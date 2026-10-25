# 安全測試配對實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 測試模式可只配置店主啟動，透過店主明確開啟、指定人傳入一次性文字、店主再次確認，安全加入測試者。

**Architecture:** 沿用既有簽章驗證、店主管理命令與 PostgreSQL。配對窗口五分鐘，只有一位待確認候選；保存碼的雜湊及最少識別，不存候選原文。只有店主確認後才寫入持久測試授權；未知一般訊息仍忽略。配對碼由既有 channel secret 做領域隔離 HMAC，依管理事件產生144位元難猜文字，讓重試回覆同碼且不必存明碼。配對狀態依 channel secret 指紋及店主隔離；管理命令及回覆不保留敏感內容。

**Tech Stack:** 沿用 Node 24、TypeScript、Node crypto、PostgreSQL/PGlite；不新增套件、網頁、外部服務、OAuth 或正式憑證。

**Spec:** 本任務 2026-10-25 使用者回覆「好」，同意「開啟短時間配對→指定的人傳測試文字→本人確認才加入」，授權僅本地功能與測試。既有接待、及時通知與人工接手規則維持。

## Global Constraints

- 不推送、部署、變更正式設定／權限、產生或配置實際憑證，不發真實 LINE 訊息。
- 預設仍 `BOT_MODE=test`（測試模式）、`RESPONSE_MODE=fixed`（固定回覆）；測試者名單可空白，只有店主可進入管理流程。
- 驗證原始 LINE 簽章後才處理配對；群組／多人聊天不參與。owner 永遠不能成為 customer。
- 配對碼只私下回覆店主，難猜、五分鐘到期、捕捉一次即消耗；任何候選仍需本人確認。不自動授權第一位私訊者。
- 候選原文與配對碼不寫一般事件或日誌；候選識別在到期／取消／確認後清除。閉合窗口metadata最多24小時，正式測試授權保留至移除且依scope隔離。
- 訊息重送、命令重試、取消、到期及重啟不能重開舊窗口或讓未確認候選取得接待權限。

## Review Focus

- 空白測試者名單沒有另一個隱藏啟動條件；LINE secret/token、owner ID與DB仍安全必填，固定模式不需AI金鑰。
- 客人偽造管理命令、店主誤傳配對文字、群組、錯誤簽章、錯碼一律不能開放接待或進AI。
- 配對後、確認前的候選仍被隔離；確認後正常接待；取消／到期／重放不能改換候選；移除後再次拒絕。
- 重啟、owner/channel變更、工作租約恢復不擴大授權；原始通知、人工狀態與tester撤銷相容。
- 通用事件／日誌不留配對碼或候選原文，清理不刪有效授權，但能清掉過期候選及短期metadata。

### Task 1: 配對狀態與授權儲存

**Files:** `src/pairing-store.ts`, `migrations/004_test_pairing.sql`, `test/pairing-store.test.ts`。

**Interfaces:** `PairingStore(db)` 提供 `open(context,eventId,codeHash)`、`capture(context,eventId,userId,codeHash)`、`status(context)`、`confirm(context,ref)`、`cancel(context)`、`remove(context,ref)`、`isTester(context,userId)`、`cleanup()`。context為`{scope,ownerId}`；window為`{ref,status,expiresAt,candidateAt}`，不暴露碼或候選ID。

- [x] 寫失敗測試：雜湊、一次性、TTL、取消／重放、確認前後、owner誤配、scope隔離、重啟、清理及撤銷。
- [x] 同交易鎖保護窗口及grant；實作最小資料保存。跑 SQL 測試通過。

### Task 2: 中文管理命令與安全啟動

**Files:** `src/pairing.ts`, `src/app.ts`, `src/worker.ts`, `src/commands.ts`, `src/config.ts`, `src/runtime.ts`, `src/types.ts`, `src/store.ts`, `test/pairing.test.ts`, `test/config.test.ts`。

**Interfaces:** `PairingService`以config及PairingStore提供owner-only管理命令、處理候選文字及查詢測試資格。中文命令：`/配對`、`/配對狀態`、`/確認配對 P…`、`/取消配對`、`/移除測試 P…`。管理命令只處理近50秒內、已驗證owner事件。候選以`測試配對 <一次性文字>`傳入，接收端不回覆；用原有LINE reply私下向owner顯示候選代號與時間，不能自動授權。

- [x] 先寫owner-only完整啟動與配對端到端失敗測試，確認失敗。
- [x] 保留簽章、原角色分流、靜態名單相容；僅允許明確確認的動態測試者。工作執行時再次檢查資格。
- [x] 配對管理回覆採敏感事件清除，不存明碼；候選配對文字不進一般事件／AI／日誌。
- [x] 跑完整check/test/build及獨立審查；更新中文啟動／驗收清單，僅本地提交。

## 授權與交付

使用者已授權實作，直接完成本地工作，不再重問。外部實際配對、人選、LINE設定、憑證與部署均另待確認。程式工作與SQL測試可固定介面分工；最後由主要代理整合並跑完整回歸。

完成證據：99項完整測試通過，check/build通過；既有真 PostgreSQL TLS 回歸1項及實際編譯版 owner-only 啟動 `/readyz=200` 通過。獨立安全審查無嚴重／重要問題；文件已補保留語法與撤銷不能收回已外送請求的邊界。未加入新套件或正式密鑰，未推送或部署。
