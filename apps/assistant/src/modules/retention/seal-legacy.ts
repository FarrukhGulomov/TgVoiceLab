import type { Db } from '../../infrastructure/db/db.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import { sealPlan, redactedPlan } from '../calls/plan-store.js';
import { CONTEXT_AAD_COLUMN } from '../contacts/contacts.service.js';
import { IDEMPOTENCY_AAD_COLUMN } from '../idempotency/idempotency.js';

/**
 * Seal plaintext copies written before audit F10 (call plans, permission context, idempotency responses). Idempotent and safe
 * to run at every start: a row is touched only while it still holds clear text. A forward migration cannot do this because the
 * key never enters SQL.
 */
export async function sealLegacyPlaintext(
  db: Db,
  crypto: DataCrypto,
): Promise<{ plans: number; authorizations: number; permissions: number; idempotency: number }> {
  const out = { plans: 0, authorizations: 0, permissions: 0, idempotency: 0 };
  await db.tx(async (c) => {
    const plans = await c.query<{ id: string; owner_id: string; plan: Record<string, unknown> }>(
      `SELECT id, owner_id, plan FROM call_requests WHERE plan_enc IS NULL AND plan ? 'purpose' FOR UPDATE`,
    );
    for (const r of plans.rows) {
      const sealed = sealPlan(crypto, r.owner_id, r.plan as never);
      await c.query('UPDATE call_requests SET plan=$2, plan_enc=$3 WHERE id=$1', [r.id, JSON.stringify(sealed.shell), sealed.enc]);
      out.plans++;
    }
    const auths = await c.query<{ id: string; plan: Record<string, unknown> }>(`SELECT id, plan FROM authorizations WHERE plan ? 'purpose' FOR UPDATE`);
    for (const r of auths.rows) {
      await c.query('UPDATE authorizations SET plan=$2 WHERE id=$1', [r.id, JSON.stringify(redactedPlan(r.plan as never))]);
      out.authorizations++;
    }
    const perms = await c.query<{ id: string; owner_id: string; context_allowlist: string[] }>(
      `SELECT id, owner_id, context_allowlist FROM contact_permissions WHERE EXISTS (SELECT 1 FROM unnest(context_allowlist) e WHERE e NOT LIKE 'e1.%') FOR UPDATE`,
    );
    for (const r of perms.rows) {
      const next = r.context_allowlist.map((e) => (e.startsWith('e1.') ? e : crypto.enc(r.owner_id, CONTEXT_AAD_COLUMN, e)));
      await c.query('UPDATE contact_permissions SET context_allowlist=$2 WHERE id=$1', [r.id, next]);
      out.permissions++;
    }
    const idem = await c.query<{ id: string; owner_id: string; response: unknown }>(
      `SELECT id, owner_id, response FROM idempotency_keys WHERE response IS NOT NULL AND jsonb_typeof(response) <> 'string' FOR UPDATE`,
    );
    for (const r of idem.rows) {
      await c.query('UPDATE idempotency_keys SET response=$2 WHERE id=$1', [
        r.id,
        JSON.stringify(crypto.enc(r.owner_id, IDEMPOTENCY_AAD_COLUMN, JSON.stringify(r.response))),
      ]);
      out.idempotency++;
    }
  });
  return out;
}
