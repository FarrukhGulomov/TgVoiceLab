# ADR 0007 — Calls to owner-vouched contacts

## Decision (owner's, 2026-10-17)

The owner may give the assistant contacts he has told in advance that an AI assistant may call them. The assistant then calls such a
contact directly on his chat or voice command ("call Javlon and tell him the report is ready"). No per-call consent dialogue with the
contact, no audio or transcript recording. Whether to store recordings/transcripts in the database is deferred to production (undecided).

## What is recorded

- `contacts.ai_consent_attested_at/revoked_at`: the **owner's attestation** that the contact was informed. It is the owner's statement,
  stored as `consent_events.source = 'owner_attested'` on every call; it is never labelled as the participant's own consent.
- A contact who says "no AI" / "talk to a person" during a call: the AI apologises, files a `consent_withdrawn` report and hangs up; the
  attestation is revoked (`consent_events.decision = 'withdrawn'`, `ai_consent_revoked_at`), so that contact is not called again until
  the owner re-adds them.

## Safeguards kept

- Contact calls still require the **full six evidence gates** (G0-A…F) and the normal dial policy; only the owner-only light gate is not
  enough. Removing a contact, revoking the attestation, or "stop calling me" cancels queued calls and hangs up live ones.
- The first sentence is a fixed AI disclosure naming the owner. The brief is passed as data; forbidden commitments (money, contracts,
  new promises, owner's private data) are part of the sealed plan. The AI's tools are `submit_report` and `end_call` only.
- The report narrative is stored sealed (`call_reports.narrative_enc`) and sent to the owner as `call.report`.

## Residual risks (owner informed)

- Contact audio goes to the AI provider. Gemini's free tier may use data to improve Google products: use a paid tier before calling
  contacts (the process logs a warning at start).
- Attestation is not the participant's own consent; local-law obligations toward the contact remain the owner's.
