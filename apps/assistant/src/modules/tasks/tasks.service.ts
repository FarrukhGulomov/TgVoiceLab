import type { Queryable } from '../../infrastructure/db/db.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import { NotFoundError, ValidationError, VersionConflictError } from '../../application/errors.js';
import { writeAudit } from '../audit/audit.js';

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  dueAt: string | null;
  version: number;
  createdAt: string;
  completedAt: string | null;
}

interface Row {
  id: string; title_enc: string; description_enc: string | null; status: TaskStatus; priority: number;
  due_at: Date | null; version: number; created_at: Date; completed_at: Date | null;
}
const COLS = 'id, title_enc, description_enc, status, priority, due_at, version, created_at, completed_at';

export class TaskService {
  constructor(private readonly crypto: DataCrypto) {}

  private map(ownerId: string, r: Row): Task {
    return {
      id: r.id,
      title: this.crypto.dec(ownerId, 'tasks.title', r.title_enc),
      description: this.crypto.decOpt(ownerId, 'tasks.description', r.description_enc),
      status: r.status,
      priority: r.priority,
      dueAt: r.due_at?.toISOString() ?? null,
      version: r.version,
      createdAt: r.created_at.toISOString(),
      completedAt: r.completed_at?.toISOString() ?? null,
    };
  }

  async create(q: Queryable, ownerId: string, i: { title: string; description?: string | undefined; priority?: number | undefined; dueAt?: Date | undefined; sourceRef?: string | undefined }): Promise<Task> {
    const title = i.title.trim();
    if (!title) throw new ValidationError('title is required');
    const r = await q.query<Row>(
      `INSERT INTO tasks (owner_id, title_enc, description_enc, priority, due_at, source_ref) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLS}`,
      [ownerId, this.crypto.enc(ownerId, 'tasks.title', title), this.crypto.encOpt(ownerId, 'tasks.description', i.description), i.priority ?? 1, i.dueAt ?? null, i.sourceRef ?? null],
    );
    const t = this.map(ownerId, r.rows[0]!);
    await writeAudit(q, { ownerId, actorType: 'owner', action: 'task.create', resourceType: 'task', resourceId: t.id, allowed: true, reasonCode: 'ok' });
    return t;
  }

  async get(q: Queryable, ownerId: string, id: string): Promise<Task> {
    const r = await q.query<Row>(`SELECT ${COLS} FROM tasks WHERE id=$1 AND owner_id=$2`, [id, ownerId]);
    if (!r.rows[0]) throw new NotFoundError('task'); // same answer whether it is absent or belongs to someone else
    return this.map(ownerId, r.rows[0]);
  }

  async list(q: Queryable, ownerId: string, f: { includeClosed?: boolean; limit?: number } = {}): Promise<Task[]> {
    const r = await q.query<Row>(
      `SELECT ${COLS} FROM tasks WHERE owner_id=$1 AND ($2::boolean OR status IN ('open','in_progress'))
       ORDER BY (due_at IS NULL), due_at, priority DESC, created_at LIMIT $3`,
      [ownerId, f.includeClosed ?? false, Math.min(f.limit ?? 50, 200)],
    );
    return r.rows.map((x) => this.map(ownerId, x));
  }

  async update(
    q: Queryable,
    ownerId: string,
    id: string,
    expectedVersion: number,
    p: { title?: string | undefined; description?: string | null | undefined; priority?: number | undefined; dueAt?: Date | null | undefined; status?: TaskStatus | undefined },
  ): Promise<Task> {
    const sets: string[] = [];
    const vals: unknown[] = [id, ownerId, expectedVersion];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (p.title !== undefined) { if (!p.title.trim()) throw new ValidationError('title cannot be empty'); add('title_enc', this.crypto.enc(ownerId, 'tasks.title', p.title.trim())); }
    if (p.description !== undefined) add('description_enc', this.crypto.encOpt(ownerId, 'tasks.description', p.description));
    if (p.priority !== undefined) add('priority', p.priority);
    if (p.dueAt !== undefined) add('due_at', p.dueAt);
    if (p.status !== undefined) {
      add('status', p.status);
      add('completed_at', p.status === 'done' ? new Date() : null);
    }
    if (!sets.length) throw new ValidationError('nothing to update');
    const r = await q.query<Row>(
      `UPDATE tasks SET ${sets.join(', ')}, version=version+1 WHERE id=$1 AND owner_id=$2 AND version=$3 RETURNING ${COLS}`,
      vals,
    );
    if (!r.rows[0]) {
      const exists = await q.query('SELECT 1 FROM tasks WHERE id=$1 AND owner_id=$2', [id, ownerId]);
      throw exists.rowCount ? new VersionConflictError('task') : new NotFoundError('task');
    }
    const t = this.map(ownerId, r.rows[0]);
    await writeAudit(q, { ownerId, actorType: 'owner', action: 'task.update', resourceType: 'task', resourceId: id, allowed: true, reasonCode: 'ok' });
    return t;
  }
}
