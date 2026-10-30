#!/usr/bin/env python3
"""Gate the isolated Live event consumer: pick at most one spooled event per run."""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from candidate_script_gate import script_gate, wake_context
from live_event_queue import mark_done, pending_records, prune_done


NO_CANDIDATE = '{"selected_this_run":false}'
# Mirrors Live's own delivery TTLs (controller-event-retry.ts): an event older than this would
# already have expired in the outbox, so it no longer describes the present.
TTL_SECONDS = {
    "supervision.review_requested": 30 * 60,
    "supervision.deviation_detected": 30 * 60,
    "device.offline": 2 * 60 * 60,
    "ai.work_requested": 24 * 60 * 60,
}
PRIORITY = ("ai.work_requested", "supervision.deviation_detected", "supervision.review_requested", "device.offline")


def select_event(
    records: list[tuple[Path, dict[str, Any]]], now: float,
) -> tuple[tuple[Path, dict[str, Any]] | None, list[tuple[Path, str]]]:
    """Return the record to run now and the records to retire without a run."""
    retired: list[tuple[Path, str]] = []
    live: list[tuple[Path, dict[str, Any], float]] = []
    for path, record in records:
        event = record["event"]
        occurred = _epoch(event.get("occurred_at"))
        ttl = TTL_SECONDS.get(str(event.get("event_type")))
        if occurred is None or ttl is None:
            retired.append((path, "invalid"))
        elif now - occurred > ttl:
            retired.append((path, "expired"))
        else:
            live.append((path, record, occurred))

    # Only the newest review of a device describes its present; AI work is a durable queue item.
    newest: dict[tuple[str, tuple[str, ...]], tuple[Path, dict[str, Any], float]] = {}
    keep: list[tuple[Path, dict[str, Any], float]] = []
    for item in sorted(live, key=lambda value: value[2]):
        event = item[1]["event"]
        if event["event_type"] == "ai.work_requested":
            keep.append(item)
            continue
        family = "offline" if event["event_type"] == "device.offline" else "supervision"
        key = (family, tuple(sorted(event.get("device_ids") or [])))
        if key in newest:
            retired.append((newest[key][0], "superseded"))
        newest[key] = item
    keep.extend(newest.values())
    if not keep:
        return None, retired
    chosen = min(keep, key=lambda value: (PRIORITY.index(value[1]["event"]["event_type"]), value[2]))
    return (chosen[0], chosen[1]), retired


def candidate_output(record: dict[str, Any]) -> str:
    event = record["event"]
    return json.dumps(
        {
            "selected_this_run": True,
            "candidate_id": event["event_id"],
            "mode": record.get("mode") or "supervision",
            "event": event,
            "task": record.get("task"),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _epoch(value: object) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.timestamp() if parsed.tzinfo is not None else None


def main() -> int:
    if os.environ.get("HERMES_CONTROLLER_ENABLED", "").strip().lower() != "true":
        print(script_gate(NO_CANDIDATE))
        return 0
    home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    now = time.time()
    try:
        prune_done(home, now)
        chosen, retired = select_event(pending_records(home), now)
        for path, outcome in retired:
            mark_done(home, path, outcome)
        if chosen is None:
            print(script_gate(NO_CANDIDATE))
            return 0
        # Retire before the run: a failed run must not replay the same event every minute.
        mark_done(home, chosen[0], "dispatched")
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(script_gate(NO_CANDIDATE, error=f"event_queue_unavailable:{type(error).__name__}"))
        return 0
    output = candidate_output(chosen[1])
    print(script_gate(output, context=wake_context(home, output)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
