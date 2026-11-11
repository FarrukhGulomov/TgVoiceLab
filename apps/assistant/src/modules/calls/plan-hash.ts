import { createHash } from 'node:crypto';
import { CallPlanBodySchema, type ApprovedCallPlan, type CallPlanBody } from '@tgvl/contracts';
import { canonicalJson } from '../idempotency/idempotency.js';

/** Hash of exactly what the owner approved. Any material change (recipient, topic, questions, limits, expiry…) changes it. */
export function computePlanHash(body: CallPlanBody): string {
  return createHash('sha256')
    .update(canonicalJson(CallPlanBodySchema.parse(body)))
    .digest('hex');
}

export function planBodyOf(plan: ApprovedCallPlan): CallPlanBody {
  const { authorizationId: _a, permissionVersion: _p, planHash: _h, ...body } = plan;
  void _a;
  void _p;
  void _h;
  return body;
}
