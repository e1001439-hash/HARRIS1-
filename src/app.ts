import Fastify from 'fastify';
import { z } from 'zod';
import { validSignature } from './signature.js';
import type { Config, LineEvent } from './types.js';
import { isPairingCommand, isPairingText, safeOwnerPairingText, type PairingService } from './pairing.js';
import { isPreviewCommand } from './preview.js';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { LineClient } from './types.js';

const sendSchema = z.object({ to: z.string().regex(/^U[0-9a-f]{32}$/), text: z.string().min(1).max(4500), retryKey: z.string().uuid().optional() });
function bearerOk(header: unknown, secret?: string): boolean {
  if (!secret || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7)), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const eventSchema = z.object({
  type: z.string(), webhookEventId: z.string().min(1).max(200), timestamp: z.number().int().nonnegative(),
  replyToken: z.string().max(1000).optional(), source: z.object({ type: z.string(), userId: z.string().optional() }),
  message: z.object({ type: z.string(), text: z.string().max(20000).optional() }).passthrough().optional(),
}).passthrough().refine(e => e.type !== 'message' || !!e.message && (e.message.type !== 'text' || typeof e.message.text === 'string'));
const bodySchema = z.object({ events: z.array(eventSchema).max(100) });

export function createApp({ config, store, pairing, line }: { config: Config; store: { ingest(events: LineEvent[], ownerId?: string): Promise<void>; ping(): Promise<void> }; pairing?: PairingService; line?: LineClient }) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, res) => { try { await store.ping(); return { ok: true }; } catch { return res.code(503).send({ ok: false }); } });
  // Outbound push for owner-approved replies. Disabled unless SEND_API_SECRET is set.
  app.post('/send', async (req, res) => {
    if (!line || !bearerOk(req.headers.authorization, config.sendApiSecret)) return res.code(401).send({ error: 'unauthorized' });
    let payload: unknown;
    try { payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''); } catch { return res.code(400).send({ error: 'invalid JSON' }); }
    const parsed = sendSchema.safeParse(payload);
    if (!parsed.success) return res.code(400).send({ error: 'invalid body' });
    const retryKey = parsed.data.retryKey ?? randomUUID();
    try { await line.push(parsed.data.to, parsed.data.text, retryKey); }
    catch { return res.code(502).send({ error: 'LINE push failed', retryKey }); }
    return { ok: true, retryKey };
  });
  app.post('/webhook', async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !validSignature(req.body, req.headers['x-line-signature'], config.lineSecret)) return res.code(401).send({ error: 'invalid signature' });
    let payload: unknown;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.code(400).send({ error: 'invalid JSON' }); }
    const parsed = bodySchema.safeParse(payload);
    if (!parsed.success) return res.code(400).send({ error: 'invalid events' });
    try {
      const accepted: LineEvent[] = [];
      for (const event of parsed.data.events) {
        const userId = event.source.userId;
        if (event.type !== 'message' || event.source.type !== 'user' || !userId) continue;
        const text = event.message?.text ?? '';
        if (userId === config.ownerId) {
          accepted.push(event.message?.type === 'text' ? { ...event, message: { ...event.message, text: safeOwnerPairingText(text) } } : event);
          continue;
        }
        // Reserved setup traffic is never normal customer content, including
        // wrong/replayed phrases and attempts from an already approved tester.
        if (isPreviewCommand(text)) continue;
        if (isPairingText(text) || isPairingCommand(text)) { if (isPairingText(text)) await pairing?.receive(event); continue; }
        if (config.mode === 'live' || config.testUserIds.includes(userId) || await pairing?.isTester(userId)) accepted.push(event);
      }
      if (accepted.length) await store.ingest(accepted, config.ownerId);
    } catch { return res.code(503).send({ error: 'storage unavailable' }); }
    return { ok: true };
  });
  return app;
}
