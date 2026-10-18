-- A text message to a contact that the free-form text AI composed waits for the owner's "ha" as a draft of its own kind.
ALTER TABLE conversation_drafts DROP CONSTRAINT conversation_drafts_kind_check;
ALTER TABLE conversation_drafts ADD CONSTRAINT conversation_drafts_kind_check CHECK (kind IN ('create_reminder', 'confirm_call', 'confirm_message'));
