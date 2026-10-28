# 自然句子與語意核驗修正計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 移除片語白名單與整句插槽，保留通過事實／行為核驗的自然原句。
**Architecture:** 既有context/policy建立允許事實與缺項；原子數值renderer＋同供應商獨立semantic review＋canonical比對；失敗安全fallback，source可辨。
**Tech Stack:** 現有TS/Zod/OpenAI/PG；無新服務、依賴、migration或secret。
**Spec:** `docs/superpowers/specs/2026-10-28-natural-sentences-design.md`

## Global Constraints

- 僅本地，不推送／部署／真API／LINE。保留價格精確值、context、接手、隔離、去重。
- 不再以片語清單或整句price/question/thanks限制日常自然句；pending為安全例外。
- 最多兩次同供應商請求、零重試、store=false、共同19秒deadline與abort。
- 語意核驗非形式證明，mock非真模型品質；source不由生成器自報。

## Review Focus

- 正確金額交換客群、再次折扣、否定／日期scope必須拒絕。
- 假通知、未來承諾、敲定、冒充及未知事實不能只因schema正確放行。
- 缺項問句可自然變化，開放greeting與謝謝不能被白名單封死。
- missing verifier／不完整核驗／假evidence／逾時遲到結果一律不採自然草稿。
- 原有manual handoff、首次介紹、owner preview與重送不回歸；明示fallback。

### Task 1: 原子值與語意核驗邊界

**Files:** `src/reply-guard.ts`, `test/reply-guard.test.ts`。
**Interfaces:** 匯出SemanticFact、SemanticReview、NaturalContract、VerificationInput、verificationSchema、renderAtomicReply、checkSemanticReview；規格見spec。

- [x] 先RED未預先列舉自然句可保留，以及錯價／角色交換／假action／否定／scope／缺漏反例。
- [x] 原子renderer不檢查語句白名單；結構化semantic抽取canonical比對與完整性fail-closed。
- [x] 純測試GREEN；不聲稱mock語意判讀等於真模型準確率。

### Task 2: 生成／核驗與deadline接入

**Files:** `src/clients/ai.ts`, `src/types.ts`, `src/analysis.ts`, `src/natural-plan.ts`, `src/policy.ts`, `src/preview.ts`；client／analysis測試。

- [x] RED單次gen＋獨立review請求、未白名單同義句保留、核驗失敗與逾時取消／不啟動遲到review。
- [x] 生成提示移除片語／整句限制，plan只傳facts/questions/atoms；現有model/key與安全錯誤分類沿用。
- [x] 共同19秒abort；replySource由程式設定且owner預覽明示；未知／失敗保守fallback。
- [x] 相關GREEN；無真API呼叫。

### Task 3: 多輪驗收、回歸與交付

**Files:** `test/contextual-policy.test.ts`, `test/contextual-worker.test.ts`及必要既有測試；README、knowledge指南、CONVERSATION_EXAMPLES、VALIDATION。

- [x] 多個不在前版片語清單的自然報價／問句／謝謝原句通過；假的通知／已預約及錯價拒絕。
- [x] 保留context／價格／更正／隔離／手動接手／API失敗／重送／重啟測試；mock草稿與mock核驗分開標示。
- [x] 獨立程式review與必要RED→GREEN修正，完整check/build/test（245/245）。
- [x] 本地提交、完整範例與限制，明確最大兩次API成本／延遲與未真驗項；不推送部署。
