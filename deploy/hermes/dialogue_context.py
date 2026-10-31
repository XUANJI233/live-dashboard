#!/usr/bin/env python3
"""Pre-run context for scheduled summaries: always wake, carrying the day's conversation tail."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from candidate_script_gate import dialogue_session_key
from dialogue_tail import chat_summary, recent_dialogue


SUMMARY_DIALOGUE_LIMIT = 100


def main() -> int:
    home = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    try:
        key = dialogue_session_key()
    except (OSError, ValueError, TypeError, ImportError):
        key = ""
    context = {"wakeAgent": True, "recent_dialogue": recent_dialogue(home, key, SUMMARY_DIALOGUE_LIMIT)}
    summary = chat_summary(home, key)
    if summary:
        context["chat_summary"] = summary
    print(json.dumps(context, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
