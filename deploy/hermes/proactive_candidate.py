#!/usr/bin/env python3
"""Emit a stable monitor value only when a new companion opportunity is selected."""

from __future__ import annotations

import json
import os
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from live_state_gate import read_live_rest_state


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


def main() -> int:
    if os.environ.get("HERMES_CONTROLLER_ENABLED", "").strip().lower() != "true":
        print(NO_CANDIDATE)
        return 0
    path = _state_path()
    state = _load_state(path)
    state, output = evaluate_candidate(
        state,
        datetime.now(TIMEZONE),
        random.SystemRandom().random(),
        rest_state=read_live_rest_state(),
    )
    _save_state(path, state)
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
