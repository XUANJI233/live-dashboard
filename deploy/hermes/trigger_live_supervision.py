#!/usr/bin/env python3
"""Turn one authenticated Live webhook into an attached Hermes cron run."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime
from typing import Any


SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
SAFE_REASON = re.compile(r"^[a-z][a-z0-9_.:-]{0,79}$")


def _validated_event(payload: object) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    if payload.get("schema") != "live_dashboard.controller_event.v1" or payload.get("v") != 1:
        return None
    if payload.get("event_type") != "supervision.deviation_detected":
        return None
    event_id = payload.get("event_id")
    occurred_at = payload.get("occurred_at")
    source = payload.get("source")
    device_ids = payload.get("device_ids")
    reason_codes = payload.get("reason_codes")
    if not isinstance(event_id, str) or not SAFE_ID.fullmatch(event_id):
        return None
    if not isinstance(occurred_at, str):
        return None
    try:
        parsed_at = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed_at.tzinfo is None or source not in {"scheduled", "report"}:
        return None
    if not isinstance(device_ids, list) or not 1 <= len(device_ids) <= 20:
        return None
    if not all(isinstance(value, str) and SAFE_ID.fullmatch(value) for value in device_ids):
        return None
    if not isinstance(reason_codes, list) or not 1 <= len(reason_codes) <= 20:
        return None
    if not all(isinstance(value, str) and SAFE_REASON.fullmatch(value) for value in reason_codes):
        return None
    return {
        "schema": "live_dashboard.controller_event.v1",
        "v": 1,
        "event_id": event_id,
        "event_type": "supervision.deviation_detected",
        "occurred_at": occurred_at,
        "source": source,
        "device_ids": device_ids,
        "reason_codes": reason_codes,
    }


def _event_from_stdin() -> dict[str, Any] | None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return None
    return _validated_event(payload)


def _run_cli(*args: str) -> bool:
    completed = subprocess.run(
        [sys.executable, "-m", "hermes_cli.main", *args],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=20,
        check=False,
    )
    return completed.returncode == 0


def main() -> int:
    event = _event_from_stdin()
    job_id = os.environ.get("HERMES_LIVE_SUPERVISION_JOB_ID", "").strip()
    if not event or not job_id:
        return 1
    compact = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    if not _run_cli("cron", "notepad", job_id, "set", "last_live_event", compact):
        return 1
    if not _run_cli("cron", "run", job_id):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
