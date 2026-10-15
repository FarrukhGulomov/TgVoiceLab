# Flood wait / account restriction

Symptoms: send/dial errors naming `FLOOD_WAIT`, `PEER_FLOOD`, `USER_PRIVACY_RESTRICTED`, account limited notices.

- Never loop or bypass. A `DialRejectedError` is terminal for that request; the owner is notified (`call.notify`); the job is not retried (`max_attempts=1`).
- Messaging: outbox retries use exponential backoff with jitter and dead-letter after 8 attempts; check `SELECT type, delivery_state, attempts, last_error FROM outbox WHERE delivery_state <> 'delivered' ORDER BY created_at DESC LIMIT 50;`.
- Reduce traffic, wait out the stated period, and keep use narrow and owner-authorized.
- If the account is restricted/banned: open the official Telegram appeal from a trusted device; set `UPDATE telegram_accounts SET status='restricted'` so the dial policy returns `account_unhealthy`.
