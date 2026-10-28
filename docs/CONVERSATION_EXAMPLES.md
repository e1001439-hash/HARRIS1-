# 自然句子版本：實際本地mock流程輸出

本頁取自 `/tmp/harris-natural-dialogues-final.json`，是本地PGlite／Store／生成接入／語意核驗比對／Worker／通知流程的實際輸出。**生成草稿與核驗報告都由測試分開人工指定，LINE也是假實作；不是實際模型生成或真實手機收發。** 不以mock的supported宣稱真實語意核驗準確率，也不以程式保留句子宣稱自然度已被本人驗收。

前版26片語＋整句插槽範例已由本頁取代。此版日常措辭不設片語白名單，只有數值／URL等原子值與固定待Harris確認例外。每組獨立測試資料，同組同客人只首次介紹。下列原樣保留實際回覆，不再替程式潤稿。

## 自然報價→新客→重啟→首次時段→接手後修改

**客人A：** 胸上染髮多少？

人工mock草稿（尚未填值）：

> 胸上屬於 L 的染髮長度，新客折後是{{price_new}}元，會員則是{{price_member}}元喔 😊

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/染髮/L/new/2780/affirmed`；`price/染髮/L/member/2910/affirmed`；`price_basis/None/None/None/already_discounted/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 你好～我是 Harris 的訊息小幫手，是協助回覆訊息的 AI。
>
> 胸上屬於 L 的染髮長度，新客折後是2,780元，會員則是2,910元喔 😊

**客人A：** 我是新客

人工mock草稿（尚未填值）：

> 第一次來的話，這個髮長染髮折後就是{{price_new}}元，不需要再算一次折扣囉 😊

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/染髮/L/new/2780/affirmed`；`price_basis/None/None/None/already_discounted/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 第一次來的話，這個髮長染髮折後就是2,780元，不需要再算一次折扣囉 😊

**客人A：** 週六兩點呢？

人工mock草稿（尚未填值）：

> 你想約的是{{requested_time}}染髮，{{pending}} 😊

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`booking_time/None/None/None/週六兩點/affirmed`；`service/None/None/None/染髮/affirmed`；`requires_harris/None/None/None/booking/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 你想約的是週六兩點染髮，這個時段需由 Harris 確認，請稍等唷 😊

**客人A：** 三點也可以

人工mock草稿（尚未填值）：

> 人工接手中

沒有核驗對客草稿：人工接手中，只抽取需求。

**程式：** 沒有自動回覆客人；依人工接手或較舊事件抑制規則處理。

**假LINE實際交付店主的最後整理節錄：**

> 期望時間：三點
> 項目：染髮

## 更正項目與長度→會員→自然謝謝→剪髮完整句

**客人A：** 胸上染髮多少？

人工mock草稿（尚未填值）：

> 胸上屬於 L 的染髮長度，新客折後是{{price_new}}元，會員則是{{price_member}}元喔 😊

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/染髮/L/new/2780/affirmed`；`price/染髮/L/member/2910/affirmed`；`price_basis/None/None/None/already_discounted/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 你好～我是 Harris 的訊息小幫手，是協助回覆訊息的 AI。
>
> 胸上屬於 L 的染髮長度，新客折後是2,780元，會員則是2,910元喔 😊

**客人A：** 不是染髮，改燙髮，長度肩上

人工mock草稿（尚未填值）：

> 那以肩上的燙髮來看，新客是{{price_new}}元，會員是{{price_member}}元，這些都是折後價。

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/燙髮/M/new/2800/affirmed`；`price/燙髮/M/member/2975/affirmed`；`price_basis/None/None/None/already_discounted/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 那以肩上的燙髮來看，新客是2,800元，會員是2,975元，這些都是折後價。

**客人A：** 我是會員

人工mock草稿（尚未填值）：

> 會員這個長度的折後費用是{{price_member}}元，表上已經折好了喔 😊

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/燙髮/M/member/2975/affirmed`；`price_basis/None/None/None/already_discounted/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 會員這個長度的折後費用是2,975元，表上已經折好了喔 😊

**客人A：** 謝謝

人工mock草稿（尚未填值）：

> 不會啦，有想到其他問題再問我就好 😊

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：無
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 不會啦，有想到其他問題再問我就好 😊

**客人A：** 那改成剪髮呢？

人工mock草稿（尚未填值）：

> 改剪髮的話，費用就是{{price}}元喔 😊

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/剪髮/None/None/700/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 改剪髮的話，費用就是700元喔 😊

## 不同客人上下文隔離與自然缺項問句

**客人A：** 胸上染髮多少？

人工mock草稿（尚未填值）：

> 胸上屬於 L 的染髮長度，新客折後是{{price_new}}元，會員則是{{price_member}}元喔 😊

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/染髮/L/new/2780/affirmed`；`price/染髮/L/member/2910/affirmed`；`price_basis/None/None/None/already_discounted/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 你好～我是 Harris 的訊息小幫手，是協助回覆訊息的 AI。
>
> 胸上屬於 L 的染髮長度，新客折後是2,780元，會員則是2,910元喔 😊

**客人B：** 我是新客

人工mock草稿（尚未填值）：

> 可以先跟我說想了解哪個服務嗎？

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：無
- questions：service；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 你好～我是 Harris 的訊息小幫手，是協助回覆訊息的 AI。
>
> 可以先跟我說想了解哪個服務嗎？

**客人B：** 我想問胸下染髮多少？

人工mock草稿（尚未填值）：

> 如果是第一次來，胸下染髮的折後費用是{{price_new}}元喔 😊

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/染髮/XL/new/3020/affirmed`；`price_basis/None/None/None/already_discounted/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 如果是第一次來，胸下染髮的折後費用是3,020元喔 😊

**客人A：** 我是會員

人工mock草稿（尚未填值）：

> 會員這個長度的折後費用是{{price_member}}元，表上已經折好了喔 😊

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/染髮/L/member/2910/affirmed`；`price_basis/None/None/None/already_discounted/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 會員這個長度的折後費用是2,910元，表上已經折好了喔 😊

## 較舊來源訊息晚到不覆蓋最新項目與長度

**客人A：** 胸上燙髮多少？

人工mock草稿（尚未填值）：

> 胸上燙髮，新客{{price_new}}元、會員{{price_member}}元，表上列的就是折後價喔。

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/燙髮/L/new/3200/affirmed`；`price/燙髮/L/member/3400/affirmed`；`price_basis/None/None/None/already_discounted/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 你好～我是 Harris 的訊息小幫手，是協助回覆訊息的 AI。
>
> 胸上燙髮，新客3,200元、會員3,400元，表上列的就是折後價喔。

**客人A：** 改成肩上染髮

人工mock草稿（尚未填值）：

> 那以肩上的染髮來看，新客是{{price_new}}元，會員是{{price_member}}元，這些都是折後價。

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/染髮/M/new/2540/affirmed`；`price/染髮/M/member/2655/affirmed`；`price_basis/None/None/None/already_discounted/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 那以肩上的染髮來看，新客是2,540元，會員是2,655元，這些都是折後價。

**客人A：** 胸下燙髮

本則未進生成器（較舊來源事件已被抑制）。

**程式：** 沒有自動回覆客人；依人工接手或較舊事件抑制規則處理。

**客人A：** 我是新客

人工mock草稿（尚未填值）：

> 第一次來的話，這個髮長染髮折後就是{{price_new}}元，不需要再算一次折扣囉 😊

人工mock核驗報告（節錄；evidence為上列候選句的原樣完整子句）：

- verdict=`supported`，complete=`true`，persona=`assistant`。
- facts：`price/染髮/M/new/2540/affirmed`；`price_basis/None/None/None/already_discounted/affirmed`
- questions：無；actions=0；issues=0。

**程式來源：** 自然原句通過mock核驗＋程式比對（不是真人或真模型品質驗收）

**實際送入假LINE：**

> 第一次來的話，這個髮長染髮折後就是2,540元，不需要再算一次折扣囉 😊

## API失敗→重送去重→人工接手後續訊

**客人A：** 胸上染髮多少？

人工mock生成器：拋出API錯誤，沒有草稿。

**程式來源：** API失敗後的固定轉人工回覆（未完成自然生成／核驗）

**實際送入假LINE：**

> 你好～我是 Harris 的訊息小幫手，是協助回覆訊息的 AI。
>
> 收到～這部分要由 Harris 幫你確認喔，先稍等一下 😊

**客人A：** 胸上染髮多少？

同一事件重送；未再呼叫生成／核驗，也沒有再次回覆。

**客人A：** 週六三點呢？

人工mock草稿（尚未填值）：

> 人工接手中

沒有核驗對客草稿：人工接手中，只抽取需求。

**程式：** 沒有自動回覆客人；依人工接手或較舊事件抑制規則處理。

**假LINE實際交付店主的最後整理節錄：**

> 期望時間：週六三點
> 項目：染髮

## 驗證界線

- 五場景有實際assert，來源 `test/contextual-worker.test.ts`。自然同義句、缺項問法、道謝、錯價／交換客群、假通知／承諾／敲定、價格否定／再折、日期scope與缺漏核驗另在pure測試覆蓋。
- 第三方模型是否正確抽取每個違規聲稱，無法由人工mock核驗證明；若真核驗器漏抽卻錯報complete，仍可能有相關模型錯誤。
- 兩階段最多兩次既有模型API，會增加未來費用與延遲；共19秒deadline與abort、零重試。這輪沒有真API用量，不估算實際帳單或通過率。
- requested仍立即轉人工，之後包括道謝都不自動回客人，除非Harris明確恢復；對話仍按每客人10turn／30天有界。
- 未推送、部署、改live/ai或發真實訊息。價格來源保持既有已核圖轉錄，未新增網站/POS／選單免AI功能。
