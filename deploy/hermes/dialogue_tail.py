"""The user's Weixin conversation, as context for isolated cron runs.

Automated runs no longer replay the conversation itself, so the gate scripts hand them a
budgeted tail of the human-visible messages plus the latest compaction summary of the
conversation, which carries what was agreed before the tail. Anything unreadable yields an
empty result: missing context must never block a wake.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from weixin_session import compression_ancestors, open_readonly, routed_session_id


TIMEZONE = timezone(timedelta(hours=8), name="UTC+08:00")
DEFAULT_LIMIT = 60
MAX_TEXT_CHARS = 600
# Total characters of tail text, newest lines first; about 8K tokens of Chinese.
TAIL_CHAR_BUDGET = 12_000
SUMMARY_CHAR_BUDGET = 6_000
SCAN_ROWS = 400
MESSAGE_SEPARATOR = "⟦MSG⟧"
CRON_DELIVERY_PREFIX = "[Cron delivery:"
SKILL_INJECTION_PREFIX = '[IMPORTANT: The "'
COMPACTION_MARKER = "[CONTEXT COMPACTION"
PRIOR_CONTEXT_PREFIX = "[PRIOR CONTEXT"
PRIOR_CONTEXT_END = "[END OF PRIOR CONTEXT"
MACHINE_PREFIXES = (COMPACTION_MARKER, "[SILENT]", "[IMPORTANT:", "[SYSTEM", CRON_DELIVERY_PREFIX)
REPLY_QUOTE_PREFIXES = ("[Replying to", "[引用")
HIDDEN_DISPLAY_KINDS = ("internal_notification", "hidden", "session_meta")


def recent_dialogue(root: Path, session_key: str, limit: int = DEFAULT_LIMIT) -> list[dict[str, str]]:
    session_ids = _conversation(root, session_key)
    if not session_ids:
        return []
    try:
        with closing(open_readonly(root)) as connection:
            rows = _recent_rows(connection, session_ids)
    except (OSError, ValueError, TypeError, sqlite3.Error):
        return []
    lines: list[dict[str, str]] = []
    used = 0
    for line in (_dialogue_line(row) for row in rows):
        if line is None:
            continue
        used += len(line["text"])
        if len(lines) >= limit or (lines and used > TAIL_CHAR_BUDGET):
            break
        lines.append(line)
    return list(reversed(lines))


def chat_summary(root: Path, session_key: str, max_chars: int = SUMMARY_CHAR_BUDGET) -> str:
    """The newest compaction summary of the conversation, clipped; "" when it was never compacted."""
    session_ids = _conversation(root, session_key)
    if not session_ids:
        return ""
    try:
        with closing(open_readonly(root)) as connection:
            row = connection.execute(
                f"SELECT content FROM messages WHERE session_id IN ({','.join('?' for _ in session_ids)}) "
                "AND instr(content, ?) > 0 ORDER BY timestamp DESC, id DESC LIMIT 1",
                [*session_ids, COMPACTION_MARKER],
            ).fetchone()
    except (OSError, ValueError, TypeError, sqlite3.Error):
        return ""
    if row is None:
        return ""
    _, summary = split_compaction(str(row["content"] or ""))
    return summary if len(summary) <= max_chars else summary[:max_chars] + "…"


def split_compaction(content: str) -> tuple[str, str]:
    """(the real message carried in front of a compaction summary, the summary)."""
    index = content.find(COMPACTION_MARKER)
    if index < 0:
        return content, ""
    head, summary = content[:index], content[index:].strip()
    end = head.find(PRIOR_CONTEXT_END)
    if end >= 0:
        head = head[:end]
    head = head.strip()
    if head.startswith(PRIOR_CONTEXT_PREFIX):
        head = head.split("]", 1)[1].strip() if "]" in head else ""
    return head, summary


def _conversation(root: Path, session_key: str) -> list[str]:
    if not session_key:
        return []
    try:
        session_id = routed_session_id(root, session_key)
        if session_id is None:
            return []
        with closing(open_readonly(root)) as connection:
            return compression_ancestors(connection, session_id)
    except (OSError, ValueError, TypeError, sqlite3.Error):
        return []


def _recent_rows(connection: sqlite3.Connection, session_ids: list[str]) -> list[sqlite3.Row]:
    columns = {row[1] for row in connection.execute("PRAGMA table_info(messages)")}
    filters = [
        f"session_id IN ({','.join('?' for _ in session_ids)})",
        "role IN ('user', 'assistant')",
        "active = 1",
    ]
    if "_compressed_summary" in columns:
        filters.append("COALESCE(_compressed_summary, 0) = 0")
    if "display_kind" in columns:
        filters.append(f"COALESCE(display_kind, '') NOT IN ({','.join('?' for _ in HIDDEN_DISPLAY_KINDS)})")
    tool_calls = "tool_calls" if "tool_calls" in columns else "NULL AS tool_calls"
    parameters = [*session_ids, *(HIDDEN_DISPLAY_KINDS if "display_kind" in columns else ())]
    return connection.execute(
        f"SELECT role, content, timestamp, {tool_calls} FROM messages WHERE "
        + " AND ".join(filters)
        + f" ORDER BY timestamp DESC, id DESC LIMIT {SCAN_ROWS}",
        parameters,
    ).fetchall()


def _dialogue_line(row: Any) -> dict[str, str] | None:
    # A compaction carrier keeps the real message in front of the summary; the summary is chat_summary's.
    content, _ = split_compaction(str(row["content"] or "").strip())
    if not content:
        return None
    if row["role"] == "assistant":
        if row["tool_calls"] not in (None, "", "[]") or content == "[SILENT]":
            return None
        return _line(row["timestamp"], "她", content)
    if content.startswith(CRON_DELIVERY_PREFIX):
        _, _, text = content.partition("\n")
        return _line(row["timestamp"], "她·主动", text)
    if content.startswith(SKILL_INJECTION_PREFIX):
        # The gateway prepends forced skills to the first message of a session and keeps the
        # user's own words as the last block; a JSON tail is a machine-built wake.
        content = content.rsplit("\n\n", 1)[-1].strip()
        if content.endswith("}]"):
            return None
    text = _strip_reply_quote(content)
    # WeChat emoji arrive as "[捂脸]", so only the gateway's own notes are dropped.
    if not text or text.startswith(MACHINE_PREFIXES):
        return None
    return _line(row["timestamp"], "他", text)


def _strip_reply_quote(text: str) -> str:
    """A quoted reply keeps only what he wrote under the quote header."""
    if text.startswith(REPLY_QUOTE_PREFIXES):
        _, separator, rest = text.partition("\n\n")
        return rest.strip() if separator else ""
    return text


def _line(timestamp: Any, speaker: str, text: str) -> dict[str, str] | None:
    compact = " / ".join(part.strip() for part in text.split(MESSAGE_SEPARATOR) if part.strip())
    if not compact:
        return None
    if len(compact) > MAX_TEXT_CHARS:
        compact = compact[:MAX_TEXT_CHARS] + "…"
    try:
        at = datetime.fromtimestamp(float(timestamp), TIMEZONE).strftime("%m-%d %H:%M")
    except (TypeError, ValueError, OverflowError, OSError):
        at = ""
    return {"at": at, "who": speaker, "text": compact}
