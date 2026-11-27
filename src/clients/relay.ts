import type { Config, EventJob, LineClient } from '../types.js';

/** Forwards one stored customer event to the external drafting webhook. */
export interface RelayExtra {
  /** hybrid: a fixed reply was attempted but not confirmed delivered. */
  quickReplyAttempt?: { id: string; text: string; delivery: string };
  /** Last stored turns for this customer (customer texts + bot fixed replies; /send pushes are not stored). */
  recent?: { role: 'user' | 'assistant'; content: string }[];
}
export async function forwardToRelay(config: Config, line: LineClient, job: EventJob, fetcher: typeof fetch = fetch, extra: RelayExtra = {}): Promise<void> {
  const profile = await line.profile?.(job.userId) ?? null;
  const body = {
    source: 'harris-line-assistant',
    eventId: job.id,                 // = LINE webhookEventId = events.id (history key)
    customerRef: job.customerRef,    // C000123
    userId: job.userId,              // push target
    displayName: profile?.displayName ?? null,
    receivedAt: job.receivedAt.toISOString(),
    // No media fetching: image/video are flagged hasPhoto for Harris to view in LINE himself.
    event: job.event,
    mode: config.customerReplyMode,
    // Harris 11/27: photos are his to look at; the relay target must not reply, only summarise.
    ...(job.event.message?.type === 'image' || job.event.message?.type === 'video' ? { hasPhoto: true, note: '有照片，留給 Harris' } : {}),
    ...extra,
  };
  const response = await fetcher(config.relayUrl!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [config.relaySecretHeader ?? 'x-relay-secret']: config.relaySecret!, 'Idempotency-Key': job.id },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`relay ${response.status}`);
}
