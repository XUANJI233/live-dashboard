import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ui_messages import merge_new_messages, message_detail, message_key, message_sender, message_summary


class UiMessageTests(unittest.TestCase):
    def test_message_key_accepts_message_id_or_id(self):
        self.assertEqual(message_key({"message_id": "msg_1"}), "msg_1")
        self.assertEqual(message_key({"id": "msg_2"}), "msg_2")

    def test_message_summary_uses_sender_and_single_line_preview(self):
        summary = message_summary({
            "viewer_name": "AI 监督",
            "text": "第一行\n第二行",
        })

        self.assertEqual(summary, "AI 监督: 第一行 第二行")

    def test_message_detail_uses_stable_empty_values(self):
        detail = message_detail({
            "viewer_id": "viewer_1",
            "queued": True,
            "text": "",
        })

        self.assertIn("发送者: viewer_1", detail)
        self.assertIn("时间: 未知", detail)
        self.assertIn("排队: 是", detail)
        self.assertTrue(detail.endswith("无内容"))

    def test_merge_new_messages_deduplicates_and_limits(self):
        existing = [{"message_id": "msg_1", "text": "old"}]
        incoming = [
            {"message_id": "msg_1", "text": "dupe"},
            {"message_id": "msg_2", "text": "new"},
        ]

        merged = merge_new_messages(existing, incoming, limit=2)

        self.assertEqual([item["message_id"] for item in merged], ["msg_2", "msg_1"])

    def test_message_sender_falls_back_to_unknown(self):
        self.assertEqual(message_sender({}), "未知")


if __name__ == "__main__":
    unittest.main()
