-- 0002: ordinal references ("the second task") resolve against the exact list last shown to the owner.
CREATE TABLE list_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  kind text NOT NULL CHECK (kind IN ('tasks', 'reminders')),
  item_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX list_snapshots_latest ON list_snapshots (owner_id, kind, created_at DESC);
