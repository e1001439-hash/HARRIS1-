import type { Store } from './store.js';
import type { AiClient, AiResult, Config, EventJob, LineClient, Outcome } from './types.js';
import { DeliveryError } from './clients/line.js';
import { handleOwnerCommand } from './commands.js';
import { humanFallback, humanRequired } from './policy.js';
import { analyzeMessage } from './analysis.js';
import { handleOwnerPreview, isPreviewCommand } from './preview.js';
import type { SalonFacts } from './knowledge.js';
import { NotificationWorker } from './notification-worker.js';
import { isPairingCommand, type PairingService } from './pairing.js';

interface Options { store: Store; config: Config; line: LineClient; ai: AiClient; knowledge: string; facts?: SalonFacts; lane?: 'owner' | 'customer'; onNotificationIssue?: (issue: Record<string, unknown>) => void; pairing?: PairingService }
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline exceeded')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export class Worker {
  private busy = false; private stopped = false;
  private notificationWorker: NotificationWorker;
  constructor(private options: Options) { this.notificationWorker = new NotificationWorker(options); }
  stop() { this.stopped = true; this.notificationWorker.stop(); }
  async tick(): Promise<boolean> {
    if (this.busy || this.stopped) return false;
    this.busy = true;
    try {
      const { store, config } = this.options;
      const lane = this.options.lane;
      const job = await store.claimEvent(lane === 'owner' ? { onlyUserId: config.ownerId } : lane === 'customer' ? { excludeUserId: config.ownerId } : {});
      if (job) await this.process(job);
      // Runtime has a separate notification loop. The all-purpose instance is
      // also usable by local tools/tests without starting a background service.
      const notified = !lane && await this.notificationWorker.tick();
      return !!(job || notified);
    } finally { this.busy = false; }
  }
  private async process(job: EventJob): Promise<void> {
    const { store, config, line, ai, knowledge } = this.options;
    const isOwner = job.userId === config.ownerId;
    const text = job.event.message?.text ?? '';
    const preview = isOwner && isPreviewCommand(text);
    const privateSetup = isOwner && (isPairingCommand(text) || preview);
    const handoff = !isOwner && (job.manualHandoff === true || (await store.getSession(job.userId)).handoff);
    let result: AiResult;
    let outcome: Outcome;
    if (!isOwner && config.mode === 'test' && !config.testUserIds.includes(job.userId) && !await this.options.pairing?.isTester(job.userId)) {
      await store.finishEvent(job, { ...humanFallback('', '測試模式略過非測試帳號'), reply: '', delivery: 'not_sent', skipTask: true }, config.ownerId);
      return;
    }
    if (job.previouslySending || job.attempts >= 3) {
      outcome = { ...humanFallback(text, '上次處理中斷，請檢查是否已回覆，避免重複傳送'), reply: '', delivery: job.previouslySending ? 'unknown' : 'not_sent', skipTask: isOwner, preserveHandoff: handoff, privateSetup };
      await store.finishEvent(job, outcome, config.ownerId); return;
    }
    if (isOwner) result = { reply: preview ? await handleOwnerPreview(this.options, job) : await handleOwnerCommand(text, store, this.options.pairing, job), summary: '店主管理操作', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '' };
    else if (!await store.isLatestEvent(job)) {
      outcome = { ...humanFallback(text, '本則為較早訊息，已由後續需求接續'), reply: '', needsHuman: false, delivery: 'not_sent', preserveHandoff: true };
      await store.finishEvent(job, outcome, config.ownerId); return;
    } else if (job.event.message?.type !== 'text' || !handoff && humanRequired(text)) result = humanFallback(text, '請本人查看客人訊息');
    else if (config.responseMode === 'fixed') result = humanFallback(text, '測試固定回覆，請本人檢查訊息');
    else {
      try {
        const history = await store.history(job.userId);
        result = await analyzeMessage({ ai, text, history, handoff, knowledge, facts: this.options.facts, bookingUrl: config.bookingUrl, receivedAt: job.receivedAt.toISOString() });
      }
      catch { result = humanFallback(text, 'AI 無法產生可靠回覆，請本人確認'); }
    }
    outcome = { ...result, delivery: 'not_sent', skipTask: isOwner, privateSetup };
    if (preview && !result.reply) { await store.finishEvent(job, outcome, config.ownerId); return; }
    if (handoff) {
      outcome = { ...outcome, reply: '', needsHuman: true, preserveHandoff: true, nextAction: '人工接手中，請本人查看本則補充／修改；時段僅為需求，尚待確認。' };
      await store.finishEvent(job, outcome, config.ownerId); return;
    }
    const age = Date.now() - job.event.timestamp;
    if (job.event.replyToken && age < 50000 && age > -60000) {
      if (await store.markSending(job, isOwner)) {
        try { await within(line.reply(job.event.replyToken, result.reply), 9000); outcome.delivery = 'sent'; }
        catch (error) { outcome.delivery = error instanceof DeliveryError ? error.delivery : 'unknown'; outcome.needsHuman = !isOwner; outcome.nextAction = '回覆未確認送達，請本人檢查再回覆'; }
      } else if (!isOwner) {
        outcome.reply = ''; outcome.preserveHandoff = true;
        const latest = await store.isLatestEvent(job);
        outcome.needsHuman = latest; outcome.nextAction = latest ? '已切換人工接手，請本人回覆' : '本則已由較新訊息接續，不再自動回覆';
      }
    } else if (!isOwner) { outcome.needsHuman = true; outcome.nextAction = '回覆憑證已過期或不存在，請本人回覆'; }
    await store.finishEvent(job, outcome, config.ownerId);
  }
}
