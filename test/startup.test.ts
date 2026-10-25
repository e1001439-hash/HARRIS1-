import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { initializeService, type StartupDependencies } from '../src/startup.js';
import { SafeDiagnosticError, startupDiagnostic, safeDatabaseFailure } from '../src/diagnostics.js';
import { loadConfig } from '../src/config.js';
import { postgresOptions, PgDatabase } from '../src/db.js';
import { emptyFacts } from '../src/knowledge.js';
import type { Database } from '../src/types.js';

const privateText = 'FAKE-PRIVATE-password-postgresql://secret@host/token';
const env = { DATABASE_URL: 'postgresql://fake:fake@localhost/fake', LINE_CHANNEL_SECRET: 'fake-secret', LINE_CHANNEL_ACCESS_TOKEN: 'fake-token', OWNER_LINE_USER_ID: `U${'1'.repeat(32)}` };
const failing = (code: string) => Object.assign(new Error(privateText, { cause: new Error(privateText) }), { code, detail: privateText, toJSON() { throw new Error(privateText); } });

function fixture(overrides: Partial<StartupDependencies> = {}) {
  let closed = 0;
  const db: Database = { async query() { return { rows: [] }; }, async transaction(fn) { return fn(db); }, async close() { closed++; } };
  const runtime = { async close() { await db.close(); } };
  const dependencies: StartupDependencies = {
    async loadEnvironment() {}, config: () => loadConfig(env), async readKnowledge() { return 'fake-knowledge'; },
    async readFacts() { return emptyFacts(); }, database: () => db, async migrate() {},
    clients: () => ({ ai: { async generate() { throw new Error('unused'); } }, line: { async reply() {}, async push() {} } }),
    async runtime() { return runtime; }, ...overrides,
  };
  return { dependencies, db, runtime, closed: () => closed };
}

test('configuration diagnostics expose only allowlisted field names', () => {
  assert.throws(() => loadConfig({}), error => {
    const diagnostic = startupDiagnostic('configuration', error);
    assert.deepEqual(diagnostic, { event: 'startup_failed', stage: 'configuration', code: 'CONFIG_MISSING', fields: ['DATABASE_URL', 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'OWNER_LINE_USER_ID'] }); return true;
  });
  for (const patch of [{ OWNER_LINE_USER_ID: privateText }, { BOT_MODE: privateText }, { TEST_LINE_USER_IDS: env.OWNER_LINE_USER_ID }, { BOOKING_URL: privateText }, { PUBLIC_SITE_URL: privateText }]) {
    assert.throws(() => loadConfig({ ...env, ...patch, PRIVATE_FIELD: privateText }), error => {
      const diagnostic = startupDiagnostic('configuration', error);
      assert.equal(diagnostic.code, 'CONFIG_INVALID');
      assert.ok(!JSON.stringify(diagnostic).includes(privateText));
      assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE_FIELD')); return true;
    });
  }
  assert.throws(() => loadConfig({ ...env, RESPONSE_MODE: 'ai' }), error => {
    assert.deepEqual(startupDiagnostic('configuration', error).fields, ['SALON_AI_API_KEY', 'AI_MODEL']); return true;
  });
});

test('diagnostic serialization ignores messages, stacks, causes, getters, toJSON and unknown fields', () => {
  const codes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', '28P01', '28000', '3D000', '42501'];
  for (const code of codes) {
    const safe = safeDatabaseFailure(failing(code));
    const diagnostic = startupDiagnostic('database_migration', safe);
    assert.equal(diagnostic.code, code);
    assert.ok(!JSON.stringify(safe).includes(privateText));
    assert.ok(!JSON.stringify(diagnostic).includes(privateText));
    assert.equal(safe.cause, undefined);
  }
  let getterCalls = 0;
  const getter = Object.defineProperty({}, 'code', { get() { getterCalls++; throw new Error(privateText); } });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(privateText); }, getPrototypeOf() { throw new Error(privateText); } });
  for (const error of [failing(privateText), getter, proxy, privateText, null, { cause: failing('28P01') }]) {
    assert.deepEqual(startupDiagnostic('database_migration', safeDatabaseFailure(error)), { event: 'startup_failed', stage: 'database_migration', code: 'UNKNOWN' });
  }
  assert.equal(getterCalls, 0);
  const spoof = Object.assign(new Error(privateText), { code: 'CONFIG_INVALID', fields: ['PRIVATE_FIELD'], stage: privateText });
  assert.equal(startupDiagnostic('configuration', spoof).code, 'UNKNOWN');
  const safe = new SafeDiagnosticError('CONFIG_INVALID', ['OWNER_LINE_USER_ID']);
  Object.assign(safe, { code: privateText, fields: [privateText], stage: privateText });
  assert.deepEqual(startupDiagnostic('configuration', safe), { event: 'startup_failed', stage: 'configuration', code: 'CONFIG_INVALID', fields: ['OWNER_LINE_USER_ID'] });
  assert.deepEqual(startupDiagnostic(privateText as never, new SafeDiagnosticError(privateText as never, [privateText as never])), { event: 'startup_failed', stage: 'unknown', code: 'UNKNOWN' });
});

test('database URL and TLS policy errors keep only fixed classifications', () => {
  for (const [url, code] of [[privateText, 'DB_URL_INVALID'], ['https://fake.example', 'DB_URL_INVALID'], [`${env.DATABASE_URL}?sslmode=require`, 'DB_TLS_POLICY_INVALID'], [`${env.DATABASE_URL}?sslrootcert=${privateText}`, 'DB_TLS_POLICY_INVALID']]) {
    assert.throws(() => postgresOptions(url!), error => {
      assert.deepEqual(startupDiagnostic('database_configuration', error), { event: 'startup_failed', stage: 'database_configuration', code });
      assert.ok(!String(error).includes(privateText)); return true;
    });
  }
  assert.deepEqual(postgresOptions(`${env.DATABASE_URL}?sslmode=verify-full`).ssl, { rejectUnauthorized: true });
});

test('PgDatabase preserves safe driver classifications at pool and transaction boundaries', async () => {
  const queryMock = mock.method(Pool.prototype, 'query', async () => { throw failing('ERR_TLS_CERT_ALTNAME_INVALID'); });
  const connectMock = mock.method(Pool.prototype, 'connect', async () => { throw failing('28P01'); });
  const db = new PgDatabase(env.DATABASE_URL);
  try {
    await assert.rejects(db.query('SELECT 1'), error => { assert.equal(startupDiagnostic('database_migration', error).code, 'ERR_TLS_CERT_ALTNAME_INVALID'); assert.ok(!JSON.stringify(error).includes(privateText)); return true; });
    await assert.rejects(db.transaction(async () => undefined), error => { assert.equal(startupDiagnostic('database_migration', error).code, '28P01'); return true; });
  } finally { queryMock.mock.restore(); connectMock.mock.restore(); await db.close(); }
});

test('transaction query failures preserve a safe code and still roll back and release', async () => {
  const statements: string[] = [];
  let released = false;
  const client = { async query(sql: string) { statements.push(sql); if (sql === 'SELECT 1') throw failing('42501'); return { rows: [], rowCount: 0 }; }, release() { released = true; } };
  const connectMock = mock.method(Pool.prototype, 'connect', async () => client);
  const db = new PgDatabase(env.DATABASE_URL);
  try {
    await assert.rejects(db.transaction(tx => tx.query('SELECT 1')), error => {
      assert.deepEqual(startupDiagnostic('database_migration', error), { event: 'startup_failed', stage: 'database_migration', code: '42501' });
      assert.ok(!JSON.stringify(error).includes(privateText)); return true;
    });
    assert.deepEqual(statements, ['BEGIN', 'SELECT 1', 'ROLLBACK']);
    assert.equal(released, true);
  } finally { connectMock.mock.restore(); await db.close(); }
});

test('startup reports the actual failed stage and original classification even when cleanup fails', async () => {
  for (const [stage, override] of [
    ['environment', { async loadEnvironment() { throw failing('EACCES'); } }],
    ['configuration', { config() { throw new SafeDiagnosticError('CONFIG_INVALID', ['BOT_MODE']); } }],
    ['knowledge', { async readKnowledge() { throw failing('ENOENT'); } }],
    ['facts', { async readFacts() { throw failing('EACCES'); } }],
    ['database_configuration', { database() { throw new SafeDiagnosticError('DB_URL_INVALID'); } }],
    ['database_migration', { async migrate() { throw safeDatabaseFailure(failing('ENOTFOUND')); } }],
    ['clients', { clients() { throw failing(privateText); } }],
    ['runtime', { async runtime() { throw failing('EADDRINUSE'); } }],
  ] as const) {
    const f = fixture(override);
    f.db.close = async () => { throw failing(privateText); };
    const result = await initializeService(f.dependencies);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('expected failure');
    assert.equal(result.diagnostic.stage, stage);
    assert.ok(!JSON.stringify(result).includes(privateText));
    if (stage === 'database_migration') assert.equal(result.diagnostic.code, 'ENOTFOUND');
    if (stage === 'runtime') assert.equal(result.diagnostic.code, 'EADDRINUSE');
  }
});

test('real local knowledge and facts failures identify missing files and JSON/schema errors without paths or content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harris-diagnostic-'));
  try {
    const absent = await initializeService({ ...fixture().dependencies, readKnowledge: async () => { const { readFile } = await import('node:fs/promises'); return readFile(join(dir, privateText.replaceAll('/', '_')), 'utf8'); } });
    assert.equal(absent.ok, false);
    if (!absent.ok) assert.equal(absent.diagnostic.code, 'ENOENT');
    const absentFacts = await initializeService({ ...fixture().dependencies, readFacts: async () => { const { loadFacts } = await import('../src/knowledge.js'); return loadFacts(join(dir, 'missing-facts.json')); } });
    assert.equal(absentFacts.ok, false);
    if (!absentFacts.ok) assert.deepEqual(absentFacts.diagnostic, { event: 'startup_failed', stage: 'facts', code: 'ENOENT' });
    for (const [content, code] of [[`{"private":"${privateText}",`, 'FACTS_JSON_INVALID'], [JSON.stringify({ private: privateText }), 'FACTS_SCHEMA_INVALID']]) {
      await writeFile(join(dir, 'facts.json'), content!);
      const result = await initializeService({ ...fixture().dependencies, readFacts: async () => { const { loadFacts } = await import('../src/knowledge.js'); return loadFacts(join(dir, 'facts.json')); } });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.diagnostic.code, code);
      assert.ok(!JSON.stringify(result).includes(privateText));
      assert.ok(!JSON.stringify(result).includes(dir));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('successful startup keeps owner-only fixed defaults and delegates normal shutdown', async () => {
  const f = fixture();
  const result = await initializeService(f.dependencies);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('expected success');
  assert.equal(result.config.mode, 'test'); assert.equal(result.config.responseMode, 'fixed');
  assert.deepEqual(result.config.testUserIds, []);
  assert.equal(f.closed(), 0);
  await result.runtime.close();
  assert.equal(f.closed(), 1);
});
