import { DateTime } from 'luxon';
import type { Queryable } from '../../../infrastructure/db/db.js';

/**
 * True when an earlier call to this person was already answered today (the owner's local day). The assistant greets and introduces itself
 * only on the first answered call of the day; later ones go straight to the point.
 */
export async function answeredEarlierToday(
  db: Queryable,
  ownerId: string,
  recipientTelegramId: string,
  exceptCallId: string,
  timezone: string,
  now: Date,
): Promise<boolean> {
  const dayStart = DateTime.fromJSDate(now, { zone: timezone }).startOf('day').toJSDate();
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM calls c JOIN call_requests cr ON cr.id=c.call_request_id AND cr.owner_id=c.owner_id
      WHERE c.owner_id=$1 AND c.id::text<>$2 AND cr.plan->>'recipientTelegramId'=$3 AND c.connected_at >= $4`,
    [ownerId, exceptCallId, recipientTelegramId, dayStart],
  );
  return Number(r.rows[0]?.n ?? 0) > 0;
}
