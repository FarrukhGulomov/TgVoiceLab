import pg from 'pg';

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://tgvl:tgvl_dev@localhost:5432/postgres';
export const TEMPLATE_DB = 'tgvl_template';

export function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export async function adminClient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await c.connect();
  } catch (e) {
    // Fail loudly: a silently skipped DB suite would look like success.
    throw new Error(`Integration tests need PostgreSQL at ${new URL(ADMIN_URL).host} (set TEST_DATABASE_ADMIN_URL). Original error: ${(e as Error).message}`);
  }
  return c;
}
