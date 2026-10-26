#!/usr/bin/env python3
"""Enable durable ACKs and AI-work delivery on the existing Live subscription."""

from __future__ import annotations

import json
import os
from pathlib import Path


ROUTE_NAME = "live-supervision"


def configure(path: Path) -> None:
    ownership = path.stat()
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("webhook subscriptions must be an object")
    route = value.get(ROUTE_NAME)
    if not isinstance(route, dict) or route.get("script") != "trigger_live_supervision.py":
        raise ValueError("live-supervision script route is missing")
    route["script_ack_required"] = True
    events = route.get("events")
    # An empty filter already accepts all event types. Preserve that contract
    # and any custom events while adding the client AI-work source.
    if isinstance(events, list) and events and "ai.work_requested" not in events:
        events.append("ai.work_requested")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    if hasattr(os, "chown"):
        os.chown(temporary, ownership.st_uid, ownership.st_gid)
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def main() -> int:
    root = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    configure(root / "webhook_subscriptions.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
