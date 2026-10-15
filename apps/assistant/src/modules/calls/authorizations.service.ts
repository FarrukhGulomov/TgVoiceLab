import { ApprovedCallPlanSchema, CallPlanBodySchema, type ApprovedCallPlan, type CallPlanBody } from '@tgvl/contracts';
import type { Db } from '../../infrastructure/db/db.js';
import type { Clock } from '../../application/clock.js';
import { NotFoundError, ValidationError, DomainError } from '../../application/errors.js';
import { writeAudit } from '../audit/audit.js';
import { computePlanHash } from './plan-hash.js';

/**
 * Immutable call briefs + exact-plan authorizations. The plan JSON and its hash are written once; approval must present
 * the same hash. A contact allowlist/permission alone never creates an authorization.
 */
export class AuthorizationService {
  constructor(private readonly db: Db, private readonly clock: Clock) {}

  /** Create the brief (pending). Returns what the owner must approve. If `ownerExplicitCommand`, approval is recorded immediately. */
  async createCallRequest(ownerId: string, bodyIn: CallPlanBody, opts: { ownerExplicitCommand?: boolean; sourceMessageId?: string } = {}): Promise<{ callRequestId: string; authorizationId: string; planHash: string; plan: ApprovedCallPlan; state: 'pending' | 'approved' }> {
    const body = CallPlanBodySchema.parse(bodyIn);
    if (body.ownerId !== ownerId) throw new DomainError('forbidden', 'plan belongs to another owner');
    const now = this.clock.now();
    if (new Date(body.expiresAt).getTime() <= now.getTime()) throw new ValidationError('plan already expired');
    const planHash = computePlanHash(body);

    return this.db.tx(async (c) => {
      const contact = await c.query<{ id: string; telegram_user_id: string; verified_at: Date | null }>('SELECT id, telegram_user_id, verified_at FROM contacts WHERE owner_id=$1 AND telegram_user_id=$2', [ownerId, body.recipientTelegramId]);
      const ct = contact.rows[0];
      if (!ct) throw new NotFoundError('contact');
      if (!ct.verified_at) throw new ValidationError('contact identity is not verified (numeric id required)');
      const perm = await c.query<{ version: number }>('SELECT version FROM contact_permissions WHERE contact_id=$1 AND owner_id=$2 ORDER BY version DESC LIMIT 1', [ct.id, ownerId]);
      const permissionVersion = perm.rows[0]?.version ?? 0;

      const auth = await c.query<{ id: string }>(
        `INSERT INTO authorizations (owner_id, action, target_contact_id, plan, plan_hash, source_message_id, state, expires_at, approved_at, created_at)
         VALUES ($1,'contact_call',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [ownerId, ct.id, JSON.stringify(body), planHash, opts.sourceMessageId ?? null, opts.ownerExplicitCommand ? 'approved' : 'pending', body.expiresAt, opts.ownerExplicitCommand ? now : null, now],
      );
      const authorizationId = auth.rows[0]!.id;
      const plan = ApprovedCallPlanSchema.parse({ ...body, authorizationId, permissionVersion, planHash });
      const req = await c.query<{ id: string }>(
        `INSERT INTO call_requests (id, owner_id, contact_id, plan, plan_hash, authorization_id, permission_version, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [body.callRequestId, ownerId, ct.id, JSON.stringify(plan), planHash, authorizationId, permissionVersion, opts.ownerExplicitCommand ? 'queued' : 'pending_authorization'],
      );
      await writeAudit(c, { ownerId, actorType: 'owner', action: opts.ownerExplicitCommand ? 'authorization.explicit_command' : 'authorization.create', resourceType: 'authorization', resourceId: authorizationId, allowed: true, reasonCode: 'ok', metadata: { planHash } });
      return { callRequestId: req.rows[0]!.id, authorizationId, planHash, plan, state: opts.ownerExplicitCommand ? 'approved' : 'pending' } as const;
    });
  }

  /** Approve exactly the plan the owner saw: the presented hash must equal the stored hash. */
  async approve(ownerId: string, authorizationId: string, presentedPlanHash: string): Promise<void> {
    const now = this.clock.now();
    await this.db.tx(async (c) => {
      const a = await c.query<{ plan_hash: string; state: string; expires_at: Date }>('SELECT plan_hash, state, expires_at FROM authorizations WHERE id=$1 AND owner_id=$2 FOR UPDATE', [authorizationId, ownerId]);
      const row = a.rows[0];
      if (!row) throw new NotFoundError('authorization');
      if (row.plan_hash !== presentedPlanHash) throw new DomainError('plan_changed', 'the plan changed since it was shown; review and approve again');
      if (row.state !== 'pending') throw new DomainError('invalid_state', `authorization is ${row.state}`);
      if (row.expires_at.getTime() <= now.getTime()) throw new DomainError('expired', 'authorization expired');
      await c.query(`UPDATE authorizations SET state='approved', approved_at=$2 WHERE id=$1`, [authorizationId, now]);
      await c.query(`UPDATE call_requests SET status='queued' WHERE authorization_id=$1 AND owner_id=$2 AND status='pending_authorization'`, [authorizationId, ownerId]);
      await writeAudit(c, { ownerId, actorType: 'owner', action: 'authorization.approve', resourceType: 'authorization', resourceId: authorizationId, allowed: true, reasonCode: 'ok' });
    });
  }
}
