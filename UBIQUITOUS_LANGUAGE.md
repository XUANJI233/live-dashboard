# Ubiquitous Language

## Activity and reporting

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Device** | A phone, watch, or privileged Android process that can report state to the dashboard. | Phone, client |
| **Capability mode** | The selected collection path for a device, such as normal app reporting or LSPosed reporting. | Mode, root mode |
| **Foreground activity** | The app, activity, browser page, or window title that the device currently sees as active. | Current app, page title |
| **Media state** | The current playback title, artist, app, package, and playback state reported by Android media APIs. | Music status, video status |
| **Upload status** | The most recent local result for a report category, including success, time, and error detail. | Sync status, send status |

## Messaging

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Visitor** | A browser-side person or session that can send private or public messages. | Guest, viewer |
| **Private conversation** | A message thread between the administrator device and one visitor. | Private chat, DM |
| **Public board** | A shared message stream visible independently from any single visitor conversation. | Public chat,留言板 |
| **Viewer remark** | The administrator's synced note attached to a visitor identity. | Note, nickname |
| **Blocked visitor** | A visitor identity that the administrator has muted or blocked from further interaction. | Blacklist item |

## Health

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Health Connect** | Android's health data provider used by the app for permissioned health records. | Google Fit |
| **Health record** | A timestamped metric read from Health Connect and uploaded to the server. | Body info, sensor item |
| **Background health sync** | A WorkManager job that uploads health records without the user keeping the app open. | Auto health upload |
| **Manual full sync** | A user-triggered health upload that rereads the supported historical window. | Full upload |

## Zepp watch sync

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Zepp Device App** | The watch-side Zepp OS code that reads sensor APIs, schedules single-execution App Service alarms, and sends compact payloads over the Zepp bridge. | Watch client, background daemon |
| **Zepp Companion Side Service** | The phone-side Zepp companion service that stores settings, expands compact watch payloads, retries pending uploads, and calls the Live Dashboard HTTP APIs. | Phone app, uploader app |
| **Zepp Settings App** | The settings page inside the Zepp phone app where the user enters server URL, token, interval, enabled state, and sensor toggles. It does not collect sensors or upload data directly. | Config UI, companion UI |
| **Single-execution App Service** | A Zepp App Service run invoked by alarm, notification, or system event, expected to finish and be reclaimed by the system after the code path completes. | Background service, resident process |
| **Sleep upload cadence** | During sleep, Zepp watch sync follows the Zepp Sleep API's 30-minute system update cadence and schedules the next alarm for 30 minutes instead of waking at the normal sync interval. | Sleep skip counter |
| **Reported offline timeout** | A device-reported grace period, in minutes, that tells the server how long the device may be silent before it should be marked offline; Zepp sleep uses 35 minutes for a 30-minute alarm cadence. | Sync interval, heartbeat interval |
| **Background service permission** | The `device:os.bg_service` permission for continuously running Zepp App Services started through `@zos/app-service.start`; it is not required for the watch's alarm/event-driven single-execution flow. | Background permission |

## Relationships

- A **Device** reports one **Upload status** per report category.
- A **Visitor** may have one **Private conversation** and may also post to the **Public board**.
- A **Public board** is not scoped to one **Visitor**, even when individual messages keep visitor metadata.
- **Health records** belong to **Health Connect** permissions and are uploaded by either foreground or **Background health sync**.
- A **Zepp Device App** sends compact status and health records to the **Zepp Companion Side Service**, which expands them into `/api/report` and `/api/health-data` payloads.
- A **Zepp Settings App** only writes configuration; the **Zepp Device App** and **Zepp Companion Side Service** consume that configuration.
- A **Single-execution App Service** may use alarms and system events without becoming a continuously running Zepp background service.
- A **Reported offline timeout** is server policy metadata, not the same thing as the watch's alarm delay or normal sync interval.

## Example dialogue

> **Dev:** "When the Android app says private chat, should it include public board messages?"
> **Domain expert:** "No. A **Private conversation** is visitor-scoped. The **Public board** is a separate shared stream."
> **Dev:** "For the diagnostics page, should failed health upload be shown as device information?"
> **Domain expert:** "Show it as **Upload status** for **Health records**. Device network and battery belong under **Device** state."
> **Dev:** "If LSPosed reports the browser title, is that a different feature?"
> **Domain expert:** "It is still **Foreground activity**; only the **Capability mode** changes."
> **Dev:** "Does the Zepp watch sync need background service permission?"
> **Domain expert:** "No, not for the alarm/event-driven **Single-execution App Service**. Only continuous Zepp services started through `@zos/app-service.start` need **Background service permission**."

## Flagged ambiguities

- "身体信息" was being used for phone/device state and health records. Use **Device** for battery/network/VPN and **Health record** for heart rate, blood oxygen, temperature, and similar metrics.
- "公开留言板" must remain **Public board**, not a subtype of **Private conversation**.
- "后台同步" for Zepp can mean an alarm/event-triggered **Single-execution App Service** or a continuously running service. Use the explicit term because only the continuous service needs **Background service permission**.
