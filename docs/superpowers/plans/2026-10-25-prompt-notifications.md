# 及時通知與人工接手續訊：實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 補強既有程式，讓新訊息先通知店主，且人工接手後仍整理客人更改的需求。

**Architecture:** 訊息持久化時同交易建立初步待辦與「收到訊息」通知；同一程序內獨立通知工作不等待 AI 或客人回覆。分析完成後建立有明確階段標記的整理更新；每則訊息／階段唯一且載荷與重試識別碼固定。人工接手訊息仍分析文字，但不自動回客人、不改寫手動接手狀態；以來源訊息時間及序號抑制被較新訊息取代的整理結果，同時保留原始通知。

**Tech Stack:** 沿用 Node 24、TypeScript、PostgreSQL／PGlite、既有 LINE／AI 客戶端及測試工具；不加依賴或付費服務。

**Spec:** 本對話使用者 2026-10-25 同意保留原方案，由代理接手技術；本次委派明確限定兩項補強及本地測試。原始設計 `docs/superpowers/specs/2026-10-24-line-salon-assistant-design.md` 其餘邊界繼續適用。

## Global Constraints

- 保留現有隔離工作區、簽章驗證、測試名單、店主權限、TLS、通知重試、租約及資料清理。
- 不部署、不推送、不變更 LINE／Render 設定、不取得或配置新憑證，不做真實客人測試。
- 預約時段都是需求；不得自動確定訂位或編造店務政策。FAQ／價目未核准則維持待確認。
- 初步通知與整理更新為同一則訊息的不同階段，不把 webhook 重送視為新訊息。
- 人工接手後無自動客人回覆；若店主在分析期間明確恢復，自動分析完成也不能再次改寫該決定。

## Review Focus

- AI／客人回覆卡住或失敗，通知仍可獨立送出；通知失敗也不能阻止分析或客人回覆。
- 人工接手續訊、更改時段、AI 失敗、非文字訊息皆保留人工狀態及原文降級。
- 重送、過期租約、倒序到達與晚完成的分析不得重複通知或讓舊時段覆蓋新時段。
- 初步／整理通知去重不能更換推播重試識別碼或修改載荷，抑制整理不可抹除唯一的原文通知。
- 既有 30／90 天清理同時涵蓋兩階段通知與新增待辦，不重新暴露過期文字。

### Task 1: 持久化及時通知

**Files:** `src/store.ts`, `src/types.ts`, `src/app.ts`, `src/notifications.ts`, `migrations/003_prompt_notifications.sql`, `test/prompt-store.test.ts`。

**Interfaces:** `Store.ingest(events, ownerId?)` 建立原始通知；`finishEvent` 更新同一事件待辦；`isLatestEvent(job)` 與 `canSendNotification(job)` 檢查來源新舊及有效租約；`Outcome.preserveHandoff` 保持手動狀態；`NotificationJob` 帶來源與階段。通知階段 `receipt|analysis` 具唯一約束。

- [x] 先寫測試並觀察失敗：未分析就有通知、重送不重複、兩階段載荷固定、晚到舊訊息與過期分析受抑制、保留原文通知與手動狀態、文字清理。
- [x] 實作原子寫入、版本／租約檢查與 idempotent migration；跑資料庫測試至通過。

### Task 2: 獨立通知與人工接手分析

**Files:** `src/notification-worker.ts`, `src/worker.ts`, `src/runtime.ts`, `src/policy.ts`, `test/prompt-worker.test.ts`, `test/runtime.test.ts`。

**Interfaces:** 獨立 `NotificationWorker.tick/stop` 沿用推播重試；客人／店主管理／通知三個迴圈仍在同一服務。人工接手文字呼叫既有 AI，但結果僅供內部需求整理；服務項目可引用已完成的客人對話，當次時段須根據當次原文。

- [x] 先寫測試並觀察失敗：AI 尚未完成已通知、客人 LINE 回覆卡住已通知、人工接手後更改時段不發客人訊息、AI／LINE 失敗降級、店主在分析期間恢復不被覆蓋、倒序訊息不送過期整理。
- [x] 實作最小調整，保留通知失敗重試與失敗日誌；不新增其他客服功能。
- [x] 跑 `npm run check`、完整 `npm test`、`npm run build`；請獨立審閱者檢查差異，必要修正以回歸案例驗證。
- [x] 更新中文操作／驗證紀錄，僅建立本地提交。保留遠端及暫停中的部署狀態。

## 執行紀錄

使用者已明確授權以上有界實作，直接執行，不再要求重複確認計畫。存儲部分與工作流程部分固定介面後分工，整合測試與最後審閱由主要代理負責。

審查修正決定：取消原本未嘗試通知的合併優化，避免舊整理被抑制時遺失該則唯一通知；原文與更新各自保存。新增人工決策版本及 `/take` 對未完成事件的黏著標記，防止 take→resume 後舊工作恢復自動回覆或蓋回舊人工狀態。兩項修正都先重現失敗再跑通；完整 78 項＋獨立 PostgreSQL 1 項通過，無未處理審查問題。部署及真實驗收仍暫停。
