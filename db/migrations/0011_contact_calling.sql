-- 0011: calls to contacts on the owner's behalf.
-- ai_consent_*: the OWNER's attestation that the contact was told in advance that an AI assistant may call and that the conversation
-- is processed by an AI service. It is the owner's statement, recorded as such (consent_events.source = 'owner_attested'); it is not
-- the participant's own consent and is never labelled as such. Revocable at any time.
ALTER TABLE contacts ADD COLUMN ai_consent_attested_at timestamptz;
ALTER TABLE contacts ADD COLUMN ai_consent_revoked_at timestamptz;
-- How the assistant introduces its owner on a call ("I am <display_name>'s AI assistant").
ALTER TABLE owners ADD COLUMN display_name text CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 80);
