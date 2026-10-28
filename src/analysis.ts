import type { AiClient, AiInput, AiResult } from './types.js';
import { emptyFacts, type SalonFacts } from './knowledge.js';
import { applyPolicy, buildReplyPlan, extractRequest } from './policy.js';
import { buildNaturalContract } from './natural-plan.js';
import { checkSemanticReview, renderAtomicReply } from './reply-guard.js';
import { AiUnavailableError } from './clients/ai.js';

export async function analyzeMessage(options: { ai: AiClient; text: string; history: AiInput['history']; knowledge: string; facts?: SalonFacts; bookingUrl: string; receivedAt: string; handoff?: boolean }): Promise<AiResult> {
  const controller = new AbortController();
  const deadline = Date.now() + 19000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => {
    if (controller.signal.aborted || Date.now() >= deadline) {
      controller.abort();
      throw new AiUnavailableError('TIMEOUT');
    }
  };
  const work = async (): Promise<AiResult> => {
    const facts = options.facts ?? emptyFacts();
    const plan = options.handoff ? undefined : buildReplyPlan(options.text, options.bookingUrl, facts, options.history);
    const contract = plan ? buildNaturalContract(plan, options.text, facts, options.history, options.bookingUrl) : null;
    const value = await options.ai.generate({ text: options.text, history: options.history, handoff: options.handoff === true,
      knowledge: `${options.knowledge}\n已審閱的結構化資料：${facts.approved ? JSON.stringify(facts) : '尚未確認'}`, receivedAt: options.receivedAt,
      signal: controller.signal, ...(contract ? { replyPlan: contract } : {}) });
    active();
    if (options.handoff) return { ...extractRequest(value, options.text, options.history), replySource: 'handoff' };
    const safe = applyPolicy(value, options.text, options.knowledge, options.bookingUrl, facts, options.history, plan);
    const fallback: AiResult = { ...safe, replySource: 'policy_fallback',
      nextAction: safe.needsHuman ? safe.nextAction : '自然草稿未採用，使用本則核准安全簡答' };
    if (!contract || !plan || !options.ai.verify || value.needsHuman && !plan.result.needsHuman) return fallback;
    const candidate = renderAtomicReply(value.reply, contract);
    if (!candidate || Date.now() > deadline - 500) return fallback;
    try {
      active();
      const review = await options.ai.verify({ candidate, contract, text: options.text, history: options.history, signal: controller.signal });
      active();
      if (!checkSemanticReview(candidate, contract, review)) return fallback;
      return { ...plan.result, reply: candidate, replySource: 'natural_verified' };
    } catch (error) {
      active(); // A shared deadline must never adopt a late review or generate.
      return fallback;
    }
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new AiUnavailableError('TIMEOUT')); }, 19000);
    })]);
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
}
