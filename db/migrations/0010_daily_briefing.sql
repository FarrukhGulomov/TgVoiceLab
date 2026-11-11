-- 0010: the daily briefing is a recurring reminder of kind 'briefing' (reuses scheduling, DST, quiet hours, fencing). One active per owner.
ALTER TABLE reminders ADD COLUMN kind text NOT NULL DEFAULT 'reminder' CHECK (kind IN ('reminder', 'briefing'));
CREATE UNIQUE INDEX reminders_one_active_briefing ON reminders (owner_id) WHERE kind = 'briefing' AND status = 'active';
