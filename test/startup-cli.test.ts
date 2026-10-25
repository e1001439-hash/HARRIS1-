import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('real startup entry reports invalid configuration as safe JSON and exits nonzero', () => {
  const privateValue = 'fake-private-owner-with-token-and-url';
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: 'postgresql://fake:fake@localhost/no-connection',
      LINE_CHANNEL_SECRET: 'fake-secret', LINE_CHANNEL_ACCESS_TOKEN: 'fake-token', OWNER_LINE_USER_ID: privateValue },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes('"event":"startup_failed"'), 'startup failure must have a structured diagnostic');
  const diagnostic = JSON.parse(result.stderr.trim());
  assert.deepEqual(diagnostic, { event: 'startup_failed', stage: 'configuration', code: 'CONFIG_INVALID', fields: ['OWNER_LINE_USER_ID'] });
  assert.ok(!result.stderr.includes(privateValue));
  assert.ok(!result.stderr.includes('fake-token'));
  assert.ok(!result.stderr.includes('postgresql://'));
});
