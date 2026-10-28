import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessage } from '../src/analysis.js';
import { loadFacts } from '../src/knowledge.js';
import { AiUnavailableError } from '../src/clients/ai.js';
import type { AiClient, AiInput, AiResult } from '../src/types.js';
import type { SemanticFact, SemanticReview, VerificationInput } from '../src/reply-guard.js';

const facts = await loadFacts('knowledge/facts.json');
const base: AiResult = { reply: '草稿', summary: '生成器不可替自己的句子背書', service: null, requestedTime: null, bookingStatus: 'none', needsHuman: false, nextAction: '' };
const settings = { knowledge: '僅核准店務事實', facts, bookingUrl: 'https://harrishair.tw', receivedAt: '2026-10-28T03:00:00Z' };
const history: AiInput['history'] = [{ role: 'user', content: '胸上染髮多少？' }];
const fact = (kind: SemanticFact['kind'], value: string, patch: Partial<SemanticFact> = {}): SemanticFact => ({ kind, service: null, length: null, audience: null, value, polarity: 'affirmed', ...patch });
const price = (audience: string, value: string, service = '染髮', length: string | null = 'L') => fact('price', value, { service, length, audience });
const colourPrices = [price('new', '2780'), price('member', '2910'), fact('price_basis', 'already_discounted')];

// Hand-authored semantic fixtures describe these exact fake drafts. They do
// not copy the production contract and do not stand for real-model accuracy.
function report(candidate: string, list: SemanticFact[] = [], questions: string[] = [], patch: Partial<SemanticReview> = {}): SemanticReview {
  return { verdict: 'supported', complete: true, facts: list.map(value => ({ ...value, evidence: candidate })),
    questions: questions.map(slot => ({ slot, evidence: candidate })), actions: [], persona: 'assistant', issues: [], ...patch };
}
async function run(text: string, draft: string, options: { history?: AiInput['history']; review?: (input: VerificationInput) => SemanticReview | Promise<SemanticReview>; omitVerifier?: boolean } = {}) {
  const generated: AiInput[] = [], reviewed: VerificationInput[] = [];
  const ai: AiClient = { async generate(input) { generated.push(input); return { ...base, reply: draft }; } };
  if (!options.omitVerifier) ai.verify = async input => { reviewed.push(input); return options.review ? options.review(input) : report(input.candidate); };
  const result = await analyzeMessage({ ...settings, ai, text, history: options.history ?? [] });
  return { result, generated, reviewed };
}

test('不同未列舉自然句與順序可原句保留，僅金額原子由程式填值', async () => {
  const cases = [
    ['胸上的長度會看 L 喔，新客染髮折後是 {{price_new}} 元，會員則是 {{price_member}} 元 😊', '胸上的長度會看 L 喔，新客染髮折後是 2,780 元，會員則是 2,910 元 😊'],
    ['會員折後為 {{price_member}} 元；如果是第一次來，胸上 L 的染髮則是 {{price_new}} 元～', '會員折後為 2,910 元；如果是第一次來，胸上 L 的染髮則是 2,780 元～'],
    ['這個髮長的染髮，新朋友 {{price_new}} 元、會員 {{price_member}} 元，價目表已經列好折後金額囉。', '這個髮長的染髮，新朋友 2,780 元、會員 2,910 元，價目表已經列好折後金額囉。'],
  ];
  for (const [draft, expected] of cases) {
    const f = await run('胸上染髮多少？', draft!, { review: input => report(input.candidate, colourPrices) });
    assert.equal(f.result.reply, expected); assert.equal(f.result.replySource, 'natural_verified');
    assert.equal(f.generated.length, 1); assert.equal(f.reviewed.length, 1);
    assert.equal(f.reviewed[0]!.candidate, expected); assert.equal('summary' in f.reviewed[0]!, false);
    assert.equal(f.generated[0]!.replyPlan?.atoms.price_new, '2,780');
    assert.equal(f.result.service, '染髮'); assert.equal(f.result.needsHuman, false);
  }
});

test('只問缺少髮長的自然同義問句，不依賴ask_length整句插槽', async () => {
  for (const draft of ['方便告訴我目前髮尾大約到哪裡嗎？', '我想先確認一下，你現在是肩上、胸上，還是胸下的長度呢？']) {
    const f = await run('染髮多少？', draft, { review: input => report(input.candidate, [], ['length']) });
    assert.equal(f.result.reply, draft); assert.equal(f.result.replySource, 'natural_verified');
    assert.deepEqual(f.generated[0]!.replyPlan?.requiredQuestions, ['length']);
    assert.doesNotMatch(f.result.reply, /預約|http|\{\{/);
  }
});

test('謝謝的自然收尾與開場開放問句可通過，沒有固定禮貌詞清單', async () => {
  for (const draft of ['不用客氣呀，希望這些資訊有幫上忙 😊', '慢慢考慮就好，有想到其他問題再聊也沒關係～']) {
    const f = await run('謝謝你喔', draft, { history, review: input => report(input.candidate) });
    assert.equal(f.result.reply, draft); assert.equal(f.result.replySource, 'natural_verified');
    assert.equal(f.result.bookingStatus, 'none'); assert.doesNotMatch(f.result.reply, /預約|http/);
  }
  const opening = '嗨，很高興收到你的訊息，今天想了解哪方面呢？';
  const f = await run('你好', opening, { review: input => report(input.candidate, [], ['help_topic']) });
  assert.equal(f.result.reply, opening); assert.equal(f.result.replySource, 'natural_verified');
});

test('剪髮自然完整句保留，避免那就是剪髮是的不自然串接', async () => {
  const draft = '改剪髮的話，費用就是 {{price}} 元喔 😊';
  const f = await run('那改成剪髮呢？', draft, { history, review: input => report(input.candidate, [fact('price', '700', { service: '剪髮' })]) });
  assert.equal(f.result.reply, '改剪髮的話，費用就是 700 元喔 😊');
  assert.equal(f.result.replySource, 'natural_verified'); assert.doesNotMatch(f.result.reply, /那就是剪髮是|預約/);
});

test('正確兩價交換客群也不能因核驗器回supported而被放行', async () => {
  const f = await run('胸上染髮多少？', '新客是 {{price_member}} 元，會員是 {{price_new}} 元。', {
    review: input => report(input.candidate, [price('new', '2910'), price('member', '2780')]),
  });
  assert.equal(f.reviewed.length, 1); assert.equal(f.result.replySource, 'policy_fallback');
  assert.doesNotMatch(f.result.reply, /新客是 2,910|會員是 2,780/);
  assert.match(f.result.reply, /2,780.*2,910/);
});

test('錯價或未知原子在機械層拒絕，不能用未核驗自然文字對客人報價', async () => {
  for (const draft of ['新客只要2224元，會員{{price_member}}元。', '新客{{price_new}}元，會員{{not_allowed}}元。']) {
    const f = await run('胸上染髮多少？', draft, { review: () => { assert.fail('invalid atom draft must not consume a verification call'); } });
    assert.equal(f.result.replySource, 'policy_fallback'); assert.doesNotMatch(f.result.reply, /2224|not_allowed|\{\{/);
    assert.match(f.result.reply, /2,780.*2,910/);
  }
});

test('核驗抽到假通知、未來承諾、能力或敲定時一律不用自然草稿', async () => {
  const cases = [
    ['已替你通知 Harris 囉。', 'notification', 'done'],
    ['我會幫你把需求備註給 Harris。', 'note', 'promised'],
    ['這個時間已經替你敲定了。', 'confirm_booking', 'done'],
    ['我能直接查到你線上預約的結果。', 'external_lookup', 'capability'],
  ] as const;
  for (const [draft, kind, mode] of cases) {
    const f = await run('謝謝', draft, { review: input => report(input.candidate, [], [], { actions: [{ kind, mode, evidence: input.candidate }] }) });
    assert.equal(f.result.replySource, 'policy_fallback'); assert.notEqual(f.result.reply, draft);
    assert.doesNotMatch(f.result.reply, /已替你通知|會幫你|敲定|直接查到/);
  }
});

test('核驗辨識價格否定、再折扣與特定日期營業後不放行', async () => {
  const negative = await run('胸上染髮多少？', '新客不是 {{price_new}} 元，會員則是 {{price_member}} 元。', { review: input => report(input.candidate, [price('new', '2780', '染髮'), price('member', '2910')].map((value, index) => index ? value : { ...value, polarity: 'negated' })) });
  assert.equal(negative.result.replySource, 'policy_fallback'); assert.doesNotMatch(negative.result.reply, /新客不是/);
  const discount = await run('胸上染髮多少？', '新客{{price_new}}元、會員{{price_member}}元，這些還能再打折。', { review: input => report(input.candidate, [price('new', '2780'), price('member', '2910'), fact('price_basis', 'discount_again')]) });
  assert.equal(discount.result.replySource, 'policy_fallback'); assert.doesNotMatch(discount.result.reply, /還能再打折/);
  const dated = await run('一般營業時間？', '明天照常營業，時段是{{hours}}。', { review: input => report(input.candidate, [fact('general_hours', '11:00–18:00'), fact('other', 'tomorrow_open')]) });
  assert.equal(dated.result.replySource, 'policy_fallback'); assert.doesNotMatch(dated.result.reply, /明天照常營業/);
});

test('有完整價格的回覆不能額外追問預約，核驗缺項問錯也要降級', async () => {
  const extra = await run('胸上染髮多少？', '新客{{price_new}}元、會員{{price_member}}元，你想預約什麼時間呢？', { review: input => report(input.candidate, [price('new', '2780'), price('member', '2910')], ['time']) });
  assert.equal(extra.result.replySource, 'policy_fallback'); assert.doesNotMatch(extra.result.reply, /預約什麼時間/);
  const missing = await run('染髮多少？', '想問哪個服務呢？', { review: input => report(input.candidate, [], ['service']) });
  assert.equal(missing.result.replySource, 'policy_fallback'); assert.match(missing.result.reply, /長度|肩上|胸上/);
});

test('沒有核驗器或核驗失敗不把草稿標成自然成功', async () => {
  const draft = '新客{{price_new}}元、會員{{price_member}}元。';
  const absent = await run('胸上染髮多少？', draft, { omitVerifier: true });
  assert.equal(absent.result.replySource, 'policy_fallback');
  const failed = await run('胸上染髮多少？', draft, { review: async () => { throw new Error('PRIVATE_FAKE_REVIEW_FAILURE'); } });
  assert.equal(failed.result.replySource, 'policy_fallback'); assert.doesNotMatch(failed.result.reply, /PRIVATE_FAKE/);
  for (const patch of [{ complete: false }, { verdict: 'uncertain' as const }, { facts: [] }, { persona: 'harris' as const }, { issues: ['unverified'] }]) {
    const f = await run('胸上染髮多少？', draft, { review: input => report(input.candidate, [price('new', '2780'), price('member', '2910')], [], patch) });
    assert.equal(f.result.replySource, 'policy_fallback');
  }
});

test('核驗evidence不在候選句或抽取未知內容，不能只靠supported通過', async () => {
  const draft = '新客{{price_new}}元、會員{{price_member}}元。';
  const f = await run('胸上染髮多少？', draft, { review: input => report(input.candidate, [price('new', '2780'), price('member', '2910')], [], { facts: [{ ...price('new', '2780'), evidence: '不存在的核准敘述' }] }) });
  assert.equal(f.result.replySource, 'policy_fallback');
});

test('共享deadline真的abort，遲到生成結果不再啟動核驗或對客送出', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined, finish!: (value: AiResult) => void, reviews = 0;
  const waiting = new Promise<AiResult>(resolve => { finish = resolve; });
  const pending = analyzeMessage({ ...settings, text: '胸上染髮多少？', history: [], ai: {
    async generate(input) { signal = input.signal; return waiting; },
    async verify(input) { reviews++; return report(input.candidate); },
  } });
  const rejection = assert.rejects(pending, error => error instanceof AiUnavailableError && error.code === 'TIMEOUT');
  t.mock.timers.tick(19001);
  await rejection; assert.equal(signal?.aborted, true);
  finish({ ...base, reply: '新客{{price_new}}元、會員{{price_member}}元。' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(reviews, 0);
});

test('事件迴圈尚未執行timer時也不能採用已超過deadline的核驗', async t => {
  let now = Date.now(), signal: AbortSignal | undefined;
  t.mock.method(Date, 'now', () => now);
  await assert.rejects(() => analyzeMessage({ ...settings, text: '胸上染髮多少？', history: [], ai: {
    async generate() { return { ...base, reply: '新客{{price_new}}元、會員{{price_member}}元。' }; },
    async verify(input) { signal = input.signal; now += 20000; return report(input.candidate, colourPrices); },
  } }), error => error instanceof AiUnavailableError && error.code === 'TIMEOUT');
  assert.equal(signal?.aborted, true);
});
