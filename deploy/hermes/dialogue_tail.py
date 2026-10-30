"""Bounded tail of the user's Weixin conversation for isolated cron runs.

Automated runs no longer replay the conversation itself, so the gate scripts hand them the last
few human-visible messages instead. Anything unreadable yields an empty tail: a missing tail must
never block a wake.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from weixin_session import compression_ancestors, open_readonly, routed_session_id


TIMEZONE = timezone(timedelta(hours=8), name="UTC+08:00")
DEFAULT_LIMIT = 10
MAX_TEXT_CHARS = 200
SCAN_ROWS = 120
MESSAGE_SEPARATOR = "⟦MSG⟧"
CRON_DELIVERY_PREFIX = "[Cron delivery:"
SKILL_INJECTION_PREFIX = '[IMPORTANT: The "'
USER_MEDIA_PREFIX = "[The user sent"
HIDDEN_DISPLAY_KINDS = ("internal_notification", "hidden", "session_meta")


def recent_dialogue(root: Path, session_key: str, limit: int = DEFAULT_LIMIT) -> list[dict[str, str]]:
    if not session_key:
        return []
    try:
        session_id = routed_session_id(root, session_key)
        if session_id is None:
            return []
        with closing(open_readonly(root)) as connection:
            session_ids = compression_ancestors(connection, session_id)
            rows = _recent_rows(connection, session_ids)
    except (OSError, ValueError, TypeError, sqlite3.Error):
        return []
    lines = [line for line in (_dialogue_line(row) for row in rows) if line is not None]
    return list(reversed(lines[:limit]))


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
    content = str(row["content"] or "").strip()
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
        # user's own words as the last block; anything else here is a machine-built wake.
        text = content.rsplit("\n\n", 1)[-1].strip()
        if not text or text.startswith("[") or text.endswith("}]"):
            return None
        return _line(row["timestamp"], "他", text)
    if content.startswith("[") and not content.startswith(USER_MEDIA_PREFIX):
        # Compaction handoffs and other bracketed gateway notes are not something he said.
        return None
    return _line(row["timestamp"], "他", content)


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
