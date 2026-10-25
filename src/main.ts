import { initializeService } from './startup.js';

const result = await initializeService();
if (!result.ok) {
  console.error(JSON.stringify(result.diagnostic));
  process.exitCode = 1;
} else {
  const { config, runtime } = result;
  console.log(JSON.stringify({ event: 'started', mode: config.mode, responseMode: config.responseMode }));
  const shutdown = async () => { await runtime.close(); };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}
