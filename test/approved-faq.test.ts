import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFacts } from '../src/knowledge.js';
import { loadConfig } from '../src/config.js';
import { applyPolicy } from '../src/policy.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { createTestDatabase } from './database.js';
import type { AiResult, LineEvent } from '../src/types.js';

const owner = `U${'1'.repeat(32)}`, customer = `U${'2'.repeat(32)}`;
const env = { DATABASE_URL: 'postgres://localhost/test', LINE_CHANNEL_SECRET: 'fake', LINE_CHANNEL_ACCESS_TOKEN: 'fake', OWNER_LINE_USER_ID: owner, TEST_LINE_USER_IDS: customer };
const model: AiResult = { reply: '剪髮560元，已預約成功，圖片已傳送。', summary: 'model text', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '' };
const facts = await loadFacts('knowledge/facts.json');
function respond(text: string, patch: Partial<AiResult> = {}) {
  return applyPolicy({ ...model, ...patch }, text, '', loadConfig(env).bookingUrl, facts);
}
function safeText(reply: string) {
  assert.doesNotMatch(reply, /560|595|已傳送|已(?:幫你)?預約成功|已保留|含洗|含剪|g7\.zoom-world/);
}

test('核准剪髮價格能處理常用問法，且不採用模型折扣或預約誤判', () => {
  for (const text of ['剪髮價格多少？', '新客剪髮多少錢？', '會員剪髮怎麼算？']) {
    const result = respond(text, { bookingStatus: 'requested' });
    assert.match(result.reply, /700\s*元/);
    assert.equal(result.bookingStatus, 'none');
    assert.equal(result.needsHuman, false);
    safeText(result.reply);
  }
});

test('燙染與價目表詢問引導選單、折後金額與長度，不提供自行報價或假圖片', () => {
  for (const text of ['燙髮多少？', '染髮費用怎麼算？', '燙染價格多少錢？', '可以給我價目表嗎？']) {
    const result = respond(text, { bookingStatus: 'requested' });
    assert.match(result.reply, /下方選單.*價目表/s);
    assert.match(result.reply, /新客/); assert.match(result.reply, /會員/);
    assert.match(result.reply, /折後/); assert.match(result.reply, /長度/);
    assert.doesNotMatch(result.reply, /\d{3,}/);
    assert.equal(result.needsHuman, false);
    safeText(result.reply);
  }
});

test('未核准資訊與複雜需求不會被服務關鍵詞帶進價目表FAQ', () => {
  for (const text of ['染髮店的地址在哪？', '染髮店明天有營業嗎？', '剪髮700有含洗嗎？', '染髮訂金多少？', '燙髮取消怎麼算？', '染髮要不要先付定金？', '燙髮需要多少時間？', '染髮有護髮嗎？', '燙髮要幾分鐘？', '燙髮改期怎麼辦？', '染髮可以刷卡嗎？']) {
    const result = respond(text);
    assert.equal(result.needsHuman, true, text);
    assert.doesNotMatch(result.reply, /700|下方選單/);
  }
  assert.equal(respond('剪髮多少？', { needsHuman: true }).needsHuman, true);
  const unapproved = { ...facts, approved: false };
  const result = applyPolicy(model, '剪髮多少？', '', 'https://harrishair.tw', unapproved);
  assert.equal(result.needsHuman, true); assert.doesNotMatch(result.reply, /700/);
});

test('預約詢問希望時段並使用核准入口，已提供時段不重問，也不保證空檔', () => {
  const result = respond('我想預約剪髮');
  assert.match(result.reply, /希望預約.*時間/);
  assert.match(result.reply, /https:\/\/harrishair\.tw/);
  assert.match(result.reply, /Harris.*確認/);
  assert.equal(result.needsHuman, true); assert.equal(result.bookingStatus, 'requested');
  const withTime = respond('我想約週五下午剪髮，價格多少？', { requestedTime: '週五下午', service: '剪髮' });
  assert.equal(withTime.bookingStatus, 'requested'); assert.equal(withTime.requestedTime, '週五下午');
  assert.match(withTime.reply, /700\s*元/); assert.match(withTime.reply, /https:\/\/harrishair\.tw/);
  assert.doesNotMatch(withTime.reply, /有沒有希望預約/);
  safeText(result.reply); safeText(withTime.reply);
});

test('實際worker使用核准FAQ後仍能接收預約，接手後僅通知店主；fixed仍保留', async () => {
  const db = await createTestDatabase();
  const store = new Store(db);
  const config = loadConfig({ ...env, RESPONSE_MODE: 'ai', SALON_AI_API_KEY: 'fake', AI_MODEL: 'fake' });
  const replies: string[] = [], notices: string[] = [];
  const worker = new Worker({ store, config, facts, knowledge: '只使用已核准模板', ai: { async generate() { return model; } }, line: { async reply(_token, text) { replies.push(text); }, async push(to, text) { assert.equal(to, owner); notices.push(text); } } });
  const message = (id: string, text: string): LineEvent => ({ type: 'message', webhookEventId: id, timestamp: Date.now(), source: { type: 'user', userId: customer }, replyToken: `fake-${id}`, message: { type: 'text', text } });
  try {
    await store.ingest([message('faq-price', '剪髮多少？')]); await worker.tick();
    assert.match(replies[0]!, /700\s*元/); assert.equal((await store.getSession(customer)).handoff, false);
    await store.ingest([message('faq-booking', '我想預約剪髮')]); await worker.tick();
    assert.match(replies[1]!, /https:\/\/harrishair\.tw/); assert.equal((await store.getSession(customer)).handoff, true);
    await store.ingest([message('faq-followup', '改成週六下午')]); await worker.tick();
    assert.equal(replies.length, 2); assert.ok(notices.some(text => text.includes('改成週六下午')));
    await store.setHandoff(customer, false);
    config.responseMode = 'fixed';
    await store.ingest([message('fixed-price', '剪髮多少？')]); await worker.tick();
    assert.equal(replies.length, 3); assert.doesNotMatch(replies[2]!, /700/);
    assert.equal((await store.getSession(customer)).handoff, true);
    assert.equal(config.mode, 'test');
  } finally { await db.close(); }
});
