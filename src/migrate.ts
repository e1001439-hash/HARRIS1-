import './env.js';
import { PgDatabase, migrate } from './db.js';
const url = process.env.DATABASE_URL;
if (!url) { console.error('缺少 DATABASE_URL'); process.exitCode = 1; }
else {
  let db: PgDatabase | undefined;
  try { db = new PgDatabase(url); await migrate(db); console.log('資料庫 migration 完成。'); }
  catch { console.error('資料庫 migration 失敗；請檢查連線與 TLS 設定。'); process.exitCode = 1; }
  finally { await db?.close(); }
}
