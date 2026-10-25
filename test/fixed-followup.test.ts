import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DeliveryError } from '../src/clients/line.js';
import { NotificationWorker } from '../src/notification-worker.js';
import { PairingService } from '../src/pairing.js';
import { PairingStore } from '../src/pairing-store.js';
import { startRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import type { Database } from '../src/types.js';
import { createTestDatabase } from './database.js';

const owner = `U${'1'.repeat(32)}`, customer = `U${'2'.repeat(32)}`;
const settings = { DATABASE_URL: 'local-fixed-followup-only', LINE_CHANNEL_SECRET: 'fake-fixed-followup-secret', LINE_CHANNEL_ACCESS_TOKEN: 'fake-token', OWNER_LINE_USER_ID: owner };
interface Observation { to: string; text: string; key: string }
function observations() {
  const replies: { token: string; text: string }[] = [], attempts: Observation[] = [], delivered: Observation[] = [], issues: Record<string, unknown>[] = [];
  const state = { replies, attempts, delivered, issues, failPush: false, aiCalls: 0 };
  const line = {
    async reply(token: string, text: string) { replies.push({ token, text }); },
    async push(to: string, text: string, key: string) {
      const notice = { to, text, key }; attempts.push(notice);
      if (state.failPush) throw new DeliveryError('failed');
      delivered.push(notice);
    },
  };
  return { state, line, ai: { async generate(): Promise<never> { state.aiCalls++; throw new Error('Fixed follow-up must never call AI'); } } };
}
type Clients = ReturnType<typeof observations>;

async function until(condition: () => Promise<boolean> | boolean, message: string) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(message);
}
function transport(app: ReturnType<typeof createApp>, secret: string) {
  return async (id: string, userId: string, text: string, timestamp = Date.now()) => {
    const payload = JSON.stringify({ events: [{ type: 'message', webhookEventId: id, timestamp, replyToken: id, source: { type: 'user', userId }, message: { type: 'text', text } }] });
    const response = await app.inject({ method: 'POST', url: '/webhook', payload, headers: { 'content-type': 'application/json', 'x-line-signature': createHmac('sha256', secret).update(payload).digest('base64') } });
    assert.equal(response.statusCode, 200);
  };
}
const eventDone = async (db: Database, id: string) => (await db.query<{ status: string }>('SELECT status FROM events WHERE id=$1', [id])).rows[0]?.status === 'done';
const drained = async (db: Database) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE status NOT IN ('sent','superseded')")).rows[0]!.n === 0;
async function running(folder: string, clients: Clients) {
  const db = await createTestDatabase(folder), config = loadConfig(settings); config.port = 0;
  const runtime = await startRuntime({ db, config, host: '127.0.0.1', knowledge: '', line: clients.line, ai: clients.ai });
  const send = transport(runtime.app, config.lineSecret);
  const command = async (id: string, text: string) => {
    await send(id, owner, text); await until(() => eventDone(db, id), 'owner command should complete');
    return clients.state.replies.find(reply => reply.token === id)?.text ?? '';
  };
  return { ...runtime, db, config, send, command };
}
async function establishFixedCustomer(f: Awaited<ReturnType<typeof running>>, clients: Clients) {
  const opened = await f.command('pair-open', '/配對');
  const phrase = opened.match(/測試配對 [A-Za-z0-9_-]{24}/)?.[0]; assert.ok(phrase);
  await f.send('pair-candidate', customer, phrase);
  const ref = (await f.db.query<{ ref: string }>("SELECT ref FROM pairing_windows WHERE status='pending'")).rows[0]?.ref; assert.ok(ref);
  assert.match(await f.command('pair-confirm', `/確認配對 ${ref}`), /已加入/);
  await f.send('fixed-first', customer, '測試預約：週五下午剪髮');
  await until(() => eventDone(f.db, 'fixed-first'), 'first fixed message should complete');
  await until(() => clients.state.delivered.some(notice => notice.to === owner && notice.text.includes('週五下午剪髮')), 'owner must actually receive first message through fake LINE push');
  await until(() => drained(f.db), 'first notification phases should settle before the next scenario');
  assert.equal(clients.state.replies.filter(reply => reply.token === 'fixed-first').length, 1);
  assert.equal((await f.store.getSession(customer)).handoff, true);
  assert.equal(clients.state.aiCalls, 0);
  return ref;
}

// Move persisted ages, not the process clock. This models a stored 45-minute
// gap without sleeping and does not simulate Render's network/cold-start layer.
async function ageStoredConversation(db: Database) {
  await db.query("UPDATE pairing_windows SET created_at=clock_timestamp()-interval '45 minutes', expires_at=clock_timestamp()-interval '40 minutes', closed_at=clock_timestamp()-interval '45 minutes' WHERE status='confirmed'");
  await db.query("UPDATE tester_grants SET approved_at=clock_timestamp()-interval '45 minutes'");
  await db.query("UPDATE events SET received_at=clock_timestamp()-interval '45 minutes', ingested_at=clock_timestamp()-interval '45 minutes' WHERE user_id=$1", [customer]);
  await db.query("UPDATE tasks SET received_at=clock_timestamp()-interval '45 minutes', created_at=clock_timestamp()-interval '45 minutes' WHERE user_id=$1", [customer]);
  await db.query("UPDATE notifications SET created_at=clock_timestamp()-interval '45 minutes'");
}

async function controlled(folder: string, clients: Clients) {
  const db = await createTestDatabase(folder), config = loadConfig(settings), store = new Store(db);
  const pairing = new PairingService(new PairingStore(db), config);
  await store.cleanup(); await pairing.cleanup();
  const app = createApp({ config, store, pairing });
  const worker = new Worker({ store, config, pairing, knowledge: '', line: clients.line, ai: clients.ai, lane: 'customer' });
  const notifier = new NotificationWorker({ store, config, line: clients.line, onNotificationIssue: issue => clients.state.issues.push(issue) });
  let closed = false;
  return { db, store, app, worker, notifier, send: transport(app, config.lineSecret), async close() {
    if (closed) return; closed = true;
    worker.stop(); notifier.stop(); await app.close(); await db.close();
  } };
}
interface NoticeRow { id: string; retry_key: string; status: string; attempts: number; due: boolean }
async function receipt(db: Database, eventId: string): Promise<NoticeRow> {
  const result = await db.query<NoticeRow>(`SELECT n.id,n.retry_key,n.status,n.attempts,n.next_attempt_at <= clock_timestamp() AS due
    FROM notifications n JOIN tasks t ON t.id=n.task_id WHERE t.event_id=$1 AND n.phase='receipt'`, [eventId]);
  assert.equal(result.rows.length, 1); return result.rows[0]!;
}
const forceDue = async (db: Database, id: string) => { await db.query("UPDATE notifications SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]); };

test('confirmed fixed tester still notifies owner after a stored 45-minute gap, runtime restart and stale reply token', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'harris-fixed-gap-')), clients = observations();
  let f = await running(folder, clients);
  try {
    const ref = await establishFixedCustomer(f, clients);
    const customerRef = (await f.store.getSession(customer)).customerRef;
    await ageStoredConversation(f.db);
    await f.send('fixed-later', customer, '測試更新：改成週六下午');
    await until(() => eventDone(f.db, 'fixed-later'), 'same-process manual update should finish');
    await until(() => clients.state.delivered.some(notice => notice.to === owner && notice.text.includes('改成週六下午')), 'owner should receive the later update after the old window expired');
    await until(() => drained(f.db), 'later notification phases should settle');
    assert.ok(!clients.state.replies.some(reply => reply.token === 'fixed-later'));
    await ageStoredConversation(f.db);
    await f.close(); f = await running(folder, clients);
    assert.equal((await f.app.inject('/readyz')).statusCode, 200);
    assert.match(await f.command('pair-status-after-restart', '/配對狀態'), new RegExp(ref));
    assert.equal((await f.store.getSession(customer)).customerRef, customerRef);
    assert.equal((await f.store.getSession(customer)).handoff, true);
    const staleTimestamp = Date.now() - 120000;
    await f.send('fixed-after-restart', customer, '測試更新：改成週日下午', staleTimestamp);
    await until(() => eventDone(f.db, 'fixed-after-restart'), 'stale reply token must not prevent processing a newer customer update');
    await until(() => clients.state.delivered.some(notice => notice.to === owner && notice.text.includes('改成週日下午')), 'owner must receive the post-restart update through fake LINE push');
    await until(() => drained(f.db), 'post-restart notification phases should settle');
    assert.ok(!clients.state.replies.some(reply => reply.token === 'fixed-after-restart'));
    const before = clients.state.delivered.length;
    await f.send('fixed-after-restart', customer, '測試更新：改成週日下午', staleTimestamp);
    assert.equal((await f.db.query<{ n: number }>('SELECT count(*)::int AS n FROM tasks WHERE event_id=$1', ['fixed-after-restart'])).rows[0]!.n, 1);
    assert.equal(clients.state.delivered.length, before, 'webhook redelivery must not create another owner notification');
    assert.equal((await f.store.getSession(customer)).handoff, true);
    assert.equal(clients.state.aiCalls, 0);
  } finally { await f.close(); await rm(folder, { recursive: true, force: true }); }
});

test('follow-up receipt preserves retry budget and key across restart and recovery of an interrupted claim', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'harris-fixed-retry-')), clients = observations();
  const initial = await running(folder, clients); let f: Awaited<ReturnType<typeof controlled>> | undefined;
  try {
    await establishFixedCustomer(initial, clients); await initial.close();
    f = await controlled(folder, clients); clients.state.failPush = true;
    await f.send('retry-update', customer, '測試更新：改成週日晚上');
    assert.equal(await f.notifier.tick(), true);
    const first = await receipt(f.db, 'retry-update');
    assert.equal(first.attempts, 1); assert.equal(first.status, 'failed'); assert.equal(first.due, false);
    assert.equal(await f.notifier.tick(), false, 'a failed push must wait for its scheduled retry');
    await f.close(); f = await controlled(folder, clients);
    assert.equal(await f.notifier.tick(), false, 'restart must not reset the scheduled delay');
    await forceDue(f.db, first.id);
    const interrupted = await f.store.claimNotification(); assert.ok(interrupted);
    assert.equal(interrupted.id, first.id); assert.equal(interrupted.retryKey, first.retry_key); assert.equal(interrupted.attempts, 2);
    await f.close(); f = await controlled(folder, clients);
    assert.equal(await f.notifier.tick(), false, 'an unexpired processing lease must survive restart');
    await f.db.query("UPDATE notifications SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
    clients.state.failPush = false;
    assert.equal(await f.notifier.tick(), true);
    const recovered = await receipt(f.db, 'retry-update');
    assert.equal(recovered.status, 'sent'); assert.equal(recovered.attempts, 3);
    const attempts = clients.state.attempts.filter(notice => notice.key === first.retry_key);
    assert.equal(attempts.length, 2, 'the interrupted second claim did not send; recovery reuses the original retry key');
    assert.ok(clients.state.delivered.some(notice => notice.key === first.retry_key && notice.to === owner && notice.text.includes('改成週日晚上')));
    assert.equal(await f.worker.tick(), true); assert.equal(await eventDone(f.db, 'retry-update'), true);
    assert.ok(!clients.state.replies.some(reply => reply.token === 'retry-update'));
    assert.equal((await f.store.getSession(customer)).handoff, true); assert.equal(clients.state.aiCalls, 0);
  } finally { await f?.close(); await initial.close(); await rm(folder, { recursive: true, force: true }); }
});

test('three failed follow-up pushes stay exhausted across restart without blocking a newer manual update', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'harris-fixed-exhausted-')), clients = observations();
  const initial = await running(folder, clients); let f: Awaited<ReturnType<typeof controlled>> | undefined;
  try {
    await establishFixedCustomer(initial, clients); await initial.close();
    f = await controlled(folder, clients); clients.state.failPush = true;
    await f.send('exhausted-update', customer, '測試更新：舊的失敗推播');
    assert.equal(await f.notifier.tick(), true);
    const first = await receipt(f.db, 'exhausted-update');
    assert.equal(first.attempts, 1); assert.equal(first.due, false);
    await forceDue(f.db, first.id); assert.equal(await f.notifier.tick(), true);
    const second = await receipt(f.db, 'exhausted-update'); assert.equal(second.attempts, 2); assert.equal(second.due, false);
    const scheduled = await f.db.query<{ delayed: boolean }>("SELECT next_attempt_at > clock_timestamp()+interval '110 seconds' AS delayed FROM notifications WHERE id=$1", [first.id]);
    assert.equal(scheduled.rows[0]!.delayed, true, 'second failure should schedule the two-minute backoff');
    await forceDue(f.db, first.id); assert.equal(await f.notifier.tick(), true);
    assert.equal((await receipt(f.db, 'exhausted-update')).attempts, 3);
    await f.close(); f = await controlled(folder, clients);
    await forceDue(f.db, first.id);
    assert.equal(await f.notifier.tick(), false, 'an exhausted notification must not gain another attempt after restart');
    assert.equal(clients.state.attempts.filter(notice => notice.key === first.retry_key).length, 3);
    assert.equal(clients.state.issues.at(-1)?.terminal, true);
    clients.state.failPush = false;
    await f.send('fresh-update', customer, '測試更新：新需求改成週一下午');
    assert.equal(await f.notifier.tick(), true, 'a terminal old receipt must not block a new receipt');
    assert.ok(clients.state.delivered.some(notice => notice.to === owner && notice.text.includes('新需求改成週一下午')));
    assert.equal(await f.worker.tick(), true); assert.equal(await f.worker.tick(), true);
    assert.equal(await eventDone(f.db, 'fresh-update'), true);
    assert.ok(!clients.state.replies.some(reply => ['exhausted-update', 'fresh-update'].includes(reply.token)));
    assert.equal(clients.state.attempts.filter(notice => notice.key === first.retry_key).length, 3);
    assert.equal((await f.store.getSession(customer)).handoff, true); assert.equal(clients.state.aiCalls, 0);
  } finally { await f?.close(); await initial.close(); await rm(folder, { recursive: true, force: true }); }
});
