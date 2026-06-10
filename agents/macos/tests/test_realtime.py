import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from realtime import DeviceCommandClient


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


class FakeSession:
    def __init__(self, response):
        self.headers = {}
        self.response = response
        self.posts = []
        self.closed = False

    def get(self, _url, timeout):
        return self.response

    def post(self, url, json, timeout):
        self.posts.append({"url": url, "json": json, "timeout": timeout})
        return FakeResponse(200, {"received": True})

    def close(self):
        self.closed = True


class RealtimeTests(unittest.TestCase):
    def test_fetch_pending_consumes_current_messages_contract(self):
        envelope = {
            "type": "device_command",
            "request_id": "req_test",
            "command_id": "cmd_test",
            "created_by": "mcp",
            "payload": {"kind": "supervision", "say": "测试提醒"},
        }
        session = FakeSession(FakeResponse(200, {
            "messages": [{"id": "cmd_test", "payload": envelope}],
        }))
        delivered = []
        client = DeviceCommandClient(
            "https://example.test",
            "token",
            on_desktop_message=delivered.append,
        )
        client._session = session

        handled = client.fetch_pending()

        self.assertEqual(handled, 1)
        self.assertEqual([item["json"]["type"] for item in session.posts], [
            "device_command_receipt",
            "device_command_result",
        ])
        self.assertEqual(session.posts[-1]["json"]["status"], "applied")
        self.assertEqual(delivered[0]["text"], "测试提醒")

    def test_fetch_pending_does_not_accept_legacy_list_response(self):
        envelope = {
            "type": "device_command",
            "request_id": "req_test",
            "command_id": "cmd_test",
            "payload": {"kind": "supervision", "say": "旧响应"},
        }
        session = FakeSession(FakeResponse(200, [{"payload": envelope}]))
        client = DeviceCommandClient("https://example.test", "token")
        client._session = session

        handled = client.fetch_pending()

        self.assertEqual(handled, 0)
        self.assertEqual(session.posts, [])


if __name__ == "__main__":
    unittest.main()
