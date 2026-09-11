## Context

`cloud/src/index.mjs` 目前有 3 個既有的結果筆數上限先例，全部發生在 dashi-taskboard-edg／dashi-taskboard-bhi／既有的 tree 端點三次獨立的 Fix-then-Audit 修復中：`TASK_TREE_MAX_NODES`（`getTaskTree()`，超量拋 `ApiError(413, "TREE_TOO_LARGE", ...)`）、`TASK_LIST_MAX_RESULTS`（`listTasks()`，超量拋 `ApiError(413, "TASK_LIST_TOO_LARGE", ...)`）、`COMMENT_LIST_MAX_RESULTS`（`listComments()`／`listCommentsAfter()`，超量拋 `ApiError(413, "COMMENT_LIST_TOO_LARGE", ...)`）。三者形狀完全一致：`all()` 撈回全部 rows 後，用 `rows.length > MAX` 判斷，超量就整個請求 413。

這三個先例都在保護「使用者直接請求的那個集合本身」——請求一份 task 列表、一份 comment 列表、一棵 task tree，太大就是那個請求本身太大。`cwe400-sweep` 的獨立覆核（`astra-scan-review-h1.md`）發現的 4 組缺口（E2 relations、F1 comments、F2 activities、F3 comment 附件）性質不同：它們都是**內嵌在 task 水合結果裡的子資源**，不是使用者直接請求的主體。使用者呼叫 `GET /api/tasks/:id` 是在要求「一個 task」，該 task 名下有幾筆 comment／幾筆 relation 只是水合過程中的附帶細節；使用者呼叫 `GET /api/tasks?projectId=...` 是在要求「一批 task」，其中某一筆 task 自己的子資源筆數更是與這次請求想要的東西（task 列表本身）無關的內部細節。這個「主體集合 vs. 內嵌子資源」的區別，是本設計選擇不同失敗模式的核心理由（見下方 Decisions）。

`hydrateTask()`（`getTask()` 的水合函式，也被 `listTasks()` 以 override 參數重用）額外把 comments／activities 兩個陣列餵給 `attachTaskActivity()`，後者用它們計算 `participants`（去重 actor 清單）、`conversationRefs`（僅收有 thread binding 的 comment）、`activityKey`（對每個 comment／activity 各自的 `[id, version/created_at]` tuple 做 `JSON.stringify`）、`activityUpdatedAt`（`updated_at`／`created_at` 的最大值）。`activityKey`／`activityUpdatedAt` 是設計給 client 做變更偵測用的：client 靠比對這兩個欄位決定要不要重新抓取詳細內容。這代表這兩個陣列的「內容」比「陣列本身有沒有回傳給 client」更重要——即使將來不截斷陣列本身，量體本身（`JSON.stringify` 每一筆的 tuple）已經是 `listTasks()` 回應大小／CPU 隨單一被灌爆 task 線性放大的真正來源，比「回傳筆數」更隱蔽。

relations（`task.relations.subIssues`／`blockedBy`／`blocks`／`related`）與附件（`comment.attachments`）不同，是直接映射進回應 JSON 的陣列，沒有中介的摘要計算。

repo 目前**沒有任何獨立的 relations 端點**——`task.relations` 只能透過 `getTask()`／`listTasks()` 內嵌取得，client 沒有替代管道可以分頁拿到完整清單。comments／activities／comment 附件則各自有（或即將有）獨立、可分頁的端點：`GET /api/tasks/:id/comments`（`listComments()`／`listCommentsAfter()`，已有 `COMMENT_LIST_MAX_RESULTS` 上限，dashi-taskboard-bhi）、`GET /api/tasks/:id/activities`（`listTaskActivities()`，目前仍無上限，dashi-taskboard-1jm，範圍外）、`GET /api/comments/:id/attachments`（`listCommentAttachments()`，目前仍無上限，dashi-taskboard-kgg，範圍外）。

`comments`／`attachments` 兩張表都有 `change_revision` 欄位（`cloud/migrations/0011_comments_task_updated.sql`，由全域 revision 計數器單調遞增賦值，並各自建有 `(task_id, change_revision)`／`(comment_id, change_revision)` 索引），`task_activities` 有 `created_at`，`task_relations` 有 `created_at`——四組子資源都有可用的、已索引或至少可排序的新舊判斷欄位，足以支援「超量時保留最新 N 筆」的截斷策略。

測試使用的 D1 綁定是 `test/helpers/cloud-worker-harness.mjs` 透過 `miniflare` 啟動的真實 workerd D1 實例（非簡化模擬），可以直接驗證 SQL 視窗函式（`ROW_NUMBER() OVER (PARTITION BY ...)`）等現代 SQLite 語法是否可用。

## Goals / Non-Goals

**Goals:**

- 為「單一 task 名下子資源筆數無上限」這一整類缺口（E2／F1／F2／F3 四組）建立可重用的共用防護機制，而不是四個獨立的程式修補，避免未來第 7 個同型函式再犯同樣的錯。
- 上限常數命名與既有 `TASK_LIST_MAX_RESULTS`／`COMMENT_LIST_MAX_RESULTS`／`TASK_TREE_MAX_NODES` 慣例一致，且新常數的命名要讓 dashi-taskboard-1jm（`listTaskActivities()`）、dashi-taskboard-kgg（`listTaskAttachments()`／`listCommentAttachments()`）未來可以直接複用，不必再發明一次。
- 讓 SQL 查詢本身限制實際掃描與傳輸的列數，而不是先讓 D1 回傳無上限的完整結果集，再於 Worker 記憶體裡事後丟棄多餘的列——否則「新增上限」只是把回應大小的放大點藏起來，沒有真正解決 CWE-400 要防的資源耗用問題。
- 為 4 組缺口中「有替代讀取路徑」與「沒有替代讀取路徑」的子資源，分別給出有理由支持的失敗模式，不強行套用單一答案。
- 保持 `deleteComment()` 的附件清理讀取在正確性上完整（附件 row 已隨 comment 的 `ON DELETE CASCADE` 從 D1 消失，讀不全就等於製造孤兒 R2 物件），同時修正它目前用單一 `Promise.all` 觸發全部附件 R2 delete、任何一個失敗就讓整個請求丟出未預期例外的問題。

**Non-Goals:**

- 不實作 dashi-taskboard-xug／dashi-taskboard-50m（`listProjects()`／`deleteProject()`／`deleteArchivedTask()` 的上限缺口，E1／F4）——已由 PM 另開票走一般 bug fix 流程平行處理，型態與本 change（task 水合路徑的單一 task 子資源筆數）不同。
- 不實作 dashi-taskboard-1jm（`listTaskActivities()` 端點本身的上限）與 dashi-taskboard-kgg（`listTaskAttachments()`／`listCommentAttachments()` 端點本身的上限）——本 change 只確保新常數命名可讓這兩張票未來直接複用，不預先實作它們的範圍。
- 不新增獨立的 `GET /api/tasks/:id/relations` 分頁端點——relations 目前的截斷雖然沒有替代讀取路徑可補救，但 relations 在合法使用情境下極少接近 1000 筆（多數 task 的 blockers／related 是個位數到十位數），新增一個分頁端點是為了尚未發生的需求預先建置基礎設施，若未來證實有真實需求應該另開 change 討論。
- 不改動 `previewImageRow` 的 N+1（dashi-taskboard-0w9）——性質是查詢次數放大而非單筆結果無上限，且已有獨立追蹤票。
- 不修改既有 3 個 413 上限先例（`listTasks()`／`listComments()`／`listCommentsAfter()`／`getTaskTree()`）的既有邏輯或把它們改成共用同一個新 helper——它們已經是正確、已測試、已上線的程式碼，沒有本 change 要修的缺口；為了「風格統一」去動它們只會增加審查面積與回歸風險，沒有對應的正確性效益。新 helper 的介面設計會讓它們未來如果要重構時可以自然採用，但重構它們不在本 change 範圍內。

## Decisions

### 共用上限常數與 helper 設計

新增 3 個常數（值皆為 `1_000`，與既有三個上限先例一致）：

- `TASK_RELATION_MAX_RESULTS`：單一 task 的 subIssues／blockedBy／blocks／related，各自獨立套用（四個集合分開計數，不是總和）。
- `TASK_ACTIVITY_MAX_RESULTS`：單一 task 的 activities（`task_activities` 表）。
- `COMMENT_ATTACHMENT_MAX_RESULTS`：單一 comment 的附件。

F1（comments）不新增常數，直接重用既有 `COMMENT_LIST_MAX_RESULTS`——理由是這條水合路徑查的是同一張 `comments` 表、同一個「這個 task 有幾筆 comment」語意，只是入口不是 `/comments` 端點而是內嵌在 task 物件裡；用同一個常數確保「這個 task 到底有幾筆 comment」在任何入口下都是同一個判斷基準，而不是意外地允許水合路徑跟專用端點採用不同上限。

備選方案：F1 也另開一個新常數（例如 `TASK_HYDRATE_COMMENT_MAX_RESULTS`）——被拒絕，因為找不到任何理由讓「水合路徑」與「`/comments` 端點」對同一張表、同一個 task 允許不同的筆數上限；分開命名只會製造兩個常數却需要保持同步變動的負擔，是不必要的重複。

新增兩個共用 helper（介面定義見下方 Implementation Contract）：`capOwnRows`（單一擁有者查詢結果的截斷判斷，用於 `getTask()` 單一路徑）與 `capRowsByOwner`（批次查詢時逐一擁有者的截斷判斷，用於 `listTasks()` 批次路徑）。兩者都不對呼叫端隱藏「超量」這件事——回傳值明確包含 `truncated` 旗標，呼叫端負責把它接到對應的回應欄位，不是在 helper 內部靜默吞掉。

### 失敗模式：hydrate 路徑一律截斷回傳，不 throw（與既有 3 個 413 先例不同）

既有 3 個先例全部是「使用者直接請求的主體集合本身太大」（一份 task 列表、一份 comment 列表、一棵 tree），太大代表這個請求本身無法安全處理，throw 413 是合理的——使用者可以縮小查詢範圍重試。本次 4 組缺口全部是**內嵌在 task 水合結果裡的子資源**，不是使用者請求的主體：呼叫 `GET /api/tasks/:id` 要的是「這個 task」，`GET /api/tasks?...` 要的是「這批 task」，子資源筆數只是水合過程的附帶細節。如果因為附帶細節超量就讓整個請求 413，會讓一個本身完全正常大小的主體資源（task 本身的標題、狀態、描述等欄位）因為不相關的欄位而變成完全無法讀取——這個代價比 CWE-400 本身要防的問題更不成比例。因此本 change 選擇：**E2／F1／F2／F3 四組子資源在 hydrate 路徑下超量一律截斷回傳，不 throw**，並用旗標明確告知 client 發生了截斷。

這個決策同時解決了批次路徑的可用性問題（見下一條）：`listTasks()` 對每一筆 task 呼叫 `hydrateTask()`，如果子資源超量就 throw，會讓「1000 筆 task 裡只有 1 筆資料異常」變成整個 `GET /api/tasks` 全部失敗——比原本要防的問題更糟，且更容易被拿來當作用一個被灌爆的 task 癱瘓整個列表頁的攻擊手法。截斷回傳讓單一 task 的異常維持在該 task 自己的欄位範圍內，不會波及同一批次裡的其他 task，也不會讓 `getTask()`／`listTasks()` 兩條路徑對同一個 task 給出不一致的「能不能讀到」結果（只有截斷程度不同，不會一個能讀一個整個失敗）。

備選方案：只有 `getTask()` 單一路徑 throw、`listTasks()` 批次路徑截斷（因為單一路徑的 blast radius 只影響請求者自己，形狀與 `getTaskTree()`／`TREE_TOO_LARGE` 一致）——被拒絕。理由有二：其一，`hydrateTask()` 是 `getTask()` 與 `listTasks()` 共用的同一個函式，讓同一個 task 在兩條路徑下有不同的失敗模式（`GET /api/tasks/:id` 整個 403，`GET /api/tasks?...` 裡卻能看到截斷後的同一個 task）會讓 client 難以建立一致的心智模型；其二，comments／activities 超量情境下真正被回傳的欄位（`participants`／`conversationRefs`／`activityKey`／`activityUpdatedAt`）本來就只是水合的衍生摘要，不是使用者直接要求的主體，用「這是附帶細節，不該讓主體資源整個不可讀」的同一套理由來看，`getTask()` 單一路徑一樣不該因為這個附帶細節而 403。

### 批次路徑的截斷必須發生在 SQL 層，不能只在 JS 層事後丟棄多餘的列

`taskActivityComments()`／`taskActivitiesForTasks()`／`relationSubIssuesByTaskId()`／`relationBlockedByByTaskId()`／`relationBlocksByTaskId()`／`relationRelatedByTaskId()` 六個批次函式目前的 `WHERE owner_id IN (...)` 一次查詢涵蓋一個 chunk（80 或 40 筆）裡的所有擁有者。如果只在撈回全部 rows 後、於 JS 分組迴圈裡把每個擁有者的陣列截斷到上限，這只能限制「最終回傳給 client 的筆數」，**不能限制「這次請求對 D1 實際掃描與傳輸的列數」**——一個被灌爆到 50 萬筆 relation 的 task，只要它出現在任何一個被查詢的 chunk 裡，這 50 萬筆仍然會被完整從 D1 讀出、完整傳輸到 Worker、完整放進 JS 陣列，只是最後才被截斷丟棄。這不是「加了上限」，只是把攻擊造成的資源耗用往後挪了一步，沒有真正防到 CWE-400 要防的問題——而批次路徑正是本次 4 組缺口裡 blast radius 最大的路徑（見上一條），如果偏偏是這條路徑的防護打了折扣，等於把最需要防的地方防得最不徹底。

因此本 change 的批次查詢改為在 SQL 層用視窗函式做逐擁有者上限：外層查詢對每個原始查詢結果加上 `ROW_NUMBER() OVER (PARTITION BY <擁有者欄位> ORDER BY <新舊判斷欄位> DESC) AS rn`，再用一層 `WHERE rn <= ?`（bind 上限常數 + 1）過濾，讓 D1 對單一擁有者最多只實際掃描與回傳「上限 + 1」筆，不論該擁有者實際累積了多少筆。分組時若某擁有者出現了第「上限 + 1」筆（`rn` 等於上限 + 1），代表該擁有者被截斷，捨棄這一筆並標記 `truncated = true`；否則该擁有者的全部列都在上限內，`truncated = false`。

單一擁有者路徑（`taskRelationsForRow()`、`hydrateTask()` 自己的 comments／activities 查詢，只有一個 task，不需要分區）用單純的 `ORDER BY <新舊判斷欄位> DESC LIMIT ?`（bind 上限常數 + 1）即可達成同樣效果，不需要視窗函式。

備選方案：批次路徑維持現有查詢不變，只在 JS 分組迴圈裡截斷——被拒絕，理由如上（無法限制實際讀取／傳輸列數，防護效果打折扣，且恰好是 blast radius 最大的路徑）。這個備選方案的優點是完全不用碰 SQL、複雜度最低；如果 apply 階段驗證視窗函式在專案的測試 D1 綁定（`test/helpers/cloud-worker-harness.mjs` 用的 `miniflare` workerd D1）上有相容性問題，允許退回這個備選方案作為權宜之計，但退回時必須在對應 task 的完成說明裡明確記錄「這是已知較弱的防護，只限制輸出筆數，未限制讀取列數」，不能悄悄退回而不留紀錄。

### relations 沒有替代讀取路徑，仍採截斷而非 throw

E2 的 4 種 relation 集合是唯一沒有獨立分頁端點的一組——client 沒有 `GET /api/tasks/:id/relations?after=...` 這類管道可以在截斷後補讀完整清單，不像 comments（`/comments` 已有游標分頁）、activities（`/activities`，1jm 修好後會有）、附件（`/attachments`，kgg 修好後會有）。這代表 relations 一旦被截斷，被截掉的那部分目前確實沒有辦法在不改動 API surface 的情況下補回來。

即使如此，本 change 仍選擇 relations 與其他三組採用同一種失敗模式（截斷），理由與上面「失敗模式」條目相同：throw 會讓 relations 這個附帶欄位的異常，波及到主體 task 資源本身的可讀性（單一路徑）或波及同一批次的其他 task（批次路徑），這個代價比「client 暫時看不到完整的 relations 清單」更高。且 relations 在合法使用情境下極少接近 1000 筆這個上限——多數 task 的 blockers／related task 是個位數到十位數，觸發這個上限本身就是異常訊號（見 Non-Goals，暫不新增獨立 relations 端點）。

備選方案：relations 維持 throw、其餘三組截斷——被拒絕，因為這會讓同一個 `hydrateTask()` 呼叫視哪一種子資源超量而有不同的整體成敗（同一次 `GET /api/tasks/:id`，relations 超量就整個 403，comments 超量卻只是回應裡多一個旗標），對呼叫端來說是更難預期的行為，且批次路徑下 relations throw 一樣會重新引入「一個異常 task 拖垮整個列表」的問題。

### 截斷時的排序偏好：保留最新資料，避免 activityKey／activityUpdatedAt 停止前進

`comments`／`attachments` 兩張表都有 `change_revision`（單調遞增，已建有對應索引）；`task_activities`／`task_relations` 都有 `created_at`。所有新的 `LIMIT`／視窗函式排序都採用「新舊判斷欄位 DESC」（保留最新 N 筆，丟棄最舊的），而不是維持現有查詢的 `ORDER BY id`／`ORDER BY created_at, id`（保留最舊 N 筆）。

理由：`hydrateTask()` 的 comments／activities 陣列會餵給 `attachTaskActivity()` 計算 `activityKey`（每筆 comment／activity 的 `[id, version/created_at]` tuple 序列化）與 `activityUpdatedAt`（`updated_at`／`created_at` 的最大值），這兩個欄位是 client 偵測「這個 task 有沒有新動態」的依據。如果截斷永遠保留最舊 N 筆，一旦某 task 的 comment／activity 數超過上限，之後任何新增的 comment／activity 都會被排除在截斷範圍外，`activityKey`／`activityUpdatedAt` 會永久停止反映新資料——依賴這兩個欄位做輪詢／變更偵測的 client 會永久收不到「這個 task 有新留言」的訊號，即使新留言確實剛剛發生。保留最新 N 筆則相反：只要有新資料進來，它一定在截斷範圍內，`activityKey`／`activityUpdatedAt` 會持續前進，只是「被截斷丟棄的那一段」會是舊資料而非新資料。

`attachTaskActivity()` 在計算前會把 `comments`／`activities` 依 `id.localeCompare` 重新排序（與查詢本身的 `ORDER BY` 無關），因此改變查詢排序方向不影響現有的顯示順序邏輯——只影響「超量時保留哪一段」，不影響「保留下來的資料要怎麼排序顯示」。

relations 的顯示順序（`tasks.sort_order, tasks.created_at, tasks.id`，依「對方 task」的排序）**沒有**類似 `attachTaskActivity()` 的重新排序步驟，是直接映射進回應 JSON 的陣列。若截斷選取查詢改用 `task_relations.created_at DESC LIMIT`／視窗函式排序，選出「保留哪些 relation」後，仍必須在回傳前依原本的 `tasks.sort_order, tasks.created_at, tasks.id` 重新排序，才不會讓一般情況（未觸發截斷）下的顯示順序跟著改變——截斷選取用的排序與顯示用的排序是兩個獨立的關注點，不能省略第二次排序。

備選方案：維持現有 `ORDER BY id`／`ORDER BY created_at, id`（保留最舊 N 筆）——被拒絕，理由是 `activityKey`／`activityUpdatedAt` 的永久停滯風險（見上）。

### deleteComment() 的附件清理讀取獨立於截斷機制之外：完整讀取 + 有界並發刪除

`deleteComment()`（`cloud/src/index.mjs`）目前的順序是：讀出該 comment 的全部附件 → 從 D1 刪除 comment row（`attachments.comment_id` 有 `ON DELETE CASCADE`，附件 row 隨之從 D1 消失）→ 用一次性的 `Promise.all` 對讀到的全部附件觸發 R2 物件刪除。這個讀取如果套用跟其他三組一樣的「截斷」處理，會讓超過上限的那部分附件永遠不會被觸發 R2 delete——因為對應的 D1 row 已經被 cascade 刪除，沒有任何機制會再去清理它們，變成永久孤兒物件，是比 CWE-400 本身更嚴重的資料完整性倒退（storage leak）。這個呼叫點的讀取因此**維持完整、不套用任何筆數上限**。

這個呼叫點真正的資安疑慮不是「讀取無上限」，是「單一 delete request 用 `Promise.all` 對無上限筆數的附件同時觸發並發 R2 API 呼叫」：附件筆數越多，並發的 R2 呼叫就越多，除了資源耗用風險外，`Promise.all` 只要其中一個 R2 delete 失敗就整體 reject，導致 comment 與其附件的 D1 row 都已經確定刪除、卻讓這次 HTTP 請求收到未預期的錯誤（而非成功的 204），且其餘還沒完成的 R2 delete 呼叫的成敗完全不可控。修法方向：改為分批、有界並發（例如每批固定筆數，批次之間循序 `await`）觸發 R2 delete，且改用能容忍個別失敗的方式收集結果（不讓單一 R2 delete 失敗就讓整個函式拋出例外）——因為此時 D1 那側已經確定完成刪除，個別 R2 物件清理失敗屬於「盡力而為、記錄下來即可」的收尾工作，不該讓使用者對一個實際上已經成功的刪除操作收到錯誤回應。

備選方案：把這個呼叫點也納入 `COMMENT_ATTACHMENT_MAX_RESULTS` 截斷——被拒絕，理由是孤兒物件的資料完整性倒退（見上）。

## Implementation Contract

**行為（Behavior）：**

- `GET /api/tasks/:id`：回應中的 `task.relations.subIssues`／`blockedBy`／`blocks`／`related`、以及影響 `task.commentsTruncated`／`task.activitiesTruncated` 計算基礎的 comments／activities 資料，各自獨立套用對應上限；任一集合超量時，該集合截斷為上限筆數（保留最新的部分），對應 `*Truncated` 旗標設為 `true`；未超量時旗標為 `false`，回應內容與行為完全不變。整個請求的 HTTP 狀態碼與既有行為一致（不因子資源超量而 403 或改變狀態碼）。
- `GET /api/tasks?...`（`listTasks()`）：回應中每一筆 task 各自獨立套用上述截斷邏輯；任一筆 task 的子資源超量，只影響該筆 task 自己的欄位與旗標，不影響同一次回應裡其他 task 的資料，也不影響整個請求的成敗。
- `POST /api/tasks/:id/comments`（`createComment()`）、`PATCH /api/comments/:id`（`updateComment()`）、`GET /api/tasks/:id/comments`（`listComments()`／`listCommentsAfter()`）：回應中每筆 comment 的 `attachments` 欄位套用 `COMMENT_ATTACHMENT_MAX_RESULTS` 截斷，新增 `attachmentsTruncated` 旗標，行為模式與上述一致。
- `DELETE /api/comments/:id`（`deleteComment()`）：刪除行為不變（該 comment 與其名下全部附件的 D1 row 一律被刪除，附件筆數多寡不影響刪除是否成功、不套用任何截斷）；附件對應的 R2 物件清理改為分批有界並發觸發，任何單一 R2 物件刪除失敗不影響本次 HTTP 回應的成功狀態（該次刪除操作在 D1 層面已經確定完成），失敗需要被記錄（例如 `console.error`，比照本檔既有的錯誤記錄慣例）以利事後排查孤兒物件。

**介面／資料形狀（Interface）：**

- 新增常數：`TASK_RELATION_MAX_RESULTS = 1_000`、`TASK_ACTIVITY_MAX_RESULTS = 1_000`、`COMMENT_ATTACHMENT_MAX_RESULTS = 1_000`，宣告位置與既有 `TASK_TREE_MAX_NODES`／`TASK_LIST_MAX_RESULTS`／`COMMENT_LIST_MAX_RESULTS` 相鄰。
- 新增共用 helper `capOwnRows(rows, max)`：輸入為一次 `ORDER BY <新舊欄位> DESC LIMIT max + 1` 查詢的完整結果，回傳 `{ rows, truncated }`——`rows.length <= max` 時原樣回傳且 `truncated` 為 `false`；否則回傳前 `max` 筆且 `truncated` 為 `true`。供單一擁有者路徑（`taskRelationsForRow()` 的四個集合、`hydrateTask()` 自己的 comments／activities 查詢、`attachmentsForComment()`）使用。
- 新增共用 helper `capRowsByOwnerId(rows, ownerIds, max)`：輸入為一次帶有 `ROW_NUMBER() OVER (PARTITION BY <擁有者欄位> ORDER BY <新舊欄位> DESC) AS rn` 並過濾 `rn <= max + 1` 的批次查詢結果、以及該批次涵蓋的擁有者 id 清單，回傳 `Map<ownerId, { rows, truncated }>`——每個擁有者最多 `max` 筆（`rn` 等於 `max + 1` 的那一列被捨棄並標記該擁有者 `truncated = true`），未出現在結果裡的擁有者對應 `{ rows: [], truncated: false }`。供批次路徑（`relationSubIssuesByTaskId()`／`relationBlockedByByTaskId()`／`relationBlocksByTaskId()`／`relationRelatedByTaskId()`／`taskActivityComments()`／`taskActivitiesForTasks()`）使用。
- `task` 回應物件新增欄位：`relations.subIssuesTruncated`／`relations.blockedByTruncated`／`relations.blocksTruncated`／`relations.relatedTruncated`（布林，巢狀在既有 `relations` 物件內，與 `subIssues`／`blockedBy`／`blocks`／`related` 同層）、`commentsTruncated`／`activitiesTruncated`（布林，與既有 `participants`／`conversationRefs`／`activityKey`／`activityUpdatedAt` 同層，由 `attachTaskActivity()` 一併設定）。
- `comment` 回應物件新增欄位：`attachmentsTruncated`（布林，與既有 `attachments` 同層，由 `hydrateComment()` 設定）。
- `attachmentsForComment()`／`attachmentsByCommentIdForTask()` 新增一個明確的呼叫端選項（例如第三個參數 `{ capped: true }`／`{ capped: false }`，預設值需在實作時明確指定、不得省略後隱性依賴預設值），讓 `hydrateComment()` 呼叫走 `capped: true`（套用截斷），`deleteComment()` 呼叫走 `capped: false`（完整讀取），兩種呼叫模式在同一組函式簽章下並存，不需要兩份重複的查詢邏輯。

**失敗模式（Failure modes）：**

- 上述四組子資源（relations／comments／activities／comment 附件）在 hydrate／read 路徑下超量：**不拋錯**，截斷為上限筆數並將對應 `*Truncated` 旗標設為 `true`；HTTP 狀態碼與既有行為一致。
- `deleteComment()` 的附件清理讀取：不套用任何截斷，永遠完整讀取；R2 物件刪除若部分失敗，記錄失敗但不讓 `deleteComment()` 拋出例外、不影響 `DELETE /api/comments/:id` 回傳 204。
- 上述失敗模式變更**不影響**既有 3 個 413 上限先例（`TASK_LIST_TOO_LARGE`／`COMMENT_LIST_TOO_LARGE`／`TREE_TOO_LARGE`）——它們的呼叫路徑、判斷邏輯與拋錯行為維持完全不變。

**驗收條件（Acceptance criteria）：**

- `test/cloud-shared-worker.test.mjs` 新增回歸測試，每組子資源（relations 四種各自、comments、activities、comment 附件）涵蓋「剛好等於上限筆數仍完整回傳、旗標為 `false`」與「超過上限筆數觸發截斷、旗標為 `true` 且截斷後仍保留最新資料」兩種情境，比照既有 `TASK_LIST_TOO_LARGE`／`COMMENT_LIST_TOO_LARGE` 測試的 boundary 與 overflow 測試慣例（`test/cloud-shared-worker.test.mjs` 既有的等於上限與超過上限兩類測試）。
- 新增測試驗證 `listTasks()` 批次路徑下，單一筆 task 的子資源超量**不影響**同一次回應裡其他 task 的資料與整體 HTTP 狀態碼（即批次路徑截斷正確運作、不會退化成整批 403）。
- 新增測試驗證 `deleteComment()` 在附件筆數超過批次併發上限時，仍能完整刪除該 comment 與其全部附件的 D1 row，且回應狀態碼仍為 204。
- 新增測試驗證截斷後的 `activityKey`／`activityUpdatedAt` 會隨新增的 comment／activity 持續前進（新增一筆超過上限後的最新 comment／activity，重新水合後 `activityKey`／`activityUpdatedAt` 有變化），驗證「保留最新 N 筆」的排序策略確實生效，而非停滯在舊資料上。
- 全部既有測試（`npm test`、`npm run test:cloud`）維持綠燈，既有 3 個 413 上限先例的既有測試案例不受影響、不需修改。

**範圍邊界（Scope boundaries）：**

- 範圍內：`cloud/src/index.mjs` 中 `taskRelationsForRow`、`relationSubIssuesByTaskId`、`relationBlockedByByTaskId`、`relationBlocksByTaskId`、`relationRelatedByTaskId`、`hydrateTask`、`taskActivityComments`、`taskActivitiesForTasks`、`attachmentsForComment`、`attachmentsByCommentIdForTask`、`hydrateComment`、`deleteComment` 的查詢與回傳邏輯；新增的 3 個上限常數與 2 個共用 helper；`test/cloud-shared-worker.test.mjs` 中對應的新增回歸測試。
- 範圍外：`listProjects()`／`deleteProject()`／`deleteArchivedTask()`（E1／F4，dashi-taskboard-xug／dashi-taskboard-50m）、`listTaskActivities()`（1jm）、`listTaskAttachments()`／`listCommentAttachments()`（kgg）、`previewImageRow` 的 N+1（0w9）、新增獨立的 relations 分頁端點、既有 3 個 413 上限先例本身的重構。

## Risks / Trade-offs

- [風險] relations 被截斷後，client 目前沒有任何 API 呼叫可以補讀被截斷的部分（無獨立 relations 端點）→ [緩解] 這個上限的觸發門檻（1000 筆）遠高於合法使用情境下的正常筆數，相關性質與既有 `TASK_LIST_MAX_RESULTS`／`COMMENT_LIST_MAX_RESULTS` 一致；`relatedTruncated` 等旗標讓 client 至少能偵測並向使用者呈現「這裡的清單不完整」，而不是靜默地看起來完整卻缺資料；若未來證實有真實需求，可另開 change 討論新增分頁端點。
- [風險] 批次路徑改用視窗函式（`ROW_NUMBER() OVER (PARTITION BY ...)`）如果與專案實際使用的 D1／workerd SQLite 版本有相容性問題，會在 apply 階段才被發現 → [緩解] `test/helpers/cloud-worker-harness.mjs` 使用真實 `miniflare` workerd D1 綁定，設計要求在動手改寫全部 6 個批次查詢前，先用一個獨立的最小驗證確認視窗函式語法在該綁定下可用；若不可用，退回「批次路徑改為單純 JS 事後截斷」的備選方案（見 Decisions 中「批次路徑的截斷必須發生在 SQL 層」條目），並在對應 task 完成說明中明確記錄這是已知較弱的防護。
- [風險] `*Truncated` 旗標是本次新增的回應欄位，既有 client（web 前端）目前不會讀取或呈現它，超量情境下使用者只會看到「清單比較短」而不知道發生了截斷 → [緩解] 這是本次變更刻意的範圍邊界（見 Non-Goals）：新增旗標本身已經是比「完全沒有任何線索」更好的狀態，前端如何呈現截斷屬於獨立的 UX 工作，不在本次資安remediation 的範圍內；旗標的存在讓未來要做這件事時不需要再改一次後端契約。
- [風險] `attachmentsForComment()`／`attachmentsByCommentIdForTask()` 新增呼叫端選項後，若有遺漏的呼叫點忘記明確指定 `capped` 選項、意外套用了錯誤的預設值（例如 `deleteComment()` 意外套用截斷、造成孤兒物件；或某個 hydrate 呼叫點意外套用完整讀取、繞過保護）→ [緩解] 驗收條件要求逐一列出這兩個函式當前的全部呼叫點（`hydrateComment()`、`deleteComment()`）並個別驗證各自套用了正確的選項，不依賴「其中一個是預設值」的隱性假設；規格與任務清單都必須明確標示每個呼叫點該傳入哪個值。

## Migration Plan

- 這是純新增的防護邏輯（新常數、新 helper、新查詢排序與截斷、新回應旗標），沒有 schema 變更，不需要資料遷移。
- 沒有需要分階段上線的相依關係——新常數與新旗標可以與既有程式碼一起原子性地部署，不存在「舊 client 呼叫新後端」或反過來的相容性問題（新增的回應欄位是純附加，既有 client 忽略未知欄位即可正常運作）。
- Rollback 策略：若上線後發現截斷邏輯本身有缺陷（例如視窗函式在正式環境 D1 行為與測試環境不一致），回退等同於還原本次變更的 commit，恢復成「無上限」的既有行為；由於沒有 schema 變更，回退不需要額外的資料修復步驟。

## Open Questions

- 批次路徑的視窗函式驗證結果（是否需要退回 JS 事後截斷的備選方案）交由 apply 階段的第一個任務決定，不在本設計文件中預先假設答案。
- `attachmentsForComment()`／`attachmentsByCommentIdForTask()` 的呼叫端選項具體命名（例如 `capped`／`enforceLimit`／其他）交由 apply 階段依 repo 現有的參數命名慣例決定，不在本設計文件中預先指定以避免與最終實作不一致。
