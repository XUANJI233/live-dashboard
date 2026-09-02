#!/usr/bin/env python3
"""Read the deterministic Live rest state before any Hermes model call."""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.request import Request, urlopen


MAX_RESPONSE_BYTES = 1024 * 1024
DEFAULT_CURRENT_URL = "http://127.0.0.1:3000/api/current"


def rest_state_from_current(payload: object) -> str:
    if not isinstance(payload, dict):
        return "unknown"
    state = payload.get("rest_state")
    return state if state in {"asleep", "screen_off", "active", "unknown"} else "unknown"


def read_live_rest_state() -> str:
    url = os.environ.get("LIVE_DASHBOARD_CURRENT_URL", DEFAULT_CURRENT_URL).strip() or DEFAULT_CURRENT_URL
    try:
        request = Request(url, headers={"Accept": "application/json", "User-Agent": "hermes-live-state-gate/1"})
        with urlopen(request, timeout=2) as response:
            length = response.headers.get("Content-Length")
            if length and int(length) > MAX_RESPONSE_BYTES:
                return "unknown"
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            return "unknown"
        return rest_state_from_current(json.loads(body))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return "unknown"
