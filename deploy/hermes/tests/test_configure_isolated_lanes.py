import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "configure_isolated_lanes.py"
SPEC = importlib.util.spec_from_file_location("configure_isolated_lanes", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
PROMPTS = Path(__file__).parents[1] / "prompts"


def test_every_controller_job_becomes_an_isolated_mirrored_run():
    jobs = {name: {"id": f"id-{name}", "enabled": name != "live-supervision-review"} for name in MODULE.JOBS}
    updates, resumed = {}, []

    changed = MODULE.configure_jobs(
        PROMPTS,
        jobs.get,
        lambda job_id, value: updates.setdefault(job_id, value),
        lambda job_id: resumed.append(job_id) or {"id": job_id},
        lambda text: {"kind": "interval", "display": text},
    )

    assert changed == list(MODULE.JOBS)
    for name, value in ((name, updates[f"id-{name}"]) for name in MODULE.JOBS):
        assert value["attach_to_session"] is True
        assert value["context_from"] is None
        assert value["skills"] == ["live-mentor", "strict-study-girlfriend"]
        assert "cronjob" not in value["enabled_toolsets"]
        assert value["prompt"] == (PROMPTS / MODULE.JOBS[name]["prompt"]).read_text(encoding="utf-8").strip()
    consumer = updates["id-live-supervision-review"]
    assert consumer["script"] == "live_event_candidate.py"
    assert consumer["schedule"] == {"kind": "interval", "display": "every 1m"}
    assert updates["id-live-daily-summary"]["script"] == "dialogue_context.py"
    assert "schedule" not in updates["id-teacher-friend-companion"]
    # Only the paused event consumer is resumed; other jobs keep their pause state.
    assert resumed == ["id-live-supervision-review"]


def test_missing_job_stops_before_partial_configuration():
    try:
        MODULE.configure_jobs(PROMPTS, lambda name: None, lambda *a: None, lambda *a: None, lambda text: {})
    except ValueError as error:
        assert "job not found" in str(error)
    else:
        raise AssertionError("expected a missing job to fail")
