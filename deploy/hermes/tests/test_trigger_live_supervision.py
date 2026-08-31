import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


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
            "event_type": "supervision.review_requested",
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
            "event_type": "supervision.review_requested",
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

    def test_persists_the_event_and_requests_the_existing_job_without_a_nested_cli(self):
        event = {
            "schema": "live_dashboard.controller_event.v1",
            "v": 1,
            "event_id": "supervision:494677:0123456789abcdefabcd",
            "event_type": "supervision.review_requested",
            "occurred_at": "2026-08-31T12:00:00.000Z",
            "source": "report",
            "device_ids": ["android-main"],
            "reason_codes": ["deviation_confirmed"],
        }
        notes = []
        jobs = types.ModuleType("cron.jobs")
        notepad = types.ModuleType("cron.notepad")
        jobs.trigger_job = lambda job_id: {"id": job_id}
        notepad.set_note = lambda job_id, key, value: notes.append((job_id, key, value))
        original_reader = MODULE._event_from_stdin
        MODULE._event_from_stdin = lambda: event
        try:
            with patch.dict(sys.modules, {"cron.jobs": jobs, "cron.notepad": notepad}), patch.dict(
                os.environ,
                {"HERMES_LIVE_SUPERVISION_JOB_ID": "job-1", "HERMES_CONTROLLER_ENABLED": "true"},
                clear=False,
            ):
                self.assertEqual(MODULE.main(), 0)
        finally:
            MODULE._event_from_stdin = original_reader

        self.assertEqual(notes[0][0:2], ("job-1", "last_live_event"))
        self.assertEqual(__import__("json").loads(notes[0][2]), event)

    def test_does_not_reenable_the_job_when_controller_mode_is_off(self):
        original_reader = MODULE._event_from_stdin
        MODULE._event_from_stdin = lambda: {
            "schema": "live_dashboard.controller_event.v1",
            "v": 1,
            "event_id": "supervision:494677:0123456789abcdefabcd",
            "event_type": "supervision.review_requested",
            "occurred_at": "2026-08-31T12:00:00.000Z",
            "source": "report",
            "device_ids": ["android-main"],
            "reason_codes": ["device_requested"],
        }
        try:
            with patch.dict(
                os.environ,
                {"HERMES_LIVE_SUPERVISION_JOB_ID": "job-1", "HERMES_CONTROLLER_ENABLED": "false"},
                clear=False,
            ):
                self.assertEqual(MODULE.main(), 0)
        finally:
            MODULE._event_from_stdin = original_reader


if __name__ == "__main__":
    unittest.main()
