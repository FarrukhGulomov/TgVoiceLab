-- 0004: "stop calling me" must be durable and enforced by the dial policy, independent of any model.
ALTER TABLE owners ADD COLUMN call_opt_out boolean NOT NULL DEFAULT false;
