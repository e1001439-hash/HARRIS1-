import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { loadConfig } from '../src/config.js';
import { DeliveryError } from '../src/clients/line.js';
import { createTestDatabase } from './database.js';
import type { AiResult, LineEvent } from '../src/types.js';

const owner = `U${'1'.repeat(32)}`, customer = `U${'2'.repeat(32)}`;
const base: AiResult = { reply: '你好，請問想了解哪一項服務？', summary: '詢問服務', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '無需處理' };
const event = (id: string, text: string, userId = customer): LineEvent => ({ type: 'message', webhookEventId: id, timestamp: Date.now(), source: { type: 'user', userId }, replyToken: `reply-${id}`, message: { type: 'text', text } });
async function fixture(generate: () => Promise<AiResult> = async () => base, pushFail = false) {
  const db = await createTestDatabase(); const store = new Store(db);
  const replies: string[] = [], pushes: string[] = [], destinations: string[] = [], issues: Record<string, unknown>[] = [];
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/test', LINE_CHANNEL_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'token', OWNER_LINE_USER_ID: owner, TEST_LINE_USER_IDS: customer, RESPONSE_MODE: 'ai', SALON_AI_API_KEY: 'fake', AI_MODEL: 'fake' });
  const worker = new Worker({ store, config, onNotificationIssue: issue => issues.push(issue), knowledge: '已確認：可提供剪髮服務。其他資訊待確認。', ai: { generate }, line: { async reply(_token, text) { replies.push(text); }, async push(id, text) { destinations.push(id); if (pushFail) throw new DeliveryError('unknown'); pushes.push(text); } } });
  return { db, store, worker, replies, pushes, destinations, config, issues };
}
test('customer receives reply and owner alone gets time/item/task notification', async () => {
  const f = await fixture(async () => ({ ...base, bookingStatus: 'requested', requestedTime: '週五下午', service: '剪髮', summary: '想預約剪髮' }));
  try { await f.store.ingest([event('one', '我想預約週五下午剪髮')]); await f.worker.tick();
    assert.equal(f.replies.length, 1); assert.equal(f.pushes.length, 1); assert.deepEqual(f.destinations, [owner]);
    assert.match(f.pushes[0]!, /週五下午/); assert.match(f.pushes[0]!, /尚未確認/); assert.match(f.replies[0]!, /https:\/\/harrishair\.tw/);
    assert.doesNotMatch(f.replies[0]!, /已(?:幫你)?預約成功|預約已成功/); assert.equal((await f.store.listTasks()).length, 1);
  } finally { await f.db.close(); }
});
test('AI failure creates human handoff and still notifies owner', async () => {
  const f = await fixture(async () => { throw new Error('private failure'); });
  try { await f.store.ingest([event('fail', '想問服務')]); await f.worker.tick();
    assert.equal((await f.store.getSession(customer)).handoff, true); assert.equal(f.pushes.length, 1);
    assert.ok(!f.pushes[0]!.includes('private')); assert.match(f.replies[0]!, /Harris/);
  } finally { await f.db.close(); }
});
test('human request and media bypass AI; handoff continuations are analyzed without replies', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return base; });
  try { await f.store.ingest([event('human', '我要找真人')]); await f.worker.tick(); assert.equal(calls, 0);
    await f.store.ingest([event('follow', '我補充一下')]); await f.worker.tick();
    assert.equal(calls, 1); assert.equal(f.replies.length, 1); assert.equal(f.pushes.length, 2);
    await f.store.setHandoff(customer, false);
    const media = event('photo', ''); media.message = { type: 'image' };
    await f.store.ingest([media]); await f.worker.tick(); assert.equal(calls, 1); assert.match(f.replies[1]!, /Harris/);
  } finally { await f.db.close(); }
});
test('handoff activated during AI generation suppresses late automated reply', async () => {
  let activate: (() => Promise<void>) | undefined;
  const f = await fixture(async () => { await activate!(); return base; });
  activate = () => f.store.setHandoff(customer, true);
  try { await f.store.ingest([event('racing', '想問服務')]); await f.worker.tick();
    assert.equal(f.replies.length, 0); assert.match(f.pushes[0]!, /未自動回覆/);
  } finally { await f.db.close(); }
});
test('stale event is not sent with expired reply token but becomes owner task', async () => {
  const f = await fixture();
  try { const stale = event('old', '想預約'); stale.timestamp -= 120000; await f.store.ingest([stale]); await f.worker.tick();
    assert.equal(f.replies.length, 0); assert.equal(f.pushes.length, 1); assert.equal((await f.store.listTasks()).length, 1);
  } finally { await f.db.close(); }
});
test('owner commands control handoff, tasks and feedback without recursive notifications', async () => {
  const f = await fixture(async () => ({ ...base, bookingStatus: 'requested', needsHuman: true }));
  try { await f.store.ingest([event('request', '想預約')]); await f.worker.tick();
    const session = await f.store.getSession(customer); const task = (await f.store.listTasks())[0]!;
    const initialPushes = f.pushes.length;
    for (const [index, text] of [`/pending`, `/take ${session.customerRef}`, `/feedback ${task.id} 語氣請更自然`, `/confirm ${task.id}`, `/done ${task.id}`, `/resume ${session.customerRef}`].entries()) {
      await f.store.ingest([event(`admin-${index}`, text, owner)]); await f.worker.tick();
    }
    assert.equal((await f.store.getSession(customer)).handoff, false); assert.equal((await f.store.listTasks()).length, 0);
    assert.equal(f.pushes.length, initialPushes); assert.equal((await f.store.getTask(task.id))!.bookingStatus, 'owner_confirmed');
  } finally { await f.db.close(); }
});
test('customer cannot execute owner commands', async () => {
  const f = await fixture();
  try { await f.store.ingest([event('establish', '你好')]); await f.worker.tick();
    const session = await f.store.getSession(customer);
    await f.store.setHandoff(customer, true);
    await f.store.ingest([event('pretend', `/resume ${session.customerRef}`)]); await f.worker.tick();
    assert.equal((await f.store.getSession(customer)).handoff, true);
  } finally { await f.db.close(); }
});
test('notification failure does not duplicate customer reply or task', async () => {
  const f = await fixture(async () => base, true);
  try { await f.store.ingest([event('notify-fail', '你好')]); await f.worker.tick(); await f.worker.tick();
    assert.equal(f.replies.length, 1);
    assert.equal(f.issues.length, 1); assert.equal(f.issues[0]!.event, 'owner_notification_failed');
    assert.equal(f.issues[0]!.attempt, 1); assert.equal(f.issues[0]!.terminal, false);
    assert.ok(!JSON.stringify(f.issues).includes('你好'));
  } finally { await f.db.close(); }
});
test('model cannot claim confirmed booking or unsupported price through free text', async () => {
  const f = await fixture(async () => ({ ...base, reply: '已幫你預約成功，剪髮只要 500 元。' }));
  try { await f.store.ingest([event('unsafe', '想問服務')]); await f.worker.tick();
    assert.ok(!f.replies[0]!.includes('500')); assert.ok(!f.replies[0]!.includes('預約成功'));
    assert.equal((await f.store.getSession(customer)).handoff, true);
  } finally { await f.db.close(); }
});
test('customer self-reported booking is never upgraded to a verified appointment', async () => {
  const f = await fixture(async () => ({ ...base, bookingStatus: 'self_reported', requestedTime: '明天下午', service: '燙髮' }));
  try { await f.store.ingest([event('reported', '我在平台預約好了')]); await f.worker.tick();
    assert.match(f.pushes[0]!, /客人自述/); assert.match(f.replies[0]!, /確認/);
  } finally { await f.db.close(); }
});
test('test gate rechecks previously queued users after a configuration change', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return base; });
  try { await f.store.ingest([event('queued-live-user', '你好')]);
    f.config.testUserIds = [`U${'3'.repeat(32)}`]; await f.worker.tick();
    assert.equal(calls, 0); assert.equal(f.replies.length, 0); assert.equal(f.pushes.length, 0);
  } finally { await f.db.close(); }
});
test('pending notifications never go to a previously configured owner after rotation', async () => {
  const f = await fixture();
  try { await f.store.ingest([event('old-owner-notice', '你好')]);
    const job = (await f.store.claimEvent())!;
    await f.store.finishEvent(job, { ...base, delivery: 'sent' }, owner);
    f.config.ownerId = `U${'3'.repeat(32)}`; await f.worker.tick();
    assert.equal(f.pushes.length, 0); assert.equal(f.destinations.length, 0);
  } finally { await f.db.close(); }
});
