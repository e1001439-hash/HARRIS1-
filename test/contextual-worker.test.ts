import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { NotificationWorker } from '../src/notification-worker.js';
import { loadConfig } from '../src/config.js';
import { loadFacts } from '../src/knowledge.js';
import type { AiInput, AiResult, LineEvent } from '../src/types.js';
import type { SemanticFact, SemanticReview, VerificationInput } from '../src/reply-guard.js';
import { createTestDatabase } from './database.js';

const owner = `U${'1'.repeat(32)}`, customer = `U${'2'.repeat(32)}`, other = `U${'3'.repeat(32)}`;
const facts = await loadFacts('knowledge/facts.json');
const base: AiResult = { reply: '好喔。', summary: '', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '' };
type Draft = string | Partial<AiResult> | Error;
interface ReviewFixture { facts: SemanticFact[]; questions?: string[] }
interface Observation {
  messages: { id: string; customer: string; text: string }[];
  replies: { token: string; text: string }[];
  notices: { owner: string; text: string; retryKey: string }[];
  mockDrafts: { text: string; draft: string | null; failed: boolean; manuallyAuthored: true }[];
  mockReviews: { text: string; candidate: string; report: SemanticReview; manuallyAuthored: true }[];
  outcomes: { id: string; replySource: AiResult['replySource'] | null }[];
}
const transcripts: { scenario: string; externalServices: 'fake LINE and fake AI generation and fake semantic review'; observation: Observation }[] = [];
const colourDraft = '胸上屬於 L 的染髮長度，新客折後是{{price_new}}元，會員則是{{price_member}}元喔 😊';
const newDraft = '第一次來的話，這個髮長染髮折後就是{{price_new}}元，不需要再算一次折扣囉 😊';
const memberDraft = '會員這個長度的折後費用是{{price_member}}元，表上已經折好了喔 😊';
const fact = (kind: SemanticFact['kind'], value: string, patch: Partial<SemanticFact> = {}): SemanticFact => ({ kind, service: null, length: null, audience: null, value, polarity: 'affirmed', ...patch });
const price = (service: string, length: string | null, audience: string | null, value: string) => fact('price', value, { service, length, audience });
const pair = (service: string, length: string, newPrice: string, memberPrice: string): ReviewFixture => ({ facts: [price(service, length, 'new', newPrice), price(service, length, 'member', memberPrice), fact('price_basis', 'already_discounted')] });
const tier = (service: string, length: string, audience: string, value: string): ReviewFixture => ({ facts: [price(service, length, audience, value), fact('price_basis', 'already_discounted')] });
function observe(): Observation { return { messages: [], replies: [], notices: [], mockDrafts: [], mockReviews: [], outcomes: [] }; }

// Every semantic fixture below is manually specified, separately from the
// production contract. The fake reviewer does not infer real-language truth.
async function fixture(drafts: Record<string, Draft>, reports: Record<string, ReviewFixture>, observation = observe(), folder?: string) {
  const db = await createTestDatabase(folder), store = new Store(db);
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/test', LINE_CHANNEL_SECRET: 'fake', LINE_CHANNEL_ACCESS_TOKEN: 'fake', OWNER_LINE_USER_ID: owner, TEST_LINE_USER_IDS: `${customer},${other}`, RESPONSE_MODE: 'ai', SALON_AI_API_KEY: 'fake', AI_MODEL: 'fake' });
  const line = {
    async reply(token: string, text: string) { observation.replies.push({ token, text }); },
    async push(to: string, text: string, retryKey: string) { observation.notices.push({ owner: to, text, retryKey }); },
  };
  const ai = {
    async generate(input: AiInput): Promise<AiResult> {
      const draft = drafts[input.text];
      assert.notEqual(draft, undefined, `fake AI fixture missing for ${input.text}`);
      if (draft instanceof Error) { observation.mockDrafts.push({ text: input.text, draft: null, failed: true, manuallyAuthored: true }); throw draft; }
      const answer = typeof draft === 'string' ? { ...base, reply: draft } : { ...base, ...draft };
      observation.mockDrafts.push({ text: input.text, draft: answer.reply, failed: false, manuallyAuthored: true });
      return answer;
    },
    async verify(input: VerificationInput): Promise<SemanticReview> {
      const expected = reports[input.text];
      assert.ok(expected, `fake semantic fixture missing for ${input.text}`);
      const report: SemanticReview = { verdict: 'supported', complete: true,
        facts: expected.facts.map(value => ({ ...value, evidence: input.candidate })),
        questions: (expected.questions ?? []).map(slot => ({ slot, evidence: input.candidate })),
        actions: [], persona: 'assistant', issues: [] };
      observation.mockReviews.push({ text: input.text, candidate: input.candidate, report, manuallyAuthored: true });
      return report;
    },
  };
  const worker = new Worker({ store, config, line, ai, facts, knowledge: '僅用已核准價格與本客人上下文。', lane: 'customer' });
  const notifier = new NotificationWorker({ store, config, line });
  let counter = 0;
  const receivedBase = Date.now() - 1000;
  const events = new Map<string, LineEvent>();
  return {
    db, store, worker, notifier, observation,
    reply(id: string) { return observation.replies.find(item => item.token === id)?.text; },
    source(id: string) { return observation.outcomes.find(item => item.id === id)?.replySource; },
    async send(id: string, text: string, userId = customer, timestamp = receivedBase + counter++ * 10) {
      const event = events.get(id) ?? { type: 'message', webhookEventId: id, timestamp, replyToken: id, source: { type: 'user', userId }, message: { type: 'text', text } };
      events.set(id, event); observation.messages.push({ id, customer: userId, text });
      await store.ingest([event], owner); await worker.tick();
      const outcome = (await db.query<{ outcome: AiResult | null }>('SELECT outcome FROM events WHERE id=$1', [id])).rows[0]?.outcome;
      observation.outcomes.push({ id, replySource: outcome?.replySource ?? null });
      let remaining = 30;
      while (await notifier.tick()) assert.ok(--remaining > 0, 'finite notification outbox should drain');
      assert.ok(observation.notices.every(notice => notice.owner === owner));
    },
    async close() { worker.stop(); notifier.stop(); await db.close(); },
  };
}
function record(scenario: string, observation: Observation) {
  transcripts.push({ scenario, externalServices: 'fake LINE and fake AI generation and fake semantic review', observation: structuredClone(observation) });
  for (const reply of observation.replies) assert.doesNotMatch(reply.text, /已(?:幫你)?(?:備註|通知)|已(?:幫你)?預約成功|已保留/);
}
after(async () => {
  const path = process.env.HARRIS_DIALOGUE_ARTIFACT;
  if (!path) return;
  const artifact = resolve(path);
  assert.ok(artifact.startsWith('/tmp/'), 'mock transcript artifact belongs in /tmp');
  await writeFile(artifact, `${JSON.stringify({ note: '實際本地Worker輸出；生成草稿與語意核驗報告都是分開人工指定的mock，LINE亦為假實作，不能代表真實模型自然度或核驗準確率。', transcripts }, null, 2)}\n`);
});

test('多輪胸上染價、新客、重啟後時段接續；人工接手後三點只通知店主', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harris-natural-contextual-'));
  const drafts: Record<string, Draft> = {
    '胸上染髮多少？': colourDraft,
    '我是新客': newDraft,
    '週六兩點呢？': '你想約的是{{requested_time}}染髮，{{pending}} 😊',
    '三點也可以': { reply: '人工接手中', service: '染髮', requestedTime: '三點', bookingStatus: 'requested', needsHuman: true },
  };
  const reports: Record<string, ReviewFixture> = {
    '胸上染髮多少？': pair('染髮', 'L', '2780', '2910'),
    '我是新客': tier('染髮', 'L', 'new', '2780'),
    '週六兩點呢？': { facts: [fact('booking_time', '週六兩點'), fact('service', '染髮'), fact('requires_harris', 'booking')] },
  };
  let f = await fixture(drafts, reports, observe(), join(directory, 'db'));
  try {
    await f.send('colour-length', '胸上染髮多少？');
    const first = f.reply('colour-length')!;
    assert.match(first, /Harris 的訊息小幫手.*AI/s);
    assert.match(first, /胸上屬於 L 的染髮長度/); assert.match(first, /2,?780/); assert.match(first, /2,?910/);
    assert.doesNotMatch(first, /https?:|下方選單|想預約哪一天|希望預約/);
    assert.equal(f.source('colour-length'), 'natural_verified');
    assert.equal((await f.store.getSession(customer)).handoff, false);
    await f.send('colour-new', '我是新客');
    const second = f.reply('colour-new')!;
    assert.equal(second, '第一次來的話，這個髮長染髮折後就是2,780元，不需要再算一次折扣囉 😊');
    assert.doesNotMatch(second, /2,?910|AI|訊息小幫手|下方選單|https?:/);
    assert.equal(f.source('colour-new'), 'natural_verified');
    assert.equal((await f.store.getSession(customer)).handoff, false);
    const observation = f.observation;
    await f.close(); f = await fixture(drafts, reports, observation, join(directory, 'db'));
    await f.send('colour-time', '週六兩點呢？');
    const third = f.reply('colour-time')!;
    assert.match(third, /週六兩點/); assert.match(third, /Harris.*確認/);
    assert.doesNotMatch(third, /2,?780|2,?910|AI|訊息小幫手|https?:/);
    assert.equal(f.source('colour-time'), 'natural_verified');
    assert.equal((await f.store.getSession(customer)).handoff, true);
    const requested = (await f.store.listTasks()).find(task => task.summary.includes('週六兩點'))!;
    assert.equal(requested.service, '染髮'); assert.equal(requested.bookingStatus, 'requested');
    await f.send('colour-later', '三點也可以');
    assert.equal(f.reply('colour-later'), undefined);
    const updated = (await f.store.listTasks()).find(task => task.summary.includes('三點也可以'))!;
    assert.equal(updated.service, '染髮'); assert.equal(updated.bookingStatus, 'requested'); assert.match(updated.requestedTime!, /三點/);
    assert.ok(f.observation.notices.some(notice => /三點/.test(notice.text) && /項目：染髮/.test(notice.text)));
    assert.ok(f.observation.mockReviews.every(value => value.text !== '三點也可以'));
    assert.equal((await f.store.getSession(customer)).handoff, true);
    record('自然報價→新客→重啟→首次時段→接手後修改', f.observation);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('項目與長度更正使用新價、承接會員、謝謝自然收尾，剪髮仍獨立700', async () => {
  const f = await fixture({
    '胸上染髮多少？': colourDraft,
    '不是染髮，改燙髮，長度肩上': '那以肩上的燙髮來看，新客是{{price_new}}元，會員是{{price_member}}元，這些都是折後價。',
    '我是會員': memberDraft,
    '謝謝': '不會啦，有想到其他問題再問我就好 😊',
    '那改成剪髮呢？': '改剪髮的話，費用就是{{price}}元喔 😊',
  }, {
    '胸上染髮多少？': pair('染髮', 'L', '2780', '2910'),
    '不是染髮，改燙髮，長度肩上': pair('燙髮', 'M', '2800', '2975'),
    '我是會員': tier('燙髮', 'M', 'member', '2975'),
    '謝謝': { facts: [] },
    '那改成剪髮呢？': { facts: [price('剪髮', null, null, '700')] },
  });
  try {
    await f.send('before-correction', '胸上染髮多少？');
    await f.send('correction', '不是染髮，改燙髮，長度肩上');
    assert.match(f.reply('correction')!, /2,?800/); assert.match(f.reply('correction')!, /2,?975/);
    assert.doesNotMatch(f.reply('correction')!, /2,?780|2,?910|https?:|下方選單/); assert.equal(f.source('correction'), 'natural_verified');
    await f.send('membership', '我是會員');
    assert.match(f.reply('membership')!, /2,?975/); assert.doesNotMatch(f.reply('membership')!, /2,?800|2,?780|2,?910/);
    assert.equal(f.source('membership'), 'natural_verified');
    await f.send('thanks', '謝謝');
    assert.equal(f.reply('thanks'), '不會啦，有想到其他問題再問我就好 😊'); assert.doesNotMatch(f.reply('thanks')!, /\d|預約|下方選單|https?:/);
    assert.equal(f.source('thanks'), 'natural_verified');
    await f.send('haircut', '那改成剪髮呢？');
    assert.equal(f.reply('haircut'), '改剪髮的話，費用就是700元喔 😊');
    assert.doesNotMatch(f.reply('haircut')!, /560|595|2,?975|希望預約|哪一天|那就是剪髮是/);
    assert.equal(f.source('haircut'), 'natural_verified'); assert.equal((await f.store.getSession(customer)).handoff, false);
    record('更正項目與長度→會員→自然謝謝→剪髮完整句', f.observation);
  } finally { await f.close(); }
});

test('不同客人不共用長度與項目；新客身分與後續報價各自承接', async () => {
  const f = await fixture({
    '胸上染髮多少？': colourDraft,
    '我是新客': '可以先跟我說想了解哪個服務嗎？',
    '我想問胸下染髮多少？': '如果是第一次來，胸下染髮的折後費用是{{price_new}}元喔 😊',
    '我是會員': memberDraft,
  }, {
    '胸上染髮多少？': pair('染髮', 'L', '2780', '2910'),
    '我是新客': { facts: [], questions: ['service'] },
    '我想問胸下染髮多少？': tier('染髮', 'XL', 'new', '3020'),
    '我是會員': tier('染髮', 'L', 'member', '2910'),
  });
  try {
    await f.send('a-first', '胸上染髮多少？');
    await f.send('b-type-only', '我是新客', other);
    assert.doesNotMatch(f.reply('b-type-only')!, /2,?780|2,?910|胸上/); assert.match(f.reply('b-type-only')!, /哪個服務/);
    assert.equal((await f.store.listTasks()).find(task => task.summary === '我是新客')?.service ?? null, null);
    assert.equal(f.source('b-type-only'), 'natural_verified');
    await f.send('b-own-length', '我想問胸下染髮多少？', other);
    assert.match(f.reply('b-own-length')!, /3,?020/); assert.doesNotMatch(f.reply('b-own-length')!, /2,?780|2,?910|3,?165/);
    await f.send('a-membership', '我是會員');
    assert.match(f.reply('a-membership')!, /2,?910/); assert.doesNotMatch(f.reply('a-membership')!, /3,?020|3,?165/);
    assert.equal((await f.store.getSession(customer)).handoff, false); assert.equal((await f.store.getSession(other)).handoff, false);
    record('不同客人上下文隔離與自然缺項問句', f.observation);
  } finally { await f.close(); }
});

test('晚到舊原文不覆寫新項目與髮長，後續新客只引用最新需求', async () => {
  const f = await fixture({
    '胸上燙髮多少？': '胸上燙髮，新客{{price_new}}元、會員{{price_member}}元，表上列的就是折後價喔。',
    '改成肩上染髮': '那以肩上的染髮來看，新客是{{price_new}}元，會員是{{price_member}}元，這些都是折後價。',
    '胸下燙髮': '不應回覆舊訊息',
    '我是新客': newDraft,
  }, {
    '胸上燙髮多少？': pair('燙髮', 'L', '3200', '3400'),
    '改成肩上染髮': pair('染髮', 'M', '2540', '2655'),
    '我是新客': tier('染髮', 'M', 'new', '2540'),
  });
  try {
    const now = Date.now();
    await f.send('source-first', '胸上燙髮多少？', customer, now - 2000);
    await f.send('source-newer', '改成肩上染髮', customer, now - 1000);
    await f.send('source-old-late', '胸下燙髮', customer, now - 5000); assert.equal(f.reply('source-old-late'), undefined);
    await f.send('source-newest', '我是新客', customer, now);
    assert.match(f.reply('source-newest')!, /2,?540/); assert.doesNotMatch(f.reply('source-newest')!, /3,?600|3,?825|3,?200|3,?400|2,?655/);
    assert.equal(f.source('source-newest'), 'natural_verified'); assert.equal((await f.store.getSession(customer)).handoff, false);
    record('較舊來源訊息晚到不覆蓋最新項目與長度', f.observation);
  } finally { await f.close(); }
});

test('API失敗仍交人工並通知，重送不重複，之後時段只整理給店主', async () => {
  const f = await fixture({
    '胸上染髮多少？': new Error('PRIVATE_FAKE_API_FAILURE'),
    '週六三點呢？': { reply: '人工接手中', service: '染髮', requestedTime: '週六三點', bookingStatus: 'requested', needsHuman: true },
  }, {});
  try {
    await f.send('api-failed', '胸上染髮多少？');
    assert.match(f.reply('api-failed')!, /Harris.*確認/); assert.doesNotMatch(f.reply('api-failed')!, /PRIVATE_FAKE|2,?780|2,?910/);
    assert.equal((await f.store.getSession(customer)).handoff, true); assert.ok(f.observation.notices.some(notice => notice.text.includes('胸上染髮多少')));
    const replies = f.observation.replies.length, notices = f.observation.notices.length, tasks = (await f.store.listTasks()).length;
    await f.send('api-failed', '胸上染髮多少？');
    assert.equal(f.observation.replies.length, replies); assert.equal(f.observation.notices.length, notices); assert.equal((await f.store.listTasks()).length, tasks);
    await f.send('api-followup', '週六三點呢？'); assert.equal(f.reply('api-followup'), undefined);
    assert.ok(f.observation.notices.some(notice => /期望時間：週六三點/.test(notice.text) && /項目：染髮/.test(notice.text)));
    assert.equal((await f.store.getSession(customer)).handoff, true); assert.equal(f.observation.mockReviews.length, 0);
    record('API失敗→重送去重→人工接手後續訊', f.observation);
  } finally { await f.close(); }
});
