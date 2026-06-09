"""Tk settings dialog with single-window activation control."""

from __future__ import annotations

import logging
import threading
from typing import Callable

from win_control import activate_window

log = logging.getLogger("agent")

ConfigLoader = Callable[[], dict]
ConfigValidator = Callable[[dict], str | None]
ConfigSaver = Callable[[dict], bool]


class SettingsDialogController:
    """Open at most one settings window and restore it on repeated requests."""

    def __init__(
        self,
        load_config: ConfigLoader,
        validate_config: ConfigValidator,
        save_config: ConfigSaver,
        on_saved: Callable[[], None] | None = None,
    ):
        self._load_config = load_config
        self._validate_config = validate_config
        self._save_config = save_config
        self._on_saved = on_saved
        self._lock = threading.Lock()
        self._hwnd: int | None = None
        self._thread: threading.Thread | None = None

    def open(self, current_config: dict | None = None, blocking: bool = False) -> dict | None:
        """Open settings. Non-blocking calls restore the active dialog if present."""
        with self._lock:
            if self._hwnd:
                activate_window(self._hwnd)
                return None
            if self._thread and self._thread.is_alive():
                return None

        if blocking:
            cfg = current_config or self._load_config()
            return self._run_dialog(cfg)

        cfg = current_config or self._load_config()
        with self._lock:
            if self._hwnd:
                activate_window(self._hwnd)
                return None
            if self._thread and self._thread.is_alive():
                return None
            self._thread = threading.Thread(
                target=self._run_dialog,
                args=(cfg,),
                name="settings-dialog",
                daemon=True,
            )
            self._thread.start()
        return None

    def _set_hwnd(self, hwnd: int | None) -> None:
        with self._lock:
            self._hwnd = hwnd
        if hwnd:
            activate_window(hwnd)

    def _clear_window(self) -> None:
        with self._lock:
            self._hwnd = None
            self._thread = None

    def _run_dialog(self, cfg: dict) -> dict | None:
        try:
            result = show_settings_dialog(
                cfg,
                validate_config=self._validate_config,
                save_config=self._save_config,
                on_window=self._set_hwnd,
            )
            if result is not None and self._on_saved is not None:
                self._on_saved()
            return result
        finally:
            self._clear_window()


def show_settings_dialog(
    current_config: dict,
    validate_config: ConfigValidator,
    save_config: ConfigSaver,
    on_window: Callable[[int | None], None] | None = None,
) -> dict | None:
    """Show tkinter settings dialog. Returns new config or None if cancelled."""
    try:
        import tkinter as tk
        from tkinter import ttk, messagebox
    except ImportError:
        log.error("tkinter 不可用, 请手动编辑 config.json")
        return None

    cfg = dict(current_config)
    result: list[dict | None] = [None]

    root = tk.Tk()
    root.title("Live Dashboard - 设置")
    root.resizable(False, False)
    root.protocol("WM_DELETE_WINDOW", root.destroy)

    frame = ttk.Frame(root, padding=20)
    frame.pack(fill="both", expand=True)

    ttk.Label(frame, text="服务器地址:").grid(row=0, column=0, sticky="w", pady=6)
    url_var = tk.StringVar(value=cfg.get("server_url", ""))
    ttk.Entry(frame, textvariable=url_var, width=45).grid(row=0, column=1, pady=6, padx=(8, 0))

    ttk.Label(frame, text="Token:").grid(row=1, column=0, sticky="w", pady=6)
    token_var = tk.StringVar(value=cfg.get("token", ""))
    ttk.Entry(frame, textvariable=token_var, width=45, show="*").grid(row=1, column=1, pady=6, padx=(8, 0))

    ttk.Label(frame, text="上报间隔 (秒):").grid(row=2, column=0, sticky="w", pady=6)
    interval_var = tk.StringVar(value=str(cfg.get("interval_seconds", 5)))
    ttk.Spinbox(frame, textvariable=interval_var, from_=1, to=300, width=10).grid(
        row=2, column=1, sticky="w", pady=6, padx=(8, 0)
    )

    ttk.Label(frame, text="心跳间隔 (秒):").grid(row=3, column=0, sticky="w", pady=6)
    heartbeat_var = tk.StringVar(value=str(cfg.get("heartbeat_seconds", 60)))
    ttk.Spinbox(frame, textvariable=heartbeat_var, from_=10, to=600, width=10).grid(
        row=3, column=1, sticky="w", pady=6, padx=(8, 0)
    )

    ttk.Label(frame, text="AFK 判定 (秒):").grid(row=4, column=0, sticky="w", pady=6)
    idle_var = tk.StringVar(value=str(cfg.get("idle_threshold_seconds", 300)))
    ttk.Spinbox(frame, textvariable=idle_var, from_=30, to=3600, width=10).grid(
        row=4, column=1, sticky="w", pady=6, padx=(8, 0)
    )

    log_var = tk.BooleanVar(value=cfg.get("enable_log", False))
    ttk.Checkbutton(frame, text="开启日志文件 (保留 2 天)", variable=log_var).grid(
        row=5, column=0, columnspan=2, sticky="w", pady=6
    )

    def read_int(var: "tk.StringVar", label: str, low: int, high: int) -> int | None:
        try:
            value = int(var.get())
        except ValueError:
            messagebox.showerror("配置错误", f"{label} 必须是整数", parent=root)
            return None
        if value < low or value > high:
            messagebox.showerror("配置错误", f"{label} 必须在 {low}-{high} 之间", parent=root)
            return None
        return value

    def on_save() -> None:
        interval = read_int(interval_var, "上报间隔", 1, 300)
        heartbeat = read_int(heartbeat_var, "心跳间隔", 10, 600)
        idle = read_int(idle_var, "AFK 判定", 30, 3600)
        if interval is None or heartbeat is None or idle is None:
            return

        new_cfg = {
            "server_url": url_var.get().strip(),
            "token": token_var.get().strip(),
            "interval_seconds": interval,
            "heartbeat_seconds": heartbeat,
            "idle_threshold_seconds": idle,
            "enable_log": bool(log_var.get()),
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

    root.update_idletasks()
    w, h = root.winfo_reqwidth(), root.winfo_reqheight()
    x = (root.winfo_screenwidth() - w) // 2
    y = (root.winfo_screenheight() - h) // 2
    root.geometry(f"+{x}+{y}")
    root.lift()
    root.focus_force()
    root.attributes("-topmost", True)
    root.after(300, lambda: root.attributes("-topmost", False))

    if on_window is not None:
        on_window(root.winfo_id())

    root.mainloop()
    if on_window is not None:
        on_window(None)
    return result[0]
