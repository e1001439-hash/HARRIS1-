# Harris 身份與語氣更新實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以核准口語模板回覆，且每位客人僅首次介紹 AI 身份。

**Architecture:** 沿既有 sessions 與 markSending 租約交易保存介紹狀態；policy 與核准知識繼續控制所有對客文案。通知、預約與接手架構不變。

**Tech Stack:** 現有 TypeScript、Fastify、Postgres、PGlite 測試；不加依賴。

**Spec:** `docs/superpowers/specs/2026-10-27-assistant-identity-design.md`

## Global Constraints

- 僅本地實作、測試與提交，不推送部署或發真實訊息。
- 身份 Harris 的訊息小幫手，首次明說 AI，每則客人回覆最多一個 emoji。
- 預約仍待 Harris 確認；一般時間 11:00–18:00 不代表特定日期營業。
- 不改既有通知、人工接手、價格或預約入口。

## Review Focus

- 重新部署、事件重送與 lease 失效不可反覆介紹或越過人工接手。
- 送出過期/失敗不得誤當成功；不明送達不可盲目再傳。
- owner、預覽與未授權測試帳號不消耗客人介紹。
- 日期營業與混合預約問題不可承諾開店/空檔。
- 照片一律由 Harris 處理，組合價格與預約模板仍最多一個 emoji。

### Task 1: 持久化首次介紹

**Files:** `src/store.ts`, `src/types.ts`, `src/worker.ts`, `migrations/006_assistant_identity.sql`, `test/assistant-identity.test.ts`, `test/store.test.ts`。

**Interfaces:** 沿既有 `Store.markSending` 保持租約與 handoff 鎖；介紹狀態不依對話原文或保留期限判定。

- [x] 寫首次/第二次、重送/重啟、未送出、明確失敗/不明、人工接手與 owner 隔離測試，執行確認 RED。
- [x] 最小實作持久狀態與送出時介紹前綴，保留去重與人工接手。
- [x] 執行相關測試確認 GREEN，更新 migration 期待版本。

### Task 2: 核准文案與一般營業時間

**Files:** `src/policy.ts`, `src/knowledge.ts`, `src/clients/ai.ts`, `knowledge/facts.json`, `knowledge/salon.md`, 相關 policy/FAQ/preview/worker 測試。

**Interfaces:** `applyPolicy` 與 `humanFallback` 仍回傳 `AiResult`；不自由發送模型原文；Task 1 前綴不含 emoji。

- [x] 寫核准四類模板、一般/日期營業與組合問題測試並確認 RED。
- [x] 更新核准知識、模板與角色提示；只做文字政策，不加圖片功能。
- [x] 跑相關測試確認 GREEN；對既有期待更新已核准文案/時間。

### Task 3: 驗證與交付

- [x] `npm run check`、`npm run build`、`npm test -- --test-concurrency=1` 全通過（157/157）。
- [x] 獨立 review 範圍、競態、隱私、營業日與上限；具名節日漏接已 RED→GREEN 修正。
- [x] 更新 `docs/VALIDATION.md` 與啟動 migration 注意事項，本地提交並回報 SHA；不推送部署。
