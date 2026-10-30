#!/usr/bin/env python3
"""Put a proactive message on the phone when Weixin refused to deliver it.

iLink rejects many proactive sends (`business_rejected ... prepare failed`), so a nudge the model
wrote can silently never arrive. Hermes mirrors a cron delivery into the conversation only after
the platform accepted it, so a recent sendable cron response with no mirror was not delivered.
This no-agent job sends such text to the Android phone as a Live `say` notification, once. It
never calls a model.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
import time
from contextlib import closing
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cron_outputs import is_sendable_response, response_from_output
from live_mcp import LiveMcpError, call_tool
from weixin_session import mirrored_delivery, open_readonly


STATE_NAME = "weixin-delivery-fallback.json"
MAX_AGE_SECONDS = 30 * 60
# Delivery and its mirror happen right after the run writes its output.
SETTLE_SECONDS = 90
MIRROR_SLACK_SECONDS = 300
MAX_SAY_CHARS = 500
HANDLED_RING = 128
MESSAGE_SEPARATOR = "⟦MSG⟧"


def recent_responses(home: Path, now: float, handled: set[str]) -> list[dict[str, Any]]:
    """Settled, sendable responses of jobs that deliver to a chat, not yet handled."""
    try:
        jobs = json.loads((home / "cron" / "jobs.json").read_text(encoding="utf-8"))["jobs"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return []
    found = []
    for job in jobs:
        if not isinstance(job, dict) or not isinstance(job.get("id"), str) or job.get("deliver") in (None, "", "local"):
            continue
        for output in (home / "cron" / "output" / job["id"]).glob("*.md"):
            age = now - output.stat().st_mtime
            output_id = f"{job['id']}:{output.name}"
            if not SETTLE_SECONDS <= age <= MAX_AGE_SECONDS or output_id in handled:
                continue
            response = response_from_output(output)
            if is_sendable_response(response):
                found.append({"id": output_id, "job_name": str(job.get("name") or job["id"]),
                              "response": response, "written_at": output.stat().st_mtime})
    return sorted(found, key=lambda item: item["written_at"])


def undelivered(home: Path, responses: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Split responses into those Weixin never accepted and those it did."""
    if not responses:
        return [], []
    missing, delivered = [], []
    with closing(open_readonly(home)) as connection:
        for item in responses:
            first = item["response"].split(MESSAGE_SEPARATOR, 1)[0]
            if mirrored_delivery(connection, item["job_name"], first, item["written_at"] - MIRROR_SLACK_SECONDS):
                delivered.append(item["id"])
            else:
                missing.append(item)
    return missing, delivered


def phone_text(response: str) -> str:
    parts = [part.strip() for part in response.split(MESSAGE_SEPARATOR) if part.strip()]
    return "\n".join(parts)[:MAX_SAY_CHARS]


def phone_device_id() -> str | None:
    devices = call_tool("live_dashboard.list_devices", {}).get("devices") or []
    phones = [device for device in devices if isinstance(device, dict) and device.get("platform") == "android"
              and (device.get("capability") or {}).get("capabilities", {}).get("say") is True]
    phones.sort(key=lambda device: (device.get("is_online") is not True, str(device.get("device_id"))))
    return str(phones[0]["device_id"]) if phones else None


def load_handled(path: Path) -> list[str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [item for item in value.get("handled", []) if isinstance(item, str)] if isinstance(value, dict) else []


def save_handled(path: Path, handled: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"handled": handled[-HANDLED_RING:]}, ensure_ascii=False), encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def main() -> int:
    if os.environ.get("HERMES_CONTROLLER_ENABLED", "").strip().lower() != "true":
        return 0
    home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    state_path = home / "state" / STATE_NAME
    handled = load_handled(state_path)
    try:
        missing, delivered = undelivered(home, recent_responses(home, time.time(), set(handled)))
    except (OSError, ValueError, sqlite3.Error):
        return 0
    handled.extend(delivered)
    try:
        device_id = phone_device_id() if missing else None
        for item in missing:
            if device_id:
                call_tool("live_dashboard.send_device_commands", {
                    "request_id": "weixin-fallback-" + hashlib.sha256(item["id"].encode("utf-8")).hexdigest()[:24],
                    "created_by": "supervision",
                    "commands": [{"device_id": device_id, "say": phone_text(item["response"])}],
                })
            handled.append(item["id"])
    except LiveMcpError:
        # Live unreachable: the rest stays unhandled for the next tick.
        pass
    save_handled(state_path, handled)
    # A no-agent job's stdout would itself be delivered; stay silent.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
