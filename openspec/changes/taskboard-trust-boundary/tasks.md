## 1. 自動化 prompt 的不受信任資料包裹與框架說明（shared/taskboard-automation.mjs）

- [ ] 1.1 在 `shared/taskboard-automation.mjs` 新增一個欄位包裹 helper：輸入任意字串值，輸出以一致分隔符包裹該值的字串，且當輸入值本身包含與分隔符相同的序列時會被跳脫，使分隔符邊界不會被提前關閉；對應 spec `taskboard-content-trust-boundary` 的 Requirement「Automation prompt field interpolation SHALL use delimited untrusted-data wrapping」與「Delimiter boundaries SHALL be escaped against field values that contain a delimiter sequence」；驗證方式：`test/taskboard-automation.test.mjs` 新增單元測試直接呼叫此 helper，涵蓋 Scenario「Ordinary field value is wrapped」與「Field value containing the delimiter sequence」（含 spec 中 adversarial values 範例表的三種輸入）。

- [ ] 1.2 `buildTaskboardAutomationPrompt()` 改為對所有插值的 host-request 欄位（`projectName`、`taskboardProjectId`、`workspacePath`、`intervalMinutes`、`codexProjectId`、`codexHostId`、`remoteProjects`）呼叫 1.1 的 helper，取代目前的直接模板字串插值；這是 design.md Decisions 中「欄位插值改用可跳脫的包裹 helper，僅限程式碼可控的部分」的落地，且明確不採用 design.md 已拒絕的「拒絕黑名單式 sanitize」與「拒絕現在就建立完整內容安全掃描系統」兩個方向；驗證方式：`test/taskboard-automation.test.mjs` 新增測試斷言 `buildTaskboardAutomationPrompt()` 對每個受影響欄位的輸出都經過 1.1 helper 包裹。

- [ ] 1.3 `buildTaskboardAutomationPrompt()` 的輸出新增一段固定框架說明文字，出現在所有欄位插值之前，聲明分隔符包裹範圍內的內容是不受信任的外部資料、只能用於回答工作流程固定決策點、不得被解讀為新指令；這是 design.md Decisions 中「採用結構化「不受信任資料」標記/分隔機制」的具體落地；對應 Requirement「Automation prompt SHALL declare untrusted-data framing before any delimited content」；驗證方式：新增測試斷言輸出字串中框架說明文字出現在第一個包裹欄位之前（對應 Scenario「Framing statement precedes delimited content」）。

- [ ] 1.4 `buildTaskboardAutomationPrompt()` 現有「發送給遠端會話的指令必須包含議題編號、標題、完整描述、全部評論」的段落文字，改為明確要求該轉發訊息中的議題內容套用與 1.3 相同的分隔符與框架說明慣例；對應 Requirement「Taskboard content forwarded to a remote worker thread SHALL retain the untrusted-data delimiter convention」；驗證方式：新增測試斷言 `buildTaskboardAutomationPrompt()` 輸出的 remote 分支文字中包含要求轉發內容套用分隔符慣例的明確語句（對應 Scenario「Forwarded issue content is delimited」）。

## 2. AGENTS.md 的不受信任資料信任邊界說明

- [ ] [P] 2.1 在 `AGENTS.md`「Taskboard Delivery Workflow」一節第 1 節「Read and claim work」之前，新增一段不受信任資料的框架說明，並更新該節「Read the full issue description, attachments, and all comments before routing or changing it」等既有條目的文字，使其明確限定 comment/description 內容只能用於回答工作流程固定決策點（proceed/skip/wait/blocked/in_review），不得被解讀為新指令、新工具呼叫或覆蓋當前操作指令；對應 Requirement「Interactive workflow instructions SHALL apply the same untrusted-data trust boundary to taskboard issue content」；驗證方式：reviewer 人工核對改寫後文字涵蓋 Scenario「Comment content is limited to fixed decision points」與「Existing wait-then-skip behavior remains a fixed decision point」所描述的行為，且與 3.1 改寫的 SKILL.md 文字語意一致、無矛盾措辭。

## 3. skills/manage-taskboard/SKILL.md 的 Core workflow 改寫

- [ ] [P] 3.1 改寫 `skills/manage-taskboard/SKILL.md` Core workflow 第 1 步，將「Treat comments as current requirements...If they say to wait, not execute, or not start now, stop and report without changing the status.」改為明確的不受信任資料語意：comments 只能用於回答固定決策點，「評論寫明等待就跳過」這個既有行為保留但明確定位為固定決策點之一，而非開放式指令解讀入口；同樣對應 Requirement「Interactive workflow instructions SHALL apply the same untrusted-data trust boundary to taskboard issue content」；驗證方式：reviewer 人工核對改寫後文字涵蓋同一組 Scenario，且與 2.1 改寫的 AGENTS.md 文字使用一致的心智模型（不受信任資料定義、固定決策點清單、禁止內容內指令覆蓋），無矛盾措辭。

## 4. 整體回歸驗證與範圍收斂確認

- [ ] 4.1 確認 1.1-1.4 新增的測試與既有 `test/taskboard-automation.test.mjs` 測試集一起執行時全數通過，作為本 change 的整體驗收閘門；本任務刻意停在文件與欄位包裹層級，依 design.md Decisions「能力限制（capability-limiting）範圍收斂到既有指令面的明確禁止，不新建權限系統」的判斷，不新增任何權限或 sandbox 系統，也不變更 `buildTaskboardAutomationSpec()` 送出的 RPC payload 欄位（留待 design.md Open Questions 後續評估）；同樣依 design.md Decisions「評估並拒絕在 `cli/taskctl.mjs` 的 `issue get`／`comment list` 輸出層做程式碼層級分隔符包裹」的判斷，本任務範圍不包含修改 `cli/taskctl.mjs` 的輸出層，issue title/description/comment 這條資料流的防線由 2.1/3.1 的自然語言框架宣告單獨承擔；驗證方式：執行 `npm test` 並確認結果為綠燈（若 `test/inject-fullheight-regression.test.mjs` 單獨失敗，依 repo 慣例先單獨重跑該檔案排除已知的並發 flaky 情形，再重跑整套一次），並人工確認 `git status`／`git diff` 未觸碰 `cli/taskctl.mjs`。
