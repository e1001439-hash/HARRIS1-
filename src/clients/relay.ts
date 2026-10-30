import type { Config, EventJob, LineClient } from '../types.js';

/** Forwards one stored customer event to the external drafting webhook. */
export async function forwardToRelay(config: Config, line: LineClient, job: EventJob, fetcher: typeof fetch = fetch): Promise<void> {
  const profile = await line.profile?.(job.userId) ?? null;
  const body = {
    source: 'harris-line-assistant',
    eventId: job.id,                 // = LINE webhookEventId = events.id (history key)
    customerRef: job.customerRef,    // C000123
    userId: job.userId,              // push target
    displayName: profile?.displayName ?? null,
    receivedAt: job.receivedAt.toISOString(),
    // Image/video/audio/file: fetch bytes with GET https://api-data.line.me/v2/bot/message/{message.id}/content
    // (or GET /media/:eventId on this service) – LINE keeps content only for a limited time.
    event: job.event,
  };
  const response = await fetcher(config.relayUrl!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [config.relaySecretHeader ?? 'x-relay-secret']: config.relaySecret!, 'Idempotency-Key': job.id },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`relay ${response.status}`);
}
