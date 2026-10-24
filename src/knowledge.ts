import { readFile } from 'node:fs/promises';
import { z } from 'zod';
const factsSchema = z.object({
  approved: z.boolean(), address: z.string().max(1000).nullable(), hours: z.string().max(1000).nullable(),
  services: z.array(z.object({ name: z.string().min(1).max(100), price: z.string().max(300).nullable() })).max(100),
  faqs: z.array(z.object({ keywords: z.array(z.string().min(2).max(100)).min(1), answer: z.string().min(1).max(2000) })).max(100),
  voice: z.object({ greeting: z.string().min(1).max(500), handoff: z.string().min(1).max(500) }),
}).strict();
export type SalonFacts = z.infer<typeof factsSchema>;
export function emptyFacts(): SalonFacts { return { approved: false, address: null, hours: null, services: [], faqs: [], voice: { greeting: '你好，想了解服務或預約呢？', handoff: '收到你的訊息，這部分需要由我本人確認，稍後再回覆你。' } }; }
export async function loadFacts(path: string): Promise<SalonFacts> { return factsSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
