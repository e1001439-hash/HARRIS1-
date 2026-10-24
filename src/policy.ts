import { validateAnswer } from './clients/ai.js';
import type { AiResult } from './types.js';
import { emptyFacts, type SalonFacts } from './knowledge.js';

export const humanRequired = (text: string) => /真人|本人|人工|髮型師|客訴|退款|過敏|頭皮受傷|染黑|受損|漂髮|漂頭髮/.test(text);
export function humanFallback(text: string, reason = '需要本人確認'): AiResult {
  return { reply: '收到你的訊息，這部分需要由我本人確認，稍後再回覆你。', summary: text.slice(0, 500) || '收到非文字訊息', service: null, requestedTime: null, bookingStatus: /預約/.test(text) ? 'requested' : 'none', needsHuman: true, nextAction: reason };
}
export function applyPolicy(value: unknown, text: string, _knowledge: string, bookingUrl: string, facts: SalonFacts = emptyFacts()): AiResult {
  const answer = validateAnswer(value);
  // The model extracts intent; customer-visible facts/commitments come only from
  // reviewed structured facts and editable templates, never unrestricted prose.
  const voice = facts.approved ? facts.voice : emptyFacts().voice;
  const fallback = (reason: string) => ({ ...humanFallback(text, reason), reply: voice.handoff });
  answer.summary = text.slice(0, 500);
  if (answer.requestedTime && !text.includes(answer.requestedTime)) answer.requestedTime = null;
  if (answer.service && !text.includes(answer.service)) answer.service = null;
  const selfReported = /(?:已經|已|完成|好了).{0,6}預約|預約.{0,6}(?:好了|完成|成功)/.test(text);
  const availability = /(?:今天|明天|後天|週|星期|禮拜|上午|下午|晚上|\d{1,2}[月/:點]).*(?:可以|有空|有位|能)|空檔|有空位|約時間|約時段/.test(text);
  answer.bookingStatus = selfReported ? 'self_reported' : /預約/.test(text) || availability || answer.bookingStatus === 'requested' ? 'requested' : 'none';
  if (answer.bookingStatus === 'requested') {
    answer.reply = `收到你的預約需求！你可以先透過這個連結選擇項目與時段：\n${bookingUrl}\n是否預約成功，請以預約平台的確認結果為準。需要協助的部分會再由本人確認。`;
    answer.needsHuman = true; answer.nextAction = '確認客人是否仍需協助預約；目前僅收到需求';
    return answer;
  } else if (answer.bookingStatus === 'self_reported') {
    answer.reply = '收到你已在平台預約的訊息！我會再確認預約資訊，如需調整請告訴我。';
    answer.needsHuman = true; answer.nextAction = '核對客人自述的預約，尚未向平台核實';
    return answer;
  }
  if (answer.needsHuman) return fallback('這個問題需要本人確認');
  const known = (reply: string): AiResult => ({ ...answer, reply, needsHuman: false, nextAction: '已依確認資料回覆，無需處理' });
  if (/地址|在哪|店址|怎麼去|怎麼走|交通/.test(text)) return facts.approved && facts.address ? known(`店家地址：${facts.address}`) : fallback('店家地址或交通方式待本人確認');
  if (/營業|幾點|休假|休息|開店/.test(text)) return facts.approved && facts.hours ? known(`營業時間：${facts.hours}`) : fallback('營業時間待本人確認');
  if (/價格|費用|多少錢|價錢|報價|收費/.test(text)) {
    const service = facts.approved ? facts.services.find(item => text.includes(item.name)) : undefined;
    return service?.price ? known(`${service.name}：${service.price}`) : fallback('服務價格待本人確認');
  }
  if (facts.approved) {
    const faq = facts.faqs.find(item => item.keywords.some(keyword => text.includes(keyword)));
    if (faq) return known(faq.answer);
    if (/項目|服務|可以做什麼/.test(text) && facts.services.length) return known(`目前提供：${facts.services.map(item => item.name).join('、')}。`);
  }
  if (/^(?:你好|嗨|哈囉|hello|hi)[！!。~～\s]*$/i.test(text)) return known(voice.greeting);
  if (/^(?:謝謝|感謝)[！!。~～\s]*$/.test(text)) return known('不客氣，有需要再告訴我。');
  return fallback('尚無已確認的對應回覆，請本人處理並補充指南');
}
