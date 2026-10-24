import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { migrate, PgDatabase } from '../src/db.js';
import { Store } from '../src/store.js';
import type { Database, LineEvent } from '../src/types.js';

// Use an isolated local PostgreSQL database with verified TLS. For a generated
// test CA, set NODE_EXTRA_CA_CERTS before starting Node; never use a live database.
const connectionString = process.env.POSTGRES_TEST_DATABASE_URL;
const deadlineMs = 5_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), deadlineMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function wrap(db: Database, transaction: Database['transaction']): Database {
  return { query: db.query.bind(db), transaction, close: db.close.bind(db) };
}

const event = (id: string, userId: string): LineEvent => ({
  type: 'message', webhookEventId: id, timestamp: Date.now(),
  source: { type: 'user', userId }, message: { type: 'text', text: id },
});

test('a later ingest cannot become claimable while an earlier sequence is uncommitted', {
  skip: !connectionString && 'set POSTGRES_TEST_DATABASE_URL to an isolated PostgreSQL TLS database',
  timeout: 25_000,
}, async () => {
  const firstDb = new PgDatabase(connectionString!);
  const secondDb = new PgDatabase(connectionString!);
  const observer = new PgDatabase(connectionString!);
  const gateDb = new PgDatabase(connectionString!);
  const gateHeld = deferred<void>();
  const releaseGate = deferred<void>();
  const claimantStarted = deferred<number>();
  const gateKey = 81277436;
  let gateTransaction: Promise<void> | undefined;
  let claim: ReturnType<Store['claimEvent']> | undefined;
  const userId = `concurrency-${randomUUID()}`;
  const firstId = `${userId}-first`;
  const secondId = `${userId}-second`;
  const firstInserted = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondStarted = deferred<number>();
  let firstIngest: Promise<void> | undefined;
  let secondIngest: Promise<void> | undefined;
  let secondSettled = false;
  const firstStore = new Store(firstDb);
  // Pause only after PostgreSQL allocated the first event's sequence, keeping
  // that insertion uncommitted while a separate connection ingests the next one.
  const gatedStore = new Store(wrap(firstDb, fn => firstDb.transaction(async tx => {
    const gated: Database = {
      query: async <T>(sql: string, values?: unknown[]) => {
        const result = await tx.query<T>(sql, values);
        if (/^\s*INSERT INTO events\b/i.test(sql)) {
          firstInserted.resolve();
          await bounded(releaseFirst.promise, 'release first ingest');
        }
        return result;
      },
      transaction: callback => callback(gated),
      close: async () => {},
    };
    return fn(gated);
  })));
  const secondStore = new Store(wrap(secondDb, fn => secondDb.transaction(async tx => {
    const result = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    secondStarted.resolve(result.rows[0]!.pid);
    return fn(tx);
  })));
  const claimant = new Store(wrap(observer, fn => observer.transaction(async tx => {
    const pid = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    claimantStarted.resolve(pid.rows[0]!.pid);
    const gated: Database = {
      query: <T>(sql: string, values?: unknown[]) => tx.query<T>(
        sql.replace('WHERE (e.status', `WHERE (SELECT pg_advisory_xact_lock(${gateKey})) IS NOT NULL AND (e.status`), values),
      transaction: callback => callback(gated), close: async () => {},
    };
    return fn(gated);
  })));
  try {
    await migrate(observer);
    // Existing sessions are essential: inserting a new session would itself
    // serialize both transactions and conceal the ordering defect.
    await firstStore.getSession(userId);
    firstIngest = gatedStore.ingest([event(firstId, userId)]);
    await bounded(firstInserted.promise, 'first event insert');
    secondIngest = secondStore.ingest([event(secondId, userId)]);
    void secondIngest.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    const secondPid = await bounded(secondStarted.promise, 'second ingest connection');
    await bounded((async () => {
      while (!secondSettled) {
        const activity = await observer.query<{ wait_event_type: string | null }>(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [secondPid],
        );
        if (activity.rows[0]?.wait_event_type === 'Lock') return;
        await delay(10);
      }
    })(), 'second ingest completion or PostgreSQL lock wait');
    if (secondSettled) {
      await secondIngest;
      gateTransaction = gateDb.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [gateKey]);
        gateHeld.resolve();
        await bounded(releaseGate.promise, 'release statement snapshot gate');
      });
      await bounded(gateHeld.promise, 'hold statement snapshot gate');
      claim = claimant.claimEvent();
      const claimantPid = await bounded(claimantStarted.promise, 'claimant connection');
      await bounded((async () => {
        while (true) {
          const activity = await gateDb.query<{ wait_event: string | null }>(
            'SELECT wait_event FROM pg_stat_activity WHERE pid = $1', [claimantPid],
          );
          if (activity.rows[0]?.wait_event === 'advisory') return;
          await delay(10);
        }
      })(), 'claim statement snapshot waiting at gate');
      releaseFirst.resolve();
      await bounded(firstIngest, 'first ingest commit');
      releaseGate.resolve();
      await bounded(gateTransaction, 'snapshot gate commit');
      assert.notEqual((await bounded(claim, 'claim after first commit'))?.id, secondId,
        'claim snapshot must not let a later event overtake an earlier committed sequence');
    } else {
      // A serialized ingest implementation may block B before it commits.
      assert.equal(await new Store(observer).claimEvent(), null);
      releaseFirst.resolve();
      await bounded(Promise.all([firstIngest, secondIngest]), 'both ingests commit');
    }
    assert.equal((await new Store(observer).claimEvent())?.id, firstId);
    const rows = await observer.query<{ id: string }>('SELECT id FROM events WHERE user_id = $1 ORDER BY sequence', [userId]);
    assert.deepEqual(rows.rows.map(row => row.id), [firstId, secondId]);
  } finally {
    releaseFirst.resolve();
    releaseGate.resolve();
    await Promise.allSettled([firstIngest, secondIngest, gateTransaction, claim]);
    await observer.query('DELETE FROM events WHERE user_id = $1', [userId]);
    await observer.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await Promise.all([firstDb.close(), secondDb.close(), observer.close(), gateDb.close()]);
  }
});
