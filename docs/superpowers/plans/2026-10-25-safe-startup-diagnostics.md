# 安全啟動診斷實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** 將既有啟動失敗的單一通用訊息，改為可判讀、嚴格白名單且不洩密的階段／分類，讓下一次授權部署可定位問題。

**Architecture:** 沿用 Node 24／TypeScript／pg；在啟動階段及錯誤被包裝的邊界保留最少安全分類，最終只序列化自行建立的固定欄位。設定錯誤只列已知名稱；資料庫／檔案錯誤只映射已知代碼。未知例外一律落入固定 unknown，不讀取或輸出任意 message／stack／cause／provider payload。

**Spec:** 本任務 2026-10-25 最新委派已明確授權本地診斷程式與完整測試，先不推送／部署。實際日誌證明建置成功，npm start 執行後在 main.ts 通用 catch 失敗，不能據此判定 TLS、認證、免費方案或其他根因。

## Global Constraints

- 僅本地；不推送／部署、不讀正式憑證、不連正式 DB、不修改 LINE／Render、不新增費用或套件。
- 嚴格白名單：不得記錄原始 error message／stack／cause／URL／密鑰／連線字串／任意 provider payload。
- 不降低 TLS、憑證／主機名驗證，不改 owner/tester 權限、通知或回覆行為；維持 test/fixed 預設。
- 對外報告區分安全診斷修補完成與實際部署根因仍待確認；不得把本地通過當成上線。

## Review Focus

- 含秘密的 Error、未知 code、巢狀 cause、惡意 enumerable 欄位不出現在輸出或保留的安全錯誤中。
- 設定缺漏與格式錯誤只顯示允許的欄位名稱，不包含值。
- PgDatabase 原有包裝會抹去 TLS／DNS／認證代碼：需在該邊界轉換為安全分類，而非在 main 猜原始訊息。
- 讀 knowledge 與 facts、JSON／schema、DB 初始化、runtime／監聽可定位，清理失敗不掩蓋原始啟動階段。
- 實際入口非零結束且只輸出安全紀錄；成功啟動及 shutdown 不受影響。

### Task 1: 分階段安全診斷與本地失敗重現

**Files:** 新增聚焦的 `src/*diagnostic*.ts`／必要啟動編排檔及 `test/*startup*.test.ts`／診斷測試；最小修改 `src/main.ts`、`src/config.ts`、`src/db.ts`，必要時 `src/env.ts`／`src/migrate.ts`。根目錄負責更新 SETUP 與 VALIDATION。

**Interfaces:** 安全紀錄為固定 `event`、有限集合 `stage`、有限集合 `code`，必要時僅已知設定 `fields`。跨層傳遞安全錯誤不得保留原始 error／cause。具體型別與最小啟動分離由實作者依既有程式判斷，但不得暴露可任意輸入的診斷內容。

- [x] 先寫並執行失敗測試：缺 env、非法 owner／mode、知識檔不存在、facts JSON／schema錯誤、非法 DB URL／TLS選項、TLS／DNS／認證代碼、未知／惡意錯誤、監聽失敗、清理失敗不掩蓋原錯。
- [x] 用假資料與本地替身驗證分類，不連外；至少一項實際 CLI 啟動失敗證明非零結束且沒有原文／秘密。
- [x] 實作最小安全分類與邊界傳遞，跑指定測試 GREEN；記錄 RED/GREEN命令與結果。
- [x] 根目錄整合後跑完整 `npm run check`、`npm test`、`npm run build`，獨立審查安全與需求，更新中文判讀說明。
- [x] 僅本地提交；保留實際 Render 根因未確定與下一步安全日誌驗收。

## 執行紀錄

- BASE：732a51f；使用既有隔離 checkout `work`，不建立替代任務或部署。
- 使用者已指定直接修補並測試，不重問流程或設計批准。
- 完成：完整108項測試及check/build通過；編譯版四種安全失敗、原有本地PG17 TLS owner-only `/readyz=200` 啟動通過；獨立審查無未處理問題，僅本地保存。
