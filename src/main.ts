import './env.js';
import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { PgDatabase, migrate } from './db.js';
import { HttpLineClient } from './clients/line.js';
import { OpenAiClient } from './clients/ai.js';
import { startRuntime } from './runtime.js';
import { dirname, join } from 'node:path';
import { loadFacts } from './knowledge.js';

try {
  const config = loadConfig();
  const knowledge = await readFile(config.knowledgePath, 'utf8');
  const facts = await loadFacts(join(dirname(config.knowledgePath), 'facts.json'));
  const db = new PgDatabase(config.databaseUrl);
  try {
    await migrate(db);
    const ai = config.responseMode === 'ai' ? new OpenAiClient(config.aiKey!, config.aiModel!) : { async generate(): Promise<never> { throw new Error('AI mode disabled'); } };
    const runtime = await startRuntime({ db, config, ai, line: new HttpLineClient(config.lineToken), knowledge, facts });
    console.log(JSON.stringify({ event: 'started', mode: config.mode, responseMode: config.responseMode }));
    const shutdown = async () => { await runtime.close(); };
    process.once('SIGTERM', () => { void shutdown(); }); process.once('SIGINT', () => { void shutdown(); });
  } catch (error) { await db.close(); throw error; }
} catch { console.error('服務啟動失敗；請檢查必要環境變數、資料庫的 TLS 連線與店務知識檔。'); process.exitCode = 1; }
