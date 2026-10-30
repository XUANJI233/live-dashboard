"""Read-only helpers for the user's Weixin conversation in Hermes state."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


MAX_LINEAGE = 128
MESSAGE_SEPARATOR = "⟦MSG⟧"
MIRROR_CLOCK_SLACK_SECONDS = 5


def load_routing(root: Path) -> dict[str, Any]:
    try:
        value = json.loads((root / "sessions" / "sessions.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def routed_session_id(root: Path, session_key: str) -> str | None:
    entry = load_routing(root).get(session_key)
    session_id = entry.get("session_id") if isinstance(entry, dict) else None
    return session_id if isinstance(session_id, str) and session_id else None


def compression_ancestors(connection: sqlite3.Connection, session_id: str) -> list[str]:
    """The live session plus the sessions it was compacted from, newest first."""
    ancestors: list[str] = []
    current = connection.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    while current is not None and current["id"] not in ancestors:
        if current["source"] != "weixin":
            raise ValueError("target is not a Weixin conversation")
        ancestors.append(current["id"])
        if len(ancestors) > MAX_LINEAGE:
            raise ValueError("compression lineage exceeds the bounded read")
        parent_id = current["parent_session_id"]
        if not parent_id:
            break
        config = json.loads(current["model_config"] or "{}")
        if not isinstance(config, dict):
            raise ValueError("invalid session model config")
        if config.get("_branched_from") == parent_id or config.get("_delegate_from") == parent_id:
            break
        parent = connection.execute("SELECT * FROM sessions WHERE id = ?", (parent_id,)).fetchone()
        if parent is None or parent["end_reason"] != "compression":
            break
        current = parent
    if not ancestors:
        raise ValueError("Weixin session is missing")
    return ancestors


MIRROR_PROBE_CHARS = 40


def mirrored_delivery(connection: sqlite3.Connection, job_name: str, response: str, written_at: float, until: float) -> bool:
    """True when Hermes mirrored this run's response into the conversation, which it does only
    after the platform accepted the delivery. A mirror is written after the run's output file, so
    only mirrors from `written_at` (less clock slack) up to `until` can belong to this run, and
    the mirrored body must begin with the response's own first bubble."""
    first = response.split(MESSAGE_SEPARATOR, 1)[0].strip()[:MIRROR_PROBE_CHARS]
    expected = f"[Cron delivery: {job_name}]\n{first}"
    row = connection.execute(
        "SELECT 1 FROM messages WHERE role = 'user' AND timestamp >= ? AND timestamp <= ? "
        "AND substr(content, 1, ?) = ? LIMIT 1",
        (written_at - MIRROR_CLOCK_SLACK_SECONDS, until, len(expected), expected),
    ).fetchone()
    return row is not None


def open_readonly(root: Path) -> sqlite3.Connection:
    connection = sqlite3.connect((root / "state.db").resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection
