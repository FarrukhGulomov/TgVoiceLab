-- Audit F07: outbox settlement is fenced. Every claim bumps fencing_token; success/failure updates must present the token
-- they were given, so a worker whose lease expired can no longer overwrite the row's newer holder. Additive and rollback-safe
-- (older code ignores the column; its default keeps existing rows valid).
ALTER TABLE outbox ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0;
