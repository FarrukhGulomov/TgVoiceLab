# Security and data policy

Scope: what is _actually enforced in this repository_, where, and what is not done. Legal compliance for recording/AI-processing third parties is
**not asserted**: confirm applicable requirements (Uzbekistan and the participant's jurisdiction) before real deployment.

## Invariants (spec "mandatory security and reliability invariants")

| Invariant                                                                 | Enforced by                                                                                                                           | Test                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Numeric Telegram IDs are identity; usernames are not                      | `TelegramUserIdSchema` + DB `CHECK (~ '^[1-9][0-9]{0,18}$')` on owners/contacts/accounts                                              | `schema`, `e2e/owner-journey`                           |
| First sender is never enrolled; bootstrap echoes both IDs                 | `bootstrapOwner` (exact phrase, owner ≠ assistant, single owner)                                                                      | `e2e/owner-journey`                                     |
| Owner commands: private chat only, owner's id, owner's own account        | `authenticateOwnerMessage`; denial is silent, audited at most once/min/sender                                                         | `intake` › A01                                          |
| Forwarded/contact content is data, never instructions                     | `IntakeService` forwards → refusal reply; interpreter has no call intent; no conversation layer exists yet                            | `intake`, `language-eval`                               |
| One active call per account, DB-level                                     | Partial unique index `calls_one_active_per_account`; `outcome_unknown` occupies the account                                           | `schema`, `calls-orchestrator`                          |
| Durable kill switch independent of the model; fail closed                 | `operation_settings.calling_kill_switch` defaults `true`; absent row ⇒ on; read `FOR SHARE` inside the dial tx                        | `calls-orchestrator` › A12                              |
| Crash/timeout after dial ⇒ uncertain; reconcile; never redial             | `CallOrchestrator.onDialError`, `recoverOrphanedCalls`; authorization is single-use (`UNIQUE(calls.authorization_id)`)                | `calls-orchestrator` › A11, `http-api` › recovery       |
| Blocks/privacy/flood waits/refusals are terminal, not retried             | `DialRejectedError` → terminal state; `call.dial` job `max_attempts=1`                                                                | `calls-orchestrator` › A14                              |
| Authorization is exact-plan, expiring, single-use                         | `computePlanHash`, `authorizations` checks, `evaluateDialPolicy` (hash recomputed from the stored plan and compared twice)            | `dial-policy`, `calls-orchestrator` › A04               |
| Allowlist alone never authorizes dialing                                  | Policy requires an approved authorization with matching hash                                                                          | `dial-policy`                                           |
| Sensitive content encrypted with external key refs, bound to owner/column | AES-256-GCM, random nonce, key id, AAD `owner:<id>\|col:<c>`; key ring from `file:`/`env:` refs (never literal)                       | `envelope`, `owner-isolation` (copied ciphertext fails) |
| No secrets/OTP/session/hash/IP/transcripts in logs                        | pino `formatters.log` + `logMethod` scrubbers (normalized key allowlist + token-shaped strings); `audit_events` stores IDs/codes only | `logger-redaction`, `http-api` (token never audited)    |
| Fakes never silently selected in production                               | `loadConfig` rejects `fake` adapters when `NODE_ENV=production`; fakes live in `testing/`                                             | `config`                                                |
| Owner isolation                                                           | Owner-scoped queries **and** composite `(owner_id, id)` foreign keys; foreign vs. absent id give identical errors                     | `schema`, `owner-isolation`                             |
| Calling cannot be enabled by a flag                                       | Capabilities derived from a build-bound, `production-adapter`-stamped, live-PASS evidence artifact                                    | `capability-evidence`, `spike-guards`                   |
| Append-only audit/consent                                                 | Triggers reject UPDATE/DELETE; DELETE only inside the retention tx (`app.retention_delete`)                                           | `schema`, `retention`                                   |
| Telegram call encryption ends at the gateway                              | Documented boundary (below). No claim of end-to-end coverage of the AI pipeline                                                       | —                                                       |

## Encryption boundary (do not misstate this to participants)

Telegram's private-call encryption terminates inside the assistant's call engine. Audio forwarded to an AI provider (not implemented yet) leaves that
encrypted Telegram boundary and is governed by the provider's terms. The disclosure played to a participant must say an AI service processes speech. The
full pipeline is **not** "end-to-end encrypted by Telegram".

## Data inventory and retention (defaults; configurable before launch)

| Data                                          | Stored as                                                                                  | Default retention              | Mechanism                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------ |
| Owner messages                                | AEAD ciphertext (`messages.content_enc`)                                                   | 30 days                        | `runRetention` (daily job), tombstone                  |
| Call reports                                  | structured JSON + encrypted narrative ref                                                  | 30 days                        | `runRetention`, tombstone                              |
| Full third-party transcripts                  | **not stored** (feature off)                                                               | — (7 days if ever enabled)     | `FULL_TRANSCRIPT_RETENTION_ENABLED` (true rad etiladi) |
| Raw audio                                     | **never written**                                                                          | — (7 days max if ever enabled) | `RAW_AUDIO_RECORDING_ENABLED` (true rad etiladi)       |
| Security audit metadata                       | IDs/codes only                                                                             | 90 days                        | `runRetention`                                         |
| Memory (owner-approved)                       | AEAD ciphertext + provenance                                                               | until expiry/deletion          | table exists; feature **not started**                  |
| Idempotency keys, done jobs, delivered outbox | rows                                                                                       | 24 h / 7 d / 7 d               | `runRetention`                                         |
| Call plans (purpose, questions, context)      | AEAD in `call_requests.plan_enc`; `plan`/`authorizations.plan` hold routable metadata only | with the call request          | sealed; plan hash is over the logical plan             |
| Permission context entries                    | AEAD per element (`contact_permissions.context_allowlist`)                                 | with the permission row        | sealed                                                 |
| Idempotency responses                         | AEAD (jsonb string)                                                                        | 24 h                           | `runRetention`; rotation covers it                     |
| Clarification drafts                          | AEAD (`conversation_drafts.draft_enc`)                                                     | 10 min                         | one per owner, expiring, `runRetention`                |
| Telegram recovery watermarks                  | ids only                                                                                   | until superseded               | `recovery_watermarks`                                  |
| Backups                                       | encrypted dumps (procedure only)                                                           | 30 days                        | runbook; deletion is **not instant** in backups        |

Restore procedure re-applies `deletion_tombstones` (`replayTombstones`) so deleted content does not resurface. AI-processing consent, recording and transcript
retention are separate consent kinds (`consent_events.kind`), append-only. Defaults: no recording, no persistent third-party transcript.

## Database privileges

Three logins (`deploy/postgres/roles.sql`): the bootstrap superuser (initialisation and break-glass only), `tgvl_migrator` (schema owner, runs forward-only
migrations), `tgvl_app` (runtime: DML only; no DDL, no trigger or grant changes, no UPDATE/DELETE on `audit_events`/`consent_events`, no write to
`schema_migrations`). Audit rows are purged only through the narrow `purge_audit_events` function, which refuses rows younger than 60 days. The append-only
triggers protect against accidents, **not** against a privileged database actor; the boundary for the runtime login is its privilege set. Production refuses
to start if its login is a superuser, owns schema objects, can create objects or can rewrite history (`DB_ALLOW_PRIVILEGED_ROLE=true` is for non-production only).
Verified by `integration/least-privilege` (real roles) and by `deploy/smoke.sh` on containers.

## Secrets

`TELEGRAM_SESSION` _is_ account access; `DATA_ENCRYPTION_KEY` decrypts everything; `ADMIN_TOKEN` operates the API. All are referenced (`file:` requires mode ≤ 600,
or `env:`), never committed (`.gitignore`, `scripts/check-secrets.mjs` in CI), never logged. The live scripts type credentials into a hidden TTY prompt and refuse
non-interactive use. Rotation: runbooks `key-rotation`, `session-compromise`.

## Known gaps (do not assume these are covered)

- No KMS integration (file/env refs only). `pnpm keys:rotate` re-encrypts every ciphertext location (including call plans, permission context, drafts, idempotency responses); transient outbox payloads are not rewritten (drain first).
- Admin API has no TLS or per-token scopes; it must stay on loopback/private network.
- No metrics export/alerting yet; only structured logs, audit rows, and `/health/ready` (which now also reports overdue jobs/outbox and incomplete Telegram recovery).
- No row-level security (optional per spec).
- Prompt-injection and consent-refusal behavior against real speech cannot be tested until the conversation layer exists.
- The image and database run as real containers in `deploy/smoke.sh` (run locally and in CI); a real host canary with Telegram has **not** been done. `pnpm audit` runs in CI and was run locally on 2026-10-17.
- LGPL-3.0 `ntgcalls`: it IS part of the production image (a production dependency); see docs/THIRD_PARTY_NOTICES.md and obtain legal review before redistributing an image (ADR-0001).

## Voice, memory and persona data flows (added with the VoiceLab / persona work)

- **VoiceLab (TTS) receives only text the assistant itself wrote** (call sentences, short voice-note replies): never the contact's or the owner's audio. That text can contain a contact's name or facts from the owner's brief. Spoken replies to voice notes are capped (500 characters, 40 per hour).
- **Gemini / OpenAI receive the live call audio** (the listening model). Use a paid tier before calling contacts: on free tiers the provider may train on it.
- **Call lessons** ("what to do better") are written by the model from what a contact said. They are the only memory that crosses from one contact's call into another's prompt, so they are accepted only as short style advice (`calls/conversation/lessons.ts`): instructions aimed at the system, limits, amounts, numbers, links and contact details are rejected when saved, when recalled and when put into a prompt, and they are framed as data that cannot change rules, limits or the brief.
- **Persona**: the assistant calls itself "Zubayr" and does not announce that it is an AI unprompted. In the owner's own chat and calls it never calls itself an AI, bot or model at all (the owner knows what it is; this only sets its tone), but it never claims to be a human and answers truthfully if asked whether it is a person/AI or whether the call is recorded (audio is not stored). A contact who objects to talking to an AI ends the call with `consent_withdrawn`.
- **Content boundary**: the assistant declines religious topics and politically dangerous/extremist material in calls, chat and composed texts. This is an instruction to the model, not a classifier; treat it as best effort.

## VoiceLab speech recognition (STT_PROVIDER=voicelab)

- **Live calls** (`VOICELAB_STT_CALLS`): the caller's audio goes to VoiceLab over a WebSocket (`xvl-api-key` handshake header, key permission `stt:realtime`); Gemini/OpenAI then receive only the recognised TEXT, never the caller's audio. Voice-activity detection and commits are done here (`VOICELAB_STT_SILENCE_MS`, `VOICELAB_STT_LEVEL`); one utterance is at most about 30 s (the service allows 35 s per commit).
- **Voice notes** (`VOICELAB_STT_NOTES`): the owner's OGG/Opus note is uploaded to VoiceLab as it is (`stt:write`, then `stt:read` to poll the job).
- Nothing is recorded or stored here; logs carry timings and lengths only (`turn timing: ...` lines), never the words or keys; error text is scrubbed of the key.
- The integration was written from the vendor's documentation as given to us and is NOT live verified (voicelab.uz is unreachable from the build sandbox). The JSON field names of the file-API job id and transcript are read defensively; an unrecognised shape is reported by key names only.
- Accuracy and speed are not claimed: measure with `pnpm voicelab:stt-bench -- <folder>` on your own recordings, and read the `turn timing` log lines (synthesis time is reported separately from recognition time).

## ElevenLabs (TTS_PROVIDER=elevenlabs, STT_PROVIDER=elevenlabs)

- **Speech (TTS)** receives only text the assistant itself wrote (call sentences, voice-note replies), over HTTPS through the official SDK; audio comes back as raw 24 kHz PCM and is played while it arrives. No audio of a person is sent.
- **Live calls** (`ELEVENLABS_STT_CALLS`): the caller's audio (16 kHz PCM) goes to ElevenLabs over the SDK's realtime WebSocket (`xi-api-key`); the thinking model receives only the recognised TEXT. Utterances are ended here (silence detection) and committed manually.
- **Voice notes** (`ELEVENLABS_STT_FILE_MODEL`): the owner's OGG/Opus note is uploaded as it is.
- Retention at ElevenLabs follows the account's own settings (zero-retention mode is an enterprise option and is not requested here). Review the account's data-retention and training settings before calling contacts.
- **Not live verified** from the build sandbox (elevenlabs.io is unreachable there): unit tests use fakes of the SDK; run `pnpm elevenlabs:check` and a short call before relying on it. Which models speak Uzbek is the account owner's decision (`ELEVENLABS_TTS_MODEL`, `ELEVENLABS_STT_MODEL` are never defaulted).

## VoiceLab streaming speech (VOICELAB_TTS_STREAM=true)

- Each spoken sentence opens its own WebSocket to `wss://api.voicelab.uz/v1/tts/stream` (header `xvl-api-key`, key permission `tts:realtime`) and sends exactly one request: the sentence text, language, voice id and speed. The text is what the assistant is about to say, not what the other person said. Audio is played as it arrives and is not stored.
- Barge-in sends `{"action":"interrupt"}` and closes the open connections; audio that arrives afterwards is discarded.
- A stream that fails before any audio falls back to the REST synthesis for that sentence. A sentence that failed after part of it was heard is reported and not repeated.
- Not verified against the live service from the build environment. The streaming endpoint has no model choice, so `VOICELAB_TTS_MODEL` applies only to the REST fallback.

## Answering the owner's calls (ANSWER_OWNER_CALLS=true)

- Phase 1 answers a call to the assistant's Telegram account only when the caller's numeric id is the owner's. Everyone else is declined as busy: no conversation, no recording, no contact row, no log of who called. More than five declines a minute from one id are ignored.
- The owner's ring becomes an owner-approved call request and runs through the same orchestrator as every other call: kill switch, verified-build gate (`ownerCallingAllowed`), single active call, call budget, durable call state, events and report. Only the owner's opt-out and quiet hours are skipped, because they limit calls the assistant starts, not calls the owner makes.
- Key exchange: the assistant answers with its half (`g_b`) and checks that the key derived from the caller's `g_a` carries the fingerprint the caller announced; a mismatch hangs up. Audio is not stored.
- Not verified against the live service. Strangers and contacts calling in are a later phase.

## Live-call safety and privacy (2026-10-24 audit follow-up)

- A kill switch, opt-out or revoked permission is committed first; ending the live call follows. A periodic sweep (every 5 s) re-reads the committed policy and ends any live call it forbids, and every hangup is retried, so a failed hangup does not leave a call running.
- What was said and tool arguments are never written to logs by default. `debug`/`trace` logging is refused in production.
- What a call taught the assistant about a contact (summary, offers, notes) expires after `CALL_MEMORY_RETENTION_DAYS` (default 180; 0 = forever). Call reports are deleted after 30 days. Style lessons contain no personal data and are kept.
- A paid call whose cost is unknown is settled at its full reservation against the daily budget; an unknown cost never counts as free.
