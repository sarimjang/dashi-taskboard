## Why

`dashi-taskboard-50m`（`work/50m` 分支 commit `783befa`，尚未合併進 `integration/dashi-taskboard`）把 `deleteProject()`/`deleteArchivedTask()` 刪除附件前的無上限 SELECT 改成 keyset pagination 收集完整 id 清單，並在 `DELETE` 的 `WHERE` 子句用 `(SELECT COUNT(*) FROM ... WHERE ...) = ?` 做原子性數量檢查，取代原本無 guard 的兩段式 `env.DB.batch()`。獨立 reviewer（`bd50m-review-h1.md` 發現 1）證實這個 count-based guard 有一個真實、可構造的 TOCTOU 盲點：分頁收集完成到 `DELETE` 真正執行之間的窗口內，若剛好發生「刪除一筆既有附件 + 新增一筆全新附件」，COUNT 淨值不變，guard 誤判通過，新上傳那筆附件的 D1 metadata 列會被 `ON DELETE CASCADE` 清空，其 R2 物件從此永久孤兒化（無法被任何現有清理路徑找到）。這是 50m 這次重構自己新引入的回歸——修法前的兩段式 `env.DB.batch([SELECT, DELETE])` 在 D1 上是單一 implicit transaction，不存在這個窗口。

user 已核准修法方向：改用類似 `tasks`/`comments` 既有 `version` 欄位的樂觀鎖 pattern，幫每個附件擁有者（`projects`、`tasks`）各自維護一個單調遞增的附件變更計數器，`DELETE` guard 改成比對計數器版本而非數量——計數器單調遞增，一增一減必然讓計數器移動，不會有「淨值不變」的盲點。

## What Changes

- 新增 schema migration：`projects`、`tasks` 各自新增 `attachment_revision INTEGER NOT NULL DEFAULT 0` 計數器欄位；新增 4 個 `AFTER INSERT`/`AFTER DELETE` trigger，掛在 `project_readme_attachments`（遞增 `projects.attachment_revision`）與 `attachments`（遞增 `tasks.attachment_revision`）兩張表上，比照這個 repo 已經在 `global_revision` 大量使用的既有 trigger 慣例（`cloud/migrations/0001_initial.sql`、`0004_task_activities.sql`、`0010_project_readme_attachments.sql`、`0011_comments_task_updated.sql`）。
- `deleteProject()`/`deleteArchivedTask()` 的 `DELETE` guard 從 `(SELECT COUNT(*) FROM ... WHERE ...) = ?`（bind 分頁收集到的筆數）改成 `(SELECT attachment_revision FROM ... WHERE id = ?) = ?`（bind 分頁開始前讀取到的計數器起始值），能正確偵測「附件集合內容變動」而非只看「數量沒變」。分頁邏輯本身（`collectProjectReadmeAttachmentIds()`/`collectTaskAttachmentIds()`）與既有錯誤碼（`PROJECT_ATTACHMENTS_CHANGED`/`TASK_ATTACHMENTS_CHANGED`，409）維持不變。
- （trigger 設計的直接後果）4 個會 mutate `project_readme_attachments`/`attachments` 的呼叫點——`uploadAttachment()`、`uploadProjectReadmeAttachment()`、`deleteAttachment()`（兩個分支）、以及 `deleteComment()` 透過 `attachments.comment_id ON DELETE CASCADE` 觸發的間接刪除——全部由 schema trigger 自動、正確地涵蓋，不需要對這幾個函式的程式碼做任何修改。
- 新增回歸測試，涵蓋「keyset pagination 收集完成後、`DELETE` 真正執行前的窗口內，發生一次刪除既有附件 + 一次新增全新附件」的 race 情境，驗證新附件不會被誤判為安全而導致 R2 物件孤兒化；測試需要確定性觸發這個窗口，不能依賴真實併發的時序運氣。

## Non-Goals

(design.md 會涵蓋 Goals/Non-Goals 與已排除的替代方案)

## Capabilities

### New Capabilities

- `attachment-deletion-consistency`：定義 `deleteProject()`/`deleteArchivedTask()` 刪除附件前的併發保護契約——系統必須能偵測「keyset pagination 收集完成後，附件集合內容（不只數量）是否發生任何變動」，並在偵測到變動時安全地拒絕刪除（可重試），而不是只比對數量、放行一個集合內容其實已經改變的刪除。

### Modified Capabilities

(none — repo 目前沒有既有 spec 描述這個刪除路徑的併發保護行為；dashi-taskboard-50m 那個修法本身也還沒合併進 integration/dashi-taskboard，不存在需要 delta 的既有 spec)

## Impact

- Affected specs: `attachment-deletion-consistency`（新增）
- Affected code:
  - New: `cloud/migrations/0012_attachment_revision_counters.sql`（暫定檔名，實際編號需在 apply 階段重新確認是否仍是下一個可用編號）
  - Modified: `cloud/src/index.mjs`（`deleteProject()`、`deleteArchivedTask()` 兩個函式的 guard 邏輯）
  - Modified: `test/cloud-shared-worker.test.mjs`（新增涵蓋 race 情境的回歸測試）
