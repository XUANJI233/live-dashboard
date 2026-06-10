"""Shared tkinter UI theme values for the Windows agent."""

from __future__ import annotations


BG = "#F5F5F7"
SURFACE = "#FFFFFF"
SURFACE_MUTED = "#F2F2F7"
BORDER = "#E5E5EA"
TEXT = "#1D1D1F"
MUTED = "#6E6E73"
ACCENT = "#007AFF"
SUCCESS = "#346538"
WARNING = "#956400"
ERROR = "#9F2F2D"

BUTTON_BG = "#ECECF0"
BUTTON_ACTIVE_BG = "#E0E0E5"
PRIMARY_BG = "#1D1D1F"
PRIMARY_ACTIVE_BG = "#333336"

NOTICE_INFO_BG = "#EAF4FF"
NOTICE_ERROR_BG = "#FDEBEC"
NOTICE_INFO_BORDER = "#B9DCFF"
NOTICE_ERROR_BORDER = "#F2C9CB"
TONE_NEUTRAL_BG = SURFACE_MUTED
TONE_GOOD_BG = "#EAF7EE"
TONE_WARN_BG = "#FFF4E5"
TONE_BAD_BG = NOTICE_ERROR_BG
TONE_INFO_BG = NOTICE_INFO_BG

TONE_NEUTRAL_TEXT = MUTED
TONE_GOOD_TEXT = SUCCESS
TONE_WARN_TEXT = WARNING
TONE_BAD_TEXT = ERROR
TONE_INFO_TEXT = ACCENT


def status_color(status: str) -> str:
    """Return a semantic text color for a runtime status label."""
    if "错误" in status:
        return ERROR
    if status == "AFK":
        return WARNING
    if status == "在线":
        return SUCCESS
    return TEXT


def status_tone(status: str) -> str:
    """Return a semantic tone key for status pills."""
    if "错误" in status:
        return "bad"
    if status == "AFK":
        return "warn"
    if status == "在线":
        return "good"
    return "neutral"


def tone_palette(tone: str = "neutral") -> dict[str, str]:
    """Return surface/text colors for compact status blocks and pills."""
    palettes = {
        "good": {"background": TONE_GOOD_BG, "text": TONE_GOOD_TEXT},
        "warn": {"background": TONE_WARN_BG, "text": TONE_WARN_TEXT},
        "bad": {"background": TONE_BAD_BG, "text": TONE_BAD_TEXT},
        "info": {"background": TONE_INFO_BG, "text": TONE_INFO_TEXT},
        "neutral": {"background": TONE_NEUTRAL_BG, "text": TONE_NEUTRAL_TEXT},
    }
    return palettes.get(tone, palettes["neutral"])


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
