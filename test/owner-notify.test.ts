import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { HttpLineClient } from '../src/clients/line.js';
import { loadConfig } from '../src/config.js';
import { startRuntime } from '../src/runtime.js';
import { createTestDatabase } from './database.js';

const owner = `U${'1'.repeat(32)}`;
const customer = `U${'2'.repeat(32)}`;
const channelSecret = 'test-line-channel-secret';
const lineToken = 'line-access-token-do-not-log';
const sendSecret = 's'.repeat(40);
const relaySecret = 'r'.repeat(24);

function relayEnv(extra: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'local', LINE_CHANNEL_SECRET: channelSecret, LINE_CHANNEL_ACCESS_TOKEN: lineToken,
    OWNER_LINE_USER_ID: owner, BOT_MODE: 'live', CUSTOMER_REPLY_MODE: 'relay',
    RELAY_URL: 'https://relay.example/hook', RELAY_SECRET: relaySecret, RELAY_SECRET_HEADER: 'x-grok-secret',
    SEND_API_SECRET: sendSecret, POLL_IDLE_MS: '100', ...extra,
  };
}

async function until(condition: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(message);
}

async function listen() {
  const received: { headers: Record<string, string | string[] | undefined>; body: { userId?: string } }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => { received.push({ headers: req.headers, body: JSON.parse(raw) as { userId?: string } }); res.end('{}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as { port: number }).port, received };
}

test('OWNER_NOTIFY_ENABLED defaults off and still forwards, answers /pending, and accepts /send', async () => {
  const hook = await listen();
  const db = await createTestDatabase();
  const config = loadConfig(relayEnv());
  assert.equal(config.ownerNotifyEnabled, false);
  config.port = 0;
  config.relayUrl = `http://127.0.0.1:${hook.port}/hook`;
  const replies: { token: string; text: string }[] = [];
  const pushes: { to: string; text: string }[] = [];
  const runtime = await startRuntime({
    db, config, knowledge: '', host: '127.0.0.1',
    ai: { async generate() { throw new Error('no ai'); } },
    line: {
      async reply(token, text) { replies.push({ token, text }); },
      async push(to, text) { pushes.push({ to, text }); },
      async profile() { return { displayName: '小美' }; },
    },
  });
  const sign = (body: string) => createHmac('sha256', channelSecret).update(body).digest('base64');
  const webhook = (body: string) => runtime.app.inject({ method: 'POST', url: '/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-line-signature': sign(body) } });
  try {
    const customerBody = JSON.stringify({ events: [{ type: 'message', webhookEventId: 'cust-1', timestamp: Date.now(), replyToken: 'reply-cust', source: { type: 'user', userId: customer }, message: { type: 'text', text: '想預約週五剪髮' } }] });
    assert.equal((await webhook(customerBody)).statusCode, 200);
    await until(() => hook.received.length === 1, 'customer event must reach the Grok webhook');
    assert.equal(hook.received[0]!.headers['x-grok-secret'], relaySecret);
    assert.equal(hook.received[0]!.body.userId, customer);

    const ownerBody = JSON.stringify({ events: [{ type: 'message', webhookEventId: 'owner-pending', timestamp: Date.now(), replyToken: 'reply-owner', source: { type: 'user', userId: owner }, message: { type: 'text', text: '/pending' } }] });
    assert.equal((await webhook(ownerBody)).statusCode, 200);
    await until(() => replies.some(reply => reply.token === 'reply-owner' && (/待辦/.test(reply.text) || reply.text.includes('想預約週五剪髮'))), 'owner /pending must still be answered');

    const sent = await runtime.app.inject({ method: 'POST', url: '/send', headers: { authorization: `Bearer ${sendSecret}`, 'content-type': 'application/json' }, payload: JSON.stringify({ to: customer, text: '核准後的回覆' }) });
    assert.equal(sent.statusCode, 200);
    await until(() => pushes.some(push => push.to === customer && push.text === '核准後的回覆'), 'POST /send must still push');
    await until(async () => {
      const rows = await db.query<{ phase: string; status: string }>('SELECT phase, status FROM notifications');
      const phases = new Set(rows.rows.map(row => row.phase));
      return phases.has('receipt') && phases.has('analysis') && rows.rows.every(row => row.status === 'superseded');
    }, 'receipt and analysis must be dropped without a LINE push');
    assert.equal(pushes.filter(push => push.to === owner).length, 0);
    assert.equal(replies.filter(reply => reply.token === 'reply-cust').length, 0);
    assert.equal(hook.received.length, 1);
  } finally { await runtime.close(); hook.server.close(); }
});

test('OWNER_NOTIFY_ENABLED=true pushes both the receipt and the analysis', async () => {
  const hook = await listen();
  const db = await createTestDatabase();
  const config = loadConfig(relayEnv({ OWNER_NOTIFY_ENABLED: 'true' }));
  assert.equal(config.ownerNotifyEnabled, true);
  config.port = 0;
  config.relayUrl = `http://127.0.0.1:${hook.port}/hook`;
  const pushes: { to: string; text: string }[] = [];
  const runtime = await startRuntime({
    db, config, knowledge: '', host: '127.0.0.1',
    ai: { async generate() { throw new Error('no ai'); } },
    line: { async reply() {}, async push(to, text) { pushes.push({ to, text }); }, async profile() { return { displayName: '小美' }; } },
  });
  const body = JSON.stringify({ events: [{ type: 'message', webhookEventId: 'cust-on', timestamp: Date.now(), replyToken: 'reply-on', source: { type: 'user', userId: customer }, message: { type: 'text', text: '想預約週五剪髮' } }] });
  const signature = createHmac('sha256', channelSecret).update(body).digest('base64');
  try {
    assert.equal((await runtime.app.inject({ method: 'POST', url: '/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-line-signature': signature } })).statusCode, 200);
    await until(() => pushes.some(push => push.to === owner && push.text.includes('收到客人訊息')) && pushes.some(push => push.to === owner && push.text.includes('需求整理更新')), 'both owner notifications must be pushed');
  } finally { await runtime.close(); hook.server.close(); }
});

test('POST /send logs LINE status and error body without tokens or secrets', async () => {
  const lineBody = JSON.stringify({ message: 'You have reached your monthly limit.', access: lineToken, authorization: `Bearer ${lineToken}` });
  const line = new HttpLineClient(lineToken, async () => new Response(lineBody, { status: 429 }));
  const config = loadConfig(relayEnv());
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  const app = createApp({ config, store: { async ingest() {}, async ping() {} }, line });
  try {
    const denied = await app.inject({ method: 'POST', url: '/send', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ to: customer, text: 'nope' }) });
    assert.equal(denied.statusCode, 401);
    assert.equal(logs.length, 0);
    const failed = await app.inject({
      method: 'POST', url: '/send',
      headers: { authorization: `Bearer ${sendSecret}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ to: customer, text: '核准後的回覆' }),
    });
    assert.equal(failed.statusCode, 502);
    assert.equal(JSON.stringify(failed.json()).includes('monthly'), false);
    const logged = logs.join('\n');
    const failure = JSON.parse(logs.find(line => line.includes('line_push_failed'))!) as { event: string; status: number | null; body: string | null };
    assert.equal(failure.event, 'line_push_failed');
    assert.equal(failure.status, 429);
    assert.match(failure.body ?? '', /monthly limit/);
    assert.equal(logged.includes(lineToken), false);
    assert.equal(logged.includes(sendSecret), false);
    assert.equal(logged.includes(channelSecret), false);
    assert.equal(logged.includes(relaySecret), false);
    assert.equal(logged.includes('核准後的回覆'), false);
  } finally { console.error = original; await app.close(); }
});

test('POST /send logs a non-LINE push failure without the thrown error text', async () => {
  const config = loadConfig(relayEnv());
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  const app = createApp({
    config, store: { async ingest() {}, async ping() {} },
    line: { async reply() {}, async push() { throw new Error(`socket reset ${lineToken}`); } },
  });
  try {
    const failed = await app.inject({
      method: 'POST', url: '/send',
      headers: { authorization: `Bearer ${sendSecret}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ to: customer, text: 'hello' }),
    });
    assert.equal(failed.statusCode, 502);
    const failure = JSON.parse(logs.find(line => line.includes('line_push_failed'))!) as { status: number | null; body: string | null };
    assert.equal(failure.status, null);
    assert.equal(failure.body, null);
    assert.equal(logs.join('\n').includes(lineToken), false);
    assert.equal(logs.join('\n').includes('socket reset'), false);
  } finally { console.error = original; await app.close(); }
});
