"""Request-only migration of legacy Weixin persona scaffolding.

SOUL.md now carries the persona. Old forced-skill bodies must not override it or be replayed
on every turn. Use Hermes's middleware surface; never edit stored messages or core files.
The same input always produces the same projection, including on retries and later turns.
"""

from __future__ import annotations

import re
from typing import Any


# Skills Weixin used to auto-load: the persona pair, now in SOUL.md, and the sticker manual, now
# read on demand.
FOLDED_SKILLS = frozenset({"strict-study-girlfriend", "live-mentor", "sticker-library"})
AUTO_HEADER = re.compile(
    r'\[IMPORTANT: The "([^"\n]+)" skill is auto-loaded\. '
    r'Follow its instructions for this session\.\]'
)
TIMESTAMP = re.compile(r"^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [^\]\n]+\]\s*")
DIRECTORY_FOOTER = re.compile(
    r"\n\[Skill directory: [^\r\n]+\]\r?\n"
    r"Resolve any relative paths in this skill[^\r\n]*"
    r"then run them with the terminal tool using the absolute path\."
)
OPTIONAL_FOOTERS = (
    ("[Skill config (", "\n]"),
    ("[Skill setup note: ", "]"),
    ("[This skill has supporting files", "/scripts/foo.js`)."),
)


def _payload_end(text: str, start: int) -> int | None:
    footer = DIRECTORY_FOOTER.search(text, start)
    if footer is None:
        return None
    next_header = AUTO_HEADER.search(text, start)
    if next_header is not None and next_header.start() < footer.start():
        return None
    end = footer.end()
    while True:
        next_start = end + len(text[end:]) - len(text[end:].lstrip("\r\n"))
        optional = next((item for item in OPTIONAL_FOOTERS if text.startswith(item[0], next_start)), None)
        if optional is None:
            return end
        close = text.find(optional[1], next_start + len(optional[0]))
        if close < 0:
            return None
        end = close + len(optional[1])


def compact_legacy_text(text: str) -> str:
    """Fold only complete leading auto-load scaffolds, retaining the user's exact text tail."""
    stamp = TIMESTAMP.match(text)
    offset = stamp.end() if stamp else 0
    spans: list[tuple[int, int]] = []
    names: list[str] = []
    while header := AUTO_HEADER.match(text, offset):
        end = _payload_end(text, header.end())
        if end is None:
            # Unknown/incomplete framing is retained rather than guessing where his text starts.
            break
        if header[1] in FOLDED_SKILLS:
            spans.append((offset, end))
            if header[1] not in names:
                names.append(header[1])
        offset = end + len(text[end:]) - len(text[end:].lstrip("\r\n"))
    if not spans:
        return text
    note = "[历史技能自动注入已折叠：" + ", ".join(names) + "；人设见系统提示，手册按需读取。]"
    for index in range(len(spans) - 1, -1, -1):
        start, end = spans[index]
        text = text[:start] + (note if index == 0 else "") + text[end:]
    return text


def _compact_content(content: Any) -> Any:
    if isinstance(content, str):
        return compact_legacy_text(content)
    if not isinstance(content, list):
        return content
    # Anthropic/OpenAI text blocks may share a user row with images or tool results. Those
    # blocks, and current skill_view results, keep their content and cache metadata intact.
    return [
        {**block, "text": compact_legacy_text(block["text"])}
        if isinstance(block, dict) and block.get("type") in {"text", "input_text"}
        and isinstance(block.get("text"), str) else block
        for block in content
    ]


def compact_persona_history(request: dict[str, Any], *, platform: str = "", **_: Any) -> dict[str, Any] | None:
    if platform != "weixin":
        return None
    projected = dict(request)
    changed = False
    for key in ("messages", "input"):
        rows = request.get(key)
        if not isinstance(rows, list):
            continue
        rewritten = []
        for row in rows:
            if isinstance(row, dict) and row.get("role") == "user" and "content" in row:
                content = _compact_content(row["content"])
                changed |= content != row["content"]
                rewritten.append({**row, "content": content})
            else:
                rewritten.append(row)
        projected[key] = rewritten
    if not changed:
        return None
    return {"request": projected, "source": "persona_context", "reason": "fold legacy persona auto-loads"}


def register(ctx: Any) -> None:
    ctx.register_middleware("llm_request", compact_persona_history)
