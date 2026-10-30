import type { Delivery, LineClient } from '../types.js';
export class DeliveryError extends Error {
  constructor(public readonly delivery: Extract<Delivery, 'failed' | 'unknown'>) { super(`LINE delivery ${delivery}`); }
}
export class HttpLineClient implements LineClient {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  private async send(endpoint: 'reply' | 'push', payload: object, retryKey?: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.line.me/v2/bot/message/${endpoint}`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {}) },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
      });
    } catch { throw new DeliveryError('unknown'); }
    if (response.ok || endpoint === 'push' && response.status === 409 && response.headers.has('x-line-accepted-request-id')) return;
    throw new DeliveryError(response.status >= 500 || response.status === 408 ? 'unknown' : 'failed');
  }
  reply(replyToken: string, text: string): Promise<void> { return this.send('reply', { replyToken, messages: [{ type: 'text', text: text.slice(0, 4500) }] }); }
  async profile(userId: string): Promise<{ displayName: string; pictureUrl?: string } | null> {
    try {
      const response = await this.fetcher(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const body = await response.json() as { displayName?: string; pictureUrl?: string };
      return typeof body.displayName === 'string' ? { displayName: body.displayName, pictureUrl: body.pictureUrl } : null;
    } catch { return null; }
  }
  push(to: string, text: string, retryKey: string): Promise<void> { return this.send('push', { to, messages: [{ type: 'text', text: text.slice(0, 4500) }] }, retryKey); }
}
