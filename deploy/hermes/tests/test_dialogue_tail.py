import importlib.util
import json
import sqlite3
import sys
from pathlib import Path


SCRIPTS = Path(__file__).parents[1]
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("dialogue_tail", SCRIPTS / "dialogue_tail.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

KEY = "agent:main:weixin:dm:user"
# 2026-10-30 09:00:00 UTC+08:00
BASE = 1793322000.0


def build_home(tmp_path, rows, *, sessions=(("dm", None, None),), routed="dm"):
    (tmp_path / "sessions").mkdir()
    (tmp_path / "sessions" / "sessions.json").write_text(json.dumps({KEY: {"session_id": routed}}), encoding="utf-8")
    connection = sqlite3.connect(tmp_path / "state.db")
    connection.executescript(
        """
        CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT, model_config TEXT, end_reason TEXT);
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT,
          timestamp REAL, active INTEGER, display_kind TEXT, _compressed_summary INTEGER
        );
        """
    )
    for session_id, parent, end_reason in sessions:
        connection.execute("INSERT INTO sessions VALUES (?, 'weixin', ?, '{}', ?)", (session_id, parent, end_reason))
    for index, (session_id, role, content, *extra) in enumerate(rows):
        tool_calls = extra[0] if extra else None
        connection.execute(
            "INSERT INTO messages(session_id, role, content, tool_calls, timestamp, active, display_kind, _compressed_summary) "
            "VALUES (?, ?, ?, ?, ?, 1, NULL, 0)",
            (session_id, role, content, tool_calls, BASE + index * 60),
        )
    connection.commit()
    connection.close()
    return tmp_path


def test_keeps_human_visible_turns_oldest_first(tmp_path):
    home = build_home(tmp_path, [
        ("dm", "user", "淘宝开一下"),
        ("dm", "assistant", "", '[{"id":"call"}]'),
        ("dm", "assistant", "买什么⟦MSG⟧几分钟"),
        ("dm", "assistant", "[SILENT]"),
        ("dm", "user", "[Cron delivery: teacher-friend-companion]\n词呢"),
        ("dm", "user", "[CONTEXT COMPACTION — REFERENCE ONLY] summary"),
    ])

    tail = MODULE.recent_dialogue(home, KEY)

    assert [(line["who"], line["text"]) for line in tail] == [
        ("他", "淘宝开一下"),
        ("她", "买什么 / 几分钟"),
        ("她·主动", "词呢"),
    ]
    assert tail[0]["at"] == "10-30 09:00"


def test_reads_his_words_after_forced_skills_and_drops_machine_wakes(tmp_path):
    home = build_home(tmp_path, [
        ("dm", "user", '[IMPORTANT: The "strict-study-girlfriend" skill is auto-loaded.]\n\nskill body\n\n晚安'),
        ("dm", "user", '[IMPORTANT: The "live-mentor" skill is auto-loaded.]\n\nbody\n\n{"event_id":"cron:x"}]'),
        ("dm", "user", "[The user sent an image~ 单词统计截图]"),
    ])

    assert [line["text"] for line in MODULE.recent_dialogue(home, KEY)] == ["晚安", "[The user sent an image~ 单词统计截图]"]


def test_follows_compaction_lineage_and_bounds_the_tail(tmp_path):
    rows = [("old", "user", f"旧{index}") for index in range(3)] + [("dm", "user", "x" * 300)]
    home = build_home(
        tmp_path, rows,
        sessions=(("old", None, "compression"), ("dm", "old", None)),
    )

    tail = MODULE.recent_dialogue(home, KEY, limit=2)

    assert [line["text"] for line in tail] == ["旧2", "x" * MODULE.MAX_TEXT_CHARS + "…"]


def test_missing_route_or_database_is_an_empty_tail(tmp_path):
    assert MODULE.recent_dialogue(tmp_path, KEY) == []
    assert MODULE.recent_dialogue(build_home(tmp_path, [("dm", "user", "在吗")]), "") == []


def test_keeps_weixin_emoji_and_the_words_under_a_quote(tmp_path):
    home = build_home(tmp_path, [
        ("dm", "user", "[捂脸]好吧我去背"),
        ("dm", "user", '[Replying to: "背完了吗"]\n\n背完了'),
        ("dm", "user", "[SYSTEM note] gateway restarted"),
    ])

    assert [line["text"] for line in MODULE.recent_dialogue(home, KEY)] == ["[捂脸]好吧我去背", "背完了"]


def test_silence_variants_are_never_sendable():
    sys.path.insert(0, str(SCRIPTS))
    from cron_outputs import is_sendable_response

    for text in ("[SILENT]", "[SILENT] 他在专注，不打扰", "SILENT", "[静默]", "(No response generated)", "  ", "看了一眼\n[SILENT]"):
        assert not is_sendable_response(text), text
    assert is_sendable_response("词呢\n⟦MSG⟧\n截图发我")
