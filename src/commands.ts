import type { Store } from './store.js';
const help = '店主管理指令：\n/pending 查看待辦\n/take C000001 接手\n/resume C000001 恢復自動回覆\n/done T000001 完成待辦\n/confirm T000001 本人已核實預約\n/feedback T000001 正確回法\n/help 顯示說明';
export async function handleOwnerCommand(text: string, store: Store): Promise<string> {
  const [command, ref, ...rest] = text.trim().split(/\s+/);
  if (command === '/pending') {
    if (ref && !/^T\d+$/.test(ref)) return help;
    const tasks = await store.listTasks(ref);
    let message = '', lastRef = '', shown = 0;
    for (const task of tasks) {
      const block = `${task.id}｜${task.customerRef}｜${task.bookingStatus}\n${task.summary.slice(0, 120)}\n下一步：${task.nextAction.slice(0, 100)}\n\n`;
      if (message.length + block.length > 3800) break;
      message += block; lastRef = task.id; shown++;
    }
    if (tasks.length >= 20 || shown < tasks.length) message += `查看較舊待辦：/pending ${lastRef}`;
    return message.trim() || '這一頁沒有未完成待辦。';
  }
  if ((command === '/take' || command === '/resume') && ref && /^C\d+$/.test(ref)) {
    const session = await store.sessionForRef(ref);
    if (!session) return '找不到這位客人代號。';
    await store.setHandoff(session.userId, command === '/take');
    return `${ref} ${command === '/take' ? '已切換人工接手；請到官方帳號後台回覆。' : '已恢復自動回覆。'}`;
  }
  if (ref && /^T\d+$/.test(ref)) {
    if (command === '/done') return await store.completeTask(ref) ? `${ref} 已完成。` : '找不到待辦。';
    if (command === '/confirm') return await store.confirmTask(ref) ? `${ref} 已記錄為「店主本人確認」；不是平台自動核實。` : '找不到可確認的預約待辦。';
    if (command === '/feedback' && rest.length) return await store.addFeedback(ref, rest.join(' ').slice(0, 2000)) ? '已記錄回饋；審閱並修改規則後才會套用。' : '找不到待辦。';
  }
  return help;
}
