#!/usr/bin/env python3
"""Run Live controller jobs as isolated sessions that mirror their deliveries into the chat.

Pair with `session_events.enabled: false` and `HERMES_LIVE_EVENT_QUEUE_ENABLED=true`. The Weixin
conversation then carries only his messages and what was actually sent, so a stronger dialogue
model does not replay every automated wake.

Every job is pinned to an explicit provider and model: Hermes skips an unpinned isolated run
whose creation-time model differs from the global default (`[drift_skip]`). Re-run with
`HERMES_LIVE_JOB_MODEL` / `HERMES_LIVE_JOB_PROVIDER` to move the jobs to another model.
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
    parse_schedule: Callable[[str], dict[str, Any]]
    create: Callable[..., object]


def configure_jobs(prompt_dir: Path, cron: CronApi, inference: dict[str, str]) -> list[str]:
    if not inference.get("provider") or not inference.get("model"):
        raise ValueError("an explicit provider and model are required")
    changed = []
    for name, spec in JOBS.items():
        prompt = (prompt_dir / spec["prompt"]).read_text(encoding="utf-8").strip()
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
        if cron.update(job["id"], updates) is None:
            raise ValueError(f"job update failed: {name}")
        if spec.get("consumer") and job.get("enabled") is not True:
            if cron.resume(job["id"]) is None:
                raise ValueError(f"job resume failed: {name}")
        changed.append(name)
    if cron.resolve(FALLBACK_JOB["name"]) is None:
        # No model ever runs here; the script itself sends the phone notification.
        cron.create(prompt=None, schedule=FALLBACK_JOB["schedule"], name=FALLBACK_JOB["name"],
                    deliver="local", script=FALLBACK_JOB["script"], no_agent=True)
        changed.append(FALLBACK_JOB["name"])
    return changed


def configured_inference() -> dict[str, str]:
    from hermes_cli.config import load_config

    model = (load_config() or {}).get("model") or {}
    return {
        "provider": os.environ.get("HERMES_LIVE_JOB_PROVIDER") or str(model.get("provider") or ""),
        "model": os.environ.get("HERMES_LIVE_JOB_MODEL") or str(model.get("default") or ""),
    }


def main() -> int:
    prompt_dir = Path(os.environ.get("HERMES_LIVE_PROMPT_DIR") or "/var/lib/hermes/prompts/live")
    from cron.jobs import create_job, parse_schedule, resolve_job_ref, resume_job, update_job

    cron = CronApi(resolve_job_ref, update_job, resume_job, parse_schedule, create_job)
    inference = configured_inference()
    changed = configure_jobs(prompt_dir, cron, inference)
    print(json.dumps({"updated": changed, "isolated": True, **inference}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
