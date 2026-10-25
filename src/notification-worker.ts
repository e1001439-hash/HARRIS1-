import type { Store } from './store.js';
import type { Config, LineClient } from './types.js';
import { DeliveryError } from './clients/line.js';

export interface NotificationOptions {
  store: Store; line: LineClient; config: Pick<Config, 'ownerId'>;
  onNotificationIssue?: (issue: Record<string, unknown>) => void;
}
/** A separate loop in the existing process; never waits for AI or customer replies. */
export class NotificationWorker {
  private busy = false; private stopped = false;
  constructor(private options: NotificationOptions) {}
  stop() { this.stopped = true; }
  async tick(): Promise<boolean> {
    if (this.busy || this.stopped) return false;
    this.busy = true;
    try {
      const { store, line, config } = this.options;
      const notice = await store.claimNotification();
      if (!notice) return false;
      if (!await store.canSendNotification(notice)) return true;
      let status: 'sent' | 'failed' | 'unknown' = 'sent';
      try {
        if (notice.ownerId !== config.ownerId) throw new DeliveryError('failed');
        // The production LINE client enforces its own abort deadline.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([line.push(config.ownerId, notice.text, notice.retryKey), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new DeliveryError('unknown')), 9000);
          })]);
        } finally { if (timer) clearTimeout(timer); }
      } catch (error) {
        status = error instanceof DeliveryError ? error.delivery : 'unknown';
        const issue = { event: 'owner_notification_failed', notificationId: notice.id, phase: notice.phase, delivery: status, attempt: notice.attempts, terminal: notice.attempts >= 3 };
        if (this.options.onNotificationIssue) this.options.onNotificationIssue(issue);
        else console.warn(JSON.stringify(issue));
      }
      await store.finishNotification(notice, status);
      return true;
    } finally { this.busy = false; }
  }
}
