# Implementation status

Last updated: 2026-10-15 · Branch `claude/new-session-o6be3b`

**Bottom line: the requested outcome is NOT complete.** The text/task/reminder assistant works and is tested. Real Telegram private calling
(owner calls, authorized contact calls, live AI conversation) is **not implemented and not verified**: it is blocked on live evidence that cannot be
produced from this sandbox. Production calling is **disabled by construction** (see "How calling is held off").

Status vocabulary (spec §15): **implemented** · **automatically tested** · **live verified** · **blocked** · **not started**.
Nothing in this repository is _live verified_ today. Fakes are labeled `FAKE`/`TEST-ONLY` and never count as live evidence.

## Phase gates

| Phase                      | State                                           | What exists                                                                                                                                                                                     | Remaining / exact blocker                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Feasibility              | **research done · live gates BLOCKED_EXTERNAL** | Research doc, pinned candidate (ntgcalls 3.0.3 + GramJS 2.26.22), offline-executed API evidence, guarded spike scripts for G0-A…F, evidence assembly that cannot enable production              | Needs the owner: a dedicated assistant account + `api_id/api_hash`, a consenting test participant with numeric id, a time window, real phones. See `docs/research/telegram-private-calls.md` §9.                     |
| 1 Foundation               | **implemented · automatically tested**          | Strict TS workspace, validated config, redacting logs, SQL migrations, owner-scoped composite FKs, audit, idempotency, outbox, leased/fenced jobs, policy, ports + fakes, private admin API, CI | Optional: row-level security (spec: optional defense in depth); KMS/secret-manager integration beyond file/env references.                                                                                           |
| 2 Text/task MVP            | **implemented · automatically tested**          | Intake (text + voice-note limits), tasks, reminders (one-off/recurring), DST policy, quiet hours, missed-reminder policy, restart + stale-schedule scenarios, uz/en rules interpreter           | Not live verified against Telegram. Voice-note **transcription adapter is not implemented** (port exists; replies "voice notes unavailable"). Daily briefings and owner memory are **not started**.                  |
| 3 Owner live calls         | **blocked**                                     | State machine, orchestrator, kill switch, crash reconciliation, 20 ms PCM frame codec (all tested against a FAKE adapter)                                                                       | Blocked by Phase 0. Production `TelegramCallAdapter` for ntgcalls, audio bridge/resampler, OpenAI Realtime adapter are **not started** (OpenAI docs were unreachable from the sandbox).                              |
| 4 Authorized contact calls | **partly implemented (control plane only)**     | Verified numeric-ID contacts, versioned/expiring permissions, immutable plan + hash + single-use authorization, pure dial policy, mid-call revocation, minimal truthful report                  | Disclosure playback, **local consent recognizer**, consent state machine, conversation, structured reports, follow-up proposals are **not started**. Third-party calls stay disabled (`consent_mechanism_unproven`). |
| 5 Operational release      | **partly implemented**                          | Dockerfile, Compose, CI, retention/deletion + tombstone replay, runbooks, graceful drain (measured ~1.1 s)                                                                                      | Docker image **not built** (no daemon in sandbox; packaging path validated via `pnpm deploy` + a booted bundle). No backup/restore rehearsal, key rotation tooling, monitoring/metrics export, or host canary.       |

## How calling is held off (defense in depth)

1. `CALL_ADAPTER=disabled` and `CALLS_ENABLED=false` by default; `loadConfig` refuses `CALLS_ENABLED=true` without a real adapter, evidence path, budget and owner.
2. `CALL_ADAPTER=ntgcalls` **aborts startup**: the production adapter does not exist.
3. Capabilities are _derived_ from an evidence artifact bound to the build fingerprint and `producedBy: "production-adapter"`. Spike evidence, mock/synthetic results, a different build, or any missing/invalid gate yields all-false.
4. The durable kill switch defaults **ON** for every new owner and is read inside the dial transaction.
5. Dial policy (`evaluateDialPolicy`) is deterministic and re-evaluated after the call row is taken and before the external side effect.
6. Contact calls additionally require a live-verified local consent recognizer (none exists).
7. `/v1/capabilities` reports `degraded_text_only` with the reasons.

## Requirement status (R01–R10)

| ID  | Requirement                            | Status                                                                                              | Evidence                                                                   |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| R01 | Dedicated assistant account            | **implemented** (login script + GramJS gateway with identity check), **not live verified**          | `experiments/telegram-calls/login.mjs`, `gramjs-gateway.ts`                |
| R02 | Real private calls ring the owner      | **blocked** (G0-B)                                                                                  | `docs/research/telegram-private-calls.md`                                  |
| R03 | Bidirectional live AI voice            | **blocked** (G0-C, Phase 3)                                                                         | —                                                                          |
| R04 | Tasks, persistent reminders            | **implemented · automatically tested**                                                              | `reminders-e2e`, `intake`, `owner-journey`, `wallclock-dst`, language eval |
| R05 | Calls to authorized contacts           | **control plane implemented · tested with FAKE adapter**; real calls **blocked**                    | `calls-orchestrator`, `dial-policy`                                        |
| R06 | Discuss agenda, report                 | **blocked / not started** (only a truthful "no conversation took place" report)                     | —                                                                          |
| R07 | Disclose AI identity, consent          | **not started** (schema + append-only `consent_events` only)                                        | `schema.test.ts` (append-only)                                             |
| R08 | Node + TS + PostgreSQL monolith        | **implemented · automatically tested**                                                              | whole repo; `pnpm verify`                                                  |
| R09 | Verify media before promising          | **implemented** (gates, scripts, evidence guard); the _verification itself_ is **blocked_external** | `capability-evidence.test`, `spike-guards.test`                            |
| R10 | Sessions, permissions, audit, recovery | **mostly implemented · automatically tested** (see `docs/SECURITY_AND_DATA.md` for gaps)            | `schema`, `owner-isolation`, `envelope`, `retention`, `http-api` recovery  |

See `docs/ACCEPTANCE_MAP.md` for A01–A16 and the test that covers each.

## Decisions taken / deviations (details in `docs/adr/`)

- Node (GramJS + ntgcalls) is the single account/media owner; **no Python sidecar** (ADR-0001).
- `topic` added to the call plan and `producedBy` to the evidence schema (ADR-0002). The spec's interface list is otherwise unchanged.
- The source BRD (`AI yordamchi imkoniyatlari`) was **not in the repository**; nothing was invented from it (ADR-0006).
- Vitest 5 / TypeScript 5.9 / ESLint 9 chosen; TypeScript 7.x was available but unsupported by typescript-eslint.

## Not verified because of sandbox limits

`core.telegram.org`, `github.com` and `developers.openai.com` were blocked by the egress proxy. Telegram call-protocol facts come from the GramJS TL schema and
`py-tgcalls` source; OpenAI Realtime behavior was **not** checked, so no Realtime adapter was written. Re-verify before Phase 3.

## Test inventory (all offline; real PostgreSQL for integration/e2e)

`pnpm verify` → lint, format, typecheck, unit (161), contract (7), integration (124), e2e (4) = 296 tests. Live scripts are separate and refuse to run without authorization.
