import type { Store } from './store.js';
import type { AiClient, AiResult, Config, EventJob, LineClient, Outcome } from './types.js';
import { DeliveryError } from './clients/line.js';
import { handleOwnerCommand } from './commands.js';
import { applyPolicy, humanFallback, humanRequired } from './policy.js';
import type { SalonFacts } from './knowledge.js';

interface Options { store: Store; config: Config; line: LineClient; ai: AiClient; knowledge: string; facts?: SalonFacts; lane?: 'owner' | 'customer'; onNotificationIssue?: (issue: Record<string, unknown>) => void }
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline exceeded')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export class Worker {
  private busy = false; private stopped = false;
  constructor(private options: Options) {}
  stop() { this.stopped = true; }
  async tick(): Promise<boolean> {
    if (this.busy || this.stopped) return false;
    this.busy = true;
    try {
      const { store, line, config } = this.options;
      const lane = this.options.lane;
      const job = await store.claimEvent(lane === 'owner' ? { onlyUserId: config.ownerId } : lane === 'customer' ? { excludeUserId: config.ownerId } : {});
      if (job) await this.process(job);
      const notice = lane === 'owner' ? null : await store.claimNotification();
      if (notice) {
        let status: 'sent' | 'failed' | 'unknown' = 'sent';
        try {
          if (notice.ownerId !== config.ownerId) throw new DeliveryError('failed');
          await within(line.push(config.ownerId, notice.text, notice.retryKey), 9000);
        }
        catch (error) {
          status = error instanceof DeliveryError ? error.delivery : 'unknown';
          const issue = { event: 'owner_notification_failed', notificationId: notice.id, delivery: status, attempt: notice.attempts, terminal: notice.attempts >= 3 };
          if (this.options.onNotificationIssue) this.options.onNotificationIssue(issue);
          else console.warn(JSON.stringify(issue));
        }
        await store.finishNotification(notice, status);
      }
      return !!(job || notice);
    } finally { this.busy = false; }
  }
  private async process(job: EventJob): Promise<void> {
    const { store, config, line, ai, knowledge } = this.options;
    const isOwner = job.userId === config.ownerId;
    const text = job.event.message?.text ?? '';
    let result: AiResult;
    let outcome: Outcome;
    if (!isOwner && config.mode === 'test' && !config.testUserIds.includes(job.userId)) {
      await store.finishEvent(job, { ...humanFallback('', '測試模式略過非測試帳號'), reply: '', delivery: 'not_sent', skipTask: true }, config.ownerId);
      return;
    }
    if (job.previouslySending || job.attempts >= 3) {
      outcome = { ...humanFallback(text, '上次處理中斷，請檢查是否已回覆，避免重複傳送'), delivery: job.previouslySending ? 'unknown' : 'not_sent', skipTask: isOwner };
      await store.finishEvent(job, outcome, config.ownerId); return;
    }
    if (isOwner) result = { reply: await handleOwnerCommand(text, store), summary: '店主管理操作', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '' };
    else if ((await store.getSession(job.userId)).handoff) {
      outcome = { ...humanFallback(text, '人工接手中，請本人回覆新訊息'), reply: '', delivery: 'not_sent' };
      await store.finishEvent(job, outcome, config.ownerId); return;
    } else if (job.event.message?.type !== 'text' || humanRequired(text)) result = humanFallback(text, '請本人查看客人訊息');
    else if (Date.now() - job.event.timestamp > 45000) result = humanFallback(text, '訊息處理延遲，請本人回覆');
    else if (config.responseMode === 'fixed') result = humanFallback(text, '測試固定回覆，請本人檢查訊息');
    else {
      try { result = applyPolicy(await within(ai.generate({ text, history: await store.history(job.userId), knowledge: `${knowledge}\n已審閱的結構化資料：${this.options.facts?.approved ? JSON.stringify(this.options.facts) : '尚未確認'}`, receivedAt: job.receivedAt.toISOString() }), 19000), text, knowledge, config.bookingUrl, this.options.facts); }
      catch { result = humanFallback(text, 'AI 無法產生可靠回覆，請本人確認'); }
    }
    outcome = { ...result, delivery: 'not_sent', skipTask: isOwner };
    const age = Date.now() - job.event.timestamp;
    if (job.event.replyToken && age < 50000 && age > -60000) {
      if (await store.markSending(job, isOwner)) {
        try { await within(line.reply(job.event.replyToken, result.reply), 9000); outcome.delivery = 'sent'; }
        catch (error) { outcome.delivery = error instanceof DeliveryError ? error.delivery : 'unknown'; outcome.needsHuman = !isOwner; outcome.nextAction = '回覆未確認送達，請本人檢查再回覆'; }
      } else if (!isOwner) { outcome.needsHuman = true; outcome.reply = ''; outcome.nextAction = '已切換人工接手，請本人回覆'; }
    } else if (!isOwner) { outcome.needsHuman = true; outcome.nextAction = '回覆憑證已過期或不存在，請本人回覆'; }
    await store.finishEvent(job, outcome, config.ownerId);
  }
}
