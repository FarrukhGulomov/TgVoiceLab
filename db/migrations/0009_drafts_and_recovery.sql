-- Audit F16: one bounded, expiring clarification draft per owner. The draft holds free text (a reminder title), so it is stored
-- sealed (owner/column-bound AEAD) like every other content column.
CREATE TABLE conversation_drafts (
  owner_id uuid PRIMARY KEY REFERENCES owners (id),
  kind text NOT NULL CHECK (kind IN ('create_reminder')),
  draft_enc text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX conversation_drafts_expiry ON conversation_drafts (expires_at);

-- Audit F15: durable per-chat recovery watermark (highest incoming Telegram message id fully processed), so restart recovery can
-- page back to exactly where it left off instead of re-reading only the last 50 messages.
CREATE TABLE recovery_watermarks (
  account_id uuid NOT NULL REFERENCES telegram_accounts (id),
  chat_id text NOT NULL,
  last_message_id bigint NOT NULL CHECK (last_message_id >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, chat_id)
);
