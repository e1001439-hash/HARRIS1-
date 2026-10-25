import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import type { Database, EventJob, LineEvent, NotificationJob, Outcome } from '../src/types.js';
import { createTestDatabase } from './database.js';

const event = (id: string, timestamp = Date.now(), userId = 'customer'): LineEvent => ({
  type: 'message', webhookEventId: id, timestamp, replyToken: `reply-${id}`,
  source: { type: 'user', userId }, message: { type: 'text', text: `原文-${id}` },
});
const outcome = (overrides: Partial<Outcome> = {}): Outcome => ({
  reply: '', summary: '整理後的剪髮需求', service: '剪髮', requestedTime: '週五下午三點',
  bookingStatus: 'requested', needsHuman: true, nextAction: '請店主確認新時間', delivery: 'not_sent', ...overrides,
});
async function fixture(fn: (store: Store, db: Database) => Promise<void>) {
  const db = await createTestDatabase();
  try { await fn(new Store(db), db); } finally { await db.close(); }
}
async function requiredEvent(store: Store): Promise<EventJob> {
  const job = await store.claimEvent(); assert.ok(job); return job;
}
async function requiredNotification(store: Store): Promise<NotificationJob> {
  const job = await store.claimNotification(); assert.ok(job); return job;
}

test('ingest atomically creates a claimable receipt and open task before any AI claim', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('prompt', Date.parse('2026-10-25T09:00:00Z'))], 'owner');
    const tasks = await store.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, 'open');
    assert.equal((await store.getSession('customer')).handoff, false);
    const receipt = await requiredNotification(store);
    assert.equal(receipt.phase, 'receipt'); assert.equal(receipt.eventId, 'prompt'); assert.equal(receipt.userId, 'customer');
    assert.match(receipt.text, /原文-prompt/); assert.match(receipt.text, /17:00/); assert.match(receipt.text, /T000001/);
    assert.equal(await store.canSendNotification(receipt), true);
    assert.deepEqual((await db.query('SELECT status, attempts FROM events')).rows, [{ status: 'pending', attempts: 0 }]);
  });
});

test('owner events and webhook redelivery never create extra tasks or receipts', async () => {
  await fixture(async (store, db) => {
    const customer = event('once');
    await store.ingest([customer, customer, event('owner', Date.now(), 'owner')], 'owner');
    await store.ingest([customer], 'owner');
    assert.equal((await db.query('SELECT id FROM events')).rows.length, 2);
    assert.equal((await db.query('SELECT id FROM tasks')).rows.length, 1);
    assert.equal((await db.query('SELECT id FROM notifications')).rows.length, 1);
    const receipt = await requiredNotification(store); assert.equal(receipt.eventId, 'once');
  });
});

test('an ingest outbox failure rolls back the event and preliminary task together', async () => {
  await fixture(async (store, db) => {
    await db.query("ALTER TABLE notifications ADD CONSTRAINT reject_prompt_owner CHECK (owner_id <> 'reject-owner')");
    await assert.rejects(store.ingest([event('atomic')], 'reject-owner'));
    assert.equal((await db.query('SELECT id FROM events')).rows.length, 0);
    assert.equal((await db.query('SELECT id FROM tasks')).rows.length, 0);
  });
});

test('analysis keeps the original receipt intact with independent immutable phase keys', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('merge')], 'owner');
    const initial = (await db.query<{ id: string; retry_key: string; text: string }>('SELECT id, retry_key, text FROM notifications')).rows[0];
    assert.ok(initial);
    await store.finishEvent(await requiredEvent(store), outcome(), 'owner');
    assert.equal((await db.query('SELECT id FROM tasks')).rows.length, 1);
    assert.equal((await db.query('SELECT id FROM notifications')).rows.length, 2);
    const original = (await db.query<{id:string;retry_key:string;text:string}>('SELECT id,retry_key,text FROM notifications WHERE phase = $1', ['receipt'])).rows[0]!;
    assert.deepEqual(original, initial);
    const first = await requiredNotification(store); await store.finishNotification(first, 'sent');
    const second = await store.claimNotification();
    const phases = [first, ...(second ? [second] : [])];
    assert.ok(phases.some(notice => notice.phase === 'analysis' && /整理後的剪髮需求/.test(notice.text)));
    assert.equal(new Set(phases.map(notice => notice.retryKey)).size, phases.length);
  });
});

test('an attempted receipt keeps its payload and key while analysis uses a separate phase', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('attempted')], 'owner');
    const receipt = await requiredNotification(store);
    await store.finishNotification(receipt, 'unknown');
    await store.finishEvent(await requiredEvent(store), outcome(), 'owner');
    const original = (await db.query<{ text: string; retry_key: string }>('SELECT text, retry_key FROM notifications WHERE id = $1', [receipt.id])).rows[0];
    assert.deepEqual(original, { text: receipt.text, retry_key: receipt.retryKey });
    const analysis = await requiredNotification(store);
    assert.equal(analysis.phase, 'analysis'); assert.equal(analysis.eventId, receipt.eventId);
    assert.notEqual(analysis.retryKey, receipt.retryKey); assert.match(analysis.text, /整理後的剪髮需求/);
    await store.finishNotification(analysis, 'sent');
    await db.query("UPDATE notifications SET next_attempt_at = clock_timestamp() - interval '1 second'");
    assert.equal(await store.claimNotification(), null, 'late receipt retries must not follow a delivered analysis');
    assert.equal((await db.query<{ status: string }>('SELECT status FROM notifications WHERE id = $1', [receipt.id])).rows[0]?.status, 'superseded');
  });
});

test('a receipt already processing is immutable when its analysis completes', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('in-flight')], 'owner');
    const receipt = await requiredNotification(store);
    await store.finishEvent(await requiredEvent(store), outcome(), 'owner');
    assert.equal(await store.canSendNotification(receipt), true);
    assert.equal((await db.query<{ text: string }>('SELECT text FROM notifications WHERE id = $1', [receipt.id])).rows[0]?.text, receipt.text);
    const analysis = await requiredNotification(store); assert.equal(analysis.phase, 'analysis');
  });
});

test('source time then sequence determine latest event, including older messages arriving late', async () => {
  await fixture(async (store, db) => {
    const now = Date.now();
    await store.ingest([event('newer', now), event('late-older', now - 60_000)], 'owner');
    const newer = await requiredEvent(store);
    assert.equal(await store.isLatestEvent(newer), true);
    assert.equal(await store.markSending(newer), true);
    await store.finishEvent(newer, outcome({ needsHuman: false }), 'owner');
    const older = await requiredEvent(store);
    assert.equal(await store.isLatestEvent(older), false); assert.equal(await store.markSending(older), false);
    await store.finishEvent(older, outcome(), 'owner');
    const receipts = (await db.query<{ text: string; phase: string }>('SELECT text, phase FROM notifications ORDER BY created_at, id')).rows;
    assert.equal(receipts.filter(row => row.phase === 'receipt').length, 2);
    assert.equal(receipts.filter(row => row.phase === 'analysis').length, 1);
    assert.ok(receipts.some(row => row.phase === 'receipt' && row.text.includes('原文-late-older')));
    assert.ok(!receipts.some(row => row.text.includes('原文-late-older') && row.text.includes('整理後的剪髮需求')));
    await store.ingest([event('same-time-newer', now)], 'owner');
    assert.equal(await store.isLatestEvent(newer), false, 'a later sequence breaks equal source timestamps');
  });
});

test('late analysis never replaces a receipt or queues an update after a newer source message', async () => {
  await fixture(async (store, db) => {
    const now = Date.now();
    await store.ingest([event('slow', now)], 'owner');
    const slow = await requiredEvent(store);
    await store.ingest([event('fresh', now + 1000)], 'owner');
    assert.equal(await store.markSending(slow), false);
    await store.finishEvent(slow, outcome(), 'owner');
    const notifications = (await db.query<{ text: string; phase: string }>('SELECT text, phase FROM notifications')).rows;
    assert.equal(notifications.length, 2); assert.ok(notifications.every(row => row.phase === 'receipt'));
    assert.ok(notifications.every(row => !row.text.includes('整理後的剪髮需求')));
    const receipt = await requiredNotification(store); assert.equal(await store.canSendNotification(receipt), true);
  });
});

test('a newer event suppresses a queued or already claimed analysis but preserves receipts', async () => {
  await fixture(async (store, db) => {
    const now = Date.now();
    await store.ingest([event('first', now)], 'owner');
    const receipt = await requiredNotification(store); await store.finishNotification(receipt, 'sent');
    await store.finishEvent(await requiredEvent(store), outcome(), 'owner');
    const analysis = await requiredNotification(store); assert.equal(analysis.phase, 'analysis');
    await store.ingest([event('second', now + 1000)], 'owner');
    assert.equal(await store.canSendNotification(analysis), false);
    await db.query("UPDATE notifications SET lease_until = clock_timestamp() - interval '1 second' WHERE id = $1", [analysis.id]);
    const next = await requiredNotification(store); assert.equal(next.eventId, 'second'); assert.equal(next.phase, 'receipt');
    assert.equal((await db.query<{ status: string }>('SELECT status FROM notifications WHERE id = $1', [analysis.id])).rows[0]?.status, 'superseded');
  });
});

test('notification send checks reject expired or fenced leases even after a reclaim', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('fenced')], 'owner');
    const stale = await requiredNotification(store); assert.equal(await store.canSendNotification(stale), true);
    await db.query("UPDATE notifications SET lease_until = clock_timestamp() - interval '1 second'");
    assert.equal(await store.canSendNotification(stale), false);
    const current = await requiredNotification(store); assert.notEqual(current.leaseToken, stale.leaseToken);
    assert.equal(await store.canSendNotification(stale), false); assert.equal(await store.canSendNotification(current), true);
    await store.finishNotification(stale, 'sent'); assert.equal(await store.canSendNotification(current), true);
  });
});

test('an unsent analysis is superseded while both source receipts remain claimable', async () => {
  await fixture(async (store, db) => {
    const now = Date.now();
    await store.ingest([event('merged-first', now)], 'owner');
    await store.finishEvent(await requiredEvent(store), outcome(), 'owner');
    await store.ingest([event('merged-second', now + 1000)], 'owner');
    const first = await requiredNotification(store);
    assert.equal(first.eventId, 'merged-first'); assert.equal(first.phase, 'receipt'); await store.finishNotification(first, 'sent');
    const next = await requiredNotification(store); assert.equal(next.eventId, 'merged-second'); assert.equal(next.phase, 'receipt');
    assert.deepEqual((await db.query<{ phase: string; status: string }>(`SELECT n.phase, n.status FROM notifications n
      JOIN tasks t ON t.id = n.task_id WHERE t.event_id = 'merged-first' AND n.phase = 'analysis'`)).rows, [{ phase: 'analysis', status: 'superseded' }]);
  });
});
test('every original receipt remains available when a newer message suppresses an unsent analysis', async () => {
  await fixture(async (store, db) => {
    const now = Date.now();
    await store.ingest([event('receipt-must-survive', now)], 'owner');
    await store.finishEvent(await requiredEvent(store), outcome(), 'owner');
    await store.ingest([event('newer-receipt', now + 1000)], 'owner');
    const sentEvents: string[] = [];
    for (let i = 0; i < 4; i++) {
      const notice = await store.claimNotification(); if (!notice) break;
      if (await store.canSendNotification(notice)) { sentEvents.push(notice.eventId); await store.finishNotification(notice, 'sent'); }
    }
    assert.ok(sentEvents.includes('receipt-must-survive'), 'suppressing analysis must not erase the original receipt');
    assert.ok(sentEvents.includes('newer-receipt'));
  });
});

test('ingest remembers manual handoff even if the owner resumes before the first claim', async () => {
  await fixture(async store => {
    await store.setHandoff('customer', true);
    await store.ingest([event('paused-ingest')], 'owner');
    await store.setHandoff('customer', false);
    const job = await requiredEvent(store);
    assert.equal(job.manualHandoff, true);
    assert.equal(await store.markSending(job), false);
  });
});

test('a claim remembers manual handoff across lease recovery and an owner resume', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('paused-claim')], 'owner');
    await store.setHandoff('customer', true);
    const first = await requiredEvent(store); assert.equal(first.manualHandoff, true);
    await db.query("UPDATE events SET lease_until = clock_timestamp() - interval '1 second'");
    await store.setHandoff('customer', false);
    const recovered = await requiredEvent(store);
    assert.equal(recovered.manualHandoff, true); assert.notEqual(recovered.leaseToken, first.leaseToken);
    assert.equal(await store.markSending(recovered), false);
  });
});

test('preserveHandoff leaves both an active handoff and an explicit manual resume unchanged', async () => {
  await fixture(async store => {
    await store.setHandoff('customer', true);
    await store.ingest([event('handoff')], 'owner');
    await store.finishEvent(await requiredEvent(store), outcome({ preserveHandoff: true }), 'owner');
    assert.equal((await store.getSession('customer')).handoff, true);
    await store.ingest([event('resumed')], 'owner');
    const job = await requiredEvent(store); await store.setHandoff('customer', false);
    await store.finishEvent(job, outcome({ preserveHandoff: true }), 'owner');
    assert.equal((await store.getSession('customer')).handoff, false);
  });
});

test('AI completion preserves a manually completed and owner-confirmed preliminary task', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('manual')], 'owner');
    const task = (await store.listTasks())[0]; assert.ok(task);
    await db.query("UPDATE tasks SET booking_status = 'requested' WHERE id = $1", [task.id]);
    assert.equal(await store.confirmTask(task.id), true); assert.equal(await store.completeTask(task.id), true);
    await store.finishEvent(await requiredEvent(store), outcome(), 'owner');
    const final = await store.getTask(task.id);
    assert.equal(final?.status, 'done'); assert.equal(final?.bookingStatus, 'owner_confirmed');
    assert.equal((await db.query('SELECT id FROM tasks')).rows.length, 1);
    assert.equal((await db.query<{ confirmation_source: string }>('SELECT confirmation_source FROM tasks')).rows[0]?.confirmation_source, 'owner_confirmation');
  });
});

test('owner command send intent explicitly bypasses customer latest-event suppression', async () => {
  await fixture(async store => {
    await store.ingest([event('owner-first', Date.now(), 'owner'), event('owner-second', Date.now() + 1000, 'owner')], 'owner');
    const job = await requiredEvent(store);
    assert.equal(await store.isLatestEvent(job), false);
    assert.equal(await store.markSending(job, true), true);
  });
});

test('retention redacts both phases and prevents claimed or late-completed text from returning', async () => {
  await fixture(async (store, db) => {
    await store.ingest([event('expired')], 'owner');
    const receipt = await requiredNotification(store); await store.finishNotification(receipt, 'sent');
    await store.finishEvent(await requiredEvent(store), outcome(), 'owner');
    const analysis = await requiredNotification(store);
    await db.query("UPDATE events SET ingested_at = now() - interval '31 days'");
    await db.query("UPDATE tasks SET created_at = now() - interval '31 days'");
    await db.query("UPDATE notifications SET created_at = now() - interval '31 days'");
    await store.cleanup();
    assert.equal(await store.canSendNotification(analysis), false);
    assert.ok((await db.query<{ text: string }>('SELECT text FROM notifications')).rows.every(row => row.text === '[已依保存期限移除]'));
    assert.equal(await store.claimNotification(), null);
    await store.ingest([event('late-finish')], 'owner'); const late = await requiredEvent(store);
    await db.query("UPDATE events SET ingested_at = now() - interval '31 days' WHERE id = $1", [late.id]);
    await store.cleanup(); await store.finishEvent(late, outcome(), 'owner');
    assert.equal(await store.claimNotification(), null);
    assert.ok((await db.query<{ text: string }>('SELECT text FROM notifications')).rows.every(row => row.text === '[已依保存期限移除]'));
  });
});
