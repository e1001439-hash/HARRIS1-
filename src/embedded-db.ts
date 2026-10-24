import { PGlite } from '@electric-sql/pglite';
import type { Database } from './types.js';

/** Real embedded PostgreSQL for local demo/tests only; never used by main.ts. */
export async function createEmbeddedDatabase(dataDir?: string): Promise<Database> {
  const pg = new PGlite(dataDir); await pg.waitReady;
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const result = tail.then(fn, fn); tail = result.catch(() => {}); return result; };
  const raw: Database = {
    async query<T>(sql: string, values: unknown[] = []) { const result = await pg.query<T>(sql, values); return { rows: result.rows, rowCount: result.affectedRows }; },
    async transaction<T>(fn: (db: Database) => Promise<T>) { return fn(raw); },
    async close() { await pg.close(); },
  };
  const db: Database = {
    query: (sql, values) => exclusive(() => raw.query(sql, values)),
    transaction: fn => exclusive(async () => {
      await raw.query('BEGIN');
      try { const result = await fn(raw); await raw.query('COMMIT'); return result; }
      catch (error) { await raw.query('ROLLBACK'); throw error; }
    }),
    close: () => exclusive(() => raw.close()),
  };
  return db;
}
