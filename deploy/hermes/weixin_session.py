"""Read-only helpers for the user's Weixin conversation in Hermes state."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


MAX_LINEAGE = 128


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


def mirrored_delivery(connection: sqlite3.Connection, job_name: str, text: str, since: float) -> bool:
    """True when Hermes mirrored this job's text into the conversation, which it does only after
    the platform accepted the delivery."""
    probe = text.strip()[:40]
    row = connection.execute(
        "SELECT 1 FROM messages WHERE role = 'user' AND timestamp >= ? "
        "AND substr(content, 1, ?) = ? AND instr(content, ?) > 0 LIMIT 1",
        (since, len(f"[Cron delivery: {job_name}]"), f"[Cron delivery: {job_name}]", probe),
    ).fetchone()
    return row is not None


def open_readonly(root: Path) -> sqlite3.Connection:
    connection = sqlite3.connect((root / "state.db").resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection
