# Recording the contact-calling gates (G0-D, G0-E, G0-F)

Contact calls need all six gates for the **current build fingerprint**. Owner-only calling (G0-A…C + G0-D5) is a separate, lighter gate.
Every result below comes from a live run through the **production adapter**; nothing can be typed in as a pass (except the host
attestation, which is a recorded human statement). Any change to `infrastructure/telegram`, `modules/calls/ntgcalls`, `modules/calls/audio`
or `pnpm-lock.yaml` changes the fingerprint and old run records stop counting.

## What you need

- The assistant account (already logged in) and a **second Telegram account you control** that agreed to be called (the "test account"; any spare SIM/phone). Its numeric id is `LIVE_TEST_RECIPIENT_ID` — never paste codes or sessions anywhere.
- A 2-hour window: `LIVE_TEST_WINDOW_START` / `LIVE_TEST_WINDOW_END` (ISO instants) and `LIVE_TEST_OPT_IN=yes LIVE_TEST_RECIPIENT_CONSENT=yes`.
- Run on the machine that will host the service for the G0-F part, with `LIVE_TEST_HOST_IS_TARGET=yes`.

## Steps (each prints what you must do)

1. **G0-D, long call with a real interruption** (AI, costs a little): `LIVE_TEST_RECIPIENT_KIND=test_account LIVE_TEST_MAX_SECONDS=300 pnpm live:ai-call` — answer, talk for 5 minutes, **interrupt the AI while it speaks at least once**, then type `yes` when asked whether you heard it clearly.
2. **G0-D, ten consecutive short calls:** `GATE_SCENARIO=short_batch pnpm live:gate-calls` — answer all ten; the batch stops at the first call that is not clean (then run it again from the start).
3. **G0-E, one run per scenario** (`GATE_SCENARIO=…`, one call each): `decline`, `busy`, `no_answer`, `privacy` (set Calls = Nobody on the test account first), `connectivity_loss` (airplane mode after answering; the call must end **by the adapter's own report** within 150 s — if you have to force it, the run fails and tells us the adapter needs work). Afterwards restore the privacy setting.
4. **G0-F:** do step 1 or 2 on the target host with `LIVE_TEST_HOST_IS_TARGET=yes`, then `pnpm attest:target-host` (host, phone clients, network notes).
5. `pnpm evidence:production` — prints each gate; use the printed `BUILD_FINGERPRINT` and `CALL_FEASIBILITY_EVIDENCE_PATH`.

Duplicate provider events and process crashes cannot be provoked safely on a live account; they are covered by automated tests and are listed
in the G0-E evidence as `synthetic:` references (never as live).

## After it passes

Restart the service. Contact calls still go through the dial policy (owner's explicit command, owner-attested consent, kill switch,
quiet hours, budget). Remove a contact, revoke the attestation, or say "stop calling me" to stop them.
