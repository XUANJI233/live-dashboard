"""Native cron script gates and durable session-event acceptance checks."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any


def session_event_target() -> tuple[bool, str]:
    from hermes_cli.config import load_config

    config = load_config() or {}
    if not isinstance(config, dict):
        raise ValueError("invalid Hermes configuration")
    settings = config.get("session_events") or {}
    if not isinstance(settings, dict):
        raise ValueError("invalid session events configuration")
    if settings.get("enabled") is not True:
        return False, ""
    key = settings.get("session_key")
    if not isinstance(key, str) or not key.strip():
        raise ValueError("enabled session events require a session key")
    return True, key


def dialogue_session_key() -> str:
    """The user's conversation key; `enabled` only says whether timers wake into it."""
    from hermes_cli.config import load_config

    config = load_config() or {}
    settings = config.get("session_events") if isinstance(config, dict) else None
    key = settings.get("session_key") if isinstance(settings, dict) else None
    return key.strip() if isinstance(key, str) else ""


def jobs_by_name(root: Path) -> dict[str, str]:
    records = json.loads((root / "cron" / "jobs.json").read_text(encoding="utf-8"))["jobs"]
    if not isinstance(records, list):
        raise ValueError("invalid cron jobs")
    result = {}
    for job in records:
        if not isinstance(job, dict):
            continue
        name, job_id = job.get("name"), job.get("id")
        if not isinstance(name, str) or not isinstance(job_id, str) or not job_id:
            continue
        if name in result:
            raise ValueError("ambiguous cron job name")
        result[name] = job_id
    return result


def candidate_event_id(job_id: str, candidate_id: str) -> str:
    return f"cron:{job_id}:candidate:{candidate_id}"


def candidate_accepted(root: Path, session_key: str, job_id: str, candidate_id: str) -> bool:
    database = (root / "state.db").resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(database, uri=True)) as connection:
        row = connection.execute(
            "SELECT 1 FROM session_wake_events "
            "WHERE session_key = ? AND source = 'cron' AND event_id = ? LIMIT 1",
            (session_key, candidate_event_id(job_id, candidate_id)),
        ).fetchone()
    return row is not None


def script_gate(output: str, *, error: str | None = None, context: dict[str, Any] | None = None) -> str:
    value: dict[str, Any] = json.loads(output)
    value["wakeAgent"] = value.get("selected_this_run") is True
    if error:
        value["gate_error"] = error
    if context and value["wakeAgent"]:
        # Context rides only on a real wake; a skipped run never reads or prints it.
        value.update(context)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def wake_context(root: Path, output: str) -> dict[str, Any] | None:
    if json.loads(output).get("selected_this_run") is not True:
        return None
    from dialogue_tail import recent_dialogue

    try:
        key = dialogue_session_key()
    except (OSError, ValueError, TypeError, ImportError):
        key = ""
    return {"recent_dialogue": recent_dialogue(root, key)}
