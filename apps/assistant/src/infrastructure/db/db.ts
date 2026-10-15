import pg from 'pg';
import type { Logger } from '../observability/logger.js';

/** Minimal structural query surface satisfied by Db, pg.Pool and pg.PoolClient. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

pg.types.setTypeParser(1700, (v) => v); // numeric stays string; no float surprises
pg.types.setTypeParser(20, (v) => v); // int8 stays string (Telegram ids, fencing tokens)

export class Db {
  readonly pool: pg.Pool;
  constructor(
    connectionString: string,
    private readonly log?: Logger,
    max = 10,
  ) {
    this.pool = new pg.Pool({ connectionString, max });
    this.pool.on('error', (err) => this.log?.error({ err: err.message }, 'idle pg client error'));
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) {
    return this.pool.query<R>(text, params);
  }

  /** Run `fn` in a transaction; rolls back on any throw. */
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {
        /* connection already dead */
      }
      throw e;
    } finally {
      c.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}
