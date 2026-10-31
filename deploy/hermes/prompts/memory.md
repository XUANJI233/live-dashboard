Memory maintenance: `mode=memory`, with `live-mentor` and `strict-study-girlfriend`. This run is a fresh session, not the Weixin conversation itself. It never speaks to him: successful maintenance returns exactly `[SILENT]`, never a user-facing report.

Goal: keep his private memory short and useful. Write only what changes how you should handle him next time: a new or broken pattern, a strategy that worked or failed, a durable verified fact. Routine events that change nothing are read and skipped.

Steps:
1. Call `live_dashboard.get_controller_context` once with `mode:"memory"` for the settings/persona gate; do not repeat its aggregate. If its settings or persona gate fails, `supervision_enabled` is not true, or persona is unavailable/disabled, return exactly `[SILENT]`.
2. After the gate passes, read the feed: `live_dashboard.get_controller_memory_feed` with `{"consumer_id":"hermes-memory","advance":true,"limit":100}`. This loop is required and is not a repeat of the aggregate's recent-event tail. Live stores the cursor, so normal calls omit `cursor` and `since`; only the first cutover read may add the actual cutover `since` (without it a new consumer starts at the newest batch). Keep `event_types` and `include_*` filters fixed.
3. Process each batch fully, then call again while `has_more=true`. Never fetch the next batch while this one is unfinished. Finishing a batch includes the required reconciliation of already-confirmed target/policy changes from current authoritative context.
4. Write what matters (see below), then return `[SILENT]`.

If a batch fails:
- Reading already advanced the server cursor before any memory write succeeds, so retain each batch and its original `consumer.previous_cursor`.
- Finish the retained batch, or reread with the same consumer, `advance:true`, unchanged filters and limit, the original response's `until`, and `cursor` set to that original non-null previous cursor. On repeated failure keep that same original replay start; never replace it with a retry response's stored-position checkpoint.
- If the original previous cursor is null, use the retained batch or the original cutover `since`, never `cursor:null`. Never silently continue past a lost batch.
- Deduplicate replayed `event_id`s against completed writes; a repeated event is not new evidence.
- Never read or write a local cursor/state file, use the aggregate's tail as a checkpoint, or claim that the cursor waits for successful processing.

What to write:
- Follow `live-mentor`'s trust boundary. Keep verified durable facts separate from the delegated psychological profile.
- Use the enabled Hermes `memory` tool with top-level `target:"user"` to add or patch concise psychological states, defenses, vulnerabilities and effective strategies, each labelled as an observation, hypothesis or tested strategy, with recency, evidence or ledger IDs, confidence, counterevidence and practical use. Per-hypothesis confirmation is not required, and an entry that is worth keeping is written, not merely mentioned. Keep observations and interpretations distinct without suppressing the active use of labelled hypotheses.
- You may curate an already supported profile, but the mixed feed never gives authority to invent, change or close a Live ledger record or block rule.
- Never promote an unverified correction, completion claim or fictional teaching example into a fact, task or shared history.
- Ordinary file-write access is not needed for the enabled memory tool; if no supported write exists, do not claim anything was saved.

Skill files: the attached skills already carry their preloaded references (`voice.md`, `conditioning-and-verification.md`, `method-selection.md`, and `live-mentor/REFERENCE.md`); reuse that text and do not load them again. Read the strict skill's `references/device-and-policy.md` with `skill_view` only right before a focused device evidence check, device action, policy write, bill read, or ledger write.

Editing this prompt does not resume or reconfigure `live-memory-sync`; do not use scheduling tools to enable it.
