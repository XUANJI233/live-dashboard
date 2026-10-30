#!/usr/bin/env python3
"""Read the deterministic Live rest state before any Hermes model call."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from live_mcp import LiveMcpError, call_tool


REST_STATES = {"asleep", "screen_off", "active", "unknown"}
GATE_TIMEOUT_SECONDS = 2.0


def rest_state_from_content(content: object) -> str:
    state = content.get("rest_state") if isinstance(content, dict) else None
    return state if state in REST_STATES else "unknown"


def read_live_rest_state() -> str:
    """Any failure reads as unknown, which never suppresses contact."""
    try:
        return rest_state_from_content(call_tool("live_dashboard.get_rest_state", {}, timeout=GATE_TIMEOUT_SECONDS))
    except LiveMcpError:
        return "unknown"
