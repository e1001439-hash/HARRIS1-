import { z } from 'zod';
import type { Config } from './types.js';

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
  BOOKING_URL: httpsUrl.default('https://g7.zoom-world.tw/Round2HairSalon/index.aspx'),
  PUBLIC_SITE_URL: httpsUrl.default('https://harrishair.tw/'),
});
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`設定缺漏或格式錯誤：${[...new Set(result.error.issues.map(x => x.path[0]))].join(', ')}`);
  const d = result.data;
  const testIds = d.TEST_LINE_USER_IDS.split(',').map(x => x.trim()).filter(Boolean);
  if (testIds.some(id => !userId.safeParse(id).success || id === d.OWNER_LINE_USER_ID)) throw new Error('TEST_LINE_USER_IDS 必須為有效且不同於店主的個人 LINE user ID');
  if (d.RESPONSE_MODE === 'ai' && (!d.SALON_AI_API_KEY || !d.AI_MODEL)) throw new Error('AI 模式需要 SALON_AI_API_KEY 與 AI_MODEL');
  return { port: d.PORT, databaseUrl: d.DATABASE_URL, mode: d.BOT_MODE, responseMode: d.RESPONSE_MODE,
    lineSecret: d.LINE_CHANNEL_SECRET, lineToken: d.LINE_CHANNEL_ACCESS_TOKEN, ownerId: d.OWNER_LINE_USER_ID,
    testUserIds: testIds, aiKey: d.SALON_AI_API_KEY, aiModel: d.AI_MODEL, knowledgePath: d.KNOWLEDGE_PATH,
    bookingUrl: d.BOOKING_URL, publicSiteUrl: d.PUBLIC_SITE_URL };
}
