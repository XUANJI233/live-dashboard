import importlib.util
import json
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "trigger_live_supervision.py"
SPEC = importlib.util.spec_from_file_location("trigger_live_supervision_contract", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

# The same fixture runs in packages/backend/tests/controller-event-contract.test.ts.
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "controller_events.json").read_text(encoding="utf-8"))


class ControllerEventContractTest(unittest.TestCase):
    def test_hermes_accepts_every_event_live_may_send(self):
        for case in FIXTURE["valid"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(MODULE._validated_event(case["event"]), case["event"])

    def test_hermes_rejects_every_event_live_must_not_send(self):
        for case in FIXTURE["invalid"]:
            with self.subTest(case=case["name"]):
                self.assertIsNone(MODULE._validated_event(case["event"]))


if __name__ == "__main__":
    unittest.main()
