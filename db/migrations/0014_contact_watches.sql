-- "Tell me when X replies": one active watch per contact. A reply from a vouched contact is always relayed to the owner as text;
-- a 'call' watch additionally rings the owner once (then fired_at is set).
CREATE TABLE contact_watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  contact_id uuid NOT NULL REFERENCES contacts (id),
  mode text NOT NULL CHECK (mode IN ('text', 'call')),
  expires_at timestamptz NOT NULL,
  fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contact_watches_one_active ON contact_watches (owner_id, contact_id) WHERE fired_at IS NULL;
