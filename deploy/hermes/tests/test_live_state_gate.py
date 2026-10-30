import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).parents[1]
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("live_state_gate", SCRIPTS / "live_state_gate.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
import live_mcp  # noqa: E402  the gate's transport, patched below


def tool_result(content, *, error=False):
    return {"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": content, **({"isError": True} if error else {})}}


class FakeResponse(io.BytesIO):
    headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def serve(payload, seen=None):
    def fake_urlopen(request, timeout):
        if seen is not None:
            seen.update(url=request.full_url, auth=request.get_header("Authorization"),
                        body=json.loads(request.data), timeout=timeout)
        return FakeResponse(json.dumps(payload).encode("utf-8"))
    return fake_urlopen


class LiveStateGateTest(unittest.TestCase):
    def test_reported_states_pass_through_and_anything_else_is_unknown(self):
        for state in ("asleep", "screen_off", "active"):
            self.assertEqual(MODULE.rest_state_from_content({"rest_state": state}), state)
        self.assertEqual(MODULE.rest_state_from_content({"rest_state": "bad"}), "unknown")
        self.assertEqual(MODULE.rest_state_from_content(None), "unknown")

    def test_reads_the_local_mcp_tool_with_the_controller_token(self):
        seen = {}
        with mock.patch.dict("os.environ", {"LIVE_DASHBOARD_MCP_TOKEN": "gate-token"}, clear=True), \
                mock.patch.object(live_mcp, "urlopen", serve(tool_result({"rest_state": "screen_off"}), seen)):
            self.assertEqual(MODULE.read_live_rest_state(), "screen_off")
        self.assertEqual(seen["url"], "http://127.0.0.1:3031/api/mcp")
        self.assertEqual(seen["auth"], "Bearer gate-token")
        self.assertEqual(seen["body"]["params"], {"name": "live_dashboard.get_rest_state", "arguments": {}})
        self.assertEqual(seen["timeout"], MODULE.GATE_TIMEOUT_SECONDS)

    def test_tool_errors_and_an_unreachable_live_are_unknown(self):
        def refused(request, timeout):
            raise OSError("connection refused")

        for transport in (refused, serve(tool_result({"ok": False, "error": "unauthorized"}, error=True)), serve({})):
            with self.subTest(transport=transport), mock.patch.object(live_mcp, "urlopen", transport):
                self.assertEqual(MODULE.read_live_rest_state(), "unknown")


class LiveMcpClientTest(unittest.TestCase):
    def test_falls_back_to_the_key_hermes_holds_for_its_live_mcp_server(self):
        seen = {}
        with mock.patch.dict("os.environ", {"MCP_LIVE_DASHBOARD_API_KEY": "hermes-mcp-key"}, clear=True), \
                mock.patch.object(live_mcp, "urlopen", serve(tool_result({"ok": True}), seen)):
            self.assertEqual(live_mcp.call_tool("live_dashboard.list_devices", {}), {"ok": True})
        self.assertEqual(seen["auth"], "Bearer hermes-mcp-key")

    def test_a_flagged_tool_failure_raises_its_code(self):
        with mock.patch.object(live_mcp, "urlopen", serve(tool_result({"ok": False, "error": "device_offline"}, error=True))):
            with self.assertRaisesRegex(live_mcp.LiveMcpError, "device_offline"):
                live_mcp.call_tool("live_dashboard.send_device_commands", {})


if __name__ == "__main__":
    unittest.main()
