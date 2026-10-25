import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { startDemo, DEMO_CUSTOMER_ID, DEMO_OWNER_ID, DEMO_SECRET } from '../src/demo.js';

test('signed HTTP event generates durable fake reply/owner notice and survives restart', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'salon-demo-test-'));
  const options = { dataDir: join(folder, 'db'), outboxPath: join(folder, 'outbound.jsonl'), port: 0 };
  let service = await startDemo(options);
  try {
    assert.equal((await service.app.inject('/readyz')).statusCode, 200);
    const event = { type: 'message', webhookEventId: 'demo-e2e', timestamp: Date.now(), replyToken: 'fake-reply', source: { type: 'user', userId: DEMO_CUSTOMER_ID }, message: { type: 'text', text: '我想預約週五下午剪髮' } };
    const payload = JSON.stringify({ events: [event] });
    const response = await fetch(`${service.address}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': createHmac('sha256', DEMO_SECRET).update(payload).digest('base64') }, body: payload });
    assert.equal(response.status, 200);
    // Tick is serialized with the background loop; bounded polling waits for the actual stored result.
    let output = '';
    for (let i = 0; i < 80; i++) {
      try { output = await readFile(options.outboxPath, 'utf8'); } catch { /* not emitted yet */ }
      if (output.includes('"kind":"reply"') && output.includes('期望時間：週五下午')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const lines = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.filter(line => line.kind === 'reply').length, 1);
    const pushes = lines.filter(line => line.kind === 'push');
    assert.ok(pushes.length >= 1 && pushes.length <= 2, 'one source event may have receipt and analysis stages');
    assert.ok(pushes.every(line => line.to === DEMO_OWNER_ID));
    assert.ok(pushes.some(line => /期望時間：週五下午/.test(line.text)));
    assert.equal(new Set(pushes.map(line => line.retryKey)).size, pushes.length);
    assert.equal((await service.store.listTasks()).length, 1);
    await service.close(); service = await startDemo(options);
    assert.equal((await service.store.listTasks()).length, 1);
    assert.equal((await service.store.getSession(DEMO_CUSTOMER_ID)).handoff, true);
    assert.equal((await service.app.inject({ method: 'POST', url: '/webhook', headers: { 'content-type': 'application/json', 'x-line-signature': createHmac('sha256', DEMO_SECRET).update(payload).digest('base64') }, payload })).statusCode, 200);
    await service.worker.tick();
    assert.equal((await readFile(options.outboxPath, 'utf8')).trim().split('\n').length, lines.length);
  } finally { await service.close(); await rm(folder, { recursive: true, force: true }); }
});
