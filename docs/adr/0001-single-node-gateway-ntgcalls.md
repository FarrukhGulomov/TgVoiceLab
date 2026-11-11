# ADR-0001: One Node process owns the Telegram account and the call media engine

Status: **Proposed** (candidate selected by inspection; not live verified) · Date: 2026-10-15

## Context

Private calls need (a) MTProto signaling and (b) a media engine. The spec forbids a competing second session owner and a generic "invoke MTProto" endpoint.
Inspection (see `docs/research/telegram-private-calls.md`) found `ntgcalls` 3.0.3 with explicit private (P2P) call support, a Node binding with external-PCM
send/receive, a prebuilt linux-x64/arm64 binary, and GramJS exposing every `phone.*` method and `updatePhoneCall*` constructor.

## Decision

Use **GramJS + ntgcalls in the same Node codebase**, behind `TelegramCallAdapter`. No Python sidecar. The adapter converts at the boundary (bytes as `number[]`, runtime
enums — findings F-1/F-2/F-3) and is the only code that imports either library. Capabilities come from build-bound live evidence.

## Consequences

- (+) One account owner; simpler deployment; same language/tooling/tests.
- (−) Native addon (98.5 MB) in the call-worker image; crash isolation requires running the call worker as a separate process of the same image (supported by design).
- (−) **License:** `ntgcalls` is LGPL-3.0-only. Use as an unmodified dynamically loaded addon is the usual compliant pattern, but redistribution of an image requires notices and
  a relinking/source offer. The production image currently **excludes** it. Legal confirmation is a stopping gate before bundling.
- (−) Unknown: protocol descriptor `minLayer=maxLayer=92` / lib versions 8–13 interoperability with current official clients (R-P1) — decided by G0-B/G0-F.
- Rejected: `MarshalX/tgcalls` (stale since 2023, private calls "not in release"), group voice chats as a substitute (explicitly out of scope).

## Revisit when

G0-B fails (do not start custom protocol/crypto work — ask the owner), or a maintained alternative appears.
