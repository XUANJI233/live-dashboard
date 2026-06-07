# Android UI Redesign Notes

## Design read

This is an Android-native administrator utility for monitoring device reports, health sync, and visitor messages. The redesign uses a premium utilitarian minimalism direction: warm monochrome surfaces, fine borders, restrained status color, clear type hierarchy, and fewer nested panels.

## Skill references applied

- `redesign-existing-projects`: audit first, keep the existing Compose / Material 3 stack, preserve behavior, add empty/error states, and improve typography, spacing, and hierarchy before changing architecture.
- `minimalist-ui`: warm off-white canvas, thin borders, low-saturation semantic tones, crisp 10-12dp radius, no emoji-driven UI, and minimal shadows.
- `imagegen-frontend-mobile`: Android-native navigation, safe readable text, screen-first structure, consistent design bible, and no website-in-a-phone patterns.
- `design-an-interface`: shared UI primitives (`DashboardCard`, `ScreenHeader`, `StatusPill`, `InitialBadge`, `EmptyState`) provide a smaller interface for screen authors and hide repeated tone/surface decisions.
- `ubiquitous-language`: separates **Device**, **Health record**, **Private conversation**, and **Public board** so screens do not merge unrelated concepts.
- `android-performance`: validation should prefer lazy lists for long message/status streams and avoid unnecessary new dependencies or heavy runtime effects.

## Current audit

- The old UI was mostly flat `Column` / `Row` blocks with repeated surfaces, weak grouping, and inconsistent status presentation.
- Private messages used a two-pane layout that is cramped on phones.
- Public board looked like another chat thread even though it is a separate public stream.
- Health and device diagnostics mixed permission checks, sync controls, and raw debug data in one long surface.
- Health type icons used emoji glyphs, causing visual inconsistency across Android fonts.

## Redesign rules

- One calm light theme for the app.
- One reusable status/tone system for success, warning, error, info, and neutral states.
- Lazy lists for long streams: messages, public board, health types, upload statuses.
- Cards only for real grouping; no card-inside-card layout.
- Keep existing behavior and API calls unchanged unless the UI flow exposes a bug.

## 2026-06-07 IA consolidation

- Remove the global `Monika Now` app header and subtitle. The Android app should open directly into the active utility screen under the system status bar; page headers carry the context.
- Keep the bottom navigation to three destinations only: Overview, Messages, Settings.
- Merge private chat and public board into `MessagesHubScreen` with an in-page segmented control. Public board remains an independent public stream, not a visitor-specific private conversation.
- Merge setup, health, and diagnostics into `SettingsHubScreen` with an in-page segmented control. Local logs are exposed from the settings header action.
- Upload status belongs beside the relevant upload switch in setup; diagnostics should not repeat the same upload list when embedded in settings.
- When no health data types are enabled, health options stay collapsed behind a single compact card. Expanded health data type rows should appear only after explicit user intent or when some type is already enabled.
- Use native Material 3 / Compose primitives. Apply Apple-like restraint through spacing, color, and hierarchy, not through large decorative headers or web-style hero composition.
