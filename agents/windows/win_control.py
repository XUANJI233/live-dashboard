"""Windows process, activation, and autostart helpers for the agent."""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import logging
from pathlib import Path
import subprocess
import sys
import threading
from typing import Callable

log = logging.getLogger("agent")

AUTOSTART_NAME = "LiveDashboardAgent"
AUTOSTART_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
ACTIVATION_EVENT_NAME = r"Local\LiveDashboardAgentOpenSettings"
SINGLE_INSTANCE_MUTEX_NAME = r"Local\LiveDashboardAgentSingleton"

ERROR_ALREADY_EXISTS = 183
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 0x102
INFINITE = 0xFFFFFFFF
EVENT_MODIFY_STATE = 0x0002
SYNCHRONIZE = 0x00100000
SW_RESTORE = 9
SW_SHOW = 5

kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
user32 = ctypes.windll.user32  # type: ignore[attr-defined]

CreateMutexW = kernel32.CreateMutexW
CreateMutexW.argtypes = [ctypes.wintypes.LPVOID, ctypes.wintypes.BOOL, ctypes.wintypes.LPCWSTR]
CreateMutexW.restype = ctypes.wintypes.HANDLE

CreateEventW = kernel32.CreateEventW
CreateEventW.argtypes = [
    ctypes.wintypes.LPVOID,
    ctypes.wintypes.BOOL,
    ctypes.wintypes.BOOL,
    ctypes.wintypes.LPCWSTR,
]
CreateEventW.restype = ctypes.wintypes.HANDLE

OpenEventW = kernel32.OpenEventW
OpenEventW.argtypes = [ctypes.wintypes.DWORD, ctypes.wintypes.BOOL, ctypes.wintypes.LPCWSTR]
OpenEventW.restype = ctypes.wintypes.HANDLE

SetEvent = kernel32.SetEvent
SetEvent.argtypes = [ctypes.wintypes.HANDLE]
SetEvent.restype = ctypes.wintypes.BOOL

WaitForSingleObject = kernel32.WaitForSingleObject
WaitForSingleObject.argtypes = [ctypes.wintypes.HANDLE, ctypes.wintypes.DWORD]
WaitForSingleObject.restype = ctypes.wintypes.DWORD

CloseHandle = kernel32.CloseHandle
CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
CloseHandle.restype = ctypes.wintypes.BOOL

GetLastError = kernel32.GetLastError
GetLastError.restype = ctypes.wintypes.DWORD

ShowWindow = user32.ShowWindow
ShowWindow.argtypes = [ctypes.wintypes.HWND, ctypes.c_int]
ShowWindow.restype = ctypes.wintypes.BOOL

SetForegroundWindow = user32.SetForegroundWindow
SetForegroundWindow.argtypes = [ctypes.wintypes.HWND]
SetForegroundWindow.restype = ctypes.wintypes.BOOL


def activate_window(hwnd: int | None) -> bool:
    """Restore and foreground a native window handle."""
    if not hwnd:
        return False
    try:
        ShowWindow(hwnd, SW_RESTORE)
        if not SetForegroundWindow(hwnd):
            ShowWindow(hwnd, SW_SHOW)
        return True
    except Exception as exc:
        log.debug("Window activation failed: %s", exc)
        return False


class SingleInstanceGuard:
    """Named mutex guard; secondary launches ask the primary to show settings."""

    def __init__(self, name: str = SINGLE_INSTANCE_MUTEX_NAME):
        self._handle = CreateMutexW(None, False, name)
        self.already_running = bool(self._handle and GetLastError() == ERROR_ALREADY_EXISTS)

    def notify_existing(self) -> bool:
        """Ask the already-running instance to show its main settings window."""
        handle = OpenEventW(EVENT_MODIFY_STATE, False, ACTIVATION_EVENT_NAME)
        if not handle:
            return False
        try:
            return bool(SetEvent(handle))
        finally:
            CloseHandle(handle)

    def close(self) -> None:
        if self._handle:
            CloseHandle(self._handle)
            self._handle = None


class ActivationEventServer:
    """Waits for secondary-launch activation events without blocking the tray."""

    def __init__(self, callback: Callable[[], None], name: str = ACTIVATION_EVENT_NAME):
        self._callback = callback
        self._handle = CreateEventW(None, False, False, name)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if not self._handle or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="activation-event", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None
        if self._handle:
            CloseHandle(self._handle)
            self._handle = None

    def _run(self) -> None:
        while not self._stop.is_set():
            result = WaitForSingleObject(self._handle, 1000)
            if result == WAIT_OBJECT_0:
                try:
                    self._callback()
                except Exception as exc:
                    log.debug("Activation callback failed: %s", exc)
            elif result != WAIT_TIMEOUT:
                log.debug("Activation wait returned %s", result)
                self._stop.wait(1)


def build_autostart_command() -> str:
    """Return the command line used for current-user login autostart."""
    if getattr(sys, "frozen", False):
        return subprocess.list2cmdline([str(Path(sys.executable).resolve())])
    return subprocess.list2cmdline([sys.executable, str(Path(__file__).with_name("agent.py").resolve())])


def _registry_command() -> str | None:
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, AUTOSTART_NAME)
    except FileNotFoundError:
        return None
    except OSError as exc:
        log.warning("Autostart registry query failed: %s", exc)
        return None
    return value if isinstance(value, str) and value.strip() else None


def has_registry_autostart() -> bool:
    """Return whether the current user Run key points at this agent."""
    value = _registry_command()
    return bool(value and value.strip().casefold() == build_autostart_command().casefold())


def set_registry_autostart(enabled: bool) -> bool:
    """Enable/disable login autostart through the current-user Run key."""
    try:
        import winreg

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, AUTOSTART_RUN_KEY) as key:
            if enabled:
                winreg.SetValueEx(key, AUTOSTART_NAME, 0, winreg.REG_SZ, build_autostart_command())
            else:
                try:
                    winreg.DeleteValue(key, AUTOSTART_NAME)
                except FileNotFoundError:
                    pass
        return True
    except OSError as exc:
        log.error("Autostart registry update failed: %s", exc)
        return False


def has_legacy_startup_task() -> bool:
    """Return whether the legacy Task Scheduler based autostart exists."""
    try:
        result = subprocess.run(
            ["schtasks", "/query", "/tn", AUTOSTART_NAME],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.debug("Autostart task query failed: %s", exc)
        return False
    return result.returncode == 0


def remove_legacy_startup_task() -> bool:
    """Remove the legacy scheduled task if it exists."""
    if not has_legacy_startup_task():
        return True
    try:
        result = subprocess.run(
            ["schtasks", "/delete", "/tn", AUTOSTART_NAME, "/f"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("Legacy startup task removal failed: %s", exc)
        return False
    if result.returncode == 0:
        return True
    output = (result.stderr or result.stdout).strip()
    if output:
        log.warning("Legacy startup task removal failed: %s", output)
    return False


def is_autostart_enabled() -> bool:
    """Return whether the current Run-key startup entry points at this agent."""
    return has_registry_autostart()
