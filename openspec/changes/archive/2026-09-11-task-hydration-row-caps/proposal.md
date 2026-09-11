## Why

`cloud/src/index.mjs` 的兩條 task 水合路徑——`listTasks()`（多 task 批次）與 `getTask()`／`hydrateTask()`（單一 task）——從頭到尾只對「幾個 task 一起查」設過上限（`TASK_LIST_MAX_RESULTS`／`COMMENT_LIST_MAX_RESULTS`／`TASK_TREE_MAX_NODES`，均為 1000），從未對「單一 task 自己名下的子資源有幾筆」設過上限。這是 `cwe400-sweep` change 的獨立覆核（`astra-scan-review-h1.md`）確認的架構性根因，收斂為 4 組同型缺口（dashi-taskboard-3dq）：單一 task 的 relations（subIssues／blockedBy／blocks／related）、comments、activities、comment 附件皆可被人為灌爆到無上限筆數，而水合這些子資源的函式完全不檢查筆數。逐一在 4 個地方各自手動加檢查無法防止未來第 7 個同型函式再犯同樣的錯——這正是本次 4 組缺口裡有 3 組（F1／F2／F4）原本就被 `cwe400-sweep` 初版全面掃描漏掉的原因。需要一個可重用的共用防護機制，而不是四個獨立的程式修補。

## What Changes

- 新增 3 個上限常數：`TASK_RELATION_MAX_RESULTS`、`TASK_ACTIVITY_MAX_RESULTS`、`COMMENT_ATTACHMENT_MAX_RESULTS`（皆為 1000，比照既有 `TASK_LIST_MAX_RESULTS`／`COMMENT_LIST_MAX_RESULTS`／`TASK_TREE_MAX_NODES` 的命名慣例與數值）；單一 task 的 comment 上限直接重用既有 `COMMENT_LIST_MAX_RESULTS`（同一張表、同一個「每 task 幾筆 comment」語意，只是水合路徑而非 `/comments` 端點）。
- 新增兩個共用防護 helper：一個處理「單一擁有者（一個 task／一個 comment）查詢結果」的上限截斷，另一個處理「`listTasks()` 批次查詢時，多個擁有者共用一次 SQL 呼叫」情境下逐一擁有者的上限截斷。兩者的 SQL 查詢都在 SQL 層限制實際掃描與傳輸的列數（`LIMIT max+1`，批次情境用 `ROW_NUMBER() OVER (PARTITION BY <擁有者欄位> ...)` 分區限制），不是先撈全部再於 JS 事後丟棄多餘的列。
- 單一 task 的 relations（subIssues／blockedBy／blocks／related，parent 除外——已由 schema 的 `UNIQUE INDEX` 保證安全）、comments、activities 三組子資源，在 `getTask()` 單一路徑與 `listTasks()` 批次路徑下超量時一律**截斷回傳、不拋錯**，並在回應中新增對應的 `*Truncated` 布林旗標（`task.relations.subIssuesTruncated`／`blockedByTruncated`／`blocksTruncated`／`relatedTruncated`、`task.commentsTruncated`、`task.activitiesTruncated`）。**這與既有 3 個 413 上限先例（`TASK_LIST_TOO_LARGE`／`COMMENT_LIST_TOO_LARGE`／`TREE_TOO_LARGE`）的失敗模式不同**——理由與批次路徑的可用性風險（見 design.md）有關，非隨意選擇。
- comment 附件（F3）分兩種呼叫情境處理：`hydrateComment()` 的 hydrate 路徑（`createComment()`／`updateComment()`／`listComments()`／`listCommentsAfter()`）比照上一點截斷回傳，新增 `comment.attachmentsTruncated` 旗標；`deleteComment()` 刪除前的附件讀取維持**完整讀取、不截斷**（截斷會讓超量附件永遠不被 R2 delete，變成孤兒物件，比原本要防的問題更嚴重），但把目前「一次性 `Promise.all` 觸發全部附件的 R2 delete」改為有界並發、個別失敗互不拖累彼此的批次刪除。
- 回歸測試新增涵蓋 relations／comments／activities／comment 附件四組子資源「剛好等於上限仍完整回傳」與「超過上限觸發截斷（旗標為 true）」的情境，並涵蓋 `deleteComment()` 附件數超過批次併發上限時仍完整刪除、局部失敗不拋出未預期例外的情境；比照 `test/cloud-shared-worker.test.mjs` 既有 cap 測試慣例。

## Capabilities

### New Capabilities

- `task-hydration-result-caps`：定義 task 水合路徑（單一 task 檢視與批次列表兩種路徑）對其名下子資源（relations／comments／activities／comment 附件）套用的筆數上限、超量時的截斷行為與對應旗標契約，以及刪除路徑上附件清理讀取與截斷機制的邊界。

### Modified Capabilities

(none — repo 內尚無既有 spec 描述 task 水合路徑的子資源筆數上限；既有三個上限先例的常數同樣未被任何既有 spec 描述過，屬程式碼慣例而非規範化行為)

## Impact

- Affected specs: `task-hydration-result-caps`（新增）
- Affected code：
  - Modified: `cloud/src/index.mjs`（新增上限常數與共用截斷 helper；修改 `taskRelationsForRow`、`relationSubIssuesByTaskId`、`relationBlockedByByTaskId`、`relationBlocksByTaskId`、`relationRelatedByTaskId`、`hydrateTask`、`taskActivityComments`、`taskActivitiesForTasks`、`attachmentsForComment`、`attachmentsByCommentIdForTask`、`hydrateComment`、`deleteComment` 的查詢與回傳邏輯）
  - Modified: `test/cloud-shared-worker.test.mjs`（新增四組子資源的邊界／超量截斷回歸測試，以及 `deleteComment()` 有界並發刪除的回歸測試）
