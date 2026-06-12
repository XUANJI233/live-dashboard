# Live Dashboard — Windows Agent

> `windows-source` branch — native Windows desktop Agent source.
>
> Server, Web, Android, and shared API documentation live in the main project branches.

## Overview

The Windows Agent is now a Flutter desktop app with a small native C++ runner. It runs as a long-lived tray application, reports foreground activity to Live Dashboard, receives desktop-safe device messages, and provides a Windows settings/install experience without the WinUI/Windows App Runtime footprint.

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
| Installer | Current-user/all-users install modes, custom path, desktop shortcut, protected manifest uninstall |
| Logs | Disabled by default; optional `logs\agent.log` beside the running app with in-app open-file/open-folder actions |

## Source Layout

```text
agents/windows-flutter/
├── lib/src/controllers/  # App orchestration and immutable UI snapshots
├── lib/src/models/       # Config, install state, messages, runtime snapshots
├── lib/src/pages/        # Overview, messages, settings, installer surfaces
├── lib/src/services/     # API clients, runtime loop, installer, logging
├── lib/src/theme/        # Shared design tokens
├── windows/runner/       # Native Win32 bridge, tray, startup, activity probes
└── build-flutter.ps1
```

The previous Python/tkinter UI and WinUI packaging path have been removed from the active build. Use the Flutter project for all Windows Agent changes.

## Build

```powershell
cd agents/windows-flutter
$env:WINDOWS_SKIP_SIGNING = "true"
.\build-flutter.ps1 -Mode Both -Configuration Release
```

Outputs:

- `agents/windows-flutter/dist/portable/LiveDashboardAgent.exe`
- `agents/windows-flutter/dist/install/LiveDashboardAgent.exe`
- `agents/windows-flutter/dist/packages/LiveDashboardAgent-portable-win-x64.zip`
- `agents/windows-flutter/dist/packages/LiveDashboardAgent-installer-win-x64.zip`

Downloadable GitHub artifacts are zip packages. Extract the whole package and run the `LiveDashboardAgent.exe` inside the extracted folder; Flutter Windows needs the adjacent `flutter_windows.dll` and `data` directory.

Use `WINDOWS_SKIP_SIGNING=true` only for local/debug smoke builds. Signed release builds use `agents/windows-flutter/sign-windows.ps1`.
