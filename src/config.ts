import { z } from 'zod';
import type { Config } from './types.js';
import { SafeDiagnosticError, configFields, type ConfigField } from './diagnostics.js';

const userId = z.string().regex(/^U[0-9a-f]{32}$/);
const httpsUrl = z.string().url().refine(value => new URL(value).protocol === 'https:');
const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  LINE_CHANNEL_SECRET: z.string().min(1), LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),
  OWNER_LINE_USER_ID: userId,
  TEST_LINE_USER_IDS: z.string().default(''), BOT_MODE: z.enum(['test', 'live']).default('test'),
  RESPONSE_MODE: z.enum(['fixed', 'ai']).default('fixed'),
  SALON_AI_API_KEY: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
  AI_MODEL: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).optional()),
  KNOWLEDGE_PATH: z.string().default('knowledge/salon.md'),
  BOOKING_URL: httpsUrl.default('https://harrishair.tw'),
  PUBLIC_SITE_URL: httpsUrl.default('https://harrishair.tw/'),
});
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map(x => x.path[0]).filter((field): field is ConfigField => typeof field === 'string' && (configFields as readonly string[]).includes(field)))];
    throw new SafeDiagnosticError(fields.every(field => env[field] === undefined || env[field] === '') ? 'CONFIG_MISSING' : 'CONFIG_INVALID', fields);
  }
  const d = result.data;
  const testIds = d.TEST_LINE_USER_IDS.split(',').map(x => x.trim()).filter(Boolean);
  if (testIds.some(id => !userId.safeParse(id).success || id === d.OWNER_LINE_USER_ID)) throw new SafeDiagnosticError('CONFIG_INVALID', ['TEST_LINE_USER_IDS']);
  if (d.RESPONSE_MODE === 'ai' && (!d.SALON_AI_API_KEY || !d.AI_MODEL)) throw new SafeDiagnosticError('CONFIG_MISSING', [!d.SALON_AI_API_KEY ? 'SALON_AI_API_KEY' : undefined, !d.AI_MODEL ? 'AI_MODEL' : undefined].filter((field): field is ConfigField => field !== undefined));
  return { port: d.PORT, databaseUrl: d.DATABASE_URL, mode: d.BOT_MODE, responseMode: d.RESPONSE_MODE,
    lineSecret: d.LINE_CHANNEL_SECRET, lineToken: d.LINE_CHANNEL_ACCESS_TOKEN, ownerId: d.OWNER_LINE_USER_ID,
    testUserIds: testIds, aiKey: d.SALON_AI_API_KEY, aiModel: d.AI_MODEL, knowledgePath: d.KNOWLEDGE_PATH,
    bookingUrl: d.BOOKING_URL, publicSiteUrl: d.PUBLIC_SITE_URL };
}
