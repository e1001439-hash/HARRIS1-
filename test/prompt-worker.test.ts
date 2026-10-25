import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startRuntime } from '../src/runtime.js';
import { loadConfig } from '../src/config.js';
import { DeliveryError } from '../src/clients/line.js';
import { createTestDatabase } from './database.js';
import type { AiInput, AiResult } from '../src/types.js';

const owner = `U${'1'.repeat(32)}`, customer = `U${'2'.repeat(32)}`;
const base: AiResult = { reply: '草稿', summary: '需求', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '待確認' };
const booking = (time = '週五下午', service = '剪髮'): AiResult => ({ ...base, requestedTime: time, service, bookingStatus: 'requested', needsHuman: true });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(condition: () => Promise<boolean> | boolean, reason: string) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail(reason);
}
async function fixture(options: { ai?: (input: AiInput) => Promise<AiResult>; reply?: () => Promise<void>; push?: () => Promise<void> } = {}) {
  const db = await createTestDatabase();
  const replies: string[] = [], notices: string[] = [], trace: string[] = [];
  const config = loadConfig({ DATABASE_URL: 'test-only', LINE_CHANNEL_SECRET: 'test-secret', LINE_CHANNEL_ACCESS_TOKEN: 'fake-token', OWNER_LINE_USER_ID: owner, TEST_LINE_USER_IDS: customer, RESPONSE_MODE: 'ai', SALON_AI_API_KEY: 'fake-only', AI_MODEL: 'fake-only' }); config.port = 0;
  const runtime = await startRuntime({ db, config, knowledge: '', host: '127.0.0.1', ai: { generate: options.ai ?? (async () => booking()) }, line: {
    async reply(_token, text) { trace.push('reply'); await options.reply?.(); replies.push(text); },
    async push(to, text) { assert.equal(to, owner); trace.push('push'); await options.push?.(); notices.push(text); },
  } });
  const send = async (id: string, text: string, timestamp = Date.now()) => {
    const payload = JSON.stringify({ events: [{ type: 'message', webhookEventId: id, timestamp, replyToken: `reply-${id}`, source: { type: 'user', userId: customer }, message: { type: 'text', text } }] });
    const response = await runtime.app.inject({ method: 'POST', url: '/webhook', payload, headers: { 'content-type': 'application/json', 'x-line-signature': createHmac('sha256', 'test-secret').update(payload).digest('base64') } });
    assert.equal(response.statusCode, 200);
  };
  const done = async (id: string) => (await db.query<{status:string}>('SELECT status FROM events WHERE id=$1', [id])).rows[0]?.status === 'done';
  return { ...runtime, db, replies, notices, trace, send, done };
}

test('signed intake notifies the owner before an unresolved AI call finishes', async () => {
  const ai = gate<AiResult>(); let started = false;
  const f = await fixture({ ai: async () => { started = true; return ai.promise; } });
  try {
    await f.send('early-ai', '我想預約週五下午剪髮');
    await until(() => started, 'AI must start');
    await until(() => f.notices.length === 1, 'owner must get receipt while AI is unresolved');
    assert.match(f.notices[0]!, /週五下午剪髮/); assert.equal(f.replies.length, 0);
    ai.resolve(booking()); await until(() => f.done('early-ai'), 'analysis must complete');
    await until(() => f.notices.some(text => text.includes('期望時間：週五下午')), 'owner must get extracted time');
    assert.equal(f.trace[0], 'push');
  } finally { ai.resolve(booking()); await f.close(); }
});
test('a blocked customer LINE reply does not block owner receipt delivery', async () => {
  const reply = gate<void>(); let started = false;
  const f = await fixture({ reply: async () => { started = true; await reply.promise; } });
  try {
    await f.send('blocked-reply', '我想預約週五下午剪髮');
    await until(() => started, 'reply must be in flight');
    await until(() => f.notices.length > 0, 'owner receipt must bypass blocked reply');
    assert.equal(f.replies.length, 0);
  } finally { reply.resolve(); await f.close(); }
});
test('human handoff still extracts changed times without replying or resuming', async () => {
  const f = await fixture({ ai: async ({ text }) => text.includes('週六') ? booking('週六晚上', '剪髮') : booking() });
  try {
    await f.store.setHandoff(customer, true);
    await f.send('manual-first', '我想預約週五下午剪髮'); await until(() => f.done('manual-first'), 'manual analysis must finish');
    await f.send('manual-change', '改成週六晚上'); await until(() => f.done('manual-change'), 'changed time must be analyzed');
    await until(() => f.notices.some(text => text.includes('期望時間：週六晚上')), 'updated time must reach owner');
    const tasks = await f.store.listTasks();
    assert.equal(tasks[0]!.requestedTime, '週六晚上'); assert.equal(tasks[0]!.service, '剪髮');
    assert.equal(f.replies.length, 0); assert.equal((await f.store.getSession(customer)).handoff, true);
    assert.ok(f.notices.every(text => !text.includes('預約已成功')));
  } finally { await f.close(); }
});
test('handoff analysis preserves owner resume while keeping this message silent', async () => {
  const ai = gate<AiResult>(); let started = false;
  const f = await fixture({ ai: async () => { started = true; return ai.promise; } });
  try {
    await f.store.setHandoff(customer, true); await f.send('manual-resume', '改成週六晚上剪髮');
    await until(() => started, 'manual message must be analyzed');
    await f.store.setHandoff(customer, false); ai.resolve(booking('週六晚上'));
    await until(() => f.done('manual-resume'), 'analysis must finish');
    assert.equal((await f.store.getSession(customer)).handoff, false); assert.equal(f.replies.length, 0);
  } finally { ai.resolve(booking('週六晚上')); await f.close(); }
});
test('AI failure during handoff still sends raw request without customer reply', async () => {
  const f = await fixture({ ai: async () => { throw new Error('private model details'); } });
  try {
    await f.store.setHandoff(customer, true); await f.send('manual-fail', '希望改成週六晚上染髮');
    await until(() => f.done('manual-fail'), 'fallback must finish');
    await until(() => f.notices.length > 0, 'raw request must be delivered');
    assert.ok(f.notices.some(text => text.includes('週六晚上染髮')));
    assert.equal(f.replies.length, 0); assert.equal((await f.store.getSession(customer)).handoff, true);
    assert.ok(!f.notices.join('').includes('private model details'));
  } finally { await f.close(); }
});
test('LINE reply failure still permits receipt and analyzed owner update', async () => {
  const f = await fixture({ reply: async () => { throw new DeliveryError('unknown'); } });
  try {
    await f.send('reply-fail', '我想預約週五下午剪髮');
    await until(() => f.done('reply-fail'), 'reply failure must not prevent analysis persistence');
    await until(() => f.notices.some(text => text.includes('期望時間：週五下午')), 'owner update must survive reply failure');
    assert.equal((await f.store.getSession(customer)).handoff, true);
  } finally { await f.close(); }
});
test('notification failure does not block processing or customer reply', async () => {
  const f = await fixture({ push: async () => { throw new DeliveryError('unknown'); } });
  try {
    await f.send('notice-fail', '我想預約週五下午剪髮');
    await until(() => f.done('notice-fail'), 'processing must finish despite failed push');
    assert.equal(f.replies.length, 1);
    const jobs = await f.db.query<{status:string;attempts:number}>('SELECT status,attempts FROM notifications');
    assert.ok(jobs.rows.length >= 1); assert.ok(jobs.rows.every(row => row.attempts <= 3));
  } finally { await f.close(); }
});
test('a late older message cannot replace the newer appointment request', async () => {
  const f = await fixture({ ai: async ({ text }) => text.includes('週六') ? booking('週六晚上') : booking() });
  try {
    await f.store.setHandoff(customer, true); const now = Date.now();
    await f.send('newest-time', '改成週六晚上剪髮', now); await until(() => f.done('newest-time'), 'newer message must finish');
    await f.send('late-old-time', '我想預約週五下午剪髮', now - 1000); await until(() => f.done('late-old-time'), 'late message must finish safely');
    const tasks = await f.store.listTasks();
    assert.equal(tasks[0]!.requestedTime, '週六晚上');
    assert.equal(f.replies.length, 0); assert.equal((await f.store.getSession(customer)).handoff, true);
  } finally { await f.close(); }
});
test('take then resume while an initially automatic AI call is pending cannot leak a reply or undo resume', async () => {
  const ai = gate<AiResult>(); let started = false;
  const f = await fixture({ ai: async () => { started = true; return ai.promise; } });
  try {
    await f.send('auto-take-resume', '我想預約週五下午剪髮'); await until(() => started, 'AI must start');
    await f.store.setHandoff(customer, true); await f.store.setHandoff(customer, false);
    ai.resolve(booking()); await until(() => f.done('auto-take-resume'), 'analysis must finish');
    assert.equal(f.replies.length, 0); assert.equal((await f.store.getSession(customer)).handoff, false);
  } finally { ai.resolve(booking()); await f.close(); }
});
test('owner resume during an already-started LINE reply is not overwritten at completion', async () => {
  const reply = gate<void>(); let started = false;
  const f = await fixture({ reply: async () => { started = true; await reply.promise; } });
  try {
    await f.send('reply-take-resume', '我想預約週五下午剪髮'); await until(() => started, 'LINE reply must already be in flight');
    await f.store.setHandoff(customer, true); await f.store.setHandoff(customer, false);
    reply.resolve(); await until(() => f.done('reply-take-resume'), 'completion must preserve owner decision');
    assert.equal(f.trace.filter(item => item === 'reply').length, 1);
    assert.equal((await f.store.getSession(customer)).handoff, false);
  } finally { reply.resolve(); await f.close(); }
});
test('an explicit resume alone fences the automatic decision made by an older AI job', async () => {
  const ai = gate<AiResult>(); let started = false;
  const f = await fixture({ ai: async () => { started = true; return ai.promise; } });
  try {
    await f.send('resume-fence', '我想預約週五下午剪髮'); await until(() => started, 'AI must start');
    await f.store.setHandoff(customer, false); ai.resolve(booking());
    await until(() => f.done('resume-fence'), 'completion must preserve explicit resume');
    assert.equal((await f.store.getSession(customer)).handoff, false);
  } finally { ai.resolve(booking()); await f.close(); }
});
