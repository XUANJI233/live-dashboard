#!/usr/bin/env python3
"""Turn one authenticated Live webhook into an attached Hermes cron run."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any


def _event_from_stdin() -> dict[str, Any] | None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("event_type") != "supervision.deviation_detected":
        return None
    return {
        "schema": str(payload.get("schema") or "")[:80],
        "event_id": str(payload.get("event_id") or "")[:160],
        "event_type": "supervision.deviation_detected",
        "occurred_at": str(payload.get("occurred_at") or "")[:80],
        "source": str(payload.get("source") or "")[:40],
        "device_ids": [str(value)[:160] for value in (payload.get("device_ids") or [])[:20]],
        "reason_codes": [str(value)[:80] for value in (payload.get("reason_codes") or [])[:20]],
    }


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
