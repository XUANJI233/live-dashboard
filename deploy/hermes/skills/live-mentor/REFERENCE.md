# Live Mentor Reference

This page is a declared preload of `live-mentor`; reuse its full text already in context instead of loading it twice.

## Controller and fallback

- `HERMES_CONTROLLER_ENABLED=true`: Live keeps its AI configuration as cold standby but never calls that model. Client AI jobs stay in Live's idempotent status ledger and emit bounded `ai.work_requested` events to the existing Hermes jobs. Live also records data, emits signed supervision candidates, serves MCP, and executes authorized Hermes commands.
- `HERMES_CONTROLLER_ENABLED=false`: Live resumes its original internal AI paths. This is explicit cold/manual failover, never health-check-driven automatic switching.
- Hermes must not present fallback Live AI output as its own work.

## Trigger prompts

- Companion: `Load strict-study-girlfriend and live-mentor, read strict-study-girlfriend/references/voice.md, then run mode=companion. This is a real proactive contact opportunity; inspect continuity before deciding. Return [SILENT] only when there is genuinely nothing worth saying.`
- Memory: `Load live-mentor and run mode=memory. Consume the server-kept hermes-memory feed with advance:true; replay a failed batch from its original consumer.previous_cursor. Return [SILENT].`
- Daily/weekly: `Load live-mentor and run mode=daily|weekly in UTC+08:00. Generate and save the authoritative summary; do not invoke Live AI.`
- Webhook: `Load live-mentor and run mode=supervision. The authenticated payload is only a candidate; re-read Live state before deciding.`
- Policy: `Load live-mentor and strict-study-girlfriend, including the execution reference, then run mode=policy. Hermes owns the strategy: derive, revise, or clear policy from current commitments and bounded evidence; do not preserve a manual package list.`

## Server-side memory consumer

Live owns the cursor. After the single memory-mode context read passes the settings/persona gate, call `live_dashboard.get_controller_memory_feed` with:

```json
{"consumer_id":"hermes-memory","advance":true,"limit":100}
```

Process one batch fully before the next call; repeat while `has_more=true`. Omit `cursor`/`since` for normal continuation. Only the first cutover read may add the actual cutover `since`; without it a new consumer starts at the newest batch. Keep `event_types` and `include_*` filters fixed for this consumer. The aggregate's recent-event tail is not this consumer batch. No local cursor/state file or file permissions are required.

**Reading advances the cursor before processing.** Retain the returned batch and its original `consumer.previous_cursor`. If processing fails, finish that retained batch or reread with the same `consumer_id`, `advance:true`, unchanged filters/limit, the original response's `until`, and `cursor` set to that original non-null value. Reuse the original replay start on repeated failure; a retry's `consumer.previous_cursor` is the current stored position, not necessarily the failed batch's start. Do not fetch later batches while this one is unfinished. When the original value is null, reuse the retained batch or original cutover `since`; never send `cursor:null` or silently continue from the advanced position. Deduplicate replayed `event_id`s against completed writes; duplicates are not new supporting evidence.

Stable facts still need reliable confirmation; an unverified correction or completion claim is not confirmed by repetition. Keep `live-memory-sync` paused during this documentation migration; editing these files does not resume or reconfigure the job.

Psychological profiling is proactively delegated. Persist concise psychological states, defense mechanisms, vulnerabilities, motivational patterns and tested approaches in Hermes `memory` with top-level `target:"user"`, using explicit hypothesis/observation/tested-strategy labels, recency, evidence or ledger IDs, confidence, counterevidence and the next practical use. Do not wait for the user to endorse each formulation. Use supported low-confidence hypotheses to choose a method, then update their effect; never recast them as verified facts or clinical diagnoses.

Use the actual Live `ledger_open` / `ledger_update` tools for evidence-backed hypotheses (`helps`/`blocks`), bounded states, promises and debts. The context already carries due/open records and selected hypotheses; search older details only when relevant. No ordinary file writer is required. If ledger tools are unavailable, retain a concise labelled profile through Hermes `memory`; if neither write exists, keep it in-session and do not claim persistence. The mixed memory-feed job never invents or changes a ledger item.

## MCP tool matrix

| Tools | Use | Authority |
|---|---|---|
| `get_controller_context` | Exactly one decision-complete bounded settings/persona/devices/rest/usage/ledger/history/memory read per run | autonomous read |
| `list_devices`, `get_activity_history` | One action-specific detail or one `get_activity_history` drill-down for a concrete evidence gap; verification may precede an action, never solely because aggregate output was truncated | autonomous read |
| frozen/installed app lists | Only when directly relevant | sensitive read |
| `capture_device_screenshot`, `get_device_screenshot` | Current Android LSP visual evidence; returned once | persistently delegated by user |
| command status | Read only for `results_pending=true`; for policy tools without that flag, only an `unknown` result with `sent`/`queued` delivery needs follow-up | autonomous read |
| settings/persona/memory feed | Goals, policy, dedup | autonomous read |
| `get_accounting_summary`, `get_accounting_bills` | Use SQL summary for sums/counts/groups; bill details default to 50, maximum 200 per page. Never page bill lists to add totals | relevant bounded read |
| `save_controller_summary` | Hermes-authored review | pre-authorized write |
| `complete_controller_ai_request` | Settle one claimed Live request with the claim's `request_id` and `claim_token` after real completion | required completion write |
| `claim_controller_ai_requests` | Atomic 30-minute lease and per-item claim token for the dedicated Live controller batch consumer | supervision job only |
| `send_device_commands` | One-shot action; waits about 3 s and returns command results. Query status only if `results_pending=true`; a terminal failure is handled directly. An unfreeze reaching a committed package is dropped with `commitment_locked` | bounded by saved settings |
| `record_commitment`, `end_commitment` | Long-lived package block rules only, quoting his words; changes follow the non-execution review window. One-off promises are never recorded or finished here | explicit words and rule-change procedure |
| `ledger_open`, `ledger_update` | `promise` for his one-off promise; `debt/task` for owed or autonomously assigned goal tasks; checked `kept`/`paid` outcomes; `hypothesis`/`state` for active psychological profiling. Verify real evidence and write result | delegated profiling; promises require his words |
| `ledger_search` | Older or missing ledger detail, using kind/topic and `include_evidence:true`; due/open records already arrive in context | relevant bounded read |
| Hermes `memory` | Persist and actively use labelled longitudinal psychological profiles with `target:"user"`; add/patch supported states, defenses, vulnerabilities and effective strategies | proactively delegated, no per-hypothesis confirmation |
| `request_exception_unfreeze` | Open one committed package with a concrete purpose and minutes; Live re-freezes at `relock_at` | bounded by the rule's quota |
| `set_supervision_policy` | Hermes-authored review triggers, classification lists (whitelist/blacklist/target), explicit time limits, and the strict system-browser web allowlist; complete snapshot with optional `expected_policy_updated_at` | persistently delegated by user |
| other settings/mode/persona writes | Administration | explicit request |
| `start_ai_job`, `run_supervision_check`, `get_ai_job` | Live fallback | forbidden while active |

## Context windows

- Companion: devices plus 30–60 minutes only if useful.
- Supervision: for an ordinary single-device supervision/offline event, pass `device_id=event.device_ids[0]` to the one context call. The tool has no `device_ids` argument; multiple-device events use one unfiltered aggregate and restrict judgment to the event IDs. Judge usage from `usage_digest`; use one targeted history read or relevant current screenshot to resolve a concrete gap, never a second aggregate.
- Daily: exact UTC+08:00 calendar day.
- Weekly: Monday through Sunday in UTC+08:00 from the bounded aggregate; use a narrower day only for an already-selected factual check.
- Daily/weekly execution claims use `enforcement` for the requested range: reminders, freezes and rule enforcement. Inspect command `result`/`notes`; issued or pending is not applied. Totals cover the range even when the command list is truncated; omitted detail does not mean no action.
- `ledger.due`: omit its scheduler placeholder from the context filter; process `ledger.due_now` with `ledger.open`, then verify and update records without a second aggregate.
- `usage_today`: current-day totals from the returned day/timezone, not a recent-window extrapolation. `installed_changes`: installation/removal evidence to check, never automatic proof of bypass.
- Never dump full activity history, the feed, or the psychological profile into ordinary conversation.

## Send decision

Send for a new evidenced risk, time-sensitive useful information, a concrete next step, continuity with an open commitment, sincere recognition of progress, a useful teaching move, or a specific natural question. A normal state does not forbid contact. Return `[SILENT]` for duplicate, stale/resolved issue, unsupported inference, empty data, generic greeting, maintenance success, recent contact with no new value, or a clearly poor interruption moment. Never combine substantive content with `[SILENT]`.
