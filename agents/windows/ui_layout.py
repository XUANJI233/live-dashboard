"""Responsive layout decisions for the Windows agent UI."""

from __future__ import annotations

from dataclasses import dataclass


TWO_COLUMN_MIN_WIDTH = 700


@dataclass(frozen=True)
class GridSlot:
    row: int
    column: int
    columnspan: int = 1
    padx: tuple[int, int] = (0, 0)
    pady: tuple[int, int] = (0, 0)


def use_two_columns(width: int) -> bool:
    """Return whether the content pane has enough room for two card columns."""
    return width >= TWO_COLUMN_MIN_WIDTH


def overview_slots(width: int) -> dict[str, GridSlot]:
    """Return card slots for the overview page."""
    if use_two_columns(width):
        return {
            "status": GridSlot(0, 0, padx=(0, 10), pady=(0, 12)),
            "config": GridSlot(0, 1, padx=(10, 0), pady=(0, 12)),
            "actions": GridSlot(1, 0, columnspan=2),
        }
    return {
        "status": GridSlot(0, 0, pady=(0, 12)),
        "config": GridSlot(1, 0, pady=(0, 12)),
        "actions": GridSlot(2, 0),
    }


def settings_slots(width: int) -> dict[str, GridSlot]:
    """Return card slots for the settings page."""
    if use_two_columns(width):
        return {
            "connection": GridSlot(0, 0, padx=(0, 10), pady=(0, 12)),
            "cadence": GridSlot(0, 1, padx=(10, 0), pady=(0, 12)),
            "local": GridSlot(1, 0, padx=(0, 10)),
            "actions": GridSlot(1, 1, padx=(10, 0)),
        }
    return {
        "connection": GridSlot(0, 0, pady=(0, 12)),
        "cadence": GridSlot(1, 0, pady=(0, 12)),
        "local": GridSlot(2, 0, pady=(0, 12)),
        "actions": GridSlot(3, 0),
    }


def text_wrap_width(content_width: int) -> int:
    """Return a stable wrap width for labels inside cards."""
    return max(260, min(720, content_width - 72))
