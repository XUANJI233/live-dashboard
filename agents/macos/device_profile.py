"""macOS device profile helpers for backend capability filtering."""

from __future__ import annotations


DESKTOP_DEVICE_PROFILE = "desktop_message"

DESKTOP_CAPABILITIES = {
    "freeze": False,
    "unfreeze": False,
    "vibrate": False,
    "screen_off": False,
    "say": True,
}


def with_device_capabilities(extra: dict | None = None) -> dict:
    """Attach explicit desktop message capabilities to a report extra payload."""
    payload = dict(extra or {})
    device = payload.get("device")
    device_payload = dict(device) if isinstance(device, dict) else {}
    device_payload.update({
        "profile": DESKTOP_DEVICE_PROFILE,
        "capabilities": dict(DESKTOP_CAPABILITIES),
    })
    payload["device"] = device_payload
    return payload
