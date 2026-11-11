# Media outage / model outage

**Media (call engine or network):** calls end as `transport_error`; reports are marked incomplete (`complete=false`); no automatic redial. Tasks and reminders are unaffected
(call-mode reminders degrade to labeled messages). Engage the [kill switch](kill-switch.md) if the engine is flapping, fix, then re-run the live canary
(`pnpm spike:call`) before re-enabling.

**Model outage (when the Realtime/text adapter exists):** on model disconnect the design is to stop generated playback and privileged tools, optionally play a neutral local
message, and end the call; the MVP never resumes an ambiguous conversation. Today there is no model dependency: the rules interpreter is local.

**Telegram outage:** inbound is lost until reconnect; on restart the gateway re-scans the owner chat for messages from the last 24 h (older ones are ignored on purpose) and durable
dedupe prevents double-processing. Outbound messages wait in the outbox with backoff.

**Database outage:** `/health/ready` returns 503; the API and workers cannot make progress; committed state is not lost.
