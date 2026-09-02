#!/usr/bin/env python3
"""Apply bounded prompts and remove per-job self continuity without resuming jobs."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable


PROMPT_FILES = {
    "live-supervision-review": "supervision.md",
    "teacher-friend-companion": "companion.md",
    "live-memory-sync": "memory.md",
    "live-daily-summary": "daily.md",
    "live-weekly-summary": "weekly.md",
    "strict-proactive-followup": "followup.md",
}


def configure_jobs(
    prompt_dir: Path,
    resolve_job: Callable[[str], dict[str, Any] | None],
    update_job: Callable[[str, dict[str, Any]], object],
) -> list[str]:
    changed = []
    for name, filename in PROMPT_FILES.items():
        prompt = (prompt_dir / filename).read_text(encoding="utf-8").strip()
        if not prompt:
            raise ValueError(f"empty prompt: {filename}")
        job = resolve_job(name)
        if not job or not isinstance(job.get("id"), str):
            raise ValueError(f"job not found: {name}")
        if update_job(job["id"], {"prompt": prompt, "context_from": None}) is None:
            raise ValueError(f"job update failed: {name}")
        changed.append(name)
    return changed


def main() -> int:
    prompt_dir = Path(os.environ.get("HERMES_LIVE_PROMPT_DIR") or "/var/lib/hermes/prompts/live")
    from cron.jobs import resolve_job_ref, update_job

    changed = configure_jobs(prompt_dir, resolve_job_ref, update_job)
    print(json.dumps({"updated": changed, "self_continuity": False}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
