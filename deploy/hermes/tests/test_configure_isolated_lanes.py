import importlib.util
import sys
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[1] / "configure_isolated_lanes.py"
SPEC = importlib.util.spec_from_file_location("configure_isolated_lanes", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
# dataclasses resolve their module through sys.modules.
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
PROMPTS = Path(__file__).parents[1] / "prompts"
INFERENCE = {"provider": "custom", "model": "dialogue-model"}


def fake_cron(jobs):
    updates, resumed, created = {}, [], []
    cron = MODULE.CronApi(
        resolve=jobs.get,
        update=lambda job_id, value: updates.setdefault(job_id, value),
        resume=lambda job_id: resumed.append(job_id) or {"id": job_id},
        parse_schedule=lambda text: {"kind": "interval", "display": text},
        create=lambda **kwargs: created.append(kwargs) or {"id": "fallback"},
    )
    return cron, updates, resumed, created


def test_every_controller_job_becomes_an_isolated_pinned_mirrored_run():
    jobs = {name: {"id": f"id-{name}", "enabled": name != "live-supervision-review"} for name in MODULE.JOBS}
    cron, updates, resumed, created = fake_cron(jobs)

    changed = MODULE.configure_jobs(PROMPTS, cron, INFERENCE)

    assert changed == [*MODULE.JOBS, "weixin-delivery-fallback"]
    for name in MODULE.JOBS:
        value = updates[f"id-{name}"]
        assert value["attach_to_session"] is True
        assert value["context_from"] is None
        assert value["skills"] == ["live-mentor", "strict-study-girlfriend"]
        assert "cronjob" not in value["enabled_toolsets"]
        # Unpinned isolated runs are skipped by Hermes once the global model drifts.
        assert (value["provider"], value["model"]) == ("custom", "dialogue-model")
        assert value["prompt"] == (PROMPTS / MODULE.JOBS[name]["prompt"]).read_text(encoding="utf-8").strip()
    consumer = updates["id-live-supervision-review"]
    assert consumer["script"] == "live_event_candidate.py"
    assert consumer["schedule"] == {"kind": "interval", "display": "every 1m"}
    assert updates["id-live-daily-summary"]["script"] == "dialogue_context.py"
    assert "schedule" not in updates["id-teacher-friend-companion"]
    # Only the paused event consumer is resumed; other jobs keep their pause state.
    assert resumed == ["id-live-supervision-review"]
    assert created == [{"prompt": None, "schedule": "every 2m", "name": "weixin-delivery-fallback",
                        "deliver": "local", "script": "weixin_delivery_fallback.py", "no_agent": True}]


def test_an_existing_fallback_job_is_not_duplicated():
    jobs = {name: {"id": f"id-{name}", "enabled": True} for name in [*MODULE.JOBS, "weixin-delivery-fallback"]}
    cron, _, _, created = fake_cron(jobs)
    MODULE.configure_jobs(PROMPTS, cron, INFERENCE)
    assert created == []


def test_missing_job_or_model_stops_before_partial_configuration():
    cron, updates, _, _ = fake_cron({})
    with pytest.raises(ValueError, match="job not found"):
        MODULE.configure_jobs(PROMPTS, cron, INFERENCE)
    with pytest.raises(ValueError, match="explicit provider and model"):
        MODULE.configure_jobs(PROMPTS, cron, {"provider": "custom", "model": ""})
    assert updates == {}
