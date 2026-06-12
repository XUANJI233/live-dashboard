# Live Dashboard Agent for Windows

Flutter Windows client with a small C++ runner for native system integration.

## Architecture

- `lib/src/controllers`: app orchestration and UI-facing immutable snapshots.
- `lib/src/models`: config, runtime, install, and message value objects.
- `lib/src/services`: API clients, runtime loop, installer, startup, logging, and native bridge adapter.
- `lib/src/pages`: overview, messages, settings, and installer UI.
- `lib/src/theme`: shared design tokens and motion constants.
- `windows/runner`: Win32 bridge for tray, single instance, foreground activity, registry config/startup, folder picker, process launch, and SHA-256.

The resident runtime uses a single scheduled loop. A tick schedules the next tick only after it completes, so slow network calls cannot pile up overlapping work.

## API Contract

The client is a `desktop_message` device.

- Reports foreground state to `POST /api/report`.
- Reads pending device messages from `GET /api/messages`.
- Reads display history from `GET /api/messages/history`.
- Sends command receipt/result frames to `POST /api/supervision/ack`.
- Reports capabilities as snake_case boolean fields: `freeze`, `unfreeze`, `vibrate`, `screen_off`, `say`, `risk_app_monitor`, `app_time_limit`.

Desktop supports `say` only. Android/LSP-only commands return structured unsupported results.

## Build

```powershell
$env:WINDOWS_SKIP_SIGNING = "true"
.\build-flutter.ps1 -Mode Both -Configuration Release
```

Outputs:

- `dist\portable`
- `dist\install`
- `dist\packages\LiveDashboardAgent-portable-win-x64.zip`
- `dist\packages\LiveDashboardAgent-installer-win-x64.zip`

The executable is not a true single-file app; keep `LiveDashboardAgent.exe`, `flutter_windows.dll`, and `data\` together.

## Signing

`sign-windows.ps1` supports trusted PFX/thumbprint signing, temporary self-signing, or unsigned debug builds via:

- `WINDOWS_CODESIGN_CERT_BASE64`
- `WINDOWS_CODESIGN_CERT_PATH`
- `WINDOWS_CODESIGN_CERT_THUMBPRINT`
- `WINDOWS_CODESIGN_CERT_PASSWORD`
- `WINDOWS_SELF_SIGN=true`
- `WINDOWS_SKIP_SIGNING=true`
