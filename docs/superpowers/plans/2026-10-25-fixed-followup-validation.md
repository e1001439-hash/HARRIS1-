# 固定模式後續通知自主模擬驗收計畫

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** 不需要本人或第二位測試者在線，針對已配對的 fixed 模式第一則回覆後，人工狀態的後續通知進行本地自主驗收。

**Architecture:** 沿既有簽章 HTTP、真執行迴圈、檔案型 PGlite 與假 LINE client 驗證可觀察行為。以持久時間欄位／排程推進模擬45分鐘及到期重試，不實際等待或聲稱重現 Render 休眠。

**Tech Stack:** 既有 Node 24／TypeScript／node:test／PGlite，無新套件。

**Spec:** 本任務最新使用者「能不麻煩他人的前提繼續操作執行嗎」授權本地診斷、模擬測試與已證實問題的必要修正；此輪不推送、部署、改遠端、啟用正式模式、發真實LINE、升級付費或繞過CONNECT403。已知真實配對及第一則雙邊收訊成功，後續更新通知尚未驗收，不能推定休眠原因。

## Global Constraints

- 保持 owner／tester 分離、test/fixed 與已核實的TLS政策；全部外部服務使用假替身，AI呼叫須為0。
- 不使用正式秘密、連正式DB、發真實訊息或讓任何人保持在線。
- 新驗收測試可以在既有正常實作直接通過；若遇真失敗，先重現與定位，再針對根因修補並加回歸。
- 區分本地程式模擬、持久資料年齡推進與真實Render／LINE證據；沒有真實日誌不能歸因休眠。

## Review Focus

- 動態批准的配對越過五分鐘後仍有效，真檔案資料庫關閉重開保留授權及人工狀態。
- 第一則固定回覆成功後，不對後續更新自動回覆，但實際呼叫假push通知owner，不能僅以HTTP200判定通過。
- reply token超過50秒不應阻止人工狀態的原文通知；舊訊息不得蓋掉新需求。
- 排程未到不能先重試，重啟／到期使用同一retryKey，最多三次，不重送客人或阻擋新的通知。
- 現有日誌沒有webhook受理或入列成功紀錄，不能以缺日誌推定未收到事件。

### Task 1: 行為驗收與證據

**Files:** 新增 `test/fixed-followup.test.ts`，必要時最小測試工具；主代理更新 `docs/VALIDATION.md`。只有確定bug才修改src。

- [x] 用動態配對、簽章HTTP與假LINE驗證首則→人工→45分鐘情境更新通知。
- [x] 用同一檔案PGlite跨runtime重啟驗證授權、人工與後續通知持久性。
- [x] 模擬通知排程／重試／終止，驗證不重送客人、舊失敗不阻擋新更新，另涵蓋過期reply token。
- [x] 讀取聚焦測試結果與獨立流程稽核，若無程式bug就保留原實作。
- [x] 跑完整check/test/build並獨立審查新測試可信度，記錄證據；僅本地提交。

## 執行紀錄

- BASE：3a375bb。既有checkout `work`；遠端與正式設定維持。
- 主代理核對現有流程，實作代理僅寫新測試；另一代理獨立唯讀核對阻擋條件與log界線。
- 完成：3項新驗收在既有程式直接通過，src未改；完整111項與check/build通過。獨立審查無阻擋，兩項非阻擋測試強化及真實驗收界線列於VALIDATION；沒有外部操作。
