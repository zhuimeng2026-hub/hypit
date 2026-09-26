# `jobs.py` — Job Lifecycle + JOB_LOCK

`tools/dub-server/dub_server/jobs.py` is **230 lines** of plumbing. It does
exactly four things:

1. Define a `Job` status enum + dataclass
2. Provide a thread-safe FIFO `JobRegistry` with bounded size
3. Define the module-level `JOB_LOCK` that serialises dub execution
4. Manage workspace directories per job

It knows nothing about dubbing, audio, or any backend. It just answers
"what job is running, where do its files live, who else is running at the
same time".

---

## `JobStatus` — the state machine (lines 14–24)

```python
class JobStatus(str, Enum):
    QUEUED    = "queued"      # create() 后
    RUNNING   = "running"     # start() 后
    COMPLETED = "completed"   # complete() 后(终态)
    FAILED    = "failed"      # fail() 后(终态)
    CANCELLED = "cancelled"   # cancel() 后(终态)

_TERMINAL_STATUSES = frozenset({COMPLETED, FAILED, CANCELLED})
```

Legal transitions:

```
QUEUED ─start→ RUNNING ─complete→ COMPLETED
   │ │
   │                └─fail──────→ FAILED
   └──fail/cancel──────────────→ FAILED / CANCELLED
```

`_TERMINAL_STATUSES` is used by `sweep()` — only terminal jobs have their
workspace deleted. Non-terminal jobs must never be evicted, otherwise the
running pipeline loses its intermediate outputs.

---

## `Job` dataclass (lines 27–50)

```python
@dataclass
class Job:
    job_id: str                              # uuid.uuid4().hex[:12]
    status: JobStatus
    created_at: datetime                     # UTC
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    workspace: Path = field(default_factory=Path)   # $JOB_ROOT/$job_id/
    log_path: Path = field(default_factory=Path)    # $workspace/run.log
    error: Optional[str] = None
    result: Optional[dict] = None            # payload from model_dump
```

`to_dict()` (lines 39–50) ISO-formats datetimes and stringifies Paths — used
when the registry needs to JSON-serialise job state.

---

## `JobRegistry` — thread-safe FIFO (lines 53–225)

```python
class JobRegistry:
    def __init__(self, root: Path, max_jobs: int = 10):
        ...
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._lock = threading.Lock()
```

Two data structures:

- `OrderedDict[str, Job]` — keeps insertion order (FIFO)
- `threading.Lock()` — every read/write goes through the lock

### `create()` — allocate workspace + log (lines 77–93)

```python
def create(self) -> Job:
    job_id = uuid.uuid4().hex[:12]
    workspace = self._root / job_id
    workspace.mkdir(parents=True, exist_ok=True)
    log_path = workspace / "run.log"
    log_path.touch(exist_ok=True)
    job = Job(job_id=job_id, status=QUEUED, created_at=utcnow(),
              workspace=workspace, log_path=log_path)
    with self._lock:
        self._jobs[job_id] = job
        self._evict_locked()                  # ← eager eviction, not lazy
    return job
```

Two notes:

- **12-char hex** `job_id` — collision-safe for any realistic concurrency
- **Eager eviction** — every `create()` calls `_evict_locked()` so the
  registry never exceeds `max_jobs`. No background thread needed.

### `_transition()` — the state-change guard (lines 178–207)

```python
def _transition(self, job_id, *, allowed_from, new_status,
                started_at=None, finished_at=None, result=None, error=None):
    with self._lock:
        job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(f"Unknown job_id: {job_id}")
        if job.status not in allowed_from:
            raise ValueError(
                f"Cannot transition job {job_id} from "
                f"{job.status.value} to {new_status.value}"
            )
        job.status = new_status
        ...
```

All four `start / complete / fail / cancel` go through this single helper
with different `allowed_from` sets:

| Method | allowed_from |
|---|---|
| `start()` | `{QUEUED}` |
| `complete()` | `{RUNNING}` |
| `fail()` | `{QUEUED, RUNNING}` |
| `cancel()` | `{QUEUED, RUNNING}` |

Trying to fail an already-COMPLETED job raises `ValueError`. The state
machine is hard-enforced — no way to reach an inconsistent state.

### `get()` — copy-on-read (lines 130–148)

```python
def get(self, job_id: str) -> Optional[Job]:
    with self._lock:
        job = self._jobs.get(job_id)
        if job is None:
            return None
        return Job(
            job_id=job.job_id, status=job.status,
            created_at=job.created_at,
            started_at=job.started_at, finished_at=job.finished_at,
            workspace=job.workspace, log_path=job.log_path,
            error=job.error,
            result=dict(job.result) if job.result is not None else None,
        )
```

Returns a **shallow copy** so callers can't mutate registry state by
holding a reference. `Path` objects are immutable so they're shared;
`result` is a dict so it's copied.

### `sweep()` + `_evict_locked()` — bounded retention (lines 157–217)

```python
def sweep(self) -> list[str]:
    removed: list[str] = []
    with self._lock:
        while len(self._jobs) > self._max:
            old_id, old_job = self._jobs.popitem(last=False)
            if old_job.status in _TERMINAL_STATUSES:
                self._delete_workspace(old_job.workspace)
                removed.append(old_id)
            else:
                # Non-terminal — must not be evicted. Push back and stop.
                self._jobs[old_id] = old_job
                self._jobs.move_to_end(old_id)
                break
    return removed
```

`OrderedDict.popitem(last=False)` pops the **oldest**. If it's terminal,
delete its workspace. If it's still running:

- `self._jobs[old_id] = old_job` — push it back (re-insert at end)
- `move_to_end(old_id)` — keep it at the end so the next iteration sees a
  different oldest
- `break` — without this, infinite loop on the same non-terminal job

`_evict_locked()` (lines 209–217) is the inline version used during
`create()`. Same logic, no `removed` list.

Two sweep entry points:

| Caller | When |
|---|---|
| `server.py` `_state()` | On first tool call (startup sweep) |
| `_evict_locked()` | Inside every `create()` (incremental sweep) |

Together they guarantee: the registry never exceeds `max_jobs` regardless
of restart cycles.

### `_delete_workspace()` — best-effort cleanup (lines 219–225)

```python
@staticmethod
def _delete_workspace(workspace: Path) -> None:
    try:
        if workspace.exists():
            shutil.rmtree(workspace, ignore_errors=True)
    except Exception:
        pass
```

`shutil.rmtree(..., ignore_errors=True)` + outer `try/except` = double
defense. If `/tmp` is full or `JOB_ROOT` got unmounted, the deletion fails
silently. Job completion is not blocked by workspace cleanup.

---

## `JOB_LOCK` — the cross-pipeline serialisation lock (lines 228–230)

```python
# Global lock so the pipeline serialises one dub at a time
# (whisperx is single-inference; demucs holds the model in memory).
JOB_LOCK = threading.Lock()
```

**Not** the same as `JobRegistry._lock`. Two distinct locks:

| Lock | Scope | Holds for |
|---|---|---|
| `JobRegistry._lock` | Registry state only | microseconds (dict ops) |
| `JOB_LOCK` | Whole pipeline execution | seconds to minutes |

`server.py` wraps every tool call:

```python
with JOB_LOCK:
    job = registry.create()
    registry.start(job.job_id)
    try:
        result = pipeline_dub_video(req, config=config, job=job)
        ...
```

So any two `dub_video` / `transcribe_audio` / `separate_audio` calls queue
behind each other.

**Critical caveat**: `JOB_LOCK` is `threading.Lock` — **intra-process only**.
Two `python -m dub_server serve stdio` processes don't see each other's
locks. Single-process is assumed. If you need cross-process serialisation,
add an external flock (e.g. `fcntl.flock` on a lockfile).

---

## How the registry gets used

### server.py

```python
from .jobs import JOB_LOCK, JobRegistry

def _state():
    if _registry is None:
        _registry = JobRegistry(_config.job_root, max_jobs=10)
        _registry.sweep()                   # startup sweep
    return _config, _registry

@mcp.tool()
def dub_video(req):
    config, registry = _state()
    with JOB_LOCK:                          # serialise
        job = registry.create()             # allocate workspace
        registry.start(job.job_id)          # QUEUED → RUNNING
        try:
            result = pipeline_dub_video(req, config=config, job=job)
            registry.complete(job.job_id, result.model_dump(mode="json"))
        except PipelineError as e:
            registry.fail(job.job_id, str(e))   # QUEUED|RUNNING → FAILED
            ...
        except Exception as e:
            registry.fail(job.job_id, f"unexpected: {e}")
            ...
```

### __main__.py (CLI mode)

```python
config = Config.from_env()
registry = JobRegistry(config.job_root, max_jobs=10)
registry.sweep()                            # startup sweep

# in _run_dub / _run_transcribe / _run_separate:
job = registry.create()
registry.start(job.job_id)
try:
    result = pipeline_xxx(req, config=config, job=job)
    registry.complete(job.job_id, result.model_dump(mode="json"))
except PipelineError as e:
    registry.fail(job.job_id, str(e))
```

Same lifecycle, **no JOB_LOCK** — CLI assumes caller-managed serialisation.

### pipeline.py (consumer)

```python
from .jobs import Job

def dub_video(req, *, config, job: Job):
    workspace = job.workspace                # $JOB_ROOT/$job_id
    logger = setup_logging(job_log_path=job.log_path)
    ...
    workspace.mkdir(parents=True, exist_ok=True)  # safe: parent already exists
    canonical_wav = workspace / "audio.wav"
    ...
```

The pipeline doesn't import `JobRegistry` or `JOB_LOCK`. It just receives
a `Job` and uses its `workspace` / `log_path` paths. Pure dependency
injection.

---

## Testability

The whole module is easy to test in isolation:

```python
import tempfile
from pathlib import Path
from dub_server.jobs import JobRegistry, JobStatus

def test_lifecycle():
    with tempfile.TemporaryDirectory() as tmp:
        reg = JobRegistry(Path(tmp), max_jobs=3)
        job = reg.create()
        assert job.status == JobStatus.QUEUED
        reg.start(job.job_id)
        assert reg.get(job.job_id).status == JobStatus.RUNNING
        reg.complete(job.job_id, {"output_path": "x.mp4"})
        assert reg.get(job.job_id).status == JobStatus.COMPLETED

def test_eviction_preserves_running():
    with tempfile.TemporaryDirectory() as tmp:
        reg = JobRegistry(Path(tmp), max_jobs=2)
        a = reg.create(); reg.start(a.job_id)            # RUNNING
        b = reg.create(); reg.complete(b.job_id, {})     # COMPLETED
        c = reg.create()                                  # → evicts b, not a
        assert reg.get(a.job_id) is not None
        assert reg.get(b.job_id) is None
        assert reg.get(c.job_id) is not None
```

`JobRegistry._lock` and the underlying `OrderedDict` are private
(underscore prefix), so all interaction goes through the public methods
listed above.