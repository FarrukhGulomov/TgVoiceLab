# TgVoiceLab — Personal AI Executive Assistant

A dedicated Telegram **user account** that acts as the owner's AI executive assistant: tasks, persistent reminders, and (target) real private
voice calls to the owner and to explicitly authorized business contacts.

> **Honest status:** the text/task/reminder core works and is tested. **Real Telegram calling is not enabled and not verified** — it is blocked on live
> evidence that needs your accounts and devices. Read [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) first.

## What works today

- Owner-authenticated private Telegram text (numeric-ID auth, private chat only; strangers and forwarded content get no authority).
- Tasks (encrypted at rest, optimistic concurrency) and reminders: one-off and recurring, `Asia/Samarkand` default, DST-correct, quiet hours,
  missed-reminder policy, restart-safe, reschedule rejects stale jobs. Uzbek and English phrasing via a deterministic rules interpreter.
- Private admin API with bearer auth and idempotency, honest `/v1/capabilities`.
- Fail-closed call **control plane** (policy, state machine, kill switch, crash reconciliation) exercised against a _fake_ adapter.

## What does not work yet

Owner calls, contact calls, live AI conversation, voice-note transcription, daily briefings, memory, OpenAI adapters. See the status document.

## Quickstart (development)

Prerequisites: Node 22, pnpm 10, PostgreSQL 16 (a role that can `CREATE DATABASE` for tests).

```bash
pnpm install --frozen-lockfile
cp .env.example .env                    # edit locally; never commit; never paste secrets into chat
pnpm dev:secrets                        # creates .local/secrets/{data-keys.json,admin-token} (mode 600), prints the two *_REF lines for .env
export TEST_DATABASE_ADMIN_URL=postgres://USER:PASS@localhost:5432/postgres
pnpm verify                                 # lint, format, typecheck, build, unit + contract + integration + e2e (needs PostgreSQL)
pnpm db:migrate                         # applies db/migrations to DATABASE_URL (forward-only, checksum-verified)
pnpm bootstrap:owner                    # prints BOTH numeric ids and asks you to retype a confirmation phrase
pnpm dev                                # starts the API + worker (MESSAGING_ADAPTER=fake for a local dry run)
```

Run a single suite: `pnpm test:unit`, `pnpm test:contract`, `pnpm test:integration`, `pnpm test:e2e`. Integration tests clone a migrated template database
per test file and **fail loudly** if PostgreSQL is unreachable (they never skip silently).

### Connecting a real Telegram account (messaging only)

```bash
# 1. Create api_id/api_hash at https://my.telegram.org and put them in .env (TELEGRAM_API_ID / TELEGRAM_API_HASH)
pnpm spike:login                        # interactive, hidden OTP/2FA; writes .local/secrets/telegram.session (600); prints the assistant's numeric id
# 2. In .env: TELEGRAM_SESSION_SECRET_REF=file:/abs/path/.local/secrets/telegram.session  MESSAGING_ADAPTER=telegram
pnpm bootstrap:owner                    # owner id = YOU; assistant id = the id printed by the login step. They must differ.
```

The gateway is type-checked but **not live verified**. The assistant refuses to start if the logged-in account id differs from the bootstrapped assistant id.

### Phase 0 live gates (the blocker for calling)

See [`docs/research/telegram-private-calls.md`](docs/research/telegram-private-calls.md) §9. Live scripts need explicit opt-in, a numeric consenting recipient, a time
window and credentials; otherwise they exit `2` with `BLOCKED_EXTERNAL` — never a silent pass.

## Commands

| Command                                                                                                               | Purpose                                              |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm verify`                                                                                                         | Everything CI runs (needs PostgreSQL)                |
| `pnpm lint` · `pnpm format` · `pnpm typecheck` · `pnpm build`                                                         | Static checks and build                              |
| `pnpm test:unit` · `test:contract` · `test:integration` · `test:e2e` · `test:all`                                     | Test projects                                        |
| `pnpm db:migrate` · `pnpm db:seed`                                                                                    | Migrations; dev seed (refuses in production)         |
| `pnpm dev:secrets` · `pnpm bootstrap:owner`                                                                           | Local secrets; protected owner bootstrap             |
| `pnpm start`                                                                                                          | Production start (`node dist/main.js`; build first)  |
| `pnpm spike:smoke` · `spike:login` · `spike:call` · `spike:record-gate` · `spike:evidence` (alias `live:test` = call) | Phase 0 feasibility tooling                          |
| `pnpm secrets:scan` · `pnpm fingerprint`                                                                              | Secret scan of tracked files; deployment fingerprint |

## Deployment

`Dockerfile` (non-root, no native call binary) and `deploy/docker-compose.yml` (read-only FS, `cap_drop: ALL`, secrets as files, loopback-only port).
The image has **not been built in this sandbox** (no Docker daemon); the packaging step it relies on (`pnpm deploy --prod`) was exercised and the resulting
bundle booted, refused an un-migrated database, served probes and drained in ~1.1 s. Details: [`docs/runbooks/`](docs/runbooks).

## Layout

```
apps/assistant/src   bootstrap/ modules/{identity,tasks,scheduling,messaging,contacts,calls,policy,operations,retention,jobs,outbox,audit,idempotency}
                     infrastructure/{db,crypto,observability,telegram}  http/  testing/ (FAKES)  cli/
packages/contracts   zod schemas + types shared across boundaries (call plan, PCM frame codec, API bodies)
db/migrations        forward-only SQL
experiments/telegram-calls   Phase 0 spike (NOT production code)
tests/{unit,contract,integration,e2e}   docs/{research,adr,runbooks}   deploy/   scripts/
```

## Documents

[Status](docs/IMPLEMENTATION_STATUS.md) · [Acceptance map](docs/ACCEPTANCE_MAP.md) · [API](docs/API.md) · [Security & data](docs/SECURITY_AND_DATA.md) ·
[Research](docs/research/telegram-private-calls.md) · [ADRs](docs/adr) · [Runbooks](docs/runbooks) · [Spec](TECHNICAL_SPEC.md) · [Original prompt](CLAUDE_CODE_PROMPT.md)

## Licenses

Application code: unlicensed/private (owner to choose). Dependencies are MIT/Apache/ISC except the Phase 0 candidate **`ntgcalls` (LGPL-3.0-only)**, which is
confined to `experiments/` and excluded from the production image. Do not redistribute an image containing it before the LGPL review in ADR-0001.
