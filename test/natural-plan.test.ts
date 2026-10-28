import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyPlan } from '../src/policy.js';
import { buildNaturalContract } from '../src/natural-plan.js';
import { loadFacts } from '../src/knowledge.js';
import type { AiInput } from '../src/types.js';

const facts = await loadFacts('knowledge/facts.json'), url = 'https://harrishair.tw';
function contract(text: string, history: AiInput['history'] = []) {
  return buildNaturalContract(buildReplyPlan(text, url, facts, history), text, facts, history, url);
}
test('日常價格只提供原子金額與語意事實，不提供整段報價句', () => {
  const c = contract('胸上染髮多少？'); assert.ok(c);
  assert.deepEqual(c.atoms, { price_new: '2,780', price_member: '2,910' });
  assert.deepEqual(c.requiredAtoms, ['price_new', 'price_member']);
  assert.deepEqual(c.requiredFacts.map(f => [f.kind,f.service,f.length,f.audience,f.value]), [
    ['price','染髮','L','new','2780'], ['price','染髮','L','member','2910'],
  ]);
  assert.deepEqual(c.allowedQuestions, []);
  assert.equal(c.allowedFacts.some(f => f.kind === 'price_basis' && f.value === 'already_discounted'), true);
});
test('新客只綁定對應已折後金額，剪價獨立700且無身分折扣', () => {
  const c = contract('我是新客', [{ role: 'user', content: '胸上染髮多少？' }]); assert.ok(c);
  assert.deepEqual(c.atoms, { price_new: '2,780' });
  const cut = contract('會員剪髮多少？'); assert.ok(cut);
  assert.deepEqual(cut.atoms, { price: '700' }); assert.equal(cut.requiredFacts[0]?.audience, null);
});
test('缺項只限制要問的資訊，不指定問題句型', () => {
  const c = contract('染髮多少？'); assert.ok(c);
  assert.deepEqual(c.atoms, {}); assert.deepEqual(c.requiredQuestions, ['length']);
  assert.equal(JSON.stringify(c).includes('還是胸下呢'), false);
  const hello = contract('你好'); assert.ok(hello);
  assert.equal(hello.allowedQuestions.includes('help_topic'), true);
  const bye = contract('謝謝'); assert.ok(bye);
  assert.deepEqual(bye.atoms, {}); assert.deepEqual(bye.requiredFacts, []); assert.deepEqual(bye.allowedQuestions, []);
});
test('混合預約只鎖原時段與URL，待Harris確認是唯一完整安全例外', () => {
  const c = contract('我要預約週六兩點染髮，給我預約連結'); assert.ok(c);
  assert.equal(c.atoms.requested_time, '週六兩點'); assert.equal(c.atoms.booking_url, url);
  assert.equal(c.atoms.pending, '這個時段需由 Harris 確認，請稍等唷');
  assert.equal(c.requiredFacts.some(f => f.kind === 'requires_harris' && f.value === 'booking'), true);
  assert.equal(c.allowedFacts.some(f => f.kind === 'booking_status' && f.value === 'confirmed'), false);
});
test('一般時間與特定日分開，未知日期不加入有營業事實', () => {
  const c = contract('元旦有營業嗎？'); assert.ok(c);
  assert.deepEqual(c.atoms, { hours: '11:00–18:00' });
  assert.equal(c.requiredFacts.some(f => f.kind === 'requires_harris' && f.value === 'opening_date'), true);
  assert.equal(c.allowedFacts.some(f => f.value.includes('元旦營業')), false);
});
test('未結構化FAQ與未知政策不偷換回整句生成插槽', () => {
  assert.equal(contract('訂金多少？'), null);
  const custom = { ...facts, faqs: [{ keywords: ['停車'], answer: '某個自訂停車說明' }] };
  assert.equal(buildNaturalContract(buildReplyPlan('停車', url, custom), '停車', custom, [], url), null);
});
