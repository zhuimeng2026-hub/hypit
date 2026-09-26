"""HTTP client for the local WhisperX alignment service.

Mirrors the contract documented in
``/opt/hypit/services/whisperx/src/hypit_whisperx_service/application.py``
(lines 53–88): the service accepts ``{audio_path, language}`` and returns
``{language, segments: [{text, words: [...]}, ...]}``. 503 BUSY is mapped
to a distinct :class:`WhisperXBusy` so the pipeline layer can decide
whether to wait or fail.

The whisperx service uses Python's stdlib ``http.server``, so ``requests``
talks to it directly — no ASGI/uvicorn quirks to worry about.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import requests

# Default endpoint; the service defaults to 127.0.0.1:8765.
DEFAULT_BASE_URL = "http://127.0.0.1:8765"


class WhisperXError(Exception):
    """Raised on any non-success response or malformed payload from whisperx."""


class WhisperXBusy(WhisperXError):
    """Service returned 503 BUSY — another inference is in flight."""


def transcribe(
    wav_path: str | Path,
    language: str | None,
    *,
    base_url: str = DEFAULT_BASE_URL,
    timeout: float = 300.0,
) -> dict[str, Any]:
    """POST ``{base_url}/transcribe`` with the canonical whisperx request body.

    ``wav_path`` MUST live under ``HYPIT_WHISPERX_INPUT_ROOTS`` (default
    ``/tmp``) — the caller is responsible for staging the file there.

    Returns the parsed JSON response (``{language, segments}``).

    Raises:
        WhisperXBusy: service returned 503 BUSY.
        WhisperXError: any other non-2xx, JSON parse failure, or invalid
            response shape.
    """
    payload: dict[str, Any] = {"audio_path": str(wav_path)}
    if language is not None:
        payload["language"] = language

    url = f"{base_url.rstrip('/')}/transcribe"
    try:
        response = requests.post(url, json=payload, timeout=timeout)
    except requests.RequestException as error:
        raise WhisperXError(
            f"whisperx POST {url} failed: {error}"
        ) from error

    if response.status_code == 503:
        # WhisperX is single-inference; a 503 means another caller owns the lock.
        raise WhisperXBusy(
            f"whisperx service busy: status=503 body={response.text[:500]!r}"
        )

    if not response.ok:
        raise WhisperXError(
            f"whisperx returned status={response.status_code}: body={response.text[:500]!r}"
        )

    try:
        body = response.json()
    except ValueError as error:
        raise WhisperXError(
            f"whisperx returned non-JSON response: {response.text[:500]!r}"
        ) from error

    if not isinstance(body, dict):
        raise WhisperXError(
            f"whisperx returned non-object body: {body!r}"
        )

    # WhisperX response shape per normalize_alignment:
    #   {"language": str, "segments": [{"text": str, "words": [...]}]}
    # Some legacy responses may surface the aligned words at the top level
    # instead; normalize to the canonical shape.
    if "segments" not in body and "words" in body:
        body = {
            "language": body.get("language"),
            "segments": [{"text": "", "words": body["words"]}],
        }

    if "segments" not in body:
        raise WhisperXError(
            f"whisperx response missing 'segments' key: {list(body.keys())}"
        )

    return body