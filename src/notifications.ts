import type { EventJob, Outcome } from './types.js';
export function formatNotification({ job, outcome, taskId }: { job: EventJob; outcome: Outcome; taskId: string }): string {
  const time = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(job.receivedAt);
  const delivery = { sent: '已回覆', failed: '回覆失敗', unknown: '回覆送達不確定', not_sent: '未自動回覆' }[outcome.delivery];
  const booking = { none: '一般詢問', requested: '預約需求（尚未確認成功）', self_reported: '客人自述已預約（尚未向平台核實）' }[outcome.bookingStatus];
  return [ `${time}｜${job.customerRef}`, `詢問：${outcome.summary.slice(0, 1000)}`, `狀態：${delivery}`, `回覆：${outcome.reply.slice(0, 1000) || '人工接手中'}`,
    `預約：${booking}`, `期望時間：${outcome.requestedTime ?? '未提供'}`, `項目：${outcome.service ?? '未提供'}`,
    `待辦 ${taskId}：${outcome.nextAction.slice(0, 1000)}`, `需要你處理：${outcome.needsHuman ? '是' : '否'}`, `接手：/take ${job.customerRef}` ].join('\n').slice(0, 4400);
}
