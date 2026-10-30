"""Shared pieces of the cron script gates: the gate output and the context a real wake carries."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def dialogue_session_key() -> str:
    """The key of his Weixin conversation, read from `session_events.session_key`."""
    from hermes_cli.config import load_config

    config = load_config() or {}
    settings = config.get("session_events") if isinstance(config, dict) else None
    key = settings.get("session_key") if isinstance(settings, dict) else None
    return key.strip() if isinstance(key, str) else ""


def script_gate(output: str, *, error: str | None = None, context: dict[str, Any] | None = None) -> str:
    value: dict[str, Any] = json.loads(output)
    value["wakeAgent"] = value.get("selected_this_run") is True
    if error:
        value["gate_error"] = error
    if context and value["wakeAgent"]:
        # Context rides only on a real wake; a skipped run never reads or prints it.
        value.update(context)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def wake_context(root: Path, output: str) -> dict[str, Any] | None:
    if json.loads(output).get("selected_this_run") is not True:
        return None
    from dialogue_tail import recent_dialogue

    try:
        key = dialogue_session_key()
    except (OSError, ValueError, TypeError, ImportError):
        key = ""
    return {"recent_dialogue": recent_dialogue(root, key)}
