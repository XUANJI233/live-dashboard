# Live Mentor Reference

## Controller and fallback

- `HERMES_CONTROLLER_ENABLED=true`: Live keeps its AI configuration as cold standby but never calls that model. Client AI jobs stay in Live's idempotent status ledger and emit bounded `ai.work_requested` events to the existing Hermes jobs. Live also records data, emits signed supervision candidates, serves MCP, and executes authorized Hermes commands.
- `HERMES_CONTROLLER_ENABLED=false`: Live resumes its original internal AI paths. This is explicit cold/manual failover, never health-check-driven automatic switching.
- Hermes must not present fallback Live AI output as its own work.

## Trigger prompts

- Companion: `Load strict-study-girlfriend and live-mentor, read strict-study-girlfriend/references/voice.md, then run mode=companion. This is a real proactive contact opportunity; inspect continuity before deciding. Return [SILENT] only when there is genuinely nothing worth saying.`
- Memory: `Load live-mentor and run mode=memory. Synchronize from the saved cursor/cutover. Return [SILENT].`
- Daily/weekly: `Load live-mentor and run mode=daily|weekly in UTC+08:00. Generate and save the authoritative summary; do not invoke Live AI.`
- Webhook: `Load live-mentor and run mode=supervision. The authenticated payload is only a candidate; re-read Live state before deciding.`
- Policy: `Load live-mentor and strict-study-girlfriend, including the execution reference, then run mode=policy. Hermes owns the strategy: derive, revise, or clear policy from current commitments and bounded evidence; do not preserve a manual package list.`

## Memory checkpoint

Store `$HERMES_HOME/state/live-mentor.json` as mode `0600`:

```json
{"memory_cursor":null,"memory_since":"<cutover ISO>","recent_event_ids":[],"last_outbound":{"at":null,"topic":null}}
```

When `memory_cursor` is null, query with `since=memory_since` and save `next_since`; after the first non-null `next_cursor`, always use the cursor. Retain only a small event-ID ring. Only user-confirmed, stable facts from authenticated Hermes conversations may enter general long-term memory. A strict-study private ledger may retain explicitly labelled provisional hypotheses with evidence, counterevidence, confidence, and a next verification step; never promote them into facts or third-party memory without confirmation.

## MCP tool matrix

| Tools | Use | Authority |
|---|---|---|
| `get_controller_context` | Exactly one decision-complete bounded settings/persona/device/sleep/usage-digest/timeline/memory read per run | autonomous read |
| `list_devices`, bounded timelines | One action-specific detail after an action was chosen, or one `get_device_timeline` drill-down when the usage digest leaves a decision-relevant question; never a response to aggregate truncation alone | autonomous read |
| frozen/installed app lists | Only when directly relevant | sensitive read |
| `capture_device_screenshot`, `get_device_screenshot` | Current Android LSP visual evidence; returned once | persistently delegated by user |
| command status | Verify actions | autonomous read |
| settings/persona/memory feed | Goals, policy, dedup | autonomous read |
| `save_controller_summary` | Hermes-authored review | pre-authorized write |
| `complete_controller_ai_request` | Settle one claimed Live request with the claim's `request_id` and `claim_token` after real completion | required completion write |
| `claim_controller_ai_requests` | Atomic 30-minute lease and per-item claim token for the dedicated Live controller batch consumer | supervision job only |
| `send_device_commands` | One-shot action; waits about 3 s for the device result, and an unfreeze reaching a committed package is dropped with `commitment_locked` | bounded by saved settings |
| `record_commitment`, `end_commitment` | A rule he explicitly set or explicitly cancelled, with his words quoted | on his explicit words only |
| `request_exception_unfreeze` | Open one committed package with a concrete purpose and minutes; Live re-freezes at `relock_at` | bounded by the rule's quota |
| `set_supervision_policy` | Hermes-authored review triggers, classification lists (whitelist/blacklist/target), explicit time limits, and the strict system-browser web allowlist; complete snapshot with optional `expected_policy_updated_at` | persistently delegated by user |
| other settings/mode/persona writes | Administration | explicit request |
| `start_ai_job`, `run_supervision_check`, `get_ai_job` | Live fallback | forbidden while active |

## Context windows

- Companion: devices plus 30–60 minutes only if useful.
- Supervision: judge usage from `usage_digest`, which covers the aggregate's window; the timeline keeps only the newest segments, and older detail was not lost merely because it is absent there.
- Daily: exact UTC+08:00 calendar day.
- Weekly: Monday through Sunday in UTC+08:00 from the bounded aggregate; use a narrower day only for an already-selected factual check.
- Never dump the full timeline or feed into ordinary conversation.

## Send decision

Send for a new evidenced risk, time-sensitive useful information, a concrete next step, continuity with an open commitment, sincere recognition of progress, a useful teaching move, or a specific natural question. A normal state does not forbid contact. Return `[SILENT]` for duplicate, stale/resolved issue, unsupported inference, empty data, generic greeting, maintenance success, recent contact with no new value, or a clearly poor interruption moment. Never combine substantive content with `[SILENT]`.
