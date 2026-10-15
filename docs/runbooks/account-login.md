# Account login / re-authentication

Use a **dedicated** Telegram account (its own phone number). Never your personal account.

1. `.env`: set `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` (my.telegram.org). Do not paste them anywhere else.
2. `pnpm spike:login` in a real terminal. Enter phone, then the login code and 2FA password at the hidden prompts. The session is written to `.local/secrets/telegram.session` (mode 600) and is **not printed**.
3. Note the printed **assistant numeric id**. It must differ from yours.
4. First time only: `pnpm bootstrap:owner` — enter your numeric id, the assistant id, the session reference (`file:/abs/path/.local/secrets/telegram.session`), then retype the confirmation phrase.
5. Set `MESSAGING_ADAPTER=telegram`, `TELEGRAM_SESSION_SECRET_REF=file:…` and restart. Startup verifies the logged-in id equals the bootstrapped assistant id and **refuses to run** otherwise.

If Telegram revoked the session ("not authorized"): repeat step 2 (it overwrites the file), then restart. Do not run two processes with the same session.
