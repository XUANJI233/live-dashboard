"""Durable spool between the Live webhook route and the isolated event consumer job.

The webhook acknowledges Live only after a record is fsynced into `pending/`. The one-minute
consumer gate moves the record it dispatches to `inflight/` before the run starts; the next gate
tick settles it into `done/`, or back into `pending/` when the run failed, at most twice.
`done/` doubles as the replay guard for Live's retries until it is pruned.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any


QUEUE_DIR = Path("state") / "live-events"
STAGES = ("pending", "inflight", "done")
DONE_RETENTION_SECONDS = 2 * 24 * 60 * 60


def queue_root(home: Path) -> Path:
    return home / QUEUE_DIR


def record_name(event_id: str) -> str:
    return hashlib.sha256(event_id.encode("utf-8")).hexdigest()[:40] + ".json"


def enqueue(home: Path, record: dict[str, Any]) -> bool:
    """Persist a record; False when the event was already queued or handled (a Live retry)."""
    root = queue_root(home)
    name = record_name(record["event"]["event_id"])
    if any((root / stage / name).exists() for stage in STAGES):
        return False
    pending = _ensure(root / "pending")
    _write(pending, name, record)
    return True


def stage_records(home: Path, stage: str) -> list[tuple[Path, dict[str, Any]]]:
    directory = queue_root(home) / stage
    records = []
    for path in sorted(directory.glob("*.json")) if directory.is_dir() else []:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict) and isinstance(value.get("event"), dict):
            records.append((path, value))
    return records


def pending_records(home: Path) -> list[tuple[Path, dict[str, Any]]]:
    return stage_records(home, "pending")


def move(home: Path, path: Path, stage: str, record: dict[str, Any]) -> Path:
    """Write the updated record into `stage` and drop it from where it was."""
    target = _write(_ensure(queue_root(home) / stage), path.name, record)
    if path != target:
        path.unlink(missing_ok=True)
    return target


def mark_done(home: Path, path: Path, outcome: str, record: dict[str, Any] | None = None) -> None:
    value = record if record is not None else _read(path)
    move(home, path, "done", {**value, "outcome": outcome, "handled_at": int(time.time())})


def prune_done(home: Path, now: float) -> None:
    directory = queue_root(home) / "done"
    for path in directory.glob("*.json") if directory.is_dir() else []:
        try:
            if now - path.stat().st_mtime > DONE_RETENTION_SECONDS:
                path.unlink()
        except OSError:
            continue


def _read(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _write(directory: Path, name: str, record: dict[str, Any]) -> Path:
    temporary = directory / f".{name}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(record, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    target = directory / name
    os.replace(temporary, target)
    _fsync_dir(directory)
    return target


def _ensure(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def _fsync_dir(path: Path) -> None:
    if os.name != "posix":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
