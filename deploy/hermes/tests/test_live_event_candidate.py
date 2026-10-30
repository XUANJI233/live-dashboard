import importlib.util
import io
import json
import os
import sys
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


SCRIPTS = Path(__file__).parents[1]
sys.path.insert(0, str(SCRIPTS))


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


QUEUE = load("live_event_queue")
CANDIDATE = load("live_event_candidate")
NOW = datetime(2026, 10, 30, 9, 0, tzinfo=timezone.utc).timestamp()


def event(event_id, event_type="supervision.review_requested", *, minutes_ago=1, devices=("android-main",)):
    occurred = datetime.fromtimestamp(NOW - minutes_ago * 60, timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "schema": "live_dashboard.controller_event.v1",
        "v": 1,
        "event_id": event_id,
        "event_type": event_type,
        "occurred_at": occurred,
        "source": "scheduled",
        "device_ids": list(devices),
        "reason_codes": ["scheduled_check"],
    }


def record(value, mode="supervision", task=None):
    return {"event": value, "mode": mode, "task": task, "queued_at": "2026-10-30T09:00:00+00:00"}


def test_enqueue_is_durable_and_idempotent_across_handling(tmp_path):
    first = record(event("review:1"))

    assert QUEUE.enqueue(tmp_path, first) is True
    assert QUEUE.enqueue(tmp_path, first) is False
    [(path, stored)] = QUEUE.pending_records(tmp_path)
    assert stored == first

    QUEUE.mark_done(tmp_path, path, "dispatched")
    assert QUEUE.pending_records(tmp_path) == []
    # A Live retry after the run still finds the replay guard.
    assert QUEUE.enqueue(tmp_path, first) is False


def test_newest_review_per_device_wins_and_ai_work_goes_first(tmp_path):
    for value in (
        record(event("review:old", minutes_ago=20)),
        record(event("review:new", minutes_ago=2)),
        record(event("review:other-device", minutes_ago=5, devices=("tablet",))),
        record(event("ai:daily", "ai.work_requested", minutes_ago=10), mode="daily", task="claim and run daily"),
        record(event("review:stale", minutes_ago=45, devices=("watch",))),
    ):
        QUEUE.enqueue(tmp_path, value)

    chosen, retired = CANDIDATE.select_event(QUEUE.pending_records(tmp_path), NOW)

    assert chosen[1]["event"]["event_id"] == "ai:daily"
    assert sorted(outcome for _, outcome in retired) == ["expired", "superseded"]

    for path, outcome in retired:
        QUEUE.mark_done(tmp_path, path, outcome)
    QUEUE.mark_done(tmp_path, chosen[0], "dispatched")
    chosen, _ = CANDIDATE.select_event(QUEUE.pending_records(tmp_path), NOW)
    assert chosen[1]["event"]["event_id"] == "review:other-device"


def run_main(home):
    output = io.StringIO()
    with patch.dict(os.environ, {"HERMES_CONTROLLER_ENABLED": "true", "HERMES_HOME": str(home)}, clear=True), \
            redirect_stdout(output):
        assert CANDIDATE.main() == 0
    return json.loads(output.getvalue())


def test_main_dispatches_one_event_before_the_run_and_then_goes_quiet(tmp_path):
    QUEUE.enqueue(tmp_path, record(event("offline:1", "device.offline"), task="check the device"))

    with patch.object(CANDIDATE.time, "time", return_value=NOW):
        woke = run_main(tmp_path)
        quiet = run_main(tmp_path)

    assert woke["wakeAgent"] is True
    assert woke["candidate_id"] == "offline:1"
    assert woke["task"] == "check the device"
    assert woke["recent_dialogue"] == []
    assert quiet == {"selected_this_run": False, "wakeAgent": False}
    assert [path.name for path in (tmp_path / QUEUE.QUEUE_DIR / "done").glob("*.json")] == [QUEUE.record_name("offline:1")]


def test_disabled_controller_never_reads_the_queue(tmp_path):
    QUEUE.enqueue(tmp_path, record(event("review:1")))
    output = io.StringIO()
    with patch.dict(os.environ, {"HERMES_CONTROLLER_ENABLED": "false", "HERMES_HOME": str(tmp_path)}, clear=True), \
            redirect_stdout(output):
        CANDIDATE.main()
    assert json.loads(output.getvalue())["wakeAgent"] is False
    assert len(QUEUE.pending_records(tmp_path)) == 1
