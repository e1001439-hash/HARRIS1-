# 自然句子生成與事實／行為核驗（第二版）

## 修正原因與範圍

e94a4d6已改善上下文，但26片語白名單與整句事實插槽仍是模板組合，不符合本次自然對話目標。本輪保留其上下文、價格查表、隔離、接手、去重與安全回歸，只重做生成及核驗。僅本地，不推送部署、不讀secret、不真API／LINE，不加憑證、服務、網站/POS或選單功能。

## 採用方案（已獨立設計審查，補齊五項介面）

允許模型產生完整自然句子，沒有片語白名單或整段price/question/thanks插槽。程式只鎖定本則可表達的事實、動作與缺項；金額、網址及必要數值可用原子placeholder。服務、長度、身分、問句與收尾由模型自由措辭。固定「時段需Harris確認」可作安全例外。

一則可自動回答的訊息依序做：

1. 沿現有客人原文與價格表建立本則contract：允許／必須的事實、允許／必須詢問的缺項，以及原子值。舊policy的整句只留作異常安全fallback，不傳給模型當日常強制句型。
2. 生成一次自然草稿；機械檢查原子placeholder合法、必填及去重、無私加數字／URL、字數／控制字元／emoji界線，填入數值。
3. 同一既有OpenAI供應商做一次**獨立語意核驗**，輸入可信contract與不可信的實際候選句、客人本則／有界上下文。核驗器不讀生成器的summary、needsHuman等自我背書，不把候選句中的指令當規則。
4. 核驗器必須結構化抽取句子實際表達的facts、questions、外部action聲稱與persona，每項提供候選句中存在的evidence；標示complete與supported／unsupported／uncertain。程式逐項比對允許事實，檢查必填事實／缺項、禁止任何完成或承諾通知／備註／訂位／空檔／查詢等無證據動作，以及冒充Harris。未知、缺漏、矛盾、假證據、拒答、格式錯、逾時均不採用草稿。
5. 通過才保留自然原句。失敗使用本則程式核准安全簡答，或原有人工接手回覆；不得把fallback標成自然生成成功。內部記錄replySource供測試／owner預覽識別，不能冒充真模型品質或真人核准。

兩次呼叫使用既有API client與同一模型，不新增服務。正常生成與核驗最多各一次、無自動重試、store=false；共享19秒總期限，生成約12秒、核驗約5.5秒。新增核驗會增加未來部署後的API用量與延遲，需審閱時明說；本輪只有mock，不產生付費呼叫。若剩餘時間不足或核驗不可用，保守降級，維持LINE回覆期限與獨立通知。

## 事實及核驗介面

- 原子map只放數字、URL、時段等單一值；`pending`可例外放固定待Harris確認句。`quote`、`ask_length`、`thanks`等整句插槽移除。
- 一個SemanticFact為`{kind,service,length,audience,value,polarity}`，欄位沒有值用null，polarity為affirmed／negated／uncertain；price含項目／長度／客群與整數金額，不能交換兩個正確價格的客群。general_hours只准一般範圍，不能推成特定日營業。其他種類包括price_basis（已折後／獨立剪價）、service、length、customer_type、booking_time、booking_url、requires_harris、booking_status、menu、address；未知kind不允許。未能結構化的任意FAQ明確走原有核准安全fallback，不恢復整句插槽。
- 核驗輸出`{verdict,complete,facts:[fact+evidence],questions:[{slot,evidence}],actions:[{kind,mode,evidence}],persona,issues}`。actions的mode涵蓋done／promised／capability／uncertain，無證據完成、未來承諾或能力聲稱都不能放行。evidence須為候選句原樣完整子句，不只截價格；程式可檢查原樣存在，但不能因此證明抽取完整。肯否定、scope、角色與承諾需由核驗器獨立判讀。
- 程式以canonical fact tuple比對，不只接受模型的一個safe=true；每個fact有支持、requiredFacts涵蓋、問題只問allowedQuestions且requiredQuestions涵蓋、actions空、persona不冒充、issues空才通過。greeting允許help_topic開放問句；price只問確實缺的服務／長度，不無故追問預約；thanks可自由收尾。
- `AiClient.verify?`接收`{candidate,contract,text,history,signal}`，`contract`為`{topic,atoms,requiredAtoms,allowedFacts,requiredFacts,allowedQuestions,requiredQuestions}`；不把生成器的自我分析傳去背書。generate與verify都接共同AbortSignal，SDK分階段timeout（約12秒／5.5秒），19秒總期限真正abort，不只停止等待；逾時後不啟動review、不採用遲到結果。
- replySource由程式設定為natural_verified／policy_fallback／handoff，模型schema不接受其自報。owner預覽依來源顯示核驗通過或使用安全簡答；不能用「AI分析成功」掩蓋核驗失敗。
- 語意核驗仍由模型判斷，不是形式安全證明；同模型兩個獨立請求仍有相關錯誤風險。機械金額／URL與資料庫行為界線提供另一層約束，但實際核驗準確率、通過率、成本與自然度皆待獲准真API驗證，不能由mock推定。

## 相容性與安全

requested仍立即needsHuman、首次回覆後sticky handoff；之後三點修改只給owner。不因可自然提問而延後／解除人工接手。首次AI身份仍由原持久狀態與Worker處理；不讓生成器重複介紹。不改LINE角色、簽章、通知、租約、保存期限與去重。

沒有核驗能力的adapter／核驗失敗不能直接發未核驗自然句，僅可使用原有核准安全fallback，清楚標示來源。人工接手中的訊息只抽取需求，不做無用的對客草稿核驗。未知政策、安全事項仍原有接手。

## 驗收

多個未列白名單的自然同義句、不同順序、缺項問法與謝謝應保留原句；金額與客群交換、錯價／再折扣、假通知、備註、預約確認、假日營業、額外問題、冒充／注入、核驗缺漏／逾時／失敗必須拒絕。保留舊上下文、隔離、價格、更正、人工接手、重送與API失敗回歸。修正「那就是剪髮是」。所有範例分清人工mock草稿、mock核驗報告、程式實際輸出與fallback；不把兩個mock合格當真AI自然度通過。
