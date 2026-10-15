// Ensures the local development/test PostgreSQL role and databases exist. Dev convenience only; needs a superuser.
import pg from 'pg';
const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres' });
await admin.connect();
for (const name of ['tgvl', 'tgvl_test']) {
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!rowCount) await admin.query(`CREATE DATABASE ${name}`);
}
await admin.end();
console.log('databases ready');
