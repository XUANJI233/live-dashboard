import importlib.util
import io
import json
import os
import sqlite3
import sys
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


SCRIPTS = Path(__file__).parents[1]
sys.path.insert(0, str(SCRIPTS))
import candidate_script_gate as GATE


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FOLLOWUP = load_script("followup_candidate")
PROACTIVE = load_script("proactive_candidate")
KEY = "weixin:dm:target"
TZ = timezone(timedelta(hours=8))


def create_profile(root):
    (root / "sessions").mkdir()
    (root / "sessions" / "sessions.json").write_text(
        json.dumps({KEY: {"session_id": "tip"}}), encoding="utf-8",
    )
    (root / "cron").mkdir()
    (root / "cron" / "jobs.json").write_text(json.dumps({"jobs": [
        {"name": "strict-proactive-followup", "id": "follow-job"},
        {"name": "teacher-friend-companion", "id": "companion-job"},
    ]}), encoding="utf-8")
    connection = sqlite3.connect(root / "state.db")
    connection.executescript("""
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT,
            end_reason TEXT, model_config TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
            timestamp REAL, active INTEGER, display_kind TEXT,
            _compressed_summary INTEGER DEFAULT 0
        );
        CREATE TABLE delivery_obligations (
            obligation_id TEXT PRIMARY KEY, session_key TEXT, state TEXT,
            updated_at REAL, trigger_event_ids TEXT, content TEXT, platform_message_id TEXT
        );
        CREATE TABLE session_wake_events (
            session_key TEXT, source TEXT, event_id TEXT, state TEXT
        );
        INSERT INTO sessions VALUES ('parent', 'weixin', NULL, 'compression', '{}');
        INSERT INTO sessions VALUES ('tip', 'weixin', 'parent', NULL, '{}');
        INSERT INTO sessions VALUES ('other', 'weixin', NULL, NULL, '{}');
        INSERT INTO sessions VALUES ('branch', 'weixin', 'parent', NULL, '{"_branched_from":"parent"}');
        INSERT INTO messages VALUES (1, 'parent', 'user', 'real reply', 900, 1, NULL, 0);
        INSERT INTO messages VALUES (2, 'tip', 'user', 'internal event', 8000, 1, 'internal_notification', 0);
        INSERT INTO messages VALUES (3, 'tip', 'user', 'hidden event', 7900, 1, 'hidden', 0);
        INSERT INTO messages VALUES (4, 'tip', 'user', 'session metadata', 7800, 1, 'session_meta', 0);
        INSERT INTO messages VALUES (5, 'tip', 'user', 'compression summary', 7700, 1, NULL, 1);
        INSERT INTO messages VALUES (6, 'other', 'user', 'other person', 9000, 1, NULL, 0);
        INSERT INTO messages VALUES (7, 'branch', 'user', 'other branch', 9100, 1, NULL, 0);
        INSERT INTO messages VALUES (8, 'tip', 'assistant', 'not a delivery receipt', 9200, 1, NULL, 0);
        INSERT INTO messages VALUES (9, 'tip', 'user', 'inactive', 9300, 0, NULL, 0);
    """)
    connection.commit()
    return connection


def add_delivery(connection, obligation_id="root", *, key=KEY, state="delivered", at=1000,
                 triggers=None, content="A concrete checkpoint", message_id=None):
    if triggers is None:
        triggers = ["cron:companion-job:candidate:opportunity"]
    connection.execute(
        "INSERT INTO delivery_obligations VALUES (?, ?, ?, ?, ?, ?, ?)",
        (obligation_id, key, state, at, json.dumps(triggers), content, message_id),
    )
    connection.commit()


class CandidateGateTest(unittest.TestCase):
    def test_gate_requires_real_boolean_selection(self):
        for value in (False, None, 0, 1, "true"):
            result = json.loads(GATE.script_gate(json.dumps({"selected_this_run": value})))
            self.assertIs(result["wakeAgent"], False)
        result = json.loads(GATE.script_gate('{"selected_this_run":true,"candidate_id":"stable"}'))
        self.assertIs(result["wakeAgent"], True)
        self.assertEqual(result["candidate_id"], "stable")

    def test_ack_requires_exact_session_source_and_candidate_identity(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            connection = create_profile(root)
            event_id = GATE.candidate_event_id("follow-job", "candidate")
            connection.executemany("INSERT INTO session_wake_events VALUES (?, ?, ?, ?)", [
                ("other", "cron", event_id, "completed"),
                (KEY, "live", event_id, "completed"),
                (KEY, "cron", event_id + "-other", "pending"),
            ])
            connection.commit()
            self.assertFalse(GATE.candidate_accepted(root, KEY, "follow-job", "candidate"))
            connection.execute("INSERT INTO session_wake_events VALUES (?, ?, ?, ?)",
                               (KEY, "cron", event_id, "unknown"))
            connection.commit()
            self.assertTrue(GATE.candidate_accepted(root, KEY, "follow-job", "candidate"))
            connection.close()

    def test_companion_retries_same_candidate_until_durable_ack(self):
        now = datetime(2026, 9, 7, 9, 0, tzinfo=TZ)
        state, first = PROACTIVE.evaluate_script_candidate({}, now, 0.0, "active", lambda _: False)
        state, retry = PROACTIVE.evaluate_script_candidate(state, now + timedelta(minutes=35), 1.0, "active", lambda _: False)
        self.assertEqual(json.loads(first), json.loads(retry))
        self.assertEqual(state["day_count"], 1)
        state, accepted = PROACTIVE.evaluate_script_candidate(state, now + timedelta(minutes=36), 1.0, "active", lambda _: True)
        self.assertEqual(accepted, PROACTIVE.NO_CANDIDATE)
        self.assertNotIn("pending_candidate", state)

    def test_companion_pending_retry_never_bypasses_sleep(self):
        now = datetime(2026, 9, 7, 9, 0, tzinfo=TZ)
        state, _ = PROACTIVE.evaluate_script_candidate({}, now, 0.0, "active", lambda _: False)
        state, sleeping = PROACTIVE.evaluate_script_candidate(state, now, 0.0, "asleep", lambda _: False)
        self.assertEqual(sleeping, PROACTIVE.NO_CANDIDATE)
        self.assertIn("pending_candidate", state)

    def test_followup_only_advances_cadence_after_durable_ack(self):
        kwargs = dict(root_id="delivery:root", outbound_at=1000, inbound_at=900, rest_state="active")
        state, first = FOLLOWUP.evaluate_script_followup({}, now=1300, accepted=lambda _: False, **kwargs)
        self.assertEqual(state["last_wake_slot"], 0)
        self.assertEqual(state["pending_wake_slot"], 1)
        state, retry = FOLLOWUP.evaluate_script_followup(state, now=1600, accepted=lambda _: False, **kwargs)
        self.assertEqual(json.loads(first), json.loads(retry))
        state, accepted = FOLLOWUP.evaluate_script_followup(state, now=1600, accepted=lambda _: True, **kwargs)
        self.assertEqual(accepted, FOLLOWUP.NO_CANDIDATE)
        self.assertEqual(state["last_wake_slot"], 1)
        state, second = FOLLOWUP.evaluate_script_followup(state, now=1900, accepted=lambda _: False, **kwargs)
        self.assertNotEqual(json.loads(first)["candidate_id"], json.loads(second)["candidate_id"])
        self.assertEqual(state["last_wake_slot"], 1)

    def test_reply_closes_unacknowledged_followup(self):
        kwargs = dict(root_id="delivery:root", outbound_at=1000, rest_state="active", accepted=lambda _: False)
        state, _ = FOLLOWUP.evaluate_script_followup({}, now=1300, inbound_at=900, **kwargs)
        state, output = FOLLOWUP.evaluate_script_followup(state, now=1400, inbound_at=1350, **kwargs)
        self.assertEqual(output, FOLLOWUP.NO_CANDIDATE)
        self.assertEqual(state["answered_at"], 1350)
        self.assertNotIn("pending_candidate", state)

    def test_pending_followup_obeys_sleep_and_slower_screen_off(self):
        kwargs = dict(root_id="delivery:root", outbound_at=1000, inbound_at=900, accepted=lambda _: False)
        state, first = FOLLOWUP.evaluate_script_followup({}, now=1300, rest_state="active", **kwargs)
        for rest_state in ("asleep", "screen_off", "unknown"):
            _, output = FOLLOWUP.evaluate_script_followup(state, now=1400, rest_state=rest_state, **kwargs)
            self.assertEqual(output, FOLLOWUP.NO_CANDIDATE)
        _, output = FOLLOWUP.evaluate_script_followup(state, now=1900, rest_state="screen_off", **kwargs)
        self.assertEqual(json.loads(output), json.loads(first))


class NativeFollowupContextTest(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.connection = create_profile(self.root)

    def tearDown(self):
        self.connection.close()
        self.temporary.cleanup()

    def test_only_confirmed_target_delivery_creates_root(self):
        add_delivery(self.connection)
        add_delivery(self.connection, "failed", state="failed", at=2000)
        add_delivery(self.connection, "unknown", state="unknown", at=3000)
        add_delivery(self.connection, "other", key="other", at=4000)
        add_delivery(self.connection, "normal-reply", triggers=[], at=5000)
        add_delivery(self.connection, "followup", triggers=["cron:follow-job:candidate:delivery:root:1"], at=6000)
        result = FOLLOWUP.native_followup_context(self.root, KEY, "follow-job")
        self.assertEqual(result, ("delivery:root", 1000, 900))

    def test_no_receipt_means_no_root_even_with_assistant_transcript(self):
        self.assertEqual(FOLLOWUP.native_followup_context(self.root, KEY, "follow-job"), (None, None, 900))

    def test_mixed_batch_retains_new_non_followup_trigger(self):
        add_delivery(self.connection, triggers=["cron:follow-job:candidate:old", "live-new-event"])
        self.assertEqual(FOLLOWUP.native_followup_context(self.root, KEY, "follow-job")[0], "delivery:root")

    def test_followup_exclusion_uses_exact_dynamic_job_id(self):
        add_delivery(self.connection, triggers=["cron:follow-job-other:candidate:new"])
        self.assertEqual(FOLLOWUP.native_followup_context(self.root, KEY, "follow-job")[0], "delivery:root")

    def test_silent_or_invalid_trigger_receipt_is_not_a_root(self):
        add_delivery(self.connection, "silent", content="[SILENT]")
        add_delivery(self.connection, "invalid", triggers=[42], at=2000)
        self.assertIsNone(FOLLOWUP.native_followup_context(self.root, KEY, "follow-job")[0])

    def test_native_reply_does_not_cross_an_explicit_branch(self):
        self.connection.execute("UPDATE sessions SET model_config = ? WHERE id = 'tip'",
                                ('{"_branched_from":"parent"}',))
        self.connection.commit()
        self.assertIsNone(FOLLOWUP.native_followup_context(self.root, KEY, "follow-job")[2])

    def test_native_reply_does_not_cross_an_explicit_delegate(self):
        self.connection.execute("UPDATE sessions SET model_config = ? WHERE id = 'tip'",
                                ('{"_delegate_from":"parent"}',))
        self.connection.commit()
        self.assertIsNone(FOLLOWUP.native_followup_context(self.root, KEY, "follow-job")[2])

    def test_later_real_user_reply_closes_native_root(self):
        add_delivery(self.connection)
        self.connection.execute("INSERT INTO messages VALUES (10, 'tip', 'user', 'actual reply', 1100, 1, NULL, 0)")
        self.connection.commit()
        root_id, outbound_at, inbound_at = FOLLOWUP.native_followup_context(self.root, KEY, "follow-job")
        _, output = FOLLOWUP.evaluate_script_followup({}, root_id=root_id, outbound_at=outbound_at,
            inbound_at=inbound_at, now=1400, rest_state="active", accepted=lambda _: False)
        self.assertEqual(output, FOLLOWUP.NO_CANDIDATE)

    def test_missing_native_route_does_not_fall_back_to_other_weixin(self):
        with self.assertRaises(ValueError):
            FOLLOWUP.native_followup_context(self.root, "missing", "follow-job")

    def test_followup_main_emits_false_gate_without_confirmed_delivery(self):
        output = io.StringIO()
        with patch.dict(os.environ, {"HERMES_HOME": str(self.root), "HERMES_CONTROLLER_ENABLED": "true"}), \
                patch.object(FOLLOWUP, "session_event_target", return_value=(True, KEY)), \
                patch.object(FOLLOWUP, "read_live_rest_state", return_value="active"), redirect_stdout(output):
            self.assertEqual(FOLLOWUP.main(), 0)
        value = json.loads(output.getvalue())
        self.assertIs(value["wakeAgent"], False)
        self.assertIs(value["selected_this_run"], False)

    def test_native_read_failure_stays_gated_without_legacy_fallback(self):
        self.connection.execute("DROP TABLE delivery_obligations")
        self.connection.commit()
        output = io.StringIO()
        with patch.dict(os.environ, {"HERMES_HOME": str(self.root), "HERMES_CONTROLLER_ENABLED": "true"}), \
                patch.object(FOLLOWUP, "session_event_target", return_value=(True, KEY)), \
                patch.object(FOLLOWUP, "latest_proactive_outbound", side_effect=AssertionError("legacy read")), \
                redirect_stdout(output):
            self.assertEqual(FOLLOWUP.main(), 0)
        value = json.loads(output.getvalue())
        self.assertIs(value["wakeAgent"], False)
        self.assertIn("gate_error", value)


if __name__ == "__main__":
    unittest.main()
