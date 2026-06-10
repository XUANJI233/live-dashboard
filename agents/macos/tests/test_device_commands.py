import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from device_commands import execute_desktop_command, extract_device_command, receipt_frame
from device_profile import with_device_capabilities


class DeviceCommandTests(unittest.TestCase):
    def test_extracts_current_queued_device_command_payload(self):
        envelope = {
            "type": "device_command",
            "request_id": "req_test",
            "command_id": "cmd_test",
            "issued_at": "2026-06-11T00:00:00.000Z",
            "payload": {"kind": "supervision", "say": "回到目标"},
        }

        self.assertIs(extract_device_command({"type": "viewer_message", "payload": envelope}), envelope)

    def test_desktop_command_applies_say_and_builds_result(self):
        envelope = {
            "type": "device_command",
            "request_id": "req_test",
            "command_id": "cmd_test",
            "created_by": "supervision",
            "issued_at": "2026-06-11T00:00:00.000Z",
            "payload": {
                "kind": "supervision",
                "freeze_commands": [],
                "unfreeze_commands": [],
                "vibrate": False,
                "screen_off": False,
                "say": "回到目标",
            },
        }

        receipt = receipt_frame(envelope)
        result, message = execute_desktop_command(envelope)

        self.assertEqual(receipt["type"], "device_command_receipt")
        self.assertEqual(receipt["command_id"], "cmd_test")
        self.assertEqual(result["type"], "device_command_result")
        self.assertEqual(result["status"], "applied")
        self.assertEqual(result["result_id"], "res_cmd_test")
        self.assertEqual(result["state_after"], {"desktop_message_visible": True})
        self.assertEqual(message["text"], "回到目标")
        self.assertEqual(message["viewer_name"], "AI 监督")

    def test_desktop_command_reports_unsupported_controls(self):
        envelope = {
            "type": "device_command",
            "request_id": "req_test",
            "command_id": "cmd_control",
            "payload": {
                "kind": "supervision",
                "freeze_commands": ["com.video"],
                "unfreeze_commands": ["全部"],
                "vibrate": True,
                "screen_off": True,
                "say": "",
            },
        }

        result, message = execute_desktop_command(envelope)

        self.assertEqual(result["status"], "unsupported")
        self.assertIn("freeze", result["reason"])
        self.assertIn("unfreeze", result["reason"])
        self.assertIn("vibrate", result["reason"])
        self.assertIn("screen_off", result["reason"])
        self.assertIsNone(message)

    def test_numeric_booleans_do_not_enable_controls(self):
        envelope = {
            "type": "device_command",
            "request_id": "req_test",
            "command_id": "cmd_numeric",
            "payload": {
                "kind": "supervision",
                "freeze_commands": [],
                "unfreeze_commands": [],
                "vibrate": 1,
                "screen_off": 1,
                "say": "",
            },
        }

        result, message = execute_desktop_command(envelope)

        self.assertEqual(result["status"], "ignored")
        self.assertEqual(result["reason"], "empty_desktop_command")
        self.assertIsNone(message)

    def test_supervision_policy_is_not_executed_on_desktop(self):
        envelope = {
            "type": "device_command",
            "request_id": "req_policy",
            "command_id": "cmd_policy",
            "payload": {
                "kind": "supervision_policy",
                "risk_app_regex": ["Video"],
                "risk_trigger_minutes": 5,
                "app_time_limits": [{"app_regex": "Game", "limit_minutes": 10, "reason": "limit"}],
                "say": "",
            },
        }

        result, message = execute_desktop_command(envelope)

        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(result["reason"], "policy_requires_android_lsp")
        self.assertIsNone(message)

    def test_report_extra_uses_desktop_message_capabilities(self):
        extra = with_device_capabilities({
            "battery_percent": 80,
            "device": {"offline_timeout_minutes": 5},
        })

        self.assertEqual(extra["battery_percent"], 80)
        self.assertEqual(extra["device"]["offline_timeout_minutes"], 5)
        self.assertEqual(extra["device"]["profile"], "desktop_message")
        self.assertEqual(
            extra["device"]["capabilities"],
            {
                "freeze": False,
                "unfreeze": False,
                "vibrate": False,
                "screen_off": False,
                "say": True,
            },
        )


if __name__ == "__main__":
    unittest.main()
