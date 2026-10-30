import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "live_state_gate.py"
SPEC = importlib.util.spec_from_file_location("live_state_gate", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def tool_result(state):
    return {"jsonrpc": "2.0", "id": 1, "result": {"structuredContent": {"rest_state": state}}}


class FakeResponse(io.BytesIO):
    headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class LiveStateGateTest(unittest.TestCase):
    def test_watch_or_phone_sleep_is_authoritative(self):
        self.assertEqual(MODULE.rest_state_from_result(tool_result("asleep")), "asleep")

    def test_idle_phone_is_screen_off_but_not_confirmed_sleep(self):
        self.assertEqual(MODULE.rest_state_from_result(tool_result("screen_off")), "screen_off")

    def test_active_phone_keeps_normal_cadence(self):
        self.assertEqual(MODULE.rest_state_from_result(tool_result("active")), "active")

    def test_missing_invalid_or_error_result_is_unknown(self):
        self.assertEqual(MODULE.rest_state_from_result({}), "unknown")
        self.assertEqual(MODULE.rest_state_from_result(tool_result("bad")), "unknown")
        self.assertEqual(MODULE.rest_state_from_result({"result": {"isError": True, "content": []}}), "unknown")

    def test_reads_the_local_mcp_tool_with_the_controller_token(self):
        seen = {}

        def fake_urlopen(request, timeout):
            seen["url"] = request.full_url
            seen["auth"] = request.get_header("Authorization")
            seen["body"] = json.loads(request.data)
            return FakeResponse(json.dumps(tool_result("screen_off")).encode("utf-8"))

        with mock.patch.dict("os.environ", {"LIVE_DASHBOARD_MCP_TOKEN": "gate-token"}, clear=False), \
                mock.patch.object(MODULE, "urlopen", fake_urlopen):
            self.assertEqual(MODULE.read_live_rest_state(), "screen_off")
        self.assertEqual(seen["url"], "http://127.0.0.1:3031/api/mcp")
        self.assertEqual(seen["auth"], "Bearer gate-token")
        self.assertEqual(seen["body"]["params"]["name"], "live_dashboard.get_rest_state")

    def test_falls_back_to_the_key_hermes_holds_for_its_live_mcp_server(self):
        seen = {}

        def fake_urlopen(request, timeout):
            seen["auth"] = request.get_header("Authorization")
            return FakeResponse(json.dumps(tool_result("active")).encode("utf-8"))

        with mock.patch.dict("os.environ", {"MCP_LIVE_DASHBOARD_API_KEY": "hermes-mcp-key"}, clear=True), \
                mock.patch.object(MODULE, "urlopen", fake_urlopen):
            self.assertEqual(MODULE.read_live_rest_state(), "active")
        self.assertEqual(seen["auth"], "Bearer hermes-mcp-key")

    def test_an_unreachable_live_is_unknown(self):
        def refused(request, timeout):
            raise OSError("connection refused")

        with mock.patch.object(MODULE, "urlopen", refused):
            self.assertEqual(MODULE.read_live_rest_state(), "unknown")


if __name__ == "__main__":
    unittest.main()
