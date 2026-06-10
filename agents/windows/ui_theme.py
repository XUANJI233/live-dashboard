"""Shared tkinter UI theme values for the Windows agent."""

from __future__ import annotations


BG = "#F7F6F3"
SURFACE = "#FFFFFF"
SURFACE_MUTED = "#FBFBFA"
BORDER = "#E7E3DC"
TEXT = "#1F2428"
MUTED = "#6B6F76"
ACCENT = "#1F6C9F"
SUCCESS = "#346538"
WARNING = "#956400"
ERROR = "#9F2F2D"

BUTTON_BG = "#EFECE6"
BUTTON_ACTIVE_BG = "#E7E3DC"
PRIMARY_BG = "#111111"
PRIMARY_ACTIVE_BG = "#333333"

NOTICE_INFO_BG = "#E1F3FE"
NOTICE_ERROR_BG = "#FDEBEC"
NOTICE_INFO_BORDER = "#B8DFF5"
NOTICE_ERROR_BORDER = "#F2C9CB"


def status_color(status: str) -> str:
    """Return a semantic text color for a runtime status label."""
    if "错误" in status:
        return ERROR
    if status == "AFK":
        return WARNING
    if status == "在线":
        return SUCCESS
    return TEXT


def notice_palette(error: bool = False) -> dict[str, str]:
    """Return colors for the non-modal notice banner."""
    if error:
        return {
            "background": NOTICE_ERROR_BG,
            "border": NOTICE_ERROR_BORDER,
            "title": ERROR,
            "text": TEXT,
        }
    return {
        "background": NOTICE_INFO_BG,
        "border": NOTICE_INFO_BORDER,
        "title": ACCENT,
        "text": TEXT,
    }
