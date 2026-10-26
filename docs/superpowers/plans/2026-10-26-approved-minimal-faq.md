# 核准最小 FAQ 本地實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans。沿原工作分支本地實作，測試後獨立審查；禁止推送、部署、正式設定與真實訊息。

**Goal:** 用 Harris 已提供的三類回法完成最小客服文字模板，未知資訊仍轉人工。

**Architecture:** 沿用既有 facts schema、文字 LINE client 與 policy。剪髮固定700元，其餘價目表引導不做數字報價；預約入口改為本人確認的 https://harrishair.tw。圖片功能不新增。

**Tech Stack:** Node 24、TypeScript、Zod、node:test、既有 PGlite 測試。

**Spec:** 本輪本人提供的預約／剪髮／燙染回法、主對話已檢視價目表的文字核對、已確認預約網址；原總設計見 ../specs/2026-10-24-line-salon-assistant-design.md。

## Global Constraints

- 僅本地改動；BOT_MODE=test 與 RESPONSE_MODE=fixed 預設保持，無實際 AI key／模型／API 額度設定。
- 剪髮700元獨立，不計算新客／會員折扣、不加入含洗等未確認說明。
- 燙染與價目表引導：選單已有新客／會員折後金額，依長度選擇，不再自行打折，不存整張價表數字為報價功能。
- 預約只詢問需求、引導本人確認的網址；不承諾空檔、保留時段或完成預約。
- 不保存私人聊天、姓名、頭像、休假與具體承諾；只保存去識別化語氣規則。
- 不下載或公開私人圖片。正式價目表圖片尚未接 LINE，回覆不可聲稱已傳送。

## Review Focus

- 模型把純問價誤判為預約：仍回答核准價目，真正混合預約需求仍保留。
- 價格判斷攔截燙染 FAQ：實際問題能得到選單指引，無自行算價。
- 含洗、護理、訂金、取消等未核准問題：不因包含服務詞而套用無關 FAQ。
- facts 未核准時：不能從資料檔外洩未核准服務價格。
- 預約網址舊預設／環境覆寫：新預設確實供實際回覆使用，部署前仍須檢查既有環境覆寫。

## Task 1：資料、模板與回歸驗證

**Files:** knowledge/facts.json、knowledge/salon.md、src/config.ts、src/policy.ts、test/approved-faq.test.ts、test/worker.test.ts、.env.example、README.md、docs/SETUP.md、docs/VALIDATION.md。

**Interfaces:** 沿用 loadFacts(path)、loadConfig(env)、applyPolicy(value,text,knowledge,bookingUrl,facts,history) 與 Worker，無 schema／外部介面擴充。

- [x] 先新增真實資料檔→policy／worker 的測試：剪髮700不折扣、燙染選單與長度、未知內容轉人工、純詢價誤判防護、混合預約與問價、已知／未知時段、固定模式與人工接手保留。
- [x] 執行 `node --import tsx --test test/approved-faq.test.ts`，確認失敗原因是尚未提供的資料／模板行為。
- [x] 最小更新知識、網址與文字模板，調整詢價分支；無新圖片功能、無所有價格自動報價。
- [x] 執行相關測試，再執行完整 `npm run check`、`npm test`、`npm run build`，讀取結果。
- [x] 獨立審查、修正必要缺陷、記錄測試與仍待真實驗收事項；僅本地保存。

## 交付紀錄

獨立審查唯一 Important：服務詞過廣導致未知問題誤套價目表FAQ。先以「染髮有護髮嗎」等回歸重現失敗，再將服務說明放回詢價分支、FAQ只匹配價目表／價單。修正後新增5項全數通過，沒有待處理的嚴重／重要審查項。

Ruling：完整預設與併行2兩輪各出現不同原有5秒等待超時，均保存日誌；不延長時限、不修改配對／背景產品邏輯，最終同一批套件循序執行116項全通過。此選擇保留併行時序風險，不能據此斷定超時根因或聲稱預設併行已全綠。詳見 ../../VALIDATION.md。
