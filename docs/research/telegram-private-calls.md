# Telegram private-call feasibility (Phase 0)

Status: **CANDIDATE IDENTIFIED — NOT LIVE VERIFIED.** All live gates (G0-A … G0-F) are `BLOCKED_EXTERNAL`.
Production calling stays disabled. Prepared 2026-10-15 in a sandbox with no Telegram network access.

## 1. What this document is and is not

It records what was _actually inspected_, with the exact artifacts, and keeps three evidence classes apart:

| Class                | Meaning                                                                                                                                | Can pass a real-media gate? |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Inspected**        | Package metadata, headers, type definitions and wheels/tarballs downloaded from registries and read                                    | No                          |
| **Offline-executed** | Native module loaded and exercised on this host without contacting Telegram (`experiments/telegram-calls/evidence/offline-smoke.json`) | No                          |
| **Live**             | Real Telegram account, real consenting peer, real phone                                                                                | Only this class             |

Only the first two classes exist today.

## 2. Source access limits in this session (honest gaps)

Egress goes through a proxy that allowed `registry.npmjs.org` and `pypi.org` and **denied** `core.telegram.org`, `github.com`,
`api.github.com` and `developers.openai.com`. Consequently:

- The Telegram documentation pages named in the spec (`phone.requestCall`, call lifecycle, modern call encryption) were **not re-read**.
  Method and constructor names below come from the TL schema bundled in `telegram@2.26.22` (layer 198) and from `py-tgcalls` source, not from the web docs.
- The OpenAI Realtime docs were **not re-read**. The Realtime adapter must be written against the pinned API after docs access is available (see §8).
- Upstream GitHub commit SHAs could not be fetched. Candidates are pinned by **registry version + tarball hash** instead (see §4).
  Anything claiming a commit SHA below would be fabricated, so none is given.

Action for the owner: allow `core.telegram.org`, `github.com` and `developers.openai.com` for the session (or run the checklist in §9 locally).

## 3. Capability matrix

`Y` = present in inspected code/types; `?` = unverified; `N` = absent. Nothing here is a live result.

| Capability                                                                                                           | `telegram` (GramJS) 2.26.22      | `ntgcalls` 3.0.3 (Node + Python)                                                                                              | `py-tgcalls` 3.0.0                  | `tgcalls` 2.0.0 (MarshalX)                                                   |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| User-account login (MTProto)                                                                                         | Y (MIT)                          | N (media engine only)                                                                                                         | via Pyrogram/Telethon               | N                                                                            |
| `phone.requestCall` / `acceptCall` / `confirmCall` / `receivedCall` / `discardCall` / `sendSignalingData` TL methods | **Y** (in bundled TL, layer 198) | N (caller supplies)                                                                                                           | Y (via Pyrogram raw)                | N                                                                            |
| `updatePhoneCall`, `updatePhoneCallSignalingData`                                                                    | **Y**                            | N                                                                                                                             | Y                                   | N                                                                            |
| Private (P2P) call media engine                                                                                      | N                                | **Y** — `createP2pCall`, `initExchange`, `exchangeKeys`, `skipExchange`, `connectP2p`, `onSignalingData`, `sendSignalingData` | wraps ntgcalls                      | README: private calls "not in release version" (stale: last release 2023-01) |
| PCM injection to remote                                                                                              | N                                | **Y** — `MediaSource.EXTERNAL` + `sendExternalFrame`                                                                          | partial (`send_frame`)              | ?                                                                            |
| PCM extraction from remote                                                                                           | N                                | **Y** — `onFrames(chatId, mode, device, frames)`                                                                              | partial                             | ?                                                                            |
| Headless (no audio device)                                                                                           | Y                                | Y (external source; no device required — to be proven live)                                                                   | Y                                   | ?                                                                            |
| Linux x64 prebuilt                                                                                                   | pure JS                          | **Y** — `@ntgcalls/linux-x64` (98.5 MB `.node`)                                                                               | pure Python                         | cp37–cp39 wheels only                                                        |
| Linux arm64 prebuilt                                                                                                 | pure JS                          | Y (`@ntgcalls/linux-arm64`)                                                                                                   | —                                   | ?                                                                            |
| License                                                                                                              | MIT                              | **LGPL-3.0-only**                                                                                                             | (LGPL dependency)                   | LGPLv3                                                                       |
| Maintenance (registry timestamps)                                                                                    | active                           | releases 3.0.1 (2026-10-04), 3.0.2 (10-06), 3.0.3 (10-11)                                                                     | 3.0.0 (2026-09-25), 3.0.1b1 (10-11) | stale (last 2023-01-09)                                                      |

Interpretation:

1. The earlier `MarshalX/tgcalls` caveat in the spec is **superseded for a different library**, not refuted for that one.
   `tgcalls` is stale (2023) and should not be selected. `ntgcalls` is a distinct, actively released library whose headers
   (`instances/p2p_call.hpp`, `ntgcalls.hpp`) and Node types explicitly model private calls and external PCM frames.
2. This is a **capability claim by code inspection only**. The spec's rule stands: signaling success, a ringing phone, a README line or a type
   definition do not establish private-call PCM send/receive. Only G0-B/G0-C live evidence does.

## 4. Pinned artifacts (reproducibility)

| Artifact                            | Version | Identifier                                                               |
| ----------------------------------- | ------- | ------------------------------------------------------------------------ |
| `ntgcalls` (npm, JS shim)           | 3.0.3   | see root `pnpm-lock.yaml` (integrity hashes)                             |
| `@ntgcalls/linux-x64` (npm, native) | 3.0.3   | lockfile integrity; `ntgcalls.node` 98,528,104 bytes                     |
| `ntgcalls` sdist (PyPI)             | 3.0.3   | uploaded 2026-10-11; LGPL-3.0 `LICENSE` inspected                        |
| `py-tgcalls`                        | 3.0.0   | uploaded 2026-09-25; used only as a reference for the handshake sequence |
| `telegram` (GramJS)                 | 2.26.22 | MIT; bundled TL layer **198**                                            |

Upstream build inputs read from the sdist `version.properties`: libwebrtc `152.7977.0.3`, Boost `1.92.0`, FFmpeg `9.0.1`, OpenH264 `2.6.0`, clang 22.
Building from source (instead of the prebuilt binary) is a heavy WebRTC build and is _not_ attempted; the prebuilt binary is the pinned deliverable.

## 5. Offline-executed evidence (this host: linux-x64, Node v22.22.0)

Produced by `node experiments/telegram-calls/smoke-offline.mjs` → `evidence/offline-smoke.json`:

- Native module loads; `createP2pCall` succeeds; `calls()` reflects the call.
- `NTgCalls.getProtocol()` returns `minLayer 92, maxLayer 92, udpP2p true, udpReflector true, libraryVersions [8.0.0, 9.0.0, 12.0.0, 13.0.0]`.
  **Risk R-P1:** whether current official clients negotiate a compatible library version with this protocol descriptor is unverified (G0-F).
- **Finding F-1 (typing/runtime mismatch, bytes):** `index.d.ts` declares byte arguments as `Buffer`, but the native layer rejects `Buffer` and
  `Uint8Array` ("An array was expected") and accepts plain `number[]`. Returned byte data comes back as `Uint8Array`. The adapter must
  convert at the boundary and have a contract test, otherwise a library upgrade silently changes behavior.
- **Finding F-2 (typing/runtime mismatch, enums):** `index.d.ts` lists enums as sequential ordinals, but the runtime enums are **bit flags**
  (`MediaSource.EXTERNAL` is `32`, not `6`; `ConnectionState.CONNECTED` is `2`; `StreamMode` is `CAPTURE=0, PLAYBACK=1`). Passing a hand-written ordinal
  fails with "Invalid input mode". Always use the runtime enum objects exported by the module, never numeric literals.
- **Finding F-3 (outgoing `initExchange` argument):** for an _outgoing_ call the third argument (`ga_hash`) must be **absent** (`undefined`, `null` or omitted):
  the call returns the 32-byte `g_a_hash` that `phone.requestCall` needs. An empty array is treated as the _incoming_ case and returns a 256-byte `g_b`.
  This was found by comparison with `py-tgcalls` 3.0.0 (`connect_call.py` passes `None` for outgoing) and then confirmed against the binding.
- Order that the binding accepts offline (and that `py-tgcalls` uses): `createP2pCall` → `setStreamSources(CAPTURE, external microphone)` → `initExchange`.
  After that, `sendExternalFrame(MICROPHONE, 20 ms of s16le @ 48 kHz mono = 1,920 bytes)` is accepted without a peer; a frame for an unknown call is rejected.
- `sendExternalFrame` before a stream source is configured is rejected ("External source not initialized"): fail-closed, as required.

None of this contacts Telegram.

## 6. Handshake sequence (read from `py-tgcalls` 3.0.0 source and the GramJS TL schema; **NOT verified against live Telegram**)

Outgoing private call, owner account = caller:

1. `messages.getDhConfig` → `p`, `g`, `random`.
2. `ntgcalls.createP2pCall(peerUserId)`; `setStreamSources(CAPTURE, external mic)`; `initExchange(peer, dhConfig, undefined)` → 32-byte `g_a_hash`.
3. `phone.requestCall(user_id, random_id, g_a_hash, protocol{min/max layer, udp_p2p, udp_reflector, library_versions}, video=false)`.
4. Updates: `updatePhoneCall(phoneCallWaiting → phoneCallAccepted)`; on `phoneCallAccepted` call `exchangeKeys(peer, g_b, 0)` → `{ gAOrB, keyFingerprint }` (the reference passes the fingerprint field of the _accepted_ update, which is absent, i.e. 0).
5. `phone.confirmCall(peer, g_a, key_fingerprint, protocol)` → `phoneCall` with `connections[]`/RTC servers.
6. `connectP2p(peer, servers, versions, p2pAllowed, customParameters)`; relay signaling blobs both ways through
   `onSignalingData` ↔ `phone.sendSignalingData` and `updatePhoneCallSignalingData` ↔ `sendSignalingData`.
7. Send with `sendExternalFrame(MICROPHONE, …)`; to receive remote audio the spike also sets an external `speaker` source in `PLAYBACK` mode and reads `onFrames`. (Whether remote PCM is delivered this way on a _private_ call is exactly what G0-C must show; the group-call examples do not prove it.)
8. `phone.discardCall` on end; handle `phoneCallDiscarded` (busy/declined/missed reasons).

Whether the exact private-call DH/`confirmCall` details match the _current_ Telegram server behavior at layer 198+ is exactly what G0-B must prove.

## 7. Architecture consequence (ADR-0001 draft)

**One Node process owns the Telegram account session and the media engine** (GramJS for MTProto + `ntgcalls` native addon in-process, or in a dedicated
call-worker process of the same codebase). No Python sidecar is required by this design, which removes the spec's "competing session owner" problem entirely.

- The gateway is hidden behind the `TelegramCallAdapter` contract (`packages/contracts`). The core never imports GramJS or ntgcalls.
- `capabilities()` is computed from an **evidence artifact bound to the build fingerprint** (§ code: `apps/assistant/src/modules/calls/capability-evidence.ts`).
  Today no such artifact exists, so every capability is reported `false` and `dial` rejects. A boolean in config cannot override this.
- LGPL-3.0 note: `ntgcalls` is consumed as an unmodified, dynamically loaded prebuilt addon. Redistribution of container images that bundle it requires
  LGPL notices and offering the corresponding source/relinking path. Needs owner/legal confirmation before any redistribution (stopping gate 5).

## 8. Known limitations / open risks

| ID   | Risk                                                                                                               | Mitigation / gate                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| R-P1 | Protocol descriptor (`minLayer=maxLayer=92`, lib versions 8–13) may not interoperate with current official clients | G0-B/G0-F on real devices; disable capability on failure          |
| R-P2 | GramJS TL is layer 198; server may require newer layers for some constructors                                      | G0-A/G0-B live; pin and canary                                    |
| R-P3 | Echo cancellation / speakerphone loop not provided by external-source mode                                         | Measure at G0-C/D; bridge must never feed own output to the model |
| R-P4 | 98.5 MB native binary; supply-chain and license review                                                             | Lockfile integrity, ADR, LGPL notices                             |
| R-P5 | Account restrictions/flood waits when automating a user account                                                    | Narrow owner-authorized use; no loops; runbook                    |
| R-P6 | Docs for Telegram/OpenAI not re-read (proxy)                                                                       | §2 action; blocks Realtime adapter finalization                   |

## 8a. What the spike scripts do (all exist and are guarded)

| Script (pnpm)                                       | Gate        | Behavior                                                                                                                                                                                                   |
| --------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm spike:smoke`                                  | none        | Offline load/API-sequence check; writes `offline-smoke.json`. **Never** a gate result.                                                                                                                     |
| `pnpm spike:login`                                  | G0-A        | Interactive, hidden OTP/2FA, mode-600 session file, prints the assistant numeric id. Refuses non-TTY before any network access.                                                                            |
| `pnpm spike:call`                                   | G0-B/C/D/E  | Real call to ONE consenting numeric recipient inside a ≤2 h window. Refuses (exit 2) unless opt-in, recipient, consent, window, credentials and session are all present. Never redials after an exception. |
| `pnpm spike:record-gate <gate> <result> <evidence>` | G0-E/F etc. | Operator attestation for things a script cannot observe (target host, phone clients). `PASS` needs an existing evidence file and `OPERATOR_ATTESTS_LIVE=yes`.                                              |
| `pnpm spike:evidence`                               | all         | Assembles gate records. Missing records become `BLOCKED_EXTERNAL`. Stamped `producedBy: "spike"`, which the application **rejects**.                                                                       |

Spike evidence proves the _approach_ is feasible. It cannot enable production by design (`producedBy` must be `production-adapter`, and the fingerprint covers the
production adapter sources), so the same live gates must be re-run against the production adapter before calling can be enabled.

## 9. Live gate checklist (run locally; exact commands)

Prerequisites (owner, locally): dedicated assistant Telegram account + `api_id`/`api_hash` from my.telegram.org; a consenting test participant with their numeric Telegram ID and a time window; a phone/client for that participant.

```bash
cp .env.example .env            # fill TELEGRAM_API_ID / TELEGRAM_API_HASH only; never paste them in chat
pnpm install --frozen-lockfile
pnpm spike:login                # G0-A  protected interactive login; prints assistant numeric ID for you to compare
LIVE_TEST_OPT_IN=yes LIVE_TEST_RECIPIENT_ID=<numeric id> LIVE_TEST_RECIPIENT_CONSENT=yes \
  LIVE_TEST_WINDOW_START=<ISO> LIVE_TEST_WINDOW_END=<ISO> pnpm spike:call     # G0-B/C (refuses unless ALL are present)
LIVE_TEST_MAX_SECONDS=300 ... pnpm spike:call                                   # G0-D five-minute two-way session
LIVE_TEST_REPEAT=10 ...      pnpm spike:call                                   # G0-D ten consecutive short calls (aborts the whole batch on any uncertain or unproven call)
LIVE_TEST_SCENARIO=expect_decline LIVE_TEST_EXPECTED_DISCARD_REASON=<exact class> ... pnpm spike:call   # G0-E (ask the participant to decline); the expected Telegram discard class is declared by the operator; repeat for expect_busy
OPERATOR_ATTESTS_LIVE=yes pnpm spike:record-gate G0-F PASS <evidence file>     # G0-F target host/container + phone clients
pnpm spike:evidence                                                             # assemble gate records
```

Each gate result must be recorded as `PASS` / `FAIL` / `BLOCKED_EXTERNAL` in `docs/IMPLEMENTATION_STATUS.md` with the evidence file path.

## 9a. Live findings so far (single Mac, owner calling own second account; **not** the production adapter, **not** a gate pass)

Recorded from the operator's runs on 2026-10-16. Raw evidence files stay local (`experiments/telegram-calls/evidence/*.local.json`, not committed).

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Status                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| F-4 | `ntgcalls` 3.0.3 type declarations do not match runtime: native `bigint` required for `RTCServer.id` (GramJS returns `big-integer` objects); `Array` (not `Buffer`) required for `peerTag`, key material and signaling payloads; empty `customParameters` fails JSON parsing (use `'{}'`).                                                                                                                                                                                                                  | fixed in the spike script; reproduced offline  |
| F-5 | Outbound external PCM at **20 ms** frames was audibly distorted; at **10 ms** the operator heard a clean continuous tone for 30 s.                                                                                                                                                                                                                                                                                                                                                                          | operator-reported, human judgment, one session |
| F-6 | G0-B: outgoing call set up, accepted, `CONNECTED`, held 30 s and ended by the script (`time_limit`) in one attempt. One attempt is not the G0-D criterion.                                                                                                                                                                                                                                                                                                                                                  | 1 PASS, still needs G0-D repeats               |
| F-7 | Inbound audio: remote RTP (PT 111) arrived but was dropped by WebRTC (`Failed to demux RTP packet`, ~500 packets) because no receive stream was created (`recv=0`, no `AddRecvStream`). `onFrames` never fired. Attaching the PLAYBACK stream as `speaker` before `connectP2p` (the documented-looking setup) does not work.                                                                                                                                                                                | root cause localised                           |
| F-8 | Workaround found in an upstream issue thread (ntgcalls #44, user-reported, **not** maintainer-validated) and reproduced locally with two in-process peers: attach CAPTURE before `connectP2p`; after connect attach PLAYBACK **on the `microphone` slot**, `unmute`, `resume`, and keep a continuous outbound stream. Local result: 801 inbound frames of 960 bytes (10 ms, 48 kHz mono s16), `mode=PLAYBACK device=MICROPHONE`. Applied to `live-call.mjs`; **not yet confirmed on a real Telegram call**. | local only                                     |

| F-9 | After the audit, `live-call.mjs` was refactored (placement tracking, call-bound updates, per-placement window check, validated integers, default 10 ms frames, `LIVE_TEST_EXPECTED_DISCARD_REASON` for G0-E). The guard logic is unit-tested offline; **the refactored script has not been re-run against Telegram**. | re-run needed |

| F-10 | 2026-10-17, refactored `live-call.mjs` re-run (answer, 10 ms frames, 60 s): `G0-B` PASS, `G0-C` outbound PASS (operator: clean tone), inbound PASS (`receivedNonSilent` > 0 while the operator spoke). This **confirms F-8 on a real call**. An earlier run was scored FAIL only because the operator mistyped the tone answer (`clead`) and another because the operator hung up at 20 s (discard reason `Disconnect`, not `time_limit`); both records are kept as they were. | 1 PASS (operator-run, spike script) |
| F-11 | Same script, 300 s: summary `G0-B` PASS, `G0-C` PASS, `G0-D-candidate` 1/1 at 300 s. | 1 PASS; **10-call repeat not run** |
| F-12 | G0-E, `expect_decline`: operator rejected the ringing call twice. Telegram reported `PhoneCallDiscardReasonDisconnect` both times, with no redial. The first run declared `Busy` as expected reason and was scored FAIL (wrong expectation, record kept); the second, declaring `Disconnect`, PASS. | decline only; `Disconnect` is **not** a reliable "declined" signal |
| F-13 | Every script run exits with `SIGABRT` after printing results (native teardown in ntgcalls). Results are not affected, but a production process must shut calls down cleanly. | open defect |

Open: `LIVE_TEST_REPEAT=10` (G0-D), busy/no-answer/privacy-restricted/connectivity-loss (G0-E), and a target-host canary (G0-F). The workaround depends on undocumented behaviour of a third-party native library; the adapter must pin the exact version and keep a regression test.

## 10. Recommendation

Proceed with ntgcalls + GramJS as the **single primary candidate**, behind the typed adapter, and spend the three-day timebox on live gates G0-A…G0-C first.
Do **not** start custom protocol or cryptography work if G0-B fails; stop and ask. Keep calling disabled until G0-A…G0-F pass and the evidence artifact is bound to the deployed build.
