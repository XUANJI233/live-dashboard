#!/usr/bin/env python3
"""Gate native cron wakes on bounded companion opportunities."""

from __future__ import annotations

import json
import os
import random
import sqlite3
import sys
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from live_state_gate import read_live_rest_state
from candidate_script_gate import candidate_accepted, jobs_by_name, script_gate, session_event_target


TIMEZONE = timezone(timedelta(hours=8), name="UTC+08:00")
SLOT_SECONDS = 30 * 60
COOLDOWN_SECONDS = 90 * 60
DAILY_CANDIDATE_LIMIT = 6
NORMAL_PROBABILITY = 0.50
QUIET_PROBABILITY = 0.05
SCREEN_OFF_PROBABILITY = 0.10
UNKNOWN_STATE_PROBABILITY = 0.05
NO_CANDIDATE = '{"selected_this_run":false}'


def evaluate_candidate(
    state: dict[str, Any],
    now: datetime,
    draw: float,
    rest_state: str = "active",
) -> tuple[dict[str, Any], str]:
    local = now.astimezone(TIMEZONE)
    slot = int(local.timestamp()) // SLOT_SECONDS
    current = dict(state) if isinstance(state, dict) else {}
    if current.get("last_slot") == slot:
        if current.get("last_candidate_slot") == slot:
            return current, _output_for(current.get("last_candidate_id"))
        return current, NO_CANDIDATE

    current["last_slot"] = slot
    day = local.date().isoformat()
    if current.get("day") != day:
        current["day"] = day
        current["day_count"] = 0

    if rest_state == "asleep":
        return current, NO_CANDIDATE

    count = int(current.get("day_count") or 0)
    last_at = _epoch(current.get("last_candidate_at"))
    if count >= DAILY_CANDIDATE_LIMIT or (last_at and local.timestamp() - last_at < COOLDOWN_SECONDS):
        return current, NO_CANDIDATE

    probability = QUIET_PROBABILITY if _quiet_time(local) else NORMAL_PROBABILITY
    if rest_state == "screen_off":
        probability = min(probability, SCREEN_OFF_PROBABILITY)
    elif rest_state == "unknown":
        probability = min(probability, UNKNOWN_STATE_PROBABILITY)
    if not 0 <= draw < probability:
        return current, NO_CANDIDATE

    candidate_id = f"{day}:{slot}"
    current["last_candidate_id"] = candidate_id
    current["last_candidate_slot"] = slot
    current["last_candidate_at"] = int(local.timestamp())
    current["day_count"] = count + 1
    return current, _output_for(candidate_id)


def _quiet_time(value: datetime) -> bool:
    minute = value.hour * 60 + value.minute
    return minute >= 23 * 60 + 30 or minute < 8 * 60


def _epoch(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _output_for(candidate_id: object) -> str:
    if not isinstance(candidate_id, str) or not candidate_id:
        return NO_CANDIDATE
    return json.dumps(
        {"selected_this_run": True, "candidate_id": candidate_id},
        separators=(",", ":"),
    )


def _state_path() -> Path:
    root = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    return root / "state" / "proactive-candidate.json"


def _load_state(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(temp, 0o600)
    os.replace(temp, path)
    os.chmod(path, 0o600)


def evaluate_script_candidate(
    state: dict[str, Any],
    now: datetime,
    draw: float,
    rest_state: str,
    accepted: Callable[[str], bool] | None = None,
) -> tuple[dict[str, Any], str]:
    current = dict(state)
    pending = current.get("pending_candidate")
    if accepted is not None and isinstance(pending, dict) and isinstance(pending.get("candidate_id"), str):
        if accepted(pending["candidate_id"]):
            current.pop("pending_candidate", None)
            return current, NO_CANDIDATE
        if rest_state == "asleep":
            return current, NO_CANDIDATE
        return current, json.dumps(pending, separators=(",", ":"))

    current, output = evaluate_candidate(current, now, draw, rest_state)
    value = json.loads(output)
    if accepted is not None and value.get("selected_this_run") is True:
        if accepted(value["candidate_id"]):
            return current, NO_CANDIDATE
        # Keep the selected opportunity until the durable native inbox confirms it.
        current["pending_candidate"] = value
    return current, output


def main() -> int:
    if os.environ.get("HERMES_CONTROLLER_ENABLED", "").strip().lower() != "true":
        print(script_gate(NO_CANDIDATE))
        return 0
    path = _state_path()
    try:
        native, key = session_event_target()
        root = path.parent.parent
        job_id = jobs_by_name(root)["teacher-friend-companion"] if native else ""
        accepted = (lambda candidate: candidate_accepted(root, key, job_id, candidate)) if native else None
        state, output = evaluate_script_candidate(
            _load_state(path),
            datetime.now(TIMEZONE),
            random.SystemRandom().random(),
            rest_state=read_live_rest_state(),
            accepted=accepted,
        )
        _save_state(path, state)
    except (OSError, ValueError, KeyError, TypeError, ImportError, sqlite3.Error) as error:
        print(script_gate(NO_CANDIDATE, error=f"candidate_state_unavailable:{type(error).__name__}"))
        return 0
    print(script_gate(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
