# Runbooks

Every command here exists in this repository. `API` = `http://127.0.0.1:8080` with `Authorization: Bearer $(cat .local/secrets/admin-token)`
and a fresh `Idempotency-Key` on mutations. If a runbook says "calling", remember: **calling is currently unavailable by construction**; the call-related
procedures are written so they are correct the day a production adapter exists, and are safe (no-ops) today.

| Situation                           | Runbook                                                |
| ----------------------------------- | ------------------------------------------------------ |
| First login / re-authentication     | [account-login.md](account-login.md)                   |
| Session lost or compromised         | [session-compromise.md](session-compromise.md)         |
| Stop all calling now                | [kill-switch.md](kill-switch.md)                       |
| A call is stuck / outcome unknown   | [stuck-call.md](stuck-call.md)                         |
| Flood wait / account restriction    | [flood-wait.md](flood-wait.md)                         |
| Media outage / model outage         | [outages.md](outages.md)                               |
| A reminder or report did not arrive | [failed-reminder-report.md](failed-reminder-report.md) |
| Backup and restore                  | [restore.md](restore.md)                               |
| Key rotation                        | [key-rotation.md](key-rotation.md)                     |
| Delete someone's data               | [data-deletion.md](data-deletion.md)                   |
| Deploy and roll back                | [deploy-rollback.md](deploy-rollback.md)               |

| Enable calls to the owner | [owner-calling.md](owner-calling.md) |
