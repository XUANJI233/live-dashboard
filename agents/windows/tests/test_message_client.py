import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import MessageClient


class _Response:
    status_code = 200

    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


class _Session:
    def __init__(self, body):
        self._body = body
        self.headers = {}

    def get(self, *_args, **_kwargs):
        return _Response(self._body)

    def close(self):
        pass


class _RecordingMessageClient(MessageClient):
    def __init__(self, body):
        super().__init__("https://example.test", "token")
        self._session = _Session(body)
        self.sent_frames = []

    def _send_command_ack(self, frame: dict) -> bool:
        self.sent_frames.append(frame)
        return True


class MessageClientTests(unittest.TestCase):
    def test_fetch_pending_returns_only_plain_messages_after_handling_commands(self):
        client = _RecordingMessageClient({
            "messages": [
                {
                    "id": "cmd_policy",
                    "viewer_id": "__mcp__",
                    "kind": "private",
                    "text": "监督策略更新",
                    "payload": {
                        "type": "device_command",
                        "request_id": "req_policy",
                        "command_id": "cmd_policy",
                        "payload": {"kind": "supervision_policy"},
                    },
                },
                {
                    "id": "msg_plain",
                    "viewer_id": "viewer_1",
                    "kind": "private",
                    "text": "hello",
                },
            ],
        })
        notified = []
        client.on_message(notified.append)

        messages = client.fetch_pending()

        self.assertEqual([item["message_id"] for item in messages], ["msg_plain"])
        self.assertEqual([item["message_id"] for item in notified], ["msg_plain"])
        self.assertEqual([frame["type"] for frame in client.sent_frames], [
            "device_command_receipt",
            "device_command_result",
        ])


if __name__ == "__main__":
    unittest.main()
