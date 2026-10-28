import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderGroundedReply, type ReplyContract } from '../src/reply-guard.js';

const contract: ReplyContract = {
  claims: {
    quote: 'L 胸上染髮，新客 2,780 元、會員 2,910 元（價目表已折後金額）',
    pending: '這個時段需由 Harris 確認，請稍等唷',
    request: '週六兩點的染髮需求',
    ask_length: '頭髮目前大約到肩上、胸上，還是胸下呢？',
    booking_link: 'https://harrishair.tw',
  },
  required: ['quote'],
};

test('保留生成的兩種口語銜接，只用核准片段填入實際金額', () => {
  assert.equal(renderGroundedReply('了解～那就是{{quote}}，慢慢考慮也可以 😊', contract),
    '了解～那就是L 胸上染髮，新客 2,780 元、會員 2,910 元（價目表已折後金額），慢慢考慮也可以 😊');
  assert.equal(renderGroundedReply('好呀，{{quote}}。有其他問題再跟我說喔～', contract),
    '好呀，L 胸上染髮，新客 2,780 元、會員 2,910 元（價目表已折後金額）。有其他問題再跟我說喔～');
});

test('保留當下合格生成的事實順序與段落，不重新覆寫整段模板', () => {
  const pending = { ...contract, required: ['request', 'pending'] };
  assert.equal(renderGroundedReply('{{pending}}。\n{{request}}，了解囉 😊', pending),
    '這個時段需由 Harris 確認，請稍等唷。\n週六兩點的染髮需求，了解囉 😊');
  assert.equal(renderGroundedReply('了解～{{request}}，{{pending}}。', pending),
    '了解～週六兩點的染髮需求，這個時段需由 Harris 確認，請稍等唷。');
});

test('核准連接片語可組合與換序，並非只能使用固定整段回覆', () => {
  assert.equal(renderGroundedReply('可以呀～{{quote}}，再跟我說就好 😊', contract),
    '可以呀～L 胸上染髮，新客 2,780 元、會員 2,910 元（價目表已折後金額），再跟我說就好 😊');
  assert.equal(renderGroundedReply('這樣比較清楚一些，{{quote}}。慢慢想就好', contract),
    '這樣比較清楚一些，L 胸上染髮，新客 2,780 元、會員 2,910 元（價目表已折後金額）。慢慢想就好');
});

for (const [label, draft] of [
  ['假稱店主收到', '{{request}}。{{pending}}。老闆收到囉'],
  ['假稱敲定', '{{request}}。{{pending}}。敲定囉'],
  ['勸忽視待確認', '別信{{pending}}。{{request}}'],
  ['反轉待確認', '{{request}}。{{pending}}才怪'],
] as const) {
  test(`未審閱銜接語不能${label}`, () => {
    assert.equal(renderGroundedReply(draft, { ...contract, required: ['request', 'pending'] }), null);
  });
}

test('placeholder兩側或標點間不能重組核准片語而改變事實含意', () => {
  const booking = { ...contract, required: ['request', 'pending'] };
  assert.equal(renderGroundedReply('不{{pending}}客氣。{{request}}', booking), null);
  assert.equal(renderGroundedReply('了{{quote}}解', contract), null);
  assert.equal(renderGroundedReply('不，客氣{{pending}}。{{request}}', booking), null);
});

test('未審閱的其他自由句即使看似日常也不當成安全銜接語', () => {
  assert.equal(renderGroundedReply('{{quote}}，這看起來真好', contract), null);
  assert.equal(renderGroundedReply('{{quote}}，下雨真好', contract), null);
});

test('必要事實刪除、重複或擅自加未知片段時不產生客人回覆', () => {
  for (const draft of ['了解喔～', '{{quote}}{{quote}}', '{{quote}} {{unknown}}', '{{quote}} {{toString}}']) {
    assert.equal(renderGroundedReply(draft, contract), null, draft);
  }
});

test('可用非必填片段最多一次，問句與網址只從本次核准片段插入', () => {
  assert.equal(renderGroundedReply('{{quote}}。{{ask_length}}', contract),
    'L 胸上染髮，新客 2,780 元、會員 2,910 元（價目表已折後金額）。頭髮目前大約到肩上、胸上，還是胸下呢？');
  assert.equal(renderGroundedReply('{{quote}}。{{booking_link}}', contract),
    'L 胸上染髮，新客 2,780 元、會員 2,910 元（價目表已折後金額）。https://harrishair.tw');
  assert.equal(renderGroundedReply('{{quote}}{{booking_link}}{{booking_link}}', contract), null);
});

test('破損或變形 placeholder 不容許留下原樣或被靜默刪去', () => {
  for (const draft of ['{{quote}} {{quote }', '{{quote}} {pending}', '{{quote}} {{QUOTE}}', '{{quote}} {{ quote }}', '{{quote}} ｛｛pending｝｝']) {
    assert.equal(renderGroundedReply(draft, contract), null, draft);
  }
});

test('有誤的必填合約與巢狀片段拒絕輸出，不從原型尋找內容', () => {
  assert.equal(renderGroundedReply('{{quote}}', { ...contract, required: ['unknown'] }), null);
  assert.equal(renderGroundedReply('{{quote}}', { ...contract, required: ['quote', 'quote'] }), null);
  assert.equal(renderGroundedReply('{{quote}}', { claims: { quote: '{{pending}}' }, required: ['quote'] }), null);
});

test('自由文字不能加錯價、再次折扣、服務內容或日期營業事實', () => {
  for (const suffix of ['新客再打八折喔', '會員只要二千元', '原價三千五', '含洗剪護髮', '頭髮是L長度', '週六營業', '11:00–18:00', '下午可以', '免訂金', '明天照常開']) {
    assert.equal(renderGroundedReply(`{{quote}}，${suffix}`, contract), null, suffix);
  }
});

test('自由文字不能聲稱備註通知、登記、完成訂位或保留空檔', () => {
  for (const suffix of ['已幫你通知Harris', '已備註', '已登記', '完成預約', '預約成功', '幫你保留', '這時段有空可以約', '我會幫你處理', '直接過來就好']) {
    assert.equal(renderGroundedReply(`{{quote}}，${suffix}`, contract), null, suffix);
  }
});

test('不能以省略預約字樣的口語承諾放行空檔或免單', () => {
  for (const suffix of ['可以約喔', '那天可以來', '能來喔', '免單喔', '全部都可以']) {
    assert.equal(renderGroundedReply(`{{quote}}，${suffix}`, contract), null, suffix);
  }
});

test('不能在核准事實外否定片段、增加無證據保證或重複助手身份', () => {
  for (const suffix of ['不用理會', '不對', '這些作廢', '保證沒問題', '我本人幫你', '我是AI小幫手', '我是Harris']) {
    assert.equal(renderGroundedReply(`{{quote}}，${suffix}`, contract), null, suffix);
  }
});

test('核准片段外的否定標記不能反轉事實，固定禮貌語不客氣仍可用', () => {
  for (const [draft, required] of [
    ['不需要{{pending}}', 'pending'],
    ['沒有{{quote}}', 'quote'],
    ['不能{{request}}', 'request'],
    ['無{{quote}}', 'quote'],
    ['並非{{quote}}', 'quote'],
    ['未{{pending}}', 'pending'],
    ['没有{{quote}}', 'quote'],
    ['无{{quote}}', 'quote'],
  ] as const) {
    assert.equal(renderGroundedReply(draft, { ...contract, required: [required] }), null, draft);
  }
  assert.equal(renderGroundedReply('不客氣～{{quote}} 😊', contract),
    '不客氣～L 胸上染髮，新客 2,780 元、會員 2,910 元（價目表已折後金額） 😊');
});

test('只能使用本次允許的問句與連結，不能自由追加預約追問或其他網址', () => {
  for (const suffix of ['想預約嗎？', '你想什麼時候?', 'https://evil.invalid', 'www.evil.invalid', '@evil']) {
    assert.equal(renderGroundedReply(`{{quote}}，${suffix}`, contract), null, suffix);
  }
});

test('省略問號的額外追問也只能由核准缺項片段提出', () => {
  for (const suffix of ['想做什麼', '還有需要嗎', '你比較喜歡哪個', '是否要其他的', '你覺得呢']) {
    assert.equal(renderGroundedReply(`{{quote}}，${suffix}`, contract), null, suffix);
  }
});

test('HTML、程式碼與隱藏控制字元不通過，正常換行可保留', () => {
  for (const draft of ['<>{{quote}}', '`{{quote}}`', '[{{quote}}]', '{{quote}}\u200b', '{{quote}}\u202e', '{{quote}}\u0000', '{{quote}}\u001b']) {
    assert.equal(renderGroundedReply(draft, contract), null, JSON.stringify(draft));
  }
  assert.equal(renderGroundedReply('好呀～\n{{quote}}', contract),
    '好呀～\nL 胸上染髮，新客 2,780 元、會員 2,910 元（價目表已折後金額）');
});

test('全形數字、全形英字與貨幣符號不能繞過敏感內容邊界', () => {
  for (const suffix of ['２７８０', 'ＡＩ', '￥', '＄', 'Ⅳ']) {
    assert.equal(renderGroundedReply(`{{quote}} ${suffix}`, contract), null, suffix);
  }
});

test('填入事實後整則最多一個emoji，包含片段內的emoji及旗幟', () => {
  assert.equal(renderGroundedReply('{{quote}} 😊😊', contract), null);
  assert.equal(renderGroundedReply('{{quote}} 🇹🇼🇯🇵', contract), null);
  const withEmoji = { claims: { handoff: '收到，稍等一下 😊' }, required: ['handoff'] };
  assert.equal(renderGroundedReply('{{handoff}} 🙂', withEmoji), null);
  assert.equal(renderGroundedReply('{{handoff}}', withEmoji), '收到，稍等一下 😊');
});

test('自由emoji也只能用核准友善表情，不能反轉待確認片段', () => {
  const booking = { ...contract, required: ['request', 'pending'] };
  for (const face of ['👎', '🙅', '❌']) assert.equal(renderGroundedReply(`{{request}}。{{pending}} ${face}`, booking), null);
});

test('拒絕無界自由文字或事實結果，沒有片段的簡短收尾仍可自然保留', () => {
  assert.equal(renderGroundedReply('了解'.repeat(91) + '{{quote}}', contract), null);
  assert.equal(renderGroundedReply('了解'.repeat(90) + '{{quote}}', contract),
    '了解'.repeat(90) + 'L 胸上染髮，新客 2,780 元、會員 2,910 元（價目表已折後金額）');
  assert.equal(renderGroundedReply('～'.repeat(801) + '{{quote}}', contract), null);
  assert.equal(renderGroundedReply('{{quote}}', { claims: { quote: '嗯'.repeat(1501) }, required: ['quote'] }), null);
  assert.equal(renderGroundedReply('', { claims: {}, required: [] }), null);
  assert.equal(renderGroundedReply('不客氣～有需要再跟我說 😊', { claims: {}, required: [] }), '不客氣～有需要再跟我說 😊');
});
