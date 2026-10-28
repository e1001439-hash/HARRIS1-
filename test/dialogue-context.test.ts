import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDialogueContext } from '../src/dialogue-context.js';
import { emptyFacts, loadFacts } from '../src/knowledge.js';
import type { AiInput } from '../src/types.js';

const user = (content: string): AiInput['history'][number] => ({ role: 'user', content });
const assistant = (content: string): AiInput['history'][number] => ({ role: 'assistant', content });

test('胸上染髮後承接新客與本則時段，不從助手文字認定資料', () => {
  const history = [user('胸上染髮多少？'), assistant('你是會員嗎？也可以考慮燙髮。')];
  assert.deepEqual(resolveDialogueContext('我是新客', history), {
    service: '染髮', length: 'L', customerType: 'new', currentTime: null, bookingActive: false, ambiguous: false,
  });
  const booked = resolveDialogueContext('週六兩點呢？', [...history, user('我是新客')]);
  assert.equal(booked.service, '染髮'); assert.equal(booked.length, 'L'); assert.equal(booked.customerType, 'new');
  assert.equal(booked.currentTime, '週六兩點'); assert.equal(booked.bookingActive, true);
});

test('更改長度與服務採最新客人原文，助手報價不會保留舊服務', () => {
  const history = [user('胸上染髮多少？'), user('我是新客'), assistant('L 染髮新客2780元')];
  const changedLength = resolveDialogueContext('改成肩上喔', history);
  assert.equal(changedLength.length, 'M'); assert.equal(changedLength.service, '染髮');
  const changedService = resolveDialogueContext('改燙髮好了', [...history, user('改成肩上喔')]);
  assert.equal(changedService.service, '燙髮'); assert.equal(changedService.length, 'M');
  assert.equal(changedService.customerType, 'new'); assert.equal(changedService.ambiguous, false);
});

test('同一則明確更正只採更正後服務與長度，否定不會被當成肯定', () => {
  const result = resolveDialogueContext('不是胸上染髮，是肩上燙髮', []);
  assert.equal(result.service, '燙髮'); assert.equal(result.length, 'M'); assert.equal(result.ambiguous, false);
  const denied = resolveDialogueContext('不要染髮了', [user('胸上染髮多少？')]);
  assert.equal(denied.service, null); assert.equal(denied.ambiguous, true);
});

test('多個未定選項或矛盾長度保留含混，不以最後出現項目猜答案', () => {
  for (const text of ['染髮或燙髮哪個好？', '肩上還是胸上我不確定', '肩上不是胸上']) {
    const result = resolveDialogueContext(text, [user('胸下染髮多少？')]);
    assert.equal(result.ambiguous, true, text);
  }
  assert.equal(resolveDialogueContext('染髮或燙髮哪個好？', []).service, null);
  assert.equal(resolveDialogueContext('肩上還是胸上我不確定', []).length, null);
});

test('更正為未對應價表的長度或服務不沿用舊報價slot', () => {
  const history = [user('胸上染髮多少？')];
  for (const text of ['改成肩下', '大概胸上左右']) {
    const result = resolveDialogueContext(text, history);
    assert.equal(result.length, null, text); assert.equal(result.ambiguous, true, text);
  }
  const unknown = resolveDialogueContext('那護髮多少？', history);
  assert.equal(unknown.service, null); assert.equal(unknown.ambiguous, true);
});

test('客群否定與多選不猜會員資格，清楚新身分可覆蓋舊身分', () => {
  const history = [user('胸上染髮，我是新客')];
  assert.equal(resolveDialogueContext('我是會員喔', history).customerType, 'member');
  assert.equal(resolveDialogueContext('不是會員', history).customerType, null);
  assert.equal(resolveDialogueContext('新客或會員怎麼分？', []).customerType, null);
  assert.equal(resolveDialogueContext('新客或會員怎麼分？', []).ambiguous, true);
  assert.equal(resolveDialogueContext('我算會員嗎？', history).customerType, null);
});

test('非會員與沒有會員及後置否定不能被當成會員資格', () => {
  const history = [user('胸上染髮，我是新客')];
  for (const text of ['我是非會員', '沒有會員', '會員先不要']) {
    const result = resolveDialogueContext(text, history);
    assert.equal(result.customerType, null, text); assert.equal(result.ambiguous, true, text);
  }
});

test('服務後置否定會清除舊slot，之後明確更正仍可建立新服務', () => {
  const history = [user('胸上染髮多少？'), user('染髮先不要')];
  const result = resolveDialogueContext('我是新客', history);
  assert.equal(result.service, null); assert.equal(result.ambiguous, true);
  const correction = resolveDialogueContext('改燙髮好了', history);
  assert.equal(correction.service, '燙髮'); assert.equal(correction.ambiguous, false);
});

test('客群比較提問不覆蓋已確認身分，只有自我宣稱或直接選擇能更新', () => {
  const history = [user('胸上染髮，我是新客')];
  assert.equal(resolveDialogueContext('會員有比較便宜嗎？', history).customerType, 'new');
  assert.equal(resolveDialogueContext('會員價格多少？', history).customerType, 'new');
  assert.equal(resolveDialogueContext('會員', history).customerType, 'member');
  assert.equal(resolveDialogueContext('我選會員', history).customerType, 'member');
  assert.equal(resolveDialogueContext('我是會員喔', history).customerType, 'member');
  assert.equal(resolveDialogueContext('不是新客，是會員', history).customerType, 'member');
});

test('長度碼與中文價表長度對應一致，XL不能被當成L', () => {
  for (const [text, expected] of [['男髮', 'S'], ['肩上', 'M'], ['胸上', 'L'], ['胸下', 'XL'], ['XL', 'XL'], ['L 長度', 'L']] as const) {
    assert.equal(resolveDialogueContext(text, []).length, expected, text);
  }
  assert.equal(resolveDialogueContext('燙染', []).service, '燙染');
  assert.equal(resolveDialogueContext('染髮和燙髮', []).service, null);
});

test('只有本則原文可成為新時段，既有預約可以延續服務但不複製舊時間', () => {
  const history = [user('胸上染髮多少？'), user('我是新客'), user('週六兩點呢？')];
  const update = resolveDialogueContext('三點也可以', history);
  assert.equal(update.currentTime, '三點'); assert.equal(update.service, '染髮'); assert.equal(update.bookingActive, true);
  const noTime = resolveDialogueContext('謝謝', history);
  assert.equal(noTime.currentTime, null); assert.equal(noTime.bookingActive, true);
  assert.equal(resolveDialogueContext('一般營業時間？', [assistant('你可以約明天下午三點')]).currentTime, null);
});

test('同指日期重複不抹除明確時段，不把營業追問的裸日期當第二選項', () => {
  const result = resolveDialogueContext('我想約明天下午剪髮，明天有營業嗎？', []);
  assert.equal(result.currentTime, '明天下午');
  assert.equal(result.ambiguous, false);
  assert.equal(result.service, '剪髮');
});

test('時段明確更正取新值，未定選項或被否定的時段不作希望時間', () => {
  const history = [user('胸上染髮多少？'), user('週六兩點呢？')];
  const corrected = resolveDialogueContext('不是三點，改成五點', history);
  assert.equal(corrected.currentTime, '五點'); assert.equal(corrected.ambiguous, false);
  for (const text of ['三點還是五點', '不要三點', '明天下午，不要明天']) {
    const result = resolveDialogueContext(text, history);
    assert.equal(result.currentTime, null, text); assert.equal(result.ambiguous, true, text);
  }
});

test('上下文有界且只讀user，新客與價格數字不會被誤認為時段', () => {
  const result = resolveDialogueContext('我是新客', [assistant('胸下燙髮會員約三點')]);
  assert.equal(result.service, null); assert.equal(result.length, null); assert.equal(result.currentTime, null);
  assert.equal(resolveDialogueContext('2780元嗎？', []).currentTime, null);
  const history = [user('胸上染髮'), ...Array.from({ length: 10 }, () => assistant('收到'))];
  assert.equal(resolveDialogueContext('我是新客', history).service, null);
});

test('核准結構化價表保留圖列折後價，L染髮2780與2910及剪髮700', async () => {
  const facts = await loadFacts('knowledge/facts.json');
  assert.equal(facts.haircutPrice, 700);
  assert.equal(facts.priceTable?.length, 12);
  assert.deepEqual(facts.priceTable?.find(row => row.service === '染髮' && row.length === 'L'), {
    service: '染髮', length: 'L', newCustomer: 2780, member: 2910,
  });
  assert.deepEqual(facts.priceTable?.find(row => row.service === '燙髮' && row.length === 'XL'), {
    service: '燙髮', length: 'XL', newCustomer: 3600, member: 3825,
  });
  assert.deepEqual(facts.priceTable?.find(row => row.service === '燙染' && row.length === 'S'), {
    service: '燙染', length: 'S', newCustomer: 3840, member: 4080,
  });
});

test('舊facts無數字價表仍兼容；損壞價格不能成為核准lookup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harris-prices-'));
  try {
    const path = join(directory, 'facts.json');
    await writeFile(path, JSON.stringify(emptyFacts()));
    assert.equal((await loadFacts(path)).approved, false);
    const original = JSON.parse(await readFile('knowledge/facts.json', 'utf8'));
    await writeFile(path, JSON.stringify({ ...original, priceTable: [{ service: '染髮', length: 'L', newCustomer: -1, member: 2910 }] }));
    await assert.rejects(() => loadFacts(path));
    await writeFile(path, JSON.stringify({ ...original, priceTable: [
      { service: '染髮', length: 'L', newCustomer: 2780, member: 2910 },
      { service: '染髮', length: 'L', newCustomer: 1, member: 2 },
    ] }));
    await assert.rejects(() => loadFacts(path), '同項目長度不能同時存在兩組相衝價格');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
