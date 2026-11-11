-- 0003: handler failures must be diagnosable, not silently swallowed.
ALTER TABLE outbox ADD COLUMN last_error text;
