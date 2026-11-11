# ADR-0002: Two small extensions to the spec's interfaces

Status: Accepted · Date: 2026-10-15

1. **`ApprovedCallPlan.topic`** (slug). The spec requires topic-scoped contact permissions but its plan interface has no topic to match against free-text `purpose`.
   Matching free text against scopes would be fuzzy and model-dependent; an explicit slug keeps the check deterministic (`topic_not_permitted`). It is part of the hashed plan body.
2. **Evidence `producedBy: "production-adapter"`.** The Phase 0 spike proves feasibility of a library, not of the shipped adapter. To prevent spike output from ever
   enabling production, the evidence schema accepts only `production-adapter`, and the build fingerprint covers the production adapter sources
   (`apps/assistant/src/infrastructure/telegram/**`) plus the lockfile. Changing the adapter invalidates evidence and forces the live gates to be re-run.

Both are additive; no other spec interface was changed.
