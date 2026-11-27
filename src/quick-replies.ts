import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { LineEvent } from './types.js';

const schema = z.object({
  _note: z.string().optional(),
  skipExact: z.array(z.string().min(1).max(50)).max(100),
  entries: z.array(z.object({ id: z.string().min(1), price: z.boolean(), match: z.array(z.string().min(1)).min(1), text: z.string().min(1).max(1000) })).max(100),
}).strict();
export type QuickReplies = z.infer<typeof schema>;
export type QuickDecision = { kind: 'skip'; reason: 'menu_keyword' | 'sticker' } | { kind: 'reply'; id: string; text: string } | null;

/** Anything that needs judgement (dates, slots, changes, complaints, combos) is never auto-answered. */
const JUDGEMENT = /明天|後天|今天|今日|下週|下周|這週|這周|下禮拜|這禮拜|禮拜[一二三四五六日天]|週[一二三四五六日]|周[一二三四五六日]|星期[一二三四五六日天]|\d{1,2}\s*[\/月號日點:：]|空檔|空位|有位|有空|約得到|可以約|改|取消|遲到|晚到|延後|提早|退|客訴|過敏|受損|漂|縮毛|矯正|蓬|瀏海|壽星|生日|折|優惠|熟客|舊價|照片|圖片|適合|建議/;
const COMBO = /加|\+|＋|跟|和|一起|順便|還有|再/;
/** More than one service family (cut / perm / dye / treatment) in one message needs a person. */
const multiService = (text: string) => [/剪/, /燙/, /染/, /護髮/].filter(re => re.test(text)).length > 1;
export const QUICK_MAX_LENGTH = 40;
/** Any price wording. With prices off (default) such messages are always relayed, whatever else they ask. */
export const PRICE = /多少錢|價格|價位|價錢|費用|怎麼算|收費|報價|價目|幾塊|\$|\d+\s*元|多少(?!時間|小時|分鐘|個小時)/;

export async function loadQuickReplies(path: string): Promise<QuickReplies> {
  const data = schema.parse(JSON.parse(await readFile(path, 'utf8')));
  for (const entry of data.entries) for (const pattern of entry.match) new RegExp(pattern, 'i');
  return data;
}

export function decideQuickReply(rules: QuickReplies | undefined, event: LineEvent, options: { prices: boolean; skipStickers: boolean }): QuickDecision {
  if (event.message?.type === 'sticker') return options.skipStickers ? { kind: 'skip', reason: 'sticker' } : null;
  if (!rules || event.message?.type !== 'text') return null;
  const text = (event.message.text ?? '').trim();
  if (rules.skipExact.includes(text)) return { kind: 'skip', reason: 'menu_keyword' };
  if (!text || text.length > QUICK_MAX_LENGTH || JUDGEMENT.test(text) || multiService(text)) return null;
  if (!options.prices && PRICE.test(text)) return null;
  for (const entry of rules.entries) {
    if (entry.price && (!options.prices || COMBO.test(text))) continue;
    if (entry.match.some(pattern => new RegExp(pattern, 'i').test(text))) return { kind: 'reply', id: entry.id, text: entry.text };
  }
  return null;
}
