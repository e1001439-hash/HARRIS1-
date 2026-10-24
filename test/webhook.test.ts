import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const owner = `U${'1'.repeat(32)}`;
const customer = `U${'2'.repeat(32)}`;
const stranger = `U${'3'.repeat(32)}`;
const config = loadConfig({ DATABASE_URL: 'postgres://localhost/test', LINE_CHANNEL_SECRET: 'test-secret', LINE_CHANNEL_ACCESS_TOKEN: 'test-token', OWNER_LINE_USER_ID: owner, TEST_LINE_USER_IDS: customer });
const event = (userId = customer, sourceType = 'user') => ({ type: 'message', webhookEventId: 'event-1', timestamp: Date.now(), replyToken: 'reply-token', source: { type: sourceType, userId }, message: { type: 'text', text: '剪髮怎麼預約？' } });
function setup(fail = false) {
  const saved: unknown[][] = [];
  const app = createApp({ config, store: { async ingest(events: unknown[]) { if (fail) throw new Error('private database error'); saved.push(events); }, async ping() { if (fail) throw new Error('private'); } } });
  const send = (body: string, signature = createHmac('sha256', 'test-secret').update(body).digest('base64')) => app.inject({ method: 'POST', url: '/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-line-signature': signature } });
  return { app, saved, send };
}

test('invalid signature never persists or invokes customer workflow', async () => {
  const { app, saved, send } = setup();
  assert.equal((await send(JSON.stringify({ events: [event()] }), 'invalid')).statusCode, 401);
  assert.equal(saved.length, 0); await app.close();
});
test('signed malformed JSON is rejected; empty LINE verification succeeds', async () => {
  const { app, send, saved } = setup();
  assert.equal((await send('{')).statusCode, 400);
  assert.equal((await send(JSON.stringify({ events: [] }))).statusCode, 200);
  assert.equal(saved.length, 0); await app.close();
});
test('only direct test customer and configured owner accepted; groups and others ignored', async () => {
  const { app, send, saved } = setup();
  const events = [event(customer), { ...event(owner), webhookEventId: 'owner-1' }, { ...event(stranger), webhookEventId: 'other-1' }, { ...event(customer, 'group'), webhookEventId: 'group-1' }];
  assert.equal((await send(JSON.stringify({ events }))).statusCode, 200);
  assert.equal(saved[0]?.length, 2); await app.close();
});
test('acknowledges only after persistence and hides internal failures', async () => {
  const { app, send } = setup(true);
  const response = await send(JSON.stringify({ events: [event()] }));
  assert.equal(response.statusCode, 503);
  assert.ok(!response.body.includes('private'));
  assert.equal((await app.inject('/readyz')).statusCode, 503);
  assert.equal((await app.inject('/healthz')).statusCode, 200); await app.close();
});
test('missing event identity or text rejects batch instead of accepting untrackable messages', async () => {
  const { app, send, saved } = setup();
  assert.equal((await send(JSON.stringify({ events: [{ ...event(), webhookEventId: undefined }] }))).statusCode, 400);
  assert.equal((await send(JSON.stringify({ events: [{ ...event(), message: { type: 'text' } }] }))).statusCode, 400);
  assert.equal(saved.length, 0); await app.close();
});
