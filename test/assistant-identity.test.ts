import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { loadConfig } from '../src/config.js';
import { loadFacts } from '../src/knowledge.js';
import { DeliveryError } from '../src/clients/line.js';
import type { AiResult, Database, LineEvent } from '../src/types.js';
import { createTestDatabase } from './database.js';

const owner = `U${'1'.repeat(32)}`, customer = `U${'2'.repeat(32)}`;
const model: AiResult = { reply: 'model', summary: '', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '' };
const facts = await loadFacts('knowledge/facts.json');
const message = (id: string, userId = customer): LineEvent => ({ type: 'message', webhookEventId: id, timestamp: Date.now(), source: { type: 'user', userId }, replyToken: `fake-${id}`, message: { type: 'text', text: '你好' } });
const intro = /Harris 的訊息小幫手.*AI/s;
function fixture(db: Database) {
  const store = new Store(db), replies: string[] = [];
  let failure: 'failed' | 'unknown' | undefined;
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/test', LINE_CHANNEL_SECRET: 'fake', LINE_CHANNEL_ACCESS_TOKEN: 'fake', OWNER_LINE_USER_ID: owner, TEST_LINE_USER_IDS: customer, RESPONSE_MODE: 'ai', SALON_AI_API_KEY: 'fake', AI_MODEL: 'fake' });
  const options = { store, config, facts, knowledge: '核准指南', ai: { async generate() { return model; } }, line: { async reply(_token: string, text: string) { replies.push(text); if (failure) throw new DeliveryError(failure); }, async push() {} } };
  return { store, replies, config, worker: new Worker(options), restart: () => new Worker(options), fail: (value?: 'failed' | 'unknown') => { failure = value; } };
}

test('首次透明介紹 AI，事件重送及後續回覆不再重複，保存實際對客文案', async () => {
  const db = await createTestDatabase(), f = fixture(db);
  try {
    const first = message('intro-first');
    await f.store.ingest([first], owner); await f.worker.tick();
    assert.match(f.replies[0]!, intro);
    assert.equal((f.replies[0]!.match(/AI/g) ?? []).length, 1);
    assert.equal((await f.store.history(customer)).find(turn => turn.role === 'assistant')?.content, f.replies[0]);
    await f.store.ingest([first], owner); await f.worker.tick();
    await f.store.ingest([message('intro-second')], owner); await f.restart().tick();
    assert.equal(f.replies.length, 2); assert.doesNotMatch(f.replies[1]!, /AI|訊息小幫手/);
    assert.equal((f.replies[0]!.match(/\p{Extended_Pictographic}/gu) ?? []).length <= 1, true);
  } finally { await db.close(); }
});

test('資料庫重開與清除對話原文後仍記得已介紹，不靠暫存或聊天內容', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harris-identity-'));
  let db = await createTestDatabase(join(directory, 'db'));
  try {
    let f = fixture(db);
    await f.store.ingest([message('before-restart')]); await f.worker.tick();
    assert.match(f.replies[0]!, intro);
    await db.query('UPDATE events SET payload=NULL, outcome=NULL, text_removed_at=now()');
    await db.close(); db = await createTestDatabase(join(directory, 'db')); f = fixture(db);
    await f.store.ingest([message('after-restart')]); await f.worker.tick();
    assert.equal(f.replies.length, 1); assert.doesNotMatch(f.replies[0]!, /AI|訊息小幫手/);
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('明確首次送出失敗讓未來恢復接待時重新介紹，後續一般失敗不清除既有介紹', async () => {
  const db = await createTestDatabase(), f = fixture(db);
  try {
    f.fail('failed'); await f.store.ingest([message('first-failed')]); await f.worker.tick();
    assert.match(f.replies[0]!, intro); assert.equal((await f.store.getSession(customer)).handoff, true);
    f.fail(); await f.store.setHandoff(customer, false);
    await f.store.ingest([message('first-accepted')]); await f.worker.tick(); assert.match(f.replies[1]!, intro);
    f.fail('failed'); await f.store.ingest([message('later-failed')]); await f.worker.tick();
    f.fail(); await f.store.setHandoff(customer, false);
    await f.store.ingest([message('later-accepted')]); await f.worker.tick();
    assert.doesNotMatch(f.replies[2]!, /AI|訊息小幫手/); assert.doesNotMatch(f.replies[3]!, /AI|訊息小幫手/);
  } finally { await db.close(); }
});

test('送達不明與送出後重啟不重傳介紹或重複回覆', async () => {
  const db = await createTestDatabase(), f = fixture(db);
  try {
    f.fail('unknown'); await f.store.ingest([message('unknown-intro')]); await f.worker.tick();
    assert.match(f.replies[0]!, intro);
    f.fail(); await f.store.setHandoff(customer, false);
    await f.store.ingest([message('after-unknown')]); await f.restart().tick();
    assert.doesNotMatch(f.replies[1]!, /AI|訊息小幫手/);
    const other = `U${'3'.repeat(32)}`; f.config.testUserIds.push(other);
    await f.store.ingest([message('crashed-send', other)]);
    const job = (await f.store.claimEvent())!;
    assert.ok(await f.store.markSending(job));
    await db.query("UPDATE events SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    await f.restart().tick(); assert.equal(f.replies.length, 2);
    await f.store.setHandoff(other, false);
    await f.store.ingest([message('after-crash', other)]); await f.restart().tick();
    assert.doesNotMatch(f.replies[2]!, /AI|訊息小幫手/);
  } finally { await db.close(); }
});

test('過期、較舊與人工接手抑制的訊息不消耗首次介紹', async () => {
  const db = await createTestDatabase(), f = fixture(db);
  try {
    const old = message('expired'); old.timestamp -= 120000;
    await f.store.ingest([old]); await f.worker.tick(); assert.equal(f.replies.length, 0);
    await f.store.setHandoff(customer, false);
    await f.store.ingest([message('older'), message('newest')]);
    await f.worker.tick(); assert.equal(f.replies.length, 0);
    await f.worker.tick(); assert.match(f.replies[0]!, intro);
    const other = `U${'3'.repeat(32)}`; f.config.testUserIds.push(other);
    await f.store.setHandoff(other, true); await f.store.ingest([message('manual-only', other)]); await f.worker.tick();
    assert.equal(f.replies.length, 1);
    await f.store.setHandoff(other, false); await f.store.ingest([message('resumed-first', other)]); await f.worker.tick();
    assert.match(f.replies[1]!, intro);
  } finally { await db.close(); }
});

test('owner 管理與未核准測試帳號不收到客人介紹，後續獲准客人仍首次介紹', async () => {
  const db = await createTestDatabase(), f = fixture(db);
  try {
    const admin = message('admin', owner); admin.message!.text = '/help';
    await f.store.ingest([admin]); await f.worker.tick(); assert.doesNotMatch(f.replies[0]!, intro);
    const other = `U${'3'.repeat(32)}`;
    await f.store.ingest([message('not-allowed', other)]); await f.worker.tick(); assert.equal(f.replies.length, 1);
    f.config.testUserIds.push(other);
    await f.store.ingest([message('allowed-first', other)]); await f.worker.tick(); assert.match(f.replies[1]!, intro);
  } finally { await db.close(); }
});
