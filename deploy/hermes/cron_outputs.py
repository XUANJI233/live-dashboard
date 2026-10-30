"""Read what a Hermes cron run actually answered, from its saved output files."""

from __future__ import annotations

from pathlib import Path


SILENT_MARKER = "[SILENT]"


def latest_output(home: Path, job_id: str) -> Path | None:
    outputs = sorted((home / "cron" / "output" / job_id).glob("*.md"), key=lambda path: path.stat().st_mtime)
    return outputs[-1] if outputs else None


def response_from_output(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    return text.rsplit("## Response", 1)[-1].strip() if "## Response" in text else ""


def is_sendable_response(value: str) -> bool:
    if not value.strip():
        return False
    return all(line.strip() != SILENT_MARKER for line in value.splitlines())
