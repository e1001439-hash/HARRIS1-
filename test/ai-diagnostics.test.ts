import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { APIConnectionTimeoutError } from 'openai';
import { OpenAiClient, AiUnavailableError, aiFailureCode } from '../src/clients/ai.js';
import type { AiInput, AiResult } from '../src/types.js';

const privateKey = 'sk-local-diagnostic-secret';
const privateMessage = 'PRIVATE_PROVIDER_MESSAGE';
const privateHeader = 'PRIVATE_PROVIDER_HEADER';
const privateStack = 'PRIVATE_PROVIDER_STACK';
const privatePayload = 'PRIVATE_PROVIDER_PAYLOAD';
const input: AiInput = {
  text: 'PRIVATE_CUSTOMER_MESSAGE', history: [], knowledge: 'PRIVATE_KNOWLEDGE',
  receivedAt: '2026-10-26T00:00:00.000Z',
};
const answer: AiResult = {
  reply: '請問想了解哪個服務？', summary: '詢問服務', service: null, requestedTime: null,
  bookingStatus: 'none', needsHuman: false, nextAction: '等待客人回覆',
};

test('非型別安全adapter傳入未知錯誤碼仍只能得到白名單分類', () => {
  const privateCode = 'PRIVATE_UNTRUSTED_CODE';
  const error = new AiUnavailableError(privateCode as never);
  assert.equal(error.code, 'UNAVAILABLE');
  assert.equal(aiFailureCode(error), 'UNAVAILABLE');
  assert.doesNotMatch(inspect(error, { showHidden: true, depth: 10 }), new RegExp(privateCode));
});

function providerResponse(status: number, code: string, message = privateMessage): Response {
  return Response.json({
    error: { message, type: privatePayload, code, param: privatePayload },
  }, { status, headers: { 'x-request-id': privateHeader, 'x-private-header': privateHeader } });
}

function generatedResponse(output: string, status = 'completed'): Response {
  return Response.json({
    id: privatePayload, object: 'response', status,
    incomplete_details: status === 'completed' ? null : { reason: privatePayload },
    output: [{
      type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: output, annotations: [] }],
    }],
  }, { headers: { 'x-request-id': privateHeader } });
}

async function assertSafeFailure(fetcher: typeof fetch, expectedCode: string): Promise<void> {
  const ai = new OpenAiClient(privateKey, 'local-test-model', fetcher);
  await assert.rejects(() => ai.generate(input), (value: unknown) => {
    assert.ok(value instanceof Error);
    const error = value as Error & { readonly code?: string };
    assert.equal(error.message, 'AI response unavailable');
    assert.equal(error.code, expectedCode);
    assert.equal('cause' in error, false);
    assert.deepEqual(Reflect.ownKeys(error).filter(key => !['message', 'stack', 'name', 'code'].includes(String(key))), []);
    assert.match(error.stack ?? '', /^[^\n]*AI response unavailable(?:\n|$)/);
    const exposed = inspect(error, { showHidden: true, depth: 10 });
    for (const secret of [privateKey, privateMessage, privateHeader, privateStack, privatePayload, input.text, input.knowledge]) {
      assert.equal(exposed.includes(secret), false, '安全錯誤不得保存供應商或請求私密資料');
    }
    return true;
  });
}

for (const { label, status, providerCode, expected } of [
  { label: '401 驗證失敗', status: 401, providerCode: 'invalid_api_key', expected: 'AUTHENTICATION' },
  { label: '403 權限不足', status: 403, providerCode: 'permission_denied', expected: 'PERMISSION' },
  { label: '429 額度不足', status: 429, providerCode: 'insufficient_quota', expected: 'QUOTA' },
  { label: '429 速率限制', status: 429, providerCode: 'rate_limit_exceeded', expected: 'RATE_LIMIT' },
  { label: '429 未知原因', status: 429, providerCode: privatePayload, expected: 'RATE_LIMIT' },
  { label: '404 模型不可用', status: 404, providerCode: 'model_not_found', expected: 'MODEL_UNAVAILABLE' },
  { label: '500 供應商錯誤', status: 500, providerCode: 'internal_error', expected: 'UNAVAILABLE' },
  { label: '未知 HTTP 狀態', status: 418, providerCode: privatePayload, expected: 'UNAVAILABLE' },
]) {
  test(`OpenAI 將${label}轉成安全的固定分類`, async () => {
    await assertSafeFailure(async () => providerResponse(status, providerCode), expected);
  });
}

test('OpenAI 額度分類只使用供應商 code，不從原始訊息猜測', async () => {
  await assertSafeFailure(async () => providerResponse(429, 'rate_limit_exceeded', `${privateMessage}: insufficient_quota`), 'RATE_LIMIT');
});

test('OpenAI 將 SDK timeout 轉成安全的 TIMEOUT 分類', async () => {
  await assertSafeFailure(async () => {
    const error = new APIConnectionTimeoutError({ message: `Request timed out. ${privateMessage}` });
    error.stack = privateStack;
    throw error;
  }, 'TIMEOUT');
});

test('OpenAI 將未知傳輸錯誤轉成安全的 UNAVAILABLE 分類', async () => {
  await assertSafeFailure(async () => {
    const error = new Error(privateMessage, { cause: { payload: privatePayload, headers: privateHeader, key: privateKey } });
    error.stack = privateStack;
    throw error;
  }, 'UNAVAILABLE');
});

for (const status of ['incomplete', 'failed', 'queued']) {
  test(`OpenAI 將 ${status} 回應轉成安全的 INCOMPLETE 分類`, async () => {
    await assertSafeFailure(async () => generatedResponse(JSON.stringify(answer), status), 'INCOMPLETE');
  });
}

for (const { label, output } of [
  { label: '損壞的 JSON', output: `{${privatePayload}` },
  { label: '不符合 schema', output: JSON.stringify({ ...answer, bookingStatus: privatePayload }) },
  { label: '空白回覆', output: JSON.stringify({ ...answer, reply: ' ' }) },
  { label: '超長回覆', output: JSON.stringify({ ...answer, reply: privatePayload.repeat(200) }) },
]) {
  test(`OpenAI 將${label}轉成安全的 INVALID_RESPONSE 分類`, async () => {
    await assertSafeFailure(async () => generatedResponse(output), 'INVALID_RESPONSE');
  });
}
