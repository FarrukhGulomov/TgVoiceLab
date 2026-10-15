# Stuck call / `outcome_unknown`

`outcome_unknown` means the dial request may or may not have reached Telegram. It deliberately **occupies the account** (no new call can start) and is never auto-retried.

1. Find it: `SELECT id, state, end_reason, started_at FROM calls WHERE state NOT IN ('ended','rejected','cancelled','expired','declined','busy','no_answer','failed','consent_denied');`
2. **Look at the real assistant account / phone.** Is a call in progress or ringing? If yes, end it from the Telegram client.
3. Only when you have confirmed there is no live call:
   ```bash
   curl -s -X POST $API/v1/calls/<callId>/resolve-unknown -H "$AUTH" -H "Idempotency-Key: r-$(date +%s)" \
     -H 'content-type: application/json' -d '{"operatorConfirmsNoLiveCall":true,"note":"checked phone, no call in progress"}'
   ```
   The call becomes `ended`; the action is audited. A retry still needs a **fresh explicit authorization** — the old one is consumed.
4. A live call the supervisor lost: `POST /v1/calls/<callId>/cancel` (idempotent), or [kill-switch.md](kill-switch.md).
5. After a process crash the service reconciles orphaned calls at startup (`recoverOrphanedCalls`): provider says ended ⇒ `failed`; unknown ⇒ `outcome_unknown`; never redials.
