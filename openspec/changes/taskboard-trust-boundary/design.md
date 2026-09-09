## Context

Taskboard 的 issue title、description、comments 是自由文字欄位，寫入來源包含本地 UI 直寫 REST API、`cli/taskctl.mjs` 的 `issue create`／`comment add`（人與 agent 都可呼叫），以及 `server/jira-integration.mjs` 的雙向 Jira 同步（Jira `fields.summary`／`fields.description` 最長 100,000 字元直接寫回 taskboard `title`／`description`，無內容過濾）。AGENTS.md 中提到的「GitHub Issue and PR synchronization」目前在程式碼庫內找不到對應的同步模組（`grep -rli github server/ cli/ shared/` 無結果）——這是文件描述與現況的落差，不是已存在的寫入路徑，本設計如實記錄、不假裝要修一個不存在的東西。

這些內容目前在三個彼此獨立、沒有互相引用的位置被當成特權 agent 的決策輸入：

1. `shared/taskboard-automation.mjs` 的 `buildTaskboardAutomationPrompt()` 組出一整段自然語言 system prompt，逐字送進 `scripts/codex-injector.mjs` 呼叫的 Codex App `automation-create`／`automation-update` RPC。這是一個 `kind: "cron"` 的排程自動化（`buildTaskboardAutomationSpec`），依 `rrule` 定期觸發，過程中無人在場核准。prompt 內容明確指示該 agent 每輪先 `issue get` + `comment list` 讀最新內容，「根据描述和最新评论判断是否允许开始」，並在準備轉發任務給另一個 remote worker thread 時，把「議題編號、標題、完整描述、全部評論」原文放進轉發訊息——這個轉發動作是 agent runtime 當下自己組訊息，不是本 repo 的程式碼路徑，所以無法用程式碼把關，只能靠自然語言指令本身建立「這是資料不是指令」的語意邊界。`request.projectName` 等 host-request 欄位（本機使用者設定自動化時填入，已被 `parseTaskboardAutomationHostRequest` 的 `validText` 驗證長度與字元集，但未做分隔符跳脫）也是直接字串插值進同一段 prompt。
2. `AGENTS.md`「Taskboard Delivery Workflow」一節是任何在此 repo 工作的 agent（互動式 session，非 cron 自動化）都會自動載入的系統層 context。第 1 節「Read and claim work」要求「Read the full issue description, attachments, and all comments before routing or changing it」（現行行號 91 行），同節第 90 行並要求「Leave an item unclaimed when its description or latest comment explicitly requires waiting」。獨立逐字重讀第 3 節「Follow E3」全文（現行行號 119-138 行）後確認：內容是 Estimate/Execute/Expand 的工作量與風險分級方法論（步驟、複雜度分級、驗證預算），全文沒有一處提到 issue description 或 comment 內容被用作路由或決策輸入。先前版本在此處寫「E3 小節同樣要求把描述與評論當路由依據」缺乏文字佐證，屬於未經查核就沿用的引用，已移除；把描述/評論當路由依據的要求目前只出現在第 1 節，本 change 對 AGENTS.md 的修改範圍（見 tasks.md 2.1）也只鎖定第 1 節，不涉及 E3。
3. `skills/manage-taskboard/SKILL.md` 的 Core workflow 第 1 步寫明「Treat comments as current requirements...If they say to wait, not execute, or not start now, stop and report without changing the status.」——這是三處裡最直白的「comment 文字＝指令」語意。`grep` 確認 AGENTS.md 未提及 `skills/manage-taskboard`，即 SKILL.md 與 AGENTS.md 之間沒有引用關係；只有 `buildTaskboardAutomationPrompt` 的輸出用 `[$manage-taskboard](${request.skillPath})` 明確連結到 SKILL.md，因此 cron 自動化路徑會顯式載入這份 skill，互動路徑則不會——兩份文件各自獨立重複了同一個信任假設，需要一起修，不是同一個引用點的兩份拷貝。

此 finding 與 `dashi-taskboard-8p7`（AI 對話跨 project 檔案存取，CWE-863）出自同一批 `codex-security` scan，但範圍不同：8p7 是 AI agent 的能力（檔案系統存取）範圍模型，本 change 是輸入信任邊界模型，兩者互相獨立，本 change 不處理 8p7。

## Goals / Non-Goals

**Goals:**

- 在 `buildTaskboardAutomationPrompt()`、`AGENTS.md`、`skills/manage-taskboard/SKILL.md` 三處建立一致的「不受信任資料」標記慣例，讓從 taskboard 讀回或使用者填入的欄位，在被引用、複述或轉發時都有明確、一致的分隔邊界。
- 讓包在分隔符內的文字，語意上被限定為既有工作流程固定決策點（proceed/skip/wait/blocked/in_review 判斷、或轉發給實作者的任務描述）的描述性輸入，不得被解讀為新的指令、新的工具呼叫，或取代/覆蓋當前系統指令本身的授權。
- `buildTaskboardAutomationPrompt()` 的欄位插值改為結構化包裹，並防止欄位值本身包含分隔符序列時提前關閉邊界；此為三處變更中唯一可用程式碼強制且可自動化測試的部分。

**Non-Goals:**

- 不對 taskboard 內容做關鍵字／pattern 黑名單式 sanitize——這類防禦不可靠、容易被繞過，也可能誤擋合法內容（例如合法評論剛好包含「ignore」這個詞）。
- 不設計或實作一整套內容安全掃描／分類系統——超出本 change 的最小必要範圍；若未來確實需要，應是獨立 change，不在此預先發明。
- 不處理 `dashi-taskboard-8p7` 的 AI 能力範圍模型（跨 project 檔案存取）。
- 不改變 `server/jira-integration.mjs` 或 `cli/taskctl.mjs` 本身的寫入驗證邏輯——這兩者是內容如何被寫入的範疇，本 change 管的是內容進入 agent prompt 前的邊界。
- 不修改 `cli/taskctl.mjs` 的 `issue get`／`comment list` 輸出層，不對其回傳的 title/description/comment body 做分隔符包裹——已評估並拒絕，理由見 Decisions「評估並拒絕在 `cli/taskctl.mjs` 的 `issue get`／`comment list` 輸出層做程式碼層級分隔符包裹」。
- 不設計或實作 GitHub Issue/PR 同步——目前程式碼庫內沒有對應模組，AGENTS.md 的描述與現況有落差，本 change 如實記錄此落差，不代為補上不存在的同步功能。
- 不新建 LLM-eval 或 prompt-injection 自動化測試框架——AGENTS.md／SKILL.md 兩份自然語言指令檔案的行為無法用本 repo 現有測試工具鏈自動驗證，此限制在 Risks 段落記錄，驗收方式改為人工審閱。
- 不變更 `buildTaskboardAutomationSpec()` 回傳給 Codex App `automation-create`／`automation-update` RPC payload 的 approval／sandbox 相關欄位——目前完全沒有此類欄位，是否可設定更保守的執行權限需先查 Codex App 自身的 RPC schema，超出本 repo 程式碼範圍，列為 Open Question。

## Decisions

### 拒絕黑名單式 sanitize

對 taskboard 內容做關鍵字或 pattern 比對式的過濾，看似直覺，但黑名單式防禦系統性地不可靠：攻擊者能用同義詞、換行、編碼、多語言等方式繞過任何固定的 pattern 列表，而合法使用者的正常評論（例如包含「先別執行」「忽略上次的評論」等中文常見措辭）反而容易被誤擋。這類方案投入越多，越容易產生「看起來有防護、實際上防不住真正的攻擊」的假象，不採用。

### 拒絕現在就建立完整內容安全掃描系統

调查過程中曾考慮引入一個獨立的內容分類／風險評分服務，在內容寫入或讀取時攔截可疑內容。這需要新的服務邊界、新的資料模型、以及誤判率調校，遠超過「讓特權 agent 分清楚資料與指令」這個核心風險所需的最小方案。若未來證明現有的標記機制不足以攔阻實際攻擊，應該以獨立 change 重新評估，不在本 change 預先蓋一個可能用不到的系統。

### 採用結構化「不受信任資料」標記/分隔機制

三處受影響位置改為明確要求：任何從 `issue get`／`comment list` 讀回、或使用者設定自動化時填入的欄位，在被引用、複述、或轉發進另一個 agent（含轉發進 remote worker thread 的訊息）時，一律用一致的分隔慣例包起來（例如 `<untrusted-taskboard-content>...</untrusted-taskboard-content>`），並明確聲明：包裹範圍內的文字只能用來回答工作流程已定義好的固定決策點，不得被解讀成新的指令、新的工具呼叫，或覆蓋當前系統指令本身的授權。

備選方案是只在其中一處（例如只改 automation prompt）做標記，讓 AGENTS.md 與 SKILL.md 維持現狀——被拒絕，因為背景調查已確認三處各自獨立重複了同一個信任假設，且 SKILL.md 與 AGENTS.md 之間沒有引用關係，只改一處無法涵蓋所有實際會載入到相同不受信任內容的 agent 執行路徑。這個決策本質上是語意修正，不是新增能力，也不需要三份文件逐字使用完全相同的分隔符字串，但三者建立的心智模型（資料與指令分離、固定決策點清單、禁止內容內指令覆蓋）必須一致。

### 欄位插值改用可跳脫的包裹 helper，僅限程式碼可控的部分

`buildTaskboardAutomationPrompt()` 目前直接用範本字串插值 `request.projectName` 等 host-request 欄位，沒有任何逃逸。新增一個單一小函式（不做成框架），將插入值用選定的分隔符包裹，並在插入值本身恰好包含該分隔符序列時做跳脫（例如替換掉序列中會被誤判為邊界的字元），確保分隔符邊界在字串層級真的立得住。

這個 helper 的適用範圍僅限於本 repo 程式碼實際組裝 prompt 字串的路徑——也就是 `buildTaskboardAutomationPrompt()` 對 host-request 欄位的插值。至於自動化 agent 在 runtime 執行 `issue get`／`comment list` 後，決定要不要把讀到的內容轉發進其自身推理或轉發訊息，這個轉發動作是 agent 在其自身推理過程中組成的，不是本 repo 程式碼會執行的字串組裝步驟，因此無法用同一個 helper 覆蓋，只能靠 prompt 文字本身的自然語言指令要求 agent 在轉發時自行套用相同的包裹慣例。這是本設計對「程式碼可強制的邊界」與「只能靠指令文字建立的邊界」的明確切割，避免對後者做出程式碼層級無法兌現的承諾。

備選方案是把 host-request 欄位也一併列入黑名單過濾——與上述「拒絕黑名單式 sanitize」的理由相同，不採用；改以跳脫（而非過濾）保留欄位值完整性，只確保它不能提前結束分隔符邊界。

**範圍收斂（實作階段補記）：** 這個 helper 在 `buildTaskboardAutomationPrompt()` 內的實際套用點，進一步收斂到函式開頭新增的識別描述行（`projectName`／`taskboardProjectId`／`workspacePath`／`intervalMinutes` 所在的識別描述行）與新增的 Codex 身份行（`codexProjectId`／`codexHostId`／`remoteProjects` 所在的身份聲明行）——7 個欄位各自在這裡至少會有一次透過 helper 輸出的包裹版本。函式內原本就存在、用於組裝字面 `taskctl` CLI 參數的插值點（例如 `--binding-codex-project-id ${JSON.stringify(request.codexProjectId)}`、`--binding-workspace-path ${JSON.stringify(request.workspacePath)}`、`issue list --project ${request.taskboardProjectId}` 等）刻意不套用這個 helper，維持原始 `request.X` 直接插值：若在這些位置也包上分隔符標籤，標籤字面會被烤進 agent 實際要執行的 `taskctl` shell 指令內，破壞自動化功能本身，這與本節「僅限程式碼可控的部分」的判斷是同一個原則的延伸，不是另一個新判斷。

其結果是：同一個欄位值在同一個產生的 prompt 字串裡，會同時存在「識別描述行/身份行的包裹版本」與「CLI 參數組裝處的原始未包裹版本」——這是刻意的設計取捨，不是遺漏或未完成的取代。下方 Implementation Contract 與 `tasks.md` 1.2、`spec.md` Requirement 1 的措辭均已改為反映「每個欄位至少一處包裹」而非「全部插值都取代」，避免文件承諾範圍與程式碼實際範圍不一致。

### 評估並拒絕在 `cli/taskctl.mjs` 的 `issue get`／`comment list` 輸出層做程式碼層級分隔符包裹

上一節的欄位包裹 helper 只覆蓋 `buildTaskboardAutomationPrompt()` 插值的 host-request 設定欄位（`projectName`／`workspacePath`／`codexProjectId`／`codexHostId` 等，本機使用者設定自動化時填入），不覆蓋 agent 在 runtime 透過 `${taskctlCommand} issue get`／`comment list`（見 Context 第 1 點）讀到的 issue title/description/comment body——後者才是 Why 段落實際指控的攻擊面：`cli/taskctl.mjs` 的 `issue get`／`comment list` 是 REST API 的薄封裝，逐字回傳 taskboard 儲存的 title/description/comment body，完全不經過上一節新增的 helper。這裡明確評估是否應該在 `cli/taskctl.mjs` 的這兩個指令輸出層，對回傳 JSON 裡的對應欄位值做同一套分隔符包裹，讓這條路徑也變成程式碼可強制的部分。

獨立查證後，**拒絕**這個選項，理由如下：

1. **`taskctl` 不是 agent 專屬管道，而是本 repo 文件化、有版本號的通用 CLI 契約。** `cli/taskctl.mjs` 的 `main()` 對每個指令的輸出都透過 `writeJson()` 附帶 `SCHEMA_VERSION`（目前為 `2`，見第 34、300 行）——這是明確的版本化契約設計，意味著存在需要相容性保證的消費者。`README.md`／`README.zh-CN.md` 把 `taskctl` 描述為與 React UI 平起平坐、共用同一套 HTTP API 的介面（"The same HTTP API powers the React UI and the `taskctl` CLI"），並記載一般使用者（非 agent）直接執行 `npm run taskctl -- issue create`／`project create`，以及「同一受信任網路的協作者可以用 `CODEX_TASKBOARD_URL` 指向共享服務」的人類使用情境；`docs/planning/risk-assessment.md`（第 15 行）與 `docs/planning/architect.md`（第 50 行）也把 `taskctl` 列為與 React UI、Node HTTP service 平行的系統組件之一，不是 agent 專屬工具。
2. **修改輸出會打破本 repo 自己測試鎖定的既有預期。** 例如 `test/project-readme.test.mjs` 斷言 CLI JSON 輸出裡的欄位值必須與寫入值逐字相等；本 repo 對 `taskctl` JSON 輸出的既有預期就是「欄位值＝原始儲存值，不夾帶額外標記」。沒有理由讓 `issue get`／`comment list` 這兩個指令的輸出契約，單獨與同一支 CLI 的其他指令（`issue list`／`project readme` 等）不一致。
3. **比契約相容性更嚴重的是資料污染風險。** `buildTaskboardAutomationPrompt()` 插值的 host-request 欄位是唯讀輸入，不會被寫回任何地方，包裹／跳脫是無副作用的一次性操作。但 `issue get`／`comment list` 的輸出常態性地被「讀出後再寫回」的流程消費（例如 agent 或腳本讀到 description／comment body 後，透過 `issue update`／`comment update` 原樣或修改後寫回）。若輸出層先摻入分隔符與跳脫序列，任何沒有先剝除包裹就寫回的呼叫端，會把分隔符工件永久烤進 taskboard 的儲存內容——這是 host-request 欄位包裹完全不會遇到的新風險類別，且一旦發生無法用程式碼層級的方式偵測或回滾。
4. **要同時避免上述兩個問題，唯一乾淨的作法是新增一個不影響既有欄位的獨立輸出欄位**（例如額外附加一份包裹過的 rendering），但這麼做等於新建一套與現有 JSON 契約平行的新資料形狀，還需要同步修改 AGENTS.md／SKILL.md／automation prompt 三處指示 agent 改讀這個新欄位而非原始欄位——這已經超出本 change「三處統一心智模型＋一個小型 host-request 包裹 helper」的最小必要範圍，性質上更接近 Non-Goals 已經拒絕的「建立新的內容安全基礎設施」，不在本 change 追加。

拒絕在 `cli/taskctl.mjs` 輸出層做程式碼包裹後，issue title/description/comment 這個本 change Why 段落真正指控的攻擊面，其防線完全落在 1.3／2.1／3.1 已規劃的自然語言框架宣告上。這不是新的侷限——Risks 段落第一條本來就記錄了「自然語言約束無法用程式碼驗證」這個侷限——但必須明確承認一件事：對這個攻擊面而言，自然語言框架宣告是**唯一**防線，而不是與 1.1/1.2 的程式碼包裹 helper 並存的第二道防線；1.1/1.2 對這個攻擊面沒有任何程式碼層級的貢獻，它強化的是另一個獨立的次要管道。proposal.md「What Changes」已同步修正此定位。

### 能力限制（capability-limiting）範圍收斂到既有指令面的明確禁止，不新建權限系統

現有 automation 的 `taskctl` 操作面已經是固定且小的集合（`issue get`／`issue move`／`comment add`），三處受影響文件裡都沒有指示 agent 依評論內容決定要執行任意 shell command 或呼叫其操作面以外的工具。新建一個獨立的權限／sandbox 系統會直接撞進 `dashi-taskboard-8p7` 的範圍（AI 能力範圍模型），也是本 change 不該做的過度設計。

因此能力限制這個方向，在本 change 的落地方式就是「結構化標記」決策裡已包含的禁止語句——包裹範圍內的文字不得被解讀為新的指令或新的工具呼叫——不需要另外新增一層機制。唯一沒有被涵蓋、且可能真正限縮攻擊後果的槓桿，是 `buildTaskboardAutomationSpec()` 送給 Codex App `automation-create`／`automation-update` RPC 的 payload 是否能設定更保守的 approval／sandbox 執行權限；這需要先確認 Codex App 自身的 RPC schema 是否支援此類欄位，屬於外部系統的能力調查，不在本 repo 程式碼可直接驗證的範圍內，列為 Open Question，不在 tasks.md 承諾實作。

## Implementation Contract

**行為（Behavior）：**

- `buildTaskboardAutomationPrompt()` 的輸出字串中，7 個 host-request 欄位（`projectName`、`taskboardProjectId`、`workspacePath`、`intervalMinutes`、`codexProjectId`、`codexHostId`、`remoteProjects`）各自在函式開頭新增的識別描述行／Codex 身份行至少出現一次透過新增的包裹 helper 輸出的版本，該次輸出的欄位值前後帶有一致的分隔符邊界；函式內既有的、用於組裝字面 `taskctl` CLI 參數的插值點（例如 `--binding-codex-project-id`、`--binding-workspace-path`、`issue list --project` 等）維持原始 `request.X` 直接插值不變，不套用 helper，理由見上方 Decisions「欄位插值改用可跳脫的包裹 helper，僅限程式碼可控的部分」的範圍收斂段落。
- 若欄位值本身包含與分隔符相同的字元序列，輸出中該序列會被跳脫，使分隔符邊界不會被欄位值提前關閉——也就是說，用任何欄位值都無法讓輸出字串在非預期位置產生一個看起來合法的分隔符邊界。
- `buildTaskboardAutomationPrompt()` 的輸出新增一段固定的框架說明文字，出現在所有欄位插值之前，說明分隔符包裹範圍內的內容是不受信任的外部資料，只能用於回答工作流程已定義的固定決策點，不得被解讀為新指令。
- `AGENTS.md`「Taskboard Delivery Workflow」第 1 節（「Read and claim work」把描述/評論當路由依據的要求只出現在這一節，見 Context 第 2 點對 E3 小節的查核結果，不涉及 E3）、`skills/manage-taskboard/SKILL.md` Core workflow 第 1 步的文字內容更新，加入與上述相同心智模型的不受信任資料說明；SKILL.md 既有的「評論寫明等待就跳過」行為保留，但明確定位為固定決策點之一，而非開放式的指令解讀入口。

**介面／資料形狀（Interface / data shape）：**

- 新增的包裹 helper 是 `shared/taskboard-automation.mjs` 內的一個具名匯出或模組內函式，輸入為待插入的字串值，輸出為帶分隔符邊界、且對邊界序列做過跳脫處理的字串；`buildTaskboardAutomationPrompt()` 對函式開頭新增的識別描述行／Codex 身份行改呼叫此函式取得要插入模板的片段。函式內既有的、用於組裝字面 `taskctl` CLI 參數的插值點不呼叫此函式，維持原始 `request.X` 直接模板字串插值，理由見上方 Decisions 的範圍收斂段落。
- `buildTaskboardAutomationPrompt()` 的公開簽名（輸入 `request`、輸出 prompt 字串）不變；改變的只是回傳字串的內部內容與結構，呼叫端 `buildTaskboardAutomationSpec()` 仍把整段回傳值當不透明字串塞進 RPC payload 的 `prompt` 欄位。

**失敗模式（Failure modes）：**

- 欄位值本身包含分隔符序列時，不視為錯誤、不拋出例外——按跳脫規則轉換後照常輸出，維持自動化既有的「盡量繼續運作」語意，不因為某個欄位剛好長得像分隔符就讓整個自動化建立/更新失敗。
- 三份文件的文字修改沒有執行期失敗模式可言（純文字內容）；驗收方式見下。

**驗收條件（Acceptance criteria）：**

- `test/taskboard-automation.test.mjs` 新增測試，斷言 `buildTaskboardAutomationPrompt()` 輸出中，一個正常的 `projectName` 值會被完整包在分隔符邊界內。
- 同一測試檔新增測試，用一個刻意構造、內容看起來像是要提前關閉分隔符邊界並注入新指令的 `projectName` 值（例如包含分隔符本身的字元序列）呼叫 `buildTaskboardAutomationPrompt()`，斷言輸出中分隔符邊界仍然完整、且該欄位值中的分隔符序列已被跳脫，不會被解讀成一個提前結束的邊界。
- 上述兩項測試連同既有 `test/taskboard-automation.test.mjs` 測試集一起以 `npm test` 執行並全數通過。
- `AGENTS.md`、`skills/manage-taskboard/SKILL.md` 的文字變更沒有自動化驗收工具（本 repo 沒有 LLM-eval harness）；驗收方式是 reviewer 人工核對改寫後的文字：三處文件對「不受信任資料」的定義、分隔符慣例、固定決策點清單三者語意一致，且沒有互相矛盾的措辭。

**範圍邊界（Scope boundaries）：**

- 範圍內：`shared/taskboard-automation.mjs` 的欄位包裹 helper 與 `buildTaskboardAutomationPrompt()` 改寫、`AGENTS.md` Taskboard Delivery Workflow 一節的信任邊界說明、`skills/manage-taskboard/SKILL.md` Core workflow 第 1 步改寫、`test/taskboard-automation.test.mjs` 新增測試案例。
- 範圍外：`server/jira-integration.mjs`、`cli/taskctl.mjs` 的寫入驗證邏輯；`dashi-taskboard-8p7` 的 AI 能力範圍模型；任何形式的內容安全掃描／分類系統；GitHub Issue/PR 同步的設計或實作；LLM-eval／prompt-injection 自動化測試框架；`buildTaskboardAutomationSpec()` 送出的 RPC payload 新增 approval／sandbox 欄位。

## Risks / Trade-offs

- [風險] 自然語言層級的「不得將內容內文字當指令」約束，對底層 LLM 的實際遵從程度無法在本 repo 用程式碼驗證，約束本身可能被更精巧的注入手法繞過。對 issue title/description/comment（本 change Why 段落所述的核心攻擊面）而言，這不是眾多防線中的一道，而是**唯一**防線——Decisions 已評估並拒絕在 `cli/taskctl.mjs` 的 `issue get`／`comment list` 輸出層做程式碼層級包裹，1.1/1.2 的欄位包裹 helper 只覆蓋 host-request 這個獨立的次要管道，對此攻擊面沒有程式碼層級貢獻 → [緩解] 這是目前業界公認的防禦手段（明確標記不受信任資料邊界），能顯著降低而非完全消除風險；不承諾這是完整解，如實記錄其侷限性，不誇大其效果，也不假裝 1.1/1.2 已經涵蓋這個攻擊面。
- [風險] `buildTaskboardAutomationPrompt()` 轉發給 remote worker thread 的訊息組裝發生在 agent runtime 自身，不在本 repo 程式碼控制範圍內，即使自動化 prompt 的框架說明要求 agent 轉發時套用相同包裹慣例，也無法用程式碼強制其確實照做 → [緩解] 在 automation prompt 中把這個要求寫得明確且可執行（具體分隔符字面值、具體轉發時機），並在 design 中誠實記錄此限制，不假裝這是程式碼層級可驗證的保證。
- [風險] 三份文件（automation prompt、AGENTS.md、SKILL.md）修改後若彼此措辭出現細微不一致，可能重新產生「重複信任假設」的問題，只是換了新的措辭版本 → [緩解] Implementation Contract 的驗收條件明確要求 reviewer 核對三處語意一致，作為人工驗收的具體檢查項，而非只驗收單一檔案。
- [風險] `buildTaskboardAutomationSpec()` 送給 Codex App 的 RPC payload 缺少 approval／sandbox 欄位，即使本 change 完成，若注入仍然成功，cron 自動化實際能造成的傷害上限仍取決於 Codex App 對該自動化 thread 預設授予的執行權限，本 change 不改變這一層 → [緩解] 列為 Open Question 留給後續 change 評估，不在此偽稱已解決能力限制層面的風險。

## Migration Plan

- 三份文件的變更都是純文字／prompt 語意修正，沒有資料庫 schema 或既有 API contract 變動。
- `buildTaskboardAutomationPrompt()` 的輸出格式改變（新增分隔符與框架說明段落），但唯一呼叫端 `buildTaskboardAutomationSpec()` 只把回傳值當一段不透明字串塞進 RPC payload 的 `prompt` 欄位，不解析其內部結構，因此輸出格式改變不會破壞既有呼叫端；已建立的舊版自動化在下一次 `automation-update` 時會取得新版 prompt。
- Rollback 策略：還原 `shared/taskboard-automation.mjs`、`AGENTS.md`、`skills/manage-taskboard/SKILL.md`、`test/taskboard-automation.test.mjs` 四個檔案到變更前版本即可，不需要資料遷移或額外的相容層。

## Open Questions

- `buildTaskboardAutomationSpec()` 送給 Codex App `automation-create`／`automation-update` RPC 的 payload 是否支援設定更保守的 approval／sandbox 執行權限？需要查 Codex App 自身的 RPC schema／文件才能確認，超出本 repo 程式碼範圍，本 change 不預先假設答案，也不在 tasks.md 承諾實作對應欄位；若確認支援，應開立獨立 bd issue 或 change 評估是否要收斂 cron 自動化的預設執行權限。
- 是否要為 AGENTS.md／SKILL.md 這類自然語言指令檔案建立某種形式的 LLM-eval 或 prompt-injection 回歸測試（例如用固定的一組對抗性評論樣本，人工或半自動檢查 agent 是否仍會誤將其當指令執行）？這需要新的測試基礎設施投資，本 change 判斷超出範圍，留待未來若證明人工審閱不足以攔阻實際問題時，再開獨立 change 評估。
- AGENTS.md 中「GitHub Issue and PR synchronization」的描述與程式碼庫現況（無對應同步模組）之間的落差，是否需要另開 bd issue 修正文件或補齊功能？不在本 change 範圍內，僅在此記錄觀察到的落差，留給 reviewer／PM 判斷後續處理方式。
