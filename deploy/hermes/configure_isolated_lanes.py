#!/usr/bin/env python3
"""Run Live controller jobs as isolated sessions that mirror their deliveries into the chat.

Pair with `session_events.enabled: false` and `HERMES_LIVE_EVENT_QUEUE_ENABLED=true`. The Weixin
conversation then carries only his messages and what was actually sent, so a stronger dialogue
model does not replay every automated wake.
"""

from __future__ import annotations

import json
import os
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


def configure_jobs(
    prompt_dir: Path,
    resolve_job: Callable[[str], dict[str, Any] | None],
    update_job: Callable[[str, dict[str, Any]], object],
    resume_job: Callable[[str], object],
    parse_schedule: Callable[[str], dict[str, Any]],
) -> list[str]:
    changed = []
    for name, spec in JOBS.items():
        prompt = (prompt_dir / spec["prompt"]).read_text(encoding="utf-8").strip()
        if not prompt:
            raise ValueError(f"empty prompt: {spec['prompt']}")
        job = resolve_job(name)
        if not job or not isinstance(job.get("id"), str):
            raise ValueError(f"job not found: {name}")
        updates: dict[str, Any] = {
            "prompt": prompt,
            "context_from": None,
            "skills": list(SKILLS),
            "enabled_toolsets": list(ISOLATED_TOOLSETS),
            # Explicit `platform:chat` targets are mirrored into the chat only on this opt-in.
            "attach_to_session": True,
        }
        if "script" in spec:
            updates["script"] = spec["script"]
        if spec.get("consumer"):
            updates["schedule"] = parse_schedule(CONSUMER_SCHEDULE)
        if update_job(job["id"], updates) is None:
            raise ValueError(f"job update failed: {name}")
        if spec.get("consumer") and job.get("enabled") is not True:
            if resume_job(job["id"]) is None:
                raise ValueError(f"job resume failed: {name}")
        changed.append(name)
    return changed


def main() -> int:
    prompt_dir = Path(os.environ.get("HERMES_LIVE_PROMPT_DIR") or "/var/lib/hermes/prompts/live")
    from cron.jobs import parse_schedule, resolve_job_ref, resume_job, update_job

    changed = configure_jobs(prompt_dir, resolve_job_ref, update_job, resume_job, parse_schedule)
    print(json.dumps({"updated": changed, "isolated": True}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
