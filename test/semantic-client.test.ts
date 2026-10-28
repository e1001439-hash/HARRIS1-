import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { OpenAiClient, AiUnavailableError } from '../src/clients/ai.js';
import type { AiInput, AiResult } from '../src/types.js';
import type { NaturalContract, SemanticReview, VerificationInput } from '../src/reply-guard.js';

const fact = { kind: 'price', service: '染髮', length: 'L', audience: 'new', value: '2780', polarity: 'affirmed' } as const;
const contract: NaturalContract = {
  topic: 'price', atoms: { price_new: '2,780' }, requiredAtoms: ['price_new'],
  allowedFacts: [fact], requiredFacts: [fact], allowedQuestions: [], requiredQuestions: [],
};
const candidate = '你說的胸上是 L，染髮新客這邊是 2,780 元喔 😊';
const review: SemanticReview = {
  verdict: 'supported', complete: true, facts: [{ ...fact, evidence: candidate }],
  questions: [], actions: [], persona: 'assistant', issues: [],
};
const generated: AiResult = {
  reply: '你說的胸上是 L，染髮新客這邊是 {{price_new}} 元喔 😊',
  summary: 'GENERATOR_PRIVATE_SELF_APPROVAL', service: '染髮', requestedTime: null,
  bookingStatus: 'none', needsHuman: false, nextAction: 'GENERATOR_PRIVATE_NEXT_ACTION',
};
const generation: AiInput = { text: 'PRIVATE_CUSTOMER_MESSAGE', history: [{ role: 'user', content: 'PRIVATE_PRIOR_MESSAGE' }], knowledge: '核准資料', receivedAt: '2026-10-28T03:00:00Z', replyPlan: contract };
const verification: VerificationInput = { candidate, contract, text: generation.text, history: generation.history };
function output(value: unknown, status = 'completed'): Response {
  return Response.json({ id: 'fake-semantic-response', object: 'response', status,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: typeof value === 'string' ? value : JSON.stringify(value), annotations: [] }] }] });
}

test('生成與獨立語意核驗使用同一模型但分開請求，核驗不接受生成器自我背書', async () => {
  const calls: { url: string; body: any; headers: Headers; signal: AbortSignal | null | undefined }[] = [];
  const ai = new OpenAiClient('fake-semantic-key', 'configured-model', async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options!.body as string), headers: new Headers(options!.headers), signal: options!.signal });
    return output(calls.length === 1 ? generated : review);
  });
  assert.equal(typeof ai.verify, 'function');
  assert.deepEqual(await ai.generate(generation), generated);
  assert.deepEqual(await ai.verify(verification), review);
  assert.equal(calls.length, 2);
  for (const request of calls) {
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(request.body.model, 'configured-model'); assert.equal(request.body.store, false);
    assert.equal(request.body.text.format.type, 'json_schema'); assert.equal(request.body.text.format.strict, true);
    assert.ok(request.signal);
    assert.equal(request.body.instructions.includes(generation.text), false);
    assert.equal(request.body.instructions.includes('PRIVATE_PRIOR_MESSAGE'), false);
  }
  assert.equal(calls[0]!.headers.get('x-stainless-timeout'), '12');
  assert.equal(calls[1]!.headers.get('x-stainless-timeout'), '5');
  assert.notEqual(calls[0]!.body.text.format.name, calls[1]!.body.text.format.name);
  const data = JSON.parse(calls[1]!.body.input[0].content);
  assert.deepEqual(data.contract, contract); assert.equal(data.candidate, candidate);
  assert.equal(data.customerMessage, generation.text); assert.deepEqual(data.history, generation.history);
  assert.equal(JSON.stringify(calls[1]!.body).includes('GENERATOR_PRIVATE_SELF_APPROVAL'), false);
  assert.equal(JSON.stringify(calls[1]!.body).includes('GENERATOR_PRIVATE_NEXT_ACTION'), false);
  assert.match(calls[1]!.body.instructions, /完整.*子句|完整.*句/);
  assert.match(calls[1]!.body.instructions, /承諾/); assert.match(calls[1]!.body.instructions, /能力/);
});

test('核驗器只解析結構化抽取，不把unsupported或uncertain改成supported', async () => {
  for (const verdict of ['unsupported', 'uncertain'] as const) {
    const response = { ...review, verdict, complete: false, issues: ['尚無法支持'] };
    const ai = new OpenAiClient('fake-key', 'model', async () => output(response));
    assert.equal(typeof ai.verify, 'function');
    assert.deepEqual(await ai.verify(verification), response);
  }
});

test('模型不能自報replySource，生成結果維持原嚴格schema', async () => {
  const ai = new OpenAiClient('fake-key', 'model', async () => output({ ...generated, replySource: 'natural_verified' }));
  await assert.rejects(() => ai.generate(generation), error => error instanceof AiUnavailableError && error.code === 'INVALID_RESPONSE');
});

test('核驗缺欄、safe布林捷徑、額外背書與壞JSON只得到安全INVALID_RESPONSE', async () => {
  for (const value of [{ safe: true }, { ...review, facts: undefined }, { ...review, approvedByGenerator: true }, 'PRIVATE_INVALID_JSON']) {
    const ai = new OpenAiClient('fake-key', 'model', async () => output(value));
    assert.equal(typeof ai.verify, 'function');
    await assert.rejects(() => ai.verify(verification), error => error instanceof AiUnavailableError && error.code === 'INVALID_RESPONSE' && !inspect(error).includes('PRIVATE_INVALID_JSON'));
  }
});

test('核驗未完成與拒答不當成可用報告', async () => {
  for (const status of ['incomplete', 'failed', 'queued']) {
    const ai = new OpenAiClient('fake-key', 'model', async () => output(review, status));
    assert.equal(typeof ai.verify, 'function');
    await assert.rejects(() => ai.verify(verification), error => error instanceof AiUnavailableError && error.code === 'INCOMPLETE');
  }
  const ai = new OpenAiClient('fake-key', 'model', async () => Response.json({ id: 'fake-refusal', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'PRIVATE_REFUSAL' }] }] }));
  assert.equal(typeof ai.verify, 'function');
  await assert.rejects(() => ai.verify(verification), error => error instanceof AiUnavailableError && error.code === 'INVALID_RESPONSE' && !inspect(error).includes('PRIVATE_REFUSAL'));
});

test('核驗HTTP失敗不重試且不保存金鑰或供應商載荷', async () => {
  let calls = 0;
  const ai = new OpenAiClient('PRIVATE_FAKE_SECRET', 'model', async () => {
    calls++; return Response.json({ error: { code: 'provider_error', message: 'PRIVATE_PROVIDER_PAYLOAD', type: 'PRIVATE_TYPE' } }, { status: 503, headers: { 'x-request-id': 'PRIVATE_HEADER' } });
  });
  assert.equal(typeof ai.verify, 'function');
  await assert.rejects(() => ai.verify(verification), error => {
    assert.ok(error instanceof AiUnavailableError); assert.equal(error.code, 'UNAVAILABLE');
    assert.equal('cause' in error, false);
    assert.doesNotMatch(inspect(error, { showHidden: true, depth: 10 }), /PRIVATE_FAKE_SECRET|PRIVATE_PROVIDER_PAYLOAD|PRIVATE_TYPE|PRIVATE_HEADER/);
    return true;
  });
  assert.equal(calls, 1);
});

for (const stage of ['generate', 'verify'] as const) {
  test(`${stage}把共同AbortSignal傳到SDK fetch，取消後不重試`, async () => {
    const abort = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    let calls = 0, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const ai = new OpenAiClient('fake-key', 'model', async (_url, options) => {
      calls++; transportSignal = options!.signal; started();
      return new Promise<Response>((_resolve, reject) => {
        transportSignal!.addEventListener('abort', () => reject(new Error('PRIVATE_ABORT_PAYLOAD')), { once: true });
      });
    });
    assert.equal(typeof ai.verify, 'function');
    const pending = stage === 'generate' ? ai.generate({ ...generation, signal: abort.signal }) : ai.verify({ ...verification, signal: abort.signal });
    const rejected = assert.rejects(() => pending, error => error instanceof AiUnavailableError && !inspect(error).includes('PRIVATE_ABORT_PAYLOAD'));
    await ready; assert.ok(transportSignal); abort.abort(); await rejected;
    assert.equal(transportSignal.aborted, true); assert.equal(calls, 1);
  });
}
