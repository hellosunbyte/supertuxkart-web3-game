import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';

export interface Sql {
  query<T extends Record<string, any> = Record<string, any>>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(run: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function postgres(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(run) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await run(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    close: () => pool.end(),
  };
}
export async function migrate(db: Database) {
  // One transaction + advisory lock prevents two deploys racing schema changes.
  await db.transaction(async sql => {
    await sql.query('SELECT pg_advisory_xact_lock(20831002)');
    await sql.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
      if ((await sql.query('SELECT name FROM schema_migrations WHERE name = $1', [name])).rows.length) continue;
      await sql.query(await readFile(new URL(name, directory), 'utf8'));
      await sql.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
  });
}
