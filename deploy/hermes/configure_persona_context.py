#!/usr/bin/env python3
"""Select SOUL.md plus on-demand manuals; no session deletion or cron changes."""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
from typing import Any

PERSONA_SKILLS = {"strict-study-girlfriend", "live-mentor"}
PLUGIN = "persona_context"


def persona_config(config: dict[str, Any]) -> dict[str, Any]:
    updated = deepcopy(config)
    weixin = updated.setdefault("platforms", {}).setdefault("weixin", {})
    weixin["dm_auto_skills"] = []
    # Explicit extra wins over the top-level spelling, and an empty list wins over the old env.
    if isinstance(weixin.get("extra"), dict):
        weixin["extra"]["dm_auto_skills"] = []
    skills = updated.setdefault("skills", {})
    if isinstance(skills.get("auto_load"), list):
        skills["auto_load"] = [
            name for name in skills["auto_load"]
            if not isinstance(name, str) or name.strip() not in PERSONA_SKILLS
        ]
    plugins = updated.setdefault("plugins", {})
    enabled = plugins.setdefault("enabled", [])
    if not isinstance(enabled, list):
        raise ValueError("plugins.enabled must be a list")
    if PLUGIN not in enabled:
        enabled.append(PLUGIN)
    if isinstance(plugins.get("disabled"), list):
        plugins["disabled"] = [name for name in plugins["disabled"] if name != PLUGIN]
    return updated


def configure_file(path: Path, *, yaml_api: Any = None) -> bool:
    if yaml_api is None:
        import hermes_yaml as yaml_api

    text = path.read_text(encoding="utf-8")
    config = yaml_api.safe_load(text)
    if not isinstance(config, dict):
        raise ValueError("config.yaml must contain a mapping")
    updated = persona_config(config)
    if updated == config:
        return False
    backup = path.with_suffix(path.suffix + ".persona-context.bak")
    if not backup.exists():
        descriptor = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, path.stat().st_mode & 0o777)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            yaml_api.safe_dump(updated, handle, allow_unicode=True, sort_keys=False)
        os.chmod(temporary, path.stat().st_mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="Profile config.yaml; defaults to the active Hermes home")
    args = parser.parse_args()
    path = args.config
    if path is None:
        from hermes_constants import get_hermes_home

        path = get_hermes_home() / "config.yaml"
    # Check the deployed API and assets before removing the old instruction source.
    from hermes_cli.middleware import apply_llm_request_middleware  # noqa: F401

    for relative in ("SOUL.md", "plugins/persona_context/__init__.py", "plugins/persona_context/plugin.yaml"):
        if not (path.parent / relative).is_file():
            raise ValueError(f"deploy the persona assets first: {relative}")
    changed = configure_file(path)
    print(json.dumps({"changed": changed, "dm_auto_skills": [], "history_projection": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
