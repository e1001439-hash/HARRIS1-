import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPolicy } from '../src/policy.js';
import { emptyFacts } from '../src/knowledge.js';
import type { AiResult } from '../src/types.js';
const answer: AiResult = { reply: '我們在台北市信義路五段 7 號，每天 10:00–20:00 營業。', summary: '詢問地址', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '無需處理' };
const link = 'https://g7.zoom-world.tw/Round2HairSalon/index.aspx';
test('unknown facts cannot be invented, including unsolicited facts in a model greeting', () => {
  for (const text of ['地址在哪？', '幾點營業？', '你好']) {
    const result = applyPolicy(answer, text, '地址與營業時間尚未提供', link, emptyFacts());
    assert.ok(!result.reply.includes('信義路')); assert.ok(!result.reply.includes('10:00'));
  }
});
test('availability question cannot become a booking promise even when model says no booking', () => {
  const result = applyPolicy({ ...answer, reply: '可以，已幫您訂好明天下午兩點，直接過來就可以了。' }, '明天下午兩點可以嗎？', '', link, emptyFacts());
  assert.doesNotMatch(result.reply, /訂好|直接過來/); assert.equal(result.bookingStatus, 'requested'); assert.equal(result.needsHuman, true);
});
test('confirmed structured facts and human-authored FAQ supply the actual customer reply', () => {
  const facts = { ...emptyFacts(), approved: true, address: '測試市測試路 1 號', hours: '週二至週六 11:00–19:00', faqs: [{ keywords: ['停車'], answer: '附近停車方式請先詢問本人。' }] };
  assert.match(applyPolicy(answer, '地址在哪？', '', link, facts).reply, /測試路 1 號/);
  assert.equal(applyPolicy(answer, '可以停車嗎？', '', link, facts).reply, facts.faqs[0]!.answer);
  facts.approved = false;
  assert.ok(!applyPolicy(answer, '地址在哪？', '', link, facts).reply.includes('測試路'));
});
