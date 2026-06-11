# Live Dashboard Agent WinUI

WinUI 3 Windows Agent migration workspace. This directory is intentionally separate from `agents/windows` so the current Python agent can stay stable while the native Windows client is rebuilt in focused pieces.

## Architecture

- `Pages/`: thin WinUI pages. Pages bind fields and handle button events only.
- `Services/`: registry configuration, startup, install mode, navigation routes, and later device/API runtime services.
- `Styles/`: shared XAML resources. Pages should reuse these styles instead of hard-coding card, text, spacing, or color choices.
- `ViewModels/`: display snapshots derived from services.

## Configuration

Settings are stored under:

`HKCU\Software\LiveDashboardAgent`

Boolean settings are stored as explicit `true` / `false` strings. The WinUI app can migrate an existing `config.json` into the registry, but new writes go to the registry.

## Startup

Autostart uses the current-user Run key:

`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

The value name is `LiveDashboardAgent`. Startup cleanup removes duplicate Live Dashboard Run values, current-user Startup folder shortcuts, and the legacy scheduled task named `LiveDashboardAgent`.

This app should not request UAC elevation for normal startup. The agent does not need administrator rights for the current foreground/audio/battery/tray workflows, and elevated tray apps are more likely to create desktop-session and trust friction.

## Build

Build both current-user install and portable artifacts:

```powershell
$env:WINDOWS_SKIP_SIGNING = "true"
.\build-winui.ps1
```

Build only one mode:

```powershell
.\build-winui.ps1 -Mode Portable
.\build-winui.ps1 -Mode UserInstall
```

Outputs:

- `dist\portable\LiveDashboardAgent.Portable.exe`
- `dist\install\LiveDashboardAgent.exe`

Use `WINDOWS_SKIP_SIGNING=true` only for local/debug smoke builds. Signed release builds reuse `agents/windows/sign-windows.ps1`.
