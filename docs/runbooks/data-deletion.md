# Data deletion

- **Automatic:** a daily `retention.sweep` job removes expired messages (30 d), call reports (30 d), memories past expiry, audit rows (90 d), expired idempotency keys, old done jobs and delivered outbox rows. Content deletions write tombstones.
- **On request (a person asks to be deleted):** identify the contact (`SELECT id FROM contacts WHERE telegram_user_id='<numeric id>'`), revoke permission (`PATCH /v1/contacts/:id/permissions {"revoke":true,…}`), then delete their conversations/messages/reports in one transaction that also inserts `deletion_tombstones` rows (resource types `message`, `call_report`, `memory`). Audit rows hold IDs only and age out at 90 days.
- **After a restore:** `pnpm db:replay-tombstones`.
- Raw audio and third-party transcripts are not stored by default (`RAW_AUDIO_RECORDING_ENABLED=false`, `FULL_TRANSCRIPT_RETENTION_ENABLED=false`); verify those flags in production config.
