# ADR-0004: Application-level AEAD with key IDs and context binding; secrets by reference

Status: Accepted · Date: 2026-10-15

AES-256-GCM, random 96-bit nonce, key id in the envelope, AAD `owner:<id>|col:<column>` so ciphertext moved between owners/columns fails authentication (tested).
Key ring = `{active, keys{id: base64-32B}}` loaded via `file:`(mode ≤600)/`env:` reference; literals are never accepted. Rotation: add a new active key, keep old for
decrypt, re-encrypt using `Envelope.needsRotation` (tool not yet written — gap). Telegram session secrets are referenced the same way and never enter the database.
