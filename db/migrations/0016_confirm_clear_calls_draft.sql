-- The owner confirms in chat that no real call is live before outcome_unknown calls are cleared.
ALTER TABLE conversation_drafts DROP CONSTRAINT conversation_drafts_kind_check;
ALTER TABLE conversation_drafts ADD CONSTRAINT conversation_drafts_kind_check CHECK (kind IN ('create_reminder', 'confirm_call', 'confirm_message', 'confirm_clear_calls'));
