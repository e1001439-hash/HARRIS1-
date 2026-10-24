import { randomUUID, createHmac } from 'node:crypto';
import { DEMO_CUSTOMER_ID, DEMO_SECRET } from './demo.js';
const port = Number(process.env.PORT ?? 3000);
const text = process.argv.slice(2).join(' ') || '我想預約週五下午剪髮';
const payload = JSON.stringify({ events: [{ type: 'message', webhookEventId: randomUUID(), timestamp: Date.now(), replyToken: 'demo-reply', source: { type: 'user', userId: DEMO_CUSTOMER_ID }, message: { type: 'text', text } }] });
try {
  const response = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': createHmac('sha256', DEMO_SECRET).update(payload).digest('base64') }, body: payload, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('failed');
  console.log('假訊息已接收；稍後可在 .local/demo-outbound.jsonl 查看假回覆與店主通知。');
} catch { console.error('示範訊息傳送失敗，請先啟動 npm run demo。'); process.exitCode = 1; }
