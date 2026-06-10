"""
Live Dashboard — Windows Agent
Monitors the foreground window and reports app usage to the dashboard backend.
"""

import ctypes
import ctypes.wintypes
from datetime import datetime, timezone
import ipaddress
import json
import logging
import logging.handlers
import os
import socket
import sys
import threading
import time
import urllib.parse
from pathlib import Path

import psutil
import requests

from device_commands import execute_desktop_command, extract_device_command, receipt_frame
from device_profile import with_device_capabilities
from probe_cache import TimedProbe
from ui_app import DashboardUiController
from win_control import (
    ActivationEventServer,
    SingleInstanceGuard,
    is_autostart_enabled,
    remove_legacy_startup_task,
    set_registry_autostart,
)

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


def show_message(title: str, message: str, error: bool = False) -> None:
    """Show a best-effort native message box for user-facing actions."""
    try:
        flags = 0x10 if error else 0x40
        ctypes.windll.user32.MessageBoxW(None, message, title, flags)  # type: ignore[attr-defined]
    except Exception:
        log.info("%s: %s", title, message)


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

    def close(self) -> None:
        """Release HTTP resources before runtime reload or shutdown."""
        self.session.close()


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
        self._stop_event = threading.Event()
        self._connected = False
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._backoff = self.INITIAL_BACKOFF

    # -- public API ----------------------------------------------------------

    def start(self):
        if not HAS_WEBSOCKET:
            log.warning("websocket-client 未安装, WebSocket 功能禁用")
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="ws-client")
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        ws = self._ws
        if ws:
            try:
                ws.close()
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        self._connected = False

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

    def send_device_command_ack(self, frame: dict) -> bool:
        """Send a device command receipt/result frame over WebSocket."""
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
        while not self._stop_event.is_set():
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
                self._ws.run_forever(ping_interval=30, ping_timeout=10)
            except Exception as exc:
                log.debug("WS run_forever 异常: %s", exc)
            if self._stop_event.is_set():
                break
            self._connected = False
            log.info("WebSocket 断开, %d 秒后重连...", self._backoff)
            self._stop_event.wait(self._backoff)
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
        elif msg_type == "device_command" and self._on_viewer_message:
            self._on_viewer_message(data)
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

    @staticmethod
    def _text(value, default: str = "") -> str:
        return value if isinstance(value, str) else default

    @classmethod
    def _normalize_message(cls, data: dict) -> dict | None:
        message_id = cls._text(data.get("message_id")) or cls._text(data.get("id"))
        if not message_id:
            return None
        msg = {
            "id": message_id,
            "message_id": message_id,
            "viewer_id": cls._text(data.get("viewer_id")),
            "viewer_name": cls._text(data.get("viewer_name")),
            "kind": cls._text(data.get("kind"), "text"),
            "text": cls._text(data.get("text")),
            "created_at": cls._text(data.get("created_at")),
            "queued": data.get("queued") is True,
        }
        payload = data.get("payload")
        if isinstance(payload, dict):
            msg["payload"] = payload
        return msg

    @classmethod
    def _messages_from_response(cls, parsed) -> list[dict]:
        if isinstance(parsed, list):
            raw_messages = parsed
        elif isinstance(parsed, dict) and isinstance(parsed.get("messages"), list):
            raw_messages = parsed["messages"]
        else:
            return []
        messages = []
        for item in raw_messages:
            if isinstance(item, dict):
                msg = cls._normalize_message(item)
                if msg:
                    messages.append(msg)
        return messages

    # -- WS relay ------------------------------------------------------------

    def on_ws_message(self, data: dict):
        """Handle viewer_message from WS relay."""
        if self.handle_device_command(data):
            return
        msg = self._normalize_message(data)
        if not msg:
            return
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
            parsed = r.json()
            msgs = self._messages_from_response(parsed)
        except Exception as exc:
            log.debug("获取待处理留言失败: %s", exc)
            return []
        plain_messages = []
        for m in msgs:
            if not self.handle_device_command(m):
                plain_messages.append(m)

        new_messages = []
        with self._lock:
            existing_ids = {m.get("message_id") for m in self._cache}
            for m in plain_messages:
                mid = m.get("message_id", "")
                if mid and mid not in existing_ids:
                    self._cache.insert(0, m)
                    new_messages.append(m)
            self._cache = self._cache[:self.MAX_CACHED]
        for m in new_messages:
            self._notify(m)
        return msgs

    def handle_device_command(self, message: object) -> bool:
        """Handle device_command envelopes from WS or queued message payloads."""
        envelope = extract_device_command(message)
        if not envelope:
            return False
        command_id = envelope.get("command_id")
        if not isinstance(command_id, str) or not command_id:
            return True

        self._send_command_ack(receipt_frame(envelope))
        result, synthetic_message = execute_desktop_command(envelope)
        notify_message = None
        if synthetic_message:
            with self._lock:
                if not any(m.get("message_id") == synthetic_message["message_id"] for m in self._cache):
                    self._cache.insert(0, synthetic_message)
                    self._cache = self._cache[:self.MAX_CACHED]
                    notify_message = synthetic_message
        if notify_message:
            self._notify(notify_message)
        self._send_command_ack(result)
        return True

    def _send_command_ack(self, frame: dict) -> bool:
        if self._ws and self._ws.send_device_command_ack(frame):
            return True
        try:
            r = self._session.post(
                f"{self._server_url}/api/supervision/ack",
                json=frame,
                timeout=10,
            )
            return r.status_code == 200
        except Exception as exc:
            log.debug("设备命令回执失败: %s", exc)
            return False

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
                return self._messages_from_response(r.json())
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
                                   if m.get("message_id") != message_id and m.get("id") != message_id]
                return True
        except Exception as exc:
            log.debug("删除留言失败: %s", exc)
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

    def close(self) -> None:
        """Release HTTP resources before runtime reload or shutdown."""
        self._session.close()


# ---------------------------------------------------------------------------
# System Tray
# ---------------------------------------------------------------------------
shutdown_event = threading.Event()
reload_event = threading.Event()


def control_wait(timeout: float) -> bool:
    """Wait until timeout, shutdown, or config reload. Returns True if interrupted."""
    deadline = time.monotonic() + max(0, timeout)
    while not shutdown_event.is_set() and not reload_event.is_set():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        shutdown_event.wait(min(remaining, 0.5))
    return True


def update_runtime_status(
    tray: "TrayAgent | None",
    ui: DashboardUiController | None,
    status: str,
    current_target: str | None = None,
) -> None:
    """Fan out runtime status updates to every visible UI surface."""
    if tray:
        tray.update_status(status, current_target)
    if ui:
        ui.update_status(status, current_target)


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
    """System tray with Chinese UI, hover tooltip, and integrated main window."""

    def __init__(self, ui_controller: DashboardUiController | None = None):
        import pystray
        self._pystray = pystray
        self._lock = threading.Lock()
        self._status = "初始化中"
        self._current_target = ""
        self._icon: pystray.Icon | None = None
        self._ui_controller = ui_controller
        self._msg_client: MessageClient | None = None
        self._unread_count = 0
        self._icons = {
            "green": _make_tray_icon("green"),
            "orange": _make_tray_icon("orange"),
            "gray": _make_tray_icon("gray"),
        }

    def set_message_client(self, mc: MessageClient):
        with self._lock:
            self._msg_client = mc
            self._unread_count = 0
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
            p.MenuItem("打开主界面", self._open_main, default=True),
            p.MenuItem(lambda _: f"状态: {self._get_status()}", None, enabled=False),
            p.MenuItem(lambda _: f"当前: {self._get_current() or '无'}", None, enabled=False),
            p.Menu.SEPARATOR,
            p.MenuItem("设置", self._open_settings),
            p.MenuItem("日志文件", self._toggle_log,
                       checked=lambda _: _file_handler is not None),
            p.MenuItem("开机自启", self._toggle_autostart,
                       checked=lambda _: is_autostart_enabled()),
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
            previous_status = self._status
            previous_target = self._current_target
            self._status = status
            if current_target is not None:
                self._current_target = current_target
            current_target_value = self._current_target
            changed = previous_status != self._status or previous_target != self._current_target
        if not changed:
            return
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
            registry_ok = set_registry_autostart(False)
            legacy_ok = remove_legacy_startup_task()
            if registry_ok and legacy_ok:
                log.info("Autostart disabled")
            else:
                self._notify_user(
                    "Live Dashboard",
                    "关闭开机自启时未能清理全部启动项。\n请检查任务计划程序中的 LiveDashboardAgent。",
                    error=True,
                )
        else:
            remove_legacy_startup_task()
            if set_registry_autostart(True):
                log.info("Autostart enabled")
            else:
                self._notify_user(
                    "Live Dashboard",
                    "无法开启开机自启，请检查当前账户是否有写入启动项的权限。",
                    error=True,
                )
        if self._icon:
            self._icon.update_menu()

    def _notify_user(self, title: str, message: str, error: bool = False) -> None:
        if self._ui_controller:
            self._ui_controller.show_notice(title, message, error)
        else:
            show_message(title, message, error)

    def _open_main(self, _icon=None, _item=None):
        if self._ui_controller:
            self._ui_controller.open("overview")

    def _open_settings(self, _icon=None, _item=None):
        if self._ui_controller:
            self._ui_controller.open("settings")

    def _show_messages(self, _icon=None, _item=None):
        """Show recent messages in a dialog."""
        if not self._msg_client:
            return
        with self._lock:
            self._unread_count = 0
        if self._ui_controller:
            self._ui_controller.open("messages")
        elif not self._msg_client.get_recent(10):
            show_message("Live Dashboard", "暂无留言")
        if self._icon:
            self._icon.update_menu()

    def _quit(self, _icon=None, _item=None):
        shutdown_event.set()
        if self._ui_controller:
            self._ui_controller.stop()
        if self._icon:
            self._icon.stop()

    def _create_icon(self):
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

    def run(self):
        """Run the tray icon, blocking until it is stopped."""
        self._create_icon()
        self._icon.run()

    def run_detached(self):
        """Run the tray icon without blocking the tkinter main loop."""
        self._create_icon()
        self._icon.run_detached()

    def stop(self):
        if self._icon:
            self._icon.stop()


# ---------------------------------------------------------------------------
# Monitor loop
# ---------------------------------------------------------------------------
def _monitor_loop(cfg: dict, reporter: Reporter, tray: TrayAgent | None,
                  ui: DashboardUiController | None = None,
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
    audio_probe = TimedProbe(is_audio_playing, ttl_seconds=10, fallback=False)
    fullscreen_probe = TimedProbe(is_foreground_fullscreen, ttl_seconds=2, fallback=False)
    music_probe = TimedProbe(get_music_info, ttl_seconds=15, fallback=None)

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

    while not shutdown_event.is_set() and not reload_event.is_set():
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
                       and not audio_probe.get()
                       and not fullscreen_probe.get())

            if is_idle and not was_idle:
                log.info("User idle (%.0fs)", idle_secs)
                was_idle = True
                update_runtime_status(tray, ui, "AFK")
            elif not is_idle and was_idle:
                log.info("User returned")
                was_idle = False

            if is_idle:
                heartbeat_due = (now - last_report_time) >= heartbeat_interval
                if heartbeat_due:
                    extra = with_device_capabilities(get_battery_extra())
                    idle_target = format_report_target("idle", "User is away")
                    if _send_report("idle", "User is away", extra):
                        prev_app = "idle"
                        prev_title = "User is away"
                        last_report_time = now
                        update_runtime_status(tray, ui, "AFK", idle_target)
                    elif reporter.retry_delay > 0:
                        control_wait(reporter.retry_delay)
                        continue
                control_wait(interval)
                continue

            info = get_foreground_info()
            if info is None:
                control_wait(interval)
                continue

            app_id, title = info

            # Keep tray status responsive; current item is updated only after a successful report.
            update_runtime_status(tray, ui, "在线")

            changed = app_id != prev_app or title != prev_title
            heartbeat_due = (now - last_report_time) >= heartbeat_interval

            if changed or heartbeat_due:
                extra = with_device_capabilities(get_battery_extra())
                music = music_probe.get(force=changed)
                if music:
                    extra["music"] = music
                reported_target = format_report_target(app_id, title)
                success = _send_report(app_id, title, extra)
                if success:
                    prev_app = app_id
                    prev_title = title
                    last_report_time = now
                    update_runtime_status(tray, ui, "在线", reported_target)
                    if changed:
                        log.info("Reported: %s", reported_target)
                elif reporter.retry_delay > 0:
                    control_wait(reporter.retry_delay)
                    continue

            control_wait(interval)

        except Exception as e:
            log.error("Error: %s", e, exc_info=True)
            control_wait(interval)

    log.info("Monitor stopped")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
class RuntimeSupervisor:
    """Owns the active reporter, websocket, message client, and monitor loop."""

    def __init__(self, tray: TrayAgent | None, ui: DashboardUiController | None = None):
        self._tray = tray
        self._ui = ui
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="runtime-supervisor", daemon=True)
        self._thread.start()

    def join(self, timeout: float | None = None) -> None:
        if self._thread:
            self._thread.join(timeout=timeout)
            self._thread = None

    def _run(self) -> None:
        while not shutdown_event.is_set():
            reload_event.clear()
            cfg = load_config()
            err = validate_config(cfg)
            if err:
                log.warning("Invalid config: %s", err)
                update_runtime_status(self._tray, self._ui, "配置错误")
                control_wait(5)
                continue

            set_file_logging(cfg.get("enable_log", False))
            if cfg.get("enable_log"):
                log.info("HTTP: %s", "HTTPS" if cfg["server_url"].startswith("https") else "HTTP (内网)")

            reporter = Reporter(cfg["server_url"], cfg["token"])
            ws_client: WsClient | None = None
            msg_client: MessageClient | None = None

            try:
                if HAS_WEBSOCKET:
                    ws_client = WsClient(cfg["server_url"], cfg["token"])
                    msg_client = MessageClient(cfg["server_url"], cfg["token"], ws_client)
                    ws_client._on_viewer_message = msg_client.on_ws_message
                    ws_client.start()
                    log.info("WebSocket 客户端已启动")
                else:
                    log.info("websocket-client 未安装, 仅使用 HTTP 上报")
                    msg_client = MessageClient(cfg["server_url"], cfg["token"])

                if self._tray and msg_client:
                    self._tray.set_message_client(msg_client)
                if self._ui and msg_client:
                    self._ui.set_message_client(msg_client)

                _monitor_loop(cfg, reporter, self._tray, self._ui, ws_client, msg_client)
            finally:
                if ws_client:
                    ws_client.stop()
                if msg_client:
                    msg_client.close()
                reporter.close()

            if reload_event.is_set() and not shutdown_event.is_set():
                log.info("配置已更新，正在重载 Windows Agent 运行时")
                continue
            break


def main() -> None:
    log.info("Live Dashboard Windows Agent")

    guard = SingleInstanceGuard()
    if guard.already_running:
        if not guard.notify_existing():
            show_message("Live Dashboard", "Windows Agent 已在后台运行。")
        guard.close()
        return

    ui: DashboardUiController | None = None
    try:
        ui = DashboardUiController(
            load_config=load_config,
            validate_config=validate_config,
            save_config=save_config,
            on_saved=reload_event.set,
            on_quit=shutdown_event.set,
            should_exit=shutdown_event.is_set,
            log_path=LOG_FILE,
        )
    except ImportError:
        log.warning("tkinter 不可用，主界面禁用")
    except Exception as exc:
        log.warning("主界面初始化失败: %s", exc)

    activation_server = ActivationEventServer(
        lambda: ui.open("overview") if ui else show_message("Live Dashboard", "Windows Agent 已在后台运行。")
    )
    supervisor: RuntimeSupervisor | None = None
    tray: TrayAgent | None = None

    try:
        activation_server.start()
        cfg = load_config()
        try:
            tray = TrayAgent(ui)
        except ImportError:
            log.warning("pystray/Pillow not installed, running without tray")
        except Exception as e:
            log.warning("Tray init failed: %s", e)

        reload_event.clear()
        supervisor = RuntimeSupervisor(tray, ui)
        supervisor.start()

        if tray:
            tray.run_detached()
        if ui and validate_config(cfg):
            ui.open("settings")
        elif ui:
            ui.open("overview")

        if ui:
            ui.run_forever()
        else:
            while not shutdown_event.is_set():
                shutdown_event.wait(1)
    except KeyboardInterrupt:
        shutdown_event.set()
    finally:
        shutdown_event.set()
        activation_server.stop()
        if ui:
            ui.stop()
        if tray:
            tray.stop()
        if supervisor:
            supervisor.join(timeout=10)
        guard.close()
        log.info("Agent stopped")
        logging.shutdown()


if __name__ == "__main__":
    main()
