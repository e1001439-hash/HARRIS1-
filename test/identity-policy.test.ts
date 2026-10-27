import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFacts } from '../src/knowledge.js';
import { applyPolicy, humanFallback } from '../src/policy.js';
import type { AiResult } from '../src/types.js';

const facts = await loadFacts('knowledge/facts.json');
const model: AiResult = { reply: '我本人已幫你預約成功，也看過照片了。', summary: '', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '' };
const respond = (text: string, patch: Partial<AiResult> = {}) => applyPolicy({ ...model, ...patch }, text, '', 'https://harrishair.tw', facts);
const emojiCount = (text: string) => [...new Intl.Segmenter('zh-TW', { granularity: 'grapheme' }).segment(text)].filter(part => /\p{Extended_Pictographic}/u.test(part.segment)).length;

test('核准剪價與燙染回覆以助手身分引導，不冒充 Harris 或宣稱已看照片', () => {
  assert.equal(respond('剪髮多少錢？').reply, '剪髮是 700 元喔 😊 想預約哪一天呢？');
  for (const question of ['燙髮多少？', '染髮價格？', '燙染價格？', '給我價目表']) {
    const result = respond(question);
    assert.equal(result.reply, '可以先看下方選單的價目表喔 😊 新客跟會員的折後價格都有列好，依照頭髮長度看就可以了～不確定長度的話，也可以傳照片讓 Harris 幫你確認。');
    assert.equal(result.needsHuman, false);
    assert.doesNotMatch(result.reply, /我本人|已看|已傳送/);
  }
});

test('通用失敗與未知問題轉交 Harris，仍要求人工而非假冒店主', () => {
  for (const result of [humanFallback('照片'), respond('地址在哪？'), respond('染髮包含什麼？')]) {
    assert.equal(result.reply, '收到～這部分要由 Harris 幫你確認喔，先稍等一下 😊');
    assert.equal(result.needsHuman, true);
  }
});

test('已有預約時段使用本人核准短句，內部僅待確認需求', () => {
  const result = respond('我想約週五下午剪髮', { service: '剪髮', requestedTime: '週五下午' });
  assert.match(result.reply, /這個時段需由 Harris 確認，請稍等唷/);
  assert.doesNotMatch(result.reply, /想預約哪一天|希望預約什麼時間|先不要當作|我本人|預約成功/);
  assert.equal(result.bookingStatus, 'requested'); assert.equal(result.needsHuman, true);
  assert.equal(result.requestedTime, '週五下午'); assert.match(result.reply, /https:\/\/harrishair\.tw/);
});

test('價格與預約組合不重問已給時段，每則至多一個 emoji', () => {
  for (const question of ['我想約週五下午剪髮，價格多少？', '我想約週五下午染髮，價格多少？']) {
    const result = respond(question, { requestedTime: '週五下午' });
    assert.equal(result.bookingStatus, 'requested'); assert.equal(result.needsHuman, true);
    assert.match(result.reply, /這個時段需由 Harris 確認，請稍等唷/);
    assert.doesNotMatch(result.reply, /想預約哪一天|有沒有希望/);
    assert.ok(emojiCount(result.reply) <= 1);
  }
});

test('一般營業時間採核准時段，不推定每天開店', () => {
  for (const question of ['幾點開門？', '一般營業時間？', '染髮幾點營業？']) {
    const result = respond(question);
    assert.match(result.reply, /11:00[–－-]18:00/);
    assert.match(result.reply, /一般/); assert.doesNotMatch(result.reply, /每天|明天.*開門/);
    assert.equal(result.needsHuman, false); assert.ok(emojiCount(result.reply) <= 1);
  }
});

test('日期及休假問題提供一般時段後仍由 Harris 確認營業日', () => {
  for (const question of ['明天幾點開門？', '今天有營業嗎？', '週日會開店嗎？', '11/1幾點營業？', '每週幾休假？', '每天都有營業嗎？']) {
    const result = respond(question);
    assert.match(result.reply, /11:00[–－-]18:00/);
    assert.match(result.reply, /Harris.*確認/); assert.equal(result.needsHuman, true);
    assert.doesNotMatch(result.reply, /明天.*11.*開|每天.*營業喔/);
    assert.ok(emojiCount(result.reply) <= 1);
  }
});

test('具名節日與未識別日期的營業問題仍交 Harris，不從一般時間推定開店', () => {
  for (const question of ['元旦有營業嗎？', '聖誕節幾點開門？', '店慶當天幾點開門？', '下個月幾點開門？']) {
    const result = respond(question);
    assert.equal(result.needsHuman, true, question);
    assert.match(result.reply, /一般.*11:00[–－-]18:00/);
    assert.match(result.reply, /Harris.*確認/);
    assert.doesNotMatch(result.nextAction, /無需處理/);
  }
});

test('日期營業與預約混合問題保留需求與時段，不被預約分支當已核准營業日', () => {
  const result = respond('我想約明天下午剪髮，明天有營業嗎？', { requestedTime: '明天下午', service: '剪髮' });
  assert.match(result.reply, /一般.*11:00[–－-]18:00/);
  assert.match(result.reply, /Harris.*確認/);
  assert.equal(result.requestedTime, '明天下午'); assert.equal(result.service, '剪髮');
  assert.equal(result.bookingStatus, 'requested'); assert.equal(result.needsHuman, true);
  assert.doesNotMatch(result.reply, /已預約成功|每天|有沒有希望/);
  assert.ok(emojiCount(result.reply) <= 1);
});

test('客人自述預約成功只讓 Harris 核對，不再以店主本人語氣承諾', () => {
  const result = respond('我在平台預約好了');
  assert.equal(result.bookingStatus, 'self_reported'); assert.equal(result.needsHuman, true);
  assert.match(result.reply, /Harris.*確認/); assert.doesNotMatch(result.reply, /我會再確認|我本人/);
});
