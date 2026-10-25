import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { startRuntime } from '../src/runtime.js';
import { createTestDatabase } from './database.js';

const owner = `U${'1'.repeat(32)}`, tester = `U${'2'.repeat(32)}`, stranger = `U${'3'.repeat(32)}`;
const settings = { DATABASE_URL: 'local-test-only', LINE_CHANNEL_SECRET: 'fake-pairing-secret', LINE_CHANNEL_ACCESS_TOKEN: 'fake-token', OWNER_LINE_USER_ID: owner, TEST_LINE_USER_IDS: '', SALON_AI_API_KEY: '', AI_MODEL: '' };
async function until(condition: () => Promise<boolean> | boolean, message: string) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail(message);
}
async function fixture(dataDir?: string, extras: Record<string, string> = {}) {
  // Same config loader as main.ts: this must boot with no tester or AI key.
  const config = loadConfig({ ...settings, ...extras }); config.port = 0;
  const db = await createTestDatabase(dataDir); const replies: { token: string; text: string }[] = [], pushes: string[] = [];
  let aiCalls = 0;
  const runtime = await startRuntime({ db, config, host: '127.0.0.1', knowledge: '', ai: { async generate() { aiCalls++; throw new Error('AI must stay off in fixed mode'); } }, line: { async reply(token, text) { replies.push({ token, text }); }, async push(_to, text) { pushes.push(text); } } });
  const done = async (id: string) => (await db.query<{status:string}>('SELECT status FROM events WHERE id=$1', [id])).rows[0]?.status === 'done';
  const send = async (id: string, userId: string, text: string, options: { signature?: string; source?: string; timestamp?: number } = {}) => {
    const payload = JSON.stringify({ events: [{ type: 'message', webhookEventId: id, timestamp: options.timestamp ?? Date.now(), replyToken: id, source: { type: options.source ?? 'user', userId }, message: { type: 'text', text } }] });
    const signature = options.signature ?? createHmac('sha256', config.lineSecret).update(payload).digest('base64');
    return runtime.app.inject({ method: 'POST', url: '/webhook', payload, headers: { 'content-type': 'application/json', 'x-line-signature': signature } });
  };
  const command = async (id: string, text: string, timestamp?: number) => {
    assert.equal((await send(id, owner, text, { timestamp })).statusCode, 200);
    await until(() => done(id), 'owner command must finish');
    return replies.find(reply => reply.token === id)?.text ?? '';
  };
  const open = async (id = 'open') => {
    const text = await command(id, '/配對');
    const phrase = text.match(/測試配對 [A-Za-z0-9_-]{24}/)?.[0];
    assert.ok(phrase, 'owner alone should receive a high-entropy pairing phrase');
    return phrase;
  };
  const candidate = async () => (await db.query<{ref:string}>("SELECT ref FROM pairing_windows WHERE status='pending'")).rows[0]?.ref;
  return { ...runtime, db, config, replies, pushes, send, command, open, candidate, done, aiCalls: () => aiCalls };
}

test('owner-only first startup accepts management but ignores unknown customers without AI', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject('/readyz')).statusCode, 200);
    assert.match(await f.command('help-owner', '/help'), /配對/);
    assert.equal((await f.send('unknown', stranger, '想約明天剪髮')).statusCode, 200);
    await f.send('unknown-command', stranger, '/配對');
    assert.equal((await f.db.query('SELECT id FROM events WHERE id=$1', ['unknown'])).rows.length, 0);
    assert.equal((await f.db.query('SELECT id FROM events WHERE id=$1', ['unknown-command'])).rows.length, 0);
    assert.equal((await f.db.query('SELECT ref FROM pairing_windows')).rows.length, 0);
    assert.equal(f.replies.length, 1); assert.equal(f.pushes.length, 0); assert.equal(f.aiCalls(), 0);
  } finally { await f.close(); }
});
test('candidate cannot receive service until explicit owner confirmation then joins fixed testing', async () => {
  const f = await fixture();
  try {
    const phrase = await f.open();
    assert.equal((await f.send('candidate', tester, phrase)).statusCode, 200);
    const ref = await f.candidate(); assert.ok(ref);
    await f.send('forged-approval', stranger, `/確認配對 ${ref}`);
    assert.equal((await f.db.query('SELECT user_id FROM tester_grants')).rows.length, 0);
    await f.send('too-early', tester, '想預約週五剪髮');
    assert.equal((await f.db.query('SELECT id FROM events WHERE id=$1', ['too-early'])).rows.length, 0);
    assert.equal(f.replies.length, 1, 'candidate receives no pairing reply');
    assert.match(await f.command('status', '/配對狀態'), new RegExp(ref));
    assert.match(await f.command('approve', `/確認配對 ${ref}`), /已加入/);
    await f.send('real-test', tester, '想預約週五剪髮'); await until(() => f.done('real-test'), 'confirmed tester should enter existing workflow');
    assert.ok(f.replies.some(reply => reply.token === 'real-test'));
    assert.equal(f.aiCalls(), 0); await until(() => f.pushes.length >= 1, 'owner notification must actually be emitted');
    const ownerRole = await f.command('owner-still-admin', '/配對狀態'); assert.match(ownerRole, /配對|測試/);
  } finally { await f.close(); }
});
test('bad signatures, group messages and owner self-pairing cannot register a candidate', async () => {
  const f = await fixture();
  try {
    const phrase = await f.open();
    assert.equal((await f.send('bad-signature', tester, phrase, { signature: 'bad' })).statusCode, 401);
    await f.send('wrong-phrase', tester, `測試配對 ${'x'.repeat(24)}`);
    await f.send('group-pair', tester, phrase, { source: 'group' });
    await f.send('self-pair', owner, phrase); await until(() => f.done('self-pair'), 'owner mistake should finish safely');
    assert.equal(await f.candidate(), undefined);
    assert.equal((await f.db.query('SELECT id FROM events WHERE id IN ($1,$2)', ['bad-signature','group-pair'])).rows.length, 0);
    const stored = await f.db.query<{payload:unknown;outcome:unknown}>('SELECT payload,outcome FROM events');
    assert.ok(!JSON.stringify(stored.rows).includes(phrase), 'pairing phrase must not enter normal event storage');
    await f.send('correct-person', tester, phrase); assert.ok(await f.candidate());
  } finally { await f.close(); }
});
test('one-time phrase cannot swap candidate or grant a replaying stranger', async () => {
  const f = await fixture();
  try {
    const phrase = await f.open(); await f.send('first-candidate', tester, phrase);
    const ref = await f.candidate(); assert.ok(ref);
    await f.send('first-candidate', tester, phrase); await f.send('second-candidate', stranger, phrase);
    assert.equal(await f.candidate(), ref);
    await f.command('confirm-once', `/確認配對 ${ref}`);
    await f.send('replay-old-code', stranger, phrase); await f.send('stranger-normal', stranger, '想預約');
    assert.equal((await f.db.query('SELECT id FROM events WHERE id=$1', ['stranger-normal'])).rows.length, 0);
    assert.equal((await f.db.query('SELECT user_id FROM tester_grants')).rows.length, 1);
  } finally { await f.close(); }
});
test('cancel and expiry invalidate pending candidates and old phrases', async () => {
  const f = await fixture();
  try {
    const phrase = await f.open(); await f.send('pending-cancel', tester, phrase);
    const ref = await f.candidate(); assert.ok(ref);
    await f.command('cancel', '/取消配對');
    assert.ok(!(await f.command('confirm-cancelled', `/確認配對 ${ref}`)).includes('已加入'));
    await f.send('cancelled-replay', stranger, phrase); assert.equal(await f.candidate(), undefined);
    const nextPhrase = await f.open('open-next');
    assert.ok(nextPhrase !== phrase, 'a new window must not reuse the cancelled phrase');
    await f.db.query("UPDATE pairing_windows SET expires_at=clock_timestamp()-interval '1 second' WHERE status='open'");
    await f.send('expired-candidate', tester, nextPhrase); assert.equal(await f.candidate(), undefined);
    assert.equal((await f.db.query('SELECT user_id FROM tester_grants')).rows.length, 0);
  } finally { await f.close(); }
});
test('removal revokes service admission and pairing command content is not retained', async () => {
  const f = await fixture();
  try {
    const phrase = await f.open(); await f.send('candidate-remove', tester, phrase); const ref = await f.candidate(); assert.ok(ref);
    await f.command('confirm-remove', `/確認配對 ${ref}`);
    await f.command('remove', `/移除測試 ${ref}`);
    await f.send('removed-message', tester, '想預約');
    assert.equal((await f.db.query('SELECT id FROM events WHERE id=$1', ['removed-message'])).rows.length, 0);
    const text = JSON.stringify((await f.db.query('SELECT payload,outcome FROM events')).rows);
    assert.ok(!text.includes(phrase));
    assert.ok(!text.includes('fake-pairing-secret'));
    assert.equal((await f.db.query('SELECT user_id FROM tester_grants')).rows.length, 0);
    assert.ok(!(await f.command('old-confirm', `/確認配對 ${ref}`)).includes('已加入'));
  } finally { await f.close(); }
});
test('paired tester survives restart but never crosses owner or channel scope', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'harris-pairing-test-')); let f = await fixture(folder);
  try {
    const phrase = await f.open(); await f.send('restart-candidate', tester, phrase); const ref = await f.candidate(); assert.ok(ref);
    await f.command('restart-approve', `/確認配對 ${ref}`); await f.close(); f = await fixture(folder);
    await f.send('after-restart', tester, '我想預約'); await until(() => f.done('after-restart'), 'grant should survive restart');
    await f.close(); f = await fixture(folder, { LINE_CHANNEL_SECRET: 'different-fake-channel' });
    await f.send('wrong-scope', tester, '想預約');
    assert.equal((await f.db.query('SELECT id FROM events WHERE id=$1', ['wrong-scope'])).rows.length, 0);
  } finally { await f.close(); await rm(folder, { recursive: true, force: true }); }
});
test('stale owner requests and live mode cannot open a pairing window', async () => {
  const f = await fixture();
  try {
    await f.send('stale-pair', owner, '/配對', { timestamp: Date.now()-120000 });
    await until(() => f.done('stale-pair'), 'stale owner event should finish without action');
    assert.equal((await f.db.query('SELECT ref FROM pairing_windows')).rows.length, 0);
    f.config.mode = 'live'; await f.command('live-pair', '/配對');
    assert.equal((await f.db.query('SELECT ref FROM pairing_windows')).rows.length, 0);
  } finally { await f.close(); }
});
