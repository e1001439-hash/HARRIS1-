import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startRuntime } from '../src/runtime.js';
import { loadConfig } from '../src/config.js';
import { createTestDatabase } from './database.js';
import type { LineEvent } from '../src/types.js';

test('relay mode forwards customer events with secret header and never auto-replies', async () => {
  const received: { headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { received.push({ headers: req.headers, body: JSON.parse(b) }); res.end('{}'); }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const db = await createTestDatabase();
  const owner = `U${'1'.repeat(32)}`, customer = `U${'2'.repeat(32)}`;
  const config = loadConfig({ DATABASE_URL: 'local', LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', OWNER_LINE_USER_ID: owner, BOT_MODE: 'live',
    CUSTOMER_REPLY_MODE: 'relay', RELAY_URL: 'https://relay.example/hook', RELAY_SECRET: 'x'.repeat(20), RELAY_SECRET_HEADER: 'x-grok-secret', OWNER_LINE_NOTIFY: 'false' });
  config.port = 0; config.relayUrl = `http://127.0.0.1:${port}/hook`; // local fake only
  const replies: string[] = [], pushes: string[] = [];
  const runtime = await startRuntime({ db, config, knowledge: '', host: '127.0.0.1', ai: { async generate() { throw new Error('no ai'); } },
    line: { async reply(t) { replies.push(t); }, async push(to) { pushes.push(to); }, async profile() { return { displayName: '小美' }; } } });
  const event: LineEvent = { type: 'message', webhookEventId: 'evt-img', timestamp: Date.now(), replyToken: 'rt', source: { type: 'user', userId: customer }, message: { type: 'image', id: '5555' } };
  try {
    await runtime.store.ingest([event], owner);
    for (let i = 0; i < 80 && !received.length; i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(received.length, 1);
    assert.equal(received[0]!.headers['x-grok-secret'], 'x'.repeat(20));
    assert.equal(received[0]!.body.displayName, '小美');
    assert.equal(received[0]!.body.event.message.id, '5555');
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(replies, []); assert.deepEqual(pushes, []);
  } finally { await runtime.close(); server.close(); }
});
