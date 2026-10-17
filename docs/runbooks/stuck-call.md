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
5. After a process crash the service reconciles orphaned calls at startup (`recoverOrphanedCalls`): the provider **confirming** the end ⇒ `failed`/`ended`; anything else (active, unknown) ⇒ `outcome_unknown` for every in-flight state; never redials. The same rule applies while running: a call whose end is not proven (no terminal event and no provider confirmation after a bounded hangup) is persisted as `outcome_unknown`.
6. An `outcome_unknown` call also keeps its **budget reservation** until you resolve it; resolving settles it exactly once.

## Re-enabling calls after "stop calling me"

The owner's "stop calling me" sets `owners.call_opt_out = true`, which denies **every** call (owner and contact) with `owner_opted_out` until it is cleared. There is no chat command for this yet. Only on the owner's explicit request, an operator with the migrator/bootstrap role runs:

```sql
UPDATE owners SET call_opt_out = false WHERE id = '<owner uuid>';
```

Requests cancelled by the opt-out stay cancelled and their authorizations stay revoked; new calls need a fresh request and approval.
