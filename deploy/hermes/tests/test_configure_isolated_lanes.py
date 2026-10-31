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
VOICE = {"provider": "custom:chat", "model": "chat-model"}
VOICE_JOBS = ["live-supervision-review", "teacher-friend-companion", "strict-proactive-followup"]


def fake_cron(jobs):
    calls = {"updates": {}, "resumed": [], "paused": [], "created": []}
    cron = MODULE.CronApi(
        resolve=jobs.get,
        update=lambda job_id, value: calls["updates"].setdefault(job_id, value),
        resume=lambda job_id: calls["resumed"].append(job_id) or {"id": job_id},
        pause=lambda job_id: calls["paused"].append(job_id) or {"id": job_id},
        parse_schedule=lambda text: {"kind": "interval", "display": text},
        create=lambda **kwargs: calls["created"].append(kwargs) or {"id": "fallback"},
    )
    return cron, calls


def all_jobs(consumer_enabled):
    return {name: {"id": f"id-{name}", "enabled": consumer_enabled or name != "live-supervision-review"} for name in MODULE.JOBS}


def test_every_controller_job_becomes_an_isolated_pinned_mirrored_run():
    cron, calls = fake_cron(all_jobs(consumer_enabled=False))

    result = MODULE.configure_jobs(PROMPTS, cron, INFERENCE, resume_consumer=True, voice_inference=VOICE)

    assert result == {"updated": list(MODULE.JOBS), "fallback_created": True, "consumer_paused": False}
    for name in MODULE.JOBS:
        value = calls["updates"][f"id-{name}"]
        assert value["attach_to_session"] is True
        assert value["context_from"] is None
        assert value["skills"] == ["live-mentor", "strict-study-girlfriend"]
        assert "cronjob" not in value["enabled_toolsets"]
        # Unpinned isolated runs are skipped by Hermes once the global model drifts.
        expected = VOICE if name in VOICE_JOBS else INFERENCE
        assert (value["provider"], value["model"]) == (expected["provider"], expected["model"])
        assert value["prompt"] == (PROMPTS / MODULE.JOBS[name]["prompt"]).read_text(encoding="utf-8").strip()
    consumer = calls["updates"]["id-live-supervision-review"]
    assert consumer["script"] == "live_event_candidate.py"
    assert consumer["schedule"] == {"kind": "interval", "display": "every 1m"}
    assert calls["updates"]["id-live-daily-summary"]["script"] == "dialogue_context.py"
    assert "schedule" not in calls["updates"]["id-teacher-friend-companion"]
    assert calls["resumed"] == ["id-live-supervision-review"]
    assert calls["created"] == [{"prompt": None, "schedule": "every 2m", "name": "weixin-delivery-fallback",
                                 "deliver": "local", "script": "weixin_delivery_fallback.py", "no_agent": True}]
    assert calls["paused"] == []


def test_without_a_chat_model_the_voice_jobs_share_the_job_model():
    cron, calls = fake_cron(all_jobs(consumer_enabled=True))
    MODULE.configure_jobs(PROMPTS, cron, INFERENCE, resume_consumer=False)
    assert {calls["updates"][f"id-{name}"]["model"] for name in MODULE.JOBS} == {"dialogue-model"}


def test_a_paused_consumer_stays_paused_and_the_fallback_waits_with_it():
    cron, calls = fake_cron(all_jobs(consumer_enabled=False))
    result = MODULE.configure_jobs(PROMPTS, cron, INFERENCE, resume_consumer=False)
    assert result["consumer_paused"] is True
    assert calls["resumed"] == []
    assert calls["paused"] == ["fallback"]


def test_an_existing_fallback_job_is_not_duplicated():
    jobs = {**all_jobs(consumer_enabled=True), "weixin-delivery-fallback": {"id": "fallback", "enabled": True}}
    cron, calls = fake_cron(jobs)
    MODULE.configure_jobs(PROMPTS, cron, INFERENCE, resume_consumer=False)
    assert calls["created"] == []


def test_a_missing_job_prompt_or_model_changes_nothing(tmp_path):
    for jobs in ({}, {name: value for name, value in all_jobs(True).items() if name != "live-memory-sync"}):
        cron, calls = fake_cron(jobs)
        with pytest.raises(ValueError, match="job not found"):
            MODULE.configure_jobs(PROMPTS, cron, INFERENCE, resume_consumer=True)
        assert calls == {"updates": {}, "resumed": [], "paused": [], "created": []}

    for name in MODULE.JOBS.values():
        (tmp_path / name["prompt"]).write_text((PROMPTS / name["prompt"]).read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / "memory.md").write_text("  ", encoding="utf-8")
    cron, calls = fake_cron(all_jobs(True))
    with pytest.raises(ValueError, match="empty prompt"):
        MODULE.configure_jobs(tmp_path, cron, INFERENCE, resume_consumer=True)
    assert calls["updates"] == {}

    with pytest.raises(ValueError, match="explicit provider and model"):
        MODULE.configure_jobs(PROMPTS, cron, {"provider": "custom", "model": ""}, resume_consumer=True)
    with pytest.raises(ValueError, match="explicit provider and model"):
        MODULE.configure_jobs(PROMPTS, cron, INFERENCE, resume_consumer=True,
                              voice_inference={"provider": "", "model": "m"})


def test_resuming_the_consumer_also_resumes_a_paused_fallback():
    jobs = {**all_jobs(consumer_enabled=False), "weixin-delivery-fallback": {"id": "fallback", "enabled": False}}
    cron, calls = fake_cron(jobs)
    MODULE.configure_jobs(PROMPTS, cron, INFERENCE, resume_consumer=True)
    assert calls["resumed"] == ["id-live-supervision-review", "fallback"]
    assert calls["paused"] == []
