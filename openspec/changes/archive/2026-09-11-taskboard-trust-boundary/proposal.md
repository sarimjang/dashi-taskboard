## Why

`codex-security` 掃描（scanId `0e8da15f`，CWE-250/1427）發現：`shared/taskboard-automation.mjs` 的 `buildTaskboardAutomationPrompt()`、`AGENTS.md`「Taskboard Delivery Workflow」一節、`skills/manage-taskboard/SKILL.md` 的 Core workflow，三處各自獨立指示特權 agent 在執行前讀取 taskboard issue 的 title/description/comments，並把讀到的內容當成路由與執行決策的依據（例如「若評論寫明等待就跳過」）。這些內容是外部可寫的不受信任資料——本地 UI 直寫 REST API、`cli/taskctl.mjs` 的 `issue create`/`comment add`、以及 `server/jira-integration.mjs` 的雙向 Jira 同步都能寫入，其中 Jira 同步單次可回寫最長 100,000 字元的 description，完全沒有內容過濾。三處指示之間彼此沒有引用關係、各自獨立重複了「comment 內容可直接當指令」這個假設，其中 `shared/taskboard-automation.mjs` 組出的 prompt 是逐字送進 Codex App `automation-create`/`automation-update` RPC 的 cron 排程自動化，無人在場核准。一個能寫入 issue 評論的攻擊者（或被入侵的 Jira 帳號）因此有機會讓特權 agent 把注入的文字誤判為系統指令，這是典型的 prompt injection 架構缺口，需要先定義「不受信任資料」邊界才能修，不是單點字串跳脫可以解決的。

## What Changes

- 在 `shared/taskboard-automation.mjs`、`AGENTS.md`、`skills/manage-taskboard/SKILL.md` 三處，統一建立一套結構化的「不受信任資料」標記慣例：從 `issue get`/`comment list` 讀回的內容、以及使用者設定自動化時填入的欄位，被引用、複述或轉發給其他 agent（含轉發進 remote worker thread 的訊息）時，一律用一致的分隔符包起來，並明確聲明包裹範圍內的文字只能作為現有工作流程固定決策點（proceed/skip/wait/blocked/in_review）的描述性輸入，不得被解讀為新的指令、新的工具呼叫，或取代/覆蓋當前系統指令本身的授權。
- `buildTaskboardAutomationPrompt()` 新增一個小型 helper，將插入 prompt 的 host-request／automation-config 欄位（如 `projectName`，本機使用者設定自動化時填入的參數，不是本提案 Why 段落所指的 issue 內容）用上述分隔符包裹，並對欄位值本身恰好包含分隔符序列的情況做跳脫，避免值提前關閉分隔符邊界——這是三處變更裡唯一能用程式碼強制、也唯一能自動化測試的部分，但它強化的是 automation-config/host-request 這個**次要**管道，不是 Why 段落所述的 issue title/description/comments 攻擊面。後者（含 agent 透過 `taskctl issue get`／`comment list` 在 runtime 讀到的內容）完全依賴下面兩項對 AGENTS.md／SKILL.md 的自然語言框架宣告；design.md 已評估並記錄為何不在 `cli/taskctl.mjs` 的 `issue get`／`comment list` 輸出層做同等的程式碼包裹（見 design.md Decisions「評估並拒絕在 `cli/taskctl.mjs` 的 `issue get`／`comment list` 輸出層做程式碼層級分隔符包裹」）。
- 更新 `AGENTS.md`「Taskboard Delivery Workflow」第 1 節（Read and claim work），在既有「讀取完整描述與評論」的指示前，加入不受信任資料的框架說明（第 3 節「Follow E3」全文查核後確認與描述/評論路由依據無關，本 change 不觸碰該節，見 design.md Context）。
- 改寫 `skills/manage-taskboard/SKILL.md` Core workflow 第 1 步，將「Treat comments as current requirements...」的描述改為明確的不受信任資料語意，同時保留其既有的「評論寫明等待就跳過」行為（作為固定決策點之一，而非開放式指令解讀）。
- `test/taskboard-automation.test.mjs` 新增測試，驗證分隔符包裹存在，且用刻意構造的注入樣式欄位值驗證分隔符邊界不會被提前關閉。

## Capabilities

### New Capabilities

- `taskboard-content-trust-boundary`：定義 taskboard 使用者可寫內容（issue title/description/comments，含 Jira 同步寫入的內容）在進入特權 agent 決策與轉發流程前必須遵守的不受信任資料邊界——涵蓋自動化 prompt 組裝時的欄位包裹與跳脫規則、以及 AGENTS.md／SKILL.md 對 agent 如何解讀讀取到的 issue 內容的行為約束。

### Modified Capabilities

(none — repo 內目前沒有既有 spec 描述 taskboard 內容的信任邊界)

## Impact

- Affected specs: `taskboard-content-trust-boundary`（新增）
- Affected code:
  - Modified: `shared/taskboard-automation.mjs`（新增欄位包裹/跳脫 helper，`buildTaskboardAutomationPrompt` 改用該 helper 包裹插值欄位並新增不受信任資料框架說明段落）
  - Modified: `AGENTS.md`（Taskboard Delivery Workflow 一節新增信任邊界說明，更新既有讀取描述/評論的條目）
  - Modified: `skills/manage-taskboard/SKILL.md`（Core workflow 第 1 步改寫為不受信任資料語意）
  - Modified: `test/taskboard-automation.test.mjs`（新增分隔符包裹與跳脫的測試案例）
  - 不修改：`server/jira-integration.mjs`、`cli/taskctl.mjs`（這兩者是內容寫入路徑本身，屬於資料如何被寫入的範疇，不是本 change 管的「內容進入 agent prompt 前的邊界」）
