#!/usr/bin/env python3
"""Read the deterministic Live rest state before any Hermes model call."""

from __future__ import annotations

import json
import os
from urllib.request import Request, urlopen


MAX_RESPONSE_BYTES = 64 * 1024
# The local MCP listener: authenticated, not behind REQUIRE_EDGE, and not counted as a visitor.
DEFAULT_MCP_URL = "http://127.0.0.1:3031/api/mcp"
REST_STATES = {"asleep", "screen_off", "active", "unknown"}
# MCP_LIVE_DASHBOARD_API_KEY is the key Hermes already holds for its own Live MCP server; the
# cron script sandbox passes it through, so the gate needs no second copy of the secret.
TOKEN_ENV_NAMES = ("LIVE_DASHBOARD_MCP_TOKEN", "MCP_SERVER_TOKEN", "MCP_LIVE_DASHBOARD_API_KEY")


def rest_state_from_result(payload: object) -> str:
    """Extract rest_state from a get_rest_state JSON-RPC response; anything else is unknown."""
    if not isinstance(payload, dict):
        return "unknown"
    result = payload.get("result")
    content = result.get("structuredContent") if isinstance(result, dict) else None
    state = content.get("rest_state") if isinstance(content, dict) else None
    return state if state in REST_STATES else "unknown"


def read_live_rest_state() -> str:
    url = os.environ.get("LIVE_DASHBOARD_MCP_URL", DEFAULT_MCP_URL).strip() or DEFAULT_MCP_URL
    token = next((os.environ.get(name, "").strip() for name in TOKEN_ENV_NAMES if os.environ.get(name, "").strip()), "")
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "User-Agent": "hermes-live-state-gate/2",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "live_dashboard.get_rest_state", "arguments": {}},
    }).encode("utf-8")
    try:
        request = Request(url, data=body, headers=headers, method="POST")
        with urlopen(request, timeout=2) as response:
            length = response.headers.get("Content-Length")
            if length and int(length) > MAX_RESPONSE_BYTES:
                return "unknown"
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            return "unknown"
        return rest_state_from_result(json.loads(raw))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return "unknown"
