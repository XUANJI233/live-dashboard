import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "trigger_live_supervision.py"
SPEC = importlib.util.spec_from_file_location("trigger_live_supervision", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class TriggerLiveSupervisionTest(unittest.TestCase):
    def test_accepts_only_the_v1_supervision_event_contract(self):
        event = {
            "schema": "live_dashboard.controller_event.v1",
            "v": 1,
            "event_id": "supervision:494677:0123456789abcdefabcd",
            "event_type": "supervision.deviation_detected",
            "occurred_at": "2026-08-31T12:00:00.000Z",
            "source": "report",
            "device_ids": ["android-main"],
            "reason_codes": ["deviation_confirmed"],
        }

        self.assertEqual(MODULE._validated_event(event), event)

    def test_rejects_malformed_or_unsupported_events(self):
        base = {
            "schema": "live_dashboard.controller_event.v1",
            "v": 1,
            "event_id": "supervision:494677:0123456789abcdefabcd",
            "event_type": "supervision.deviation_detected",
            "occurred_at": "2026-08-31T12:00:00.000Z",
            "source": "scheduled",
            "device_ids": ["android-main"],
            "reason_codes": ["deviation_confirmed"],
        }
        invalid = [
            {**base, "schema": "other"},
            {**base, "v": 2},
            {**base, "event_id": "../../bad"},
            {**base, "occurred_at": "not-a-time"},
            {**base, "source": "unknown"},
            {**base, "device_ids": "android-main"},
            {**base, "device_ids": ["../../bad"]},
            {**base, "reason_codes": {"bad": True}},
        ]

        for value in invalid:
            with self.subTest(value=value):
                self.assertIsNone(MODULE._validated_event(value))


if __name__ == "__main__":
    unittest.main()
