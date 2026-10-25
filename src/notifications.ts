import type { EventJob, Outcome } from './types.js';
function taipeiTime(date: Date): string {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}
export function formatReceipt({ customerRef, receivedAt, text, taskId }: { customerRef: string; receivedAt: Date; text: string; taskId: string }): string {
  return ['收到客人訊息｜初步通知', `訊息時間：${taipeiTime(receivedAt)}｜${customerRef}`, `原文：${text.slice(0, 500) || '收到非文字訊息，請查看官方帳號'}`,
    '時段與項目尚待整理；這不是預約確認。', `待辦 ${taskId}（後續整理更新沿用同一編號）`, `接手：/take ${customerRef}`].join('\n');
}
export function formatNotification({ job, outcome, taskId }: { job: EventJob; outcome: Outcome; taskId: string }): string {
  const time = taipeiTime(job.receivedAt);
  const delivery = { sent: '已回覆', failed: '回覆失敗', unknown: '回覆送達不確定', not_sent: '未自動回覆' }[outcome.delivery];
  const booking = { none: '一般詢問', requested: '預約需求（尚未確認成功）', self_reported: '客人自述已預約（尚未向平台核實）' }[outcome.bookingStatus];
  return [ '需求整理更新｜同一則訊息，非新預約', `訊息時間：${time}｜${job.customerRef}`, `詢問：${outcome.summary.slice(0, 1000)}`, `狀態：${delivery}`, `回覆：${outcome.reply.slice(0, 1000) || '未自動回覆，請本人處理'}`,
    `預約：${booking}`, `期望時間：${outcome.requestedTime ?? '未提供'}`, `項目：${outcome.service ?? '未提供'}`,
    `待辦 ${taskId}：${outcome.nextAction.slice(0, 1000)}`, `需要你處理：${outcome.needsHuman ? '是' : '否'}`, '僅整理本則需求；如有後續修改，以較新訊息為準。', `接手：/take ${job.customerRef}` ].join('\n').slice(0, 4400);
}
