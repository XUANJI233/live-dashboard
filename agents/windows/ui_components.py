"""Small tkinter design-system primitives for the Windows agent."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ui_theme import (
    ACCENT,
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
    tone_palette,
)


@dataclass(frozen=True)
class TabSpec:
    key: str
    label: str
    title: str
    subtitle: str


@dataclass(frozen=True)
class ButtonSpec:
    text: str
    command: Callable[[], None]
    primary: bool = False


TAB_SPECS = (
    TabSpec("overview", "概览", "概览", "后台采集、连接状态和常用操作。"),
    TabSpec("messages", "消息", "消息", "服务器留言、AI 监督提醒和桌面命令。"),
    TabSpec("settings", "设置", "设置", "服务器连接、采集间隔和本地日志。"),
)
TAB_BY_KEY = {tab.key: tab for tab in TAB_SPECS}


class DashboardCard:
    """Tk card with a small interface matching the Android DashboardCard idea."""

    def __init__(self, tk, ttk, parent, title: str, subtitle: str = "", tone: str = "neutral"):
        palette = tone_palette(tone)
        background = SURFACE if tone == "neutral" else palette["background"]
        self.frame = tk.Frame(
            parent,
            bg=background,
            highlightthickness=1,
            highlightbackground=BORDER,
            padx=18,
            pady=16,
        )
        ttk.Label(self.frame, text=title, style="CardTitle.TLabel").pack(anchor="w")
        if subtitle:
            ttk.Label(self.frame, text=subtitle, style="CardBody.TLabel").pack(anchor="w", pady=(2, 0))
        self.body = tk.Frame(self.frame, bg=background)
        self.body.pack(fill="both", expand=True)

    def pack(self, *args, **kwargs):
        return self.frame.pack(*args, **kwargs)

    def grid(self, *args, **kwargs):
        return self.frame.grid(*args, **kwargs)


class ScrollableFrame:
    """Canvas-backed vertical scroll container for card-heavy panes."""

    def __init__(self, tk, ttk, parent, background: str = BG):
        self.tk = tk
        self.frame = tk.Frame(parent, bg=background)
        self.canvas = tk.Canvas(
            self.frame,
            bg=background,
            bd=0,
            highlightthickness=0,
            yscrollincrement=24,
        )
        self.scrollbar = ttk.Scrollbar(self.frame, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=self.scrollbar.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.scrollbar.pack(side="right", fill="y")
        self.body = tk.Frame(self.canvas, bg=background)
        self._window_id = self.canvas.create_window((0, 0), window=self.body, anchor="nw")
        self.body.bind("<Configure>", self._sync_scroll_region)
        self.canvas.bind("<Configure>", self._sync_body_width)
        self.canvas.bind("<Enter>", self._bind_mousewheel)
        self.canvas.bind("<Leave>", self._unbind_mousewheel)

    def pack(self, *args, **kwargs):
        return self.frame.pack(*args, **kwargs)

    def grid(self, *args, **kwargs):
        return self.frame.grid(*args, **kwargs)

    def _sync_scroll_region(self, _event=None) -> None:
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    def _sync_body_width(self, event) -> None:
        self.canvas.itemconfigure(self._window_id, width=event.width)

    def _bind_mousewheel(self, _event=None) -> None:
        self.canvas.bind_all("<MouseWheel>", self._on_mousewheel)

    def _unbind_mousewheel(self, _event=None) -> None:
        self.canvas.unbind_all("<MouseWheel>")

    def _on_mousewheel(self, event) -> None:
        delta = int(-1 * (event.delta / 120))
        if delta:
            self.canvas.yview_scroll(delta, "units")


class UiKit:
    """Factory for the shared tkinter primitives used by every UI pane."""

    def __init__(self, tk, ttk):
        self.tk = tk
        self.ttk = ttk

    def configure_style(self, root) -> None:
        style = self.ttk.Style(root)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure(".", font=("Segoe UI", 10), background=BG, foreground=TEXT)
        style.configure("TFrame", background=BG)
        style.configure("Surface.TFrame", background=SURFACE)
        style.configure("Muted.TLabel", background=BG, foreground=MUTED)
        style.configure("RailTitle.TLabel", background=SURFACE, foreground=TEXT, font=("Segoe UI Semibold", 13))
        style.configure("RailMeta.TLabel", background=SURFACE, foreground=MUTED, font=("Segoe UI", 9))
        style.configure("Title.TLabel", background=BG, foreground=TEXT, font=("Segoe UI Semibold", 20))
        style.configure("Subtitle.TLabel", background=BG, foreground=MUTED, font=("Segoe UI", 10))
        style.configure("CardTitle.TLabel", background=SURFACE, foreground=TEXT, font=("Segoe UI Semibold", 11))
        style.configure("CardBody.TLabel", background=SURFACE, foreground=MUTED, font=("Segoe UI", 9))
        style.configure("Value.TLabel", background=SURFACE, foreground=TEXT, font=("Segoe UI Semibold", 18))
        style.configure("TEntry", fieldbackground="#FFFFFF")
        style.configure("TSpinbox", fieldbackground="#FFFFFF")

    def card(self, parent, title: str, subtitle: str = "", tone: str = "neutral") -> DashboardCard:
        return DashboardCard(self.tk, self.ttk, parent, title, subtitle, tone)

    def scrollable_frame(self, parent) -> ScrollableFrame:
        return ScrollableFrame(self.tk, self.ttk, parent)

    def button(self, parent, text: str, command: Callable[[], None], primary: bool = False):
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

    def button_grid(self, parent, actions: tuple[ButtonSpec, ...], columns: int = 3):
        frame = self.tk.Frame(parent, bg=SURFACE)
        for index, action in enumerate(actions):
            button = self.button(frame, action.text, action.command, action.primary)
            button.grid(
                row=index // columns,
                column=index % columns,
                sticky="w",
                padx=(0, 8),
                pady=(0, 8),
            )
        return frame

    def nav_button(self, parent, text: str, command: Callable[[], None]):
        return self.tk.Button(
            parent,
            text=text,
            command=command,
            anchor="w",
            relief="flat",
            padx=14,
            pady=10,
            cursor="hand2",
            bg=SURFACE,
            fg=MUTED,
            activebackground=SURFACE_MUTED,
            activeforeground=TEXT,
            font=("Segoe UI Semibold", 10),
        )

    def set_nav_active(self, button, active: bool) -> None:
        button.configure(
            bg=SURFACE_MUTED if active else SURFACE,
            fg=ACCENT if active else MUTED,
            activebackground=SURFACE_MUTED,
            activeforeground=ACCENT if active else TEXT,
        )

    def status_pill(self, parent, text: str, tone: str = "neutral"):
        palette = tone_palette(tone)
        return self.tk.Label(
            parent,
            text=text,
            bg=palette["background"],
            fg=palette["text"],
            padx=10,
            pady=4,
            font=("Segoe UI Semibold", 9),
        )

    def set_status_pill(self, label, text: str, tone: str = "neutral") -> None:
        palette = tone_palette(tone)
        label.configure(text=text, bg=palette["background"], fg=palette["text"])

    def preference_check(self, parent, title: str, body: str, variable):
        frame = self.tk.Frame(parent, bg=SURFACE)
        frame.columnconfigure(1, weight=1)
        check = self.tk.Checkbutton(
            frame,
            variable=variable,
            bg=SURFACE,
            fg=TEXT,
            activebackground=SURFACE,
            selectcolor=SURFACE,
            cursor="hand2",
        )
        check.grid(row=0, column=0, rowspan=2, sticky="nw", padx=(0, 10), pady=(2, 0))
        self.ttk.Label(frame, text=title, style="CardTitle.TLabel").grid(row=0, column=1, sticky="ew")
        self.ttk.Label(frame, text=body, style="CardBody.TLabel", wraplength=420).grid(
            row=1,
            column=1,
            sticky="ew",
            pady=(2, 0),
        )
        return frame

    def compact_divider(self, parent):
        return self.tk.Frame(parent, bg=BORDER, height=1)

    def field(self, parent, row: int, label: str, widget) -> None:
        self.ttk.Label(parent, text=label, style="CardTitle.TLabel").grid(
            row=row,
            column=0,
            sticky="w",
            pady=7,
            padx=(0, 14),
        )
        widget.grid(row=row, column=1, sticky="ew", pady=7)
