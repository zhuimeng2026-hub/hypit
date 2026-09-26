"""Cross-process job lock for the dub-server.

The default :class:`threading.Lock` inside :mod:`dub_server.jobs` serializes
within a single Python interpreter (helpful for the MCP server handling
many concurrent tool calls). It does **not** see across processes, so a
shell `dub` CLI run and an `MCP`-driven dub running in parallel would
both hit whisperx :func:`/transcribe` at the same time → whisperx
service is single-inference and the second one gets ``503 BUSY``.

POSIX ``flock(2)`` on a sentinel file gives us a kernel-managed lock that
is honoured across processes. We default the lock file to
``$JOB_ROOT/.dub.lock`` so multiple processes sharing one workspace
serialize; ``DUB_LOCK_PATH`` overrides for system-wide locking.

Windows has no ``fcntl.flock``; we degrade to a no-op + warning so the
server still **runs** (Windows users accept races on whisperx).
"""
from __future__ import annotations

import contextlib
import errno
import fcntl
import os
import time
from pathlib import Path
from typing import Iterator


class DubJobBusy(RuntimeError):
    """Cross-process lock could not be acquired (non-blocking mode)."""


# fcntl is POSIX-only. Import lazily so importing the module on Windows
# does not hard-fail; degraded mode = lock becomes a no-op.
_FCNTL_AVAILABLE = True
try:
    import fcntl as _fcntl  # noqa: F401
except ImportError:  # pragma: no cover — Windows
    _FCNTL_AVAILABLE = False


def default_lock_path(job_root: Path) -> Path:
    """Lock file under the job workspace (overridable via env)."""
    override = os.environ.get("DUB_LOCK_PATH")
    if override:
        return Path(override)
    return Path(job_root) / ".dub.lock"


@contextlib.contextmanager
def cross_process_lock(
    lock_path: Path,
    *,
    blocking: bool = False,
    poll_interval: float = 0.5,
) -> Iterator[None]:
    """Acquire an exclusive cross-process lock on ``lock_path``.

    Args:
        lock_path: path to the sentinel file (created if absent).
        blocking: if ``False`` (default) and the lock is held, raise
            :class:`DubJobBusy` immediately. If ``True``, poll every
            ``poll_interval`` seconds until acquired (no timeout; the
            operator cancels via Ctrl-C).
        poll_interval: seconds between retries when ``blocking=True``.

    The kernel releases the lock automatically if the holding process
    dies — so a crashed dub does NOT lock subsequent calls forever.

    Raises:
        DubJobBusy: when ``blocking=False`` and the lock is held.
    """
    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        if not _FCNTL_AVAILABLE:
            # Windows / non-POSIX: degrade gracefully (no real lock).
            yield
            return

        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
                # Acquired. Hold for the lifetime of the context.
                break
            except OSError as exc:
                if exc.errno not in (errno.EWOULDBLOCK, errno.EAGAIN):
                    raise DubJobBusy(
                        f"flock failed on {lock_path}: {exc}"
                    ) from exc
                if not blocking:
                    raise DubJobBusy(
                        f"another dub is holding {lock_path}"
                    ) from exc
                time.sleep(poll_interval)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)
