## 1. 驗證視窗函式相容性（對應設計決策「批次路徑的截斷必須發生在 SQL 層，不能只在 JS 層事後丟棄多餘的列」）

- [x] 1.1 在 `test/helpers/cloud-worker-harness.mjs` 使用的 miniflare workerd D1 綁定上，用一個最小驗證查詢確認 `ROW_NUMBER() OVER (PARTITION BY ...)` 視窗函式語法可用且回傳結果符合預期的逐分區排名；驗證方式：執行該最小驗證查詢並斷言回傳的 `rn` 欄位對每個分區各自從 1 開始遞增。若查詢失敗或結果不符預期，本任務下明確記錄「改採批次路徑 JS 事後截斷備選方案」，後續任務 4.x／5.2／6.2 改依 JS 分組後逐擁有者截斷實作，並在對應任務完成說明中註記這是已知較弱的防護（只限制輸出筆數、未限制 D1 實際讀取列數）。

## 2. 共用上限常數與截斷 helper（對應設計決策「共用上限常數與 helper 設計」）

- [x] 2.1 在 `cloud/src/index.mjs` 新增 `TASK_RELATION_MAX_RESULTS = 1_000`、`TASK_ACTIVITY_MAX_RESULTS = 1_000`、`COMMENT_ATTACHMENT_MAX_RESULTS = 1_000` 三個常數，宣告位置與既有 `TASK_TREE_MAX_NODES`／`TASK_LIST_MAX_RESULTS`／`COMMENT_LIST_MAX_RESULTS` 相鄰；驗證方式：`rg "TASK_RELATION_MAX_RESULTS|TASK_ACTIVITY_MAX_RESULTS|COMMENT_ATTACHMENT_MAX_RESULTS" cloud/src/index.mjs` 找到三個宣告，且 `npm run test:cloud` 現有測試不受影響仍全數通過。
- [x] 2.2 新增共用 helper `capOwnRows(rows, max)`：`rows.length <= max` 時回傳 `{ rows, truncated: false }`，否則回傳 `{ rows: rows.slice(0, max), truncated: true }`；驗證方式：新增單元測試涵蓋 `rows.length` 等於 `max`、小於 `max`、等於 `max + 1` 三種輸入，各自斷言回傳的 `rows.length` 與 `truncated` 值符合設計規格。
- [x] 2.3 新增共用 helper `capRowsByOwnerId(rows, ownerIds, max)`：輸入為已含 `rn`（分區內排名）欄位的查詢結果與該批次涵蓋的擁有者 id 清單，回傳 `Map<ownerId, { rows, truncated }>`，`rn <= max` 的列進入該擁有者的 `rows`，`rn === max + 1` 的列被捨棄並將該擁有者標記 `truncated: true`，未出現在結果裡的擁有者對應 `{ rows: [], truncated: false }`；驗證方式：新增單元測試以人工建構的 `rows`（涵蓋「某擁有者剛好 max 筆」「某擁有者 max+1 筆」「某擁有者完全沒有列」三種情境）驗證回傳的 `Map` 內容。

## 3. E2 relations 單一 task 路徑截斷（`taskRelationsForRow()`，對應設計決策「失敗模式：hydrate 路徑一律截斷回傳，不 throw（與既有 3 個 413 先例不同）」與「relations 沒有替代讀取路徑，仍採截斷而非 throw」）

- [x] 3.1 `taskRelationsForRow()` 的 `subIssues`／`blockedBy`／`blocks`／`related` 四個查詢各自改為 `ORDER BY task_relations.created_at DESC LIMIT ?`（bind `TASK_RELATION_MAX_RESULTS + 1`），透過 `capOwnRows()` 判斷截斷（依設計決策「relations 沒有替代讀取路徑，仍採截斷而非 throw」，不拋 413），截斷後的結果依原有 `tasks.sort_order, tasks.created_at, tasks.id` 重新排序後才回傳，滿足 Requirement: Per-task relation result caps in hydration paths；驗證方式：新增測試建立一個有 `TASK_RELATION_MAX_RESULTS` 筆 subIssues 的 task，確認 `GET /api/tasks/:id` 回應包含全部筆數且 `relations.subIssuesTruncated` 為 `false`；再建立 `TASK_RELATION_MAX_RESULTS + 1` 筆，確認回應恰為 `TASK_RELATION_MAX_RESULTS` 筆、`subIssuesTruncated` 為 `true`，且新建立的那一筆存在於回應中（保留最新資料）。
- [x] 3.2 `task` 回應物件新增 `relations.subIssuesTruncated`／`relations.blockedByTruncated`／`relations.blocksTruncated`／`relations.relatedTruncated` 四個布林欄位，未觸發截斷時皆為 `false`；驗證方式：對一個所有關聯集合都遠低於上限的既有 task 呼叫 `GET /api/tasks/:id`，斷言四個旗標皆為 `false`。

## 4. E2 relations 批次路徑截斷（`relationSubIssuesByTaskId`／`relationBlockedByByTaskId`／`relationBlocksByTaskId`／`relationRelatedByTaskId`）

- [x] 4.1 四個批次函式各自改為在 SQL 層對每個擁有者（`relation_owner_id`）加上 `ROW_NUMBER() OVER (PARTITION BY <擁有者欄位> ORDER BY task_relations.created_at DESC) AS rn` 並在外層過濾 `rn <= ?`（bind `TASK_RELATION_MAX_RESULTS + 1`），透過 `capRowsByOwnerId()` 分組，每個擁有者的結果依原有顯示排序（`sort_order, created_at, id`）重新排序，並把對應的 `truncated` 結果一路傳遞到 `taskRelationsByTaskId()` 回傳的 Map，滿足 Requirement: Per-task relation result caps in hydration paths 與 Requirement: Batch task hydration truncation is isolated per task；驗證方式：透過 `GET /api/tasks?projectId=...` 建立一個含多筆 task 的專案，其中一筆 task 的 `blockedBy` 超過 `TASK_RELATION_MAX_RESULTS`、其餘 task 的關聯集合都在上限內，斷言回應狀態碼為 200、超量的那筆 task 的 `relations.blockedByTruncated` 為 `true` 且筆數恰為上限、其餘 task 的對應旗標皆為 `false` 且筆數不受影響。

## 5. F1 comments 單一／批次路徑截斷（`hydrateTask()`、`taskActivityComments()`，對應設計決策「截斷時的排序偏好：保留最新資料，避免 activityKey／activityUpdatedAt 停止前進」）

- [x] 5.1 `hydrateTask()` 自己的 comments 查詢改為 `ORDER BY change_revision DESC LIMIT ?`（bind `COMMENT_LIST_MAX_RESULTS + 1`，依設計決策「截斷時的排序偏好：保留最新資料，避免 activityKey／activityUpdatedAt 停止前進」保留最新資料），透過 `capOwnRows()` 判斷截斷並設定 `task.commentsTruncated`，滿足 Requirement: Per-task comment result cap in hydration paths；驗證方式：對一個恰有 `COMMENT_LIST_MAX_RESULTS` 筆 comment 的 task 呼叫 `GET /api/tasks/:id`，斷言 `commentsTruncated` 為 `false`；追加一筆讓總數變成 `COMMENT_LIST_MAX_RESULTS + 1`，重新呼叫，斷言 `commentsTruncated` 為 `true`，且 `activityKey`／`activityUpdatedAt` 相較截斷前有變化（反映最新那一筆 comment）。
- [x] 5.2 `taskActivityComments()` 改為在 SQL 層對每個 `task_id` 加上 `ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY change_revision DESC) AS rn` 並過濾 `rn <= ?`（bind `COMMENT_LIST_MAX_RESULTS + 1`），透過 `capRowsByOwnerId()` 分組後把每個 task 的 `truncated` 結果傳遞給 `listTasks()` 呼叫的 `hydrateTask()`，滿足 Requirement: Batch task hydration truncation is isolated per task；驗證方式：`GET /api/tasks?projectId=...` 回應中，comment 數超過上限的那筆 task 的 `commentsTruncated` 為 `true`，其餘 task 不受影響，整體請求狀態碼為 200。

## 6. F2 activities 單一／批次路徑截斷（`hydrateTask()`、`taskActivitiesForTasks()`）

- [x] 6.1 `hydrateTask()` 自己的 activities 查詢改為 `ORDER BY created_at DESC, id DESC LIMIT ?`（bind `TASK_ACTIVITY_MAX_RESULTS + 1`），透過 `capOwnRows()` 判斷截斷並設定 `task.activitiesTruncated`，滿足 Requirement: Per-task activity result cap in hydration paths；驗證方式：對一個恰有 `TASK_ACTIVITY_MAX_RESULTS` 筆 activity 的 task 呼叫 `GET /api/tasks/:id`，斷言 `activitiesTruncated` 為 `false`；觸發一筆新的 task 變更活動讓總數超過上限，重新呼叫，斷言 `activitiesTruncated` 為 `true` 且 `activityUpdatedAt` 反映最新活動。
- [x] 6.2 `taskActivitiesForTasks()` 改為在 SQL 層對每個 `task_id` 加上 `ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY created_at DESC, id DESC) AS rn` 並過濾 `rn <= ?`（bind `TASK_ACTIVITY_MAX_RESULTS + 1`），透過 `capRowsByOwnerId()` 分組後把每個 task 的 `truncated` 結果傳遞給 `listTasks()`，滿足 Requirement: Batch task hydration truncation is isolated per task；驗證方式：`GET /api/tasks?projectId=...` 回應中，activity 數超過上限的那筆 task 的 `activitiesTruncated` 為 `true`，其餘 task 不受影響。

## 7. F3 comment 附件 hydrate 路徑截斷（`attachmentsForComment()`／`attachmentsByCommentIdForTask()`／`hydrateComment()`）

- [x] 7.1 `attachmentsForComment(env, commentId, { capped })` 與 `attachmentsByCommentIdForTask(env, taskId, { capped })` 新增明確的 `capped` 選項（呼叫端必須明確傳入 `true` 或 `false`，不依賴隱性預設值）：`capped: true` 時查詢改為 `ORDER BY change_revision DESC LIMIT ?`（單一 comment）或帶 `ROW_NUMBER() OVER (PARTITION BY comment_id ORDER BY change_revision DESC)`（單一 task 內多個 comment 的批次版本），透過對應 helper 判斷截斷，回傳形狀新增 `truncated` 資訊；`capped: false` 時維持現有無上限查詢；驗證方式：新增單元測試分別以 `capped: true`／`capped: false` 呼叫同一個有超過 `COMMENT_ATTACHMENT_MAX_RESULTS` 筆附件的 comment，確認前者回傳恰 `COMMENT_ATTACHMENT_MAX_RESULTS` 筆且標記截斷、後者回傳全部筆數。
- [x] 7.2 `hydrateComment()` 呼叫 `attachmentsForComment()`／使用 `attachmentsByCommentIdForTask()` 的批次結果時一律傳入 `capped: true`，並在回傳的 comment 物件新增 `attachmentsTruncated` 布林欄位，滿足 Requirement: Per-comment attachment result cap in hydration read paths；驗證方式：對 `POST /api/tasks/:id/comments`、`PATCH /api/comments/:id`、`GET /api/tasks/:id/comments`、`GET /api/tasks/:id/comments?after=0` 四個入口各自建立一個附件數超過 `COMMENT_ATTACHMENT_MAX_RESULTS` 的 comment 情境，斷言四者回應中的 comment 皆恰含 `COMMENT_ATTACHMENT_MAX_RESULTS` 筆附件且 `attachmentsTruncated` 為 `true`。

## 8. F3 deleteComment() 附件清理維持完整讀取並改為有界並發刪除（對應設計決策「deleteComment() 的附件清理讀取獨立於截斷機制之外：完整讀取 + 有界並發刪除」）

- [x] 8.1 `deleteComment()` 呼叫 `attachmentsForComment(env, current.id, { capped: false })`，確保刪除前的附件讀取不受 `COMMENT_ATTACHMENT_MAX_RESULTS` 影響、永遠完整讀取，滿足 Requirement: Comment deletion attachment cleanup stays complete and fault-tolerant；驗證方式：建立一個附件數超過 `COMMENT_ATTACHMENT_MAX_RESULTS` 的 comment，呼叫 `DELETE /api/comments/:id`，斷言該 comment 與其全部附件的 D1 row（而非只有上限筆數）都已被刪除。
- [x] 8.2 把 `deleteComment()` 觸發 R2 附件刪除的邏輯從單一 `Promise.all` 改為固定批次大小的有界並發（每批循序 `await`，批內並發），並改用能個別容忍失敗的方式收集結果（單一物件刪除失敗記錄下來但不讓函式拋出例外）；驗證方式：新增測試模擬附件筆數超過批次大小的 comment 刪除，斷言 `DELETE /api/comments/:id` 回應狀態碼為 204；另新增測試模擬其中一次 R2 delete 失敗（例如以測試替身讓 `env.ATTACHMENTS.delete` 對特定 id 拋出錯誤），斷言刪除請求仍回傳 204 且失敗已被記錄（例如透過 `console.error` 或等效機制），不因單一物件清理失敗而讓整個請求失敗。

## 9. 回歸測試收尾與 Fix-then-Audit 全 repo 掃描

- [x] 9.1 在 `test/cloud-shared-worker.test.mjs` 為本 change 新增的四組上限（relations 四種、comments、activities、comment 附件）各自新增「剛好等於上限成功」與「超過上限觸發截斷」測試，比照既有 `TASK_LIST_TOO_LARGE`／`COMMENT_LIST_TOO_LARGE` 的 boundary／overflow 測試慣例；驗證方式：`npm run test:cloud` 全數通過，且新增的測試案例數與本任務描述的情境一一對應（可用測試名稱清單核對）。
- [x] 9.2 全 repo 掃描 `attachmentsForComment(` 與 `attachmentsByCommentIdForTask(` 的全部呼叫點，確認每一個呼叫點都明確傳入了 `capped` 選項（沒有遺漏、沒有依賴隱性預設值），滿足設計文件 Risks/Trade-offs 中對「遺漏呼叫點意外套用錯誤預設值」風險的緩解措施；驗證方式：`rg "attachmentsForComment\(|attachmentsByCommentIdForTask\(" cloud/src/index.mjs` 列出全部呼叫點，逐一核對每個呼叫點的 `capped` 引數值是否符合設計文件 Implementation Contract 的規定（`hydrateComment()` 傳 `true`，`deleteComment()` 傳 `false`）。
- [x] 9.3 執行完整 `npm test` 與 `npm run test:cloud`，確認既有測試（含既有 3 個 413 上限先例的既有測試）全部維持綠燈，且本次新增的所有測試皆通過；驗證方式：兩個指令的執行結果皆為全數通過，無新增的失敗或既有測試的行為變化。
