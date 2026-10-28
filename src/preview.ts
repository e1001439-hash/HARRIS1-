import { analyzeMessage } from './analysis.js';
import { aiFailureCode, type AiFailureCode } from './clients/ai.js';
import { humanFallback, humanRequired } from './policy.js';
import type { SalonFacts } from './knowledge.js';
import type { Store } from './store.js';
import type { AiClient, AiResult, Config, EventJob } from './types.js';

export const isPreviewCommand = (text: string): boolean => /^\/(?:preview|預覽)(?:\s|$)/.test(text.trim());
const header = '【店主測試預覽】\n只回覆給你，未發給客人或建立預約；不代表客人端到端驗收。\n\n';
const failureHints: Record<AiFailureCode, string> = {
  AUTHENTICATION: '金鑰驗證失敗，請本人檢查 Render 的 SALON_AI_API_KEY。',
  PERMISSION: 'API 權限不足，請本人確認專案與模型使用權限。',
  QUOTA: 'API 額度或帳務不足，請本人到 OpenAI 平台確認；未自動重試。',
  RATE_LIMIT: 'API 暫時受到速率限制，請稍後再試；未自動重試。',
  MODEL_UNAVAILABLE: '模型或端點不可用，請確認 AI_MODEL 與帳號模型權限。',
  TIMEOUT: 'AI 回應逾時，這次未取得可用分析；未自動重試。',
  INCOMPLETE: 'AI 未完成輸出，這次不能視為測試成功。',
  INVALID_RESPONSE: 'AI 輸出格式不符，已停止採用該結果。',
  UNAVAILABLE: 'AI 暫時無法產生可靠結果，請稍後確認服務狀態。',
};
function formatPreview(result: AiResult, calledAi: boolean): string {
  const booking = { none: '無預約需求', requested: '僅收到需求，尚未確認預約', self_reported: '自述已預約，尚待核實' }[result.bookingStatus];
  const source = !calledAi ? '規則直接轉人工，未呼叫 AI' : result.replySource === 'natural_verified' ? '自然草稿通過模型語意核驗，尚未經真人確認' : '使用安全簡答，未採用自然草稿';
  return `${header}${source}\n\n預計回覆：\n${result.reply.slice(0, 2200)}\n\n判斷：${result.needsHuman ? '需要本人處理' : '可初步回覆'}\n預約：${booking}\n項目：${result.service ?? '未指定'}\n希望時間：${result.requestedTime ?? '未指定'}\n下一步：${result.nextAction.slice(0, 300)}`;
}
export async function handleOwnerPreview(options: { config: Config; store: Store; ai: AiClient; knowledge: string; facts?: SalonFacts }, job: EventJob): Promise<string> {
  const { config } = options;
  if (job.userId !== config.ownerId || job.event.source.type !== 'user' || job.event.source.userId !== config.ownerId || job.event.type !== 'message' || job.event.message?.type !== 'text') return '';
  const age = Date.now() - job.event.timestamp;
  if (!job.event.replyToken || age >= 50000 || age <= -60000) return '';
  if (config.mode !== 'test') return `${header}僅限測試模式（BOT_MODE=test）使用，未呼叫 AI。`;
  if (config.responseMode !== 'ai') return `${header}請先啟用 AI 回覆模式（RESPONSE_MODE=ai），未呼叫 AI。`;
  const question = job.event.message.text?.trim().replace(/^\/(?:preview|預覽)(?:\s+|$)/, '').trim() ?? '';
  if (!question) return `${header}用法：/preview 問題，或 /預覽 問題；最多1000字元。`;
  if (question.length > 1000) return `${header}問題最多1000字元，請縮短後再試；未呼叫 AI。`;
  if (job.attempts !== 1) return `${header}上次預覽處理曾中斷，為避免重複 API 用量，本次未重新呼叫。請確認後以新訊息再測。`;
  if (humanRequired(question)) return formatPreview(humanFallback(question, '請本人確認這項需求'), false);
  const reserved = await options.store.reserveOwnerPreview(job);
  if (reserved === 'rate_limited') return `${header}預覽限每10秒1次、24小時最多20次，包含失敗嘗試；本次未呼叫 AI。`;
  if (reserved !== 'allowed') return `${header}這次預覽已處理或租約失效，為避免重複用量未呼叫 AI。`;
  try {
    const result = await analyzeMessage({ ...options, text: question, history: [], bookingUrl: config.bookingUrl, receivedAt: job.receivedAt.toISOString() });
    return formatPreview(result, true);
  } catch (error) {
    const code = aiFailureCode(error);
    return `${header}預覽未成功（${code}）\n${failureHints[code]}`;
  }
}
