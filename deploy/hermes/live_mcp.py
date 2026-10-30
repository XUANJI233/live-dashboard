"""Minimal authenticated tools/call client for the local Live MCP listener."""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.request import Request, urlopen


DEFAULT_MCP_URL = "http://127.0.0.1:3031/api/mcp"
MAX_RESPONSE_BYTES = 256 * 1024
# Same precedence as live_state_gate: the key Hermes holds for its Live MCP server passes the
# cron script sandbox, so no second copy of the secret is needed.
TOKEN_ENV_NAMES = ("LIVE_DASHBOARD_MCP_TOKEN", "MCP_SERVER_TOKEN", "MCP_LIVE_DASHBOARD_API_KEY")


class LiveMcpError(RuntimeError):
    pass


def call_tool(name: str, arguments: dict[str, Any], timeout: float = 10.0) -> dict[str, Any]:
    url = os.environ.get("LIVE_DASHBOARD_MCP_URL", DEFAULT_MCP_URL).strip() or DEFAULT_MCP_URL
    token = next((os.environ.get(key, "").strip() for key in TOKEN_ENV_NAMES if os.environ.get(key, "").strip()), "")
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": name, "arguments": arguments}}).encode("utf-8")
    try:
        with urlopen(Request(url, data=body, headers=headers, method="POST"), timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except OSError as error:
        raise LiveMcpError(f"unreachable:{type(error).__name__}") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise LiveMcpError("oversized")
    try:
        result = json.loads(raw).get("result") or {}
    except (ValueError, AttributeError) as error:
        raise LiveMcpError("invalid_response") from error
    content = result.get("structuredContent") if isinstance(result, dict) else None
    if not isinstance(content, dict) or result.get("isError"):
        raise LiveMcpError(str((content or {}).get("error") or "tool_failed"))
    return content
