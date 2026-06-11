"""Message presentation helpers for the Windows agent UI."""

from __future__ import annotations


def message_key(message: dict) -> str:
    """Return the stable id used to deduplicate UI messages."""
    return _text(message.get("message_id"))


def normalize_message(data: dict) -> dict | None:
    """Normalize current REST/WS message rows into the internal message shape."""
    message_id = _text(data.get("message_id")) or _text(data.get("id"))
    if not message_id:
        return None
    msg = {
        "message_id": message_id,
        "viewer_id": _text(data.get("viewer_id")),
        "viewer_name": _text(data.get("viewer_name")),
        "kind": _text(data.get("kind"), "text"),
        "text": _text(data.get("text")),
        "created_at": _text(data.get("created_at")),
        "queued": data.get("queued") is True,
    }
    payload = data.get("payload")
    if isinstance(payload, dict):
        msg["payload"] = payload
    return msg


def messages_from_response(parsed: object) -> list[dict]:
    """Extract the current JSON object response: {"messages": [...]}."""
    if not isinstance(parsed, dict) or not isinstance(parsed.get("messages"), list):
        return []
    messages = []
    for item in parsed["messages"]:
        if isinstance(item, dict):
            msg = normalize_message(item)
            if msg:
                messages.append(msg)
    return messages


def message_sender(message: dict) -> str:
    """Return the best available display sender for a message."""
    return _text(message.get("viewer_name")) or _text(message.get("viewer_id")) or "未知"


def message_summary(message: dict, limit: int = 48) -> str:
    """Return a single-line list label for a message."""
    sender = message_sender(message)
    text = _text(message.get("text")).replace("\n", " ")
    if len(text) > limit:
        text = text[:limit].rstrip() + "..."
    return f"{sender}: {text}" if text else sender


def message_detail(message: dict) -> str:
    """Return the read-only detail text shown for a selected message."""
    created = _text(message.get("created_at")) or "未知"
    text = _text(message.get("text")) or "无内容"
    queued = "是" if message.get("queued") is True else "否"
    return "\n".join([
        f"发送者: {message_sender(message)}",
        f"时间: {created}",
        f"排队: {queued}",
        "",
        text,
    ])


def merge_new_messages(existing: list[dict], incoming: list[dict], limit: int = 30) -> list[dict]:
    """Prepend unseen incoming messages while keeping newest messages first."""
    merged = list(existing)
    seen = {message_key(item) for item in merged if message_key(item)}
    for item in incoming:
        key = message_key(item)
        if key and key in seen:
            continue
        merged.insert(0, item)
        if key:
            seen.add(key)
    return merged[:limit]


def _text(value: object, default: str = "") -> str:
    return value.strip() if isinstance(value, str) else default
