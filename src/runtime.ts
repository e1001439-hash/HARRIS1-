import { createApp } from './app.js';
import { Store } from './store.js';
import { Worker } from './worker.js';
import type { AiClient, Config, Database, LineClient } from './types.js';
import type { SalonFacts } from './knowledge.js';

export async function startRuntime(options: { db: Database; config: Config; ai: AiClient; line: LineClient; knowledge: string; facts?: SalonFacts; host?: string }) {
  const { db, config } = options;
  const store = new Store(db); await store.ping(); await store.cleanup();
  const worker = new Worker({ ...options, store, lane: 'customer' });
  const ownerWorker = new Worker({ ...options, store, lane: 'owner' });
  const app = createApp({ config, store });
  const address = await app.listen({ port: config.port, host: options.host ?? '0.0.0.0' });
  let closed = false;
  let nextCleanup = Date.now() + 3600000;
  const loop = (runner: Worker, ownerLane: boolean) => {
    let stopped = false;
    let active: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => { if (!stopped) timer = setTimeout(() => { active = run(); }, ownerLane ? 100 : 250); };
    const run = async () => {
      try {
        await runner.tick();
        if (!ownerLane && Date.now() >= nextCleanup) { await store.cleanup(); nextCleanup = Date.now() + 3600000; }
      } catch { console.error(JSON.stringify({ event: 'worker_error', message: '背景工作失敗，已保留工作供重試；請檢查服務狀態。' })); }
      finally { schedule(); }
    };
    schedule();
    return async () => { stopped = true; clearTimeout(timer); runner.stop(); await active; };
  };
  const stopCustomer = loop(worker, false), stopOwner = loop(ownerWorker, true);
  return { app, store, worker, address, async close() {
    if (closed) return; closed = true;
    await app.close(); await Promise.all([stopCustomer(), stopOwner()]); await db.close();
  } };
}
