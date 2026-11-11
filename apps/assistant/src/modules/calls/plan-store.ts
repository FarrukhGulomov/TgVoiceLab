import { ApprovedCallPlanSchema, type ApprovedCallPlan, type CallPlanBody } from '@tgvl/contracts';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';

/**
 * Data classification for call plans (audit F10). Routable metadata stays plaintext because policy, scheduling and operators
 * need it (ids, topic slug, language, limits, expiry, hash). Free text that can carry business context is sealed with the same
 * owner/column-bound AEAD as the primary content columns. The plan HASH is always computed over the logical plan, never over
 * ciphertext (random ciphertext would break exact-plan approval).
 */
const SENSITIVE_KEYS = ['purpose', 'questions', 'allowedContext', 'forbiddenCommitments'] as const;
export const PLAN_AAD_COLUMN = 'call_requests.plan';

type Sensitive = Pick<ApprovedCallPlan, (typeof SENSITIVE_KEYS)[number]>;

export function sealPlan(crypto: DataCrypto, ownerId: string, plan: ApprovedCallPlan | CallPlanBody): { shell: Record<string, unknown>; enc: string } {
  const shell: Record<string, unknown> = { ...plan };
  const sensitive: Record<string, unknown> = {};
  for (const k of SENSITIVE_KEYS) {
    sensitive[k] = shell[k];
    delete shell[k];
  }
  return { shell, enc: crypto.enc(ownerId, PLAN_AAD_COLUMN, JSON.stringify(sensitive)) };
}

export class PlanIntegrityError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PlanIntegrityError';
  }
}

/**
 * Rebuild the full plan. Legacy rows (no ciphertext) still hold the whole plan in `shell`. A sealed row whose shell carries
 * free-text keys, or whose ciphertext does not authenticate, has been tampered with: fail closed.
 */
export function openPlan(crypto: DataCrypto, ownerId: string, shell: unknown, enc: string | null): ApprovedCallPlan {
  if (!enc) return ApprovedCallPlanSchema.parse(shell);
  if (SENSITIVE_KEYS.some((k) => k in (shell as object))) throw new PlanIntegrityError('sealed call plan carries unexpected clear-text fields');
  let sensitive: Sensitive;
  try {
    sensitive = JSON.parse(crypto.dec(ownerId, PLAN_AAD_COLUMN, enc)) as Sensitive;
  } catch {
    throw new PlanIntegrityError('sealed call plan does not authenticate');
  }
  return ApprovedCallPlanSchema.parse({ ...(shell as object), ...sensitive });
}

/** Redacted view of a plan: safe for tables that must not hold free text (e.g. authorizations.plan). */
export function redactedPlan(plan: ApprovedCallPlan | CallPlanBody): Record<string, unknown> {
  const shell: Record<string, unknown> = { ...plan };
  for (const k of SENSITIVE_KEYS) delete shell[k];
  return shell;
}
