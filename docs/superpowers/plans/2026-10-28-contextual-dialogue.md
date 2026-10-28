# 有界自然對話實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用有界客人上下文承接報價與預約，在核准事實內保留AI簡短自然措辭。

**Architecture:** 原有events提供有界上下文；純函式整理slot與已核准價格，policy建立本則事實／缺項plan；單次AI輸出帶事實placeholder的自然短句，驗證與替換後沿原Worker／Store送出。失敗使用本則安全簡答，API失敗仍轉人工。

**Tech Stack:** 現有TypeScript、Zod、OpenAI Responses、Postgres/PGlite；不新增依賴、服務或migration。

**Spec:** `docs/superpowers/specs/2026-10-28-contextual-dialogue-design.md`

## Global Constraints

- 只本地，不推送部署、不真API或LINE、不改live/ai。
- 金額為已核圖折後價lookup，不再計折扣；剪髮700、一般11–18、入口https://harrishair.tw。
- 首次AI身份、人工接手、角色隔離、通知與冪等不變；requested仍轉人工。
- 不假稱已備註／通知／成立預約；特定日營業未知。

## Review Focus

- assistant提議、客人否定／多選與晚到舊訊息不可變成已確認slot。
- 純「我是新客」及項目／長度更正不得丟上下文、引用前價或再打折。
- AI自然短句不得繞過price/date/booking/action placeholder驗證或自行插入link／介紹。
- 預約接手後續訊仍分析通知但不回客人，也不重置owner恢復決定。
- 不同客人／owner preview／重送、API失敗和重啟維持隔離與去重；測試mock不能冒充真模型品質。

### Task 1: 上下文與價格來源

**Files:** 新增 `src/dialogue-context.ts`, `test/dialogue-context.test.ts`；修改`src/knowledge.ts`, `knowledge/facts.json`；新增 `knowledge/price-source.md`。

**Interfaces:** `resolveDialogueContext(text, history)`回傳service、length、customerType、currentTime、bookingActive、ambiguous；`HairService=剪髮|染髮|燙髮|燙染`, `HairLength=S|M|L|XL`, `CustomerType=new|member`。`SalonFacts.haircutPrice?:number`與`priceTable?:{service:染髮|燙髮|燙染,length,newCustomer:number,member:number}[]`；舊facts與emptyFacts可繼續使用。

- [x] 寫上下文承接／更正／否定／多選／助手誤導與核准lookup資料的RED測試。
- [x] 最小實作上述純函式與已核圖結構化價格、來源；本則時段只來本則原文。
- [x] 相關測試GREEN並核對L染2780／2910與獨立剪700。

### Task 2: 自然生成與事實邊界

**Files:** `src/policy.ts`, 新增`src/reply-guard.ts`, `src/analysis.ts`, `src/types.ts`, `src/clients/ai.ts`；測試`test/contextual-policy.test.ts`與相關既有policy/client/FAQ測試。

**Interfaces:** 保持AiResult；AiInput增加可選本則replyPlan（allowed claims、required placeholders、缺項），`analyzeMessage`使用同一plan給AI及驗證。`applyPolicy`對同一客人history產生安全結果；handoff抽取可延續服務但新時段須原文支持。

- [x] 寫多輪價格／客群／缺項／時段、兩種實際生成措辭與順序、謝謝、未知、假日、錯價／注入／假通知的RED。
- [x] 建立本則plan與placeholder驗證，保留合格模型原文；失敗依本則安全簡答，不再固定重貼表或連結。
- [x] 更新AI提示與fake-fetch邊界測試，跑相關測試GREEN；必要舊期待只依新授權行為更新，不刪安全斷言。

### Task 3: Worker上下文與整合驗收

**Files:** `src/store.ts` history來源排序；`test/contextual-worker.test.ts`、既有相關測試；`docs/VALIDATION.md`、`docs/CONVERSATION_EXAMPLES.md`與README／知識指南。

**Interfaces:** 沿Store.history per-user有界原文；Worker沿相同analyzeMessage與handoff規則，不增加外部送達聲稱。

- [x] RED測試同客人3輪、人工接手後三點、不同客人隔離、亂序／更正、重送／API失敗與重啟。
- [x] 最小接入與相關GREEN；實際mock輸出另存範例artifact，標清楚非真模型。
- [x] 完整`npm run check`、`npm run build`、`npm test -- --test-concurrency=1`（219/219），獨立review三項Important均RED→GREEN修正；末次自查未識別縮寫亦先RED再保守清空舊服務。
- [x] 更新證據與取捨，提交本地可審版本，不推送部署。
