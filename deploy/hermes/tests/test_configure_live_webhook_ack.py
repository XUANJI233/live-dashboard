import importlib.util
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


SCRIPT = Path(__file__).parents[1] / "configure_live_webhook_ack.py"
SPEC = importlib.util.spec_from_file_location("configure_live_webhook_ack", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ConfigureLiveWebhookAckTest(unittest.TestCase):
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
