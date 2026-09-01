# Hermes controller integration

These assets make Hermes the conversational controller while Live Dashboard remains the data and device-control service.

- `SOUL.md`: routes relationship and supervision work into the canonical persona skill without duplicating it.
- `skills/strict-study-girlfriend/`: canonical relationship, initiative, teaching strategy, and user-facing voice.
- `skills/live-mentor/`: Live observation, trust, deduplication, mode, and device-authorization adapter.
- `prompts/supervision.md`: event-triggered review; normal/duplicate/low-confidence cases stay silent.
- `prompts/companion.md`: rate-limited proactive opportunity where speaking is the default when grounded context exists.
- `proactive_candidate.py`: persistent 30-minute probability gate; unchanged output suppresses the agent entirely.
- `trigger_live_supervision.py`: authenticated webhook filter that stores the minimal event in the supervision cron notepad and requests an attached cron run. It prints no stdout so the webhook route itself never starts a second agent session.

Production secrets and job IDs are not stored here. Deploy the script under the Hermes profile `scripts/` directory, keep configuration files mode `0600`, bind the Hermes webhook only to the Docker bridge, and use an independent random HMAC secret.

Set `HERMES_CONTROLLER_ENABLED=true` in both the Live container environment and the Hermes profile environment. In this mode, attach both `live-mentor` and `strict-study-girlfriend` to the supervision, companion, memory, daily-summary, and weekly-summary jobs. The former controls facts and authority; the latter controls relationship and output. To use Live AI fallback, explicitly set the flag to `false`, pause those Hermes jobs, and restart Live; never switch automatically from a health probe because that can create two active controllers.
