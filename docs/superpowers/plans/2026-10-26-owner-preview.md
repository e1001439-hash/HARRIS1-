# 店主問題預覽實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans；本地測試後獨立審查，不推送部署。

**Goal:** 店主用一則指令取得受限、隔離的客服回覆預覽。

**Architecture:** 共用 AI 分析及 policy；worker 的 owner 分支呼叫預覽處理器，app 對非 owner 保留預覽語法。用 events 單一 metadata 欄實現租約 fencing、去重及持久限流。沿用 skipTask/privateSetup，保留人工狀態。

**Tech Stack:** 現有 TypeScript、Zod、OpenAI SDK、PostgreSQL/PGlite，無新套件。

**Spec:** ../specs/2026-10-26-owner-preview-design.md

## Global Constraints

- 僅 `BOT_MODE=test`、`RESPONSE_MODE=ai`、owner、direct text。
- 最長1000字元，每10秒1次、24小時20次；重送與重啟不重複生成。
- 空 history、只回 owner、無客人／預約待辦與推播、無 handoff 變更。
- 全部外部服務是假實作；不讀真實憑證、不呼叫付費 API、不部署推送。
- 輸出與錯誤皆繁體中文及安全代碼，不能洩漏原始 provider error。

## Review Focus

- 任何非owner／群組／錯誤簽章與模式皆不能取得預覽或觸發AI。
- 既有店主管理指令、正常客人接待、人工狀態與通知保持。
- 首輪 claim／過期租約／程序中斷／檔案DB重啟不增加重複費用。
- 完成後清除問題與結果，仍保留不含內容的限流 metadata。
- API 配額、認證、未知／惡意錯誤安全降級，規則回覆不可冒充API已驗證。

## Task 1：預覽與安全錯誤

**Files:** src/analysis.ts、src/preview.ts、src/worker.ts、src/app.ts、src/store.ts、src/clients/ai.ts、migrations/005_owner_preview.sql、src/commands.ts、test/owner-preview.test.ts、test/clients.test.ts、README.md、docs/SETUP.md、docs/VALIDATION.md。

**Interfaces:** `analyzeMessage(options):Promise<AiResult>` 給 customer 與 preview 共用；`handleOwnerPreview(options,job):Promise<string>`、`isPreviewCommand(text):boolean`；`Store.reserveOwnerPreview(job)` 回 allowed/duplicate/rate_limited/expired；白名單 `aiFailureCode(error)` 不保存原始錯誤。

- [x] 寫先失敗測試：核准價目預覽、中文別名、空／過長／過期、模式與角色、無歷史／待辦／人工變更、重送／重試／重啟、限流／上限、API錯誤分類與保密。
- [x] 跑新測試確認真實缺功能的失敗，再實作最小路徑。
- [x] 跑相關測試與完整 `npm run check`、`npm test -- --test-concurrency=1`、`npm run build`；完整套件不刪測試，不放寬等待。
- [x] 獨立審查，必要修正先 RED 後 GREEN；記錄已驗證與真實未驗收部分，僅本地提交。

## 交付紀錄

獨立審查無Critical，唯一Important是錯誤分類建構子只靠TypeScript型別。先以未知runtime code重現外洩，再加入固定集合檢查，19項API診斷通過；無待處理的審查阻擋或minor。

完整首輪141/142，唯一失敗為舊migration版本清單未包含5；更新fixture後最終typecheck/build與完整142/142（0跳過）通過。全部外部API是假實作，沒有推送、部署或付費呼叫。

Ruling：限額以單一events metadata時間欄保留，不改privateSetup清空outcome的規則；相較outcome旗標需增加migration005，是為避免資料清除導致限流重設，代價為下一次部署必須包含這個schema遷移。
