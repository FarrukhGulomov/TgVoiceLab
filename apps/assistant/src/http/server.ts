import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { CallPlanBodySchema, CreateReminderBodySchema, CreateTaskBodySchema, RescheduleReminderBodySchema, UpdateTaskBodySchema } from '@tgvl/contracts';
import type { Container } from '../bootstrap/container.js';
import type { Logger } from '../infrastructure/observability/logger.js';
import { DomainError } from '../application/errors.js';
import { runIdempotent } from '../modules/idempotency/idempotency.js';
import { enqueueJob } from '../modules/jobs/jobs.js';
import { writeAudit } from '../modules/audit/audit.js';
import { deriveCapabilities } from '../modules/calls/capability-evidence.js';

export interface ServerDeps {
  app: Container;
  log: Logger;
  /** Accepted bearer tokens (more than one allows zero-downtime rotation). */
  adminTokens: string[];
  runtime: {
    messagingAdapter: string;
    interpreterAdapter: string;
    callAdapter: string;
    evidencePath: string | null;
    buildFingerprint: string;
    transcription: boolean;
  };
}

const STATUS: Record<string, number> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  plan_changed: 409,
  invalid_state: 409,
  expired: 409,
  capability_unavailable: 503,
};
const digest = (s: string) => createHash('sha256').update(s).digest();

export async function buildServer(d: ServerDeps): Promise<FastifyInstance> {
  const { app, log } = d;
  const srv = Fastify({ logger: false, bodyLimit: 256 * 1024, genReqId: () => randomUUID() });
  const tokenDigests = d.adminTokens.map(digest);

  const ok = <T>(req: FastifyRequest, rep: FastifyReply, data: T, status = 200) => rep.status(status).send({ requestId: req.id, data });
  const fail = (req: FastifyRequest, rep: FastifyReply, status: number, code: string, message: string, retryable = false, details?: unknown) =>
    rep.status(status).send({ requestId: req.id, error: { code, message, retryable, ...(details !== undefined ? { details } : {}) } });

  srv.setErrorHandler((err, req, rep) => {
    if (err instanceof ZodError)
      return fail(
        req,
        rep,
        400,
        'invalid_input',
        'request validation failed',
        false,
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    if (err instanceof DomainError) return fail(req, rep, STATUS[err.code] ?? 400, err.code, err.message, err.retryable, err.details);
    if ((err as { statusCode?: number }).statusCode === 413) return fail(req, rep, 413, 'payload_too_large', 'request body too large');
    log.error({ requestId: req.id, err: (err as Error).message }, 'unhandled request error');
    return fail(req, rep, 500, 'internal_error', 'internal error', true); // never leak internals
  });
  srv.setNotFoundHandler((req, rep) => fail(req, rep, 404, 'not_found', 'route not found'));

  // Liveness is the only unauthenticated route and exposes nothing.
  srv.get('/health/live', async (_req, rep) => rep.send({ status: 'ok' }));

  // Everything else: bearer auth (constant-time), then owner resolution.
  srv.addHook('onRequest', async (req, rep) => {
    if (req.url === '/health/live') return;
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    const supplied = m ? digest(m[1]!) : null;
    const good = supplied ? tokenDigests.some((t) => timingSafeEqual(t, supplied)) : false;
    if (!good) {
      await writeAudit(app.db, { actorType: 'unknown', action: 'admin_api', allowed: false, reasonCode: 'bad_token', correlationId: req.id }).catch(
        () => undefined,
      );
      return fail(req, rep, 401, 'unauthenticated', 'missing or invalid bearer token');
    }
  });

  const owner = async (req: FastifyRequest): Promise<string> => {
    const r = await app.db.query<{ id: string }>('SELECT id FROM owners WHERE disabled=false ORDER BY created_at LIMIT 2');
    if (r.rows.length !== 1) throw new DomainError('capability_unavailable', 'owner is not bootstrapped', true);
    void req;
    return r.rows[0]!.id;
  };

  /** Mutations: Idempotency-Key required; same key + different body => 409; replay returns the stored response. */
  const mutate =
    <B>(
      action: string,
      schema: z.ZodType<B>,
      handler: (a: { ownerId: string; body: B; c: import('pg').PoolClient; req: FastifyRequest }) => Promise<{ status: number; data: unknown }>,
    ) =>
    async (req: FastifyRequest, rep: FastifyReply) => {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length < 8 || key.length > 128)
        return fail(req, rep, 400, 'idempotency_key_required', 'Idempotency-Key header (8-128 chars) is required on mutations');
      const body = schema.parse((req.body ?? {}) as unknown);
      const ownerId = await owner(req);
      const merged = { body, params: req.params };
      const out = await runIdempotent<{ data: unknown }>(app.db, { ownerId, action, key, requestBody: merged, now: app.clock.now() }, async (c) => {
        const r = await handler({ ownerId, body, c, req });
        return { status: r.status, body: { data: r.data } };
      });
      if (out.kind === 'conflict') return fail(req, rep, 409, 'idempotency_conflict', 'this Idempotency-Key was already used with a different request');
      rep.header('Idempotent-Replayed', out.kind === 'replayed' ? 'true' : 'false');
      return rep.status(out.status).send({ requestId: req.id, data: out.body.data });
    };

  const idParam = z.object({ id: z.uuid() });

  // ---- tasks ----------------------------------------------------------------------------------------------------
  srv.post(
    '/v1/tasks',
    mutate('tasks.create', CreateTaskBodySchema, async ({ ownerId, body, c }) => ({
      status: 201,
      data: await app.tasks.create(c, ownerId, {
        title: body.title,
        description: body.description,
        priority: body.priority,
        dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
      }),
    })),
  );
  srv.get('/v1/tasks', async (req, rep) =>
    ok(req, rep, await app.tasks.list(app.db, await owner(req), { includeClosed: (req.query as Record<string, string>).includeClosed === 'true' })),
  );
  srv.patch<{ Params: { id: string } }>(
    '/v1/tasks/:id',
    mutate('tasks.update', UpdateTaskBodySchema, async ({ ownerId, body, c, req }) => {
      const { id } = idParam.parse(req.params);
      return {
        status: 200,
        data: await app.tasks.update(c, ownerId, id, body.expectedVersion, {
          title: body.title,
          description: body.description,
          priority: body.priority,
          dueAt: body.dueAt === undefined ? undefined : body.dueAt === null ? null : new Date(body.dueAt),
          status: body.status,
        }),
      };
    }),
  );

  // ---- reminders --------------------------------------------------------------------------------------------------
  srv.post(
    '/v1/reminders',
    mutate('reminders.create', CreateReminderBodySchema, async ({ ownerId, body, c }) => ({
      status: 201,
      data: await app.reminders.create(
        ownerId,
        { title: body.title, localDateTime: body.localDateTime, timezone: body.timezone, recurrence: body.recurrence, mode: body.mode, taskId: body.taskId },
        c,
      ),
    })),
  );
  const ReminderPatch = z.union([
    RescheduleReminderBodySchema.extend({ action: z.literal('reschedule').default('reschedule') }),
    z.object({ action: z.literal('cancel'), expectedVersion: z.number().int().min(1) }),
  ]);
  srv.patch<{ Params: { id: string } }>(
    '/v1/reminders/:id',
    mutate('reminders.patch', ReminderPatch, async ({ ownerId, body, c, req }) => {
      const { id } = idParam.parse(req.params);
      if (body.action === 'cancel') return { status: 200, data: await app.reminders.cancel(ownerId, id, body.expectedVersion, c) };
      return { status: 200, data: await app.reminders.reschedule(ownerId, id, body.expectedVersion, body.localDateTime, body.timezone, c) };
    }),
  );
  srv.get('/v1/reminders', async (req, rep) => ok(req, rep, await app.reminders.listActive(await owner(req))));

  // ---- contacts & permissions -------------------------------------------------------------------------------------
  srv.post(
    '/v1/contacts',
    mutate(
      'contacts.create',
      z.object({ telegramUserId: z.string().regex(/^[1-9][0-9]{0,18}$/), displayName: z.string().min(1).max(100), timezone: z.string().max(64).optional() }),
      async ({ ownerId, body, c }) => ({
        status: 201,
        data: await app.contacts.create(
          c,
          ownerId,
          { telegramUserId: body.telegramUserId, displayName: body.displayName, verificationSource: 'owner_confirmed_numeric_id', timezone: body.timezone },
          app.clock.now(),
        ),
      }),
    ),
  );
  const PermBody = z.object({
    allowCall: z.boolean(),
    topicScopes: z.array(z.string().regex(/^[a-z0-9_.-]{1,64}$/)).max(20),
    contextAllowlist: z.array(z.string().max(500)).max(20).optional(),
    allowedHours: z
      .object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })
      .nullable()
      .optional(),
    expiresAt: z.iso.datetime({ offset: true }),
    revoke: z.boolean().optional(),
  });
  srv.patch<{ Params: { id: string } }>(
    '/v1/contacts/:id/permissions',
    mutate('contacts.permissions', PermBody, async ({ ownerId, body, c, req }) => {
      const { id } = idParam.parse(req.params);
      if (body.revoke) {
        const v = await app.contacts.revoke(c, ownerId, id, app.clock.now());
        return { status: 200, data: { ...v, ...(await app.operations.onPermissionRevoked(ownerId, id)) } };
      }
      return {
        status: 200,
        data: await app.contacts.grant(
          c,
          ownerId,
          id,
          {
            allowCall: body.allowCall,
            topicScopes: body.topicScopes,
            contextAllowlist: body.contextAllowlist,
            allowedHours: body.allowedHours ?? null,
            expiresAt: new Date(body.expiresAt),
          },
          app.clock.now(),
        ),
      };
    }),
  );

  // ---- call requests, authorizations, calls --------------------------------------------------------------------------
  const CallReqBody = CallPlanBodySchema.omit({ callRequestId: true, ownerId: true }).extend({
    ownerExplicitCommand: z.boolean().default(false),
    sourceMessageId: z.string().max(128).optional(),
  });
  srv.post(
    '/v1/call-requests',
    mutate('callrequests.create', CallReqBody, async ({ ownerId, body, req }) => {
      const { ownerExplicitCommand, sourceMessageId, ...rest } = body;
      const r = await app.authorizations.createCallRequest(
        ownerId,
        { ...rest, ownerId, callRequestId: randomUUID() },
        { ownerExplicitCommand, ...(sourceMessageId ? { sourceMessageId } : {}) },
      );
      if (r.state === 'approved')
        await enqueueJob(app.db, {
          ownerId,
          kind: 'call.dial',
          dueAt: app.clock.now(),
          dedupeKey: `dial:${r.callRequestId}`,
          payload: { callRequestId: r.callRequestId },
          maxAttempts: 1,
        });
      void req;
      // 202: queued, not completed. The dial itself is subject to policy at execution time and may still be refused.
      return {
        status: 202,
        data: {
          callRequestId: r.callRequestId,
          authorizationId: r.authorizationId,
          planHash: r.planHash,
          state: r.state === 'approved' ? 'queued' : 'pending_authorization',
          plan: r.plan,
        },
      };
    }),
  );
  srv.post<{ Params: { id: string } }>(
    '/v1/authorizations/:id/approve',
    mutate('authorizations.approve', z.object({ planHash: z.string().regex(/^[a-f0-9]{64}$/) }), async ({ ownerId, body, req }) => {
      const { id } = idParam.parse(req.params);
      await app.authorizations.approve(ownerId, id, body.planHash);
      const cr = await app.db.query<{ id: string }>('SELECT id FROM call_requests WHERE authorization_id=$1 AND owner_id=$2', [id, ownerId]);
      if (cr.rows[0])
        await enqueueJob(app.db, {
          ownerId,
          kind: 'call.dial',
          dueAt: app.clock.now(),
          dedupeKey: `dial:${cr.rows[0].id}`,
          payload: { callRequestId: cr.rows[0].id },
          maxAttempts: 1,
        });
      return { status: 202, data: { approved: true } };
    }),
  );
  srv.post<{ Params: { id: string } }>(
    '/v1/calls/:id/cancel',
    mutate('calls.cancel', z.object({}).passthrough(), async ({ ownerId, req }) => {
      const { id } = idParam.parse(req.params);
      const live = app.registry.list(ownerId).find((c) => c.callId === id);
      if (live) await live.end('cancelled');
      else {
        const exists = await app.db.query('SELECT 1 FROM calls WHERE id=$1 AND owner_id=$2', [id, ownerId]);
        if (!exists.rowCount) throw new DomainError('not_found', 'call not found');
      }
      return { status: 202, data: { stopRequested: true, wasLive: !!live } };
    }),
  );
  srv.get<{ Params: { id: string } }>('/v1/calls/:id', async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const r = await app.db.query(
      `SELECT id, state, end_reason, consent_state, started_at, connected_at, ended_at, attempt FROM calls WHERE id=$1 AND owner_id=$2`,
      [id, await owner(req)],
    );
    if (!r.rows[0]) return fail(req, rep, 404, 'not_found', 'call not found');
    return ok(req, rep, r.rows[0]);
  });
  srv.get<{ Params: { id: string } }>('/v1/calls/:id/report', async (req, rep) => {
    const { id } = idParam.parse(req.params);
    const r = await app.db.query(`SELECT status, structured_result, complete, source_refs, created_at FROM call_reports WHERE call_id=$1 AND owner_id=$2`, [
      id,
      await owner(req),
    ]);
    if (!r.rows[0]) return fail(req, rep, 404, 'not_found', 'report not found');
    return ok(req, rep, r.rows[0]);
  });

  // ---- operations -------------------------------------------------------------------------------------------------
  srv.post(
    '/v1/operations/kill-switch',
    mutate('ops.killswitch', z.object({ on: z.boolean(), reason: z.string().min(1).max(200) }), async ({ ownerId, body }) => ({
      status: 200,
      data: await app.operations.setKillSwitch(ownerId, body.on, body.reason),
    })),
  );

  // ---- health & honest capability reporting (authenticated) -----------------------------------------------------------
  const capabilities = async (ownerId: string | null) => {
    const caps = deriveCapabilities(d.runtime.evidencePath, d.runtime.buildFingerprint);
    const ks = ownerId ? await app.operations.isKillSwitchOn(app.db, ownerId) : true;
    const callingAvailable = caps.productionCallingAllowed && !ks && d.runtime.callAdapter !== 'disabled';
    return {
      mode: callingAvailable ? 'calling_enabled' : 'degraded_text_only',
      calling: {
        available: callingAvailable,
        killSwitchOn: ks,
        adapter: d.runtime.callAdapter,
        privateOutbound: caps.privateOutbound,
        pcmSend: caps.pcmSend,
        pcmReceive: caps.pcmReceive,
        thirdPartyConsentMechanismProven: caps.thirdPartyConsentMechanismProven,
        productionCallingAllowed: caps.productionCallingAllowed,
        evidenceArtifact: caps.evidenceArtifact,
        buildFingerprint: caps.buildFingerprint,
        blockedBecause: caps.reasons,
      },
      messaging: { adapter: d.runtime.messagingAdapter },
      interpreter: { adapter: d.runtime.interpreterAdapter },
      voiceNotes: { transcription: d.runtime.transcription },
    };
  };
  srv.get('/v1/capabilities', async (req, rep) => {
    const o = await app.db.query<{ id: string }>('SELECT id FROM owners ORDER BY created_at LIMIT 1');
    return ok(req, rep, await capabilities(o.rows[0]?.id ?? null));
  });
  srv.get('/health/ready', async (req, rep) => {
    let dbOk = true;
    try {
      await app.db.query('SELECT 1');
    } catch {
      dbOk = false;
    }
    const pending = dbOk
      ? (await app.db.query<{ n: number }>(`SELECT count(*)::int n FROM jobs WHERE status='pending' AND due_at < now() - interval '5 minutes'`)).rows[0]!.n
      : null;
    const body = { status: dbOk ? 'ready' : 'unavailable', database: dbOk, overdueJobs: pending, capabilities: await capabilities(null) };
    return rep.status(dbOk ? 200 : 503).send({ requestId: req.id, data: body });
  });

  return srv;
}
