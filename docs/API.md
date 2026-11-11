# Admin API

Binds to `HTTP_HOST` (default `127.0.0.1`). **Bearer token required on everything except `GET /health/live`.** Tokens come from `ADMIN_TOKEN_SECRET_REF`
(comma-separated for zero-downtime rotation; each ≥ 32 chars). Telegram is the normal interface; this API is for operations and integration tests.

## Conventions

- Success: `{ "requestId": "...", "data": ... }`. Failure: `{ "requestId": "...", "error": { "code", "message", "retryable", "details?" } }`.
- Every mutation requires `Idempotency-Key` (8–128 chars). Same key + same body → stored response replayed (`Idempotent-Replayed: true`). Same key + different body → `409 idempotency_conflict`.
- Updates carry `expectedVersion`; a stale version → `409 version_conflict`.
- A resource of another owner is indistinguishable from a missing one (`404 not_found`). Internal errors return `500 internal_error` with no details.
- `202 Accepted` means queued, not completed.

| Status | Meaning                                                          |
| ------ | ---------------------------------------------------------------- |
| 400    | invalid input / missing idempotency key                          |
| 401    | missing or invalid bearer token (audited, token never logged)    |
| 403    | not allowed                                                      |
| 404    | absent or not yours                                              |
| 409    | stale version, idempotency conflict, invalid state, plan changed |
| 413    | body over 256 KiB                                                |
| 503    | capability unavailable (e.g. owner not bootstrapped)             |

## Endpoints

| Method · Path                                    | Behavior                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`                               | `{status:"ok"}`; unauthenticated, exposes nothing                                                                                                                                                                               |
| `GET /health/ready`                              | status `ready`/`degraded`/`unavailable` with `reasons`, DB reachability, overdue job and outbox counts, messaging/recovery status (`incomplete` = some owner instruction may be unprocessed), capabilities (503 unless `ready`) |
| `GET /v1/capabilities`                           | **Actual** feature state: `mode` (`degraded_text_only` \| `calling_enabled`), calling flags (incl. `ownerCallingAllowed`), `blockedBecause[]`, adapters, kill switch                                                            |
| `POST /v1/tasks` · `GET /v1/tasks`               | Create / list (open by default; `?includeClosed=true`)                                                                                                                                                                          |
| `PATCH /v1/tasks/:id`                            | Version-checked update or completion (`status`)                                                                                                                                                                                 |
| `POST /v1/reminders` · `GET /v1/reminders`       | Schedule (local `YYYY-MM-DDTHH:mm` + IANA tz; optional recurrence `daily\|weekly\|monthly`) / list active                                                                                                                       |
| `PATCH /v1/reminders/:id`                        | `{expectedVersion, localDateTime, timezone?}` reschedules; `{action:"cancel", expectedVersion}` cancels. Old occurrences/jobs are fenced out.                                                                                   |
| `POST /v1/contacts`                              | Create a contact by **numeric** Telegram id (verified by the owner)                                                                                                                                                             |
| `PATCH /v1/contacts/:id/permissions`             | Grant a new versioned permission (`allowCall`, `topicScopes`, `allowedHours`, `expiresAt`) or `{revoke:true}` (also ends live calls)                                                                                            |
| `POST /v1/call-requests`                         | Create an immutable brief + hash. `ownerExplicitCommand:true` approves immediately and enqueues a `call.dial` job; otherwise `pending_authorization`                                                                            |
| `POST /v1/authorizations/:id/approve`            | `{planHash}` must equal the stored hash                                                                                                                                                                                         |
| `POST /v1/calls/:id/cancel`                      | Idempotent stop request                                                                                                                                                                                                         |
| `POST /v1/calls/:id/resolve-unknown`             | Operator clears an `outcome_unknown` call after checking the real account (`operatorConfirmsNoLiveCall:true`, `note`); audited; retry still needs fresh authorization                                                           |
| `GET /v1/calls/:id` · `GET /v1/calls/:id/report` | Status; report (currently always `complete:false`)                                                                                                                                                                              |
| `POST /v1/operations/kill-switch`                | `{on, reason}` persists the switch, cancels queued requests (and revokes their authorizations), ends live calls after commit; returns `{on, cancelledRequests, liveStopRequested}`                                              |
| `GET /v1/operations/dead-letters`                | Outbox rows and jobs that exhausted their attempts (ids, type, attempts, truncated error; no payload) — never retried automatically                                                                                             |

**Calling note:** a `call-requests` call returns `202` and the job is still subject to policy at execution; with no evidence it is `rejected`
(`kill_switch_on` first, then `calling_not_verified`). Poll `GET /v1/capabilities` for the current reasons.

**Notes (audit remediation):** every mutation shares ONE transaction with its idempotency record, so a failed retry never leaves a half-created request;
provider hangups run after commit. Repeated failed authentication returns `401` and, past a per-minute threshold, a cheap `429` (`Retry-After: 60`) without
database work; authenticated requests are never throttled by it. A `call-requests` plan whose `recipientTelegramId` is the owner's own id is an **owner call**
(no contact needed; the owner's opt-out and quiet hours apply). Call adapters must emit a `heartbeat` event at least every 30 s while a call is live.
