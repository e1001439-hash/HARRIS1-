import Fastify from 'fastify';
import { z } from 'zod';
import { validSignature } from './signature.js';
import type { Config, LineEvent } from './types.js';

const eventSchema = z.object({
  type: z.string(), webhookEventId: z.string().min(1).max(200), timestamp: z.number().int().nonnegative(),
  replyToken: z.string().max(1000).optional(), source: z.object({ type: z.string(), userId: z.string().optional() }),
  message: z.object({ type: z.string(), text: z.string().max(20000).optional() }).optional(),
}).refine(e => e.type !== 'message' || !!e.message && (e.message.type !== 'text' || typeof e.message.text === 'string'));
const bodySchema = z.object({ events: z.array(eventSchema).max(100) });

export function createApp({ config, store }: { config: Config; store: { ingest(events: LineEvent[]): Promise<void>; ping(): Promise<void> } }) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, res) => { try { await store.ping(); return { ok: true }; } catch { return res.code(503).send({ ok: false }); } });
  app.post('/webhook', async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !validSignature(req.body, req.headers['x-line-signature'], config.lineSecret)) return res.code(401).send({ error: 'invalid signature' });
    let payload: unknown;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.code(400).send({ error: 'invalid JSON' }); }
    const parsed = bodySchema.safeParse(payload);
    if (!parsed.success) return res.code(400).send({ error: 'invalid events' });
    const accepted = parsed.data.events.filter(e => e.type === 'message' && e.source.type === 'user' && e.source.userId &&
      (e.source.userId === config.ownerId || config.mode === 'live' || config.testUserIds.includes(e.source.userId)));
    try { if (accepted.length) await store.ingest(accepted); } catch { return res.code(503).send({ error: 'storage unavailable' }); }
    return { ok: true };
  });
  return app;
}
