# Harris LINE 髮廊助理

用 LINE 官方帳號接待客人、整理需求與通知店主的小型程式。店主可接手對話，再自行恢復自動回覆。資料保存在 PostgreSQL，程式重啟後仍保留待辦與接手狀態。

第一版提供既有[公司預約連結](https://g7.zoom-world.tw/Round2HairSalon/index.aspx)，沒有接入預約平台，也無法查空檔、建立訂單或驗證預約。客人想預約、客人說已預約、店主確認，會分開記錄。價格、地址與營業時間需先由店主確認，不能讓 AI 補猜。

AI 協助理解訊息、抽取預約需求；客人端回覆由已審閱的 [店務資料與語氣模板](knowledge/facts.json) 組成，避免直接送出模型編造的店址或預約承諾。`approved` 預設為 `false`；資料未確認時會交給本人處理。可在 `faqs` 加入你的常見問答，在 `voice` 調整語氣。

目前提供程式、模擬測試及部署設定；尚未完成真實 LINE／AI 憑證設定或 Render 部署。完整操作見 [設定與上線指南](docs/SETUP.md)。

## 先在本機試用

需要 Node.js 24 LTS 與 npm。在專案根目錄執行：

```bash
npm ci
npm run check
npm test
npm run build
npm run demo
```

Demo 使用內嵌 PostgreSQL、假的 LINE 與 AI，不會傳送真實 LINE 訊息，也不需要金鑰。資料保存在已忽略的 `.local/demo`。保持 demo 執行，在另一個終端機執行：

```bash
npm run demo:send -- "我想預約剪髮"
```

在 `.local/demo-outbound.jsonl` 查看模擬回覆與店主通知；其中只有 demo 假資料。Demo 預設使用本機 3000 連接埠，請勿把它當正式 webhook。

## 常用指令

| 指令 | 用途 |
| --- | --- |
| `npm ci` | 按 lockfile 安裝相同版本的套件 |
| `npm run check` | TypeScript 檢查 |
| `npm test` | 使用模擬外部服務與內嵌資料庫執行測試 |
| `npm run build` | 編譯至 `dist/` |
| `npm run migrate` | 對 `DATABASE_URL` 執行版本化資料庫更新；需先 build |
| `npm start` | 執行 `dist/main.js`；需要設定資料庫及 LINE 環境變數 |
| `npm run demo` | 啟動本機模擬服務 |
| `npm run demo:send -- "測試文字"` | 將已簽章的假客人訊息送至本機 demo |

`GET /healthz` 檢查程式存活，`GET /readyz` 檢查資料庫是否可用。LINE 使用 `POST /webhook`，程式會以原始請求內容驗證簽章。

## 店主如何使用

店主需先加官方帳號好友，並把自己的 LINE user ID 安全設定為 `OWNER_LINE_USER_ID`。在自己的個人 LINE 對官方帳號傳送：

| 指令 | 操作 |
| --- | --- |
| `/help` | 查看指令 |
| `/pending` | 查看待辦 |
| `/pending T000001` | 依上一頁提供的代號，查看較舊待辦 |
| `/take C000001` | 接手指定客人，暫停其自動回覆 |
| `/resume C000001` | 恢復指定客人的自動回覆 |
| `/done T000001` | 結束待辦 |
| `/confirm T000001` | 由店主人工確認該待辦的預約 |
| `/feedback T000001 正確回法或問題說明` | 記錄需要改善的回覆 |

請用實際通知中的客人／待辦代號。從 LINE 官方帳號後台手動回覆前，先使用 `/take`；程式不保證偵測後台手動發訊。`/confirm` 只記錄店主的確認，沒有查詢預約平台。回饋存在私人資料庫，經整理、去識別化與審閱後，才更新 [店務指南](knowledge/salon.md)。

## 上線前準備

先閱讀 [SETUP.md](docs/SETUP.md)，依序設定 LINE、付費常駐 Render 服務、持久化 PostgreSQL 與店主／測試帳號。預設為 `BOT_MODE=test`、`RESPONSE_MODE=fixed`；固定回覆測試通過且店務知識經確認後，再設定 AI，最後才切換正式服務。

憑證只放本機未追蹤的 `.env` 或部署平台的安全環境設定，請勿貼到聊天或 Git。客人訊息、資料庫備份與未去識別化回饋也不得加入 Git。Render、LINE 及 OpenAI 的費用各自計算，方案與額度以上線時的官方資訊為準。
