-- Audit F10: free-text call-plan content (purpose, questions, allowed context, forbidden commitments) is sealed in plan_enc
-- (owner/column-bound AES-GCM, same envelope as tasks/messages). The `plan` jsonb keeps routable metadata only for new rows.
-- Existing rows are sealed by the idempotent startup backfill (no key is available inside SQL). Additive: older code ignores the column.
ALTER TABLE call_requests ADD COLUMN plan_enc text;
