import type { AiClient, AiInput, AiResult } from './types.js';
import type { SalonFacts } from './knowledge.js';
import { applyPolicy, buildReplyPlan, extractRequest } from './policy.js';
import { AiUnavailableError } from './clients/ai.js';

export async function analyzeMessage(options: { ai: AiClient; text: string; history: AiInput['history']; knowledge: string; facts?: SalonFacts; bookingUrl: string; receivedAt: string; handoff?: boolean }): Promise<AiResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const plan = options.handoff ? undefined : buildReplyPlan(options.text, options.bookingUrl, options.facts, options.history);
    const value = await Promise.race([
      options.ai.generate({ text: options.text, history: options.history, handoff: options.handoff === true,
        knowledge: `${options.knowledge}\n已審閱的結構化資料：${options.facts?.approved ? JSON.stringify(options.facts) : '尚未確認'}`, receivedAt: options.receivedAt,
        ...(plan ? { replyPlan: { topic: plan.topic, claims: plan.claims, required: plan.required, missing: plan.missing } } : {}) }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AiUnavailableError('TIMEOUT')), 19000); }),
    ]);
    return options.handoff ? extractRequest(value, options.text, options.history) : applyPolicy(value, options.text, options.knowledge, options.bookingUrl, options.facts, options.history, plan);
  } finally { if (timer) clearTimeout(timer); }
}
