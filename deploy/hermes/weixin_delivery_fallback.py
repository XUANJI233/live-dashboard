#!/usr/bin/env python3
"""Put a proactive message on the phone when Weixin refused to deliver it.

iLink rejects many proactive sends (`business_rejected ... prepare failed`), so a nudge the model
wrote can silently never arrive. This no-agent job looks for cron runs whose delivery failed and
sends the same text as a Live `say` notification to the Android phone. It never calls a model.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cron_outputs import is_sendable_response, latest_output, response_from_output
from live_mcp import LiveMcpError, call_tool


STATE_NAME = "weixin-delivery-fallback.json"
MAX_AGE_SECONDS = 30 * 60
MAX_SAY_CHARS = 500
HANDLED_RING = 64
MESSAGE_SEPARATOR = "⟦MSG⟧"


def failed_deliveries(home: Path, now: float, handled: set[str]) -> list[tuple[str, str]]:
    """(output id, text) for recent, sendable cron responses whose delivery failed."""
    try:
        jobs = json.loads((home / "cron" / "jobs.json").read_text(encoding="utf-8"))["jobs"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return []
    found = []
    for job in jobs:
        if not isinstance(job, dict) or not job.get("last_delivery_error") or not isinstance(job.get("id"), str):
            continue
        output = latest_output(home, job["id"])
        if output is None or now - output.stat().st_mtime > MAX_AGE_SECONDS:
            continue
        output_id = f"{job['id']}:{output.name}"
        text = phone_text(response_from_output(output))
        if output_id not in handled and text:
            found.append((output_id, text))
    return found


def phone_text(response: str) -> str:
    if not is_sendable_response(response):
        return ""
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
    pending = failed_deliveries(home, time.time(), set(handled))
    if not pending:
        return 0
    try:
        device_id = phone_device_id()
        for output_id, text in pending:
            if device_id:
                call_tool("live_dashboard.send_device_commands", {
                    "request_id": "weixin-fallback-" + hashlib.sha256(output_id.encode("utf-8")).hexdigest()[:24],
                    "created_by": "supervision",
                    "commands": [{"device_id": device_id, "say": text}],
                })
            handled.append(output_id)
    except LiveMcpError:
        # Live unreachable: leave the rest for the next tick.
        pass
    save_handled(state_path, handled)
    # A no-agent job's stdout would itself be delivered; stay silent.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
