-- The owner confirms in chat before the calling kill switch is switched OFF (switching it ON needs no confirmation).
ALTER TABLE conversation_drafts DROP CONSTRAINT conversation_drafts_kind_check;
ALTER TABLE conversation_drafts ADD CONSTRAINT conversation_drafts_kind_check CHECK (kind IN ('create_reminder', 'confirm_call', 'confirm_message', 'confirm_clear_calls', 'confirm_kill_switch_off'));
