import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import type { Database } from './types.js';
import { SafeDiagnosticError, safeDatabaseFailure } from './diagnostics.js';

/** URL TLS flags can override pg's ssl object, so reject weaker modes first. */
export function postgresOptions(connectionString: string): PoolConfig {
  let url: URL;
  try { url = new URL(connectionString); }
  catch { throw new SafeDiagnosticError('DB_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new SafeDiagnosticError('DB_URL_INVALID');
  for (const [key, value] of url.searchParams) {
    if (!key.toLowerCase().startsWith('ssl')) continue;
    if (key !== 'sslmode' || value !== 'verify-full') throw new SafeDiagnosticError('DB_TLS_POLICY_INVALID');
  }
  url.searchParams.delete('sslmode');
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true } };
}

/** A transaction always uses the same checked-out PostgreSQL connection. */
export class PgDatabase implements Database {
  private readonly pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool(postgresOptions(connectionString));
    // Without a listener, an idle-client error (DB restart, network reset) is
    // an unhandled 'error' event and kills the process with exit code 1.
    this.pool.on('error', () => console.error(JSON.stringify({ event: 'db_idle_client_error' })));
  }

  async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> {
    try {
      const result = await this.pool.query(sql, values);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    } catch (error) { throw safeDatabaseFailure(error); }
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch(error => { throw safeDatabaseFailure(error); });
    const scoped: Database = {
      async query<R>(sql: string, values?: unknown[]) {
        try {
          const result = await client.query(sql, values);
          return { rows: result.rows as R[], rowCount: result.rowCount };
        } catch (error) { throw safeDatabaseFailure(error); }
      },
      transaction: fn => fn(scoped),
      async close() {},
    };
    try {
      await scoped.query('BEGIN');
      const result = await fn(scoped);
      await scoped.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

export async function migrate(db: Database): Promise<void> {
  const files = (await readdir(resolve('migrations'))).filter(file => /^\d+_[a-z_]+\.sql$/.test(file)).sort();
  await db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(84832601)');
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      const version = Number(file.split('_')[0]);
      const applied = await tx.query('SELECT version FROM schema_migrations WHERE version = $1', [version]);
      if (applied.rows.length) continue;
      const sql = await readFile(resolve('migrations', file), 'utf8');
      for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await tx.query(statement);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    }
  });
}
