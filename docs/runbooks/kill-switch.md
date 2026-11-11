# Kill switch (stop calling)

Persisted in PostgreSQL, independent of any model. Default for a new owner is **ON**.

```bash
curl -s -X POST $API/v1/operations/kill-switch -H "$AUTH" -H "Idempotency-Key: ks-$(date +%s)" \
  -H 'content-type: application/json' -d '{"on":true,"reason":"incident 2026-10-15"}'
```

Effects, in order: the flag is committed (new dials are refused inside the dial transaction), queued call requests are cancelled, then live calls are ended
(`cancelled`). The response reports `terminated` and `elapsedMs`. Target on a healthy local control path: under 2 s.

Turn it off only deliberately: `{"on":false,"reason":"…"}`. Verify with `GET /v1/capabilities` → `calling.killSwitchOn`.

Without API access: `UPDATE operation_settings SET calling_kill_switch=true, version=version+1;` (audit this change manually).

## From the owner chat

The owner can also use the switch from the assistant chat (no admin token needed):

- **ON** (stops calling at once, ends calls in progress): `kill switch on`, `barcha qo'ng'iroqlarni to'xtat`, `favqulodda to'xtat`, `emergency stop`.
- **OFF** (asks first; only a plain «ha» confirms): `kill switch off`, `qo'ng'iroqlarni qayta yoq`. If the build has no live evidence the answer says that calls still cannot start and why.

Needs migration `0017_confirm_kill_switch_off_draft.sql` (`pnpm db:migrate`). Only the owner's own chat is accepted; strangers are ignored.
