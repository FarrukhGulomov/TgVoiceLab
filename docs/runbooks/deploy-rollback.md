# Deploy and roll back

**Deploy** (single Linux host, Docker Compose in `deploy/`):

0. One-time: create `.local/secrets/{db_password,data-keys.json,admin-token,telegram.session}` (mode 600; `pnpm dev:secrets` makes the middle two) and `.env.production` from `.env.example` (mode 600) with `DATABASE_URL=postgres://tgvl:<db_password>@db:5432/tgvl`, `OWNER_TELEGRAM_USER_ID`, `OWNER_TIMEZONE`, `MESSAGING_ADAPTER=telegram`, `TELEGRAM_API_ID/HASH`. Never commit either file.
1. CI green on the commit (`pnpm verify`), image built with `--build-arg BUILD_FINGERPRINT=$(node scripts/build-fingerprint.mjs)`.
2. Back up the database ([restore.md](restore.md)). Apply migrations as the migration role: `docker compose -f deploy/docker-compose.yml run --rm migrate` (migrations are additive/forward-only; a modified applied file is refused by checksum).
3. Start with calls **off**: `docker compose -f deploy/docker-compose.yml up -d`. Check `curl -s localhost:8080/health/live`, then `/v1/capabilities` (authenticated).
4. Rolling update: the container gets SIGTERM, stops claiming work, finishes the in-flight tick, closes the server and DB (measured ≈1.1 s; hard cap 30 s). Never run two gateways on one Telegram session.

**Roll back:** deploy the previous image with calls disabled and the kill switch on until health is confirmed. Schema is expand/contract: do not roll the schema back
destructively; the previous image must tolerate newer additive columns (all migrations to date are additive). If a migration itself is bad, restore from backup.

**Not yet verified:** the Docker image build in CI, and a real host canary (UDP/relay egress, session persistence) — gate G0-F.
