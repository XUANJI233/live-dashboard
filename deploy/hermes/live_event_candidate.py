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
from live_event_queue import mark_done, move, pending_records, prune_done, stage_records


NO_CANDIDATE = '{"selected_this_run":false}'
CONSUMER_JOB = "live-supervision-review"
# Mirrors Live's own delivery TTLs (controller-event-retry.ts): an event older than this would
# already have expired in the outbox, so it no longer describes the present.
TTL_SECONDS = {
    "supervision.review_requested": 30 * 60,
    "supervision.deviation_detected": 30 * 60,
    "device.offline": 2 * 60 * 60,
    "ai.work_requested": 24 * 60 * 60,
}
PRIORITY = ("ai.work_requested", "supervision.deviation_detected", "supervision.review_requested", "device.offline")
MAX_ATTEMPTS = 3
INFLIGHT_STALE_SECONDS = 30 * 60
MAX_REASON_CODES = 20


def select_event(
    records: list[tuple[Path, dict[str, Any]]], now: float,
) -> tuple[tuple[Path, dict[str, Any]] | None, list[tuple[Path, str]], list[tuple[Path, dict[str, Any]]]]:
    """Return the record to run now, the records to retire without a run, and the surviving
    records whose reason codes absorbed a superseded review (to be written back)."""
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

    # Only the newest review of a device describes its present; it inherits the reasons of the
    # reviews it replaces, as Live's outbox would have merged them. AI work is a durable queue item.
    newest: dict[tuple[str, tuple[str, ...]], tuple[Path, dict[str, Any], float]] = {}
    keep: list[tuple[Path, dict[str, Any], float]] = []
    merged: set[Path] = set()
    for item in sorted(live, key=lambda value: value[2]):
        event = item[1]["event"]
        if event["event_type"] == "ai.work_requested":
            keep.append(item)
            continue
        family = "offline" if event["event_type"] == "device.offline" else "supervision"
        key = (family, tuple(sorted(event.get("device_ids") or [])))
        if key in newest:
            older = newest[key]
            retired.append((older[0], "superseded"))
            codes = list(event.get("reason_codes") or [])
            for code in older[1]["event"].get("reason_codes") or []:
                if code not in codes and len(codes) < MAX_REASON_CODES:
                    codes.append(code)
            event["reason_codes"] = codes
            merged.discard(older[0])
            merged.add(item[0])
        newest[key] = item
    keep.extend(newest.values())
    updated = [(path, record) for path, record, _ in keep if path in merged]
    if not keep:
        return None, retired, updated
    chosen = min(keep, key=lambda value: (PRIORITY.index(value[1]["event"]["event_type"]), value[2]))
    return (chosen[0], chosen[1]), retired, updated


def settle_inflight(home: Path, now: float, last_run: tuple[float | None, str]) -> None:
    """Settle what the previous tick dispatched, now that its run has finished."""
    run_at, status = last_run
    for path, record in stage_records(home, "inflight"):
        dispatched = float(record.get("dispatched_at") or 0)
        attempts = int(record.get("attempts") or 1)
        if run_at is not None and run_at >= dispatched:
            if status == "error" and attempts < MAX_ATTEMPTS:
                move(home, path, "pending", {**record, "attempts": attempts + 1})
            else:
                mark_done(home, path, "failed" if status == "error" else "handled", record)
        elif now - dispatched > INFLIGHT_STALE_SECONDS:
            mark_done(home, path, "stale", record)


def consumer_last_run(home: Path) -> tuple[float | None, str]:
    try:
        jobs = json.loads((home / "cron" / "jobs.json").read_text(encoding="utf-8"))["jobs"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return None, ""
    job = next((item for item in jobs if isinstance(item, dict) and item.get("name") == CONSUMER_JOB), None)
    if not job:
        return None, ""
    return _epoch(job.get("last_run_at")), str(job.get("last_status") or "")


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
        settle_inflight(home, now, consumer_last_run(home))
        chosen, retired, updated = select_event(pending_records(home), now)
        # Persist merged reasons before retiring what they came from, so a crash loses nothing.
        for path, merged_record in updated:
            if chosen is None or path != chosen[0]:
                move(home, path, "pending", merged_record)
        for path, outcome in retired:
            mark_done(home, path, outcome)
        if chosen is None:
            print(script_gate(NO_CANDIDATE))
            return 0
        path, record = chosen
        # Held in inflight/ so a run that fails is retried, while a finished one never replays.
        move(home, path, "inflight", {**record, "attempts": int(record.get("attempts") or 1), "dispatched_at": now})
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(script_gate(NO_CANDIDATE, error=f"event_queue_unavailable:{type(error).__name__}"))
        return 0
    output = candidate_output(record)
    print(script_gate(output, context=wake_context(home, output)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
