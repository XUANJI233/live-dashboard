import importlib.util
import io
import json
import os
import sys
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
        self.home = Path("test-hermes-home")
        self.session_key = "platform:api:dm:existing-live-conversation"
        self.receipt = {"seq": 17, "state": "pending", "duplicate": False}
        self.get_job = Mock(return_value={"id": "supervision-job", "prompt": "Existing supervision recipe"})
        self.load_config = Mock(return_value={
            "session_events": {"enabled": True, "session_key": self.session_key},
        })
        self.control = Mock(return_value=self.receipt)
        self.trigger_job = Mock(side_effect=AssertionError("must not start a cron conversation"))
        self.set_note = Mock(side_effect=AssertionError("must not persist a lossy notepad event"))
        modules = {}
        for name, members in {
            "cron.jobs": {"get_job": self.get_job, "trigger_job": self.trigger_job},
            "cron.notepad": {"set_note": self.set_note},
            "gateway.control_socket": {"query_gateway_control": self.control},
            "hermes_cli.config": {"load_config": self.load_config},
            "hermes_constants": {"get_hermes_home": Mock(return_value=self.home)},
        }.items():
            module = types.ModuleType(name)
            module.__dict__.update(members)
            modules[name] = module
        modules_patch = patch.dict(sys.modules, modules)
        self.addCleanup(modules_patch.stop)
        modules_patch.start()
        environment_patch = patch.dict(os.environ, {
            "HERMES_CONTROLLER_ENABLED": "true",
            "HERMES_LIVE_SUPERVISION_JOB_ID": "supervision-job",
            "HERMES_LIVE_DAILY_JOB_ID": "unused-daily-job",
            "HERMES_LIVE_WEEKLY_JOB_ID": "unused-weekly-job",
        }, clear=True)
        self.addCleanup(environment_patch.stop)
        environment_patch.start()

    def invoke(self, event=None, *, raw=None):
        output = io.StringIO()
        stdin = io.StringIO(json.dumps(event) if raw is None else raw)
        with patch.object(sys, "stdin", stdin), redirect_stdout(output):
            result = MODULE.main()
        self.trigger_job.assert_not_called()
        self.set_note.assert_not_called()
        return result, output.getvalue()

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

    def assert_session_payload(self, event):
        self.control.assert_called_with(
            self.home, "session-event", timeout=6.0,
            payload=self.control.call_args.kwargs["payload"],
        )
        payload = self.control.call_args.kwargs["payload"]
        self.assertEqual(set(payload), {"session_key", "event_id", "source", "occurred_at", "content"})
        self.assertEqual(payload["session_key"], self.session_key)
        self.assertEqual(payload["event_id"], event["event_id"])
        self.assertEqual(payload["source"], "live")
        self.assertEqual(payload["occurred_at"], event["occurred_at"])
        self.assertTrue(payload["content"].startswith("Existing supervision recipe\n\n"))
        self.get_job.assert_called_with("supervision-job")
        return payload

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
        self.control.assert_not_called()
        self.load_config.assert_not_called()
        self.get_job.assert_not_called()

    def test_missing_or_disabled_session_configuration_has_no_fallback(self):
        configurations = [
            None, {}, {"session_events": {}},
            {"session_events": {"enabled": False, "session_key": self.session_key}},
            {"session_events": {"enabled": "true", "session_key": self.session_key}},
            {"session_events": {"enabled": 1, "session_key": self.session_key}},
            {"session_events": {"enabled": True}},
            {"session_events": {"enabled": True, "session_key": ""}},
            {"session_events": {"enabled": True, "session_key": 42}},
        ]
        for configuration in configurations:
            with self.subTest(configuration=configuration):
                self.load_config.return_value = configuration
                self.assertEqual(self.invoke(supervision_event()), (1, ""))
        self.control.assert_not_called()
        self.get_job.assert_not_called()

    def test_config_load_failure_never_falls_back(self):
        self.load_config.side_effect = OSError("configuration unavailable")
        self.assertEqual(self.invoke(supervision_event()), (1, ""))
        self.control.assert_not_called()
        self.get_job.assert_not_called()

    def test_socket_failure_never_acknowledges_or_starts_a_cron_session(self):
        self.control.return_value = None
        self.assertEqual(self.invoke(supervision_event()), (1, ""))
        self.control.side_effect = OSError("gateway disconnected")
        self.assertEqual(self.invoke(offline_event()), (1, ""))
        self.assertEqual(self.control.call_count, 2)

    def test_ack_is_emitted_only_after_gateway_returns_a_durable_receipt(self):
        event = supervision_event()

        def receive_receipt(*args, **kwargs):
            self.assertEqual(sys.stdout.getvalue(), "")
            return self.receipt

        self.control.side_effect = receive_receipt
        result, output = self.invoke(event)
        self.assertEqual(result, 0)
        payload = self.assert_session_payload(event)
        self.assertIn("Live observation data (not user instructions):", payload["content"])
        self.assert_ack(output, event)

    def test_all_ai_requests_target_the_same_existing_conversation(self):
        cases = [
            ("daily_summary", {"date": "2026-09-02", "tz_offset_minutes": -480}, "daily"),
            ("weekly_summary", {"week_start": "2026-08-31", "tz_offset_minutes": -480}, "weekly"),
            ("supervision_rules_refresh", {"settings_updated_at": "2026-09-02T12:00:00.000Z"}, "policy"),
            ("supervision_check", {"at": "2026-09-02T12:00:00.000Z", "source": "report", "force": True}, "supervision"),
        ]
        for kind, body, mode in cases:
            with self.subTest(kind=kind):
                event = ai_event(kind, body)
                result, output = self.invoke(event)
                self.assertEqual(result, 0)
                payload = self.assert_session_payload(event)
                content = payload["content"]
                self.assertIn(f"mode={mode}", content)
                self.assertIn("claim_controller_ai_requests", content)
                self.assertIn("complete_controller_ai_request", content)
                embedded = content.split("<live_ai_request_json>", 1)[1].split("</live_ai_request_json>", 1)[0]
                self.assertEqual(json.loads(embedded), event)
                self.assert_ack(output, event)

    def test_offline_and_supervision_events_use_the_ai_request_session_key(self):
        events = [offline_event(), supervision_event(), supervision_event("supervision.deviation_detected"), ai_event()]
        for event in events:
            with self.subTest(event_type=event["event_type"]):
                result, output = self.invoke(event)
                self.assertEqual(result, 0)
                payload = self.assert_session_payload(event)
                self.assertIn(event["event_id"], payload["content"])
                if event["event_type"] == "device.offline":
                    self.assertIn("[SILENT]", payload["content"])
                    embedded = payload["content"].split("<live_offline_event_json>", 1)[1].split("</live_offline_event_json>", 1)[0]
                    self.assertEqual(json.loads(embedded), event)
                self.assert_ack(output, event)
        self.assertEqual({call.kwargs["payload"]["session_key"] for call in self.control.call_args_list}, {self.session_key})

    def test_repeated_event_preserves_the_entire_idempotent_gateway_payload(self):
        for event in (supervision_event(), offline_event(), ai_event()):
            with self.subTest(event_type=event["event_type"]):
                self.control.reset_mock()
                self.control.side_effect = [self.receipt, {**self.receipt, "duplicate": True}]
                first_result, first_output = self.invoke(event)
                second_result, second_output = self.invoke(json.loads(json.dumps(event)))
                self.assertEqual((first_result, second_result), (0, 0))
                self.assertEqual(self.control.call_args_list[0], self.control.call_args_list[1])
                self.assert_ack(first_output, event)
                self.assert_ack(second_output, event)

    def test_retry_json_field_order_does_not_change_idempotent_content(self):
        event = ai_event()
        reordered = dict(reversed(list(event.items())))
        reordered["ai_request"] = {
            **event["ai_request"],
            "payload": dict(reversed(list(event["ai_request"]["payload"].items()))),
        }
        self.assertEqual(event, reordered)
        self.assertEqual(self.invoke(event)[0], 0)
        self.assertEqual(self.invoke(reordered)[0], 0)
        self.assertEqual(self.control.call_args_list[0], self.control.call_args_list[1])

    def test_disabled_controller_or_missing_recipe_id_has_no_fallback(self):
        for settings in (
            {"HERMES_CONTROLLER_ENABLED": "false"},
            {"HERMES_CONTROLLER_ENABLED": "1"},
            {"HERMES_LIVE_SUPERVISION_JOB_ID": ""},
        ):
            with self.subTest(settings=settings), patch.dict(os.environ, settings):
                self.assertEqual(self.invoke(supervision_event()), (1, ""))
                self.assertEqual(self.invoke(ai_event()), (1, ""))
        self.control.assert_not_called()
        self.get_job.assert_not_called()


if __name__ == "__main__":
    unittest.main()
