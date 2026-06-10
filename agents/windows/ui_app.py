"""Single-window tkinter UI for the Windows agent."""

from __future__ import annotations

import logging
import os
from pathlib import Path
import queue
import threading
from typing import Callable

from autostart_actions import toggle_autostart
from ui_theme import (
    BG,
    BORDER,
    BUTTON_ACTIVE_BG,
    BUTTON_BG,
    MUTED,
    PRIMARY_ACTIVE_BG,
    PRIMARY_BG,
    SURFACE,
    SURFACE_MUTED,
    TEXT,
    notice_palette,
    status_color,
)
from win_control import is_autostart_enabled

log = logging.getLogger("agent")

ConfigLoader = Callable[[], dict]
ConfigValidator = Callable[[dict], str | None]
ConfigSaver = Callable[[dict], bool]


class DashboardUiController:
    """Owns the tkinter root and all user-visible Windows Agent UI."""

    def __init__(
        self,
        load_config: ConfigLoader,
        validate_config: ConfigValidator,
        save_config: ConfigSaver,
        on_saved: Callable[[], None] | None = None,
        on_quit: Callable[[], None] | None = None,
        should_exit: Callable[[], bool] | None = None,
        log_path: Path | None = None,
    ):
        import tkinter as tk
        from tkinter import ttk

        self.tk = tk
        self.ttk = ttk
        self._load_config = load_config
        self._validate_config = validate_config
        self._save_config = save_config
        self._on_saved = on_saved
        self._on_quit = on_quit
        self._should_exit = should_exit or (lambda: False)
        self._log_path = log_path
        self._commands: queue.Queue[tuple[str, object]] = queue.Queue()
        self._state_lock = threading.Lock()
        self._status = "初始化中"
        self._current_target = ""
        self._messages: list[dict] = []
        self._message_client = None
        self._visible = False
        self._active_tab = "overview"
        self._notice_after_id: str | None = None

        self.root = tk.Tk()
        self.root.title("Live Dashboard")
        self.root.geometry("820x600")
        self.root.minsize(760, 540)
        self.root.configure(bg=BG)
        self.root.protocol("WM_DELETE_WINDOW", self.hide)
        self._configure_style()
        self._build()
        self._apply_config(self._load_config())
        self.root.withdraw()

    # -- cross-thread commands ---------------------------------------------

    def open(self, tab: str = "overview") -> None:
        self._commands.put(("open", tab))

    def hide(self) -> None:
        self.root.withdraw()
        self._visible = False

    def stop(self) -> None:
        self._commands.put(("stop", None))

    def show_notice(self, title: str, message: str, error: bool = False) -> None:
        self._commands.put(("notice", (title, message, error)))

    def update_status(self, status: str, current_target: str | None = None) -> None:
        changed = False
        with self._state_lock:
            if self._status != status:
                self._status = status
                changed = True
            if current_target is not None and self._current_target != current_target:
                self._current_target = current_target
                changed = True
        if changed:
            self._commands.put(("refresh", None))

    def set_message_client(self, client) -> None:
        if self._message_client is client:
            return
        self._message_client = client
        client.on_message(self.add_message)
        self._commands.put(("refresh", None))

    def add_message(self, message: dict) -> None:
        self._commands.put(("message", message))

    def run_forever(self) -> None:
        self._schedule_tick()
        self.root.mainloop()

    # -- layout --------------------------------------------------------------

    def _configure_style(self) -> None:
        style = self.ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure(".", font=("Segoe UI", 10), background=BG, foreground=TEXT)
        style.configure("TFrame", background=BG)
        style.configure("Surface.TFrame", background=SURFACE)
        style.configure("Muted.TLabel", background=BG, foreground=MUTED)
        style.configure("Title.TLabel", background=BG, foreground=TEXT, font=("Segoe UI Semibold", 18))
        style.configure("Subtitle.TLabel", background=BG, foreground=MUTED, font=("Segoe UI", 10))
        style.configure("CardTitle.TLabel", background=SURFACE, foreground=TEXT, font=("Segoe UI Semibold", 11))
        style.configure("CardBody.TLabel", background=SURFACE, foreground=MUTED, font=("Segoe UI", 9))
        style.configure("Value.TLabel", background=SURFACE, foreground=TEXT, font=("Segoe UI Semibold", 16))
        style.configure("TEntry", fieldbackground="#FFFFFF")
        style.configure("TSpinbox", fieldbackground="#FFFFFF")

    def _build(self) -> None:
        tk = self.tk
        shell = tk.Frame(self.root, bg=BG, padx=24, pady=22)
        shell.pack(fill="both", expand=True)

        header = tk.Frame(shell, bg=BG)
        header.pack(fill="x")
        self.ttk.Label(header, text="Live Dashboard", style="Title.TLabel").pack(anchor="w")
        self.ttk.Label(
            header,
            text="Windows Agent 控制台，管理状态、留言和本机配置。",
            style="Subtitle.TLabel",
        ).pack(anchor="w", pady=(2, 0))

        self._nav = tk.Frame(shell, bg=BG)
        self._nav.pack(fill="x", pady=(18, 14))
        self._nav_buttons: dict[str, tk.Button] = {}
        for key, label in [("overview", "Overview"), ("messages", "Messages"), ("settings", "Settings")]:
            btn = tk.Button(
                self._nav,
                text=label,
                command=lambda tab=key: self._select_tab(tab),
                relief="flat",
                padx=18,
                pady=8,
                cursor="hand2",
                font=("Segoe UI Semibold", 10),
            )
            btn.pack(side="left", padx=(0, 8))
            self._nav_buttons[key] = btn

        self._notice = self._build_notice(shell)

        self._content = tk.Frame(shell, bg=BG)
        self._content.pack(fill="both", expand=True)

        self._tabs = {
            "overview": self._build_overview(self._content),
            "messages": self._build_messages(self._content),
            "settings": self._build_settings(self._content),
        }
        self._select_tab("overview")

    def _build_notice(self, parent):
        tk = self.tk
        frame = tk.Frame(
            parent,
            bg=SURFACE_MUTED,
            highlightthickness=1,
            highlightbackground=BORDER,
            padx=14,
            pady=10,
        )
        frame.columnconfigure(0, weight=1)
        text_area = tk.Frame(frame, bg=SURFACE_MUTED)
        text_area.grid(row=0, column=0, sticky="ew")
        self._notice_title = tk.Label(
            text_area,
            text="Live Dashboard",
            bg=SURFACE_MUTED,
            fg=TEXT,
            font=("Segoe UI Semibold", 10),
            anchor="w",
        )
        self._notice_title.pack(fill="x", anchor="w")
        self._notice_message = tk.Label(
            text_area,
            text="",
            bg=SURFACE_MUTED,
            fg=MUTED,
            font=("Segoe UI", 9),
            anchor="w",
            justify="left",
            wraplength=640,
        )
        self._notice_message.pack(fill="x", anchor="w", pady=(2, 0))
        self._notice_close = tk.Button(
            frame,
            text="×",
            command=self._hide_notice,
            relief="flat",
            bg=SURFACE_MUTED,
            fg=MUTED,
            activebackground=SURFACE_MUTED,
            activeforeground=TEXT,
            padx=8,
            pady=2,
            cursor="hand2",
            font=("Segoe UI Semibold", 10),
        )
        self._notice_close.grid(row=0, column=1, sticky="ne", padx=(10, 0))
        return frame

    def _build_overview(self, parent):
        tk = self.tk
        frame = tk.Frame(parent, bg=BG)
        grid = tk.Frame(frame, bg=BG)
        grid.pack(fill="both", expand=True)
        grid.columnconfigure(0, weight=1)
        grid.columnconfigure(1, weight=1)

        status_card = self._card(grid, "当前状态", "后台采集与上报的实时概况")
        status_card.grid(row=0, column=0, sticky="nsew", padx=(0, 10), pady=(0, 12))
        self._status_value = self.ttk.Label(status_card.body, text="初始化中", style="Value.TLabel")
        self._status_value.pack(anchor="w", pady=(8, 2))
        self._current_value = self.ttk.Label(status_card.body, text="暂无窗口", style="CardBody.TLabel", wraplength=330)
        self._current_value.pack(anchor="w", pady=(2, 0))

        config_card = self._card(grid, "连接配置", "当前服务器和本机启动项")
        config_card.grid(row=0, column=1, sticky="nsew", padx=(10, 0), pady=(0, 12))
        self._server_value = self.ttk.Label(config_card.body, text="未配置", style="CardBody.TLabel", wraplength=330)
        self._server_value.pack(anchor="w", pady=(8, 6))
        self._autostart_value = self.ttk.Label(config_card.body, text="自启动: 未开启", style="CardBody.TLabel")
        self._autostart_value.pack(anchor="w")

        actions_card = self._card(grid, "常用操作", "不离开主界面完成日常维护")
        actions_card.grid(row=1, column=0, columnspan=2, sticky="nsew")
        actions = tk.Frame(actions_card.body, bg=SURFACE)
        actions.pack(fill="x", pady=(10, 0))
        self._button(actions, "打开设置", lambda: self._select_tab("settings")).pack(side="left", padx=(0, 8))
        self._button(actions, "查看留言", lambda: self._select_tab("messages")).pack(side="left", padx=(0, 8))
        self._button(actions, "切换自启动", self._toggle_autostart).pack(side="left", padx=(0, 8))
        self._button(actions, "打开日志", self._open_log).pack(side="left", padx=(0, 8))
        self._button(actions, "退出", self._request_quit).pack(side="left")
        return frame

    def _build_messages(self, parent):
        tk = self.tk
        frame = tk.Frame(parent, bg=BG)
        card = self._card(frame, "最近留言", "来自服务器的设备消息和提醒")
        card.pack(fill="both", expand=True)

        toolbar = tk.Frame(card.body, bg=SURFACE)
        toolbar.pack(fill="x", pady=(8, 10))
        self._button(toolbar, "刷新", self._refresh_messages).pack(side="left")
        self._messages_hint = self.ttk.Label(toolbar, text="暂无留言", style="CardBody.TLabel")
        self._messages_hint.pack(side="left", padx=(12, 0))

        body = tk.Frame(card.body, bg=SURFACE)
        body.pack(fill="both", expand=True)
        body.columnconfigure(0, weight=1)
        body.columnconfigure(1, weight=2)
        body.rowconfigure(0, weight=1)

        self._message_list = tk.Listbox(
            body,
            activestyle="none",
            bd=0,
            highlightthickness=1,
            highlightbackground=BORDER,
            selectbackground="#E1F3FE",
            selectforeground=TEXT,
            font=("Segoe UI", 10),
        )
        self._message_list.grid(row=0, column=0, sticky="nsew", padx=(0, 10))
        self._message_list.bind("<<ListboxSelect>>", lambda _event: self._show_selected_message())

        self._message_detail = tk.Text(
            body,
            bd=0,
            wrap="word",
            padx=14,
            pady=12,
            highlightthickness=1,
            highlightbackground=BORDER,
            bg=SURFACE_MUTED,
            fg=TEXT,
            font=("Segoe UI", 10),
        )
        self._message_detail.grid(row=0, column=1, sticky="nsew")
        self._message_detail.configure(state="disabled")
        return frame

    def _build_settings(self, parent):
        tk = self.tk
        frame = tk.Frame(parent, bg=BG)
        card = self._card(frame, "Settings", "服务器连接、采集间隔和本地日志")
        card.pack(fill="both", expand=True)

        form = tk.Frame(card.body, bg=SURFACE)
        form.pack(fill="x", pady=(10, 0))
        form.columnconfigure(1, weight=1)

        self._server_var = tk.StringVar()
        self._token_var = tk.StringVar()
        self._interval_var = tk.StringVar()
        self._heartbeat_var = tk.StringVar()
        self._idle_var = tk.StringVar()
        self._log_var = tk.BooleanVar()

        self._field(form, 0, "服务器地址", self.ttk.Entry(form, textvariable=self._server_var))
        self._field(form, 1, "Token", self.ttk.Entry(form, textvariable=self._token_var, show="*"))
        self._field(form, 2, "上报间隔 (秒)", self.ttk.Spinbox(form, from_=1, to=300, textvariable=self._interval_var, width=12))
        self._field(form, 3, "心跳间隔 (秒)", self.ttk.Spinbox(form, from_=10, to=600, textvariable=self._heartbeat_var, width=12))
        self._field(form, 4, "AFK 判定 (秒)", self.ttk.Spinbox(form, from_=30, to=3600, textvariable=self._idle_var, width=12))

        log_check = tk.Checkbutton(
            form,
            text="开启日志文件",
            variable=self._log_var,
            bg=SURFACE,
            fg=TEXT,
            activebackground=SURFACE,
            selectcolor=SURFACE,
            font=("Segoe UI", 10),
        )
        log_check.grid(row=5, column=1, sticky="w", pady=8)

        actions = tk.Frame(card.body, bg=SURFACE)
        actions.pack(fill="x", pady=(18, 0))
        self._button(actions, "保存配置", self._save_settings, primary=True).pack(side="left", padx=(0, 8))
        self._button(actions, "重新载入", lambda: self._apply_config(self._load_config())).pack(side="left")
        return frame

    def _field(self, parent, row: int, label: str, widget) -> None:
        self.ttk.Label(parent, text=label, style="CardTitle.TLabel").grid(row=row, column=0, sticky="w", pady=7, padx=(0, 14))
        widget.grid(row=row, column=1, sticky="ew", pady=7)

    def _card(self, parent, title: str, subtitle: str):
        tk = self.tk
        outer = tk.Frame(parent, bg=SURFACE, highlightthickness=1, highlightbackground=BORDER, padx=18, pady=16)
        self.ttk.Label(outer, text=title, style="CardTitle.TLabel").pack(anchor="w")
        self.ttk.Label(outer, text=subtitle, style="CardBody.TLabel").pack(anchor="w", pady=(2, 0))
        outer.body = tk.Frame(outer, bg=SURFACE)  # type: ignore[attr-defined]
        outer.body.pack(fill="both", expand=True)
        return outer

    def _button(self, parent, text: str, command: Callable[[], None], primary: bool = False):
        return self.tk.Button(
            parent,
            text=text,
            command=command,
            relief="flat",
            padx=16,
            pady=8,
            cursor="hand2",
            bg=PRIMARY_BG if primary else BUTTON_BG,
            fg="#FFFFFF" if primary else TEXT,
            activebackground=PRIMARY_ACTIVE_BG if primary else BUTTON_ACTIVE_BG,
            activeforeground="#FFFFFF" if primary else TEXT,
            font=("Segoe UI Semibold", 10),
        )

    # -- actions -------------------------------------------------------------

    def _select_tab(self, tab: str) -> None:
        if tab not in self._tabs:
            tab = "overview"
        self._active_tab = tab
        for key, frame in self._tabs.items():
            if key == tab:
                frame.pack(fill="both", expand=True)
            else:
                frame.pack_forget()
        for key, btn in self._nav_buttons.items():
            active = key == tab
            btn.configure(
                bg=PRIMARY_BG if active else BUTTON_BG,
                fg="#FFFFFF" if active else TEXT,
                activebackground=PRIMARY_ACTIVE_BG if active else BUTTON_ACTIVE_BG,
                activeforeground="#FFFFFF" if active else TEXT,
            )
        self._refresh_view()

    def _apply_config(self, cfg: dict) -> None:
        self._server_var.set(str(cfg.get("server_url", "")))
        self._token_var.set(str(cfg.get("token", "")))
        self._interval_var.set(str(cfg.get("interval_seconds", 5)))
        self._heartbeat_var.set(str(cfg.get("heartbeat_seconds", 60)))
        self._idle_var.set(str(cfg.get("idle_threshold_seconds", 300)))
        self._log_var.set(bool(cfg.get("enable_log", False)))
        self._refresh_view()

    def _save_settings(self) -> None:
        cfg = {
            "server_url": self._server_var.get().strip(),
            "token": self._token_var.get().strip(),
            "interval_seconds": self._int_value(self._interval_var.get(), "上报间隔", 1, 300),
            "heartbeat_seconds": self._int_value(self._heartbeat_var.get(), "心跳间隔", 10, 600),
            "idle_threshold_seconds": self._int_value(self._idle_var.get(), "AFK 判定", 30, 3600),
            "enable_log": bool(self._log_var.get()),
        }
        if None in (cfg["interval_seconds"], cfg["heartbeat_seconds"], cfg["idle_threshold_seconds"]):
            return
        err = self._validate_config(cfg)
        if err:
            self._show_notice_now("配置错误", err, error=True)
            return
        if not self._save_config(cfg):
            self._show_notice_now("保存失败", "无法写入 config.json", error=True)
            return
        if self._on_saved:
            self._on_saved()
        self._apply_config(self._load_config())
        self._show_notice_now("Live Dashboard", "配置已保存，后台运行时会自动重载。")

    def _int_value(self, raw: str, label: str, low: int, high: int) -> int | None:
        try:
            value = int(raw)
        except ValueError:
            self._show_notice_now("配置错误", f"{label} 必须是整数", error=True)
            return None
        if value < low or value > high:
            self._show_notice_now("配置错误", f"{label} 必须在 {low}-{high} 之间", error=True)
            return None
        return value

    def _toggle_autostart(self) -> None:
        result = toggle_autostart()
        self._refresh_view()
        self._show_notice_now("Live Dashboard", result.message, error=not result.ok)

    def _open_log(self) -> None:
        if not self._log_path or not self._log_path.exists():
            self._show_notice_now("Live Dashboard", "还没有日志文件。")
            return
        try:
            os.startfile(self._log_path)  # type: ignore[attr-defined]
        except OSError as exc:
            self._show_notice_now("Live Dashboard", f"无法打开日志: {exc}", error=True)

    def _refresh_messages(self) -> None:
        if not self._message_client:
            self._show_notice_now("Live Dashboard", "消息客户端尚未启动。")
            return

        def worker() -> None:
            try:
                messages = self._message_client.fetch_pending()
                self._commands.put(("messages", messages))
            except Exception as exc:
                self._commands.put(("notice", ("Live Dashboard", f"刷新留言失败: {exc}", True)))

        threading.Thread(target=worker, name="ui-refresh-messages", daemon=True).start()

    def _request_quit(self) -> None:
        if self._on_quit:
            self._on_quit()
        self.root.quit()

    # -- rendering -----------------------------------------------------------

    def _refresh_view(self) -> None:
        with self._state_lock:
            status = self._status
            current = self._current_target
        self._status_value.configure(text=status)
        self._status_value.configure(foreground=status_color(status))
        self._current_value.configure(text=current or "暂无窗口")
        cfg = self._load_config()
        server = cfg.get("server_url") or "未配置"
        self._server_value.configure(text=f"服务器: {server}")
        self._autostart_value.configure(text=f"自启动: {'已开启' if is_autostart_enabled() else '未开启'}")
        self._render_messages()

    def _render_messages(self) -> None:
        self._message_list.delete(0, "end")
        for msg in self._messages[:30]:
            name = str(msg.get("viewer_name") or msg.get("viewer_id") or "未知")
            text = str(msg.get("text") or "").replace("\n", " ")
            self._message_list.insert("end", f"{name}: {text[:48]}")
        self._messages_hint.configure(text=f"{len(self._messages)} 条已缓存" if self._messages else "暂无留言")
        if not self._messages:
            self._set_detail("暂无留言。")

    def _show_selected_message(self) -> None:
        selection = self._message_list.curselection()
        if not selection:
            return
        index = int(selection[0])
        if index >= len(self._messages):
            return
        msg = self._messages[index]
        created = str(msg.get("created_at") or "")
        text = str(msg.get("text") or "")
        name = str(msg.get("viewer_name") or msg.get("viewer_id") or "未知")
        queued = "是" if msg.get("queued") is True else "否"
        detail = "\n".join([
            f"发送者: {name}",
            f"时间: {created or '未知'}",
            f"排队: {queued}",
            "",
            text or "无内容",
        ])
        self._set_detail(detail)

    def _set_detail(self, text: str) -> None:
        self._message_detail.configure(state="normal")
        self._message_detail.delete("1.0", "end")
        self._message_detail.insert("1.0", text)
        self._message_detail.configure(state="disabled")

    # -- event pump ----------------------------------------------------------

    def _schedule_tick(self) -> None:
        self._drain_commands()
        self.root.after(120, self._schedule_tick)

    def _drain_commands(self) -> None:
        if self._should_exit():
            self.root.quit()
            return
        while True:
            try:
                command, payload = self._commands.get_nowait()
            except queue.Empty:
                break
            if command == "open":
                tab = payload if isinstance(payload, str) else "overview"
                self._show(tab)
            elif command == "stop":
                self.root.quit()
            elif command == "refresh":
                self._refresh_view()
            elif command == "notice":
                title, message, error = payload  # type: ignore[misc]
                if not self._visible:
                    self._show(self._active_tab)
                self._show_notice_now(str(title), str(message), bool(error))
            elif command == "message":
                self._add_message_now(payload)
            elif command == "messages":
                self._merge_messages(payload)

    def _show(self, tab: str) -> None:
        self._select_tab(tab)
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()
        self.root.attributes("-topmost", True)
        self.root.after(250, lambda: self.root.attributes("-topmost", False))
        self._visible = True

    def _show_notice_now(self, title: str, message: str, error: bool = False) -> None:
        if self._notice_after_id:
            self.root.after_cancel(self._notice_after_id)
            self._notice_after_id = None
        palette = notice_palette(error)
        self._notice.configure(bg=palette["background"], highlightbackground=palette["border"])
        self._notice_title.configure(bg=palette["background"], fg=palette["title"], text=title)
        self._notice_message.configure(
            bg=palette["background"],
            fg=palette["text"],
            text=message,
            wraplength=max(360, self.root.winfo_width() - 140),
        )
        self._notice_close.configure(
            bg=palette["background"],
            activebackground=palette["background"],
        )
        if not self._notice.winfo_ismapped():
            self._notice.pack(fill="x", pady=(0, 14), before=self._content)
        self._notice_after_id = self.root.after(10000, self._hide_notice)

    def _hide_notice(self) -> None:
        if self._notice_after_id:
            self.root.after_cancel(self._notice_after_id)
            self._notice_after_id = None
        if self._notice.winfo_ismapped():
            self._notice.pack_forget()

    def _add_message_now(self, payload: object) -> None:
        if not isinstance(payload, dict):
            return
        message_id = str(payload.get("message_id") or payload.get("id") or "")
        if message_id and any(str(item.get("message_id") or item.get("id") or "") == message_id for item in self._messages):
            return
        self._messages.insert(0, payload)
        self._messages = self._messages[:30]
        self._render_messages()

    def _merge_messages(self, payload: object) -> None:
        if not isinstance(payload, list):
            return
        for item in reversed(payload):
            self._add_message_now(item)
        self._render_messages()
