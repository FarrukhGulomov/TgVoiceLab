import { scrub } from '../../infrastructure/observability/logger.js';
import type { Queryable } from '../../infrastructure/db/db.js';

export interface AuditEntry {
  ownerId?: string | null;
  actorType: 'owner' | 'contact' | 'system' | 'unknown' | 'admin_api';
  actorId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  allowed: boolean;
  reasonCode: string;
  correlationId?: string;
  /** IDs and codes only. Passed through the same scrubber as logs, but do not rely on it for content. */
  metadata?: Record<string, unknown>;
}

export async function writeAudit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_events (owner_id, actor_type, actor_id, action, resource_type, resource_id, allowed, reason_code, correlation_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.ownerId ?? null, e.actorType, e.actorId ?? null, e.action, e.resourceType ?? null, e.resourceId ?? null, e.allowed, e.reasonCode, e.correlationId ?? null, JSON.stringify(scrub(e.metadata ?? {}))],
  );
}
