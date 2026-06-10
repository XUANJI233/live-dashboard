"""Realtime device command transport for macOS Agent."""

from __future__ import annotations

from collections.abc import Callable
import json
import logging
import threading

import requests

from device_commands import execute_desktop_command, extract_device_command, receipt_frame

try:
    import websocket as _ws_lib
    HAS_WEBSOCKET = True
except ImportError:
    _ws_lib = None
    HAS_WEBSOCKET = False


log = logging.getLogger("agent.realtime")


class WsClient:
    """WebSocket device client with auto-reconnect."""

    INITIAL_BACKOFF = 2
    MAX_BACKOFF = 60

    def __init__(self, server_url: str, token: str):
        self._server_url = server_url.rstrip("/")
        self._token = token
        self._ws = None
        self._stop_event = threading.Event()
        self._connected = False
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._backoff = self.INITIAL_BACKOFF
        self._on_message: Callable[[dict], None] | None = None

    def set_message_handler(self, handler: Callable[[dict], None]) -> None:
        self._on_message = handler

    def start(self) -> None:
        if not HAS_WEBSOCKET:
            log.warning("websocket-client not installed; WebSocket disabled")
            return
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="ws-client")
        self._thread.start()

    def stop(self) -> None:
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
        return self._send({"type": "device_status", "payload": payload})

    def send_device_command_ack(self, frame: dict) -> bool:
        return self._send(frame)

    def _build_ws_url(self) -> str:
        url = self._server_url
        if url.startswith("https://"):
            url = "wss://" + url[8:]
        elif url.startswith("http://"):
            url = "ws://" + url[7:]
        elif not url.startswith("ws"):
            url = "wss://" + url
        return url + "/api/ws?role=device"

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

    def _run(self) -> None:
        assert _ws_lib is not None
        while not self._stop_event.is_set():
            try:
                self._ws = _ws_lib.WebSocketApp(
                    self._build_ws_url(),
                    header={"Authorization": f"Bearer {self._token}"},
                    on_open=self._on_open,
                    on_message=self._on_raw_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                self._ws.run_forever(ping_interval=30, ping_timeout=10)
            except Exception as exc:
                log.debug("WebSocket run loop failed: %s", exc)
            if self._stop_event.is_set():
                break
            self._connected = False
            log.info("WebSocket disconnected; reconnecting in %ds", self._backoff)
            self._stop_event.wait(self._backoff)
            self._backoff = min(self._backoff * 2, self.MAX_BACKOFF)

    def _on_open(self, _ws) -> None:
        self._connected = True
        self._backoff = self.INITIAL_BACKOFF
        log.info("WebSocket connected")

    def _on_raw_message(self, _ws, raw: str) -> None:
        try:
            data = json.loads(raw)
        except Exception:
            return
        if not isinstance(data, dict):
            return
        msg_type = data.get("type")
        if msg_type == "ack":
            log.info("WebSocket handshake ack: device_id=%s", data.get("device_id"))
            return
        if msg_type in ("device_command", "viewer_message") and self._on_message:
            self._on_message(data)

    def _on_error(self, _ws, error) -> None:
        log.debug("WebSocket error: %s", error)

    def _on_close(self, _ws, code, msg) -> None:
        self._connected = False
        log.debug("WebSocket closed: code=%s msg=%s", code, msg)


class DeviceCommandClient:
    """Consumes current device_command envelopes from WS and /api/messages."""

    def __init__(
        self,
        server_url: str,
        token: str,
        ws_client: WsClient | None = None,
        on_desktop_message: Callable[[dict], None] | None = None,
    ):
        self._server_url = server_url.rstrip("/")
        self._ws = ws_client
        self._on_desktop_message = on_desktop_message
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        })

    def on_ws_message(self, data: dict) -> None:
        self.handle_device_command(data)

    def fetch_pending(self) -> int:
        """GET /api/messages and consume current pending device commands."""
        try:
            response = self._session.get(f"{self._server_url}/api/messages", timeout=10)
            if response.status_code != 200:
                return 0
            parsed = response.json()
        except Exception as exc:
            log.debug("Failed to fetch pending device messages: %s", exc)
            return 0

        messages = parsed.get("messages") if isinstance(parsed, dict) else None
        if not isinstance(messages, list):
            return 0

        handled = 0
        for message in messages:
            if self.handle_device_command(message):
                handled += 1
        return handled

    def handle_device_command(self, message: object) -> bool:
        envelope = extract_device_command(message)
        if not envelope:
            return False

        command_id = envelope.get("command_id")
        if not isinstance(command_id, str) or not command_id:
            log.warning("Ignoring device_command without command_id")
            return True

        self._send_command_ack(receipt_frame(envelope))
        result, synthetic_message = execute_desktop_command(envelope)
        if synthetic_message and self._on_desktop_message:
            try:
                self._on_desktop_message(synthetic_message)
            except Exception as exc:
                log.debug("Desktop command notification failed: %s", exc)
        self._send_command_ack(result)
        return True

    def close(self) -> None:
        self._session.close()

    def _send_command_ack(self, frame: dict) -> bool:
        if self._ws and self._ws.send_device_command_ack(frame):
            return True
        try:
            response = self._session.post(
                f"{self._server_url}/api/supervision/ack",
                json=frame,
                timeout=10,
            )
            return response.status_code == 200
        except Exception as exc:
            log.debug("Device command ack failed: %s", exc)
            return False
