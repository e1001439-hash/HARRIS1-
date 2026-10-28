import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { loadFacts } from '../src/knowledge.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { createTestDatabase } from './database.js';
import type { AiClient, AiInput, AiResult, LineEvent } from '../src/types.js';

const owner = `U${'1'.repeat(32)}`, customer = `U${'2'.repeat(32)}`;
const answer: AiResult = { reply: '模型不可信原文500元，已預約成功。', summary: '', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '' };
const facts = await loadFacts('knowledge/facts.json');
async function fixture(dataDir?: string, generate: (input: AiInput) => Promise<AiResult> = async () => answer, verify?: NonNullable<AiClient['verify']>) {
  const db = await createTestDatabase(dataDir), store = new Store(db);
  const config = loadConfig({ DATABASE_URL: 'local-fake', LINE_CHANNEL_SECRET: 'preview-test-only', LINE_CHANNEL_ACCESS_TOKEN: 'fake', OWNER_LINE_USER_ID: owner, TEST_LINE_USER_IDS: customer, RESPONSE_MODE: 'ai', SALON_AI_API_KEY: 'fake', AI_MODEL: 'fake' });
  const calls: AiInput[] = [], replies: { token: string; text: string }[] = [], pushes: string[] = [];
  const worker = new Worker({ store, config, facts, knowledge: '只使用核准店務資料', ai: { async generate(input) { calls.push(input); return generate(input); }, ...(verify ? { verify } : {}) }, line: { async reply(token, text) { replies.push({ token, text }); }, async push(_to, text) { pushes.push(text); } } });
  const app = createApp({ config, store });
  const event = (id: string, text: string, userId = owner): LineEvent => ({ type: 'message', webhookEventId: id, timestamp: Date.now(), replyToken: `reply-${id}`, source: { type: 'user', userId }, message: { type: 'text', text } });
  const inject = async (e: LineEvent, valid = true) => {
    const payload = JSON.stringify({ events: [e] });
    return app.inject({ method: 'POST', url: '/webhook', payload, headers: { 'content-type': 'application/json', 'x-line-signature': valid ? createHmac('sha256', config.lineSecret).update(payload).digest('base64') : 'invalid' } });
  };
  const send = async (id: string, text: string) => { assert.equal((await inject(event(id, text))).statusCode, 200); await worker.tick(); return replies.find(r => r.token === `reply-${id}`)?.text ?? ''; };
  return { db, store, config, calls, replies, pushes, worker, event, inject, send, async close() { await app.close(); await db.close(); } };
}

test('店主預覽共用核准價格與預約政策，空歷史且不建立待辦或改人工狀態', async () => {
  const f = await fixture();
  try {
    await f.store.setHandoff(owner, true); await f.store.setHandoff(customer, true);
    const before = (await f.db.query('SELECT user_id,handoff,handoff_revision FROM sessions ORDER BY user_id')).rows;
    const text = await f.send('price', '/preview 剪髮多少錢？');
    assert.match(text, /店主.*預覽/); assert.match(text, /700\s*元/); assert.match(text, /安全簡答.*未採用自然草稿/); assert.doesNotMatch(text, /AI.*成功/);
    assert.match(text, /不代表.*端到端/); assert.doesNotMatch(text, /500|已預約成功/);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.text, '剪髮多少錢？'); assert.deepEqual(f.calls[0]!.history, []);
    assert.match(f.calls[0]!.knowledge, /700/);
    assert.deepEqual((await f.db.query('SELECT user_id,handoff,handoff_revision FROM sessions ORDER BY user_id')).rows, before);
    assert.equal((await f.store.listTasks()).length, 0); assert.equal(f.pushes.length, 0);
    assert.equal((await f.db.query('SELECT id FROM notifications')).rows.length, 0);
    const row = (await f.db.query<{payload:unknown;outcome:unknown}>('SELECT payload,outcome FROM events WHERE id=$1', ['price'])).rows[0]!;
    assert.equal(row.payload, null); assert.equal(row.outcome, null);
    await f.db.query("UPDATE events SET owner_preview_started_at=clock_timestamp()-interval '11 seconds'");
    const booking = await f.send('book', '/預覽 我想預約剪髮');
    assert.match(booking, /希望預約.*時間/); assert.doesNotMatch(booking, /https?:/);
    assert.match(booking, /需要本人/); assert.doesNotMatch(booking, /已預約成功/);
    assert.equal((await f.store.listTasks()).length, 0); assert.equal(f.pushes.length, 0);
  } finally { await f.close(); }
});

test('空白、過長、非AI模式、非測試模式、過期及無回覆憑證不消耗AI', async () => {
  const f = await fixture();
  try {
    assert.match(await f.send('empty', '/preview   '), /用法/);
    assert.match(await f.send('long', `/預覽 ${'問'.repeat(1001)}`), /1000/);
    f.config.responseMode = 'fixed'; assert.match(await f.send('fixed', '/preview 剪髮多少'), /AI.*模式|ai/);
    f.config.responseMode = 'ai'; f.config.mode = 'live'; assert.match(await f.send('live', '/preview 剪髮多少'), /測試模式/);
    f.config.mode = 'test';
    const stale = f.event('stale', '/preview 剪髮多少'); stale.timestamp -= 60000;
    await f.inject(stale); await f.worker.tick();
    const noToken = f.event('no-token', '/preview 剪髮多少'); delete noToken.replyToken;
    await f.inject(noToken); await f.worker.tick();
    assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 4); assert.equal(f.pushes.length, 0);
    assert.equal((await f.store.listTasks()).length, 0);
  } finally { await f.close(); }
});

test('非店主、群組與錯誤簽章不能觸發預覽，也不進客人AI流程', async () => {
  const f = await fixture();
  try {
    const notOwner = f.event('customer-preview', '/preview 剪髮多少', customer);
    assert.equal((await f.inject(notOwner)).statusCode, 200);
    const group = f.event('group', '/預覽 剪髮多少'); group.source.type = 'group';
    assert.equal((await f.inject(group)).statusCode, 200);
    assert.equal((await f.inject(f.event('wrong-signature', '/preview 剪髮多少'), false)).statusCode, 401);
    await f.worker.tick();
    assert.equal((await f.db.query('SELECT id FROM events')).rows.length, 0);
    assert.equal((await f.store.listTasks()).length, 0); assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0);
    // Internal tools must not be able to make a grouped owner preview reply.
    await f.store.ingest([group], owner); await f.worker.tick();
    assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0); assert.equal(f.pushes.length, 0);
  } finally { await f.close(); }
});

test('規則直接接手與未知問題預覽分清是否呼叫AI，錯誤不洩漏原始內容', async () => {
  let fail = false;
  const secret = 'PRIVATE-PROVIDER-PAYLOAD-CANARY';
  const f = await fixture(undefined, async () => { if (fail) throw Object.assign(new Error(secret), { cause: secret, key: secret }); return answer; });
  try {
    const rule = await f.send('rule', '/preview 我漂髮後頭皮過敏');
    assert.match(rule, /未呼叫\s*AI/); assert.match(rule, /本人/); assert.equal(f.calls.length, 0);
    const unknown = await f.send('unknown', '/preview 你們的地址在哪？');
    assert.match(unknown, /安全簡答.*未採用自然草稿/); assert.match(unknown, /本人/); assert.doesNotMatch(unknown, /500/);
    await f.db.query("UPDATE events SET owner_preview_started_at=clock_timestamp()-interval '11 seconds'");
    fail = true; const failed = await f.send('failed', '/preview 剪髮多少？');
    assert.match(failed, /UNAVAILABLE/); assert.doesNotMatch(failed, new RegExp(secret));
    assert.equal((await f.store.listTasks()).length, 0); assert.equal(f.pushes.length, 0);
    assert.equal(JSON.stringify((await f.db.query('SELECT payload,outcome FROM events')).rows).includes(secret), false);
  } finally { await f.close(); }
});

test('店主預覽區分已核驗自然原句與fallback，不冒充真人核准', async () => {
  let reviews = 0;
  const f = await fixture(undefined, async () => ({ ...answer, reply: '剪髮的費用是{{price}}元喔 😊' }), async ({ candidate }) => {
    reviews++;
    return { verdict: 'supported', complete: true, facts: [{ kind: 'price', service: '剪髮', length: null, audience: null, value: '700', polarity: 'affirmed', evidence: candidate }],
      questions: [], actions: [], persona: 'assistant', issues: [] };
  });
  try {
    const text = await f.send('verified-preview', '/預覽 剪髮多少錢？');
    assert.match(text, /自然草稿通過模型語意核驗.*尚未經真人確認/);
    assert.match(text, /剪髮的費用是700元喔 😊/); assert.doesNotMatch(text, /安全簡答/);
    assert.equal(reviews, 1); assert.equal(f.pushes.length, 0); assert.equal((await f.store.listTasks()).length, 0);
  } finally { await f.close(); }
});

test('同一webhook重送只預覽一次，新的過密問題不呼叫AI', async () => {
  const f = await fixture();
  try {
    const e = f.event('same', '/preview 剪髮多少？'); await f.inject(e); await f.worker.tick();
    assert.equal(f.calls.length, 1);
    await f.inject(e); await f.worker.tick(); assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 1);
    assert.match(await f.send('too-fast', '/預覽 染髮多少？'), /10秒|20次/);
    assert.equal(f.calls.length, 1); assert.equal((await f.store.listTasks()).length, 0);
  } finally { await f.close(); }
});

test('中斷後重領與檔案資料庫重啟不重複AI呼叫，管理指令仍可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harris-owner-preview-'));
  let f = await fixture(join(dir, 'db'), async () => { await f.db.query("UPDATE events SET lease_until=clock_timestamp()-interval '1 second' WHERE id='interrupted'"); throw new Error('fake interruption'); });
  try {
    await f.send('interrupted', '/preview 剪髮多少？'); assert.equal(f.calls.length, 1);
    await f.close(); f = await fixture(join(dir, 'db'));
    await f.worker.tick();
    assert.equal(f.calls.length, 0); assert.match(f.replies[0]!.text, /中斷|重複|重新/);
    const row = (await f.db.query<{payload:unknown;outcome:unknown;owner_preview_started_at:unknown}>('SELECT payload,outcome,owner_preview_started_at FROM events WHERE id=$1', ['interrupted'])).rows[0]!;
    assert.equal(row.payload, null); assert.equal(row.outcome, null); assert.ok(row.owner_preview_started_at);
    assert.match(await f.send('help', '/help'), /preview|預覽/);
    assert.equal((await f.store.listTasks()).length, 0); assert.equal(f.pushes.length, 0);
  } finally { await f.close(); await rm(dir, { recursive: true, force: true }); }
});

test('24小時20次上限於清除問題結果後仍跨重啟保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harris-preview-budget-'));
  let f = await fixture(join(dir, 'db'));
  try {
    for (let i = 0; i < 20; i++) {
      assert.match(await f.send(`budget-${i}`, '/preview 剪髮多少？'), /700\s*元/);
      await f.db.query("UPDATE events SET owner_preview_started_at=clock_timestamp()-interval '11 seconds' WHERE owner_preview_started_at IS NOT NULL");
    }
    assert.equal(f.calls.length, 20);
    await f.close(); f = await fixture(join(dir, 'db'));
    assert.match(await f.send('budget-blocked', '/preview 剪髮多少？'), /20次/); assert.equal(f.calls.length, 0);
    await f.db.query("UPDATE events SET owner_preview_started_at=clock_timestamp()-interval '25 hours' WHERE owner_preview_started_at IS NOT NULL");
    assert.match(await f.send('budget-reset', '/preview 剪髮多少？'), /700\s*元/); assert.equal(f.calls.length, 1);
    assert.equal((await f.store.listTasks()).length, 0); assert.equal(f.pushes.length, 0);
  } finally { await f.close(); await rm(dir, { recursive: true, force: true }); }
});
