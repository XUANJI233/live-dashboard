# Hermes controller integration

These assets make Hermes the conversational controller while Live Dashboard remains the data and device-control service.

- `SOUL.md`: routes relationship and supervision work into the canonical persona skill without duplicating it.
- `skills/strict-study-girlfriend/`: canonical relationship, initiative, teaching strategy, and user-facing voice.
- `skills/live-mentor/`: Live observation, trust, deduplication, mode, and device-authorization adapter.
- `prompts/supervision.md`: event-triggered review; normal/duplicate/low-confidence cases stay silent.
- `prompts/companion.md`: rate-limited proactive opportunity where speaking is the default when grounded context exists.
- `proactive_candidate.py`: persistent 30-minute probability gate; unchanged output suppresses the agent entirely.
- `followup_candidate.py`: reawakens Hermes after 5, 15, and 30 minutes, then hourly until a later user reply (12-hour stale-root bound); screen-off starts at 15 minutes and confirmed sleep suppresses the model before invocation.
- `usage_summary.py`: read-only UTC+08:00 per-job cron token accounting from `usage_audit.jsonl`; it observes usage and never enforces a budget.
- `get_controller_context`: returns equivalent compact JSON text and structured views capped at 24 KB. Compatible clients always see the complete bounded object; the Hermes adapter removes the duplicate before model context, keeping its result below the 50K-character spillover threshold without imposing a model-token budget.
- `configure_cron_efficiency.py`: replaces the six controller prompts and clears `context_from:self` without changing pause/resume state.
- `hermes-gateway-strict-skills.conf`: forces the complete strict persona stack into every Weixin DM session instead of relying on implicit skill selection.
- `trigger_live_supervision.py`: authenticated webhook router for supervision and Live AI work requests; it validates the event (the contract fixture `tests/fixtures/controller_events.json` is shared with Live's outbox), posts it as a `session-event` into the one shared Hermes session through the gateway control socket (6 s wait), and emits the durable ACK only after the gateway's receipt. Supervision events are framed by the supervision job's prompt; daily, weekly, and policy work get a short preamble for their own `live-mentor` mode instead.
- `live_state_gate.py`: deterministic rest-state read for the candidate scripts. It calls the Live MCP tool `live_dashboard.get_rest_state` on the local listener (`LIVE_DASHBOARD_MCP_URL`, default `http://127.0.0.1:3031/api/mcp`) with `LIVE_DASHBOARD_MCP_TOKEN` (or `MCP_SERVER_TOKEN`); any failure reads as `unknown`, which never suppresses contact.
- `configure_live_webhook_ack.py`: enables `script_ack_required` on the existing Live subscription so script failure returns a retryable HTTP error and success returns a matching durable ACK.

Production secrets and job IDs are not stored here. Deploy the scripts under the Hermes profile `scripts/` directory, keep configuration files mode `0600`, bind the Hermes webhook only to the Docker bridge, and use an independent random HMAC secret. Configure `HERMES_LIVE_SUPERVISION_JOB_ID`; all on-demand Live AI requests use that one durable batch consumer, while daily/weekly scheduled jobs keep their own schedules.

Set `HERMES_CONTROLLER_ENABLED=true` in both the Live container environment and the Hermes profile environment. In this mode, attach both `live-mentor` and `strict-study-girlfriend` to the supervision, companion, memory, daily-summary, and weekly-summary jobs. The former controls facts and authority; the latter controls relationship and output. To use Live AI fallback, explicitly set the flag to `false`, pause those Hermes jobs, and restart Live; never switch automatically from a health probe because that can create two active controllers.

Before enabling unattended jobs, obtain the user's explicit consent, save `supervision_enabled=true`, initialize the Live controller persona with `enabled=true`, and verify current supervision sub-settings. The master supervision switch is the proactive-contact and device-action grant; enabled subsettings narrow vibration and LSP freeze. Live enforces these switches on `send_device_commands` for every controller (dropped actions come back as `supervision_disabled`, `freeze_disabled_by_user` or `vibrate_disabled_by_user`); unfreeze, say and screenshots are never gated. Persona `enabled` controls whether strict voice is active, not consent by itself. A user pause sets persona `enabled=false`: Live then stops waking Hermes for reviews, device requests and offline events (hard limits already on the phone stay in force), and all unattended prompts must still re-read both records and stay silent until an explicit resume.

## Token budget

Every Hermes wake is a full agent turn, so cost grows with how often Live wakes Hermes and with what each wake carries. Fixed payload measured on 2026-10-25:

- `live_dashboard` MCP tool schemas: 31 tools, about 30 KB (7-9K tokens), sent with every model call.
- `strict-study-girlfriend`: `SKILL.md` about 9 KB, `references/voice.md` about 12 KB, `references/conditioning-and-verification.md` about 43 KB (9-14K tokens). A file loaded with `skill_view` stays in the session until compaction.
- `live-mentor`: `SKILL.md` and `REFERENCE.md` together about 13 KB.
- `get_controller_context`: up to 24 KB per call.

The prompts check deterministic gates before loading strict references and treat skills and references as conversation-scoped: a file whose full text is already in the session is reused instead of loaded again for every event. Every user-facing reply or device action still loads the references its mode requires. Live merges repeated rule-matched reports into one review per device per 10 minutes, and does not wake Hermes for a due periodic review whose usage digest is materially unchanged since the last delivered one (at most two skips in a row, never once that review is four hours old); explicit device requests are never merged or skipped. Supervision, companion, and follow-up contexts carry a whole-window `usage_digest` and only the newest timeline segments, so older detail is one `get_device_timeline` call away instead of riding along on every wake.

Any wake that continues a long-lived session also replays that session's history: the Weixin DM session always does, and with `session_events` enabled every Live event and companion or follow-up candidate continues one shared session (`session_events.session_key`). Upstream Hermes compacts only at `compression.threshold` of the model context window (50% by default, at least 75% for windows under 512K), so on a large-window model one wake can replay hundreds of thousands of tokens. Cap long-lived sessions in the Hermes profile `config.yaml` and tune the value from measurements:

```yaml
compression:
  threshold_tokens: 100000
  idle_compact_after_seconds: 1800
```

`idle_compact_after_seconds` trades one summary call for smaller replays across the steps of a wake that arrives after 30 idle minutes; keep it only if totals drop. Measure before and after with `hermes insights --days 7` (tokens by source), `hermes prompt-size` (system prompt, skills index, and tool schemas), and `usage_summary.py` (cron jobs, including `silent_calls`, which is spend that ended in `[SILENT]`). Check whether session-event wakes appear in `cron/usage_audit.jsonl`; if they do not, `hermes insights` is the only place they are counted.
