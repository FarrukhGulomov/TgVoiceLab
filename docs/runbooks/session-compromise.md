# Lost or compromised Telegram session

Treat a leaked session file as full control of the assistant account.

1. **Stop calling immediately:** [kill-switch.md](kill-switch.md).
2. On a trusted device, open Telegram → Settings → Devices and **terminate every session** of the assistant account (and any you do not recognize).
3. Stop the service; delete the old session file (`.local/secrets/telegram.session` or the mounted secret) and any copies/backups containing it.
4. Review audit metadata: `SELECT created_at, actor_type, action, reason_code FROM audit_events ORDER BY created_at DESC LIMIT 200;` (IDs/codes only; no content is stored there).
5. Rotate the admin token (`pnpm dev:secrets` after deleting `.local/secrets/admin-token`, or your secret manager) and, if the host was exposed, the data-encryption key ([key-rotation.md](key-rotation.md)).
6. Re-login ([account-login.md](account-login.md)), restart, confirm `GET /v1/capabilities`, then switch the kill switch off only after you are satisfied.
