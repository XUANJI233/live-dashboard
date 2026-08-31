# Hermes controller integration

These assets make Hermes the conversational controller while Live Dashboard remains the data and device-control service.

- `SOUL.md`: canonical teacher-and-friend identity.
- `prompts/supervision.md`: event-triggered review; normal/duplicate/low-confidence cases stay silent.
- `prompts/companion.md`: optional proactive conversation opportunity; sending is never mandatory.
- `proactive_candidate.py`: persistent 30-minute probability gate; unchanged output suppresses the agent entirely.
- `trigger_live_supervision.py`: authenticated webhook filter that stores the minimal event in the supervision cron notepad and requests an attached cron run. It prints no stdout so the webhook route itself never starts a second agent session.

Production secrets and job IDs are not stored here. Deploy the script under the Hermes profile `scripts/` directory, keep configuration files mode `0600`, bind the Hermes webhook only to the Docker bridge, and use an independent random HMAC secret.
