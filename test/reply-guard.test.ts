import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAtomicReply, checkSemanticReview } from '../src/reply-guard.js';
import type { NaturalContract, SemanticFact, SemanticReview } from '../src/reply-guard.js';

// These reports are manually authored mock semantic extractions. They prove
// the protocol/canonical boundary, not a real model's extraction accuracy.
const price = (audience: string, value: string): SemanticFact => ({ kind: 'price', service: '染髮', length: 'L', audience, value, polarity: 'affirmed' });
const newPrice = price('new', '2780'), memberPrice = price('member', '2910');
const contract: NaturalContract = {
  topic: 'price', atoms: { price_new: '2,780', price_member: '2,910' }, requiredAtoms: ['price_new', 'price_member'],
  allowedFacts: [newPrice, memberPrice, { kind: 'price_basis', service: null, length: null, audience: null, value: 'already_discounted', polarity: 'affirmed' }],
  requiredFacts: [newPrice, memberPrice], allowedQuestions: [], requiredQuestions: [],
};
function render(draft: string, policy: NaturalContract = contract): string | null {
  return renderAtomicReply(draft, policy);
}
function check(candidate: string, policy: NaturalContract, review: unknown): boolean {
  return checkSemanticReview(candidate, policy, review);
}
function report(candidate: string, facts: SemanticFact[] = [newPrice, memberPrice]): SemanticReview {
  return { verdict: 'supported', complete: true, facts: facts.map(fact => ({ ...fact, evidence: candidate })), questions: [], actions: [], persona: 'assistant', issues: [] };
}
const candidate = '胸上就是 L 囉，染髮新客折後 2,780 元，會員是 2,910 元。';

test('沒有預先白名單的自然同義句與順序可以保留，金額只替換原子值', () => {
  const drafts = [
    ['胸上就是 L 囉，染髮新客折後 {{price_new}} 元，會員是 {{price_member}} 元。', candidate],
    ['若以會員身分看是 {{price_member}} 元；第一次來則是 {{price_new}} 元，這兩個都是胸上染髮的價位 😊', '若以會員身分看是 2,910 元；第一次來則是 2,780 元，這兩個都是胸上染髮的價位 😊'],
    ['我幫你對一下胸上染髮的價目：新客 {{price_new}}、會員 {{price_member}} 元，表內已經折過囉。', '我幫你對一下胸上染髮的價目：新客 2,780、會員 2,910 元，表內已經折過囉。'],
  ];
  for (const [draft, expected] of drafts) assert.equal(render(draft!), expected);
});

test('追問怎麼說與致謝收尾不使用片語或整句插槽', () => {
  const clarify: NaturalContract = { topic: 'clarify', atoms: {}, requiredAtoms: [], allowedFacts: [], requiredFacts: [], allowedQuestions: ['length'], requiredQuestions: ['length'] };
  for (const text of ['方便說一下頭髮現在大概到哪裡嗎？', '你目前的髮長比較接近肩膀，還是胸口呢？']) assert.equal(render(text, clarify), text);
  const closing = { ...clarify, topic: 'thanks', allowedQuestions: [], requiredQuestions: [] };
  for (const text of ['不用客氣呀，希望有幫上忙 😊', '好喔，慢慢想，有想法再聊～']) assert.equal(render(text, closing), text);
});

test('缺項問句與開放開場依語意slot核驗，不限定字面問法', () => {
  const policy: NaturalContract = { topic: 'clarify', atoms: {}, requiredAtoms: [], allowedFacts: [], requiredFacts: [], allowedQuestions: ['length'], requiredQuestions: ['length'] };
  const text = '方便說一下頭髮現在大概到哪裡嗎？';
  const review = { ...report(text, []), questions: [{ slot: 'length', evidence: text }] };
  assert.equal(check(text, policy, review), true);
  assert.equal(check(text, policy, { ...review, questions: [] }), false);
  assert.equal(check(text, policy, { ...review, questions: [{ slot: 'time', evidence: text }] }), false);
  const greeting = { ...policy, topic: 'greeting', allowedQuestions: ['help_topic'], requiredQuestions: [] };
  const hello = '嗨，今天想了解哪方面的髮型問題呢？';
  assert.equal(check(hello, greeting, { ...report(hello, []), questions: [{ slot: 'help_topic', evidence: hello }] }), true);
});

test('完整且逐項吻合的語意報告可通過，價格千分逗號可標準化', () => {
  assert.equal(check(candidate, contract, report(candidate)), true);
  assert.equal(check(candidate, contract, report(candidate, [price('new', '2,780'), price('member', '2,910')])), true);
});

test('兩個正確價格交換客群，即使報supported仍不能通過', () => {
  const swapped = '胸上染髮新客 2,910 元，會員 2,780 元。';
  assert.equal(check(swapped, contract, report(swapped, [price('new', '2910'), price('member', '2780')])), false);
});

test('報錯價、錯項目、錯長度、未確認身分或再次折扣均不在核准facts', () => {
  for (const invalid of [price('new', '2224'), { ...newPrice, service: '燙髮' }, { ...newPrice, length: 'M' }, { ...newPrice, audience: 'vip' }, { kind: 'price_basis', service: null, length: null, audience: null, value: 'discount_again_80_percent', polarity: 'affirmed' } satisfies SemanticFact]) {
    assert.equal(check(candidate, contract, report(candidate, [invalid, memberPrice])), false);
  }
});

for (const [label, kind, mode, claim] of [
  ['已通知', 'notification', 'done', 'Harris已經收到訊息了。'],
  ['將代為通知', 'notification', 'promised', '我會幫你通知Harris。'],
  ['已備註', 'note', 'done', '剛剛幫你備註好了。'],
  ['已預約成功', 'booking', 'done', '已替你約好了。'],
  ['能直接保留', 'availability', 'capability', '這時段我能直接替你保留。'],
  ['動作不明', 'other', 'uncertain', '這個我幫你處理就好。'],
] as const) {
  test(`語意抽取${label}時不能因價格正確或supported而放行`, () => {
    const text = `${candidate}${claim}`;
    assert.equal(check(text, contract, { ...report(text), actions: [{ kind, mode, evidence: claim }] }), false);
  });
}

test('固定待Harris確認可作例外原子值，反轉或否定不能通過核驗', () => {
  const pending: SemanticFact = { kind: 'requires_harris', service: null, length: null, audience: null, value: 'booking', polarity: 'affirmed' };
  const policy: NaturalContract = { topic: 'booking', atoms: { pending: '這個時段需由 Harris 確認，請稍等唷' }, requiredAtoms: ['pending'], allowedFacts: [pending], requiredFacts: [pending], allowedQuestions: [], requiredQuestions: [] };
  const good = '週六兩點的染髮需求我理解了。{{pending}}';
  const rendered = '週六兩點的染髮需求我理解了。這個時段需由 Harris 確認，請稍等唷';
  assert.equal(render(good, policy), rendered);
  assert.equal(check(rendered, policy, report(rendered, [pending])), true);
  const reversed = '這個時段需由 Harris 確認，請稍等唷才怪。';
  assert.equal(render('{{pending}}才怪。', policy), reversed, '原子檢查本身不是語意黑名單');
  assert.equal(check(reversed, policy, report(reversed, [{ ...pending, polarity: 'negated' }])), false);
  assert.equal(check(reversed, policy, { ...report(reversed, [pending]), verdict: 'unsupported', issues: ['contradicted_confirmation'] }), false);
});

test('一般營業時間不能被抽成特定日開店或否定原事實', () => {
  const hours: SemanticFact = { kind: 'general_hours', service: null, length: null, audience: null, value: '11:00–18:00', polarity: 'affirmed' };
  const policy: NaturalContract = { topic: 'hours', atoms: { hours: '11:00–18:00' }, requiredAtoms: ['hours'], allowedFacts: [hours], requiredFacts: [hours], allowedQuestions: [], requiredQuestions: [] };
  const text = '明天照常營業，時段是 11:00–18:00。';
  assert.equal(check(text, policy, report(text, [{ ...hours, kind: 'other', value: 'tomorrow_open' }])), false);
  assert.equal(check(text, policy, report(text, [{ ...hours, polarity: 'negated' }])), false);
});

test('缺少必須事實、未完整核驗、不確定、帶issues與冒充Harris均保守拒絕', () => {
  for (const patch of [
    { facts: [] }, { facts: [{ ...newPrice, evidence: candidate }] }, { complete: false }, { verdict: 'uncertain' },
    { verdict: 'unsupported' }, { issues: ['unreviewed_statement'] }, { persona: 'harris' }, { persona: 'uncertain' },
  ]) assert.equal(check(candidate, contract, { ...report(candidate), ...patch }), false);
});

test('核驗報告必須schema正確，不接受額外safe=true或超量/缺漏欄位', () => {
  for (const bad of [null, true, { safe: true }, { ...report(candidate), safe: true }, { ...report(candidate), complete: 'true' }, { ...report(candidate), actions: [{ kind: 'notify', mode: 'maybe', evidence: candidate }] }, { ...report(candidate), facts: Array(40).fill({ ...newPrice, evidence: candidate }) }]) {
    assert.equal(check(candidate, contract, bad), false);
  }
});

test('每個fact與question的evidence須在實際候選句中存在，不能空白或只截數字', () => {
  for (const evidence of ['', ' ', '不在候選句的價格', '2,780', '胸上就是 L 囉']) {
    const review = report(candidate); review.facts[0]!.evidence = evidence;
    assert.equal(check(candidate, contract, review), false, evidence);
  }
  const thanks: NaturalContract = { topic: 'thanks', atoms: {}, requiredAtoms: [], allowedFacts: [], requiredFacts: [], allowedQuestions: [], requiredQuestions: [] };
  assert.equal(check('謝謝囉', thanks, { ...report('謝謝囉', []), questions: [{ slot: 'time', evidence: '假的問題' }] }), false);
});

test('未知facts與未被允許的額外問題不能混入正確報價', () => {
  const extra: SemanticFact = { kind: 'other', service: null, length: null, audience: null, value: 'no_deposit', polarity: 'affirmed' };
  assert.equal(check(candidate, contract, report(candidate, [newPrice, memberPrice, extra])), false);
  assert.equal(check(candidate, contract, { ...report(candidate), questions: [{ slot: 'time', evidence: candidate }] }), false);
});

test('原子值必填、未知、重複、原型key與破損placeholder均拒絕', () => {
  for (const draft of ['新客{{price_new}}', '{{price_new}}{{price_member}}{{price_new}}', '{{price_new}}{{price_member}}{{unknown}}', '{{price_new}}{{price_member}}{{toString}}', '{{price_new}}{{price_member}} {pending}', '{{price_new}}{{price_member}} {{PRICE_NEW}}', '{{price_new}}{{price_member}} ｛｛price_new｝｝']) assert.equal(render(draft), null, draft);
});

test('不能在原子外另打錯價、Unicode數字、網址或中文貨幣金額', () => {
  for (const suffix of ['其實2224元', '２２２４元', '二千元', '一元', '再打八折', 'https://evil.invalid', 'www.evil.invalid']) assert.equal(render(`新客{{price_new}}、會員{{price_member}}。${suffix}`), null, suffix);
});

test('URL只從允許的原子值插入，普通英文Harris與L不被當成違規說法', () => {
  const policy: NaturalContract = { topic: 'booking_link', atoms: { booking_url: 'https://harrishair.tw' }, requiredAtoms: ['booking_url'], allowedFacts: [], requiredFacts: [], allowedQuestions: [], requiredQuestions: [] };
  const draft = 'Harris 的預約頁在這邊：{{booking_url}}，你可以自行挑方便的時段。';
  assert.equal(render(draft, policy), 'Harris 的預約頁在這邊：https://harrishair.tw，你可以自行挑方便的時段。');
});

test('隱藏字元、巢狀原子、無界文字與不合約定的emoji仍有機械界線', () => {
  for (const draft of ['{{price_new}}{{price_member}}\u200b', '{{price_new}}{{price_member}}\u202e', '{{price_new}}{{price_member}}\u0000', '{{price_new}}{{price_member}}😊😊', '{{price_new}}{{price_member}}👎', '啊'.repeat(1300) + '{{price_new}}{{price_member}}']) assert.equal(render(draft), null);
  assert.equal(render('{{price_new}}{{price_member}}', { ...contract, atoms: { ...contract.atoms, price_new: '{{nested}}' } }), null);
  assert.equal(render('', { ...contract, atoms: {}, requiredAtoms: [] }), null);
});

test('價格evidence必須包含同一完整金額，不能用其他金額的子字串偽證', () => {
  const haircut: SemanticFact = { kind: 'price', service: '剪髮', length: null, audience: null, value: '700', polarity: 'affirmed' };
  const policy: NaturalContract = { topic: 'price', atoms: { haircut: '700' }, requiredAtoms: ['haircut'], allowedFacts: [haircut], requiredFacts: [haircut], allowedQuestions: [], requiredQuestions: [] };
  const wrong = '剪髮是2700元喔。';
  assert.equal(check(wrong, policy, report(wrong, [haircut])), false);
  const right = '剪髮是700元喔。';
  assert.equal(check(right, policy, report(right, [haircut])), true);
});
