import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../src/types.js';
import { migrate } from '../src/db.js';

export async function createTestDatabase(dataDir?: string): Promise<Database> {
  const engine = new PGlite(dataDir);
  await engine.waitReady;
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
  const direct: Database = {
    async query<T>(sql: string, values?: unknown[]) {
      const result = await engine.query<T>(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows };
    },
    async transaction<T>(fn: (db: Database) => Promise<T>) { return fn(direct); },
    async close() { await engine.close(); },
  };
  const db: Database = {
    query: (sql, values) => run(() => direct.query(sql, values)),
    transaction: fn => run(async () => {
      await direct.query('BEGIN');
      try {
        const result = await fn(direct);
        await direct.query('COMMIT');
        return result;
      } catch (error) {
        await direct.query('ROLLBACK');
        throw error;
      }
    }),
    close: () => run(() => direct.close()),
  };
  await migrate(db);
  return db;
}
