import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
const required = { DATABASE_URL: 'postgres://localhost/test', LINE_CHANNEL_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'token', OWNER_LINE_USER_ID: `U${'1'.repeat(32)}`, TEST_LINE_USER_IDS: `U${'2'.repeat(32)}` };
test('fixed owner-only startup needs no tester or AI key and still rejects role overlap', () => {
  assert.equal(loadConfig({ ...required, SALON_AI_API_KEY: '', AI_MODEL: '' }).responseMode, 'fixed');
  assert.deepEqual(loadConfig({ ...required, TEST_LINE_USER_IDS: '', SALON_AI_API_KEY: '', AI_MODEL: '' }).testUserIds, []);
  assert.throws(() => loadConfig({ ...required, TEST_LINE_USER_IDS: required.OWNER_LINE_USER_ID }));
  assert.throws(() => loadConfig({ ...required, RESPONSE_MODE: 'ai' }), /SALON_AI_API_KEY/);
  assert.throws(() => loadConfig({ ...required, BOT_MODE: 'typo' }));
});
test('secret validation errors include names only, never secret values', () => {
  assert.throws(() => loadConfig({ ...required, OWNER_LINE_USER_ID: 'private-value' }), (e: unknown) => e instanceof Error && !e.message.includes('private-value'));
});
