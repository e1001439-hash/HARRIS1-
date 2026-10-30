import { createApp } from './app.js';
import { Store } from './store.js';
import { Worker } from './worker.js';
import type { AiClient, Config, Database, LineClient } from './types.js';
import type { SalonFacts } from './knowledge.js';
import { NotificationWorker } from './notification-worker.js';
import { PairingStore } from './pairing-store.js';
import { PairingService } from './pairing.js';

export async function startRuntime(options: { db: Database; config: Config; ai: AiClient; line: LineClient; knowledge: string; facts?: SalonFacts; host?: string }) {
  const { db, config } = options;
  const store = new Store(db); await store.ping(); await store.cleanup();
  const pairing = new PairingService(new PairingStore(db), config); await pairing.cleanup();
  const worker = new Worker({ ...options, store, pairing, lane: 'customer' });
  const ownerWorker = new Worker({ ...options, store, pairing, lane: 'owner' });
  const notificationWorker = new NotificationWorker({ ...options, store });
  const app = createApp({ config, store, pairing, line: options.line });
  const address = await app.listen({ port: config.port, host: options.host ?? '0.0.0.0' });
  let closed = false;
  let nextCleanup = Date.now() + 3600000;
  let nextPairingCleanup = Date.now() + 60000;
  const wakers: (() => void)[] = [];
  store.onIngest = () => { for (const wake of wakers) wake(); };
  const loop = (runner: Pick<Worker, 'tick' | 'stop'>, lane: 'owner' | 'customer' | 'notification') => {
    let stopped = false;
    let active: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout>;
    let busyLast = false; let running = false;
    const wake = () => { if (!stopped && !running) { clearTimeout(timer); timer = setTimeout(() => { active = run(); }, 0); } };
    wakers.push(wake);
    const schedule = () => { if (!stopped) timer = setTimeout(() => { active = run(); }, busyLast ? 100 : (config.pollIdleMs ?? 2000)); };
    const run = async () => {
      running = true;
      try {
        busyLast = await runner.tick();
        if (lane === 'customer' && Date.now() >= nextCleanup) { await store.cleanup(); nextCleanup = Date.now() + 3600000; }
        if (lane === 'owner' && Date.now() >= nextPairingCleanup) { await pairing.cleanup(); nextPairingCleanup = Date.now() + 60000; }
      } catch { console.error(JSON.stringify({ event: 'worker_error', message: '背景工作失敗，已保留工作供重試；請檢查服務狀態。' })); }
      finally { running = false; schedule(); }
    };
    schedule();
    return async () => { stopped = true; clearTimeout(timer); runner.stop(); await active; };
  };
  const stopCustomer = loop(worker, 'customer'), stopOwner = loop(ownerWorker, 'owner'), stopNotification = config.ownerLineNotify === false ? async () => {} : loop(notificationWorker, 'notification');
  return { app, store, worker, address, async close() {
    if (closed) return; closed = true;
    await app.close(); await Promise.all([stopCustomer(), stopOwner(), stopNotification()]); await db.close();
  } };
}
