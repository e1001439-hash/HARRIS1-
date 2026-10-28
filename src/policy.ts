import { validateAnswer } from './clients/ai.js';
import type { AiInput, AiResult } from './types.js';
import { emptyFacts, type SalonFacts } from './knowledge.js';
import { resolveDialogueContext, type DialogueContext } from './dialogue-context.js';

export const humanRequired = (text: string) => /真人|本人|人工|髮型師|客訴|退款|過敏|頭皮受傷|染黑|受損|漂髮|漂頭髮/.test(text);
const priceQuestion = (text: string) => /價格|費用|多少|價錢|報價|收費|怎麼算|價目表|價單/.test(text);
const selfReported = (text: string) => /(?:已經|已|完成|好了).{0,6}預約|預約.{0,6}(?:好了|完成|成功)/.test(text);
const explicitBooking = (text: string) => /預約|(?:想|要|希望|改)約|約(?:週|星期|禮拜|今天|明天|後天|\d)|空檔|有空位|有位|有空/.test(text);
const wantsBookingLink = (text: string) => /(?:預約|網站|線上).{0,8}(?:連結|網址)|(?:連結|網址).{0,8}預約|怎麼線上預約/.test(text);
const thanks = (text: string) => /^(?:好[的喔唷啊～~\s]*|謝謝(?:你)?(?:喔|唷|啦)?|感謝(?:你)?)[！!。~～\s]*$/.test(text);
const unknownDetails = /訂金|定金|取消|退訂|改期規則|遲到|包含|包括|有含|含洗|含剪|含護|含什麼|多久|多少\s*(?:時間|分鐘|小時)|幾\s*小時|接髮|護髮|漂髮|挑染|設計染|刷卡|付款|照片|圖片|髮況|資格|認定|算不算|算(?:新客|會員)嗎|便宜|優惠/;
const injection = /忽略.{0,12}(?:規則|指令|系統)|(?:系統|system|developer).{0,12}(?:指令|prompt)|(?:API|api).{0,8}(?:key|金鑰)|設(?:成|為)店主|更改權限/;
const lengthLabels = { S: '男髮', M: '肩上', L: '胸上', XL: '胸下' };

export function humanFallback(text: string, reason = '需要本人確認'): AiResult {
  return { reply: '收到～這部分要由 Harris 幫你確認喔，先稍等一下 😊', summary: text.slice(0, 500) || '收到非文字訊息', service: null, requestedTime: null, bookingStatus: /預約/.test(text) ? 'requested' : 'none', needsHuman: true, nextAction: reason };
}
function requestFields(text: string, context: DialogueContext): Pick<AiResult, 'service' | 'requestedTime' | 'bookingStatus'> {
  const explicit = explicitBooking(text) && (!wantsBookingLink(text) || /(?:想|要|希望|幫我).{0,2}(?:預約|約)(?!連結|網址)|預約(?:剪|染|燙|明|後|今|週|星期|禮拜)/.test(text));
  const timeRequest = context.currentTime !== null && !priceQuestion(text) && !/營業|開門|開店|打烊|休假|公休|休息/.test(text);
  return {
    service: context.service,
    requestedTime: context.currentTime,
    bookingStatus: selfReported(text) ? 'self_reported' : thanks(text) ? 'none' : explicit || timeRequest ? 'requested' : 'none',
  };
}
export function extractRequest(value: unknown, text: string, history: AiInput['history'] = []): AiResult {
  const answer = validateAnswer(value);
  const context = resolveDialogueContext(text, history);
  const fields = requestFields(text, context);
  // Structured customer slots are grounded in source text, never assistant
  // suggestions or a model choosing an arbitrary substring as the new time.
  const requestedTime = fields.requestedTime;
  return { ...answer, ...fields, requestedTime, summary: text.slice(0, 500), nextAction: fields.bookingStatus === 'none' ? '請 Harris 查看本則補充' : '僅整理需求，時段與預約均待 Harris 確認' };
}
export interface DialoguePlan {
  claims: Record<string, string>;
  required: string[];
  topic: string;
  missing: string[];
  result: AiResult;
}
const money = (amount: number) => amount.toLocaleString('en-US');
function quote(context: DialogueContext, facts: SalonFacts): string | null {
  if (!facts.approved || !context.service) return null;
  if (context.service === '剪髮') return facts.haircutPrice ? `剪髮是 ${money(facts.haircutPrice)} 元` : null;
  if (!context.length) return null;
  const row = facts.priceTable?.find(item => item.service === context.service && item.length === context.length);
  if (!row) return null;
  const item = `${context.length}（${lengthLabels[context.length]}）${context.service}`;
  if (context.customerType === 'new') return `${item}的新客價是 ${money(row.newCustomer)} 元，已是折後金額`;
  if (context.customerType === 'member') return `${item}的會員價是 ${money(row.member)} 元，已是折後金額`;
  return `${item}，新客 ${money(row.newCustomer)} 元、會員 ${money(row.member)} 元，都是價目表列出的折後金額`;
}

export function buildReplyPlan(text: string, bookingUrl: string, facts: SalonFacts = emptyFacts(), history: AiInput['history'] = []): DialoguePlan {
  const context = resolveDialogueContext(text, history);
  const fields = requestFields(text, context);
  const base: AiResult = { ...fields, reply: '', summary: text.slice(0, 500), needsHuman: false, nextAction: '已依確認資料初步回覆，無需處理' };
  const make = (topic: string, claims: Record<string, string>, required = Object.keys(claims), patch: Partial<AiResult> = {}, missing: string[] = []): DialoguePlan => ({
    topic, claims, required, missing,
    result: { ...base, ...patch, reply: patch.reply ?? required.map(key => claims[key]).join('。') },
  });
  const handoff = (reason: string) => make('handoff', { handoff: facts.approved ? facts.voice.handoff : humanFallback(text).reply }, ['handoff'], { ...humanFallback(text, reason), ...fields });
  const ask = (slot: 'service' | 'length') => make('clarify', slot === 'service' ? { ask_service: '想問剪髮、染髮、燙髮，還是燙染呢？' } : { ask_length: '頭髮長度是男髮、肩上、胸上，還是胸下呢？' }, undefined, {}, [slot]);
  if (humanRequired(text) || unknownDetails.test(text) || injection.test(text)) return handoff('這個問題需要 Harris 確認');
  if (thanks(text)) return make('thanks', {}, [], { bookingStatus: 'none', requestedTime: null, reply: '不客氣～有需要再跟我說 😊' });
  if (/^(?:你好|嗨|哈囉|hello|hi)[！!。~～\s]*$/i.test(text)) return make('greeting', {}, [], { reply: '你好呀，有什麼想了解的呢？😊' });
  if (!facts.approved) return handoff('店務資料未核准，請 Harris 確認');
  const hoursQuestion = /營業|幾點|休假|休息|公休|開店|開門|打烊/.test(text);
  if (hoursQuestion) {
    const general = text.replace(/請問|想問|想知道|您好|你好|哈囉|你們|店裡|店家|一般|平常|通常|的|是|會|有|從|到|幾點|什麼時候|營業時間|營業|時間|開門|開店|打烊|開始|結束|呢|嗎|呀|啊|喔|剪髮|染髮|燙髮|燙染|[\s？?，,。！!～~]/gu, '').length === 0;
    const claims: Record<string, string> = facts.hours ? { hours: `一般營業時間是 ${facts.hours}` } : {};
    if (!general) claims.opening_pending = '這天是否營業或休假，需要由 Harris 確認';
    if (!facts.hours) return handoff('一般營業時間尚未核准');
    return make('hours', claims, undefined, { bookingStatus: explicitBooking(text) ? fields.bookingStatus : 'none', requestedTime: explicitBooking(text) ? fields.requestedTime : null,
      ...(general ? {} : { needsHuman: true, nextAction: '確認客人詢問日期是否營業；一般時段不代表該日已確認營業' }) });
  }
  if (/地址|在哪|店址|怎麼去|怎麼走|交通/.test(text)) return facts.address ? make('address', { address: `店家地址：${facts.address}` }) : handoff('店家地址或交通方式待 Harris 確認');
  const link: Record<string, string> = wantsBookingLink(text) ? { booking_link: `線上預約入口：${bookingUrl}` } : {};
  if (fields.bookingStatus === 'self_reported') return make('self_reported', { self_reported: '平台預約資訊仍需由 Harris 核對', ...link }, undefined, { needsHuman: true, nextAction: '核對客人自述的預約，尚未向平台核實' });
  if (fields.bookingStatus === 'requested') {
    const claims: Record<string, string> = {};
    const missing: string[] = [];
    const amount = priceQuestion(text) ? quote(context, facts) : null;
    if (amount) claims.quote = amount;
    if (context.currentTime) {
      claims.request = `想約的是${context.currentTime}${context.service ? `的${context.service}` : ''}`;
      claims.pending = '這個時段需由 Harris 確認，請稍等唷';
    } else { claims.ask_time = '有沒有希望預約的日期、時間呢？'; claims.pending = '預約安排需由 Harris 確認'; missing.push('time'); }
    if (!context.service) { claims.ask_service = '想預約哪一個服務項目呢？'; missing.push('service'); }
    Object.assign(claims, link);
    return make('booking', claims, undefined, { needsHuman: true, nextAction: '僅收到預約需求，請 Harris 確認服務與時段；尚未成立預約' }, missing);
  }
  // A pure link query is information, while mixed booking evidence above keeps
  // its fields and handoff. Never clear an appointment to provide a URL.
  if (wantsBookingLink(text)) return make('booking_link', link, undefined, { bookingStatus: 'none', requestedTime: null });
  const faq = facts.faqs.find(item => item.keywords.some(keyword => text.includes(keyword)));
  if (/價目表|價單/.test(text)) return make('menu', { menu: faq?.answer ?? '下方選單的價目表依頭髮長度列有新客與會員折後金額' });
  const followupSlot = /新客|會員|男髮|肩上|胸上|胸下|(?:改|換|變成).{0,8}(?:剪|染|燙|長度)|^(?:S|M|L|XL)[？?。\s]*$/i.test(text);
  if (priceQuestion(text) || followupSlot) {
    if (!context.service) return ask('service');
    if (context.service !== '剪髮' && !context.length) return ask('length');
    const amount = quote(context, facts);
    return amount ? make('price', { quote: amount }) : handoff('此項價格尚無核准資料，不沿用其他項目的報價');
  }
  if (faq) return make('faq', { faq: faq.answer });
  if (/項目|服務|可以做什麼/.test(text) && facts.services.length) return make('services', { services: `目前提供：${facts.services.map(item => item.name).join('、')}` });
  return handoff('無法確定本則問題，請 Harris 確認');
}

export function applyPolicy(value: unknown, text: string, _knowledge: string, bookingUrl: string, facts: SalonFacts = emptyFacts(), history: AiInput['history'] = [], prepared?: DialoguePlan): AiResult {
  const answer = validateAnswer(value);
  const plan = prepared ?? buildReplyPlan(text, bookingUrl, facts, history);
  if (answer.needsHuman && !plan.result.needsHuman) return { ...humanFallback(text, 'AI 判斷仍需 Harris 確認'), service: plan.result.service };
  // This synchronous path is the approved safety fallback. A natural draft is
  // sent only by analyzeMessage after independent semantic verification.
  return { ...plan.result };
}
