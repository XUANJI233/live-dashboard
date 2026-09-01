#!/usr/bin/env python3
"""Wake Hermes every five minutes while a proactive Weixin message is unanswered."""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


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
    if age < FOLLOWUP_SECONDS or age > MAX_OPEN_SECONDS:
        return current, NO_CANDIDATE

    slot = int(age // FOLLOWUP_SECONDS)
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


def response_from_output(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    return text.rsplit("## Response", 1)[-1].strip() if "## Response" in text else ""


def is_sendable_response(value: str) -> bool:
    if not value.strip():
        return False
    return all(line.strip() != "[SILENT]" for line in value.splitlines())


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
        outputs = sorted(
            (root / "cron" / "output" / job_id).glob("*.md"),
            key=lambda path: path.stat().st_mtime,
        )
        if not outputs:
            continue
        output = outputs[-1]
        if not is_sendable_response(response_from_output(output)):
            continue
        modified = output.stat().st_mtime
        if latest[1] is None or modified > latest[1]:
            latest = (f"{job_id}:{output.name}", modified)
    return latest


def latest_weixin_user_message(database_path: Path) -> float | None:
    try:
        connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
        row = connection.execute(
            "SELECT MAX(messages.timestamp) "
            "FROM messages JOIN sessions ON sessions.id = messages.session_id "
            "WHERE sessions.source = 'weixin' AND messages.role = 'user' "
            "AND messages.active = 1 "
            "AND substr(ltrim(COALESCE(messages.content, '')), 1, 15) != '[Cron delivery:'"
        ).fetchone()
        connection.close()
    except sqlite3.Error:
        return None
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
        print(NO_CANDIDATE)
        return 0
    root = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    state_path = root / "state" / "proactive-followup.json"
    root_id, outbound_at = latest_proactive_outbound(root)
    state, output = evaluate_followup(
        load_state(state_path),
        root_id=root_id,
        outbound_at=outbound_at,
        inbound_at=latest_weixin_user_message(root / "state.db"),
        now=datetime.now(timezone.utc).timestamp(),
    )
    save_state(state_path, state)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
