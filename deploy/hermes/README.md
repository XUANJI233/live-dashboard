# Hermes controller integration

These assets make Hermes the conversational controller while Live Dashboard remains the data and device-control service.

- `SOUL.md`: routes relationship and supervision work into the canonical persona skill without duplicating it.
- `skills/strict-study-girlfriend/`: canonical relationship, initiative, teaching strategy, and user-facing voice.
- `skills/live-mentor/`: Live observation, trust, deduplication, mode, and device-authorization adapter.
- `prompts/supervision.md`: event-triggered review; normal/duplicate/low-confidence cases stay silent.
- `prompts/companion.md`: rate-limited proactive opportunity where speaking is the default when grounded context exists.
- `proactive_candidate.py`: persistent 30-minute probability gate; unchanged output suppresses the agent entirely.
- `followup_candidate.py`: reawakens Hermes every five minutes after a successful proactive Weixin output until a later user reply (12-hour stale-root bound).
- `hermes-gateway-strict-skills.conf`: forces the complete strict persona stack into every Weixin DM session instead of relying on implicit skill selection.
- `trigger_live_supervision.py`: authenticated webhook filter that stores the minimal event in the supervision cron notepad and requests an attached cron run. It prints no stdout so the webhook route itself never starts a second agent session.

Production secrets and job IDs are not stored here. Deploy the script under the Hermes profile `scripts/` directory, keep configuration files mode `0600`, bind the Hermes webhook only to the Docker bridge, and use an independent random HMAC secret.

Set `HERMES_CONTROLLER_ENABLED=true` in both the Live container environment and the Hermes profile environment. In this mode, attach both `live-mentor` and `strict-study-girlfriend` to the supervision, companion, memory, daily-summary, and weekly-summary jobs. The former controls facts and authority; the latter controls relationship and output. To use Live AI fallback, explicitly set the flag to `false`, pause those Hermes jobs, and restart Live; never switch automatically from a health probe because that can create two active controllers.

Before enabling unattended jobs, obtain the user's explicit consent, save `supervision_enabled=true`, initialize the Live controller persona with `enabled=true`, and verify current supervision sub-settings. The master supervision switch is the proactive-contact and device-action grant; enabled subsettings narrow vibration and LSP freeze/unfreeze. Persona `enabled` controls whether strict voice is active, not consent by itself. A user pause sets persona `enabled=false`; all unattended prompts must re-read both records and stay silent until an explicit resume.
