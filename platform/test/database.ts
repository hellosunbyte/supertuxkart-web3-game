import { PGlite } from '@electric-sql/pglite';
import type { Database, Sql } from '../src/db.js';
import { migrate } from '../src/db.js';

export async function testDatabase(): Promise<Database> {
  const engine = new PGlite();
  const adapt = (source: any): Sql => ({
    async query<T extends Record<string, any>>(sql: string, params?: any[]) {
      if (!params && sql.includes(';')) {
        const results = await source.exec(sql);
        return { rows: (results.at(-1)?.rows ?? []) as T[] };
      }
      return source.query(sql, params) as Promise<{ rows: T[] }>;
    },
  });
  const db: Database = { ...adapt(engine),
    transaction: run => engine.transaction(tx => run(adapt(tx))),
    close: () => engine.close(),
  };
  await migrate(db);
  return db;
}
