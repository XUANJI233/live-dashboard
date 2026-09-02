#!/usr/bin/env python3
"""Summarize Hermes cron token usage without invoking a model."""

from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


TIMEZONE = timezone(timedelta(hours=8), name="UTC+08:00")


def summarize_usage(
    records: Iterable[dict[str, Any]],
    job_names: dict[str, str],
    local_date: str,
) -> dict[str, Any]:
    grouped: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "calls": 0,
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
        "silent_calls": 0,
        "errors": 0,
    })
    for record in records:
        try:
            occurred = datetime.fromisoformat(str(record.get("ts") or "").replace("Z", "+00:00"))
        except ValueError:
            continue
        if occurred.astimezone(TIMEZONE).date().isoformat() != local_date:
            continue
        job_id = str(record.get("job_id") or "unknown")
        item = grouped[job_id]
        item["calls"] += 1
        item["prompt_tokens"] += _integer(record.get("prompt_tokens"))
        item["completion_tokens"] += _integer(record.get("completion_tokens"))
        item["total_tokens"] += _integer(record.get("total_tokens"))
        item["silent_calls"] += int(record.get("response_silent") is True)
        item["errors"] += int(bool(record.get("error")))
    jobs = []
    for job_id, totals in grouped.items():
        jobs.append({"job_id": job_id, "name": job_names.get(job_id, "removed-job"), **totals})
    jobs.sort(key=lambda item: (-item["total_tokens"], item["name"]))
    return {
        "local_date": local_date,
        "total_tokens": sum(item["total_tokens"] for item in jobs),
        "calls": sum(item["calls"] for item in jobs),
        "jobs": jobs,
    }


def main() -> int:
    root = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    local_date = os.environ.get("HERMES_USAGE_DATE") or datetime.now(TIMEZONE).date().isoformat()
    jobs = _job_names(root / "cron" / "jobs.json")
    records = _records(root / "cron" / "usage_audit.jsonl")
    print(json.dumps(summarize_usage(records, jobs, local_date), ensure_ascii=False, separators=(",", ":")))
    return 0


def _job_names(path: Path) -> dict[str, str]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {
        str(item.get("id")): str(item.get("name") or item.get("id"))
        for item in payload.get("jobs", [])
        if isinstance(item, dict) and item.get("id")
    }


def _records(path: Path) -> Iterable[dict[str, Any]]:
    try:
        handle = path.open(encoding="utf-8", errors="replace")
    except OSError:
        return
    with handle:
        for line in handle:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                yield item


def _integer(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
