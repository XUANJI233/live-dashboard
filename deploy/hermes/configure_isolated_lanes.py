#!/usr/bin/env python3
"""Run Live controller jobs as isolated sessions that mirror their deliveries into the chat.

Pair with `session_events.enabled: false` and `HERMES_LIVE_EVENT_QUEUE_ENABLED=true`. The Weixin
conversation then carries only his messages and what was actually sent, so a stronger dialogue
model does not replay every automated wake.

Every job is pinned to an explicit provider and model: Hermes skips an unpinned isolated run
whose creation-time model differs from the global default (`[drift_skip]`). Re-run with
`HERMES_LIVE_JOB_MODEL` / `HERMES_LIVE_JOB_PROVIDER` to move the jobs to another model. A paused
event consumer stays paused (and the fallback job with it) unless
`HERMES_LIVE_RESUME_CONSUMER=true`.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


SKILLS = ["live-mentor", "strict-study-girlfriend"]
# MCP servers are layered onto a per-job list by Hermes; cron runs never get cronjob/clarify.
ISOLATED_TOOLSETS = ["memory", "session_search", "skills", "vision"]
CONSUMER_SCHEDULE = "every 1m"
JOBS: dict[str, dict[str, Any]] = {
    "live-supervision-review": {"prompt": "supervision.md", "script": "live_event_candidate.py", "consumer": True},
    "teacher-friend-companion": {"prompt": "companion.md"},
    "strict-proactive-followup": {"prompt": "followup.md"},
    "live-daily-summary": {"prompt": "daily.md", "script": "dialogue_context.py"},
    "live-weekly-summary": {"prompt": "weekly.md", "script": "dialogue_context.py"},
    "live-memory-sync": {"prompt": "memory.md"},
}
FALLBACK_JOB = {
    "name": "weixin-delivery-fallback",
    "schedule": "every 2m",
    "script": "weixin_delivery_fallback.py",
}


@dataclass(frozen=True)
class CronApi:
    resolve: Callable[[str], dict[str, Any] | None]
    update: Callable[[str, dict[str, Any]], object]
    resume: Callable[[str], object]
    pause: Callable[[str], object]
    parse_schedule: Callable[[str], dict[str, Any]]
    create: Callable[..., object]


def configure_jobs(prompt_dir: Path, cron: CronApi, inference: dict[str, str], resume_consumer: bool) -> dict[str, Any]:
    if not inference.get("provider") or not inference.get("model"):
        raise ValueError("an explicit provider and model are required")
    # Pass 1 changes nothing: a missing job or prompt must not leave a half-applied setup.
    planned: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    for name, spec in JOBS.items():
        try:
            prompt = (prompt_dir / spec["prompt"]).read_text(encoding="utf-8").strip()
        except OSError as error:
            raise ValueError(f"prompt unreadable: {spec['prompt']}") from error
        if not prompt:
            raise ValueError(f"empty prompt: {spec['prompt']}")
        job = cron.resolve(name)
        if not job or not isinstance(job.get("id"), str):
            raise ValueError(f"job not found: {name}")
        updates: dict[str, Any] = {
            "prompt": prompt,
            "context_from": None,
            "skills": list(SKILLS),
            "enabled_toolsets": list(ISOLATED_TOOLSETS),
            # Explicit `platform:chat` targets are mirrored into the chat only on this opt-in.
            "attach_to_session": True,
            **inference,
        }
        if "script" in spec:
            updates["script"] = spec["script"]
        if spec.get("consumer"):
            updates["schedule"] = cron.parse_schedule(CONSUMER_SCHEDULE)
        planned.append((name, job, updates))

    consumer = next(job for name, job, _ in planned if JOBS[name].get("consumer"))
    consumer_paused = consumer.get("enabled") is not True and not resume_consumer
    for name, job, updates in planned:
        if cron.update(job["id"], updates) is None:
            raise ValueError(f"job update failed: {name}")
        if JOBS[name].get("consumer") and job.get("enabled") is not True and resume_consumer:
            if cron.resume(job["id"]) is None:
                raise ValueError(f"job resume failed: {name}")
    created = False
    if cron.resolve(FALLBACK_JOB["name"]) is None:
        # No model ever runs here; the script itself sends the phone notification.
        fallback = cron.create(prompt=None, schedule=FALLBACK_JOB["schedule"], name=FALLBACK_JOB["name"],
                               deliver="local", script=FALLBACK_JOB["script"], no_agent=True)
        created = True
        if consumer_paused and isinstance(fallback, dict) and isinstance(fallback.get("id"), str):
            cron.pause(fallback["id"])
    return {"updated": [name for name, _, _ in planned], "fallback_created": created, "consumer_paused": consumer_paused}


def configured_inference() -> dict[str, str]:
    from hermes_cli.config import load_config

    model = (load_config() or {}).get("model") or {}
    return {
        "provider": os.environ.get("HERMES_LIVE_JOB_PROVIDER") or str(model.get("provider") or ""),
        "model": os.environ.get("HERMES_LIVE_JOB_MODEL") or str(model.get("default") or ""),
    }


def main() -> int:
    prompt_dir = Path(os.environ.get("HERMES_LIVE_PROMPT_DIR") or "/var/lib/hermes/prompts/live")
    from cron.jobs import create_job, parse_schedule, pause_job, resolve_job_ref, resume_job, update_job

    cron = CronApi(resolve_job_ref, update_job, resume_job, pause_job, parse_schedule, create_job)
    inference = configured_inference()
    resume_consumer = os.environ.get("HERMES_LIVE_RESUME_CONSUMER", "").strip().lower() == "true"
    result = configure_jobs(prompt_dir, cron, inference, resume_consumer)
    print(json.dumps({**result, "isolated": True, **inference}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
