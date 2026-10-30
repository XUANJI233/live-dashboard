"""Read what a Hermes cron run actually answered, from its saved output files."""

from __future__ import annotations

from pathlib import Path


SILENT_MARKER = "[SILENT]"
EMPTY_PLACEHOLDER = "(No response generated)"
# Used only where Hermes itself is not importable (tests); production defers to Hermes.
_FALLBACK_MARKERS = {"[SILENT]", "SILENT", "NO_REPLY", "NO REPLY", "[静默]", "静默", "[沉默]", "沉默"}


def outputs_newest_first(home: Path, job_id: str) -> list[Path]:
    return sorted((home / "cron" / "output" / job_id).glob("*.md"), key=lambda path: path.stat().st_mtime, reverse=True)


def latest_output(home: Path, job_id: str) -> Path | None:
    outputs = outputs_newest_first(home, job_id)
    return outputs[0] if outputs else None


def response_from_output(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    return text.rsplit("## Response", 1)[-1].strip() if "## Response" in text else ""


def is_sendable_response(value: str) -> bool:
    """True only for a response Hermes would actually deliver from an autonomous lane."""
    text = (value or "").strip()
    if not text or text == EMPTY_PLACEHOLDER:
        return False
    return not _is_silence(text)


def _is_silence(text: str) -> bool:
    try:
        from gateway.response_filters import is_autonomous_silence_response
    except ImportError:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        return (
            text.upper().startswith(SILENT_MARKER)
            or any(" ".join(line.upper().split()) in _FALLBACK_MARKERS for line in (lines[0], lines[-1]))
        )
    return bool(is_autonomous_silence_response(text))
