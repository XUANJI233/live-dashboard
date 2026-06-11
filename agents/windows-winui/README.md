# Live Dashboard Agent WinUI

WinUI 3 Windows Agent workspace. This is the canonical Windows client; the previous Python/tkinter UI and PyInstaller packaging path have been removed.

## Architecture

- `Pages/`: thin WinUI pages. Pages bind fields and handle button events only.
- `Services/`: registry configuration, startup, install mode, navigation routes, and device/API helpers.
- `Styles/`: shared XAML resources. Pages should reuse these styles instead of hard-coding card, text, spacing, or color choices.
- `ViewModels/`: display snapshots derived from services.

The message page reads `/api/messages/history` for display. The background runtime owns `/api/messages`, because that endpoint marks pending rows delivered and may include `device_command` envelopes. Plain delivered messages are cached locally, and desktop-safe commands are acknowledged through `/api/supervision/ack`.

## Configuration

Settings are stored under:

`HKCU\Software\LiveDashboardAgent`

Boolean settings are stored as explicit `true` / `false` strings. The WinUI app can migrate an existing `config.json` into the registry, but new writes go to the registry.

`EnableLog` defaults to `false`. When enabled, the runtime appends to the current app directory's `logs\agent.log`, and the UI can open either the file or its folder from Overview or Settings.

## Startup

Autostart uses the current-user Run key:

`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

The value name is `LiveDashboardAgent`. Startup cleanup removes duplicate Live Dashboard Run values, current-user Startup folder shortcuts, and the legacy scheduled task named `LiveDashboardAgent`.

This app should not request UAC elevation for normal startup. The agent does not need administrator rights for the current foreground/audio/battery/tray workflows, and elevated tray apps are more likely to create desktop-session and trust friction.

## Install mode

There are two build artifacts:

- Portable: `dist\portable\LiveDashboardAgent.exe` opens the main agent UI directly and can enable HKCU startup for the current executable, but it does not show install or uninstall UI.
- UserInstall: `dist\install\LiveDashboardAgent.exe` opens an installer wizard first when launched outside a registered install directory. After installation, the installed `LiveDashboardAgent.exe` opens the main UI.

Current-user installs default to:

`%LocalAppData%\Programs\LiveDashboardAgent`

All-users installs default to:

`%ProgramFiles%\LiveDashboardAgent`

The install path can be typed directly. When the installer folder picker is used, the selected folder is treated as the parent folder and `LiveDashboardAgent` is appended automatically, so selecting `D:\Apps` installs into `D:\Apps\LiveDashboardAgent`.

The installer can create a desktop shortcut and can launch the installed main UI after installation. It also writes a Windows uninstall entry, so removal is available from Windows installed apps. Current-user startup writes `HKCU\...\Run`; all-users startup writes `HKLM\...\Run` and is executed only through an explicit UAC action. HKLM startup starts the app for all users, but it does not make the app run elevated.

Install writes a manifest with each installed file's relative path, size, and SHA-256 plus a registry install record containing the manifest hash. Uninstall revalidates the directory, manifest, registry record, and file hashes before deleting files. It deletes only files that match the install manifest, optionally removes current-user logs, and removes directories only when they are empty.

Build outputs are self-contained for Windows App SDK so users are not asked to install a separate Windows App Runtime before launching the app.

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

- `dist\portable\LiveDashboardAgent.exe`
- `dist\install\LiveDashboardAgent.exe`

Use `WINDOWS_SKIP_SIGNING=true` only for local/debug smoke builds. Signed release builds use `agents/windows-winui/sign-windows.ps1`.
