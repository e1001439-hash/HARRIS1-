export interface ReplyContract { claims: Record<string, string>; required: string[] }

const segments = new Intl.Segmenter('zh-TW', { granularity: 'grapheme' });
const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}/u;
const hiddenControl = (value: string): boolean => /[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\t]/gu, ''));

// Shared with the AI prompt. These are connective phrases, not complete reply
// templates; meaningful facts and questions can only come from trusted claims.
export const dialogueConnectives: readonly string[] = Object.freeze([
  '了解', '了解囉', '了解喔', '好', '好呀', '好喔', '好啊', '好的', '可以呀',
  '那就是', '這樣比較清楚一些', '慢慢考慮也可以', '慢慢想就好', '不客氣',
  '再跟我說就好', '有需要再跟我說', '有其他問題再跟我說喔',
  '你好', '你好呀', '嗨', '哈囉', '收到', '收到囉', '收到喔', '謝謝', '謝謝你',
]);
const orderedConnectives = [...dialogueConnectives].sort((a, b) => b.length - a.length);
const separator = /^[\s,.;:!~、。！；：…—–-]$/u;
const completeEmoji = /^😊$/u;

function reviewedConnectivesOnly(fragment: string): boolean {
  const value = fragment.normalize('NFKC');
  let offset = 0;
  while (offset < value.length) {
    const character = String.fromCodePoint(value.codePointAt(offset)!);
    if (separator.test(character)) { offset += character.length; continue; }
    const phrase = orderedConnectives.find(item => value.startsWith(item, offset));
    if (phrase) { offset += phrase.length; continue; }
    const grapheme = segments.segment(value.slice(offset))[Symbol.iterator]().next().value?.segment;
    if (!grapheme || !completeEmoji.test(grapheme)) return false;
    offset += grapheme.length;
  }
  return true;
}

export function renderGroundedReply(draft: string, contract: ReplyContract): string | null {
  if (typeof draft !== 'string' || !draft.trim() || draft.length > 800 || hiddenControl(draft)) return null;
  const keyPattern = /^[a-z][a-z0-9_]{0,39}$/u;
  if (new Set(contract.required).size !== contract.required.length || contract.required.some(key => !keyPattern.test(key) || !Object.hasOwn(contract.claims, key))) return null;
  const counts = new Map<string, number>();
  let valid = true;
  const rendered = draft.replace(/\{\{([^{}]*)\}\}/gu, (_match, key: string) => {
    if (!keyPattern.test(key) || !Object.hasOwn(contract.claims, key)) { valid = false; return ''; }
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const claim = contract.claims[key];
    if (typeof claim !== 'string' || !claim.trim()) { valid = false; return ''; }
    return claim;
  });
  const fragments = draft.split(/\{\{[^{}]*\}\}/u);
  const free = fragments.join('');
  if (!valid || /[{}]/u.test(free.normalize('NFKC')) || /[{}]/u.test(rendered.normalize('NFKC'))) return null;
  if ([...counts.values()].some(count => count !== 1) || contract.required.some(key => counts.get(key) !== 1)) return null;
  // Validate each literal fragment separately: removing placeholders or
  // punctuation first could turn "不{{pending}}客氣" into an allowed phrase.
  if (free.length > 180 || !fragments.every(reviewedConnectivesOnly)) return null;
  if (!rendered.trim() || rendered.length > 1500 || hiddenControl(rendered)) return null;
  if ([...segments.segment(rendered)].filter(part => emoji.test(part.segment)).length > 1) return null;
  return rendered;
}
