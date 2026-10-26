import importlib.util
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "configure_live_webhook_ack.py"
SPEC = importlib.util.spec_from_file_location("configure_live_webhook_ack", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ConfigureLiveWebhookAckTest(unittest.TestCase):
    def test_atomic_replacement_preserves_service_file_owner(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "webhook_subscriptions.json"
            path.write_text(json.dumps({"live-supervision": {"script": "trigger_live_supervision.py"}}))
            before = path.stat()
            with patch.object(MODULE.os, "chown", create=True) as chown:
                MODULE.configure(path)
            chown.assert_called_once_with(path.with_suffix(".tmp"), before.st_uid, before.st_gid)

    def test_existing_filter_accepts_ai_work_without_losing_other_events(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "webhook_subscriptions.json"
            original = ["supervision.review_requested", "device.offline", "custom.event"]
            path.write_text(json.dumps({"live-supervision": {
                "secret": "keep-me", "script": "trigger_live_supervision.py", "events": original,
            }}), encoding="utf-8")
            MODULE.configure(path)
            MODULE.configure(path)
            route = json.loads(path.read_text(encoding="utf-8"))["live-supervision"]
            self.assertEqual(route["events"], original + ["ai.work_requested"])
            self.assertEqual(route["secret"], "keep-me")

    def test_unfiltered_route_stays_unfiltered(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "webhook_subscriptions.json"
            path.write_text(json.dumps({"live-supervision": {
                "script": "trigger_live_supervision.py", "events": [],
            }}), encoding="utf-8")
            MODULE.configure(path)
            self.assertEqual(json.loads(path.read_text())["live-supervision"]["events"], [])

    def test_preserves_route_and_secret_while_enabling_ack(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "webhook_subscriptions.json"
            path.write_text(
                json.dumps(
                    {
                        "live-supervision": {
                            "secret": "keep-me",
                            "script": "trigger_live_supervision.py",
                        },
                        "other": {"secret": "other"},
                    }
                ),
                encoding="utf-8",
            )

            MODULE.configure(path)

            result = json.loads(path.read_text(encoding="utf-8"))
            self.assertTrue(result["live-supervision"]["script_ack_required"])
            self.assertEqual(result["live-supervision"]["secret"], "keep-me")
            self.assertEqual(result["other"], {"secret": "other"})
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
