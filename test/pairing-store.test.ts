import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PairingStore, type PairingContext } from '../src/pairing-store.js';
import { Store } from '../src/store.js';
import type { Database, LineEvent } from '../src/types.js';
import { createTestDatabase } from './database.js';

const context: PairingContext = { scope: 'channel-fingerprint', ownerId: 'owner' };
const hash = (code: string) => createHash('sha256').update(code).digest('hex');
const code = hash('one-time-code');
async function fixture(fn: (store: PairingStore, db: Database) => Promise<void>) {
  const db = await createTestDatabase();
  try { await fn(new PairingStore(db), db); } finally { await db.close(); }
}
async function approve(store: PairingStore, eventId = 'open', userId = 'tester', ctx = context) {
  const window = await store.open(ctx, eventId, hash(eventId));
  assert.equal(await store.capture(ctx, `candidate-${eventId}`, userId, hash(eventId)), true);
  assert.equal(await store.confirm(ctx, window.ref), true);
  return window;
}
const event = (id: string, userId = 'tester'): LineEvent => ({
  type: 'message', webhookEventId: id, timestamp: Date.now(),
  source: { type: 'user', userId }, message: { type: 'text', text: '一般接待訊息' },
});

test('opening stores only a hash and exposes no candidate IDs, codes, sessions or grants', async () => {
  await fixture(async (store, db) => {
    const before = Date.now();
    const window = await store.open(context, 'open', code);
    assert.match(window.ref, /^P\d{6,}$/);
    assert.equal(window.status, 'open'); assert.equal(window.candidateAt, null);
    assert.ok(window.expiresAt.getTime() >= before + 299_000);
    assert.ok(window.expiresAt.getTime() <= Date.now() + 300_000);
    assert.deepEqual(Object.keys(window).sort(), ['candidateAt', 'expiresAt', 'ref', 'status']);
    assert.deepEqual(await store.status(context), { window, testers: [] });
    assert.equal(await store.isTester(context, 'tester'), false);
    assert.equal((await db.query('SELECT user_id FROM sessions')).rows.length, 0);
    const rows = (await db.query<{ code_hash: string; candidate_user_id: string | null }>('SELECT code_hash, candidate_user_id FROM pairing_windows')).rows;
    assert.deepEqual(rows, [{ code_hash: code, candidate_user_id: null }]);
    assert.ok(!JSON.stringify((await db.query('SELECT * FROM pairing_windows')).rows).includes('one-time-code'));
    await assert.rejects(store.open(context, 'plaintext', 'one-time-code'));
  });
});

test('duplicate open preserves reference and expiry without restoring a consumed or closed code', async () => {
  await fixture(async (store, db) => {
    const initial = await store.open(context, 'open', code);
    await db.query("UPDATE pairing_windows SET expires_at = clock_timestamp() + interval '2 minutes'");
    const shortened = (await store.status(context)).window!;
    assert.equal((await store.open(context, 'open', hash('different'))).expiresAt.getTime(), shortened.expiresAt.getTime());
    assert.equal(await store.capture(context, 'candidate', 'tester', code), true);
    assert.equal((await store.open(context, 'open', code)).status, 'pending');
    assert.equal(await store.confirm(context, initial.ref), true);
    assert.equal((await store.open(context, 'open', code)).status, 'confirmed');
    assert.equal(await store.capture(context, 'replay', 'intruder', code), false);
    assert.equal((await db.query('SELECT * FROM pairing_windows')).rows.length, 1);
  });
});

test('only the first correct non-owner candidate consumes the code without creating a session or grant', async () => {
  await fixture(async (store, db) => {
    const window = await store.open(context, 'open', code);
    assert.equal(await store.capture(context, 'owner', 'owner', code), false);
    assert.equal(await store.capture(context, 'wrong', 'tester', hash('wrong')), false);
    assert.equal(await store.capture(context, 'plaintext', 'tester', 'one-time-code'), false);
    assert.equal(await store.capture(context, 'candidate', 'tester', code), true);
    assert.equal(await store.capture(context, 'candidate', 'tester', code), false);
    assert.equal(await store.capture(context, 'second', 'intruder', code), false);
    const status = await store.status(context);
    assert.equal(status.window?.ref, window.ref); assert.equal(status.window?.status, 'pending');
    assert.ok(status.window?.candidateAt instanceof Date); assert.deepEqual(status.testers, []);
    assert.equal(await store.isTester(context, 'tester'), false);
    assert.equal((await db.query('SELECT user_id FROM sessions')).rows.length, 0);
    assert.deepEqual((await db.query('SELECT code_hash, candidate_user_id FROM pairing_windows')).rows, [{ code_hash: null, candidate_user_id: 'tester' }]);
    assert.ok(!JSON.stringify(status).includes('"tester"'));
  });
});

test('confirmation grants only the candidate, redacts candidate data and supports a safe retry', async () => {
  await fixture(async (store, db) => {
    const window = await store.open(context, 'open', code);
    assert.equal(await store.confirm(context, window.ref), false);
    await store.capture(context, 'candidate', 'tester', code);
    assert.equal(await store.confirm(context, window.ref), true);
    assert.equal(await store.confirm(context, window.ref), true);
    assert.equal(await store.isTester(context, 'tester'), true);
    assert.equal(await store.isTester(context, 'owner'), false);
    const status = await store.status(context);
    assert.equal(status.window, null); assert.equal(status.testers.length, 1);
    assert.equal(status.testers[0]?.ref, window.ref); assert.ok(status.testers[0]?.approvedAt instanceof Date);
    assert.deepEqual(Object.keys(status.testers[0]!).sort(), ['approvedAt', 'ref']);
    assert.deepEqual((await db.query('SELECT code_hash, candidate_user_id, candidate_at FROM pairing_windows')).rows,
      [{ code_hash: null, candidate_user_id: null, candidate_at: null }]);
    assert.equal(await store.cancel(context), false);
    assert.equal(await store.isTester(context, 'tester'), true);
  });
});

test('expired windows erase candidate data on demand and cannot be revived by open or confirm', async () => {
  await fixture(async (store, db) => {
    const window = await store.open(context, 'open', code);
    await store.capture(context, 'candidate', 'tester', code);
    await db.query("UPDATE pairing_windows SET expires_at = clock_timestamp() - interval '1 second'");
    assert.equal(await store.confirm(context, window.ref), false);
    assert.equal(await store.capture(context, 'late', 'tester', code), false);
    assert.deepEqual(await store.status(context), { window: null, testers: [] });
    assert.equal((await store.open(context, 'open', code)).status, 'expired');
    assert.deepEqual((await db.query('SELECT status, code_hash, candidate_user_id, candidate_at FROM pairing_windows')).rows,
      [{ status: 'expired', code_hash: null, candidate_user_id: null, candidate_at: null }]);
    assert.equal(await store.isTester(context, 'tester'), false);
  });
});

test('status, open, capture and cancel each expire stale windows before acting', async () => {
  await fixture(async (store, db) => {
    for (const action of ['status', 'open', 'capture', 'cancel'] as const) {
      const window = await store.open(context, `open-${action}`, hash(action));
      await db.query("UPDATE pairing_windows SET expires_at = clock_timestamp() - interval '1 second' WHERE ref = $1", [window.ref]);
      if (action === 'status') assert.equal((await store.status(context)).window, null);
      if (action === 'open') assert.equal((await store.open(context, `open-${action}`, hash(action))).status, 'expired');
      if (action === 'capture') assert.equal(await store.capture(context, `candidate-${action}`, 'tester', hash(action)), false);
      if (action === 'cancel') assert.equal(await store.cancel(context), false);
      assert.deepEqual((await db.query('SELECT status, code_hash FROM pairing_windows WHERE ref = $1', [window.ref])).rows,
        [{ status: 'expired', code_hash: null }]);
    }
  });
});

test('cancelling and a new open discard old candidates and old codes without revoking existing grants', async () => {
  await fixture(async (store, db) => {
    const approved = await approve(store, 'approved', 'existing-tester');
    const cancelled = await store.open(context, 'cancelled', code);
    await store.capture(context, 'candidate', 'tester', code);
    assert.equal(await store.cancel(context), true); assert.equal(await store.cancel(context), false);
    assert.equal(await store.confirm(context, cancelled.ref), false);
    assert.equal((await store.open(context, 'cancelled', code)).status, 'cancelled');
    const pending = await store.open(context, 'pending', hash('pending'));
    await store.capture(context, 'candidate-pending', 'tester', hash('pending'));
    const fresh = await store.open(context, 'fresh', hash('fresh'));
    assert.notEqual(fresh.ref, pending.ref);
    assert.equal(await store.confirm(context, pending.ref), false);
    assert.equal(await store.capture(context, 'old-code', 'tester', code), false);
    assert.equal(await store.capture(context, 'old-code-pending', 'tester', hash('pending')), false);
    assert.equal(await store.isTester(context, 'existing-tester'), true);
    assert.equal((await store.status(context)).testers[0]?.ref, approved.ref);
    assert.ok((await db.query<{ candidate_user_id: string | null; code_hash: string | null }>("SELECT candidate_user_id, code_hash FROM pairing_windows WHERE status = 'cancelled'")).rows.every(row => row.candidate_user_id === null && row.code_hash === null));
  });
});

test('scope and owner isolate windows, confirmation, grants and removal', async () => {
  await fixture(async store => {
    const otherScope = { ...context, scope: 'another-channel' };
    const otherOwner = { ...context, ownerId: 'another-owner' };
    const window = await store.open(context, 'open', code);
    assert.equal(await store.capture(otherScope, 'candidate', 'tester', code), false);
    assert.equal(await store.capture(otherOwner, 'candidate', 'tester', code), false);
    await store.capture(context, 'candidate', 'tester', code);
    assert.equal(await store.confirm(otherScope, window.ref), false);
    assert.equal(await store.confirm(otherOwner, window.ref), false);
    assert.equal(await store.cancel(otherScope), false);
    assert.equal(await store.confirm(context, window.ref), true);
    for (const ctx of [otherScope, otherOwner]) {
      assert.equal(await store.isTester(ctx, 'tester'), false);
      assert.deepEqual(await store.status(ctx), { window: null, testers: [] });
      assert.equal(await store.remove(ctx, window.ref), false);
    }
    assert.equal(await store.isTester(context, 'tester'), true);
  });
});

test('concurrent candidates and confirm/cancel have one serialized outcome', async () => {
  await fixture(async store => {
    const window = await store.open(context, 'open', code);
    const captures = await Promise.all([
      store.capture(context, 'first', 'tester-a', code),
      store.capture(context, 'second', 'tester-b', code),
    ]);
    assert.equal(captures.filter(Boolean).length, 1);
    const [confirmed, cancelled] = await Promise.all([store.confirm(context, window.ref), store.cancel(context)]);
    assert.equal(Number(confirmed) + Number(cancelled), 1);
    const grants = [await store.isTester(context, 'tester-a'), await store.isTester(context, 'tester-b')];
    assert.equal(grants.filter(Boolean).length, confirmed ? 1 : 0);
  });
});

test('removal cannot be undone by confirmation retry and fences pending/claimed replies without changing handoff', async () => {
  await fixture(async (store, db) => {
    const approved = await approve(store);
    const normal = new Store(db);
    await normal.ingest([event('processing'), event('pending')]);
    const claimed = await normal.claimEvent(); assert.ok(claimed);
    assert.equal(await store.remove(context, approved.ref), true);
    assert.equal(await store.isTester(context, 'tester'), false);
    assert.equal(await store.confirm(context, approved.ref), false);
    assert.equal(await store.remove(context, approved.ref), false);
    assert.equal((await normal.getSession('tester')).handoff, false);
    assert.deepEqual((await db.query('SELECT status, manual_handoff FROM events ORDER BY sequence')).rows,
      [{ status: 'processing', manual_handoff: true }, { status: 'pending', manual_handoff: true }]);
    assert.equal(await normal.markSending(claimed), false);
    assert.deepEqual((await store.status(context)).testers, []);
  });
});

test('a fresh explicit pairing can reapprove a removed tester without making old confirmation retry succeed', async () => {
  await fixture(async store => {
    const old = await approve(store, 'old');
    await store.remove(context, old.ref);
    const fresh = await approve(store, 'fresh');
    assert.notEqual(fresh.ref, old.ref);
    assert.equal(await store.confirm(context, old.ref), false);
    assert.equal(await store.isTester(context, 'tester'), true);
    assert.deepEqual((await store.status(context)).testers.map(tester => tester.ref), [fresh.ref]);
  });
});

test('file database restart retains pending windows and approved grants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harris-pairing-'));
  let db: Database | undefined;
  try {
    db = await createTestDatabase(directory);
    const first = new PairingStore(db);
    const approved = await approve(first, 'approved');
    const pending = await first.open(context, 'pending', code);
    await first.capture(context, 'candidate-pending', 'next-tester', code);
    await db.close(); db = undefined;
    db = await createTestDatabase(directory);
    const restarted = new PairingStore(db);
    assert.equal(await restarted.isTester(context, 'tester'), true);
    assert.equal((await restarted.status(context)).testers[0]?.ref, approved.ref);
    assert.equal((await restarted.status(context)).window?.ref, pending.ref);
    assert.equal(await restarted.isTester(context, 'next-tester'), false);
    assert.equal(await restarted.confirm(context, pending.ref), true);
    assert.equal(await restarted.isTester(context, 'next-tester'), true);
  } finally {
    await db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('cleanup expires candidates, deletes closed metadata after 24h and preserves grants independently', async () => {
  await fixture(async (store, db) => {
    const approved = await approve(store, 'approved');
    const pending = await store.open(context, 'pending', code);
    await store.capture(context, 'pending-candidate', 'pending-tester', code);
    await db.query("UPDATE pairing_windows SET expires_at = clock_timestamp() - interval '1 second' WHERE ref = $1", [pending.ref]);
    await store.cleanup();
    assert.deepEqual((await db.query('SELECT status, code_hash, candidate_user_id, candidate_at FROM pairing_windows WHERE ref = $1', [pending.ref])).rows,
      [{ status: 'expired', code_hash: null, candidate_user_id: null, candidate_at: null }]);
    await db.query("UPDATE pairing_windows SET closed_at = clock_timestamp() - interval '25 hours'");
    await store.cleanup();
    assert.equal((await db.query('SELECT * FROM pairing_windows')).rows.length, 0);
    assert.equal(await store.isTester(context, 'tester'), true);
    assert.equal(await store.isTester(context, 'pending-tester'), false);
    assert.equal((await store.status(context)).testers[0]?.ref, approved.ref);
    assert.equal(await store.confirm(context, approved.ref), true);
    assert.equal(await store.remove(context, approved.ref), true);
    assert.equal(await store.confirm(context, approved.ref), false);
  });
});
