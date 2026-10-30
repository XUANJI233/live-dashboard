import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).parents[1] / "trigger_live_supervision.py"
SPEC = importlib.util.spec_from_file_location("trigger_live_supervision", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
import live_event_queue  # noqa: E402  importable once the script put its folder on sys.path


def supervision_event(event_type="supervision.review_requested"):
    return {
        "schema": "live_dashboard.controller_event.v1",
        "v": 1,
        "event_id": "supervision:494677:0123456789abcdefabcd",
        "event_type": event_type,
        "occurred_at": "2026-09-02T12:00:00.000Z",
        "source": "report",
        "device_ids": ["android-main"],
        "reason_codes": ["deviation_confirmed"],
    }


def offline_event():
    return {
        **supervision_event("device.offline"),
        "event_id": "device-offline:0123456789abcdefabcd",
        "source": "scheduled",
        "reason_codes": ["heartbeat_timeout"],
    }


def ai_event(kind="daily_summary", payload=None):
    if payload is None:
        payload = {"date": "2026-09-02", "tz_offset_minutes": -480}
    return {
        **supervision_event("ai.work_requested"),
        "event_id": f"ai-request:req_{kind}",
        "source": "client",
        "reason_codes": [kind],
        "ai_request": {"request_id": f"req_{kind}", "kind": kind, "payload": payload},
    }


class TriggerLiveSupervisionTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        self.get_home = Mock(return_value=self.home)
        module = types.ModuleType("hermes_constants")
        module.get_hermes_home = self.get_home
        modules_patch = patch.dict(sys.modules, {"hermes_constants": module})
        self.addCleanup(modules_patch.stop)
        modules_patch.start()
        environment_patch = patch.dict(os.environ, {"HERMES_CONTROLLER_ENABLED": "true"}, clear=True)
        self.addCleanup(environment_patch.stop)
        environment_patch.start()

    def invoke(self, event=None, *, raw=None):
        output = io.StringIO()
        stdin = io.StringIO(json.dumps(event) if raw is None else raw)
        with patch.object(sys, "stdin", stdin), redirect_stdout(output):
            result = MODULE.main()
        return result, output.getvalue()

    def stored(self, event):
        path = self.home / "state" / "live-events" / "pending" / live_event_queue.record_name(event["event_id"])
        return json.loads(path.read_text(encoding="utf-8"))

    def assert_ack(self, output, event):
        self.assertEqual(json.loads(output), {
            "__hermes_ignore__": True,
            "__hermes_ack__": {
                "schema": "live_dashboard.controller_ack.v1",
                "v": 1,
                "event_id": event["event_id"],
                "accepted": True,
            },
        })

    def test_accepts_only_the_expected_event_contracts(self):
        events = [supervision_event(), supervision_event("supervision.deviation_detected"), offline_event(), ai_event()]
        for event in events:
            with self.subTest(event_type=event["event_type"]):
                self.assertEqual(MODULE._validated_event(event), event)

    def test_invalid_payloads_never_enqueue_or_ack(self):
        event = supervision_event()
        invalid = [
            None, [], "not an event", {},
            {**event, "schema": "other"},
            {**event, "v": 2},
            {**event, "event_type": "unsupported"},
            {**event, "event_id": "../../bad"},
            {**event, "occurred_at": "not-a-time"},
            {**event, "occurred_at": "2026-09-02T12:00:00"},
            {**event, "source": "unknown"},
            {**event, "device_ids": "android-main"},
            {**event, "device_ids": ["../../bad"]},
            {**event, "reason_codes": {"bad": True}},
            {**offline_event(), "source": "report"},
            {**offline_event(), "reason_codes": ["device_requested"]},
            ai_event(payload={"date": "2026-09-02", "tz_offset_minutes": -480, "api_key": "must-not-cross"}),
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                self.assertEqual(self.invoke(payload), (1, ""))
        self.assertEqual(self.invoke(raw="not-json"), (1, ""))
        self.assertFalse((self.home / "state").exists())

    def test_every_event_is_spooled_with_its_mode_and_task_before_the_ack(self):
        cases = [
            (supervision_event(), "supervision", None),
            (offline_event(), "supervision", "<live_offline_event_json>"),
            (ai_event("daily_summary"), "daily", "claim_controller_ai_requests"),
            (ai_event("weekly_summary", {"week_start": "2026-08-31", "tz_offset_minutes": -480}), "weekly", "claim_controller_ai_requests"),
            (ai_event("supervision_rules_refresh", {"settings_updated_at": "2026-09-02T12:00:00.000Z"}), "policy", "claim_controller_ai_requests"),
            (ai_event("supervision_check", {"at": "2026-09-02T12:00:00.000Z", "source": "report", "force": True}), "supervision", "complete_controller_ai_request"),
        ]
        for event, mode, marker in cases:
            with self.subTest(event_id=event["event_id"]):
                result, output = self.invoke(event)
                self.assertEqual(result, 0)
                self.assert_ack(output, event)
                stored = self.stored(event)
                self.assertEqual((stored["event"], stored["mode"]), (event, mode))
                if marker is None:
                    self.assertIsNone(stored["task"])
                else:
                    self.assertIn(marker, stored["task"])

    def test_a_live_retry_is_acknowledged_again_without_a_second_record(self):
        event = ai_event()
        self.assertEqual(self.invoke(event)[0], 0)
        reordered = dict(reversed(list(event.items())))
        result, output = self.invoke(reordered)
        self.assertEqual(result, 0)
        self.assert_ack(output, event)
        self.assertEqual(len(list((self.home / "state" / "live-events" / "pending").glob("*.json"))), 1)

    def test_a_queue_failure_never_acknowledges(self):
        self.get_home.side_effect = OSError("home unavailable")
        self.assertEqual(self.invoke(supervision_event()), (1, ""))

    def test_a_disabled_controller_never_spools(self):
        for value in ("false", "1", ""):
            with self.subTest(value=value), patch.dict(os.environ, {"HERMES_CONTROLLER_ENABLED": value}):
                self.assertEqual(self.invoke(supervision_event()), (1, ""))
        self.assertFalse((self.home / "state").exists())


if __name__ == "__main__":
    unittest.main()
