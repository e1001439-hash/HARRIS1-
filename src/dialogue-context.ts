import type { AiInput } from './types.js';

export type HairService = '剪髮' | '染髮' | '燙髮' | '燙染';
export type HairLength = 'S' | 'M' | 'L' | 'XL';
export type CustomerType = 'new' | 'member';
export interface DialogueContext {
  service: HairService | null;
  length: HairLength | null;
  customerType: CustomerType | null;
  currentTime: string | null;
  bookingActive: boolean;
  ambiguous: boolean;
}
interface Mention<T> { value: T; index: number; end: number }
interface Slot<T> { value: T | null; ambiguous: boolean }

function uncertainMention<T>(text: string, mention: Mention<T>, start = 0): boolean {
  const before = text.slice(Math.max(start, mention.index - 8), mention.index);
  const after = text.slice(mention.end, mention.end + 8);
  return /不是|不要|不想|不做|不再|不確定|不知道|沒有/.test(before) || /非\s*$/.test(before)
    || /^\s*(?:先|暫時|目前)?(?:不要|不做|不想|不用|不是|沒有)/.test(after);
}

function readSlot<T>(text: string, mentions: Mention<T>[]): Slot<T> | null {
  if (!mentions.length) return null;
  // Only a clear correction whose tail mentions this slot replaces its earlier
  // alternatives. Unresolved choices and negations are never last-match wins.
  let start = 0;
  for (const match of text.matchAll(/改成|改|換成|換|更正(?:為|成)?|其實是|[，,;；]\s*(?:是|要|想要)/g)) {
    const tail = match.index + match[0].length;
    if (mentions.some(mention => mention.index >= tail)) start = tail;
  }
  const active = mentions.filter(mention => mention.index >= start);
  const unique = [...new Set(active.map(mention => mention.value))];
  const uncertain = active.some(mention => uncertainMention(text, mention, start));
  return unique.length !== 1 || uncertain ? { value: null, ambiguous: true } : { value: unique[0]!, ambiguous: false };
}

function serviceSlot(text: string): Slot<HairService> | null {
  if (/護髮|接髮|漂髮|挑染|設計染/.test(text)) return { value: null, ambiguous: true };
  const servicePattern = /燙染|剪髮|剪頭髮|染髮|染頭髮|燙髮|燙頭髮/g;
  // A terse or unsupported service change must not leave an earlier service
  // silently selected. Ask again instead of quoting that stale service.
  if (/剪|染|燙/.test(text.replace(servicePattern, ''))) return { value: null, ambiguous: true };
  const mentions = [...text.matchAll(servicePattern)].map(match => ({
    value: (match[0] === '燙染' ? '燙染' : `${match[0][0]}髮`) as HairService,
    index: match.index, end: match.index + match[0].length,
  }));
  return readSlot(text, mentions);
}

function lengthSlot(text: string): Slot<HairLength> | null {
  const names: Record<string, HairLength> = { 男髮: 'S', 肩上: 'M', 胸上: 'L', 胸下: 'XL', S: 'S', M: 'M', L: 'L', XL: 'XL' };
  const mentions = [...text.matchAll(/男髮|肩上|胸上|胸下|(?<![A-Za-z])(?:XL|S|M|L)(?![A-Za-z])/gi)].map(match => ({ value: names[match[0].toUpperCase()]!, index: match.index, end: match.index + match[0].length }));
  if (/肩下|耳上|耳下|及肩|腰|長髮|短髮/.test(text) || mentions.length && /大概|左右|差不多|不確定|不清楚/.test(text)) return { value: null, ambiguous: true };
  return readSlot(text, mentions);
}

function customerSlot(text: string): Slot<CustomerType> | null {
  const mentions = [...text.matchAll(/新客|第一次來|第一次去|會員/g)].map(match => ({
    value: (match[0] === '會員' ? 'member' : 'new') as CustomerType,
    index: match.index, end: match.index + match[0].length,
  }));
  if (mentions.length && /(?:算|是)(?:不|否)?(?:新客|會員)嗎|資格|認定|怎麼分|算不算/.test(text)) return { value: null, ambiguous: true };
  if (!mentions.length && /舊客|老客/.test(text)) return { value: null, ambiguous: true };
  const parsed = readSlot(text, mentions);
  if (!parsed || parsed.ambiguous) return parsed;
  // Merely asking about a group's prices never changes the guest's identity.
  // Accept an explicit self-statement, a direct choice, or a clear correction.
  const affirmed = mentions.some(mention => {
    if (mention.value !== parsed.value) return false;
    const before = text.slice(0, mention.index);
    const clause = before.split(/[，,。;；！？!?]/).at(-1)!.trim();
    const after = text.slice(mention.end);
    const selfStatement = /^(?:這次|那|好|好的)?我(?:是|有|選(?:擇)?|用)\s*$/.test(clause);
    const directChoice = /^(?:那就|就|選(?:擇)?|用|以)?\s*$/.test(clause) && /^[\s喔哦唷啦呀啊呢的。！!～~]*$/.test(after);
    const correction = /(?:改成|換成|其實是|[，,;；]\s*是)\s*$/.test(before);
    return selfStatement || directChoice || correction;
  });
  return affirmed ? parsed : null;
}

const day = '(?:(?:本|這|下|下下)(?:個)?(?:週|星期|禮拜)[一二三四五六日天]|(?:週|星期|禮拜)[一二三四五六日天]|今天|明天|後天|(?:\\d{1,2}月)?\\d{1,2}(?:日|號)|\\d{1,2}[/-]\\d{1,2})';
const period = '(?:早上|上午|中午|下午|晚上|傍晚)';
const clock = '(?:(?:[01]?\\d|2[0-3])[:：][0-5]\\d|[零〇一二兩三四五六七八九十\\d]{1,3}\\s*點(?:半|[零〇一二兩三四五六七八九十\\d]{1,3}分)?)';
function timeFrom(text: string): { time: string | null; ambiguous: boolean } {
  const explicit = [...text.matchAll(new RegExp(`(?:${day}\\s*)?(?:${period}\\s*)?${clock}`, 'g'))];
  const dates = [...text.matchAll(new RegExp(`${day}(?:\\s*${period})?`, 'g'))]
    .filter(date => !explicit.some(time => date.index >= time.index && date.index + date[0].length <= time.index + time[0].length));
  const mentions = [...explicit, ...dates].map(match => ({ value: match[0].trim(), index: match.index, end: match.index + match[0].length }));
  // A repeated bare day referring to an already detailed time is not another
  // alternative ("明天下午…明天有營業嗎"). Keep the raw, more precise span.
  const precise = mentions.filter(mention => uncertainMention(text, mention)
    || !mentions.some(other => other.value !== mention.value
      && other.value.replace(/\s/g, '').includes(mention.value.replace(/\s/g, ''))));
  const result = readSlot(text, precise);
  return { time: result?.value ?? null, ambiguous: result?.ambiguous ?? false };
}

export function resolveDialogueContext(text: string, history: AiInput['history']): DialogueContext {
  let service: Slot<HairService> = { value: null, ambiguous: false };
  let length: Slot<HairLength> = { value: null, ambiguous: false };
  let customer: Slot<CustomerType> = { value: null, ambiguous: false };
  let bookingActive = false;
  for (const turn of [...history.slice(-10).filter(turn => turn.role === 'user').map(turn => turn.content), text]) {
    service = serviceSlot(turn) ?? service;
    length = lengthSlot(turn) ?? length;
    customer = customerSlot(turn) ?? customer;
    if (/(?:不|不用|不要|取消).{0,3}預約/.test(turn)) bookingActive = false;
    else if (/預約|(?:想|要|希望|改)約/.test(turn) || timeFrom(turn).time !== null) bookingActive = true;
  }
  const current = timeFrom(text);
  return {
    service: service.value, length: length.value, customerType: customer.value,
    currentTime: current.time, bookingActive,
    ambiguous: service.ambiguous || length.ambiguous || customer.ambiguous || current.ambiguous,
  };
}
