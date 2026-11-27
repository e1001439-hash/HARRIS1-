import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { DeliveryError } from '../src/clients/line.js';
import { decideQuickReply, loadQuickReplies } from '../src/quick-replies.js';
import { createTestDatabase } from './database.js';
import type { LineEvent } from '../src/types.js';

const owner = `U${'1'.repeat(32)}`, customer = `U${'2'.repeat(32)}`;
const rules = await loadQuickReplies('knowledge/quick-replies.json');
const msg = (id: string, text: string, ageMs = 0): LineEvent => ({ type: 'message', webhookEventId: id, timestamp: Date.now() - ageMs, replyToken: `rt-${id}`, source: { type: 'user', userId: customer }, message: { type: 'text', text } });
const decide = (text: string, prices = false) => decideQuickReply(rules, msg('x', text), { prices, skipStickers: true });

test('simple questions get the fixed answer id', () => {
  const cases: Record<string, string> = {
    '地址在哪？': 'address', '請問店在哪裡': 'address', '公休是哪天': 'closed', '你們哪天休': 'closed', '營業時間？': 'hours', '開到幾點': 'hours',
    '怎麼預約': 'booking', '預約連結給我': 'booking', '燙髮要多久': 'perm-time', '補染最晚幾點': 'root-dye-time', '補染要多久？': 'root-dye-time',
    '燙髮要多少時間': 'perm-time',
  };
  for (const [text, id] of Object.entries(cases)) { const d = decide(text); assert.equal(d?.kind, 'reply', text); assert.equal(d?.kind === 'reply' && d.id, id, text); }
});
test('price answers exist only when QUICK_REPLY_PRICES=true', () => {
  const cases: Record<string, string> = { '剪髮多少': 'price-cut', '燙髮價格？': 'price-perm', '染髮多少錢': 'price-dye', '補染多少': 'price-root-dye', '護髮怎麼算': 'price-treatment' };
  for (const [text, id] of Object.entries(cases)) { const d = decide(text, true); assert.equal(d?.kind === 'reply' && d.id, id, text); }
});
test('default: every price question is relayed, even mixed with a simple question', () => {
  for (const text of ['剪髮多少', '剪髮多少錢', '燙髮價格？', '染髮價位', '補染多少', '護髮怎麼算', '燙髮要多久多少錢', '地址在哪？剪髮多少', '營業時間跟價格', '剪頭髮700元嗎', '收費方式']) assert.equal(decide(text), null, text);
});
test('judgement, dates, slots, combos, bangs and long messages are relayed (null)', () => {
  for (const text of ['明天下午可以約嗎', '12/5 還有空位嗎', '禮拜六有開嗎', '我想改時間', '我會晚到10分鐘', '燙加染多少', '燙染多少錢', '剪髮跟護髮多少', '修瀏海多少', '漂髮多少',
    '壽星燙髮有折扣嗎', '我頭髮很受損可以燙嗎', '你好', '謝謝', '我想預約', '預約', '我之前燙的捲度掉很快想問一下要怎麼處理比較好呢因為快拍畢業照了', '這個髮型適合我嗎']) assert.equal(decide(text), null, text);
});
test('menu keywords and lone stickers are skipped; price answers can be switched off', () => {
  for (const text of ['休假', '價目表', ' 項目表 ']) assert.deepEqual(decide(text), { kind: 'skip', reason: 'menu_keyword' });
  assert.deepEqual(decideQuickReply(rules, { ...msg('s', ''), message: { type: 'sticker' } }, { prices: true, skipStickers: true }), { kind: 'skip', reason: 'sticker' });
  assert.equal(decideQuickReply(rules, { ...msg('s', ''), message: { type: 'sticker' } }, { prices: true, skipStickers: false }), null);
  assert.equal(decide('剪髮多少'), null);
  assert.equal(decide('地址在哪')?.kind, 'reply');
});
test('fixed texts carry the site-config prices and Harris rules', () => {
  const text = (id: string) => rules.entries.find(e => e.id === id)!.text;
  assert.match(text('price-cut'), /700/); assert.match(text('price-perm'), /3825/); assert.match(text('price-dye'), /2655/);
  assert.match(text('perm-time'), /4 小時/); assert.match(text('root-dye-time'), /17點/); assert.doesNotMatch(text('root-dye-time'), /16點/); assert.match(text('booking'), /https:\/\/harrishair\.tw\//);
  for (const e of rules.entries) assert.doesNotMatch(e.text, /AI|助理|機器人|已預約成功/);
});
test('hybrid config requires relay settings and forces owner notices off', () => {
  const env = { DATABASE_URL: 'x', LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_LINE_USER_ID: owner, BOT_MODE: 'live', CUSTOMER_REPLY_MODE: 'hybrid' };
  assert.throws(() => loadConfig(env), /RELAY_URL|CONFIG/);
  const config = loadConfig({ ...env, RELAY_URL: 'https://relay.example/hook', RELAY_SECRET: 'x'.repeat(20), OWNER_LINE_NOTIFY: 'true', OWNER_NOTIFY_ENABLED: 'true' });
  assert.equal(config.ownerLineNotify, false); assert.equal(config.ownerNotifyEnabled, false); assert.equal(config.quickReplyPrices, false); assert.equal(config.relaySkipStickers, true);
});

async function fixture(replyFail?: DeliveryError) {
  const received: any[] = [];
  const server = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { received.push({ headers: req.headers, body: JSON.parse(b) }); res.end('{}'); }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const db = await createTestDatabase(); const store = new Store(db);
  const config = loadConfig({ DATABASE_URL: 'local', LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_LINE_USER_ID: owner, BOT_MODE: 'live',
    CUSTOMER_REPLY_MODE: 'hybrid', RELAY_URL: 'https://relay.example/hook', RELAY_SECRET: 'x'.repeat(20) });
  config.relayUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`; // local fake only
  const replies: string[] = [], pushes: string[] = [];
  const worker = new Worker({ store, config, knowledge: '', quickReplies: rules, ai: { async generate() { throw new Error('no ai'); } },
    line: { async reply(_t, text) { if (replyFail) throw replyFail; replies.push(text); }, async push(to) { pushes.push(to); }, async profile() { return { displayName: '小美' }; } } });
  const run = async (event: LineEvent) => { await store.ingest([event], owner); await worker.tick(); };
  return { received, replies, pushes, run, store, close: async () => { await db.close(); server.close(); } };
}
test('worker: simple question answered by reply token only; menu keyword does nothing; rest relayed with recent context', async () => {
  const f = await fixture();
  try {
    await f.run(msg('a', '地址在哪？'));
    assert.equal(f.replies.length, 1); assert.match(f.replies[0]!, /明華一路177號/); assert.equal(f.received.length, 0);
    await f.run(msg('b', '價目表'));
    assert.equal(f.replies.length, 1); assert.equal(f.received.length, 0);
    await f.run(msg('c', '明天下午三點可以約燙髮嗎'));
    assert.equal(f.replies.length, 1); assert.equal(f.received.length, 1);
    const body = f.received[0].body;
    assert.equal(body.mode, 'hybrid'); assert.equal(body.event.message.text, '明天下午三點可以約燙髮嗎'); assert.equal(body.displayName, '小美');
    assert.ok(body.recent.some((t: any) => t.role === 'assistant' && /明華一路/.test(t.content)));
    assert.equal(f.received[0].headers['idempotency-key'], 'c');
    assert.deepEqual(f.pushes, []);
    assert.equal((await f.store.listTasks()).filter((t: any) => t.status === 'open').length, 1);
  } finally { await f.close(); }
});
test('worker: photo/video relayed with hasPhoto flag, nothing replied or pushed; price question relayed', async () => {
  const f = await fixture();
  try {
    await f.run({ ...msg('img', ''), message: { type: 'image', id: '777' } });
    await f.run({ ...msg('vid', ''), message: { type: 'video', id: '778' } });
    await f.run(msg('price', '剪髮多少錢'));
    assert.equal(f.received.length, 3); assert.deepEqual(f.replies, []); assert.deepEqual(f.pushes, []);
    for (const r of f.received.slice(0, 2)) { assert.equal(r.body.hasPhoto, true); assert.equal(r.body.note, '有照片，留給 Harris'); }
    assert.equal(f.received[2].body.hasPhoto, undefined); assert.equal(f.received[2].body.event.message.text, '剪髮多少錢');
  } finally { await f.close(); }
});
test('worker: expired reply token or failed fixed reply falls back to relay, never push', async () => {
  const f = await fixture(new DeliveryError('failed'));
  try {
    await f.run(msg('old', '營業時間？', 120000));
    assert.equal(f.received.length, 1); assert.equal(f.received[0].body.quickReplyAttempt, undefined);
    await f.run(msg('fail', '營業時間？'));
    assert.equal(f.received.length, 2); assert.deepEqual(f.received[1].body.quickReplyAttempt.delivery, 'failed');
    assert.deepEqual(f.pushes, []);
  } finally { await f.close(); }
});
