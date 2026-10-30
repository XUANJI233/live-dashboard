import importlib.util
import json
import os
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


def home_with(tmp_path, jobs, responses):
    (tmp_path / "cron").mkdir()
    (tmp_path / "cron" / "jobs.json").write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
    for job_id, response in responses.items():
        directory = tmp_path / "cron" / "output" / job_id
        directory.mkdir(parents=True)
        (directory / "run.md").write_text(f"# Cron\n\n## Response\n\n{response}", encoding="utf-8")
    return tmp_path


def run(home, tool):
    with mock.patch.dict(os.environ, {"HERMES_CONTROLLER_ENABLED": "true", "HERMES_HOME": str(home)}, clear=True), \
            mock.patch.object(MODULE, "call_tool", tool):
        assert MODULE.main() == 0


def test_a_rejected_proactive_message_reaches_the_phone_once(tmp_path):
    home = home_with(tmp_path, [
        {"id": "consumer", "last_delivery_error": "iLink sendmessage business_rejected"},
        {"id": "companion", "last_delivery_error": None},
        {"id": "silent", "last_delivery_error": "rejected"},
    ], {"consumer": "月圆之夜我封了\n⟦MSG⟧\n九点前先交十个新的", "companion": "在干嘛", "silent": "[SILENT]"})
    calls = []

    def tool(name, arguments):
        calls.append((name, arguments))
        return {"devices": [PHONE]} if name == "live_dashboard.list_devices" else {"ok": True}

    run(home, tool)
    run(home, tool)

    sends = [arguments for name, arguments in calls if name == "live_dashboard.send_device_commands"]
    assert len(sends) == 1
    assert sends[0]["commands"] == [{"device_id": "android-main", "say": "月圆之夜我封了\n九点前先交十个新的"}]
    assert sends[0]["created_by"] == "supervision"


def test_old_failures_and_an_unreachable_live_are_left_alone(tmp_path):
    home = home_with(tmp_path, [{"id": "consumer", "last_delivery_error": "rejected"}], {"consumer": "词呢"})
    output = home / "cron" / "output" / "consumer" / "run.md"
    os.utime(output, (time.time() - 3600, time.time() - 3600))
    calls = []
    run(home, lambda name, arguments: calls.append(name) or {})
    assert calls == []

    os.utime(output, None)

    def unreachable(name, arguments):
        raise MODULE.LiveMcpError("unreachable:OSError")

    run(home, unreachable)
    # Nothing was recorded as handled, so the next tick retries.
    assert MODULE.load_handled(home / "state" / MODULE.STATE_NAME) == []
