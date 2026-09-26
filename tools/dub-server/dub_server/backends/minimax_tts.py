"""MiniMax direct-API TTS client.

Talks to ``{base_url}/v1/t2a_v2`` with a Bearer token. The request/response
shape is mirrored from
``/opt/n8n/packages/@n8n/nodes-langchain/nodes/vendors/MiniMax/actions/audio/tts.operation.ts``
(lines 200–250): a hex-encoded MP3 audio payload sits inside
``response.data.audio`` along with ``response.extra_info.audio_length`` in
milliseconds. We use ``output_format='hex'`` so we don't have to make a
second HTTP hop to fetch a signed URL.

Default voice ids are placeholders — pin real ids from the MiniMax voice
catalog when known. The pipeline layer reads ``MINIMAX_TTS_VOICE_*`` env
vars to override at runtime, so backend callers pass the final ``voice_id``
through.
"""
from __future__ import annotations

from pathlib import Path

import requests

# Real voice ids from the official MiniMax "System Voice ID List" FAQ at
# https://platform.minimax.io/docs/faq/system-voice-id (fetched 2026-09-26).
# Picked to match the dub pipeline's tone:
#   zh-male   → Male_Announcer   (sports-broadcast register)
#   zh-female → Warm_Bestie      (warm companion register)
#   en-male   → Trustworth_Man   (commentator register)
#   en-female → CalmWoman        (steady, warm register)
DEFAULT_VOICES: dict[str, str] = {
    "zh-male": "Chinese (Mandarin)_Male_Announcer",
    "zh-female": "Chinese (Mandarin)_Warm_Bestie",
    "en-male": "English_Trustworth_Man",
    "en-female": "English_CalmWoman",
}


class MiniMaxTTSError(Exception):
    """Raised on MiniMax TTS API failure (non-2xx, error code, empty audio)."""


def synthesize(
    text: str,
    voice_id: str,
    out_mp3: str | Path,
    *,
    base_url: str,
    api_key: str,
    model: str = "speech-02-hd",
    timeout: float = 60.0,
    speed: float = 1.1,
) -> tuple[Path, int]:
    """POST ``{base_url}/v1/t2a_v2`` with the canonical MiniMax TTS body.

    Returns ``(out_mp3_path, audio_length_ms)``. The audio file is written
    before return so partial reads from the pipeline don't see an empty
    file.

    Raises:
        MiniMaxTTSError: on any HTTP failure, MiniMax error code, missing
            ``data.audio``, or non-decodable hex.
    """
    if not api_key:
        raise MiniMaxTTSError("MiniMax API key is empty; cannot call TTS")

    payload: dict[str, object] = {
        "model": model,
        "text": text,
        "stream": False,
        "output_format": "hex",
        "voice_setting": {
            "voice_id": voice_id,
            "speed": speed,
            "vol": 1.0,
            "pitch": 0,
        },
        "audio_setting": {
            "format": "mp3",
            "sample_rate": 32000,
            "bitrate": 128000,
        },
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = f"{base_url.rstrip('/')}/v1/t2a_v2"

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=timeout)
    except requests.RequestException as error:
        raise MiniMaxTTSError(
            f"MiniMax TTS request failed: {error}"
        ) from error

    if not response.ok:
        raise MiniMaxTTSError(
            f"MiniMax TTS returned status={response.status_code}: "
            f"body={response.text[:500]!r}"
        )

    try:
        body = response.json()
    except ValueError as error:
        raise MiniMaxTTSError(
            f"MiniMax TTS returned non-JSON response: {response.text[:500]!r}"
        ) from error

    if not isinstance(body, dict):
        raise MiniMaxTTSError(
            f"MiniMax TTS returned non-object body: {body!r}"
        )

    base_resp = body.get("base_resp") or {}
    status_code = base_resp.get("status_code", -1)
    if status_code != 0:
        raise MiniMaxTTSError(
            f"MiniMax TTS error code={status_code}: "
            f"{base_resp.get('status_msg', 'unknown')}"
        )

    data = body.get("data") or {}
    audio_hex = data.get("audio", "")
    if not isinstance(audio_hex, str) or not audio_hex:
        raise MiniMaxTTSError(
            f"MiniMax TTS returned empty audio payload: {body!r}"
        )

    try:
        audio_bytes = bytes.fromhex(audio_hex)
    except ValueError as error:
        raise MiniMaxTTSError(
            f"MiniMax TTS audio hex decode failed: {error}"
        ) from error

    out_path = Path(out_mp3)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(audio_bytes)

    extra = body.get("extra_info") or {}
    try:
        audio_length_ms = int(extra.get("audio_length", 0))
    except (TypeError, ValueError):
        audio_length_ms = 0

    return out_path, audio_length_ms