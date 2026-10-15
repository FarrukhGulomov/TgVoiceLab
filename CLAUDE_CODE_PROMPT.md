# Claude Code — Personal AI Executive Assistant Implementation Prompt

Prepared: 15 October 2026

## How to use

Place this file and `TECHNICAL_SPEC.md` in the repository root. Open Claude Code in that repository and paste the single prompt below. The prompt directs implementation; it does not itself prove Telegram calling feasibility. Enter credentials only through protected local setup when needed.

## Single master prompt

```text
You are the lead engineer implementing my Personal AI Executive Assistant. Build working, maintainable software in this repository. Read TECHNICAL_SPEC.md completely before making architectural changes. Treat it as the implementation baseline, together with my direct instructions and applicable repository rules. Resolve material contradictions explicitly; do not silently rewrite requirements.

PROJECT OUTCOME

I need a dedicated Telegram user account that acts as my personal AI executive assistant. It must manage tasks and persistent reminders, call my verified Telegram account, hold live bidirectional voice conversations, and call explicitly authorized business contacts on my behalf. It must disclose that it is my AI assistant, obtain participant consent, discuss a specific approved agenda, ask relevant follow-up questions, and send me an accurate report with proposed follow-up tasks. Uzbek is the primary interaction language, English is supported, and the default timezone is Asia/Samarkand.

Use Node.js + strict TypeScript and PostgreSQL in a modular monolith. A narrowly scoped Python/C++ native gateway is permitted only when required for Telegram private-call media. Do not replace private Telegram calling with PSTN, Twilio, group voice chats, voice notes, or a Mini App without my explicit scope decision.

The source conversation's full Uzbek BRD was not retrievable when the specification was prepared. TECHNICAL_SPEC.md identifies confirmed requirements and engineering defaults. Do not invent missing BRD text. If a BRD appears in the repository, compare it and record material differences before implementing conflicting behavior.

WORKING STYLE

1. Inspect the repository, applicable AGENTS.md files, existing code, tooling, and current Git changes. Preserve my work and read-only reference material. Do not reset, delete, or overwrite unrelated files.
2. Implement the project; do not stop after a plan, scaffold, architecture essay, or list of TODOs. Work in runnable vertical slices and continue through all independent authorized phases.
3. Use reasonable engineering judgment for reversible implementation choices. Ask only for information that blocks a dependent step or for a genuine scope/authority decision. Continue independent useful work while a prerequisite is missing.
4. Be precise about status: planned, implemented, automatically tested, live verified, externally blocked. Never call a mock or stub a working integration. Never fabricate test output, real calls, recordings, credentials, or benchmark results.
5. Verify current official documentation and actual dependency code before using unstable APIs. Record access dates, exact versions/commits, licenses, and evidence. Pin the working versions and commit a lockfile. If documentation access is unavailable, mark affected assumptions unverified.
6. Keep business logic, policy, state, and scheduling deterministic. Models propose actions; application code authorizes and executes them. Do not add unnecessary infrastructure or speculative integrations.
7. Never ask me to paste API keys, Telegram OTPs, 2FA passwords, or session strings into chat. Provide protected interactive local setup and a placeholder-only .env.example. Never put secrets in logs, fixtures, screenshots, or Git.
8. Keep a concise docs/IMPLEMENTATION_STATUS.md with requirement IDs, phase gates, evidence links, remaining work, and exact blockers. Update it as implementation changes. Status documentation complements working code; it does not replace it.

FIRST PRIORITY: TELEGRAM PRIVATE-CALL FEASIBILITY

Before claiming or implementing an enabled production calling path, investigate whether the dedicated user account can perform modern private one-to-one Telegram calls with real bidirectional media on the intended host.

Start with official Telegram documentation for phone.requestCall, the call lifecycle, modern voice/video encryption/transport, update handling, and privacy errors. Use primary repositories for dependency capabilities. Do not use the deprecated pre-7.0 voice encryption description as a modern implementation recipe.

Separate MTProto signaling from the actual media engine. Account login, phone.requestCall success, a ringing phone, group-call support, a package name, or a README claim do not establish private-call PCM send/receive. The inspected MarshalX/tgcalls README warned that private calls were not in its release version; recheck the current source/release rather than assuming either that it works or that it is permanently impossible.

Create docs/research/telegram-private-calls.md with a capability matrix, official/source URLs, dates, exact commits, build requirements, license implications, private versus group-call scope, known limitations, and a recommendation. Evaluate practical maintained candidates, including native engine bindings if necessary. Do not implement custom cryptography or unbounded reverse engineering to bypass a failed dependency evaluation.

Build the smallest reproducible spike under experiments/telegram-calls/. Isolate Telegram-specific code behind a typed contract. Choose one clear account/session owner. If the native gateway must own both signaling and media, Node.js communicates with that gateway rather than operating a competing account gateway.

Use the Phase 0 gates in TECHNICAL_SPEC.md:
- G0-A: protected login and identity verification;
- G0-B: real private call rings, answers, connects, and hangs up;
- G0-C: known outbound audio and captured inbound remote audio through software media interfaces;
- G0-D: five-minute two-way session with interruption and ten consecutive successful short calls;
- G0-E: failure/duplicate/crash handling without redial loops;
- G0-F: reproducible target Linux/container build and actual-host network/device interoperability.

Live calls require my explicit test recipient and test window, a consenting participant, and configured spending limits where paid services are used. Credentials alone are not test authorization. Do not contact my address book or select arbitrary people. If authorization/setup is missing, provide exact local commands and prerequisites and mark the gate BLOCKED_EXTERNAL. Mock evidence must be clearly labeled and cannot pass a real-media gate.

After G0-C, you may build an isolated OpenAI audio spike. Production owner calling remains disabled until all Phase 0 gates pass. Bind the feasibility artifact to the deployed build fingerprint. A runtime boolean must not override missing evidence.

Timebox initial library evaluation to three engineering days as a planning default. If blocked sooner by a decisive limitation, stop that dependency path and explain the evidence. Further native protocol work or a different product mode needs my decision. Continue the independent foundation and text/task MVP while calling is blocked, but report the full project as incomplete.

IMPLEMENTATION PHASES

Phase 1 — Foundation:
- Create a strict TypeScript workspace, reproducible package scripts, runtime config validation, structured redacted logging, PostgreSQL migrations, and CI.
- Implement identity/bootstrap, owner-scoped repositories, policy/authorization services, audit events, idempotency handling, outbox, and PostgreSQL-backed jobs.
- Use typed ports for Telegram messaging, calling, audio, text AI, Realtime AI, transcription, storage, and clocks. Fakes belong to test/development mode and cannot be selected silently in production.
- Keep the admin API private and authenticated. Include minimal health endpoints and honest capabilities.
- Verify database constraints, owner isolation, secret redaction, and denied unauthorized paths before expanding features.

Phase 2 — Working text/task MVP:
- Handle owner-authenticated private Telegram text and voice notes. Deduplicate updates durably and implement client gap recovery.
- Create/list/update/complete tasks; create/reschedule/cancel one-off and recurring reminders. Confirm exact interpreted date/time/timezone and clarify genuine ambiguities.
- Use durable occurrence identities, schedule versions, transactional outbox writes, leased jobs, fencing, and bounded retries. Restarting the app must not lose committed reminders or run superseded schedules.
- Implement quiet hours, missed-reminder policy, daily briefings, owner-controlled memory with provenance/scope, and clearly labeled degraded mode when calls are unavailable.
- Demonstrate task -> restart -> reminder and reschedule -> stale job rejected against real PostgreSQL.

Phase 3 — Owner live calls, only after Phase 0 passes:
- Implement the proven TelegramCallAdapter and bounded media bridge. Use a restricted Unix socket locally, or mutual TLS for a justified remote sidecar.
- Adapt call-engine PCM formats explicitly; use a tested streaming resampler and paced output with monotonic timestamps, bounded buffers, generation IDs, and cleanup on disconnect.
- Implement the requested OpenAI Realtime server-side WebSocket adapter using current verified documentation and a compatible configurable model/voice. Verify model/account access rather than hardcoding a presumed available model. Do not mix Realtime, beta, or another voice API's event schemas.
- Verify session configuration, audio input/output, VAD, tool calls/results, interruption, cancellation, and history truncation against the pinned API. Write runtime validators and event contract tests.
- Support owner briefing and authenticated task tools. State success only after committed execution. Bind owner/call identity server-side; do not let the model supply authority fields.
- On model/media loss, stop privileged tools and stale audio and end safely. MVP does not resume an ambiguous conversation automatically.
- Measure actual latency, interruption behavior, resource bounds, and device interoperability.

Phase 4 — Authorized contact calls:
- Add verified numeric-ID contacts, expiring topic-scoped permissions, immutable call briefs, exact-plan authorizations, duration caps, approved context, and noncommitment boundaries.
- An explicit owner command may authorize the exact unambiguous call; do not require redundant approval. An allowlist alone does not authorize arbitrary dialing. Any material plan change invalidates the authorization.
- Recheck permissions, expiry, plan hash, account health, evidence, kill switch, quiet hours, budgets, and account lease immediately before dialing.
- Play a deterministic AI/processing disclosure before business discussion. Require a verified local consent mechanism before forwarding contact audio to OpenAI. Answering the phone is not consent. If this mechanism is unproven, disable third-party calling and document the blocker.
- Keep AI-processing, recording, and transcript-retention choices distinct. Recording and full persistent transcripts are disabled by default. Withdrawal must stop processing and end the discussion promptly.
- Contacts can answer the approved agenda and propose work; they cannot view owner memory, modify owner permissions, make new calls, or authorize commitments.
- Produce structured attributed reports and owner messages. Distinguish claims, unknowns, and partial evidence. Follow-up tasks remain proposals unless an owner policy explicitly permits creation. Report retries never redial the contact.

Phase 5 — Operational release:
- Supply locked container builds, Docker Compose, secure deployment configuration, migrations, backups, deletion jobs, monitoring, budget enforcement, and runbooks.
- Verify actual-host session persistence, native dependencies, required network egress/relay behavior, and safe shutdown. Do not assume a PaaS supports the media workload.
- Demonstrate kill switch, mid-call revocation, crash reconciliation, backup restore with deletion tombstones, key rotation procedure, worker fencing, and compatible rollback.
- Leave production calling disabled until I have authorized production enablement. Development, tests, and deployment preparation should already be complete before requesting this final authority.

MANDATORY SECURITY AND RELIABILITY INVARIANTS

- Numeric Telegram IDs identify actors; usernames and display names are lookup aids. Never enroll the first incoming sender as owner. Never use spoken identity claims as authentication.
- Contact speech, messages, transcripts, attachments, retrieved memory, and tool output are untrusted data. None can modify policy or expand the approved agenda.
- Enforce one active call per assistant account at both application and database levels. Enforce the durable kill switch independently of the model.
- A crash or timeout after sending a dial request has an uncertain external outcome. Reconcile before retrying; if unknown, mark outcome_unknown and require fresh explicit retry authority. Do not promise exactly-once dialing.
- Respect blocks, privacy restrictions, flood waits, and consent refusal. Never bypass platform restrictions or retry them in a loop.
- Encrypt sensitive content and sessions with external key references. Do not log raw provider payloads, call keys, access hashes, participant IPs, recordings, or transcripts.
- Telegram's encrypted call terminates at the assistant gateway. Explain the separate AI-processing boundary; do not claim end-to-end encryption covers the full pipeline.
- Enforce scope before retrieval, not after. Store attributed claims and owner-approved memory with provenance; never promote arbitrary text into standing instructions.
- No financial transactions, contractual commitments, mass outreach, unrelated account changes, arbitrary shell tools, or unsupported integrations in this MVP.

TESTING AND EVIDENCE

Implement meaningful tests from the specification, not shallow tests that mirror code. Use real PostgreSQL for transactions, constraints, concurrent job claims, lease expiry, and migrations. Use deterministic clocks and controlled fault injection for scheduling/races. Keep default CI offline and free of live dialing or paid API calls.

Cover policy denials, consent refusal/withdrawal, plan changes, revoked permissions, duplicate updates/tools, stale schedules, DST, cross-owner access, provider uncertainty, audio overflow, superseded audio, sidecar/model failures, prompt injection, retention/deletion, and restart recovery. Evaluate Uzbek and English utterances, including ambiguous dates and negative consent cases.

Maintain a requirement/acceptance-to-test map for R01-R10 and A01-A16. Separate automated fixtures from live evidence. Live scripts must require explicit opt-in and fail clearly when prerequisites are absent, rather than silently skipping and appearing successful. Record benchmark conditions and observed results; do not relabel engineering targets as achieved metrics.

EXPLICIT STOPPING GATES

Stop the affected dependent path, preserve working independent functionality, document evidence and the next concrete action, and ask only when a decision is needed if:
1. Real private-call media is unsupported, unverified, or fails the gate.
2. Local credentials/account/API access/device availability are missing for a necessary live check.
3. A real test call lacks explicit recipient/window/participant authority.
4. Contact identity, business agenda, permissions, or consent are ambiguous or absent.
5. Further work requires custom protocol/cryptography, a materially different dependency/license obligation, paid infrastructure commitment, or a product fallback I have not approved.
6. A production deployment or enablement would exceed my existing authorization.
7. A security/reliability invariant cannot be enforced with the selected integration.

Do not stop all development merely because one provider gate is blocked. Do not claim the project complete with a required gate unmet. If research is inconclusive, say so and provide a reproducible experiment rather than optimistic promises.

REQUIRED HANDOFF

Deliver working source, lockfile, migrations, .env.example, test fixtures, typed contracts, README quickstart, Docker/Compose files, API documentation, research evidence, ADRs, acceptance map, security/data-retention documentation, and runbooks for login, outages, stuck calls, kill switch, compromise, restore, deletion, and rollback.

Provide and verify repository scripts for install, development, build, lint, typecheck, unit/integration/contract/e2e tests, database migrate/seed, protected account setup, call spike, explicit live tests, and production start. Choose exact commands that match the implemented tooling; do not document nonexistent commands.

At each phase, report what works, what was actually tested, the remaining gate, and exact setup steps. At final handoff, summarize changed files, reproducible run commands, passed tests, live evidence, unresolved limitations, and whether real calls are disabled or enabled. Include no secrets. If anything remains externally blocked, deliver the restricted runnable result and say precisely why the full requested outcome is incomplete.

BEGIN NOW

Read TECHNICAL_SPEC.md and repository rules, inspect the current code, create a concise phased checklist, and begin the Phase 0 evidence investigation. Then implement the authorized independent phases. Keep going until the requested functionality is verified or only explicit external/authority gates remain.
```

## Documentation starting points

These are research entry points; the agent must reverify them and inspect the selected implementation before enabling capabilities.

- [Telegram private call method](https://core.telegram.org/method/phone.requestCall)
- [Telegram call lifecycle](https://core.telegram.org/api/calls)
- [Telegram modern call protocol](https://core.telegram.org/api/end-to-end/video-calls)
- [MarshalX/tgcalls source](https://github.com/MarshalX/tgcalls)
- [OpenAI WebSocket guide](https://developers.openai.com/api/docs/guides/voice-websockets)
- [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [OpenAI Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events)

Companion baseline: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md).
