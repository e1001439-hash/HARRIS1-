import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createEmbeddedDatabase } from './embedded-db.js';
import { migrate } from './db.js';
import { startRuntime } from './runtime.js';

export const DEMO_OWNER_ID = `U${'1'.repeat(32)}`;
export const DEMO_CUSTOMER_ID = `U${'2'.repeat(32)}`;
export const DEMO_SECRET = 'demo-secret-local-only';
export async function startDemo(options: { dataDir?: string; outboxPath?: string; port?: number } = {}) {
  const dataDir = options.dataDir ?? '.local/demo';
  const outboxPath = options.outboxPath ?? '.local/demo-outbound.jsonl';
  await mkdir(dirname(resolve(dataDir)), { recursive: true }); await mkdir(dirname(resolve(outboxPath)), { recursive: true });
  const db = await createEmbeddedDatabase(dataDir);
  try {
    await migrate(db);
    const config = loadConfig({ DATABASE_URL: 'local-demo', LINE_CHANNEL_SECRET: DEMO_SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'demo-only-not-a-real-token', OWNER_LINE_USER_ID: DEMO_OWNER_ID, TEST_LINE_USER_IDS: DEMO_CUSTOMER_ID, RESPONSE_MODE: 'fixed' });
    config.port = options.port ?? Number(process.env.PORT ?? 3000); config.responseMode = 'ai';
    const knowledge = await readFile('knowledge/salon.md', 'utf8');
    return await startRuntime({ db, config, knowledge, host: '127.0.0.1', ai: { async generate({ text }) {
      return { reply: '你好，請問想了解什麼服務？', summary: text.slice(0, 500), service: text.includes('剪髮') ? '剪髮' : null,
        requestedTime: text.includes('週五下午') ? '週五下午' : null, bookingStatus: text.includes('預約') ? 'requested' : 'none', needsHuman: false, nextAction: '無需處理' };
    } }, line: {
      async reply(_token, text) { await appendFile(outboxPath, JSON.stringify({ kind: 'reply', text }) + '\n'); },
      async push(to, text, retryKey) { await appendFile(outboxPath, JSON.stringify({ kind: 'push', to, text, retryKey }) + '\n'); },
    } });
  } catch (error) { await db.close(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runtime = await startDemo();
    console.log(`本地示範已啟動（port ${process.env.PORT ?? 3000}）；不會呼叫真實 LINE 或 AI。執行 npm run demo:send 送出假訊息。`);
    process.once('SIGINT', () => { void runtime.close(); }); process.once('SIGTERM', () => { void runtime.close(); });
  } catch { console.error('本地示範啟動失敗，請確認埠號、檔案權限與資料庫狀態。'); process.exitCode = 1; }
}
