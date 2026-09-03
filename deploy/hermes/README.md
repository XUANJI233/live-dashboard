# Hermes controller integration

These assets make Hermes the conversational controller while Live Dashboard remains the data and device-control service.

- `SOUL.md`: routes relationship and supervision work into the canonical persona skill without duplicating it.
- `skills/strict-study-girlfriend/`: canonical relationship, initiative, teaching strategy, and user-facing voice.
- `skills/live-mentor/`: Live observation, trust, deduplication, mode, and device-authorization adapter.
- `prompts/supervision.md`: event-triggered review; normal/duplicate/low-confidence cases stay silent.
- `prompts/companion.md`: rate-limited proactive opportunity where speaking is the default when grounded context exists.
- `proactive_candidate.py`: persistent 30-minute probability gate; unchanged output suppresses the agent entirely.
- `followup_candidate.py`: reawakens Hermes after 5, 15, and 30 minutes, then hourly until a later user reply (12-hour stale-root bound); screen-off starts at 15 minutes and confirmed sleep suppresses the model before invocation.
- `live_state_gate.py`: deterministic pre-model sleep/screen-off gate fed by Live `/api/current`; failures degrade to the slower unknown-state cadence.
- `usage_summary.py`: read-only UTC+08:00 per-job cron token accounting from `usage_audit.jsonl`; it observes usage and never enforces a budget.
- `get_controller_context`: returns equivalent compact JSON text and structured views capped at 24 KB. Compatible clients always see the complete bounded object; the Hermes adapter removes the duplicate before model context, keeping its result below the 50K-character spillover threshold without imposing a model-token budget.
- `configure_cron_efficiency.py`: replaces the six controller prompts and clears `context_from:self` without changing pause/resume state.
- `hermes-gateway-strict-skills.conf`: forces the complete strict persona stack into every Weixin DM session instead of relying on implicit skill selection.
- `trigger_live_supervision.py`: authenticated webhook router for supervision and Live AI work requests; it stores a bounded event, wakes the existing supervision/daily/weekly job, and emits a non-dispatching durable ACK.
- `configure_live_webhook_ack.py`: enables `script_ack_required` on the existing Live subscription so script failure returns a retryable HTTP error and success returns a matching durable ACK.

Production secrets and job IDs are not stored here. Deploy the scripts under the Hermes profile `scripts/` directory, keep configuration files mode `0600`, bind the Hermes webhook only to the Docker bridge, and use an independent random HMAC secret. Configure `HERMES_LIVE_SUPERVISION_JOB_ID`; all on-demand Live AI requests use that one durable batch consumer, while daily/weekly scheduled jobs keep their own schedules.

Set `HERMES_CONTROLLER_ENABLED=true` in both the Live container environment and the Hermes profile environment. In this mode, attach both `live-mentor` and `strict-study-girlfriend` to the supervision, companion, memory, daily-summary, and weekly-summary jobs. The former controls facts and authority; the latter controls relationship and output. To use Live AI fallback, explicitly set the flag to `false`, pause those Hermes jobs, and restart Live; never switch automatically from a health probe because that can create two active controllers.

Before enabling unattended jobs, obtain the user's explicit consent, save `supervision_enabled=true`, initialize the Live controller persona with `enabled=true`, and verify current supervision sub-settings. The master supervision switch is the proactive-contact and device-action grant; enabled subsettings narrow vibration and LSP freeze/unfreeze. Persona `enabled` controls whether strict voice is active, not consent by itself. A user pause sets persona `enabled=false`; all unattended prompts must re-read both records and stay silent until an explicit resume.
