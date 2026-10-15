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
| `ntgcalls` (npm, JS shim)           | 3.0.3   | see `experiments/telegram-calls/package-lock.json` (integrity hashes)    |
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
- **Finding F-1 (typing/runtime mismatch):** `index.d.ts` declares byte arguments as `Buffer`, but the native layer rejects `Buffer` and
  `Uint8Array` ("An array was expected") and accepts plain `number[]`. Returned byte data comes back as `Uint8Array`. The adapter must
  convert at the boundary and have a contract test, otherwise a library upgrade silently changes behavior.
- `sendExternalFrame` before a stream source is configured is rejected ("External source not initialized"): fail-closed, as required.

None of this contacts Telegram.

## 6. Handshake sequence (from py-tgcalls source structure + TL schema; **unverified against live**)

Outgoing private call, owner account = caller:

1. `messages.getDhConfig` → `p`, `g`, `random`.
2. `ntgcalls.createP2pCall(peerUserId)`; `initExchange(peer, dhConfig, undefined)` → `g_a_hash`.
3. `phone.requestCall(user_id, random_id, g_a_hash, protocol{min/max layer, udp_p2p, udp_reflector, library_versions}, video=false)`.
4. Updates: `updatePhoneCall(phoneCallWaiting → phoneCallAccepted)`; on `phoneCallAccepted` call `exchangeKeys(peer, g_b, fingerprint)` → `{ gAOrB, keyFingerprint }`.
5. `phone.confirmCall(peer, g_a, key_fingerprint, protocol)` → `phoneCall` with `connections[]`/RTC servers.
6. `connectP2p(peer, servers, versions, p2pAllowed, customParameters)`; relay signaling blobs both ways through
   `onSignalingData` ↔ `phone.sendSignalingData` and `updatePhoneCallSignalingData` ↔ `sendSignalingData`.
7. `setStreamSources(peer, CAPTURE, {microphone: {mediaSource: EXTERNAL, sampleRate, channelCount:1}})`, then `sendExternalFrame`; receive via `onFrames`.
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

## 9. Live gate checklist (run locally; exact commands)

Prerequisites (owner, locally): dedicated assistant Telegram account + `api_id`/`api_hash` from my.telegram.org; a consenting test participant with their numeric Telegram ID and a time window; a phone/client for that participant.

```bash
cp .env.example .env            # fill TELEGRAM_API_ID / TELEGRAM_API_HASH only; never paste them in chat
pnpm install --frozen-lockfile
pnpm spike:login                # G0-A  protected interactive login; prints assistant numeric ID for you to compare
LIVE_TEST_OPT_IN=yes LIVE_TEST_RECIPIENT_ID=<numeric id> LIVE_TEST_WINDOW_END=<ISO time> pnpm spike:call   # G0-B/C (script refuses to run without all three)
```

Each gate result must be recorded as `PASS` / `FAIL` / `BLOCKED_EXTERNAL` in `docs/IMPLEMENTATION_STATUS.md` with the evidence file path.

## 10. Recommendation

Proceed with ntgcalls + GramJS as the **single primary candidate**, behind the typed adapter, and spend the three-day timebox on live gates G0-A…G0-C first.
Do **not** start custom protocol or cryptography work if G0-B fails; stop and ask. Keep calling disabled until G0-A…G0-F pass and the evidence artifact is bound to the deployed build.
