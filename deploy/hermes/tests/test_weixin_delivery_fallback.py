import importlib.util
import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).parents[1]
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("weixin_delivery_fallback", SCRIPTS / "weixin_delivery_fallback.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

PHONE = {"device_id": "android-main", "platform": "android", "is_online": True,
         "capability": {"capabilities": {"say": True}}}
WEIXIN = "weixin:user@im.wechat"


def home_with(tmp_path, jobs, responses, mirrored=(), age=300):
    (tmp_path / "cron").mkdir(parents=True)
    (tmp_path / "cron" / "jobs.json").write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
    written = time.time() - age
    for job_id, response in responses.items():
        directory = tmp_path / "cron" / "output" / job_id
        directory.mkdir(parents=True)
        output = directory / "run.md"
        output.write_text(f"# Cron\n\n## Response\n\n{response}", encoding="utf-8")
        os.utime(output, (written, written))
    connection = sqlite3.connect(tmp_path / "state.db")
    connection.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT, content TEXT, timestamp REAL)")
    for content in mirrored:
        connection.execute("INSERT INTO messages(role, content, timestamp) VALUES ('user', ?, ?)", (content, written + 5))
    connection.commit()
    connection.close()
    return tmp_path


def run(home, tool):
    with mock.patch.dict(os.environ, {"HERMES_CONTROLLER_ENABLED": "true", "HERMES_HOME": str(home)}, clear=True), \
            mock.patch.object(MODULE, "call_tool", tool):
        assert MODULE.main() == 0


def recording_tool(calls):
    def tool(name, arguments):
        calls.append((name, arguments))
        return {"devices": [PHONE]} if name == "live_dashboard.list_devices" else {"ok": True}
    return tool


def test_an_unmirrored_proactive_message_reaches_the_phone_once(tmp_path):
    home = home_with(tmp_path, [
        {"id": "consumer", "name": "live-supervision-review", "deliver": WEIXIN},
        {"id": "companion", "name": "teacher-friend-companion", "deliver": WEIXIN},
        {"id": "silent", "name": "followup", "deliver": WEIXIN},
        {"id": "maintenance", "name": "08:30", "deliver": "local"},
    ], {
        "consumer": "月圆之夜我封了\n⟦MSG⟧\n九点前先交十个新的",
        "companion": "在干嘛",
        "silent": "[SILENT]",
        "maintenance": "解冻完成",
    }, mirrored=["[Cron delivery: teacher-friend-companion]\n在干嘛"])
    calls = []

    run(home, recording_tool(calls))
    run(home, recording_tool(calls))

    sends = [arguments for name, arguments in calls if name == "live_dashboard.send_device_commands"]
    assert len(sends) == 1
    assert sends[0]["commands"] == [{"device_id": "android-main", "say": "月圆之夜我封了\n九点前先交十个新的"}]
    assert sends[0]["created_by"] == "supervision"


def test_unsettled_or_old_runs_and_an_unreachable_live_are_left_alone(tmp_path):
    jobs = [{"id": "consumer", "name": "live-supervision-review", "deliver": WEIXIN}]
    calls = []
    run(home_with(tmp_path / "fresh", jobs, {"consumer": "词呢"}, age=10), recording_tool(calls))
    run(home_with(tmp_path / "old", jobs, {"consumer": "词呢"}, age=3600), recording_tool(calls))
    assert calls == []

    home = home_with(tmp_path / "down", jobs, {"consumer": "词呢"})

    def unreachable(name, arguments):
        raise MODULE.LiveMcpError("unreachable:OSError")

    run(home, unreachable)
    # Nothing was recorded as handled, so the next tick retries.
    assert MODULE.load_handled(home / "state" / MODULE.STATE_NAME) == []
