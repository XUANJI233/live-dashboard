# Live Dashboard Zepp Watch Companion

Low-power Zepp OS companion app for Amazfit / Huami watches.

Health Connect via the Zepp phone app can be enough for normal health history,
but it is not a realtime watch-status channel and may not expose every metric.
This companion is intentionally conservative:

- no automatic high-frequency uploads;
- default minimum sync interval is 5 minutes, clamped to 2-60 minutes;
- manual sync is limited to at most once every 30 seconds;
- heart rate is sampled only when the page is opened or the user manually syncs;
- no notification text, keyboard text, clipboard, or background app data is read;
- phone-side service uploads through the same Live Dashboard device token.

Configure the app-side settings storage keys from the Zepp companion settings UI:

| Key | Value |
| --- | --- |
| `serverUrl` | `https://your-dashboard.example.com` |
| `token` | Live Dashboard device token |
| `relayMode` | Optional, defaults to `phone-side` |
| `minIntervalMs` | Optional, defaults to `300000` |

`phone-side` is the recommended low-power relay mode. The watch mini app sends
only a small snapshot to the Zepp phone-side service via ZML messaging; the phone
side then performs HTTPS uploads. This follows the official Zepp OS app-side
service model and avoids keeping the watch radio awake for direct uploads.

The phone-side service posts:

- `/api/report` with `app_id="zepp_watch"` and `extra.device.capability_mode="normal"`;
- `/api/health-data` for supported readings such as `heart_rate`.

This project uses ZML (`@zeppos/zml`) and targets Zepp OS API 3.0+.

Build with the official Zepp OS CLI:

```sh
npm install
npm install -g @zeppos/zeus-cli
zeus build
```

The package is written to `dist/`.
