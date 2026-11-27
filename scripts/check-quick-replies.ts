// Compares knowledge/quick-replies.json prices with the live site-config. Read-only.
// Usage: npm run quick-replies:check
import { loadQuickReplies } from '../src/quick-replies.js';
const map: Record<string, string> = {
  '剪髮（含洗髮）': 'price-cut', '超短髮or男生燙髮': 'price-perm', '肩上燙髮': 'price-perm', '胸上燙髮': 'price-perm', '胸下燙髮': 'price-perm',
  '超短髮or男生染髮': 'price-dye', '肩上染髮': 'price-dye', '胸上染髮': 'price-dye', '胸下染髮': 'price-dye', '髮根補染': 'price-root-dye',
  '洗髮+護髮': 'price-treatment', '剪髮+護髮': 'price-treatment',
};
const rules = await loadQuickReplies('knowledge/quick-replies.json');
const site = await (await fetch('https://harrishair.tw/api/site-config')).json() as { settings: Record<string, string>; services: { name: string; priceLabel: string; isActive: boolean }[] };
let bad = 0;
for (const [name, id] of Object.entries(map)) {
  const svc = site.services.find(s => s.name === name && s.isActive);
  const text = rules.entries.find(e => e.id === id)?.text ?? '';
  if (!svc) { console.log(`?? 網站找不到服務：${name}`); bad++; continue; }
  const nums = svc.priceLabel.match(/\d{3,}/g) ?? [];
  const missing = nums.filter(n => !text.includes(n));
  console.log(`${missing.length ? '✖' : '✔'} ${name} ${svc.priceLabel}${missing.length ? `（固定回覆缺 ${missing.join('、')}）` : ''}`);
  bad += missing.length ? 1 : 0;
}
for (const [key, needle] of [['openTime', 'hours'], ['closeTime', 'hours']] as const) {
  const value = site.settings[key]!; const ok = rules.entries.find(e => e.id === needle)!.text.includes(value);
  console.log(`${ok ? '✔' : '✖'} ${key} ${value}`); if (!ok) bad++;
}
process.exitCode = bad ? 1 : 0;
