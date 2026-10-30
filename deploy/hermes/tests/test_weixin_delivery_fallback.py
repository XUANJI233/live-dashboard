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
SETTLED = MODULE.SETTLE_SECONDS + 60


def job(job_id, name, attach=True):
    return {"id": job_id, "name": name, "deliver": WEIXIN, "attach_to_session": attach}


def home_with(tmp_path, jobs, responses, mirrored=(), age=SETTLED):
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
    for content, offset in mirrored:
        connection.execute("INSERT INTO messages(role, content, timestamp) VALUES ('user', ?, ?)", (content, written + offset))
    connection.commit()
    connection.close()
    return tmp_path


def run(home, tool):
    with mock.patch.dict(os.environ, {"HERMES_CONTROLLER_ENABLED": "true", "HERMES_HOME": str(home)}, clear=True), \
            mock.patch.object(MODULE, "call_tool", tool):
        assert MODULE.main() == 0


def recording_tool(calls, fail_on=None):
    def tool(name, arguments):
        calls.append((name, arguments))
        if name == "live_dashboard.list_devices":
            return {"devices": [PHONE]}
        if fail_on and fail_on in json.dumps(arguments, ensure_ascii=False):
            raise MODULE.LiveMcpError("invalid_params")
        return {"ok": True}
    return tool


def says(calls):
    return [arguments["commands"][0]["say"] for name, arguments in calls if name == "live_dashboard.send_device_commands"]


def test_an_unmirrored_message_from_an_opted_in_job_reaches_the_phone_once(tmp_path):
    home = home_with(tmp_path, [
        job("consumer", "live-supervision-review"),
        job("companion", "teacher-friend-companion"),
        job("silent", "strict-proactive-followup"),
        job("reminder", "22:00 睡觉提醒", attach=False),
    ], {
        "consumer": "月圆之夜我封了\n⟦MSG⟧\n九点前先交十个新的",
        "companion": "在干嘛",
        "silent": "[SILENT] 他在专注，不打扰",
        "reminder": "该睡了",
    }, mirrored=[
        ("[Cron delivery: teacher-friend-companion]\n在干嘛", 5),
        # A mirror older than the run cannot be this run's.
        ("[Cron delivery: live-supervision-review]\n月圆之夜我封了", -120),
    ])
    calls = []

    run(home, recording_tool(calls))
    run(home, recording_tool(calls))

    # The reminder job never mirrors, so a missing mirror proves nothing for it.
    assert says(calls) == ["月圆之夜我封了\n九点前先交十个新的"]
    sends = [arguments for name, arguments in calls if name == "live_dashboard.send_device_commands"]
    assert sends[0]["commands"][0]["device_id"] == "android-main" and sends[0]["created_by"] == "supervision"


def test_unsettled_old_and_unreachable_cases_are_left_alone(tmp_path):
    jobs = [job("consumer", "live-supervision-review")]
    calls = []
    run(home_with(tmp_path / "fresh", jobs, {"consumer": "词呢"}, age=60), recording_tool(calls))
    run(home_with(tmp_path / "old", jobs, {"consumer": "词呢"}, age=3600), recording_tool(calls))
    assert calls == []

    home = home_with(tmp_path / "down", jobs, {"consumer": "词呢"})

    def unreachable(name, arguments):
        raise MODULE.LiveMcpError("unreachable:OSError")

    run(home, unreachable)
    # Nothing was recorded as handled, so the next tick retries.
    assert MODULE.load_handled(home / "state" / MODULE.STATE_NAME) == []


def test_a_rejected_item_does_not_block_newer_ones(tmp_path):
    jobs = [job("first", "teacher-friend-companion"), job("second", "live-supervision-review")]
    home = home_with(tmp_path, jobs, {"first": "坏的那条", "second": "好的那条"})
    calls = []
    run(home, recording_tool(calls, fail_on="坏的那条"))
    assert "好的那条" in says(calls)
    assert len(MODULE.load_handled(home / "state" / MODULE.STATE_NAME)) == 2


def test_phone_text_fits_lives_utf16_limit():
    text = MODULE.phone_text("😀" * 300)
    assert sum(2 if ord(char) > 0xFFFF else 1 for char in text) <= MODULE.MAX_SAY_UNITS
    assert MODULE.phone_text("一\n⟦MSG⟧\n二") == "一\n二"
