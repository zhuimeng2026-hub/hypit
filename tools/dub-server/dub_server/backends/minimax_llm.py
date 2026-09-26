"""MiniMax direct-API chat client for batch translation.

Endpoint discovery: the n8n MiniMax vendor at
``/opt/n8n/packages/@n8n/nodes-langchain/nodes/vendors/MiniMax/actions/text/message.operation.ts``
issues POST ``/v1/chat/completions`` with the OpenAI-compatible
``ChatCompletionResponse`` shape (see
``helpers/interfaces.ts::ChatCompletionResponse``). We pin that URL.

Request body:

    {
        "model": <model>,                       # e.g. "MiniMax-Text-01"
        "messages": [
            {"role": "system", "content": <system_prompt>},
            {"role": "user",   "content": <numbered_inputs>},
        ],
    }

Response shape:

    {
        "id": "...", "model": "...", "choices": [{
            "index": 0, "finish_reason": "stop",
            "message": {"role": "assistant", "content": "<numbered translations>"},
        }],
        "usage": {...},
    }

We ask the model for one translation per numbered input line and parse the
output by splitting on lines that start with ``"N. "`` or ``"N) "``. The
pipeline is a single chat call per dub request — no per-segment chatter.
"""
from __future__ import annotations

import re
from typing import Any, Iterable

import requests

from .prompts import build_system_message, build_user_message

# Pinned: see header docstring — derived from n8n MiniMax text/message.operation.ts.
CHAT_ENDPOINT_PATH = "/v1/chat/completions"
DEFAULT_MODEL = "MiniMax-Text-01"

# Match "1. foo bar" or "1) foo bar" or "1、foo bar" at the start of a line.
_LINE_PREFIX_RE = re.compile(r"^\s*(\d+)\s*[.\)、]\s*(.*?)\s*$")


class MiniMaxChatError(Exception):
    """Raised on MiniMax chat API failure or unparseable translation response."""


def _parse_numbered_lines(raw: str, expected: int) -> list[str | None]:
    """Extract ``[None, "translation1", "translation2", ...]`` from ``raw``.

    The list is 1-indexed by segment position; ``result[i]`` is the
    translation for segment ``i`` (segment index ``i - 1``). ``None`` means
    we couldn't find a numbered line for that slot.
    """
    found: list[str | None] = [None] * (expected + 1)
    for line in raw.splitlines():
        match = _LINE_PREFIX_RE.match(line)
        if not match:
            continue
        idx = int(match.group(1))
        text = match.group(2).strip()
        if 1 <= idx <= expected and text:
            # First match wins; subsequent matches for the same index are
            # ignored (the model occasionally echoes a line).
            if found[idx] is None:
                found[idx] = text
    return found


def translate_segments(
    segments: Iterable[Any],
    target_language: str,
    *,
    base_url: str,
    api_key: str,
    model: str = DEFAULT_MODEL,
    timeout: float = 60.0,
    source_language: str | None = None,
    system_prompt: str | None = None,
) -> list[Any]:
    """Translate each ``segments[i].text`` to ``target_language`` in one chat call.

    Returns a NEW list with each segment's ``.translation`` field set,
    preserving order and every other attribute. The input is consumed
    eagerly so we can size the request; segments are duck-typed (any
    object with a ``.text`` attribute and assignable ``.translation``).

    ``system_prompt`` overrides the default prompts.build_system_message().
    Use this for retry passes that need a stricter instruction set than
    the standard one — for example "your output must contain zero CJK
    characters" when the standard pass leaked Chinese.

    Raises :class:`MiniMaxChatError` on any HTTP failure, JSON failure, or
    parse failure (including cases where the model returned fewer numbered
    lines than inputs).
    """
    if not api_key:
        raise MiniMaxChatError("MiniMax API key is empty; cannot call chat")

    segments_list = list(segments)
    if not segments_list:
        return []

    base_system = build_system_message(target_language)
    effective_system = system_prompt if system_prompt is not None else base_system
    # Substitute {tl} placeholder if caller used templated prompt
    effective_system = effective_system.replace("{tl}", target_language)
    user_message = build_user_message(segments_list)

    messages = [
        {"role": "system", "content": effective_system},
        {"role": "user", "content": user_message},
    ]

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        # Pin max_tokens so the endpoint can't apply a server-side cap that
        # silently drops the last few sentences. 4096 covers the worst-case
        # batch we throw at it (one segment typically translates to ~80-120
        # English tokens; 4096 leaves plenty of headroom).
        "max_tokens": 4096,
        # Low temperature reduces the chance the model "gives up" mid-sentence
        # on unusual characters and falls back to echoing source-script text.
        "temperature": 0.1,
    }
    if source_language:
        # MiniMax chat accepts a per-request source language hint via the
        # system prompt in the wrapper; not all variants support a dedicated
        # field. We surface the hint in the system message rather than the
        # body to stay compatible with the OpenAI-compatible schema.
        payload["messages"][0]["content"] = (
            effective_system + f"\n\nSource language: {source_language}."
        )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = f"{base_url.rstrip('/')}{CHAT_ENDPOINT_PATH}"

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=timeout)
    except requests.RequestException as error:
        raise MiniMaxChatError(
            f"MiniMax chat request failed: {error}"
        ) from error

    if not response.ok:
        raise MiniMaxChatError(
            f"MiniMax chat returned status={response.status_code}: "
            f"body={response.text[:500]!r}"
        )

    try:
        body = response.json()
    except ValueError as error:
        raise MiniMaxChatError(
            f"MiniMax chat returned non-JSON response: {response.text[:500]!r}"
        ) from error

    if not isinstance(body, dict):
        raise MiniMaxChatError(
            f"MiniMax chat returned non-object body: {body!r}"
        )

    # Some MiniMax deployments wrap errors in base_resp; surface them.
    base_resp = body.get("base_resp")
    if isinstance(base_resp, dict):
        status_code = base_resp.get("status_code", 0)
        if status_code != 0:
            raise MiniMaxChatError(
                f"MiniMax chat error code={status_code}: "
                f"{base_resp.get('status_msg', 'unknown')}"
            )

    # OpenAI-compatible ChatCompletionResponse shape.
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise MiniMaxChatError(
            f"MiniMax chat response missing 'choices': {body!r}"
        )

    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        raise MiniMaxChatError(
            f"MiniMax chat 'choices[0]' is not an object: {first_choice!r}"
        )

    message = first_choice.get("message") or {}
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise MiniMaxChatError(
            f"MiniMax chat returned empty assistant content: {body!r}"
        )

    expected = len(segments_list)
    parsed = _parse_numbered_lines(content, expected)

    # Verify we have a translation for every input slot.
    missing = [i for i in range(1, expected + 1) if parsed[i] is None]
    if missing:
        raise MiniMaxChatError(
            f"MiniMax chat response missing translations for indices "
            f"{missing} of {expected}. Raw response:\n{content}"
        )

    # Build the output list with translations attached. Don't mutate the
    # input objects in place — the caller may want to compare them.
    output: list[Any] = []
    for i, segment in enumerate(segments_list, start=1):
        # Use copy.copy semantics via attribute assignment; Pydantic models
        # support ``model_copy(update=...)`` but we don't depend on that to
        # avoid coupling backends to schemas. Mutate a copy if available.
        try:
            new_segment = segment.model_copy(update={"translation": parsed[i]})
        except AttributeError:
            # Plain dataclass / namespace — shallow-copy via __dict__.
            try:
                import copy

                new_segment = copy.copy(segment)
                new_segment.translation = parsed[i]
            except Exception as error:  # pragma: no cover — defensive
                raise MiniMaxChatError(
                    f"segment type {type(segment).__name__} does not support "
                    f"setting .translation attribute: {error}"
                ) from error
        output.append(new_segment)

    return output