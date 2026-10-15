-- 0001_core_schema: forward-only, additive baseline. Never edited after release (checksum-verified).
-- Conventions: uuid PKs, timestamptz UTC, owner-scoped composite keys, sensitive free text stored
-- encrypted at application level (columns named *_enc hold versioned AEAD envelopes, never plaintext).

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- Append-only guard. DELETE is allowed only inside a retention job that sets app.retention_delete = 'on'.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.retention_delete', true), 'off') <> 'on' THEN
    RAISE EXCEPTION '% rows may only be deleted by the retention job', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END; $$ LANGUAGE plpgsql;

CREATE TABLE owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id text NOT NULL UNIQUE CHECK (telegram_user_id ~ '^[1-9][0-9]{0,18}$'),
  locale text NOT NULL DEFAULT 'uz' CHECK (locale IN ('uz', 'en', 'ru')),
  timezone text NOT NULL DEFAULT 'Asia/Samarkand',
  quiet_hours jsonb NOT NULL DEFAULT '{"enabled": true, "start": "22:00", "end": "08:00"}',
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER owners_updated BEFORE UPDATE ON owners FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE telegram_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  assistant_telegram_user_id text NOT NULL UNIQUE CHECK (assistant_telegram_user_id ~ '^[1-9][0-9]{0,18}$'),
  session_secret_ref text NOT NULL,           -- reference only; the session itself never enters the database
  gateway_generation bigint NOT NULL DEFAULT 0 CHECK (gateway_generation >= 0),
  status text NOT NULL DEFAULT 'unprovisioned' CHECK (status IN ('unprovisioned', 'active', 'restricted', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id),
  CHECK (assistant_telegram_user_id IS DISTINCT FROM NULL)
);
CREATE TRIGGER telegram_accounts_updated BEFORE UPDATE ON telegram_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE operation_settings (
  owner_id uuid PRIMARY KEY REFERENCES owners (id),
  calling_kill_switch boolean NOT NULL DEFAULT true,   -- fail closed: calling is OFF until explicitly enabled
  reason text,
  version integer NOT NULL DEFAULT 1,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  telegram_user_id text NOT NULL CHECK (telegram_user_id ~ '^[1-9][0-9]{0,18}$'),
  display_name text NOT NULL,
  verified_at timestamptz,
  verification_source text,
  timezone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, telegram_user_id),
  UNIQUE (owner_id, id),
  CHECK ((verified_at IS NULL) = (verification_source IS NULL))
);
CREATE TRIGGER contacts_updated BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE contact_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  allow_call boolean NOT NULL DEFAULT false,
  allow_message boolean NOT NULL DEFAULT false,
  topic_scopes text[] NOT NULL DEFAULT '{}',
  context_allowlist text[] NOT NULL DEFAULT '{}',
  allowed_hours jsonb,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, contact_id) REFERENCES contacts (owner_id, id),
  UNIQUE (contact_id, version),
  CHECK (expires_at > created_at)
);
CREATE INDEX contact_permissions_current ON contact_permissions (contact_id, version DESC);

CREATE TABLE authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  action text NOT NULL CHECK (action IN ('contact_call', 'owner_call')),
  target_contact_id uuid,
  plan jsonb NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  source_message_id text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'consumed', 'revoked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id, target_contact_id) REFERENCES contacts (owner_id, id),
  CHECK (expires_at > created_at),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK (state NOT IN ('approved', 'consumed') OR approved_at IS NOT NULL)
);

CREATE TABLE call_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  contact_id uuid,
  plan jsonb NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  authorization_id uuid,
  scheduled_at timestamptz,
  deadline timestamptz,
  permission_version integer,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'pending_authorization', 'queued', 'preflight', 'dialing', 'completed',
    'rejected', 'cancelled', 'expired', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id, contact_id) REFERENCES contacts (owner_id, id),
  FOREIGN KEY (owner_id, authorization_id) REFERENCES authorizations (owner_id, id)
);
CREATE TRIGGER call_requests_updated BEFORE UPDATE ON call_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  call_request_id uuid NOT NULL,
  account_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  authorization_id uuid NOT NULL,
  provider_call_id text,
  gateway_generation bigint NOT NULL CHECK (gateway_generation >= 0),
  state text NOT NULL CHECK (state IN (
    'preflight', 'dialing', 'ringing', 'connected', 'awaiting_consent', 'active', 'ending',
    'ended', 'rejected', 'cancelled', 'expired', 'declined', 'busy', 'no_answer', 'failed',
    'outcome_unknown', 'consent_denied')),
  consent_state text NOT NULL DEFAULT 'not_requested' CHECK (consent_state IN (
    'not_requested', 'pending', 'granted', 'denied', 'withdrawn')),
  end_reason text CHECK (end_reason IN (
    'completed', 'declined', 'busy', 'no_answer', 'privacy_restricted', 'consent_denied',
    'consent_withdrawn', 'cancelled', 'transport_error', 'duration_limit', 'budget_limit', 'outcome_unknown')),
  started_at timestamptz,
  connected_at timestamptz,
  ended_at timestamptz,
  usage jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id),
  UNIQUE (call_request_id, attempt),
  UNIQUE (authorization_id),                      -- an authorization is single-use per call attempt
  FOREIGN KEY (owner_id, call_request_id) REFERENCES call_requests (owner_id, id),
  FOREIGN KEY (owner_id, account_id) REFERENCES telegram_accounts (owner_id, id),
  FOREIGN KEY (owner_id, authorization_id) REFERENCES authorizations (owner_id, id),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CHECK (state NOT IN ('ended', 'declined', 'busy', 'no_answer', 'failed', 'consent_denied', 'cancelled') OR end_reason IS NOT NULL)
);
CREATE TRIGGER calls_updated BEFORE UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- At most one non-terminal call per assistant account. outcome_unknown deliberately occupies the account
-- until reconciled: a possibly-live call must block any new dial.
CREATE UNIQUE INDEX calls_one_active_per_account ON calls (account_id)
  WHERE state NOT IN ('ended', 'rejected', 'cancelled', 'expired', 'declined', 'busy', 'no_answer', 'failed', 'consent_denied');
CREATE INDEX calls_owner_created ON calls (owner_id, created_at);

CREATE TABLE call_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  call_id uuid NOT NULL,
  provider_event_key text NOT NULL,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',   -- allowlisted, redacted fields only
  sequence integer NOT NULL CHECK (sequence >= 0),
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (owner_id, call_id) REFERENCES calls (owner_id, id),
  UNIQUE (call_id, provider_event_key)
);

CREATE TABLE consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  call_id uuid NOT NULL,
  subject_telegram_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ai_processing', 'recording', 'transcript')),
  decision text NOT NULL CHECK (decision IN ('granted', 'denied', 'withdrawn')),
  source text NOT NULL,
  disclosure_version text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, call_id) REFERENCES calls (owner_id, id)
);
CREATE TRIGGER consent_events_append_only BEFORE UPDATE OR DELETE ON consent_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE call_reports (
  call_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generated', 'delivered', 'failed')),
  structured_result jsonb,
  narrative_enc text,
  source_refs jsonb NOT NULL DEFAULT '[]',
  complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, call_id) REFERENCES calls (owner_id, id)
);
CREATE TRIGGER call_reports_updated BEFORE UPDATE ON call_reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  title_enc text NOT NULL,
  description_enc text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  priority integer NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 3),
  due_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  source_ref text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id),
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE TRIGGER tasks_updated BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX tasks_owner_status_due ON tasks (owner_id, status, due_at);

CREATE TABLE reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  task_id uuid,
  title_enc text NOT NULL,
  local_wall_clock timestamp NOT NULL,         -- local intent (no zone); recurrence anchor
  timezone text NOT NULL,                      -- IANA
  recurrence jsonb,
  next_occurrence_at timestamptz,
  mode text NOT NULL DEFAULT 'message' CHECK (mode IN ('message', 'call')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'completed')),
  schedule_version integer NOT NULL DEFAULT 1 CHECK (schedule_version >= 1),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  missed_policy text NOT NULL DEFAULT 'deliver_once_within_24h',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id, task_id) REFERENCES tasks (owner_id, id)
);
CREATE TRIGGER reminders_updated BEFORE UPDATE ON reminders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX reminders_next ON reminders (next_occurrence_at) WHERE status = 'active';

CREATE TABLE reminder_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  reminder_id uuid NOT NULL,
  schedule_version integer NOT NULL,
  scheduled_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'scheduled' CHECK (state IN (
    'scheduled', 'fired', 'cancelled', 'skipped_stale', 'summarized_missed')),
  fired_at timestamptz,
  FOREIGN KEY (owner_id, reminder_id) REFERENCES reminders (owner_id, id),
  UNIQUE (reminder_id, schedule_version, scheduled_at)
);
CREATE INDEX reminder_occurrences_due ON reminder_occurrences (state, scheduled_at);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  contact_id uuid,
  actor_role text NOT NULL CHECK (actor_role IN ('owner', 'contact')),
  channel text NOT NULL CHECK (channel IN ('telegram_text', 'telegram_voice_note', 'telegram_call')),
  external_id text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  retention_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id),
  FOREIGN KEY (owner_id, contact_id) REFERENCES contacts (owner_id, id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES telegram_accounts (id),
  provider_message_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content_enc text,
  confidence real CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  occurred_at timestamptz NOT NULL,
  retention_expires_at timestamptz,
  FOREIGN KEY (owner_id, conversation_id) REFERENCES conversations (owner_id, id),
  UNIQUE (account_id, direction, provider_message_id)
);
CREATE INDEX messages_retention ON messages (retention_expires_at) WHERE retention_expires_at IS NOT NULL;

-- Durable inbound-update dedupe and gap-recovery cursor (survives restarts; not an in-memory cache).
CREATE TABLE inbound_updates (
  account_id uuid NOT NULL REFERENCES telegram_accounts (id),
  update_key text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, update_key)
);
CREATE TABLE update_cursors (
  account_id uuid PRIMARY KEY REFERENCES telegram_accounts (id),
  pts bigint, qts bigint, seq bigint, date_ts bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  call_id uuid,
  action jsonb NOT NULL,
  action_hash text NOT NULL,
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'approved', 'rejected', 'executed', 'expired')),
  authorization_id uuid,
  resulting_entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, call_id) REFERENCES calls (owner_id, id),
  FOREIGN KEY (owner_id, authorization_id) REFERENCES authorizations (owner_id, id)
);

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  subject_scope text NOT NULL,                 -- e.g. 'owner:preferences', 'contact:<uuid>:claims'
  value_enc text NOT NULL,
  provenance jsonb NOT NULL,
  confidence real NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  sensitivity text NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'sensitive')),
  approved_at timestamptz,                     -- only owner-approved memories are retrievable
  expires_at timestamptz,
  superseded_by uuid REFERENCES memories (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_scope ON memories (owner_id, subject_scope) WHERE approved_at IS NOT NULL AND superseded_by IS NULL;

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  payload_version integer NOT NULL DEFAULT 1,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'done', 'cancelled', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  last_error text,
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'leased' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE TRIGGER jobs_updated BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX jobs_claimable ON jobs (status, due_at);
CREATE INDEX jobs_lease_expiry ON jobs (lease_expires_at) WHERE status = 'leased';

CREATE TABLE outbox (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  type text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}',        -- minimal; never raw conversation content
  created_at timestamptz NOT NULL DEFAULT now(),
  delivery_state text NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz
);
CREATE INDEX outbox_pending ON outbox (next_attempt_at) WHERE delivery_state = 'pending';

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners (id),
  action text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress', 'done')),
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (owner_id, action, key)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid,                               -- nullable: denied events from unknown senders have no owner
  actor_type text NOT NULL CHECK (actor_type IN ('owner', 'contact', 'system', 'unknown', 'admin_api')),
  actor_id text,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  allowed boolean NOT NULL,
  reason_code text NOT NULL,
  correlation_id text,
  metadata jsonb NOT NULL DEFAULT '{}',        -- IDs and codes only; never raw conversation content
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE INDEX audit_owner_created ON audit_events (owner_id, created_at);

CREATE TABLE usage_budgets (
  owner_id uuid NOT NULL REFERENCES owners (id),
  day date NOT NULL,
  cap_micro_usd bigint NOT NULL CHECK (cap_micro_usd >= 0),
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  actual_micro_usd bigint NOT NULL DEFAULT 0 CHECK (actual_micro_usd >= 0),
  PRIMARY KEY (owner_id, day),
  CHECK (reserved_micro_usd + actual_micro_usd <= cap_micro_usd)
);

CREATE TABLE deletion_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_id)
);
