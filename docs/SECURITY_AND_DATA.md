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

| Data                                          | Stored as                                 | Default retention              | Mechanism                                       |
| --------------------------------------------- | ----------------------------------------- | ------------------------------ | ----------------------------------------------- |
| Owner messages                                | AEAD ciphertext (`messages.content_enc`)  | 30 days                        | `runRetention` (daily job), tombstone           |
| Call reports                                  | structured JSON + encrypted narrative ref | 30 days                        | `runRetention`, tombstone                       |
| Full third-party transcripts                  | **not stored** (feature off)              | — (7 days if ever enabled)     | `FULL_TRANSCRIPT_RETENTION_ENABLED=false`       |
| Raw audio                                     | **never written**                         | — (7 days max if ever enabled) | `RAW_AUDIO_RECORDING_ENABLED=false`             |
| Security audit metadata                       | IDs/codes only                            | 90 days                        | `runRetention`                                  |
| Memory (owner-approved)                       | AEAD ciphertext + provenance              | until expiry/deletion          | table exists; feature **not started**           |
| Idempotency keys, done jobs, delivered outbox | rows                                      | 24 h / 7 d / 7 d               | `runRetention`                                  |
| Backups                                       | encrypted dumps (procedure only)          | 30 days                        | runbook; deletion is **not instant** in backups |

Restore procedure re-applies `deletion_tombstones` (`replayTombstones`) so deleted content does not resurface. AI-processing consent, recording and transcript
retention are separate consent kinds (`consent_events.kind`), append-only. Defaults: no recording, no persistent third-party transcript.

## Secrets

`TELEGRAM_SESSION` _is_ account access; `DATA_ENCRYPTION_KEY` decrypts everything; `ADMIN_TOKEN` operates the API. All are referenced (`file:` requires mode ≤ 600,
or `env:`), never committed (`.gitignore`, `scripts/check-secrets.mjs` in CI), never logged. The live scripts type credentials into a hidden TTY prompt and refuse
non-interactive use. Rotation: runbooks `key-rotation`, `session-compromise`.

## Known gaps (do not assume these are covered)

- No KMS integration (file/env refs only); key rotation re-encryption tool is **not written** (`Envelope.needsRotation` exists; see runbook).
- Admin API has no TLS or per-token scopes; it must stay on loopback/private network.
- No metrics export/alerting yet; only structured logs, audit rows, and `/health/ready`.
- No row-level security (optional per spec).
- Prompt-injection and consent-refusal behavior against real speech cannot be tested until the conversation layer exists.
- Docker image builds in CI (`image` job) but has never been run as a container; `pnpm audit` runs in CI only.
- LGPL-3.0 `ntgcalls`: excluded from the production image; legal review required before bundling (ADR-0001).
