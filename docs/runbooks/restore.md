# Backup and restore

**Backup (daily, encrypted, 30-day retention — your scheduler):**
`pg_dump --format=custom --file=backup.dump "$DATABASE_URL"`, then encrypt (e.g. `age`/`gpg`) and store off-host. Keep the **data-encryption key ring separate** from backups (ciphertext is useless without it, and vice versa — back it up through a different channel).

**Restore into a clean database (rehearse monthly; never over a live one):**

1. `createdb tgvl_restore && pg_restore --no-owner --dbname=tgvl_restore backup.dump`
2. Point `DATABASE_URL` at it; run `pnpm db:migrate` (forward-only; a no-op if the dump is current).
3. **Re-apply deletions:** `pnpm db:replay-tombstones` — removes content that was deleted after the backup was taken. Tombstones themselves are in the dump only if they pre-date it, so keep a copy of `deletion_tombstones` from the live system when restoring an older dump.
4. Start with `CALLS_ENABLED=false`, kill switch **on**. Check `/health/ready`, `/v1/capabilities`, create a test task.
5. Objectives (proposed): RPO ≤ 24 h from backups for host loss; RTO ≤ 4 h after infrastructure is back. Ordinary process restarts lose nothing committed.

Deleted data persists in backups until they expire (30 days). Do not promise instant erasure from backups.
