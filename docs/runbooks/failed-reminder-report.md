# A reminder or report did not arrive

1. Is the worker running and is messaging configured? `GET /v1/capabilities` → `messaging.adapter` must not be `disabled`.
2. Occurrence state: `SELECT r.id, o.state, o.scheduled_at, o.fired_at FROM reminder_occurrences o JOIN reminders r ON r.id=o.reminder_id ORDER BY o.scheduled_at DESC LIMIT 20;`
   - `scheduled` and overdue ⇒ job not claimed: `SELECT status, attempts, last_error, due_at FROM jobs WHERE kind='reminder.fire' ORDER BY due_at DESC LIMIT 20;` (dead ⇒ read `last_error`).
   - `fired` ⇒ delivery is in the outbox: `SELECT delivery_state, attempts, last_error, next_attempt_at FROM outbox WHERE type='reminder.notify' ORDER BY created_at DESC LIMIT 20;`
   - `skipped_stale` ⇒ it was rescheduled/cancelled (expected). `summarized_missed` ⇒ it was over 24 h late and sent as a "you missed" notice.
3. Policy reminders: a call-mode reminder is intentionally sent as a labeled message while calls are unavailable; reminders in quiet hours are sent silently.
4. Failed **reports** never re-dial: a report failure retries the message only. A call report is currently always `complete:false` (no conversation layer).
5. After fixing the cause, outbox rows retry on their own; dead rows can be re-queued with `UPDATE outbox SET delivery_state='pending', attempts=0, next_attempt_at=now() WHERE event_id='…'` — the event id is the Telegram dedupe key, so a retry cannot double-send.
