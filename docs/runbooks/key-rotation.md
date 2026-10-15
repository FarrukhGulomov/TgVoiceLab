# Data-encryption key rotation

1. Add a new key to the ring file and make it active (keep the old one for decryption):
   `{"active":"k2","keys":{"k1":"<base64-32B>","k2":"<base64-32B>"}}` (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`; file mode 600).
2. Restart the service (new writes use `k2`).
3. `pnpm keys:rotate` re-encrypts all stored envelopes under the active key and prints `{"reencrypted":N,"remainingOnOldKeys":0}` (counts only; idempotent; safe to interrupt and re-run).
4. When `remainingOnOldKeys` is 0 **and** the outbox is drained (`SELECT count(*) FROM outbox WHERE delivery_state='pending'` = 0; reply payloads are transient), remove `k1` from the ring and restart.
5. Old backups still need `k1` to be readable — keep it in escrow until those backups expire (30 days).

Compromise of a key: rotate as above immediately, then treat all content encrypted under the old key as exposed.
