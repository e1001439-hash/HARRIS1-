import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from './database.js';
import type { Database, EventJob, LineEvent, Outcome } from '../src/types.js';
import { migrate, postgresOptions } from '../src/db.js';
import { Store } from '../src/store.js';

const event = (id: string, userId = 'customer'): LineEvent => ({
  type: 'message', webhookEventId: id, timestamp: Date.now(), replyToken: `reply-${id}`,
  source: { type: 'user', userId }, message: { type: 'text', text: `message-${id}` },
});
const outcome = (overrides: Partial<Outcome> = {}): Outcome => ({
  reply: '請使用預約連結，我再幫你確認。', summary: '客人詢問剪髮', service: '剪髮',
  requestedTime: '明天下午', bookingStatus: 'requested', needsHuman: true,
  nextAction: '請聯絡客人確認時間', delivery: 'sent', ...overrides,
});

async function storeFor(db: Database) {
  return new Store(db);
}
async function fixture(fn: (store: Awaited<ReturnType<typeof storeFor>>, db: Database) => Promise<void>) {
  const db = await createTestDatabase();
  try { await fn(await storeFor(db), db); } finally { await db.close(); }
}
async function requiredJob(store: Awaited<ReturnType<typeof storeFor>>): Promise<EventJob> {
  const job = await store.claimEvent();
  assert.ok(job, 'a pending event must be claimable');
  return job;
}

test('migrations initialize durable event, session, task and outbox tables', async () => {
  const db = await createTestDatabase();
  try {
    const result = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const names = result.rows.map(row => row.table_name);
    for (const expected of ['events', 'sessions', 'tasks', 'notifications', 'feedback']) {
      assert.ok(names.includes(expected), `${expected} must survive a process restart`);
    }
    await Promise.all([migrate(db), migrate(db)]);
    assert.deepEqual((await db.query<{version:number}>('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version), [1, 2, 3, 4]);
  } finally { await db.close(); }
});

test('PostgreSQL connections require verified TLS and reject URL overrides that weaken it', async () => {
  const config = postgresOptions;
  assert.deepEqual(config('postgresql://user:secret@db.example/db').ssl, { rejectUnauthorized: true });
  assert.deepEqual(config('postgresql://user:secret@db.example/db?sslmode=verify-full').ssl, { rejectUnauthorized: true });
  assert.ok(!config('postgresql://user:secret@db.example/db?sslmode=verify-full').connectionString?.includes('sslmode'));
  for (const option of ['sslmode=disable', 'sslmode=require', 'sslmode=no-verify', 'sslrejectunauthorized=false', 'ssl=false']) {
    assert.throws(() => config(`postgresql://user:secret@db.example/db?${option}`), error =>
      error instanceof Error && !error.message.includes('secret') && /TLS/.test(error.message));
  }
});

test('duplicate webhook delivery preserves one event and one stable customer reference', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('duplicate'), event('duplicate')]);
    await store.ingest([event('duplicate')]);
    assert.equal((await db.query('SELECT id FROM events')).rows.length, 1);
    assert.deepEqual(await store.getSession('customer'), { userId: 'customer', customerRef: 'C000001', handoff: false });
    const first = await requiredJob(store);
    assert.equal(first.id, 'duplicate');
    assert.equal(await store.claimEvent(), null);
    await store.ping();
  });
});

test('claims preserve per-user arrival order while other customers can progress', async () => {
  await fixture(async store => {
    const later = event('second');
    later.timestamp -= 100000;
    await store.ingest([event('first'), later, event('other', 'other-customer')]);
    const first = await requiredJob(store);
    assert.equal(first.id, 'first');
    assert.equal((await requiredJob(store)).id, 'other');
    assert.equal(await store.claimEvent(), null);
    await store.finishEvent(first, outcome({ needsHuman: false }), 'owner');
    assert.equal((await requiredJob(store)).id, 'second');
  });
});

test('parallel claims never lease two events for one user', async () => {
  await fixture(async store => {
    await store.ingest([event('one'), event('two')]);
    const jobs = await Promise.all([store.claimEvent(), store.claimEvent(), store.claimEvent()]);
    assert.equal(jobs.filter(Boolean).length, 1);
  });
});

test('expired lease preserves send intent and rejects every stale worker mutation', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('recover')]);
    const stale = await requiredJob(store);
    assert.equal(await store.markSending(stale), true);
    assert.equal(await store.markSending(stale), false, 'send intent cannot be claimed twice');
    await db.query("UPDATE events SET lease_until = now() - interval '1 second' WHERE id = $1", [stale.id]);
    const recovered = await requiredJob(store);
    assert.notEqual(recovered.leaseToken, stale.leaseToken);
    assert.equal(recovered.previouslySending, true);
    assert.equal(recovered.attempts, 2);
    assert.equal(await store.markSending(stale), false);
    await store.finishEvent(stale, outcome(), 'owner');
    assert.equal((await db.query('SELECT id FROM tasks')).rows.length, 0);
    await store.finishEvent(recovered, outcome({ delivery: 'unknown' }), 'owner');
    const stored = await db.query<{ delivery: string }>('SELECT delivery FROM events WHERE id = $1', [stale.id]);
    assert.equal(stored.rows[0]?.delivery, 'unknown');
  });
});

test('lease expiry uses wall-clock time even when a transaction started before expiry', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('wall-clock')]);
    const job = await requiredJob(store);
    await db.transaction(async tx => {
      await tx.query("UPDATE events SET lease_until = clock_timestamp() + interval '10 milliseconds'");
      await tx.query('SELECT pg_sleep(0.03)');
      const delayed = new Store(tx);
      assert.equal(await delayed.markSending(job), false);
      await delayed.finishEvent(job, outcome(), 'owner');
      assert.equal((await tx.query('SELECT id FROM tasks')).rows.length, 0);
    });
  });
});

test('handoff is authoritative at send time and owner replies can explicitly bypass it', async () => {
  await fixture(async store => {
    await store.ingest([event('pause')]);
    const job = await requiredJob(store);
    await store.setHandoff('customer', true);
    assert.equal(await store.markSending(job), false);
    assert.equal((await store.sessionForRef('C000001'))?.handoff, true);
    assert.equal(await store.markSending(job, true), true);
    await store.setHandoff('customer', false);
    assert.equal((await store.getSession('customer')).handoff, false);
    assert.equal(await store.sessionForRef('C999999'), null);
  });
});

test('event completion atomically creates one task, notification and human handoff', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('finish')]);
    const job = await requiredJob(store);
    await store.finishEvent(job, outcome(), 'configured-owner');
    await store.finishEvent(job, outcome(), 'configured-owner');
    const tasks = await store.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.id, 'T000001');
    assert.equal(tasks[0]?.customerRef, 'C000001');
    assert.equal(tasks[0]?.bookingStatus, 'requested');
    assert.ok(tasks[0]?.receivedAt instanceof Date);
    assert.equal((await store.getSession('customer')).handoff, true);
    const notification = await store.claimNotification();
    assert.ok(notification);
    assert.equal(notification.ownerId, 'configured-owner');
    assert.match(notification.text, /T000001/);
    assert.equal((await db.query('SELECT id FROM notifications')).rows.length, 1);
    assert.equal(await store.claimEvent(), null);
  });
});

test('an outbox constraint failure rolls back event completion, task and handoff', async () => {
  await fixture(async (store, db) => {
    await db.query("ALTER TABLE notifications ADD CONSTRAINT reject_owner CHECK (owner_id <> 'reject-owner')");
    await store.ingest([event('atomic')]);
    const job = await requiredJob(store);
    await assert.rejects(store.finishEvent(job, outcome(), 'reject-owner'));
    assert.equal((await db.query('SELECT id FROM tasks')).rows.length, 0);
    assert.equal((await db.query<{status: string}>('SELECT status FROM events')).rows[0]?.status, 'processing');
    assert.equal((await store.getSession('customer')).handoff, false);
    await store.finishEvent(job, outcome(), 'owner');
    assert.equal((await store.listTasks()).length, 1);
  });
});

test('owner events skip tasks and customer questions still leave completed task records', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('owner-command', 'owner'), event('simple-question')]);
    await store.finishEvent(await requiredJob(store), outcome({ skipTask: true }), 'owner');
    await store.finishEvent(await requiredJob(store), outcome({ needsHuman: false, bookingStatus: 'none' }), 'owner');
    assert.equal((await store.listTasks()).length, 0);
    const records = await db.query<{status:string}>('SELECT status FROM tasks');
    assert.deepEqual(records.rows, [{ status: 'done' }]);
    assert.equal((await db.query('SELECT id FROM notifications')).rows.length, 1);
  });
});

test('history includes at most ten completed turns without duplicating the current event', async () => {
  await fixture(async store => {
    for (let i = 1; i <= 6; i++) {
      await store.ingest([event(`history-${i}`)]);
      await store.finishEvent(await requiredJob(store), outcome({ needsHuman: false, reply: `answer-${i}` }), 'owner');
    }
    await store.ingest([event('current')]);
    await requiredJob(store);
    const history = await store.history('customer');
    assert.equal(history.length, 10);
    assert.deepEqual(history[0], { role: 'user', content: 'message-history-2' });
    assert.deepEqual(history[9], { role: 'assistant', content: 'answer-6' });
    assert.ok(!history.some(turn => turn.content.includes('current')));
  });
});

test('owner confirmation records its source and completed tasks disappear from pending list', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('booking')]);
    await store.finishEvent(await requiredJob(store), outcome({ bookingStatus: 'self_reported' }), 'owner');
    assert.equal(await store.addFeedback('missing', 'unlinked'), false);
    assert.equal(await store.addFeedback('T000001', '請改成這樣說'), true);
    assert.equal(await store.confirmTask('missing'), false);
    assert.equal(await store.confirmTask('T000001'), true);
    assert.equal((await store.getTask('T000001'))?.bookingStatus, 'owner_confirmed');
    assert.equal((await db.query<{confirmation_source:string}>('SELECT confirmation_source FROM tasks')).rows[0]?.confirmation_source, 'owner_confirmation');
    assert.equal(await store.completeTask('T000001'), true);
    assert.equal(await store.completeTask('missing'), false);
    assert.deepEqual(await store.listTasks(), []);
  });
});

test('notification failures retry at most three times with the same idempotency key', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('notify')]);
    await store.finishEvent(await requiredJob(store), outcome(), 'owner');
    const first = await store.claimNotification();
    assert.ok(first);
    await store.finishNotification(first, 'unknown');
    assert.equal(await store.claimNotification(), null, 'temporary outage must wait before retrying');
    await db.query("UPDATE notifications SET next_attempt_at = clock_timestamp() - interval '1 second'");
    const second = await store.claimNotification();
    assert.ok(second);
    assert.equal(second.retryKey, first.retryKey);
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.equal(second.attempts, 2);
    await store.finishNotification(first, 'sent');
    assert.equal((await db.query<{status:string}>('SELECT status FROM notifications')).rows[0]?.status, 'processing');
    await db.query("UPDATE notifications SET lease_until = now() - interval '1 second'");
    const third = await store.claimNotification();
    assert.ok(third);
    assert.equal(third.retryKey, first.retryKey);
    assert.equal(third.attempts, 3);
    await store.finishNotification(third, 'failed');
    assert.equal(await store.claimNotification(), null);
    assert.equal((await db.query<{status:string}>('SELECT status FROM notifications')).rows[0]?.status, 'failed');
  });
});

test('general inquiries cannot be marked as a confirmed booking', async () => {
  await fixture(async store => {
    await store.ingest([event('general-question')]);
    await store.finishEvent(await requiredJob(store), outcome({ bookingStatus: 'none' }), 'owner');
    assert.equal(await store.confirmTask('T000001'), false);
    assert.equal((await store.getTask('T000001'))!.bookingStatus, 'none');
  });
});
test('pending pagination makes older actionable tasks reachable', async () => {
  await fixture(async store => {
    for (let index = 0; index < 21; index++) {
      await store.ingest([event(`backlog-${index}`)]);
      await store.finishEvent(await requiredJob(store), outcome(), 'owner');
    }
    const page = await store.listTasks();
    assert.equal(page.length, 20);
    const older = await store.listTasks(page.at(-1)!.id);
    assert.equal(older.length, 1); assert.equal(older[0]!.id, 'T000001');
  });
});
test('database reopen retains dedupe, pending work, handoff and owner tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harris-db-'));
  try {
    const db = await createTestDatabase(dir);
    const store = await storeFor(db);
    await store.ingest([event('persist'), event('pending', 'other-customer')]);
    await store.finishEvent(await requiredJob(store), outcome(), 'owner');
    await db.close();
    const reopened = await createTestDatabase(dir);
    try {
      const restored = await storeFor(reopened);
      await restored.ingest([event('persist')]);
      assert.equal((await reopened.query('SELECT id FROM events')).rows.length, 2);
      assert.equal((await restored.getSession('customer')).handoff, true);
      assert.equal((await restored.listTasks()).length, 1);
      assert.equal((await requiredJob(restored)).id, 'pending');
      assert.ok(await restored.claimNotification());
    } finally { await reopened.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('retention removes all 30-day text copies without deleting open tasks or reenabling delivery', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('old-open'), event('old-pending')], 'owner');
    await store.finishEvent(await requiredJob(store), outcome(), 'owner');
    await store.addFeedback('T000001', '私人的修正文字');
    await db.query("UPDATE events SET ingested_at = now() - interval '31 days'");
    await db.query("UPDATE tasks SET created_at = now() - interval '31 days'");
    await db.query("UPDATE notifications SET created_at = now() - interval '31 days'");
    await db.query("UPDATE feedback SET created_at = now() - interval '31 days'");
    await store.cleanup();
    const raw = await db.query<{payload:unknown;outcome:unknown}>('SELECT payload, outcome FROM events');
    assert.ok(raw.rows.every(row => row.payload === null && row.outcome === null));
    const task = await store.getTask('T000001');
    assert.ok(task);
    assert.equal(task.summary, '[已依保存期限移除]');
    assert.equal(task.service, null);
    assert.equal((await db.query<{text:string}>('SELECT text FROM feedback')).rows[0]?.text, '[已依保存期限移除]');
    assert.equal((await db.query<{text:string}>('SELECT text FROM notifications')).rows[0]?.text, '[已依保存期限移除]');
    assert.equal(await store.claimNotification(), null);
    const pending = await requiredJob(store);
    assert.equal(pending.id, 'old-pending');
    assert.equal(pending.event.message?.text, undefined);
    await store.ingest([event('old-open')]);
    assert.equal((await db.query('SELECT id FROM events')).rows.length, 2);
  });
});

test('late completion cannot copy an expired customer message into fresh tasks or notifications', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('late-completion')]);
    await db.query("UPDATE events SET ingested_at = now() - interval '31 days'");
    const job = await requiredJob(store);
    assert.equal(await store.markSending(job), false);
    await store.finishEvent(job, outcome(), 'owner');
    assert.equal((await store.getTask('T000001'))?.summary, '[已依保存期限移除]');
    assert.equal(await store.claimNotification(), null);
    const stored = await db.query<{payload:unknown;outcome:unknown}>('SELECT payload, outcome FROM events');
    assert.equal(stored.rows[0]?.payload, null);
    assert.equal(stored.rows[0]?.outcome, null);
  });
});

test('90-day cleanup removes closed metadata and dedupe while retaining open tasks and recent closure', async () => {
  await fixture(async (store, db) => {
    for (const id of ['closed-old', 'closed-recent', 'open-old']) {
      await store.ingest([event(id)]);
      await store.finishEvent(await requiredJob(store), outcome(), 'owner');
    }
    await store.completeTask('T000001');
    await store.completeTask('T000002');
    await db.query("UPDATE events SET ingested_at = now() - interval '91 days'");
    await db.query("UPDATE tasks SET created_at = now() - interval '91 days'");
    await db.query("UPDATE tasks SET closed_at = now() - interval '91 days' WHERE id = 'T000001'");
    await store.cleanup();
    assert.equal(await store.getTask('T000001'), null);
    assert.ok(await store.getTask('T000002'));
    assert.ok(await store.getTask('T000003'));
    assert.equal((await db.query("SELECT id FROM events WHERE id = 'closed-old'")).rows.length, 0);
    assert.equal((await db.query("SELECT id FROM events WHERE id = 'open-old'")).rows.length, 1);
    await store.ingest([event('open-old')]);
    assert.equal(await store.claimEvent(), null);
  });
});
