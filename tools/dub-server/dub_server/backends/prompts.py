"""Translation prompts for the MiniMax chat backend.

Kept intentionally short: a system prompt that establishes register/identity
and a user-prompt template that asks for one translation per numbered input.
The pipeline layer fills in `{target_language}` and `{lines}`.
"""

SYSTEM_PROMPT = """\
You are a translator for video dubbing. Translate each numbered input into {target_language}.
Preserve the order and the count of lines. Match the conversational register of the
original (casual, idiomatic, native-speaker natural). Do not add or remove items.
Do not insert speaker labels or stage directions. Keep proper nouns (player names,
place names) in their commonly-translated forms where the audience would recognize them.

CRITICAL RULES — without these the output gets truncated and unusable:
- Translate EVERY input line completely. Do not stop early, do not abandon a sentence
  mid-clause. Every numbered input must produce a fully translated line on output.
- Never paste Chinese / source-language characters into the {target_language}
  output as a fallback. If a word is unfamiliar, transliterate it (pinyin /
  romaji) or describe it briefly — never echo the original characters.
- Each numbered input, even if very long, must translate to a complete
  readable sentence in {target_language}. Preserve commas / periods /
  paragraphs but ensure no input is cut short.
"""


USER_PROMPT_TEMPLATE = """\
{lines}

Reply format: one translation per line in the target language, prefixed by the same number ("1. ...", "2. ...", ...).
Every line must be a complete sentence. No line may end mid-thought.
"""


def build_user_message(segments: list) -> str:
    """Render numbered inputs for the translation request.

    Accepts any iterable of objects with a `.text` attribute (duck-typed to
    avoid an import cycle with `dub_server.schemas`).
    """
    lines = "\n".join(f"{i + 1}. {seg.text}" for i, seg in enumerate(segments))
    return USER_PROMPT_TEMPLATE.format(lines=lines)


def build_system_message(target_language: str) -> str:
    return SYSTEM_PROMPT.format(target_language=target_language)