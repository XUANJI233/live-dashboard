#!/usr/bin/env python3
"""Gate native followups on confirmed delivery and unanswered conversation state."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from collections.abc import Callable
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from live_state_gate import read_live_rest_state
from candidate_script_gate import candidate_accepted, jobs_by_name, script_gate, session_event_target, wake_context
from weixin_session import compression_ancestors, open_readonly, routed_session_id
from cron_outputs import is_sendable_response, latest_output, response_from_output


TIMEZONE = timezone(timedelta(hours=8), name="UTC+08:00")
# Deep night: an unanswered message waits for morning unless the phone is actually in use.
DEEP_QUIET_START_MINUTE = 60
DEEP_QUIET_END_MINUTE = 7 * 60
FOLLOWUP_SECONDS = 5 * 60
MAX_OPEN_SECONDS = 12 * 60 * 60
NO_CANDIDATE = '{"selected_this_run":false}'
SOURCE_JOB_NAMES = {
    "live-supervision-review",
    "teacher-friend-companion",
    "live-daily-summary",
    "live-weekly-summary",
    "strict-weixin-e2e",
}


def evaluate_followup(
    state: dict[str, Any],
    *,
    root_id: str | None,
    outbound_at: float | None,
    inbound_at: float | None,
    now: float,
    rest_state: str = "active",
) -> tuple[dict[str, Any], str]:
    current = dict(state) if isinstance(state, dict) else {}
    if not root_id or outbound_at is None:
        return current, NO_CANDIDATE

    if current.get("root_id") != root_id:
        current = {
            "root_id": root_id,
            "outbound_at": outbound_at,
            "last_wake_slot": 0,
        }

    if inbound_at is not None and inbound_at > outbound_at:
        current["answered_at"] = inbound_at
        return current, NO_CANDIDATE

    age = max(0.0, now - outbound_at)
    if rest_state == "asleep" or age < FOLLOWUP_SECONDS or age > MAX_OPEN_SECONDS:
        return current, NO_CANDIDATE
    if rest_state != "active" and deep_quiet(now):
        return current, NO_CANDIDATE

    slot = followup_wake_slot(age, rest_state)
    if slot <= int(current.get("last_wake_slot") or 0):
        return current, NO_CANDIDATE

    current["last_wake_slot"] = slot
    current.pop("answered_at", None)
    output = {
        "selected_this_run": True,
        "root_id": root_id,
        "outbound_at": datetime.fromtimestamp(outbound_at, timezone.utc).isoformat(),
        "minutes_without_reply": int(age // 60),
    }
    return current, json.dumps(output, ensure_ascii=False, separators=(",", ":"))


def deep_quiet(now: float) -> bool:
    local = datetime.fromtimestamp(now, TIMEZONE)
    minute = local.hour * 60 + local.minute
    return DEEP_QUIET_START_MINUTE <= minute < DEEP_QUIET_END_MINUTE


def followup_wake_slot(age_seconds: float, rest_state: str) -> int:
    thresholds = (15 * 60, 30 * 60, 60 * 60) if rest_state in {"screen_off", "unknown"} else (5 * 60, 15 * 60, 30 * 60, 60 * 60)
    for index, threshold in enumerate(thresholds, start=1):
        if age_seconds < threshold:
            return index - 1
    return len(thresholds) + int((age_seconds - thresholds[-1]) // (60 * 60))


def latest_proactive_outbound(root: Path) -> tuple[str | None, float | None]:
    jobs_path = root / "cron" / "jobs.json"
    try:
        jobs = json.loads(jobs_path.read_text(encoding="utf-8"))["jobs"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return None, None

    latest: tuple[str | None, float | None] = (None, None)
    for job in jobs:
        if not isinstance(job, dict) or job.get("name") not in SOURCE_JOB_NAMES:
            continue
        if job.get("last_status") != "ok" or job.get("last_delivery_error"):
            continue
        job_id = str(job.get("id") or "")
        if not job_id:
            continue
        output = latest_output(root, job_id)
        if output is None:
            continue
        if not is_sendable_response(response_from_output(output)):
            continue
        modified = output.stat().st_mtime
        if latest[1] is None or modified > latest[1]:
            latest = (f"{job_id}:{output.name}", modified)
    return latest


def latest_weixin_user_message(database_path: Path) -> float | None:
    try:
        database = database_path.resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(database, uri=True)) as connection:
            return _latest_user_message(connection)
    except sqlite3.Error:
        return None


def _latest_user_message(connection: sqlite3.Connection, session_ids: list[str] | None = None) -> float | None:
    columns = {row[1] for row in connection.execute("PRAGMA table_info(messages)")}
    filters = [
        "sessions.source = 'weixin'", "messages.role = 'user'", "messages.active = 1",
        "substr(ltrim(COALESCE(messages.content, '')), 1, 15) != '[Cron delivery:'",
    ]
    if "display_kind" in columns:
        filters.append("COALESCE(messages.display_kind, '') NOT IN ('internal_notification', 'hidden', 'session_meta')")
    if "_compressed_summary" in columns:
        filters.append("COALESCE(messages._compressed_summary, 0) = 0")
    if session_ids is not None:
        if not session_ids or "display_kind" not in columns:
            raise ValueError("native reply filtering requires a typed conversation")
        filters.append(f"messages.session_id IN ({','.join('?' for _ in session_ids)})")
    row = connection.execute(
        "SELECT MAX(messages.timestamp) FROM messages "
        "JOIN sessions ON sessions.id = messages.session_id WHERE " + " AND ".join(filters),
        session_ids or [],
    ).fetchone()
    return float(row[0]) if row and row[0] is not None else None


def native_followup_context(root: Path, session_key: str, followup_job_id: str) -> tuple[str | None, float | None, float | None]:
    session_id = routed_session_id(root, session_key)
    if session_id is None:
        raise ValueError("native followup route is missing")
    with closing(open_readonly(root)) as connection:
        connection.execute("BEGIN")
        session_ids = compression_ancestors(connection, session_id)
        inbound_at = _latest_user_message(connection, session_ids)
        rows = connection.execute(
            "SELECT obligation_id, updated_at, trigger_event_ids, content "
            "FROM delivery_obligations WHERE session_key = ? AND state = 'delivered' "
            "ORDER BY updated_at DESC LIMIT 256",
            (session_key,),
        )
        for row in rows:
            try:
                event_ids = json.loads(row["trigger_event_ids"])
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(event_ids, list) or not event_ids or not all(isinstance(value, str) and value for value in event_ids):
                continue
            if all(value.startswith(f"cron:{followup_job_id}:") for value in event_ids):
                continue
            if not is_sendable_response(row["content"] or ""):
                continue
            return f"delivery:{row['obligation_id']}", float(row["updated_at"]), inbound_at
    return None, None, inbound_at


def evaluate_script_followup(
    state: dict[str, Any],
    *,
    root_id: str | None,
    outbound_at: float | None,
    inbound_at: float | None,
    now: float,
    rest_state: str,
    accepted: Callable[[str], bool] | None = None,
) -> tuple[dict[str, Any], str]:
    current = dict(state)
    pending = current.get("pending_candidate")
    if accepted is not None and isinstance(pending, dict) and pending.get("root_id") == root_id:
        if accepted(str(pending.get("candidate_id") or "")):
            current["last_wake_slot"] = int(current.pop("pending_wake_slot", 0))
            current.pop("pending_candidate", None)
        elif outbound_at is not None and not (inbound_at is not None and inbound_at > outbound_at):
            age = max(0.0, now - outbound_at)
            if age <= MAX_OPEN_SECONDS:
                if rest_state == "asleep" or followup_wake_slot(age, rest_state) < int(current.get("pending_wake_slot") or 0):
                    return current, NO_CANDIDATE
                return current, json.dumps(pending, ensure_ascii=False, separators=(",", ":"))
    current.pop("pending_candidate", None)
    current.pop("pending_wake_slot", None)
    previous_slot = int(current.get("last_wake_slot") or 0) if current.get("root_id") == root_id else 0
    current, output = evaluate_followup(
        current, root_id=root_id, outbound_at=outbound_at, inbound_at=inbound_at,
        now=now, rest_state=rest_state,
    )
    if accepted is None or not json.loads(output).get("selected_this_run"):
        return current, output
    slot = int(current["last_wake_slot"])
    value = json.loads(output)
    value["candidate_id"] = f"{root_id}:{slot}"
    if accepted(value["candidate_id"]):
        return current, NO_CANDIDATE
    # Advancing the cadence waits for an actual durable enqueue receipt.
    current["last_wake_slot"] = previous_slot
    current["pending_wake_slot"] = slot
    current["pending_candidate"] = value
    return current, json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def load_state(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(state, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def main() -> int:
    if os.environ.get("HERMES_CONTROLLER_ENABLED", "").strip().lower() != "true":
        print(script_gate(NO_CANDIDATE))
        return 0
    root = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    state_path = root / "state" / "proactive-followup.json"
    try:
        native, key = session_event_target()
        if native:
            job_id = jobs_by_name(root)["strict-proactive-followup"]
            root_id, outbound_at, inbound_at = native_followup_context(root, key, job_id)
            accepted = lambda candidate: candidate_accepted(root, key, job_id, candidate)
        else:
            root_id, outbound_at = latest_proactive_outbound(root)
            inbound_at = latest_weixin_user_message(root / "state.db")
            accepted = None
        state, output = evaluate_script_followup(
            load_state(state_path), root_id=root_id, outbound_at=outbound_at, inbound_at=inbound_at,
            now=datetime.now(timezone.utc).timestamp(), rest_state=read_live_rest_state(), accepted=accepted,
        )
        save_state(state_path, state)
    except (OSError, ValueError, KeyError, TypeError, ImportError, sqlite3.Error) as error:
        print(script_gate(NO_CANDIDATE, error=f"candidate_state_unavailable:{type(error).__name__}"))
        return 0
    print(script_gate(output, context=wake_context(root, output)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
