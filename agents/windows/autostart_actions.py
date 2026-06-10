"""User-facing autostart actions shared by tray and tkinter UI."""

from __future__ import annotations

from dataclasses import dataclass

from win_control import is_autostart_enabled, remove_legacy_startup_task, set_registry_autostart


@dataclass(frozen=True)
class AutostartResult:
    """Result of applying an autostart change."""

    enabled: bool
    ok: bool
    message: str


def toggle_autostart() -> AutostartResult:
    """Toggle current-user autostart and return a user-visible result."""
    return set_autostart_enabled(not is_autostart_enabled())


def set_autostart_enabled(enabled: bool) -> AutostartResult:
    """Enable or disable login autostart through the shared Windows helpers."""
    if enabled:
        legacy_ok = remove_legacy_startup_task()
        registry_ok = set_registry_autostart(True)
        ok = legacy_ok and registry_ok
        if ok:
            message = "开机自启动已开启。"
        elif registry_ok:
            message = "开机自启动已开启，但旧任务计划启动项未能清理，请检查任务计划程序。"
        else:
            message = "无法开启开机自启动，请检查当前账户是否有写入启动项的权限。"
    else:
        registry_ok = set_registry_autostart(False)
        legacy_ok = remove_legacy_startup_task()
        ok = registry_ok and legacy_ok
        message = "开机自启动已关闭。" if ok else "关闭开机自启时未能清理全部启动项，请检查任务计划程序。"

    return AutostartResult(
        enabled=is_autostart_enabled(),
        ok=ok,
        message=message,
    )
