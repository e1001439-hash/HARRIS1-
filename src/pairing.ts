import { createHash, createHmac } from 'node:crypto';
import { PairingStore, type PairingContext } from './pairing-store.js';
import type { Config, EventJob, LineEvent } from './types.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const userIdFormat = /^U[0-9a-f]{32}$/;
export const isPairingText = (text: string): boolean => /測試配對(?:\s|$)/u.test(text);
export const isPairingCommand = (text: string): boolean => /^\/(?:配對(?:狀態|本人提示|指令錯誤)?|確認配對|取消配對|移除測試)(?:\s|$)/u.test(text.trim());
/** Do not enqueue accidental pairing secrets in the normal event history. */
export function safeOwnerPairingText(text: string): string {
  if (isPairingText(text)) return '/配對本人提示';
  if (!isPairingCommand(text)) return text;
  const normalized = text.trim();
  return /^\/(?:配對|配對狀態|取消配對)$/u.test(normalized) || /^\/(?:確認配對|移除測試) P\d{6,}$/u.test(normalized) ? normalized : '/配對指令錯誤';
}
const help = '測試配對：\n/配對 開啟五分鐘窗口\n/配對狀態 查看候選與測試者代號\n/確認配對 P000001 確認你指定的人\n/取消配對 關閉尚未確認窗口\n/移除測試 P000001 移除已配對測試者';
const time = (date: Date) => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);

export class PairingService {
  constructor(private store: PairingStore, private config: Config) {}
  private get context(): PairingContext { return { scope: hash(this.config.lineSecret), ownerId: this.config.ownerId }; }
  async isTester(userId: string): Promise<boolean> {
    return this.config.mode === 'test' && userId !== this.config.ownerId && userIdFormat.test(userId) && await this.store.isTester(this.context, userId);
  }
  async receive(event: LineEvent): Promise<void> {
    const userId = event.source.userId;
    if (this.config.mode !== 'test' || event.source.type !== 'user' || !userId || !userIdFormat.test(userId) || userId === this.config.ownerId) return;
    const match = event.message?.text?.trim().match(/^測試配對\s+([A-Za-z0-9_-]{24})$/u);
    if (!match || this.config.testUserIds.includes(userId) || await this.isTester(userId)) return;
    await this.store.capture(this.context, event.webhookEventId, userId, hash(match[1]!));
  }
  async cleanup(): Promise<void> { await this.store.cleanup(); }
  async command(text: string, job: EventJob): Promise<string> {
    if (job.userId !== this.config.ownerId || job.event.source.type !== 'user' || job.event.source.userId !== this.config.ownerId) return '這是店主管理功能。';
    if (this.config.mode !== 'test') return '配對只在測試模式開放；正式模式設定保持不變。';
    const age = Date.now() - job.event.timestamp;
    if (age > 50000 || age < -10000) return '這則配對指令已過期，請重新傳送。';
    const [command, ref] = text.trim().split(/\s+/);
    if (command === '/配對本人提示') return '你目前是店主身分，不能配成測試客人。請把一次性測試文字私下交給指定測試者。';
    if (command === '/配對') {
      // Domain-separated HMAC permits idempotent retries without storing the
      // plaintext phrase or introducing another long-lived credential.
      const code = createHmac('sha256', this.config.lineSecret).update(`harris-test-pairing-v1\0${this.config.ownerId}\0${job.id}`).digest('base64url').slice(0, 24);
      const window = await this.store.open(this.context, job.id, hash(code));
      if (window.status !== 'open') return '這次窗口已使用、取消或到期；請重新傳送 /配對。';
      return `配對窗口到台灣時間 ${time(window.expiresAt)} 為止。\n請只把下列一次性文字私下交給指定測試者，讓對方傳給此官方帳號：\n測試配對 ${code}\n對方傳送後，輸入 /配對狀態，核對候選時間與人選後再確認；不會自動授權。`;
    }
    if (command === '/配對狀態') {
      const state = await this.store.status(this.context);
      const window = state.window;
      const pending = window?.status === 'pending' ? `候選 ${window.ref}，收到時間 ${window.candidateAt ? time(window.candidateAt) : '待確認'}。\n請向你指定的人核對，確認後輸入 /確認配對 ${window.ref}。` : window ? `窗口開啟中，到 ${time(window.expiresAt)}；尚無候選。` : '目前沒有待確認的配對窗口。';
      return [pending, `已配對測試者：${state.testers.map(tester => tester.ref).join('、') || '無'}`, '取消未確認窗口：/取消配對'].join('\n').slice(0, 4400);
    }
    if (command === '/確認配對' && ref && /^P\d{6,}$/.test(ref)) return await this.store.confirm(this.context, ref) ? `${ref} 已加入測試名單；只開放這位測試者，不影響其他客人。` : '候選已過期、取消、移除或不屬於這個帳號，未新增授權。';
    if (command === '/取消配對') return await this.store.cancel(this.context) ? '已取消未確認配對；原測試文字失效。' : '目前沒有未確認窗口；既有測試授權維持不變。';
    if (command === '/移除測試' && ref && /^P\d{6,}$/.test(ref)) return await this.store.remove(this.context, ref) ? `${ref} 的配對授權已移除。若也存在手動設定的靜態名單，需由管理者另行移除。` : '找不到這個帳號下的配對授權。';
    return help;
  }
}
