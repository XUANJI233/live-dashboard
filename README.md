# Live Dashboard — Windows Agent

> `windows-source` branch — native Windows desktop Agent source.
>
> Server, Web, Android, and shared API documentation live in the main project branches.

## Overview

The Windows Agent is now a WinUI 3 desktop app. It runs as a long-lived tray application, reports foreground activity to Live Dashboard, receives desktop-safe device messages, and provides a native settings/install experience.

## Features

| Feature | Status |
| --- | --- |
| Foreground app reporting | Win32 foreground process/title probing |
| AFK detection | Keyboard/mouse idle threshold with heartbeat reports |
| Fullscreen guard | Avoids AFK while the foreground window is fullscreen |
| Battery metadata | Reports battery level and charging state when available |
| Desktop messages | Displays message history and applies desktop-safe `say` commands |
| Device command ack | Sends receipt/result frames to `/api/supervision/ack` |
| Tray resident mode | Close hides to tray; relaunch wakes the existing window |
| Startup cleanup | Uses the registry Run key and removes legacy duplicate startup entries |
| Installer | Current-user/all-users install modes, custom path, desktop shortcut, uninstall entry |
| Logs | Disabled by default; optional `logs\agent.log` beside the running app with in-app open-file/open-folder actions |

## Source Layout

```text
agents/windows-winui/
├── Pages/        # WinUI pages
├── Services/     # Runtime, API, install, tray, startup, Win32 helpers
├── Styles/       # Shared XAML resources
├── ViewModels/   # UI display snapshots
└── build-winui.ps1
```

The previous Python/tkinter UI and PyInstaller packaging path have been removed from this branch. Use the WinUI project for all Windows Agent changes.

## Build

```powershell
cd agents/windows-winui
$env:WINDOWS_SKIP_SIGNING = "true"
.\build-winui.ps1 -Mode Both -Configuration Release
```

Outputs:

- `agents/windows-winui/dist/portable/LiveDashboardAgent.exe`
- `agents/windows-winui/dist/install/LiveDashboardAgent.exe`

Use `WINDOWS_SKIP_SIGNING=true` only for local/debug smoke builds. Signed release builds use `agents/windows-winui/sign-windows.ps1`.
