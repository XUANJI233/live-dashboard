"""
Live Dashboard — Windows Agent
Monitors the foreground window and reports app usage to the dashboard backend.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import logging
import logging.handlers
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

import psutil
import requests

try:
    import websocket as _ws_lib
    HAS_WEBSOCKET = True
except ImportError:
    _ws_lib = None
    HAS_WEBSOCKET = False

if getattr(sys, "frozen", False):
    base_dir = Path(sys.executable).parent
else:
    base_dir = Path(__file__).parent

# ---------------------------------------------------------------------------
# Logging — console always; file handler toggleable (2-day rotation)
# ---------------------------------------------------------------------------
LOG_FILE = base_dir / "agent.log"
_file_handler: logging.Handler | None = None

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler()],
)
log = logging.getLogger("agent")


def set_file_logging(enabled: bool) -> None:
    """Toggle file logging with 2-day rotation."""
    global _file_handler
    if enabled and _file_handler is None:
        _file_handler = logging.handlers.TimedRotatingFileHandler(
            LOG_FILE, when="midnight", backupCount=1, encoding="utf-8",
        )
        _file_handler.setFormatter(
            logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
        )
        logging.getLogger().addHandler(_file_handler)
    elif not enabled and _file_handler is not None:
        logging.getLogger().removeHandler(_file_handler)
        _file_handler.close()
        _file_handler = None


# ---------------------------------------------------------------------------
# Win32 API bindings
# ---------------------------------------------------------------------------
user32 = ctypes.windll.user32  # type: ignore[attr-defined]
kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]

ERROR_ALREADY_EXISTS = 183
EVENT_MODIFY_STATE = 0x0002
WAIT_OBJECT_0 = 0x00000000
WAIT_TIMEOUT = 0x00000102
WAIT_FAILED = 0xFFFFFFFF

GetForegroundWindow = user32.GetForegroundWindow
GetForegroundWindow.restype = ctypes.wintypes.HWND

GetWindowTextW = user32.GetWindowTextW
GetWindowTextW.argtypes = [ctypes.wintypes.HWND, ctypes.wintypes.LPWSTR, ctypes.c_int]
GetWindowTextW.restype = ctypes.c_int

GetWindowTextLengthW = user32.GetWindowTextLengthW
GetWindowTextLengthW.argtypes = [ctypes.wintypes.HWND]
GetWindowTextLengthW.restype = ctypes.c_int

GetWindowThreadProcessId = user32.GetWindowThreadProcessId
GetWindowThreadProcessId.argtypes = [ctypes.wintypes.HWND, ctypes.POINTER(ctypes.wintypes.DWORD)]
GetWindowThreadProcessId.restype = ctypes.wintypes.DWORD


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.wintypes.UINT),
        ("dwTime", ctypes.wintypes.DWORD),
    ]


GetLastInputInfo = user32.GetLastInputInfo
GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
GetLastInputInfo.restype = ctypes.wintypes.BOOL

GetTickCount = kernel32.GetTickCount
GetTickCount.restype = ctypes.wintypes.DWORD

GetLastError = kernel32.GetLastError
GetLastError.restype = ctypes.wintypes.DWORD

CreateMutexW = kernel32.CreateMutexW
CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.wintypes.BOOL, ctypes.wintypes.LPCWSTR]
CreateMutexW.restype = ctypes.wintypes.HANDLE

CreateEventW = kernel32.CreateEventW
CreateEventW.argtypes = [ctypes.c_void_p, ctypes.wintypes.BOOL, ctypes.wintypes.BOOL, ctypes.wintypes.LPCWSTR]
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


def get_idle_seconds() -> float:
    """Return seconds since last keyboard/mouse input."""
    lii = LASTINPUTINFO()
    lii.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not GetLastInputInfo(ctypes.byref(lii)):
        return 0.0
    now = GetTickCount()
    elapsed_ms = (now - lii.dwTime) & 0xFFFFFFFF
    return elapsed_ms / 1000.0


def is_audio_playing() -> bool:
    """Check if any audio session is currently active (media playing)."""
    try:
        from pycaw.pycaw import AudioUtilities
        sessions = AudioUtilities.GetAllSessions()
        for session in sessions:
            if session.Process and session.State == 1:
                return True
    except Exception:
        pass
    return False


def is_foreground_fullscreen() -> bool:
    """Check if the foreground window is fullscreen."""
    try:
        hwnd = GetForegroundWindow()
        if not hwnd:
            return False
        rect = ctypes.wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return False
        w = user32.GetSystemMetrics(0)
        h = user32.GetSystemMetrics(1)
        return (rect.left <= 0 and rect.top <= 0
                and rect.right >= w and rect.bottom >= h)
    except Exception:
        return False


def get_foreground_info() -> tuple[str, str] | None:
    """Return (process_name, window_title) of the current foreground window."""
    hwnd = GetForegroundWindow()
    if not hwnd:
        return None
    length = GetWindowTextLengthW(hwnd)
    if length <= 0:
        return None
    buf = ctypes.create_unicode_buffer(length + 1)
    GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value.strip()
    if not title:
        return None
    pid = ctypes.wintypes.DWORD()
    GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    try:
        proc = psutil.Process(pid.value)
        proc_name = proc.name()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        proc_name = "unknown"
    return proc_name, title


# ---------------------------------------------------------------------------
# Music detection — scan ALL windows (not just foreground)
# ---------------------------------------------------------------------------
WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.wintypes.BOOL, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)

EnumWindows = user32.EnumWindows
EnumWindows.argtypes = [WNDENUMPROC, ctypes.wintypes.LPARAM]
EnumWindows.restype = ctypes.wintypes.BOOL

IsWindowVisible = user32.IsWindowVisible
IsWindowVisible.argtypes = [ctypes.wintypes.HWND]
IsWindowVisible.restype = ctypes.wintypes.BOOL

_MUSIC_PROCESS_MAP: dict[str, str] = {
    "spotify.exe": "Spotify",
    "qqmusic.exe": "QQ音乐",
    "cloudmusic.exe": "网易云音乐",
    "foobar2000.exe": "foobar2000",
    "itunes.exe": "Apple Music",
    "applemusic.exe": "Apple Music",
    "kugou.exe": "酷狗音乐",
    "kwmusic.exe": "酷我音乐",
    "aimp.exe": "AIMP",
    "musicbee.exe": "MusicBee",
    "vlc.exe": "VLC",
    "potplayer.exe": "PotPlayer",
    "potplayer64.exe": "PotPlayer",
    "potplayermini.exe": "PotPlayer",
    "potplayermini64.exe": "PotPlayer",
    "wmplayer.exe": "Windows Media Player",
}


def _parse_spotify_title(title: str) -> tuple[str, str] | None:
    if title in ("Spotify", "Spotify Free", "Spotify Premium"):
        return None
    if " - " in title:
        artist, song = title.split(" - ", 1)
        return song.strip(), artist.strip()
    return title, ""


def _parse_dash_title(title: str, app_suffix: str = "") -> tuple[str, str] | None:
    if app_suffix and title.rstrip() == app_suffix:
        return None
    if " - " in title:
        song, artist = title.split(" - ", 1)
        return song.strip(), artist.strip()
    return title, ""


def _parse_foobar_title(title: str) -> tuple[str, str] | None:
    import re
    cleaned = re.sub(r"\s*\[foobar2000[^\]]*\]\s*$", "", title)
    if not cleaned or cleaned == title:
        if " - " in title:
            parts = title.split(" - ", 1)
            return parts[1].strip(), parts[0].strip()
        return title, ""
    if " - " in cleaned:
        artist, song = cleaned.split(" - ", 1)
        return song.strip(), artist.strip()
    return cleaned, ""


def get_music_info() -> dict | None:
    """Scan all windows to find a known music player and extract now-playing info."""
    results: list[tuple[str, str, str]] = []

    def enum_callback(hwnd: int, _lParam: int) -> bool:
        if not IsWindowVisible(hwnd):
            return True
        length = GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        GetWindowTextW(hwnd, buf, length + 1)
        win_title = buf.value.strip()
        if not win_title:
            return True
        pid = ctypes.wintypes.DWORD()
        GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        try:
            proc = psutil.Process(pid.value)
            proc_lower = proc.name().lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return True
        if proc_lower not in _MUSIC_PROCESS_MAP:
            return True
        app_name = _MUSIC_PROCESS_MAP[proc_lower]
        parsed = None
        if proc_lower == "spotify.exe":
            parsed = _parse_spotify_title(win_title)
        elif proc_lower == "foobar2000.exe":
            parsed = _parse_foobar_title(win_title)
        else:
            parsed = _parse_dash_title(win_title)
        if parsed:
            song, artist = parsed
            results.append((app_name, song, artist))
        return True

    try:
        EnumWindows(WNDENUMPROC(enum_callback), 0)
    except Exception:
        return None

    if not results:
        return None
    app, title, artist = results[0]
    info: dict[str, str] = {"app": app}
    if title:
        info["title"] = title[:256]
    if artist:
        info["artist"] = artist[:256]
    return info


def get_battery_extra() -> dict:
    """Return battery info dict, or empty dict if no battery."""
    try:
        battery = psutil.sensors_battery()
        if battery is None:
            return {}
        return {
            "battery_percent": int(battery.percent),
            "battery_charging": bool(battery.power_plugged),
        }
    except Exception:
        return {}


def format_report_target(app_id: str, window_title: str) -> str:
    """Return a shared display string for tray current item and report logs."""
    app = (app_id or "").strip() or "unknown"
    title = (window_title or "").strip()
    if not title or title == app:
        return app
    return f"{app} — {title[:80]}"


# ---------------------------------------------------------------------------
# Config — stored next to the exe for easy cleanup
# ---------------------------------------------------------------------------
CONFIG_PATH = base_dir / "config.json"

_DEFAULT_CFG = {
    "server_url": "",
    "token": "",
    "interval_seconds": 5,
    "heartbeat_seconds": 60,
    "idle_threshold_seconds": 300,
    "enable_log": False,
}


def load_config() -> dict:
    """Load config.json, return config dict (may be empty on error)."""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        return dict(_DEFAULT_CFG)
    except (PermissionError, json.JSONDecodeError) as e:
        log.error("config.json: %s", e)
        return dict(_DEFAULT_CFG)

    if not isinstance(cfg, dict):
        return dict(_DEFAULT_CFG)

    for key in ("server_url", "token"):
        value = cfg.get(key, _DEFAULT_CFG[key])
        cfg[key] = value.strip() if isinstance(value, str) else _DEFAULT_CFG[key]

    enable_log = cfg.get("enable_log", _DEFAULT_CFG["enable_log"])
    cfg["enable_log"] = enable_log if isinstance(enable_log, bool) else _DEFAULT_CFG["enable_log"]

    for key, default, lo, hi in [
        ("interval_seconds", 5, 1, 300),
        ("heartbeat_seconds", 60, 10, 600),
        ("idle_threshold_seconds", 300, 30, 3600),
    ]:
        val = cfg.get(key, default)
        if not isinstance(val, (int, float)) or val < lo or val > hi:
            val = default
        cfg[key] = int(val)

    return cfg


def save_config(cfg: dict) -> bool:
    """Save config to config.json atomically with restricted permissions."""
    import tempfile
    try:
        data = json.dumps(cfg, indent=2, ensure_ascii=False).encode("utf-8")
        fd = tempfile.NamedTemporaryFile(
            dir=CONFIG_PATH.parent, prefix=".config_", suffix=".tmp",
            delete=False,
        )
        tmp_path = Path(fd.name)
        try:
            fd.write(data)
            fd.flush()
            os.fsync(fd.fileno())
            fd.close()
            os.chmod(tmp_path, 0o600)
            tmp_path.replace(CONFIG_PATH)
        except BaseException:
            fd.close()
            tmp_path.unlink(missing_ok=True)
            raise
        return True
    except Exception as e:
        log.error("Config save failed: %s", e)
        return False


def validate_config(cfg: dict) -> str | None:
    """Validate config. Return error message or None if valid."""
    url = cfg.get("server_url", "").strip()
    token = cfg.get("token", "").strip()
    if not url:
        return "服务器地址不能为空"
    if not token or token == "YOUR_TOKEN_HERE":
        return "Token 不能为空"

    parsed = urllib.parse.urlparse(url)
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname
    if scheme not in ("http", "https"):
        return "服务器地址必须使用 http:// 或 https://"
    if not hostname:
        return "服务器地址无效"

    if scheme == "http":
        try:
            addrinfos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        except socket.gaierror:
            return f"无法解析域名: {hostname}"
        for info in addrinfos:
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_global:
                return "HTTP 仅允许内网地址, 公网请使用 HTTPS"

    return None


# ---------------------------------------------------------------------------
# Windows autostart
# ---------------------------------------------------------------------------
AUTOSTART_NAME = "LiveDashboardAgent"
AUTOSTART_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def _get_autostart_command() -> str:
    """Return the command line used for login autostart."""
    if getattr(sys, "frozen", False):
        return subprocess.list2cmdline([str(Path(sys.executable).resolve())])
    return subprocess.list2cmdline([sys.executable, str(Path(__file__).resolve())])


def _has_registry_autostart() -> bool:
    """Return whether the current user has a Run-key startup entry."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, AUTOSTART_NAME)
    except FileNotFoundError:
        return False
    except OSError as e:
        log.warning("Autostart registry query failed: %s", e)
        return False
    return isinstance(value, str) and bool(value.strip())


def _set_registry_autostart(enabled: bool) -> bool:
    """Enable/disable login autostart through the current-user Run key."""
    try:
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, AUTOSTART_RUN_KEY) as key:
            if enabled:
                winreg.SetValueEx(
                    key, AUTOSTART_NAME, 0, winreg.REG_SZ, _get_autostart_command()
                )
            else:
                try:
                    winreg.DeleteValue(key, AUTOSTART_NAME)
                except FileNotFoundError:
                    pass
        return True
    except OSError as e:
        log.error("Autostart registry update failed: %s", e)
        return False


def _has_legacy_startup_task() -> bool:
    """Return whether the legacy scheduled task based autostart exists."""
    try:
        result = subprocess.run(
            ["schtasks", "/query", "/tn", AUTOSTART_NAME],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError) as e:
        log.debug("Autostart task query failed: %s", e)
        return False
    return result.returncode == 0


def _remove_legacy_startup_task() -> bool:
    """Remove the legacy scheduled task if it exists."""
    if not _has_legacy_startup_task():
        return True
    try:
        result = subprocess.run(
            ["schtasks", "/delete", "/tn", AUTOSTART_NAME, "/f"],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("Legacy startup task removal failed: %s", e)
        return False
    if result.returncode == 0:
        return True
    output = (result.stderr or result.stdout).strip()
    if output:
        log.warning("Legacy startup task removal failed: %s", output)
    return False


def is_autostart_enabled() -> bool:
    """Return whether the agent is configured to launch at Windows logon."""
    return _has_registry_autostart() or _has_legacy_startup_task()


def show_message(title: str, message: str, error: bool = False) -> None:
    """Show a best-effort native message box for user-facing actions."""
    try:
        flags = 0x10 if error else 0x40
        ctypes.windll.user32.MessageBoxW(None, message, title, flags)  # type: ignore[attr-defined]
    except Exception:
        log.info("%s: %s", title, message)


# ---------------------------------------------------------------------------
# Settings Dialog
# ---------------------------------------------------------------------------
def show_settings_dialog(current_config: dict | None = None) -> dict | None:
    """Show tkinter settings dialog. Returns new config or None if cancelled."""
    try:
        import tkinter as tk
        from tkinter import ttk, messagebox
    except ImportError:
        log.error("tkinter 不可用, 请手动编辑 %s", CONFIG_PATH)
        return None

    cfg = current_config or dict(_DEFAULT_CFG)
    result: list[dict | None] = [None]

    root = tk.Tk()
    root.title("Live Dashboard - 设置")
    root.resizable(False, False)

    frame = ttk.Frame(root, padding=20)
    frame.pack(fill="both", expand=True)

    ttk.Label(frame, text="服务器地址:").grid(row=0, column=0, sticky="w", pady=6)
    url_var = tk.StringVar(value=cfg.get("server_url", ""))
    ttk.Entry(frame, textvariable=url_var, width=45).grid(row=0, column=1, pady=6, padx=(8, 0))

    ttk.Label(frame, text="Token:").grid(row=1, column=0, sticky="w", pady=6)
    token_var = tk.StringVar(value=cfg.get("token", ""))
    ttk.Entry(frame, textvariable=token_var, width=45, show="*").grid(row=1, column=1, pady=6, padx=(8, 0))

    ttk.Label(frame, text="上报间隔 (秒):").grid(row=2, column=0, sticky="w", pady=6)
    interval_var = tk.IntVar(value=cfg.get("interval_seconds", 5))
    ttk.Spinbox(frame, textvariable=interval_var, from_=1, to=300, width=10).grid(row=2, column=1, sticky="w", pady=6, padx=(8, 0))

    ttk.Label(frame, text="心跳间隔 (秒):").grid(row=3, column=0, sticky="w", pady=6)
    heartbeat_var = tk.IntVar(value=cfg.get("heartbeat_seconds", 60))
    ttk.Spinbox(frame, textvariable=heartbeat_var, from_=10, to=600, width=10).grid(row=3, column=1, sticky="w", pady=6, padx=(8, 0))

    ttk.Label(frame, text="AFK 判定 (秒):").grid(row=4, column=0, sticky="w", pady=6)
    idle_var = tk.IntVar(value=cfg.get("idle_threshold_seconds", 300))
    ttk.Spinbox(frame, textvariable=idle_var, from_=30, to=3600, width=10).grid(row=4, column=1, sticky="w", pady=6, padx=(8, 0))

    log_var = tk.BooleanVar(value=cfg.get("enable_log", False))
    ttk.Checkbutton(frame, text="开启日志文件 (保留 2 天)", variable=log_var).grid(
        row=5, column=0, columnspan=2, sticky="w", pady=6
    )

    def on_save():
        new_cfg = {
            "server_url": url_var.get().strip(),
            "token": token_var.get().strip(),
            "interval_seconds": interval_var.get(),
            "heartbeat_seconds": heartbeat_var.get(),
            "idle_threshold_seconds": idle_var.get(),
            "enable_log": log_var.get(),
        }
        err = validate_config(new_cfg)
        if err:
            messagebox.showerror("配置错误", err, parent=root)
            return
        if save_config(new_cfg):
            result[0] = new_cfg
            root.destroy()
        else:
            messagebox.showerror("保存失败", "无法写入 config.json", parent=root)

    btn_frame = ttk.Frame(frame)
    btn_frame.grid(row=6, column=0, columnspan=2, pady=16)
    ttk.Button(btn_frame, text="保存", command=on_save).pack(side="left", padx=12)
    ttk.Button(btn_frame, text="取消", command=root.destroy).pack(side="left", padx=12)

    # Center on screen
    root.update_idletasks()
    w, h = root.winfo_reqwidth(), root.winfo_reqheight()
    x = (root.winfo_screenwidth() - w) // 2
    y = (root.winfo_screenheight() - h) // 2
    root.geometry(f"+{x}+{y}")
    root.deiconify()
    root.lift()
    root.focus_set()

    root.mainloop()
    return result[0]


def open_settings_in_subprocess() -> bool:
    """Open settings dialog in a separate process and return True when saved."""
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, "--settings-dialog"]
    else:
        cmd = [sys.executable, str(Path(__file__).resolve()), "--settings-dialog"]
    try:
        result = subprocess.run(
            cmd,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return result.returncode == 0
    except Exception as e:
        log.error("Failed to open settings subprocess: %s", e)
        return False


# ---------------------------------------------------------------------------
# Single-instance control — second launch opens settings in the running agent
# ---------------------------------------------------------------------------
def _control_suffix() -> str:
    raw = str(base_dir.resolve()).lower().encode("utf-8", "ignore")
    return hashlib.sha256(raw).hexdigest()[:16]


CONTROL_SUFFIX = _control_suffix()
MUTEX_NAME = f"Local\\LiveDashboardAgent-{CONTROL_SUFFIX}"
SHOW_SETTINGS_EVENT_NAME = f"Local\\LiveDashboardAgentShowSettings-{CONTROL_SUFFIX}"


def signal_existing_instance() -> bool:
    """Ask an already-running agent from the same install dir to open settings."""
    handle = OpenEventW(EVENT_MODIFY_STATE, False, SHOW_SETTINGS_EVENT_NAME)
    if not handle:
        return False
    try:
        return bool(SetEvent(handle))
    finally:
        CloseHandle(handle)


class SingleInstanceControl:
    """Own the process mutex and listen for second-launch settings requests."""

    def __init__(self, on_show_settings):
        self._on_show_settings = on_show_settings
        self._mutex = CreateMutexW(None, False, MUTEX_NAME)
        self.already_running = GetLastError() == ERROR_ALREADY_EXISTS
        self._event = None
        self._thread: threading.Thread | None = None
        self._closed = threading.Event()
        if not self.already_running:
            self._event = CreateEventW(None, False, False, SHOW_SETTINGS_EVENT_NAME)
            if not self._event:
                log.warning("Control event create failed: %s", GetLastError())

    def start(self) -> None:
        if self.already_running or not self._event:
            return
        self._thread = threading.Thread(
            target=self._listen,
            daemon=True,
            name="single-instance-control",
        )
        self._thread.start()

    def _listen(self) -> None:
        assert self._event is not None
        while not self._closed.is_set():
            rc = WaitForSingleObject(self._event, 1000)
            if rc == WAIT_OBJECT_0:
                if self._closed.is_set():
                    break
                try:
                    self._on_show_settings()
                except Exception as exc:
                    log.warning("Open-settings signal failed: %s", exc)
            elif rc == WAIT_TIMEOUT:
                continue
            elif rc == WAIT_FAILED:
                log.warning("Control event wait failed: %s", GetLastError())
                break

    def close(self) -> None:
        self._closed.set()
        if self._event:
            SetEvent(self._event)
        if self._thread:
            self._thread.join(timeout=1)
        if self._event:
            CloseHandle(self._event)
            self._event = None
        if self._mutex:
            CloseHandle(self._mutex)
            self._mutex = None


# ---------------------------------------------------------------------------
# Reporter
# ---------------------------------------------------------------------------
class Reporter:
    """Handles sending reports to the backend with exponential backoff."""

    MAX_BACKOFF = 60
    PAUSE_AFTER_FAILURES = 5
    PAUSE_DURATION = 300

    def __init__(self, server_url: str, token: str):
        self.endpoint = server_url.rstrip("/") + "/api/report"
        self.token = token
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        })
        self._consecutive_failures = 0
        self._current_backoff = 0
        self._pause_until = 0.0

    def send(self, app_id: str, window_title: str, extra: dict | None = None) -> bool:
        if self.pause_remaining > 0:
            return False

        payload = {
            "app_id": app_id,
            "window_title": window_title[:256],
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }
        if extra:
            payload["extra"] = extra
        try:
            resp = self.session.post(self.endpoint, json=payload, timeout=10)
            if resp.status_code in (200, 201, 409):
                self._consecutive_failures = 0
                self._current_backoff = 0
                self._pause_until = 0.0
                return True
            log.warning("Server %d: %s", resp.status_code, resp.text[:200])
        except requests.RequestException as e:
            log.warning("Request failed: %s", e)

        self._consecutive_failures += 1
        if self._current_backoff == 0:
            self._current_backoff = 5
        else:
            self._current_backoff = min(self._current_backoff * 2, self.MAX_BACKOFF)

        if self._consecutive_failures >= self.PAUSE_AFTER_FAILURES:
            log.warning("Failed %d times, pausing %ds", self._consecutive_failures, self.PAUSE_DURATION)
            self._pause_until = time.monotonic() + self.PAUSE_DURATION
            self._consecutive_failures = 0
            self._current_backoff = 0
        return False

    @property
    def backoff(self) -> float:
        return self._current_backoff

    @property
    def pause_remaining(self) -> float:
        remaining = self._pause_until - time.monotonic()
        if remaining <= 0:
            self._pause_until = 0.0
            return 0.0
        return remaining

    @property
    def retry_delay(self) -> float:
        return self.pause_remaining or self.backoff


# ---------------------------------------------------------------------------
# WebSocket Client — real-time bidirectional communication
# ---------------------------------------------------------------------------
class WsClient:
    """WebSocket device client with auto-reconnect."""

    INITIAL_BACKOFF = 2
    MAX_BACKOFF = 60

    def __init__(self, server_url: str, token: str, on_viewer_message=None):
        self._server_url = server_url.rstrip("/")
        self._token = token
        self._on_viewer_message = on_viewer_message
        self._ws = None
        self._stop = False
        self._connected = False
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._backoff = self.INITIAL_BACKOFF

    # -- public API ----------------------------------------------------------

    def start(self):
        if not HAS_WEBSOCKET:
            log.warning("websocket-client 未安装, WebSocket 功能禁用")
            return
        self._stop = False
        self._thread = threading.Thread(target=self._run, daemon=True, name="ws-client")
        self._thread.start()

    def stop(self):
        self._stop = True
        ws = self._ws
        if ws:
            try:
                ws.close()
            except Exception:
                pass

    @property
    def connected(self) -> bool:
        return self._connected

    def send_status(self, payload: dict) -> bool:
        """Send device_status frame. Returns True if sent."""
        return self._send({"type": "device_status", "payload": payload})

    def send_reply(self, target_viewer_id: str, text: str,
                   message_id: str | None = None) -> bool:
        """Send device_reply frame. Returns True if sent."""
        frame: dict = {
            "type": "device_reply",
            "target_viewer_id": target_viewer_id,
            "text": text,
        }
        if message_id:
            frame["message_id"] = message_id
        return self._send(frame)

    # -- internals -----------------------------------------------------------

    def _build_ws_url(self) -> str:
        u = self._server_url
        if u.startswith("https://"):
            u = "wss://" + u[8:]
        elif u.startswith("http://"):
            u = "ws://" + u[7:]
        elif not u.startswith("ws"):
            u = "wss://" + u
        return u + "/api/ws?role=device"

    def _send(self, frame: dict) -> bool:
        with self._lock:
            ws = self._ws
            if not ws or not self._connected:
                return False
            try:
                ws.send(json.dumps(frame, ensure_ascii=False))
                return True
            except Exception:
                return False

    def _run(self):
        while not self._stop:
            try:
                url = self._build_ws_url()
                self._ws = _ws_lib.WebSocketApp(
                    url,
                    header={"Authorization": f"Bearer {self._token}"},
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                self._ws.run_forever(ping_interval=25, ping_timeout=35)
            except Exception as exc:
                log.debug("WS run_forever 异常: %s", exc)
            if self._stop:
                break
            self._connected = False
            log.info("WebSocket 断开, %d 秒后重连...", self._backoff)
            time.sleep(self._backoff)
            self._backoff = min(self._backoff * 2, self.MAX_BACKOFF)

    def _on_open(self, ws):
        self._connected = True
        self._backoff = self.INITIAL_BACKOFF
        log.info("WebSocket 已连接")

    def _on_message(self, ws, raw):
        try:
            data = json.loads(raw)
        except Exception:
            return
        msg_type = data.get("type")
        if msg_type == "ack":
            log.info("WebSocket 握手确认: device_id=%s", data.get("device_id"))
        elif msg_type == "viewer_message" and self._on_viewer_message:
            self._on_viewer_message(data)

    def _on_error(self, ws, error):
        log.debug("WebSocket 错误: %s", error)

    def _on_close(self, ws, code, msg):
        self._connected = False
        log.debug("WebSocket 关闭: code=%s msg=%s", code, msg)


# ---------------------------------------------------------------------------
# Message Client — REST + WS messaging (留言)
# ---------------------------------------------------------------------------
class MessageClient:
    """REST + WebSocket messaging client with local cache."""

    MAX_CACHED = 30

    def __init__(self, server_url: str, token: str, ws_client: WsClient | None = None):
        self._server_url = server_url.rstrip("/")
        self._token = token
        self._ws = ws_client
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        })
        self._cache: list[dict] = []
        self._callbacks: list = []
        self._lock = threading.Lock()

    # -- callback registration -----------------------------------------------

    def on_message(self, cb):
        """Register callback fn(message_dict) for incoming messages."""
        self._callbacks.append(cb)

    def _notify(self, msg: dict):
        for cb in self._callbacks:
            try:
                cb(msg)
            except Exception as exc:
                log.debug("留言回调异常: %s", exc)

    # -- WS relay ------------------------------------------------------------

    def on_ws_message(self, data: dict):
        """Handle viewer_message from WS relay."""
        msg = {
            "message_id": data.get("message_id", ""),
            "viewer_id": data.get("viewer_id", ""),
            "viewer_name": data.get("viewer_name", ""),
            "kind": data.get("kind", "text"),
            "text": data.get("text", ""),
            "created_at": data.get("created_at", ""),
            "queued": data.get("queued", False),
        }
        with self._lock:
            # deduplicate by message_id
            if any(m.get("message_id") == msg["message_id"] for m in self._cache):
                return
            self._cache.insert(0, msg)
            self._cache = self._cache[:self.MAX_CACHED]
        self._notify(msg)

    # -- REST API ------------------------------------------------------------

    def fetch_pending(self) -> list[dict]:
        """GET /api/messages — fetch pending messages (server marks delivered)."""
        try:
            r = self._session.get(f"{self._server_url}/api/messages", timeout=10)
            if r.status_code != 200:
                return []
            msgs = r.json() if isinstance(r.json(), list) else []
        except Exception as exc:
            log.debug("获取待处理留言失败: %s", exc)
            return []
        with self._lock:
            existing_ids = {m.get("message_id") for m in self._cache}
            for m in msgs:
                mid = m.get("message_id", "")
                if mid and mid not in existing_ids:
                    self._cache.insert(0, m)
                    self._notify(m)
            self._cache = self._cache[:self.MAX_CACHED]
        return msgs

    def fetch_history(self, since: str = "") -> list[dict]:
        """GET /api/messages/history?since=ISO — up to 500 messages."""
        params = {}
        if since:
            params["since"] = since
        try:
            r = self._session.get(
                f"{self._server_url}/api/messages/history",
                params=params, timeout=15,
            )
            if r.status_code == 200:
                return r.json() if isinstance(r.json(), list) else []
        except Exception as exc:
            log.debug("获取留言历史失败: %s", exc)
        return []

    def reply(self, target_viewer_id: str, text: str,
              message_id: str | None = None) -> bool:
        """Send reply — WS first, then HTTP fallback."""
        body: dict = {"target_viewer_id": target_viewer_id, "text": text}
        if message_id:
            body["message_id"] = message_id
        # try WS
        if self._ws and self._ws.send_reply(target_viewer_id, text, message_id):
            return True
        # HTTP fallback
        try:
            r = self._session.post(
                f"{self._server_url}/api/messages/reply",
                json=body, timeout=10,
            )
            return r.status_code == 200
        except Exception as exc:
            log.debug("回复留言失败: %s", exc)
            return False

    def delete(self, message_id: str) -> bool:
        """POST /api/messages/delete — remove a message."""
        try:
            r = self._session.post(
                f"{self._server_url}/api/messages/delete",
                json={"message_id": message_id}, timeout=10,
            )
            if r.status_code == 200:
                with self._lock:
                    self._cache = [m for m in self._cache
                                   if m.get("message_id") != message_id]
                return True
        except Exception as exc:
            log.debug("删除留言失败: %s", exc)
        return False

    def delete_viewer(self, viewer_id: str) -> bool:
        """POST /api/messages/viewer/delete — remove all messages from a viewer."""
        try:
            r = self._session.post(
                f"{self._server_url}/api/messages/viewer/delete",
                json={"viewer_id": viewer_id}, timeout=10,
            )
            if r.status_code == 200:
                with self._lock:
                    self._cache = [m for m in self._cache
                                   if m.get("viewer_id") != viewer_id]
                return True
        except Exception as exc:
            log.debug("删除访客对话失败: %s", exc)
        return False

    def remark(self, viewer_id: str, remark: str) -> bool:
        """POST /api/messages/remark — set viewer remark."""
        try:
            r = self._session.post(
                f"{self._server_url}/api/messages/remark",
                json={"viewer_id": viewer_id, "remark": remark}, timeout=10,
            )
            return r.status_code == 200
        except Exception as exc:
            log.debug("设置备注失败: %s", exc)
            return False

    def block(self, viewer_id: str) -> bool:
        """POST /api/messages/block."""
        try:
            r = self._session.post(
                f"{self._server_url}/api/messages/block",
                json={"viewer_id": viewer_id}, timeout=10,
            )
            return r.status_code == 200
        except Exception as exc:
            log.debug("屏蔽失败: %s", exc)
            return False

    def unblock(self, viewer_id: str) -> bool:
        """POST /api/messages/unblock."""
        try:
            r = self._session.post(
                f"{self._server_url}/api/messages/unblock",
                json={"viewer_id": viewer_id}, timeout=10,
            )
            return r.status_code == 200
        except Exception as exc:
            log.debug("解除屏蔽失败: %s", exc)
            return False

    def get_recent(self, limit: int = 10) -> list[dict]:
        """Return cached recent messages."""
        with self._lock:
            return list(self._cache[:limit])


# ---------------------------------------------------------------------------
# System Tray
# ---------------------------------------------------------------------------
shutdown_event = threading.Event()


def _make_tray_icon(color: str = "green"):
    """Generate a colored circle icon for the system tray."""
    from PIL import Image, ImageDraw
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    colors = {"green": (76, 175, 80), "orange": (255, 152, 0), "gray": (158, 158, 158)}
    rgb = colors.get(color, colors["gray"])
    draw.ellipse([8, 8, size - 8, size - 8], fill=(*rgb, 255))
    return img


class TrayAgent:
    """System tray with Chinese UI, hover tooltip, and integrated settings."""

    def __init__(self):
        import pystray
        self._pystray = pystray
        self._lock = threading.Lock()
        self._status = "初始化中"
        self._current_target = ""
        self._icon: pystray.Icon | None = None
        self._settings_requested = False
        self._msg_client: MessageClient | None = None
        self._unread_count = 0
        self._icons = {
            "green": _make_tray_icon("green"),
            "orange": _make_tray_icon("orange"),
            "gray": _make_tray_icon("gray"),
        }

    def set_message_client(self, mc: MessageClient):
        self._msg_client = mc
        mc.on_message(self._on_new_message)

    def _on_new_message(self, msg: dict):
        with self._lock:
            self._unread_count += 1
        if self._icon:
            self._icon.update_menu()

    def _get_unread_label(self, _item=None) -> str:
        with self._lock:
            n = self._unread_count
        if n > 0:
            return f"查看留言 ({n})"
        return "查看留言"

    def _build_menu(self):
        p = self._pystray
        items = [
            p.MenuItem(lambda _: f"状态: {self._get_status()}", None, enabled=False),
            p.MenuItem(lambda _: f"当前: {self._get_current() or '无'}", None, enabled=False),
            p.Menu.SEPARATOR,
            p.MenuItem("日志文件", self._toggle_log,
                       checked=lambda _: _file_handler is not None),
            p.MenuItem("开机自启", self._toggle_autostart,
                       checked=lambda _: is_autostart_enabled()),
            p.MenuItem("设置", self._open_settings),
        ]
        if self._msg_client is not None:
            items.append(p.Menu.SEPARATOR)
            items.append(p.MenuItem(
                self._get_unread_label,
                self._show_messages,
            ))
        items.append(p.Menu.SEPARATOR)
        items.append(p.MenuItem("退出", self._quit))
        return p.Menu(*items)

    def _get_status(self) -> str:
        with self._lock:
            return self._status

    def _get_current(self) -> str:
        with self._lock:
            return self._current_target

    def update_status(self, status: str, current_target: str | None = None):
        with self._lock:
            self._status = status
            if current_target is not None:
                self._current_target = current_target
            current_target_value = self._current_target
        if self._icon:
            color = {"在线": "green", "AFK": "orange"}.get(status, "gray")
            self._icon.icon = self._icons[color]
            # Hover tooltip — shows current app + status
            tip = "Live Dashboard"
            if current_target_value:
                tip += f"\n当前: {current_target_value}"
            tip += f"\n{status}"
            self._icon.title = tip[:127]

    def _toggle_log(self, _icon=None, _item=None):
        enabled = _file_handler is None
        set_file_logging(enabled)
        cfg = load_config()
        cfg["enable_log"] = enabled
        save_config(cfg)
        if self._icon:
            self._icon.update_menu()

    def _toggle_autostart(self, _icon=None, _item=None):
        enabled = is_autostart_enabled()
        if enabled:
            registry_ok = _set_registry_autostart(False)
            legacy_ok = _remove_legacy_startup_task()
            if registry_ok and legacy_ok:
                log.info("Autostart disabled")
            else:
                show_message(
                    "Live Dashboard",
                    "关闭开机自启时未能清理全部启动项。\n请检查任务计划程序中的 LiveDashboardAgent。",
                    error=True,
                )
        else:
            if _set_registry_autostart(True):
                log.info("Autostart enabled")
            else:
                show_message(
                    "Live Dashboard",
                    "无法开启开机自启，请检查当前账户是否有写入启动项的权限。",
                    error=True,
                )
        if self._icon:
            self._icon.update_menu()

    def _open_settings(self, _icon=None, _item=None):
        self.request_settings()

    def request_settings(self) -> None:
        self._settings_requested = True
        shutdown_event.set()
        if self._icon:
            self._icon.stop()

    def _show_messages(self, _icon=None, _item=None):
        """Show recent messages in a dialog."""
        if not self._msg_client:
            return
        with self._lock:
            self._unread_count = 0
        msgs = self._msg_client.get_recent(10)
        if not msgs:
            show_message("Live Dashboard", "暂无留言")
            if self._icon:
                self._icon.update_menu()
            return
        lines = []
        for m in msgs:
            name = m.get("viewer_name", "未知")
            text = m.get("text", "")[:80]
            t = m.get("created_at", "")[:16]
            lines.append(f"[{t}] {name}: {text}")
        show_message("Live Dashboard — 最近留言", "\n".join(lines))
        if self._icon:
            self._icon.update_menu()

    def _quit(self, _icon=None, _item=None):
        shutdown_event.set()
        if self._icon:
            self._icon.stop()
        logging.shutdown()
        os._exit(0)

    @property
    def settings_requested(self) -> bool:
        return self._settings_requested

    def run(self):
        """Run the tray icon (blocking — call from main thread)."""
        if self._settings_requested:
            return
        icon_path = base_dir / "icon.ico"
        if icon_path.exists():
            from PIL import Image
            with Image.open(icon_path) as im:
                icon_img = im.copy()
        else:
            icon_img = _make_tray_icon("gray")
        self._icon = self._pystray.Icon(
            "live-dashboard",
            icon_img,
            "Live Dashboard",
            menu=self._build_menu(),
        )
        self._icon.run()


# ---------------------------------------------------------------------------
# Monitor loop
# ---------------------------------------------------------------------------
def _monitor_loop(cfg: dict, reporter: Reporter, tray: TrayAgent | None,
                  ws_client: WsClient | None = None,
                  msg_client: MessageClient | None = None) -> None:
    interval = cfg["interval_seconds"]
    heartbeat_interval = cfg["heartbeat_seconds"]
    idle_threshold = cfg["idle_threshold_seconds"]

    prev_app: str | None = None
    prev_title: str | None = None
    last_report_time: float = 0
    last_msg_fetch: float = 0
    MSG_FETCH_INTERVAL = 30  # seconds
    was_idle = False

    log.info(
        "Monitoring — interval=%ds, heartbeat=%ds, idle=%ds, ws=%s",
        interval, heartbeat_interval, idle_threshold,
        "enabled" if ws_client else "disabled",
    )

    def _send_report(app_id: str, title: str, extra: dict) -> bool:
        """Send report via WS first, then HTTP fallback."""
        if ws_client and ws_client.connected:
            payload = {
                "app_id": app_id,
                "window_title": title,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "extra": extra,
            }
            if ws_client.send_status(payload):
                return True
        return reporter.send(app_id, title, extra)

    while not shutdown_event.is_set():
        try:
            now = time.time()

            # Periodically fetch pending messages (REST)
            if msg_client and (now - last_msg_fetch) >= MSG_FETCH_INTERVAL:
                try:
                    msg_client.fetch_pending()
                except Exception as exc:
                    log.debug("fetch_pending 异常: %s", exc)
                last_msg_fetch = now

            idle_secs = get_idle_seconds()
            is_idle = (idle_secs >= idle_threshold
                       and not is_audio_playing()
                       and not is_foreground_fullscreen())

            if is_idle and not was_idle:
                log.info("User idle (%.0fs)", idle_secs)
                was_idle = True
                if tray:
                    tray.update_status("AFK")
            elif not is_idle and was_idle:
                log.info("User returned")
                was_idle = False

            if is_idle:
                heartbeat_due = (now - last_report_time) >= heartbeat_interval
                if heartbeat_due:
                    extra = get_battery_extra()
                    idle_target = format_report_target("idle", "User is away")
                    if _send_report("idle", "User is away", extra):
                        prev_app = "idle"
                        prev_title = "User is away"
                        last_report_time = now
                        if tray:
                            tray.update_status("AFK", idle_target)
                    elif reporter.retry_delay > 0:
                        shutdown_event.wait(reporter.retry_delay)
                        continue
                shutdown_event.wait(interval)
                continue

            info = get_foreground_info()
            if info is None:
                shutdown_event.wait(interval)
                continue

            app_id, title = info

            # Keep tray status responsive; current item is updated only after a successful report.
            if tray:
                tray.update_status("在线")

            changed = app_id != prev_app or title != prev_title
            heartbeat_due = (now - last_report_time) >= heartbeat_interval

            if changed or heartbeat_due:
                extra = get_battery_extra()
                music = get_music_info()
                if music:
                    extra["music"] = music
                reported_target = format_report_target(app_id, title)
                success = _send_report(app_id, title, extra)
                if success:
                    prev_app = app_id
                    prev_title = title
                    last_report_time = now
                    if tray:
                        tray.update_status("在线", reported_target)
                    if changed:
                        log.info("Reported: %s", reported_target)
                elif reporter.retry_delay > 0:
                    shutdown_event.wait(reporter.retry_delay)
                    continue

            shutdown_event.wait(interval)

        except Exception as e:
            log.error("Error: %s", e, exc_info=True)
            shutdown_event.wait(interval)

    log.info("Monitor stopped")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    log.info("Live Dashboard Windows Agent")

    if "--settings-dialog" in sys.argv:
        cfg = load_config()
        new_cfg = show_settings_dialog(cfg)
        raise SystemExit(0 if new_cfg is not None else 1)

    pending_settings_request = threading.Event()
    tray_ref: dict[str, TrayAgent | None] = {"tray": None}

    def request_settings_from_existing_instance() -> None:
        tray = tray_ref["tray"]
        if tray:
            tray.request_settings()
        else:
            pending_settings_request.set()

    control = SingleInstanceControl(request_settings_from_existing_instance)
    if control.already_running:
        if signal_existing_instance():
            log.info("Agent already running; requested settings window")
        else:
            show_message("Live Dashboard", "后台已经在运行，但无法唤起设置窗口。", error=True)
        control.close()
        return

    control.start()

    try:
        while True:
            cfg = load_config()

            # No valid config → show settings dialog
            if not cfg.get("server_url") or not cfg.get("token") or cfg.get("token") == "YOUR_TOKEN_HERE":
                if not open_settings_in_subprocess():
                    return
                cfg = load_config()

            err = validate_config(cfg)
            if err:
                log.warning("Invalid config: %s", err)
                if not open_settings_in_subprocess():
                    return
                cfg = load_config()
                continue

            # Apply log preference
            set_file_logging(cfg.get("enable_log", False))
            if cfg.get("enable_log"):
                log.info("HTTP: %s", "HTTPS" if cfg["server_url"].startswith("https") else "HTTP (内网)")

            reporter = Reporter(cfg["server_url"], cfg["token"])

            # Initialize WebSocket client
            ws_client: WsClient | None = None
            msg_client: MessageClient | None = None
            if HAS_WEBSOCKET:
                ws_client = WsClient(cfg["server_url"], cfg["token"])
                msg_client = MessageClient(cfg["server_url"], cfg["token"], ws_client)
                ws_client.start()
                log.info("WebSocket 客户端已启动")
            else:
                log.info("websocket-client 未安装, 仅使用 HTTP 上报")
                msg_client = MessageClient(cfg["server_url"], cfg["token"])

            tray: TrayAgent | None = None
            try:
                tray = TrayAgent()
                tray_ref["tray"] = tray
                if msg_client:
                    tray.set_message_client(msg_client)
            except ImportError:
                log.warning("pystray/Pillow not installed, running without tray")
            except Exception as e:
                log.warning("Tray init failed: %s", e)
                tray_ref["tray"] = None

            # Wire WS viewer_message → MessageClient
            if ws_client and msg_client:
                ws_client._on_viewer_message = msg_client.on_ws_message

            if tray:
                if pending_settings_request.is_set():
                    pending_settings_request.clear()
                    tray.request_settings()
                monitor = threading.Thread(
                    target=_monitor_loop,
                    args=(cfg, reporter, tray, ws_client, msg_client),
                    daemon=True,
                )
                monitor.start()
                tray.run()  # Blocks until quit or settings
                tray_ref["tray"] = None
                shutdown_event.set()
                monitor.join(timeout=5)
                if ws_client:
                    ws_client.stop()

                if tray.settings_requested:
                    shutdown_event.clear()
                    open_settings_in_subprocess()
                    continue  # Restart with new config
                else:
                    break  # Quit
            else:
                try:
                    _monitor_loop(cfg, reporter, None, ws_client, msg_client)
                except KeyboardInterrupt:
                    pass
                if ws_client:
                    ws_client.stop()
                break
    finally:
        control.close()

    log.info("Agent stopped")


if __name__ == "__main__":
    main()
