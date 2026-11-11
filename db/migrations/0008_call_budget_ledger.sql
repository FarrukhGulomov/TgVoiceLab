-- Audit F13: every call records WHICH day's budget it reserved from and how much, and when it was settled. Settlement is a
-- compare-and-set on budget_settled_at, so a retry, a recovery run or a resolution can never settle the same call twice, and
-- recovery after midnight releases the reservation from the ORIGINAL day instead of "today". Additive.
ALTER TABLE calls
  ADD COLUMN budget_day date,
  ADD COLUMN budget_reserved_micro bigint NOT NULL DEFAULT 0 CHECK (budget_reserved_micro >= 0),
  ADD COLUMN budget_settled_at timestamptz;
