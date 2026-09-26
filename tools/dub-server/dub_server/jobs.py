from __future__ import annotations

import shutil
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


_TERMINAL_STATUSES = frozenset(
    {JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED}
)


@dataclass
class Job:
    job_id: str
    status: JobStatus
    created_at: datetime
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    workspace: Path = field(default_factory=Path)
    log_path: Path = field(default_factory=Path)
    error: Optional[str] = None
    result: Optional[dict] = None

    def to_dict(self) -> dict:
        return {
            "job_id": self.job_id,
            "status": self.status.value,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
            "workspace": str(self.workspace),
            "log_path": str(self.log_path),
            "error": self.error,
            "result": self.result,
        }


class JobRegistry:
    """FIFO registry; bounded size via ``max_jobs`` (default 10).

    - ``create()`` makes a fresh job dir + log file under ``root``.
    - ``start()``, ``complete()``, ``fail()``, ``cancel()`` mutate status
      + timestamps.
    - ``sweep()`` removes oldest jobs beyond ``max_jobs``, deleting
      workspace dirs.
    - All ops are thread-safe via internal lock.
    """

    def __init__(self, root: Path, max_jobs: int = 10):
        if max_jobs <= 0:
            raise ValueError("max_jobs must be positive")
        self._root = Path(root).expanduser()
        self._root.mkdir(parents=True, exist_ok=True)
        self._max = max_jobs
        self._jobs: "OrderedDict[str, Job]" = OrderedDict()
        self._lock = threading.Lock()

    @property
    def root(self) -> Path:
        return self._root

    def create(self) -> Job:
        job_id = uuid.uuid4().hex[:12]
        workspace = self._root / job_id
        workspace.mkdir(parents=True, exist_ok=True)
        log_path = workspace / "run.log"
        log_path.touch(exist_ok=True)
        job = Job(
            job_id=job_id,
            status=JobStatus.QUEUED,
            created_at=datetime.now(timezone.utc),
            workspace=workspace,
            log_path=log_path,
        )
        with self._lock:
            self._jobs[job_id] = job
            self._evict_locked()
        return job

    def start(self, job_id: str) -> Job:
        return self._transition(
            job_id,
            allowed_from={JobStatus.QUEUED},
            new_status=JobStatus.RUNNING,
            started_at=datetime.now(timezone.utc),
        )

    def complete(self, job_id: str, result: dict) -> Job:
        return self._transition(
            job_id,
            allowed_from={JobStatus.RUNNING},
            new_status=JobStatus.COMPLETED,
            finished_at=datetime.now(timezone.utc),
            result=result,
            error=None,
        )

    def fail(self, job_id: str, error: str) -> Job:
        return self._transition(
            job_id,
            allowed_from={JobStatus.QUEUED, JobStatus.RUNNING},
            new_status=JobStatus.FAILED,
            finished_at=datetime.now(timezone.utc),
            error=error,
        )

    def cancel(self, job_id: str) -> Job:
        return self._transition(
            job_id,
            allowed_from={JobStatus.QUEUED, JobStatus.RUNNING},
            new_status=JobStatus.CANCELLED,
            finished_at=datetime.now(timezone.utc),
        )

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            job = self._jobs.get(job_id)
            # Return a shallow copy so callers can mutate without affecting
            # registry state, but keep the inner mutable fields (workspace,
            # log_path, result) as-is.
            if job is None:
                return None
            return Job(
                job_id=job.job_id,
                status=job.status,
                created_at=job.created_at,
                started_at=job.started_at,
                finished_at=job.finished_at,
                workspace=job.workspace,
                log_path=job.log_path,
                error=job.error,
                result=dict(job.result) if job.result is not None else None,
            )

    def list(self, limit: int = 10) -> list[Job]:
        if limit <= 0:
            return []
        with self._lock:
            ids = list(self._jobs.keys())[-limit:]
            return [self._jobs[i] for i in ids]

    def sweep(self) -> list[str]:
        """Remove oldest finished jobs beyond ``max_jobs``. Returns the ids
        of jobs whose workspace dirs were deleted."""
        removed: list[str] = []
        with self._lock:
            while len(self._jobs) > self._max:
                old_id, old_job = self._jobs.popitem(last=False)
                if old_job.status in _TERMINAL_STATUSES:
                    self._delete_workspace(old_job.workspace)
                    removed.append(old_id)
                else:
                    # Non-terminal jobs must never be evicted — push back.
                    self._jobs[old_id] = old_job
                    # Reorder so subsequent evictions still target this job.
                    self._jobs.move_to_end(old_id)
                    break
        return removed

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    def _transition(
        self,
        job_id: str,
        *,
        allowed_from: set[JobStatus],
        new_status: JobStatus,
        finished_at: Optional[datetime] = None,
        started_at: Optional[datetime] = None,
        result: Optional[dict] = None,
        error: Optional[str] = None,
    ) -> Job:
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
            if started_at is not None:
                job.started_at = started_at
            if finished_at is not None:
                job.finished_at = finished_at
            if result is not None:
                job.result = dict(result)
            if error is not None:
                job.error = error
            return job

    def _evict_locked(self) -> None:
        while len(self._jobs) > self._max:
            old_id, old_job = self._jobs.popitem(last=False)
            if old_job.status in _TERMINAL_STATUSES:
                self._delete_workspace(old_job.workspace)
            else:
                self._jobs[old_id] = old_job
                self._jobs.move_to_end(old_id)
                break

    @staticmethod
    def _delete_workspace(workspace: Path) -> None:
        try:
            if workspace.exists():
                shutil.rmtree(workspace, ignore_errors=True)
        except Exception:
            pass


# Global lock so the pipeline serialises one dub at a time
# (whisperx is single-inference; demucs holds the model in memory).
JOB_LOCK = threading.Lock()