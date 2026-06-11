"""Device command parsing and desktop-safe execution for Windows."""

from __future__ import annotations

from datetime import datetime, timezone


def extract_device_command(message: object) -> dict | None:
    """Return a device_command envelope from a WS frame, queued message, or payload."""
    if not isinstance(message, dict):
        return None
    if message.get("type") == "device_command":
        return message
    payload = message.get("payload")
    if isinstance(payload, dict) and payload.get("type") == "device_command":
        return payload
    return None


def command_id(envelope: dict) -> str:
    return _text(envelope.get("command_id"))


def request_id(envelope: dict) -> str:
    return _text(envelope.get("request_id"))


def receipt_frame(envelope: dict, status: str = "received") -> dict:
    return {
        "type": "device_command_receipt",
        "request_id": request_id(envelope),
        "command_id": command_id(envelope),
        "status": status,
        "received_at": now_iso(),
    }


def execute_desktop_command(envelope: dict) -> tuple[dict, dict | None]:
    """Apply the desktop subset and return (result_frame, synthetic_message)."""
    cid = command_id(envelope)
    rid = request_id(envelope)
    payload = envelope.get("payload") if isinstance(envelope.get("payload"), dict) else {}
    assert isinstance(payload, dict)

    expired = is_expired(_text(envelope.get("expires_at")))
    kind = _text(payload.get("kind"))
    say = _text(payload.get("say"))[:500]
    actions: list[dict] = []
    unsupported: list[str] = []

    if expired:
        result_status = "expired"
        reason = "command_expired"
    elif kind == "supervision_policy":
        result_status = "unsupported"
        reason = "policy_requires_android_lsp"
    elif kind != "supervision":
        result_status = "unsupported"
        reason = "unsupported_command_kind:" + (kind or "missing")
    else:
        if say:
            actions.append({"action": "say", "status": "applied"})
        if _has_items(payload.get("freeze_commands")):
            unsupported.append("freeze")
        if _has_items(payload.get("unfreeze_commands")):
            unsupported.append("unfreeze")
        if payload.get("vibrate") is True:
            unsupported.append("vibrate")
        if payload.get("screen_off") is True:
            unsupported.append("screen_off")

        if say and unsupported:
            result_status = "partial"
            reason = "unsupported_actions:" + ",".join(unsupported)
        elif say:
            result_status = "applied"
            reason = ""
        elif unsupported:
            result_status = "unsupported"
            reason = "unsupported_actions:" + ",".join(unsupported)
        else:
            result_status = "ignored"
            reason = "empty_desktop_command"

    result = {
        "type": "device_command_result",
        "request_id": rid,
        "command_id": cid,
        "result_id": f"res_{cid}" if cid else "",
        "status": result_status,
        "executed_at": now_iso(),
        "actions": actions,
        "state_after": {"desktop_message_visible": _applied_say(actions)},
        "reason": reason,
    }

    message = None
    if actions:
        message = {
            "message_id": cid,
            "viewer_id": "__mcp__",
            "viewer_name": command_sender_name(envelope.get("created_by")),
            "kind": "device_command",
            "text": say,
            "created_at": _text(envelope.get("issued_at")) or now_iso(),
            "queued": False,
            "payload": envelope,
        }
    return result, message


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def command_sender_name(value: object) -> str:
    sender = _text(value)
    if sender == "supervision":
        return "AI 监督"
    if sender == "mcp":
        return "设备控制"
    return sender or "AI 监督"


def is_expired(value: str) -> bool:
    if not value:
        return False
    try:
        expires = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return expires <= datetime.now(timezone.utc)


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _has_items(value: object) -> bool:
    return isinstance(value, list) and any(isinstance(item, str) and item.strip() for item in value)


def _applied_say(actions: list[dict]) -> bool:
    return any(item.get("action") == "say" and item.get("status") == "applied" for item in actions)
