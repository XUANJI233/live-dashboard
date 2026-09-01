import importlib.util
import json
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


SCRIPT = Path(__file__).parents[1] / "followup_candidate.py"
SPEC = importlib.util.spec_from_file_location("followup_candidate", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def selected(value: str) -> bool:
    return bool(json.loads(value).get("selected_this_run"))


def test_wakes_every_five_minutes_until_reply():
    state = {}
    root = "job:output.md"
    state, before = MODULE.evaluate_followup(
        state, root_id=root, outbound_at=1_000, inbound_at=900, now=1_299
    )
    state, first = MODULE.evaluate_followup(
        state, root_id=root, outbound_at=1_000, inbound_at=900, now=1_300
    )
    state, same_slot = MODULE.evaluate_followup(
        state, root_id=root, outbound_at=1_000, inbound_at=900, now=1_599
    )
    state, second = MODULE.evaluate_followup(
        state, root_id=root, outbound_at=1_000, inbound_at=900, now=1_600
    )
    state, third = MODULE.evaluate_followup(
        state, root_id=root, outbound_at=1_000, inbound_at=900, now=1_900
    )

    assert not selected(before)
    assert selected(first)
    assert not selected(same_slot)
    assert selected(second)
    assert selected(third)


def test_any_later_weixin_user_message_clears_followup():
    state, output = MODULE.evaluate_followup(
        {}, root_id="job:output.md", outbound_at=1_000, inbound_at=1_001, now=2_000
    )

    assert not selected(output)
    assert state["answered_at"] == 1_001


def test_new_outbound_replaces_answered_root():
    state = {"root_id": "old", "answered_at": 1_500, "last_wake_slot": 9}
    state, output = MODULE.evaluate_followup(
        state, root_id="new", outbound_at=2_000, inbound_at=1_500, now=2_300
    )

    assert selected(output)
    assert state["root_id"] == "new"
    assert "answered_at" not in state


def test_stale_root_expires_after_twelve_hours():
    _, output = MODULE.evaluate_followup(
        {},
        root_id="job:output.md",
        outbound_at=1_000,
        inbound_at=900,
        now=1_000 + MODULE.MAX_OPEN_SECONDS + 1,
    )
    assert not selected(output)


def test_silent_or_mixed_silent_output_is_not_sendable():
    assert not MODULE.is_sendable_response("[SILENT]")
    assert not MODULE.is_sendable_response("analysis\n[SILENT]")
    assert MODULE.is_sendable_response("第几题了")


def test_discovers_only_successfully_delivered_non_silent_source(tmp_path):
    cron = tmp_path / "cron"
    output = cron / "output" / "source-job"
    output.mkdir(parents=True)
    (cron / "jobs.json").write_text(
        json.dumps(
            {
                "jobs": [
                    {
                        "id": "source-job",
                        "name": "teacher-friend-companion",
                        "last_status": "ok",
                        "last_delivery_error": None,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    path = output / "run.md"
    path.write_text("# Cron\n\n## Response\n第几题了", encoding="utf-8")

    root_id, outbound_at = MODULE.latest_proactive_outbound(tmp_path)

    assert root_id == "source-job:run.md"
    assert outbound_at == path.stat().st_mtime


def test_cron_delivery_echo_is_not_treated_as_weixin_reply(tmp_path):
    database = tmp_path / "state.db"
    connection = sqlite3.connect(database)
    connection.executescript(
        """
        CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, chat_type TEXT);
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          session_id TEXT,
          role TEXT,
          content TEXT,
          timestamp REAL,
          active INTEGER
        );
        INSERT INTO sessions VALUES ('dm', 'weixin', 'dm');
        INSERT INTO messages(session_id,role,content,timestamp,active)
        VALUES ('dm','user','真实回复',900,1);
        INSERT INTO messages(session_id,role,content,timestamp,active)
        VALUES ('dm','user','[Cron delivery: live-daily-summary]\n自动消息',1100,1);
        """
    )
    connection.commit()
    connection.close()

    assert MODULE.latest_weixin_user_message(database) == 900


class FollowupCandidateUnittest(unittest.TestCase):
    def test_wake_cadence(self):
        test_wakes_every_five_minutes_until_reply()

    def test_reply_clears(self):
        test_any_later_weixin_user_message_clears_followup()

    def test_root_replacement(self):
        test_new_outbound_replaces_answered_root()

    def test_expiry(self):
        test_stale_root_expires_after_twelve_hours()

    def test_silent_filter(self):
        test_silent_or_mixed_silent_output_is_not_sendable()

    def test_output_discovery(self):
        with TemporaryDirectory() as directory:
            test_discovers_only_successfully_delivered_non_silent_source(Path(directory))

    def test_cron_delivery_echo_filter(self):
        with TemporaryDirectory() as directory:
            test_cron_delivery_echo_is_not_treated_as_weixin_reply(Path(directory))
