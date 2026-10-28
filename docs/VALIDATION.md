# 第一版驗證紀錄與待接通事項

最初開發日期：2026-10-24。下方按日期保留各輪當時證據；歷史段落的「未部署／test」不代表目前狀態，本地驗證與外部服務驗收分開記錄。

## 2026-10-28 第二輪：自然句子與獨立語意核驗（僅本地）

前一個本地e94a4d6的26片語＋整句插槽未滿足本人核心需求，本段取代其自然度完成聲稱；219項通過僅是前版程式證據。此次先完成獨立設計review，補齊price_basis／address／非結構FAQ、肯否定與scope／未來承諾、greeting開放問句、真abort／deadline及預覽source五項，才實作。

移除措辭白名單與整句price／缺項／thanks插槽。模型可自然寫句；程式鎖定允許facts/questions/actions，金額／URL等用原子值，pending為本人允許的固定安全例外。另一次同供應商核驗獨立抽取候選句的實際facts、肯否定、questions、無證據完成／未來承諾／能力actions與persona，提供原樣evidence；程式canonical比對角色／項目／長度／客群／值，檢查必填、缺項、來源與狀態，不只接受supported。price evidence另檢查包含相同完整金額。

一般自然回覆未來最多生成12秒＋核驗5.5秒兩次既有模型請求，store=false、零重試，共同19秒AbortSignal；API失敗／不完整／核驗不確定或未配置adapter不採用自然草稿。fallback可用原有核准安全簡答，known price不必因此擅自改接手；booking原本needsHuman仍保留。replySource由程式設定natural_verified／policy_fallback／handoff，模型schema不接受自報；owner預覽明確顯示fallback，不再把「AI分析成功」當自然生成通過。

TDD證據：

- 新自然分析12項先12/12 RED→GREEN，涵蓋多個未列舉自然同義句、自由問題／謝謝、剪700正常句、兩價交換角色、假通知／承諾／能力／敲定、否定／再折／假日、額外問題、核驗缺漏／錯evidence、missing verifier，以及真abort與late gen不啟動review。
- 新原子／canonical邊界先6項RED再22項GREEN；price evidence不能只截無關字或用2700假證700，另2項先RED；最終該檔23項通過。
- 真SDK＋fake fetch API兩檔先8失敗，實作後連同舊診斷33項通過：獨立gen/review、無生成器自我背書、schema/store=false/零重試、12秒/5.5秒、abort傳遞、拒答／格式／HTTP錯誤不保存raw secrets/payload。
- 新natural-plan先5項RED後6項GREEN，證日常只有原子數值、語意事實與缺項，不傳整段句式；不結構化FAQ沿原安全fallback，不偷用整句生成slot。
- 多輪Worker五場景全通過，保留重啟、價格／更正、會員、謝謝、不同客人、亂序、重送、API失敗及接手後通知。mock生成草稿與mock核驗報告分開人工指定，不複製production contract當答案；artifact含兩者及actual outcomes.replySource。
- 獨立程式review無Critical／Important，指出timer回呼延遲可能接受deadline後的review；按硬期限需求加失敗測試（缺少預期TIMEOUT）後修正active同時比對牆鐘並abort，不把這個邊界當無關polish。另整理type-only import／EOF空行。

- 最終`npm run check`、`npm run build`皆通過。完整`HARRIS_DIALOGUE_ARTIFACT=/tmp/harris-natural-dialogues-final.json npm test -- --test-concurrency=1`為**245通過、0失敗、0跳過**（144.2秒），log `/tmp/harris-natural-full.log`。其中原上下文／價格／隔離／接手／去重／重啟回歸保留；前版25項白名單邊界改為23項原子／canonical語意邊界，不繼續把自然措辭當錯誤。新增natural-plan6、natural-analysis13、semantic-client8、owner預覽來源1，較前版219項淨增26項。
- 新自然分析＋owner預覽相關21項亦在deadline修正後通過，`/tmp/harris-natural-preview-deadline-green.log`；型別／建置log `/tmp/harris-natural-{check,build}-pre-full.log`。最終artifact `/tmp/harris-natural-dialogues-final.json`包含人工mockDrafts、人工mockReviews與actual outcomes.replySource；由此重建CONVERSATION_EXAMPLES五組完整原樣對話。沒有識別碼或retry key進範例文件。
- 本輪修改生成／核驗client、原子與canonical guard、natural-plan、analysis deadline／source、policy安全fallback、preview顯示及對應測試／知識／文件；沒有改價格數值、context原文解析、Store、Worker、通知、依賴、環境變數、migration或workflow。前版已發佈基準仍401bf62，本輪local自然版未上線。

模型若漏抽違規句卻錯報complete，程式不能形式證明其完整；同模型兩次獨立請求仍可能相關錯誤。所有通過數字僅mock協定／程式驗證，非真自然度或核驗準確率。本輪無真API／LINE、秘密讀取、新付費服務、推送或部署；未來兩次API用量與延遲需本人審閱，不能由本輪推估費用。本地可審提交保留，等待本人審閱自然語句與取捨，不以通過測試代替本人驗收。

## 2026-10-28 有界上下文自然對話（僅本地）

本人已同意先實作、看範例再決定是否更新線上。基準401bf62；本輪沒有推送、部署、真API／LINE、正式DB、憑證或費用操作，不做網站/POS或選單免AI捷徑。原生成有history卻被policy整段覆寫，是固定模板感主要來源；本輪用程式slot＋核准事實placeholder＋同一次AI有界措辭，保留合格草稿的連接語與順序。

價格來源稽核：repo原先無全表數字、圖片或CSV；依可信歷史中主對話已核對本人正式價目圖的轉錄新增結構化折後價，不宣稱本輪重新看圖。L染髮新客2780／會員2910與本輪核對一致，沒有庫內矛盾；完整來源見knowledge/price-source.md。剪700獨立，不重新折扣或猜未知價格。

上下文只取本客人user原文，10turn／30天，不把assistant建議當確認；Store.history依received_at再sequence排序，舊事件晚到不覆蓋新slot。項目／長度更正、明確新客／會員宣稱可接續；否定、非會員、資格提問及多選不能變成已確認slot。時段僅從本則原文取，不沿用前則假當新更改。未加永久偏好或migration。

保留既有接手界線：requested一律needsHuman=true，初次回覆後sticky handoff；「胸上染價→我是新客→週六兩點」可回，接著「三點也可以」只整理與通知owner，不能自動回客人。先說想預約但未給時間也可能先問缺項就接手。owner的take/resume、通知獨立迴圈、首次AI身份、lease及冪等維持，不因對話改善自動解除接手。

TDD／審查紀錄：

- 新政策13項先在舊程式10失敗／3通過（真差距為上下文、具體價格、自然草稿保留及本則plan），其後13全通過；混合索取連結的第14項亦先RED再GREEN。
- context最初模組缺失RED；後續真斷言先重現未知長度沿舊L、資格提問、價表重複key，再修正。時段更正／同指日期與否定亦先RED→GREEN；最終context16項通過。
- guard逐輪RED→GREEN。獨立審查發現只禁敏感詞仍放行「老闆收到囉／敲定囉／別信pending／pending才怪」；改採prompt與guard共用的正向有限銜接片語，逐literal驗證不跨placeholder拼字。再以👎反轉待確認重現RED，限制自由emoji為😊。guard25項通過，不把有限片語驗證包裝成任意自由文字安全證明。
- Worker整合先重現無上下文的新客轉人工、晚到舊事件覆蓋新服務／髮長；修正後5個場景全通過，包括檔案DB重開、三輪報價到首次時段、接手後三點只有owner通知、客人隔離、更正／會員／剪700／謝謝、API失敗與重送。原一次金額千位逗號／問句形式斷言過嚴已改為產品行為期待，未放寬價格、接手或隔離。
- 獨立審查共3項Important：連結分支清空混合booking/self_reported、否定與會員提及誤認slot、口語反轉／假通知。均已加失敗回歸再修正；未發現額外重要回歸。原先期待每次貼預約URL、每句問日期及只貼表的測試依本輪明確授權更新，預約未確認、未知政策與角色隔離的安全斷言保留。

- 第一輪完整套件218通過、0失敗、0跳過（152.7秒，`/tmp/harris-contextual-full.log`）。最後自查另以「改燙，胸上／先不要染，改燙」重現未識別縮寫會沿用舊染髮slot；新增失敗回歸後保守清空不完整服務，先詢問而不報前項價格。相關31項及重新型別／建置皆通過；這是保守理解邊界，不新增縮寫價格推定。最終完整重跑結果另記。
- 型別／建置log為`/tmp/harris-contextual-{check,build}-final.log`。實際fake LINE輸出artifact為`/tmp/harris-contextual-dialogues-final.json`，五組對話由此產生`docs/CONVERSATION_EXAMPLES.md`，移除測試識別碼與retry key。草稿是人工寫定的mock，沒有把它說成真模型結果；兩種不同合格稿的實際措辭／順序亦有exact-output測試，證明沒有全部被fallback覆寫。
- 最終完整`HARRIS_DIALOGUE_ARTIFACT=/tmp/harris-contextual-dialogues-final.json npm test -- --test-concurrency=1`為**219通過、0失敗、0跳過**（159.6秒），log `/tmp/harris-contextual-full-final.log`。原157項保留，新增context16、guard25、對話policy15、Worker整合5及client計畫傳遞1，共62項。`npm run check`、`npm run build`在最後程式修正後重新通過，沒有殘留失敗或待跑檢查。

變更檔案分組：

- `src/dialogue-context.ts`、`reply-guard.ts`新增有界slot與有限銜接語驗證；`policy.ts`、`analysis.ts`、`types.ts`、`clients/ai.ts`接入單次生成／核准事實計畫；`store.ts`僅調整history來源排序。
- `knowledge/facts.json`、`salon.md`及新增`price-source.md`記錄已核准折後價與自然接話／接手規則。
- 新增`test/dialogue-context.test.ts`、`reply-guard.test.ts`、`contextual-policy.test.ts`、`contextual-worker.test.ts`；更新`approved-faq.test.ts`、`clients.test.ts`、`identity-policy.test.ts`、`owner-preview.test.ts`、`worker.test.ts`的本輪行為期待與安全回歸。
- README、SETUP、本驗證紀錄、新設計／計畫及CONVERSATION_EXAMPLES提供範圍與證據。未改依賴、環境設定、migration或workflow。

新自然對話只有fake AI／LINE與真本地PGlite驗證；沒有真實模型的自然程度、草稿通過率、額度或正式客人端到端證據。安全fallback不等於自然草稿通過。需本人審閱範例後另行批准上傳／部署，沒有要求本人提供secret。本輪沒有推送、部署或補發舊訊息。新增完整價表來自已核圖轉錄，並非本輪讀取原圖；保留這項來源限制與有限口語片語的自然程度取捨。

## 2026-10-27 身份、語氣與一般營業時間（僅本地）

本輪開始時，主對話回報線上已為 `live/ai`，Web US$7／月與資料庫 US$6／月均由本人確認，四題真實 owner 預覽曾成功。第一則固定回覆及主人通知已實測，後續時段更新通知仍未真實驗收；未宣稱根因已定位。這輪沒有查正式 DB、使用真 API、讀私人聊天、補發客人訊息或改遠端。

核准身份為「Harris 的訊息小幫手」，首次透明說明 AI；「我」指助手，店主用 Harris。migration006 在 sessions 保存首次介紹事件識別，不保存額外聊天內容；與既有 markSending 的 lease/latest/handoff 及 send_started 同交易預留。成功、不明或送出後中斷保留預留，明確 failed 只清除此事件自己的預留；過期、較舊、人工接手、未獲准測試者及 owner／preview 不消耗客人介紹。對話清除、重啟或部署不重置狀態。

轉人工、剪價、燙染與預約時段使用本人核准口語模板，每則客人回覆最多一個 emoji；照片仍交 Harris，無圖片識別。一般時段11:00–18:00已核准，特定日期或休假未核准；日期營業問題先於預約分支，保留已抽取時段與需求並由 Harris 確認。沒有自動完成預約或改人工接手、通知機制。

- RED：新增首次介紹6項，在舊版均因缺少 AI 身份前綴失敗；新政策8項在舊版均失敗，原因為舊文案、hours=null或日期營業被預約分支先返回。
- 首次介紹與既有 store/outbox 相關44項通過；政策8項 RED→GREEN。政策相關檔併行跑到26項通過後，Node/V8 WASM JIT 發生原生 fatal（`jit_page_->allocations_.erase(addr)==1`）；非應用斷言失敗，未改測試門檻或產品邏輯掩蓋。為避免重複耗用，已安全停止剛開始的相關重跑（退出143），改由主代理完整單檔併發驗證；第一輪完整156項通過、0失敗（167.1秒）。
- 獨立審查發現一項 Important：日期詞清單漏「元旦」等具名節日，可能把待確認問題標成無需處理。新增包含具名節日／不熟悉日期的回歸先 RED，再只允許明確的一般營業問句使用一般時段，其餘營業上下文交 Harris 確認。此保守選擇可能讓較複雜的一般問句也轉人工，但不猜測日期營業。修正後相關12項通過；完成最小字詞辨識整理後重新跑完整套件，結果另記。審查其餘交易、角色隔離、去重、隱私與emoji組合無新增阻擋問題。

- 最終 `npm run check`、`npm run build` 通過；`npm test -- --test-concurrency=1` 完整157項通過、0失敗、0跳過（268.3秒）。原142項保留，新增首次介紹6項與政策9項；最終完整log為 `/tmp/harris-identity-full-final.log`，RED與相關測試log為 `/tmp/harris-identity-*.log`。全部 LINE／AI 皆假實作、資料庫為真本地 PGlite，沒有當作真實客人端到端驗收。

本輪已完成必要本地驗證與獨立審查修正，尚未推送部署；不能將本地新文案當作線上已生效。後續另經同意上傳／部署時需包含migration006，不需新環境變數；新版對每位尚未介紹的客人下一次實際自動回覆才介紹，不補發舊訊息。對 unknown 送達保留介紹預留是避免重傳的保守選擇，不能視為手機確實看過；後續更新通知與這輪新文案仍需分別真實驗收。

## 2026-10-26 店主問題預覽（本地，未推送部署）

核准 FAQ 版 `837e54374b0b82e2a30cd1402fc485cc5f5fbfb6` 已由本人同意上傳原 main，遠端 SHA 核對一致，[該提交 CI](https://github.com/e1001439-hash/HARRIS1-/actions/runs/40362371724) 成功（1分40秒）。其後本人回報部署 test/ai 與 `/readyz` 為 `{"ok":true}`；尚未實際驗證 API 餘額、模型請求或客人 AI 接待。Render「Live」僅部署狀態，不代表授權 `BOT_MODE=live`。

本人再同意新增 `/preview 問題`，以 `/預覽 問題` 為中文別名；本輪只本地實作與離線測試。owner 一對一、test/ai、最多1000字元；共用原 AI 分析與核准 policy，空 history，不讀取他人對話、不送客人、不建立客人／預約待辦或通知、不改人工接手。規則直接接手明示未呼叫 AI，其餘成功顯示僅店主預覽與尚非端到端驗收。沿用 owner `skipTask/privateSetup`，完成後清除 payload/outcome。

限流使用 migration005 的單一 `owner_preview_started_at` 欄與索引，保留 DB 時間；每10秒一次、滾動24小時20次，失敗或中斷也保留額度。owner session row鎖、有效事件租約與第一次claim先原子保留額度，再呼叫AI；重送、租約重領與檔案DB重啟不能額外生成。選擇時間欄而不把旗標塞進 outcome，保留既有 privateSetup 完全清除結果的不變式；代價是一個新增 migration，未更動正式資料庫。

- RED：新增店主預覽與非owner隔離先在舊版失敗；18項供應商fake fetch案例先因缺少安全分類失敗，保留 `/tmp/harris-owner-preview/red-owner.log` 與 `red-ai.log`。
- 相關驗證25項通過，涵蓋真本地PGlite、簽章HTTP、共用價目與預約政策、角色／模式／群組／簽章、空白／過長／過期、無歷史／待辦／人工變更、去重、限流、重啟及中斷；全部AI／LINE為fake，沒有使用真實金鑰或真實訊息。
- 獨立審查唯一 Important 是非型別安全 adapter 可把任意 code 放入安全錯誤。以 `PRIVATE_UNTRUSTED_CODE` 先重現失敗，再加入建構子的執行時固定集合檢查；修正後19項API診斷案例通過。安全類別不保存 raw error、cause、供應商載荷或請求秘密，未知值統一 `UNAVAILABLE`。
- 第一輪完整套件141通過、1失敗：舊 `migrations initialize durable event, session, task and outbox tables` 仍預期migration版本為 `[1,2,3,4]`，實際已依設計新增5。只更新此舊fixture預期為1至5，未修改產品邏輯或放寬其他斷言。
- 最終 `npm run check`、`npm run build` 通過；完整 `npm test -- --test-concurrency=1` 為142通過、0失敗、0跳過（249.7秒）。原116項保留，新增19項API診斷與7項預覽整合。完整證據在 `/tmp/harris-owner-preview/`；沒有把fake付費API或簽章inject當成真實手機／帳戶驗收。

本輪沒有推送、部署、API付費呼叫、憑證或正式設定變更。上傳前仍需確認差異不含秘密／私人聊天、保留test，另取得上傳與測試部署同意；部署須包含migration005，現有啟動遷移會套用。成功預覽至多證明當次AI分析與模板路徑，仍須分開驗收實際客人收發、店主通知與人工接手。已確認的gpt-5.4-mini能力／費率來自主對話官方查核，未在本雲端做付費驗證；其官方文件在本環境曾遭403，未重試或繞過。

## 2026-10-26 本人核准的最小 FAQ（僅本地）

本人已提供預約問法、剪髮700元、其餘價格引導選單價目表，以及親切口語方向，並確認預約入口為 `https://harrishair.tw`。本輪只使用這些核准內容：`facts.json` 改為核准檔內明列知識，地址／營業時間仍為 `null`；未自行加入政策、優惠資格或全表數字報價。沒有保存私人聊天、姓名、頭像、原對話或休假／預約承諾；圖片沒有下載、公開或串接 LINE，本版不聲稱已傳圖。

現有 LINE client 只有文字，沿用服務價格說明、FAQ 與語氣 schema，不新增圖片能力。剪髮回700元，不套新客／會員折扣、不添加含洗解釋；燙染與價目表詢問指向下方選單的新客／會員折後金額及長度。預約未提時間時詢問，已提供時不重問；提供已確認入口，仍明說平台確認結果為準。預約會轉人工，後續僅通知；固定模式保持原收訊確認，不會突然套用 AI FAQ。

- RED：首次5項新增驗證中4項失敗，確認舊程式缺價格、問價／預約分流、預約問法與正確入口。另以真實核准資料重現訂金等問題被服務詞誤套FAQ。
- 審查：獨立唯讀審查發現未知「有護髮嗎／幾分鐘／改期」會被寬鬆燙染關鍵詞誤標無需處理。已先加入失敗回歸，再將服務價格引導限制在詢價分支，FAQ關鍵詞收窄為價目表／價單；不以無限增加未知關鍵詞處理。5項新增驗證全部通過，覆蓋純問價模型誤判、未核准facts、未知包含內容／時間／改期／付款、真正混合預約問價、實際worker接手後續與fixed保留。外部AI／LINE全是假實作，PGlite是真本地資料庫。
- 第一輪完整 `npm test` 為115通過、1失敗、0跳過；失敗為既有 `candidate cannot receive service until explicit owner confirmation then joins fixed testing` 的5秒店主命令等待超時。沒有因此修改正式配對邏輯或延長斷言時限。該原案例單獨重跑1項通過；尚不能僅憑此聲稱已確定超時根因。
- 第二輪將完整套件併行限制為2，仍為115通過、1失敗，這次是既有 `a late older message cannot replace the newer appointment request` 的5秒背景完成等待超時；原先配對案例在此輪通過。沒有放寬斷言或更改背景產品邏輯，尚未確定超時根因。
- 最終 `npm run check`、`npm run build` 通過；`node --import tsx --test --test-concurrency=1 test/*.test.ts` 完整同一批套件116通過、0失敗、0跳過（430.9秒）。5項為本輪新增，其餘原有測試保留。這是本地循序驗證成功，不能隱去前兩輪併行超時，也不能當成真實AI端到端成功。完整本地證據保存在 `/tmp/harris-approved-faq/`。

未推送、部署、配置實際API憑證、改Render／LINE設定、切live、付費或發真實訊息。目前線上仍是 `3a375bb`／test/fixed；僅本地知識核准，不等於正式啟用授權。部署前需核對既有非秘密 `BOOKING_URL` 覆寫值與已確認入口一致，不能只改程式預設。API資料使用已有同意，但金鑰、支援模型、帳號額度及真實AI回覆品質仍未驗證，後續部署與正式客人放行需各自明確授權。Free休眠與真人後續通知未定位等既有實際限制仍保留。

## 2026-10-25 真人測試進度與固定模式後續自主驗收

安全診斷版 `3a375bb` 已推送既有 GitHub `main`，該SHA CI成功。其後本人提供真實 `database_migration / DEPTH_ZERO_SELF_SIGNED_CERT`；核對原URL主機沒有 `.render.com`，再依資料庫畫面重新複製 External URL。本人重新部署後回報公開 `/readyz` 為 `{"ok":true}`、LINE Verify 成功、店主 `/help` 收到說明、動態配對成功，第一則虛構預約的固定回覆與店主通知「兩邊都有收到」。這是本人回報的真實收發證據；本雲端對該公開主機的GET曾被代理CONNECT403拒絕，沒有將代理拒絕當成服務故障，也未繞路重試。

真人後續更新通知尚未驗證。約四十多分鐘後的「沒收到」未有足夠紀錄區分客人未回覆（人工模式預期）與店主未收到更新，不能據此斷定休眠或配對過期。五分鐘只限制未確認配對窗口；已核准授權存於 `tester_grants`，同DB／owner／channel secret跨重啟保留，人工狀態也持久化。通知原文保存門檻是30天，沒有四十分鐘自動失效條件。

本輪本人授權「不麻煩他人繼續執行」：沿既有程式做本地假訊息、持久資料庫與排程／重試驗證；必要確定bug才修補。不要求本人或測試者在線，不讀正式秘密、不連正式DB、不發真LINE、不推送／部署、不改遠端或正式模式、不升級付費。

現有日誌只含啟動、通用 `worker_error` 與 `owner_notification_failed`（notificationId、phase、delivery、attempt、terminal）；沒有webhook接受、入列成功或通知成功紀錄。因此缺少錯誤日誌、或`/readyz`成功，均不能單獨證明背景訊息與推播送達。後續若需真實歸因，可先以既有 `/pending` 是否出現該次更新縮小範圍；沒有看到也不能僅憑此判定webhook未達。

自主模擬結果：原產品程式直接通過，沒有發現確定bug，未修改 `src`。新增 `test/fixed-followup.test.ts` 三項整合驗收；完整 `npm run check`、`npm test`、`npm run build` 通過，111項通過、0失敗、0跳過。

- 真執行迴圈、簽章HTTP與檔案PGlite：動態配對→第一則固定客人回覆與假店主推播→人工狀態→45分鐘持久資料年齡→後續更新推播。實際 fake push 必須寄給owner並包含更新原文，客人沒有第二則自動回覆；AI呼叫為0。
- 同一檔案資料庫關閉重開runtime，原P授權、C客人及人工狀態仍保留，不用重新配對。兩分鐘前的更新來源時間仍比已老化的先前對話新，即使超過50秒客人回覆期限，店主仍收到更新原文。
- 通知排程未到不提早重送；重開後保留等待與retry key。模擬第二次claim在外送前中斷，未過90秒租約不能重領；租約到期後第三次claim成功，沒有虛構中斷那次已外送。三次實際失敗封頂的另一情境跨重啟仍不出現第四次，且不阻擋新更新推播。
- 時間是透過本地持久欄位與 `next_attempt_at`／`lease_until` 推進，沒有真的等待45分鐘，沒有模擬Render休眠／喚醒／外部網路或LINE投遞政策。簽章HTTP使用Fastify inject；fake push證明本地呼叫，不能當成手機實際送達。
- 獨立審查判定需求符合、核心驗收可信，無嚴重／重要阻擋。保留兩項非阻擋測試強化：重送後的outbound數量負向斷言可再加背景處理屏障；過期token案例可再明確斷言latest/manual分支。此次主要通知成功斷言及時間次序已核對，沒有將附加去重斷言視為所有非同步競態均已驗收。

本輪只本地保存測試與紀錄，沒有新的推送／部署或正式變更。實際那次未收到更新的根因仍未知；下一個最小真實檢查可以由店主本人日後查看既有 `/pending` 與通知失敗日誌，不必再請測試者重新配對或重新發訊。目前本任務沒有可用的已登入Render日誌或正式資料庫讀取管道，不能自行補出那次實際投遞／入列／送達證據。

## 2026-10-25 啟動失敗調查與安全診斷

本人提供的 Render 日誌確認 `732a51f31557c6326539df6df2e8864d3056cb92`／`main` 建置成功，執行 `npm start` → `node --use-env-proxy dist/main.js` 後，由主程式通用 catch 記錄失敗並退出1。本人最後選擇免費 Web Service、Pre-deploy 空白、`/readyz`、自動部署關閉；Webhook 尚未啟用。

已排除「不知是否舊版本」這個資訊缺口。主程式本身在監聽前執行 migration，因此不能把 Pre-deploy 空白當成漏做資料更新；程式沒有付費方案檢查，也不能由此歸因免費方案。既有 catch 及 PgDatabase 包裝抹去分類，目前沒有足夠證據確定正式部署根因，不能猜測 TLS、認證或資料庫是否需重建。

本輪僅本地補嚴格白名單診斷，不讀正式秘密、不連正式資料庫、不改正式設定、不推送／部署、不產生費用。固定 `startup_failed` 紀錄只允許階段、已知錯誤分類與已知設定名稱；跨層安全錯誤不保留原始例外或 cause，序列化不讀原始 message／stack／URL 或任意 provider payload。

- RED：實際既有 CLI 在假 invalid-owner 設定下退出1，但缺少結構化診斷，新增斷言先失敗。
- GREEN：完整 `npm run check`、`npm test`、`npm run build` 通過；108 項通過、0 失敗、0 跳過（新增9項）。覆蓋設定缺漏／格式、知識及 facts 缺檔、JSON／schema、DB URL／TLS政策、pg三個包裝邊界、已知 TLS／DNS／認證代碼、監聽失敗、清理再失敗，以及正常初始化／關閉。
- 保密測試使用假秘密、未知 code、message／stack／cause、額外欄位、toJSON、throwing getter／Proxy 與安全錯誤欄位污染，確認僅白名單輸出；不讀 getter 或任意錯誤文字來推測分類。
- 編譯版 `dist/main.js` 另外以假設定執行四種失敗：缺設定→`configuration/CONFIG_MISSING`，非法 owner→`configuration/CONFIG_INVALID`，指南缺檔→`knowledge/ENOENT`，弱 TLS 選項→`database_configuration/DB_TLS_POLICY_INVALID`。各自退出1且 stderr 僅安全 JSON，沒有假秘密、URL或檔案原路徑；均在連線前停止。
- 編譯版正常啟動沿用既有本地 PostgreSQL 17 TLS 測試容器、測試CA與假LINE值，在 production/test/fixed、零測試者、無AI金鑰下 `/readyz=200`，正常關閉；只執行本地健康 GET，沒有真 LINE 請求。啟動前確認沒有待發事件或通知，測試容器最後恢復停止。前置查詢首次誤用不存在的欄名而安全停止，依現有 `status` 欄修正後通過；產品程式不需為此變更。
- 獨立需求與品質審查通過，無嚴重／重要阻擋；發現的文件表格位置問題已修正並複核，沒有未處理項目。未把替身監聽／環境錯誤測試當成正式系統或整個Node程序所有日誌的保證。

下一個最小檢查：後續取得診斷版上傳與本人重新部署授權後，只需讀該次 `startup_failed` 的一行安全 JSON（階段／分類／必要欄位名稱）。目前實際 Render 根因仍未知；不索取設定值、不重建資料庫、不降級 TLS、不因失敗要求升級付費。

## 2026-10-25 安全測試配對（僅本地）

- 完整 `npm run check`、`npm test`、`npm run build` 通過：99 項通過、0 失敗、0 跳過。新增 13 項真 PGlite 配對儲存測試及 8 項簽章 HTTP／管理命令整合測試。
- 首次 RED 重現原設定拒絕空白測試者名單；修正後實際編譯版 `dist/main.js` 在 production（正式執行環境）、test（測試模式）、fixed（固定回覆）下啟動，測試者名單空白、AI 金鑰與模型未配置，`/readyz` 回 200。此啟動檢查使用原有本地 PostgreSQL 17 TLS 測試資料庫與假 LINE 憑證，啟動前確認沒有待發工作，只送出本機健康 GET，未對真實 LINE 發出請求。
- 同次既有 PostgreSQL 多連線順序整合測試 1 項通過；本地測試容器收尾恢復停止。沒有新增付費服務或正式憑證。
- 已驗證錯誤簽章、群組、一般 unknown（未知使用者）、偽造管理命令、店主自配、候選未確認、一次性碼重放、取消、到期、跨 owner／channel、移除後拒絕及重啟保留；原有通知與人工接手測試均保留。
- 五分鐘窗口、每窗一位候選、店主明確確認後才授權；原文與配對碼不進一般事件／AI／日誌，管理回覆會清除敏感事件內容。候選在到期／取消／確認後清除；關閉窗口的最少 metadata（中繼資料）保留最多24小時；已確認授權保留至移除。
- 配對碼是144位元 HMAC 衍生文字，只私下回給店主，使用既有 channel secret（頻道密鑰）且領域隔離；不需新增長期密鑰或 OAuth。管理事件重試回同一窗口、不延長期限，50秒新鮮度限制防止已清理舊事件重啟窗口。
- 獨立安全審查未發現 Critical／Important（嚴重／重要）阻擋項；舊設定文件已更新。含有「測試配對」配對語法的訊息屬保留流量，即使正式模式也不送入一般客服或 AI；這是避免秘密外流的明確取捨。

初次接通最小必要值仍是 `DATABASE_URL`（資料庫連線）、`LINE_CHANNEL_SECRET`（頻道密鑰）、`LINE_CHANNEL_ACCESS_TOKEN`（存取權杖）、`OWNER_LINE_USER_ID`（店主識別）；直接填安全設定。`TEST_LINE_USER_IDS`（靜態測試名單）可省略或空白，固定模式不需要 AI 金鑰。Node 24、兩個知識檔與 migration 均隨專案，不需另建檔或先取得另一人的開發者後台權限。

本人已確認原帳號 @nsw7233k、Harris 頻道及 harris841110 服務提供者，Messaging API 已「使用中」，兩處 Channel ID 一致；不再要求重做。Render 目前僅資料庫 Available 屬本人回報，Web Service 尚未部署。真實 LINE／AI、店主手機通知、指定人選及實際配對、Render 費率／自動部署設定與正式 TLS 連線，仍待後續授權驗收。本次不推送、不部署、不產生／配置正式憑證、不改權限或 LINE／Render 設定。

## 2026-10-25 先前通知補強驗證（歷史紀錄）

此節記錄配對功能之前的測試結果與當時阻礙；目前狀態以上方「安全測試配對」為準。

- `npm run check`、完整 `npm test`、`npm run build` 均通過：78 項測試通過、0 失敗、0 跳過。新增 29 項通知、接手與持久化回歸；AI 與 LINE 皆為模擬外部服務。
- 既有真 PostgreSQL 17 TLS 多連線順序整合測試再次通過：1 項通過、0 失敗、0 跳過。使用原有本地測試容器及測試憑證，完成後恢復停止狀態；沒有建立或連接新付費服務。
- 已驗證 AI 未完成、客人回覆卡住或失敗時，原文通知仍可獨立送出；通知失敗不阻止客人處理，保留分階段、固定 key 的有界重試。
- 已驗證人工接手仍抽取後續新時段；服務項目只可引用客人本則或近期對話，時段須來自本則文字；沒有客人自動回覆，也不把需求當作確認訂位。
- 已驗證手動接手後再恢復、AI／LINE 等待期間的恢復決定、租約重試及重啟不會讓舊工作改寫手動狀態。已在外部傳送中的請求無法收回，但結果不再覆寫新控制決定。
- 較早訊息的整理不覆蓋較新需求；初步原文通知獨立保留，防止抑制舊整理時連同唯一通知一起遺失。兩階段各自去重並沿用同一待辦編號，最多可能有兩種推播。
- 保留既有 30／90 天清理、租約 fencing、已確認 FAQ 與失敗降級；新增 migration 003 支援通知階段、人工訊息標記與管理決策版本。
- 獨立審查的控制時序問題與原文通知保留邊界，均以先失敗、後通過的回歸案例修正。第一次整合跑測有 1 項舊通知 fixture 不符新規則，調整為驗證實際原文 receipt 後，完整測試全部通過。

此階段僅程式與本地測試；未推送、部署、產生／配置新正式憑證、變更權限或對真實客人發訊息。當時尚未釐清的原官方帳號與頻道問題，現已由本人確認完成；不需再重做手機或帳號確認。真實 AI 理解品質、Harris 手機推播、正式資料庫與雲端服務仍待驗收。`facts.json` 仍為未核准且未新增店家政策。

## 初版驗證（歷史紀錄）

- `npm test`：49 項通過、0 項失敗、0 項跳過。測試包含原始簽章、測試名單、管理員權限、AI／LINE 失敗、送達不確定、預約狀態、通知退避重試、待辦分頁、資料保存期限、HTTP 完整流程及資料庫重啟。
- `npm run check` 與 `npm run build`：通過；包含測試及獨立 PostgreSQL 整合測試的型別檢查。
- 以 lockfile 執行 `npm ci --include=dev` 後重新檢查與建置，不停用套件完整性或 TLS 驗證。
- 本地 CLI demo：已簽章的假訊息產生一則假回覆與一則店主通知，通知有剪髮項目與期望時段；沒有呼叫真實 LINE 或 AI。
- `integration/postgres.test.ts`：在獨立 PostgreSQL 17 測試容器上執行，1 項通過。使用本地測試 CA 驗證 TLS 與主機名稱，不代表已驗證 Render 資料庫。

## 審查後修正

1. **店務資料來源**：不直接發送模型的自由文字。AI 理解需求；回覆由經確認的 `knowledge/facts.json` 與語氣模板組成。未知地址、價格、時間或問答轉交本人；預約需求及客人自述仍不視為平台成功預約。
2. **人工接手**：同一雲端程序內分開處理店主管理與客人訊息。實際排入 `/take` 指令，能在客人 AI 工作仍進行時先切換人工狀態，攔下稍後的自動回覆。
3. **通知可靠性**：失敗後約 30 秒、再約 2 分鐘重試，最多三次，保留相同推播重試識別碼。失敗以不含對話與憑證的事件記錄；待辦保留供查詢。
4. **PostgreSQL 訊息順序**：真正的多連線、交易快照與鎖定測試重現後到事件先被取得的問題。寫入前依固定順序鎖定客人狀態後，原失敗案例通過；不用內嵌資料庫的序列化結果推論正式並行行為。
5. **管理便利性**：待辦列表可接續查看較舊頁面；一般詢問不能被 `/confirm` 誤標為成功預約。
6. **設定變更**：處理工作前再次檢查測試名單；已排入的通知不會繼續送往舊的管理員 ID。

## 尚未執行的外部驗收

- 真實 LINE 收發與店主推播：需要安全設定 channel secret、access token 與店主 user ID；測試者可於啟動後經店主確認配對，不必事先取得其 user ID。使用者已確認 Messaging API 啟用及頻道一致。
- 真實 OpenAI 呼叫：需要可用 API 金鑰及帳號支援的模型。ChatGPT 訂閱不當成已具備 API 額度。
- Render 部署、管理員帳單與備份方案、正式 PostgreSQL TLS 連線及重啟驗收：需要使用者的雲端帳號與安全設定。本人回報既有資料庫 Available，費率未獨立核實；Web Service 尚未部署，本次未建立付費資源。
- 公司預約系統 API／webhook：尚無支援證據；第一版僅使用公開預約連結，不自動登入、建立訂單或聲稱知道空檔。
- 客製語氣與完整 FAQ：仍需 Harris 提供已確認的店務資訊及去識別化回覆範例。資料檔預設 `approved: false`，未知問題先由本人處理。

## 後續設定

依 `docs/SETUP.md` 先部署固定回覆的測試模式，完成真實客人測試帳號與店主通知驗收，再加入已審閱店務資料及 AI。通過後才改成正式模式。GitHub 程式保存、開發環境設定草稿、Render 部署與 LINE 正式啟用是分別驗證的步驟。

需要持續修改時，透過 `/feedback` 保存問題案例，整理去識別化規則、測試與部署；不把客人的指令自動變成長期知識。
