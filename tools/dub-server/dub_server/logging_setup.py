from __future__ import annotations

import logging
import sys
from pathlib import Path


_LOGGER_NAME = "dub_server"
_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def setup_logging(job_log_path: Path | None = None, level: int = logging.INFO) -> logging.Logger:
    """Configure the ``dub_server`` logger.

    - Always adds a stderr handler (MCP owns stdout).
    - If ``job_log_path`` is provided, also writes to that file so per-job
      logs are recoverable out-of-band.
    - Idempotent: calling twice does not add duplicate handlers.
    - Returns the configured logger.
    """
    logger = logging.getLogger(_LOGGER_NAME)
    logger.setLevel(level)

    # Strip any pre-existing handlers so a re-entry does not duplicate output.
    for handler in list(logger.handlers):
        logger.removeHandler(handler)

    formatter = logging.Formatter(_FORMAT)

    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(formatter)
    logger.addHandler(stderr_handler)

    if job_log_path is not None:
        job_log_path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(job_log_path, mode="a", encoding="utf-8")
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

    # Don't propagate — the root logger may be configured by an outer host
    # (e.g. Claude Code) and we don't want to double-emit.
    logger.propagate = False

    return logger