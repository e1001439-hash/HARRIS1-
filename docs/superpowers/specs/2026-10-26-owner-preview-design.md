# 店主問題預覽設計

本人已同意新增 `/preview 問題`，讓自己在不麻煩朋友的情況下測試 AI 回覆。支援中文別名 `/預覽 問題`。本輪僅本地程式與假 API 測試，不推送、不部署、不呼叫付費 API。

沿用已選定的 LINE 店主指令，而非新增網頁或要求第二個 LINE 帳號：只接受簽章驗證後、owner 的一對一文字訊息，且 `BOT_MODE=test`、`RESPONSE_MODE=ai`。非 owner 的預覽語法不進客人接待；群組、錯誤簽章仍由既有 webhook 防護拒絕。問題最多1000字元，空白／過長／過期或無回覆憑證均不呼叫 API。

共用現有 AI.generate → applyPolicy／人工保護路徑，傳入目前核准知識與空 history，不查詢他人／店主舊對話。需直接人工處理的題目只顯示規則結果，明示未呼叫AI。有效一般問題只回店主預覽與處理判斷，明示未發給客人、未建立預約，成功亦不等於客人端到端驗收。

預覽保留店主管理身分；沿用 owner 事件略過 task／通知的機制，每個分支均 skipTask，不調整任何 session 的 handoff。完成後沿用 privateSetup 清除預覽原文與結果，不進一般歷史或通用日誌。

限額由實作者選定為每10秒一次、滾動24小時20次。既有事件新增一個 `owner_preview_started_at` 時間欄，在 owner session 鎖、有效租約與首輪 claim 下先以 DB 時間保留額度，再呼叫 AI；保留紀錄跨重啟且失敗也消耗，重送／租約重領不重複呼叫。選擇單一 metadata 欄而非在 outcome 留特殊旗標，避免破壞現有 privateSetup 將 outcome 清空的保密規則；代價是增加一份極小 migration，不增加服務、秘密或權限。

API 錯誤只暴露固定白名單分類（認證、權限、額度、速率、模型、逾時、不完整／格式、未知失敗），不讀出或回傳原始 error message、stack、cause、URL、provider payload 或密鑰。保留既有18秒、零重試與19秒外層期限。
