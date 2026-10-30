#!/usr/bin/env python3
"""Gate follow-ups on a delivered proactive message he has not answered."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from live_state_gate import read_live_rest_state
from candidate_script_gate import script_gate, wake_context
from weixin_session import mirrored_delivery, open_readonly
from cron_outputs import is_sendable_response, outputs_newest_first, response_from_output


TIMEZONE = timezone(timedelta(hours=8), name="UTC+08:00")
# Deep night: an unanswered message waits for morning unless the phone is actually in use.
DEEP_QUIET_START_MINUTE = 60
DEEP_QUIET_END_MINUTE = 7 * 60
FOLLOWUP_SECONDS = 5 * 60
MAX_OPEN_SECONDS = 12 * 60 * 60
# Hermes mirrors an accepted delivery within minutes of the run writing its output.
DELIVERY_WINDOW_SECONDS = 15 * 60
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

    # A job's newest output is usually a skipped gate tick (the event consumer runs every minute),
    # and its last_status describes that tick, so walk back to the newest response Weixin accepted.
    now = time.time()
    latest: tuple[str | None, float | None] = (None, None)
    try:
        connection = open_readonly(root)
    except (OSError, sqlite3.Error):
        return latest
    with closing(connection):
        for job in jobs:
            if not isinstance(job, dict) or job.get("name") not in SOURCE_JOB_NAMES:
                continue
            job_id = str(job.get("id") or "")
            if not job_id:
                continue
            for output in outputs_newest_first(root, job_id):
                modified = output.stat().st_mtime
                if now - modified > MAX_OPEN_SECONDS or (latest[1] is not None and modified <= latest[1]):
                    break
                response = response_from_output(output)
                if is_sendable_response(response) and _delivered(connection, job, response, modified):
                    latest = (f"{job_id}:{output.name}", modified)
                    break
    return latest


def _delivered(connection: sqlite3.Connection, job: dict[str, Any], response: str, written_at: float) -> bool:
    try:
        return mirrored_delivery(connection, str(job.get("name")), response, written_at, written_at + DELIVERY_WINDOW_SECONDS)
    except sqlite3.Error:
        return False


def latest_weixin_user_message(database_path: Path) -> float | None:
    try:
        database = database_path.resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(database, uri=True)) as connection:
            return _latest_user_message(connection)
    except sqlite3.Error:
        return None


def _latest_user_message(connection: sqlite3.Connection) -> float | None:
    columns = {row[1] for row in connection.execute("PRAGMA table_info(messages)")}
    filters = [
        "sessions.source = 'weixin'", "messages.role = 'user'", "messages.active = 1",
        "substr(ltrim(COALESCE(messages.content, '')), 1, 15) != '[Cron delivery:'",
    ]
    if "display_kind" in columns:
        filters.append("COALESCE(messages.display_kind, '') NOT IN ('internal_notification', 'hidden', 'session_meta')")
    if "_compressed_summary" in columns:
        filters.append("COALESCE(messages._compressed_summary, 0) = 0")
    row = connection.execute(
        "SELECT MAX(messages.timestamp) FROM messages "
        "JOIN sessions ON sessions.id = messages.session_id WHERE " + " AND ".join(filters),
    ).fetchone()
    return float(row[0]) if row and row[0] is not None else None


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
        root_id, outbound_at = latest_proactive_outbound(root)
        inbound_at = latest_weixin_user_message(root / "state.db")
        state, output = evaluate_followup(
            load_state(state_path), root_id=root_id, outbound_at=outbound_at, inbound_at=inbound_at,
            now=datetime.now(timezone.utc).timestamp(), rest_state=read_live_rest_state(),
        )
        save_state(state_path, state)
    except (OSError, ValueError, KeyError, TypeError, ImportError, sqlite3.Error) as error:
        print(script_gate(NO_CANDIDATE, error=f"candidate_state_unavailable:{type(error).__name__}"))
        return 0
    print(script_gate(output, context=wake_context(root, output)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
