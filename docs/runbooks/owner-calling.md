# Enabling calls TO THE OWNER (owner-only gate)

Owner decision 2026-10-17: calls to **your own number** (briefing calls, call reminders) need only G0-A, G0-B, G0-C and one clean **5-minute** two-way call recorded with the **production adapter** (`G0-D5`). Calls to anyone else still need all six full gates and the consent recognizer; this runbook does not change that.

The evidence is bound to the **build fingerprint** (lockfile + the Telegram gateway, the call adapter and the audio path sources). Any change to those files or to the lockfile invalidates it, and the 5-minute call must be recorded again. That is deliberate.

## 1. Record the live calls (production adapter, your own phone)

```bash
cd ~/TgVoiceLab && git pull && pnpm install
# stop `pnpm dev` first: one process per Telegram session
export LIVE_TEST_OPT_IN=yes LIVE_TEST_RECIPIENT_ID=<your numeric id> LIVE_TEST_RECIPIENT_CONSENT=yes
export LIVE_TEST_WINDOW_START=$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ) LIVE_TEST_WINDOW_END=$(date -u -v+60M +%Y-%m-%dT%H:%M:%SZ)
export LIVE_TEST_MAX_SECONDS=300 AI_CALL_MODE=briefing   # briefing mode proves the recipient is the owner
pnpm live:ai-call
```

Talk to the AI for the whole call and do **not** say goodbye (it hangs up at 300 s itself; an early goodbye makes a short call that cannot pass `G0-D5`). At the end it asks: _did the person hear the AI clearly?_ Answer `yes` or `no` in full; anything else counts as `no`. A run record `PA-<time>.local.json` is written next to the other evidence files. A real briefing call edits real tasks: use a test owner or accept the edits.

## 2. Assemble the evidence

```bash
pnpm evidence:production
```

It prints each gate (`PASS` / `BLOCKED_EXTERNAL`), the build fingerprint, and the two settings to use. Gates are decided from measured facts (connected, clean end, at least 30 s, non-silent audio from the person, enough AI audio sent, no bridge errors) plus your answer; only records for **this** build count.

## 3. Switch the service on (`.env`)

```
MESSAGING_ADAPTER=telegram
CALL_ADAPTER=ntgcalls
CALLS_ENABLED=true
BUILD_FINGERPRINT=<printed by pnpm evidence:production>
CALL_FEASIBILITY_EVIDENCE_PATH=<absolute path printed by pnpm evidence:production>
OWNER_TELEGRAM_USER_ID=<your id>
DAILY_AI_BUDGET_USD=5
AI_VOICE_PROVIDER=gemini            # or openai, with its model (never defaulted)
GEMINI_API_KEY=...  GEMINI_LIVE_MODEL=...
AI_VOICE_COST_USD_PER_MINUTE=...    # optional: settles the budget with an estimate (unset settles 0)
```

The durable kill switch is **ON** for a new owner. Switch it off deliberately (admin token, see `kill-switch.md`): `POST /v1/operations/kill-switch {"on":false,"reason":"..."}`. `GET /v1/capabilities` shows `ownerCallingAllowed`, `blockedBecause[]` and the switch state.

## 4. What then happens

- A reminder set "by call" (chat or voice) fires: the text is sent at once, a call to you is queued (sealed plan, explicit-command authorization) and dialed only if policy allows (kill switch, quiet hours, opt-out, budget, evidence). "Stop calling me" stops all calls.
- Any refusal or failure is reported to you once in plain words; the reminder text was already delivered.
- Contact calls stay refused (`calling_not_verified`) until all six gates and the consent recognizer exist.

## 5. Turning it back off

Kill switch on, or `CALLS_ENABLED=false`, or remove `CALL_FEASIBILITY_EVIDENCE_PATH`. Each is sufficient on its own.
