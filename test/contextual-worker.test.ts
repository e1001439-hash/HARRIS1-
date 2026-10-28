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
import { createTestDatabase } from './database.js';

const owner = `U${'1'.repeat(32)}`, customer = `U${'2'.repeat(32)}`, other = `U${'3'.repeat(32)}`;
const facts = await loadFacts('knowledge/facts.json');
const base: AiResult = { reply: '好喔。', summary: '', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '' };
type Draft = string | Partial<AiResult> | Error;
interface Observation {
  messages: { id: string; customer: string; text: string }[];
  replies: { token: string; text: string }[];
  notices: { owner: string; text: string; retryKey: string }[];
}
const transcripts: { scenario: string; externalServices: 'fake LINE and fake AI'; observation: Observation }[] = [];

function observe(): Observation { return { messages: [], replies: [], notices: [] }; }
async function fixture(drafts: Record<string, Draft>, observation = observe(), folder?: string) {
  const db = await createTestDatabase(folder), store = new Store(db);
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/test', LINE_CHANNEL_SECRET: 'fake', LINE_CHANNEL_ACCESS_TOKEN: 'fake', OWNER_LINE_USER_ID: owner, TEST_LINE_USER_IDS: `${customer},${other}`, RESPONSE_MODE: 'ai', SALON_AI_API_KEY: 'fake', AI_MODEL: 'fake' });
  const line = {
    async reply(token: string, text: string) { observation.replies.push({ token, text }); },
    async push(to: string, text: string, retryKey: string) { observation.notices.push({ owner: to, text, retryKey }); },
  };
  const ai = { async generate(input: AiInput): Promise<AiResult> {
    const draft = drafts[input.text];
    if (draft instanceof Error) throw draft;
    assert.notEqual(draft, undefined, `fake AI fixture missing for ${input.text}`);
    return typeof draft === 'string' ? { ...base, reply: draft } : { ...base, ...draft };
  } };
  const worker = new Worker({ store, config, line, ai, facts, knowledge: '僅用已核准價格與本客人上下文。', lane: 'customer' });
  const notifier = new NotificationWorker({ store, config, line });
  let counter = 0;
  const receivedBase = Date.now() - 1000;
  const events = new Map<string, LineEvent>();
  return {
    db, store, worker, notifier, observation,
    reply(id: string) { return observation.replies.find(item => item.token === id)?.text; },
    async send(id: string, text: string, userId = customer, timestamp = receivedBase + counter++ * 10) {
      const event = events.get(id) ?? { type: 'message', webhookEventId: id, timestamp, replyToken: id, source: { type: 'user', userId }, message: { type: 'text', text } };
      events.set(id, event); observation.messages.push({ id, customer: userId, text });
      await store.ingest([event], owner); await worker.tick();
      let remaining = 30;
      while (await notifier.tick()) assert.ok(--remaining > 0, 'finite notification outbox should drain');
      assert.ok(observation.notices.every(notice => notice.owner === owner));
    },
    async close() { worker.stop(); notifier.stop(); await db.close(); },
  };
}
function record(scenario: string, observation: Observation) {
  transcripts.push({ scenario, externalServices: 'fake LINE and fake AI', observation: structuredClone(observation) });
  for (const reply of observation.replies) assert.doesNotMatch(reply.text, /已(?:幫你)?(?:備註|通知)|已(?:幫你)?預約成功|已保留/);
}
after(async () => {
  const path = process.env.HARRIS_DIALOGUE_ARTIFACT;
  if (!path) return;
  const artifact = resolve(path);
  assert.ok(artifact.startsWith('/tmp/'), 'mock transcript artifact belongs in /tmp');
  await writeFile(artifact, `${JSON.stringify({ note: '實際本地 Worker 輸出，LINE 與 AI 為假實作，不能代表真實模型品質。', transcripts }, null, 2)}\n`);
});

test('多輪胸上染價、新客、重啟後時段接續；人工接手後三點只通知店主', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harris-contextual-'));
  const drafts: Record<string, Draft> = {
    '胸上染髮多少？': '了解～{{quote}}，慢慢考慮也可以 😊',
    '我是新客': '那就是{{quote}} 😊',
    '週六兩點呢？': '了解～{{request}}。{{pending}} 😊',
    '三點也可以': { reply: '人工接手中', service: '染髮', requestedTime: '三點', bookingStatus: 'requested', needsHuman: true },
  };
  let f = await fixture(drafts, observe(), join(directory, 'db'));
  try {
    await f.send('colour-length', '胸上染髮多少？');
    const first = f.reply('colour-length')!;
    assert.match(first, /Harris 的訊息小幫手.*AI/s);
    assert.match(first, /了解～/); assert.match(first, /慢慢考慮也可以/);
    assert.match(first, /2,?780/); assert.match(first, /2,?910/);
    assert.doesNotMatch(first, /https?:|下方選單|想預約哪一天|希望預約/);
    assert.equal((await f.store.getSession(customer)).handoff, false);
    await f.send('colour-new', '我是新客');
    const second = f.reply('colour-new')!;
    assert.match(second, /那就是/); assert.match(second, /2,?780/);
    assert.doesNotMatch(second, /2,?910|AI|訊息小幫手|下方選單|https?:/);
    assert.equal((await f.store.getSession(customer)).handoff, false);
    const observation = f.observation;
    await f.close(); f = await fixture(drafts, observation, join(directory, 'db'));
    await f.send('colour-time', '週六兩點呢？');
    const third = f.reply('colour-time')!;
    assert.match(third, /週六兩點/); assert.match(third, /Harris.*確認/);
    assert.doesNotMatch(third, /2,?780|2,?910|AI|訊息小幫手|https?:/);
    assert.equal((await f.store.getSession(customer)).handoff, true);
    const requested = (await f.store.listTasks()).find(task => task.summary.includes('週六兩點'))!;
    assert.equal(requested.service, '染髮'); assert.equal(requested.bookingStatus, 'requested');
    await f.send('colour-later', '三點也可以');
    assert.equal(f.reply('colour-later'), undefined);
    const updated = (await f.store.listTasks()).find(task => task.summary.includes('三點也可以'))!;
    assert.equal(updated.service, '染髮'); assert.equal(updated.bookingStatus, 'requested');
    assert.match(updated.requestedTime!, /三點/);
    assert.ok(f.observation.notices.some(notice => /三點/.test(notice.text) && /項目：染髮/.test(notice.text)));
    assert.equal((await f.store.getSession(customer)).handoff, true);
    record('報價→新客→重啟→首次時段→接手後修改', f.observation);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test('項目與長度更正使用新價、承接會員、謝謝自然收尾，剪髮仍獨立700', async () => {
  const f = await fixture({
    '胸上染髮多少？': '了解～{{quote}}，慢慢考慮也可以 😊',
    '不是染髮，改燙髮，長度肩上': '好～那就是{{quote}} 😊',
    '我是會員': '那就是{{quote}} 😊',
    '謝謝': '不客氣～😊',
    '那改成剪髮呢？': '那就是{{quote}} 😊',
  });
  try {
    await f.send('before-correction', '胸上染髮多少？');
    await f.send('correction', '不是染髮，改燙髮，長度肩上');
    assert.match(f.reply('correction')!, /2,?800/); assert.match(f.reply('correction')!, /2,?975/);
    assert.doesNotMatch(f.reply('correction')!, /2,?780|2,?910|https?:|下方選單/);
    await f.send('membership', '我是會員');
    assert.match(f.reply('membership')!, /2,?975/); assert.doesNotMatch(f.reply('membership')!, /2,?800|2,?780|2,?910/);
    await f.send('thanks', '謝謝');
    assert.match(f.reply('thanks')!, /不客氣/); assert.doesNotMatch(f.reply('thanks')!, /\d|預約|下方選單|https?:/);
    await f.send('haircut', '那改成剪髮呢？');
    assert.match(f.reply('haircut')!, /700/); assert.doesNotMatch(f.reply('haircut')!, /560|595|2,?975|希望預約|哪一天/);
    assert.equal((await f.store.getSession(customer)).handoff, false);
    record('更正項目與長度→會員→謝謝→剪髮', f.observation);
  } finally { await f.close(); }
});

test('不同客人不共用長度與項目；新客身分與後續報價各自承接', async () => {
  const f = await fixture({
    '胸上染髮多少？': '了解～{{quote}}，慢慢考慮也可以 😊',
    '我是新客': '那就是{{quote}} 😊',
    '我想問胸下染髮多少？': '了解～{{quote}} 😊',
    '我是會員': '那就是{{quote}} 😊',
  });
  try {
    await f.send('a-first', '胸上染髮多少？');
    await f.send('b-type-only', '我是新客', other);
    assert.doesNotMatch(f.reply('b-type-only')!, /2,?780|2,?910|胸上/);
    assert.match(f.reply('b-type-only')!, /想問.*剪髮.*染髮/);
    assert.equal((await f.store.listTasks()).find(task => task.summary === '我是新客')?.service ?? null, null);
    await f.send('b-own-length', '我想問胸下染髮多少？', other);
    assert.match(f.reply('b-own-length')!, /3,?020/); assert.doesNotMatch(f.reply('b-own-length')!, /2,?780|2,?910|3,?165/);
    await f.send('a-membership', '我是會員');
    assert.match(f.reply('a-membership')!, /2,?910/); assert.doesNotMatch(f.reply('a-membership')!, /3,?020|3,?165/);
    assert.equal((await f.store.getSession(customer)).handoff, false);
    assert.equal((await f.store.getSession(other)).handoff, false);
    record('不同客人上下文隔離', f.observation);
  } finally { await f.close(); }
});

test('晚到舊原文不覆寫新項目與髮長，後續新客只引用最新需求', async () => {
  const f = await fixture({
    '胸上燙髮多少？': '了解～{{quote}}，慢慢考慮也可以 😊',
    '改成肩上染髮': '好～那就是{{quote}} 😊',
    '胸下燙髮': '不應回覆舊訊息',
    '我是新客': '那就是{{quote}} 😊',
  });
  try {
    const now = Date.now();
    await f.send('source-first', '胸上燙髮多少？', customer, now - 2000);
    await f.send('source-newer', '改成肩上染髮', customer, now - 1000);
    await f.send('source-old-late', '胸下燙髮', customer, now - 5000);
    assert.equal(f.reply('source-old-late'), undefined);
    await f.send('source-newest', '我是新客', customer, now);
    assert.match(f.reply('source-newest')!, /2,?540/);
    assert.doesNotMatch(f.reply('source-newest')!, /3,?600|3,?825|3,?200|3,?400|2,?655/);
    assert.equal((await f.store.getSession(customer)).handoff, false);
    record('較舊來源訊息晚到不覆蓋最新項目與長度', f.observation);
  } finally { await f.close(); }
});

test('API失敗仍交人工並通知，重送不重複，之後時段只整理給店主', async () => {
  const f = await fixture({
    '胸上染髮多少？': new Error('PRIVATE_FAKE_API_FAILURE'),
    '週六三點呢？': { reply: '人工接手中', service: '染髮', requestedTime: '週六三點', bookingStatus: 'requested', needsHuman: true },
  });
  try {
    await f.send('api-failed', '胸上染髮多少？');
    assert.match(f.reply('api-failed')!, /Harris.*確認/);
    assert.doesNotMatch(f.reply('api-failed')!, /PRIVATE_FAKE|2,?780|2,?910/);
    assert.equal((await f.store.getSession(customer)).handoff, true);
    assert.ok(f.observation.notices.some(notice => notice.text.includes('胸上染髮多少')));
    const replies = f.observation.replies.length, notices = f.observation.notices.length;
    const tasks = (await f.store.listTasks()).length;
    await f.send('api-failed', '胸上染髮多少？');
    assert.equal(f.observation.replies.length, replies); assert.equal(f.observation.notices.length, notices);
    assert.equal((await f.store.listTasks()).length, tasks);
    await f.send('api-followup', '週六三點呢？');
    assert.equal(f.reply('api-followup'), undefined);
    assert.ok(f.observation.notices.some(notice => /期望時間：週六三點/.test(notice.text) && /項目：染髮/.test(notice.text)));
    assert.equal((await f.store.getSession(customer)).handoff, true);
    record('API失敗→重送去重→人工接手後續訊', f.observation);
  } finally { await f.close(); }
});
