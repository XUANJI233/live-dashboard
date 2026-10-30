"""Durable spool between the Live webhook route and the isolated event consumer job.

The webhook acknowledges Live only after a record is fsynced here; the one-minute consumer cron
moves each record to `done/` before its own run starts, so an event wakes at most one model run.
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
DONE_RETENTION_SECONDS = 2 * 24 * 60 * 60


def queue_root(home: Path) -> Path:
    return home / QUEUE_DIR


def record_name(event_id: str) -> str:
    return hashlib.sha256(event_id.encode("utf-8")).hexdigest()[:40] + ".json"


def enqueue(home: Path, record: dict[str, Any]) -> bool:
    """Persist a record; False when the event was already queued or handled (a Live retry)."""
    root = queue_root(home)
    pending, done = _ensure(root / "pending"), _ensure(root / "done")
    name = record_name(record["event"]["event_id"])
    if (pending / name).exists() or (done / name).exists():
        return False
    temporary = pending / f".{name}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(record, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, pending / name)
    _fsync_dir(pending)
    return True


def pending_records(home: Path) -> list[tuple[Path, dict[str, Any]]]:
    directory = queue_root(home) / "pending"
    records = []
    for path in sorted(directory.glob("*.json")) if directory.is_dir() else []:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict) and isinstance(value.get("event"), dict):
            records.append((path, value))
    return records


def mark_done(home: Path, path: Path, outcome: str) -> None:
    done = _ensure(queue_root(home) / "done")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        value = {}
    value["outcome"] = outcome
    value["handled_at"] = int(time.time())
    temporary = done / f".{path.name}.tmp"
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, done / path.name)
    path.unlink(missing_ok=True)
    _fsync_dir(done)


def prune_done(home: Path, now: float) -> None:
    directory = queue_root(home) / "done"
    for path in directory.glob("*.json") if directory.is_dir() else []:
        try:
            if now - path.stat().st_mtime > DONE_RETENTION_SECONDS:
                path.unlink()
        except OSError:
            continue


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
