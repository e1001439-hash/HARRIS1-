import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from '../src/runtime.js';
import { loadConfig } from '../src/config.js';
import { createTestDatabase } from './database.js';
import type { AiResult, LineEvent } from '../src/types.js';

test('real owner take command pauses a customer while their AI request is still in flight', async () => {
  const db = await createTestDatabase();
  const owner = `U${'1'.repeat(32)}`, customer = `U${'2'.repeat(32)}`;
  const config = loadConfig({ DATABASE_URL: 'local', LINE_CHANNEL_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'token', OWNER_LINE_USER_ID: owner, TEST_LINE_USER_IDS: customer, RESPONSE_MODE: 'ai', SALON_AI_API_KEY: 'fake', AI_MODEL: 'fake' }); config.port = 0;
  let started = false; let release!: (value: AiResult) => void;
  const pending = new Promise<AiResult>(resolve => { release = resolve; });
  const replies: string[] = [];
  const runtime = await startRuntime({ db, config, knowledge: '', host: '127.0.0.1', ai: { async generate() { started = true; return pending; } }, line: { async reply(token) { replies.push(token); }, async push() {} } });
  const event = (id: string, userId: string, text: string): LineEvent => ({ type: 'message', webhookEventId: id, timestamp: Date.now(), source: { type: 'user', userId }, replyToken: id, message: { type: 'text', text } });
  try {
    await runtime.store.ingest([event('customer-inflight', customer, '想問服務')]);
    for (let i = 0; i < 80 && !started; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(started, true);
    const session = await runtime.store.getSession(customer);
    await runtime.store.ingest([event('owner-take', owner, `/take ${session.customerRef}`)]);
    let handoff = false;
    for (let i = 0; i < 50 && !handoff; i++) { handoff = (await runtime.store.getSession(customer)).handoff; if (!handoff) await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(handoff, true, 'owner control must not wait behind the AI request');
  } finally {
    release({ reply: '你好', summary: '詢問', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '無需處理' });
    await runtime.close();
  }
  assert.ok(!replies.includes('customer-inflight'), 'in-flight customer reply must be suppressed after owner takeover');
});
