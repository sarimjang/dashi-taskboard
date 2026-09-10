## Context

`work/50m` 分支（commit `783befa`，尚未合併進 `integration/dashi-taskboard`）把 `deleteProject()`/`deleteArchivedTask()` 改成「先用 keyset pagination（`collectProjectReadmeAttachmentIds()`/`collectTaskAttachmentIds()`，`WHERE id > ? ORDER BY id LIMIT ATTACHMENT_DELETE_PAGE_SIZE` 迴圈到底）撈完整附件 id 清單，再執行單一 `DELETE`，`DELETE` 的 `WHERE` 子句用 `(SELECT COUNT(*) FROM ... WHERE ...) = ?`（bind 分頁收集到的筆數）做原子性數量檢查」。這個修法把原本 `env.DB.batch([SELECT, DELETE])` 的單一 implicit transaction拆成「多輪分頁 + 一次 DELETE」，中間打開一個外部請求可以插入的窗口。count-based guard 只比對「數量」，無法偵測「窗口內剛好一增一減、淨數量不變」的組合——獨立 reviewer（`bd50m-review-h1.md` 發現 1）已經用 sqlite3 CLI 等效方式重建並確認這個場景真實可觸發：併發 `DELETE /api/attachments/:id`（刪掉分頁收集到的其中一筆）+ 併發 `POST /api/projects/:id/readme/attachments`（上傳一筆全新的、從未被分頁收集到的附件），兩者發生順序不拘，只要都在 `DELETE FROM projects`/`DELETE FROM tasks` 執行前完成，COUNT 讀回的值與分頁收集到的數量完全相同，guard 誤判通過，新附件的 D1 metadata 列被 `ON DELETE CASCADE` 清空，其 R2 物件永久孤兒化。

user 已核准的修法方向：比照這個 repo `tasks`/`comments` 表既有的 `version` 欄位樂觀鎖 pattern（`assertTaskVersion`/`assertCommentVersion`），幫每個附件擁有者（`projects`、`tasks`）各自維護一個單調遞增的「附件變更計數器」，`DELETE` guard 改成比對計數器版本而非數量。`tasks.version` 不能直接重用——它是任務本身欄位（title/status 等）的樂觀鎖，跟附件變更是不同語意，混用會讓不相關的任務編輯在窗口內誤觸發附件 guard 的假性衝突。

這個 repo 已經有一組成熟、大量重複使用的「變更計數器由 SQL trigger 自動維護」慣例：`global_revision` 表搭配 10 組以上的 `*_revision_insert`/`*_revision_update`/`*_revision_delete` trigger（`cloud/migrations/0001_initial.sql`、`0004_task_activities.sql`、`0010_project_readme_attachments.sql`、`0011_comments_task_updated.sql`），每個會影響回應內容的表都有對應 trigger 在 INSERT/UPDATE/DELETE 時把全域 revision 計數器 +1，呼叫端完全不需要記得手動遞增。

本 change 用 sqlite3 CLI（非 D1，但語法與觸發器語意相容，D1 是 SQLite 的受管服務）獨立建了三個最小重現實驗，驗證以下三件事都成立：(1) 用 `AFTER INSERT`/`AFTER DELETE` trigger 監聽 `project_readme_attachments` 表本身的 INSERT/DELETE 來遞增 `projects.attachment_revision`，在「刪一個既有附件 + 新增一個全新附件」的 race 場景下，count 讀回是 2（與分頁收集到的數量相同，舊 guard 會誤判通過），但 `attachment_revision` 讀回是 4（從 revisionAtStart=2 移動了，新 guard 正確判定為「有變動」並讓 `DELETE` 變成 no-op）；(2) 同一組 trigger 在 `DELETE FROM projects`（cascade 刪除其名下 `project_readme_attachments` 列）這個情境下不會出錯，trigger 對即將被刪除的擁有者列做 `UPDATE ... WHERE id = ?` 是安全的 0-row no-op（cascade 執行時擁有者列已經不存在），不影響 `DELETE FROM projects` 本身的 `changed()` 判斷（該判斷在 `DELETE` 執行前已經用 `WHERE` 子句的子查詢鎖定了要不要刪，不受 cascade 後續 trigger 影響）；(3) `attachments` 表的 `AFTER DELETE` trigger 完全不需要對 `deleteComment()` 做任何程式碼修改，就能正確涵蓋 `deleteComment()` 透過 `attachments.comment_id ON DELETE CASCADE REFERENCES comments(id)` 觸發的間接附件刪除——因為 `attachments.task_id` 在 schema 上是 `NOT NULL`（`cloud/migrations/0001_initial.sql`），不管附件是掛在 task 本身還是掛在該 task 下某個 comment 底下，`task_id` 永遠指向正確的擁有者 task，trigger 用 `OLD.task_id` 一定能找到正確的 `tasks` 列去遞增。

全 repo grep `INSERT INTO attachments|DELETE FROM attachments|INSERT INTO project_readme_attachments|DELETE FROM project_readme_attachments`（`cloud/src/index.mjs`，本 worktree 尚未合併 50m 前的 HEAD）只找到 4 個直接呼叫點：`uploadAttachment()`（INSERT，L3095-3109）、`uploadProjectReadmeAttachment()`（INSERT，L3134-3145）、`deleteAttachment()` 的兩個分支（`DELETE FROM project_readme_attachments`/`DELETE FROM attachments`，L3169-3173）。額外確認 `updateComment()`（L2982-3017）只 UPDATE `comments` 表本身的欄位，不涉及任何附件表的 INSERT/DELETE，不需要遞增邏輯。`deleteComment()`（L3019-3036）目前完全依賴 `ON DELETE CASCADE` 清空附件列，沒有任何顯式 `DELETE FROM attachments` 陳述式。也確認目前沒有任何 `UPDATE attachments`/`UPDATE project_readme_attachments` 陳述式（grep 0 筆），所以不需要 `AFTER UPDATE` trigger。

另有 `dashi-taskboard-3dq`（change: `task-hydration-row-caps`，`spectra/task-hydration-row-caps` 分支，尚未 apply）的既有 propose 也計畫修改 `deleteComment()`——但它的範圍是把觸發 R2 delete 的單一 `Promise.all` 改成有界並發＋容錯（`attachmentsForComment()` 讀取邏輯本身、以及 `DELETE FROM comments` 陳述式都不在它的修改範圍內）。本 change 完全不修改 `deleteComment()` 的任何程式碼（trigger 設計的直接好處），兩個 change 在 `deleteComment()` 上的修改面（一個動 R2 delete 並發策略、一個完全不動）没有重疊，但兩者都會修改 `cloud/src/index.mjs` 中彼此鄰近的函式，apply 順序需要留意（見 Risks/Trade-offs）。

## Goals / Non-Goals

**Goals:**

- 讓 `deleteProject()`/`deleteArchivedTask()` 的刪除前 guard 能正確偵測「keyset pagination 收集完成後，附件集合內容（不只數量）是否發生任何變動」，堵住 count-based guard「一增一減、淨值不變」的盲點。
- 遞增邏輯要涵蓋現在**與未來**所有會 mutate `project_readme_attachments`/`attachments` 的路徑，不依賴逐一記得在每個呼叫點手寫遞增陳述式——這正是這次要修的 bug 之所以存在的同一類風險（50m 自己在 `env.DB.batch()` 的 Fix-then-Audit 掃描很仔細，但下一個新增的附件 mutation 呼叫點仍然可能被遺漏)。
- 沿用這個 repo 已經確立的 `global_revision` trigger 慣例，不發明新的抽象機制。
- 新增回歸測試要能確定性觸發「窗口內刪一增一」的 race，不能只靠程式碼審查與推導論證（`50m-apply-h1.md` 自己承認這一段沒有測試覆蓋）。
- 保持 `collectProjectReadmeAttachmentIds()`/`collectTaskAttachmentIds()` 的分頁邏輯與既有錯誤碼（`PROJECT_ATTACHMENTS_CHANGED`/`TASK_ATTACHMENTS_CHANGED`）不變，讓這次修改是 `work/50m`（`783befa`）之上的增量修改，不是重寫。

**Non-Goals:**

- 不重新討論「要不要做 schema migration」——user 已核准樂觀鎖版本計數器方向，這是既定前提。
- 不採用把完整 id 清單塞進 `DELETE` 的 `WHERE ... NOT IN (...)` 子句的方案——已由 PM 排除：`dashi-taskboard-zbb` change 已經因為 D1 bind-parameter 上限建立 chunk size 40/80 的先例（`RELATED_BATCH_CHUNK_SIZE`，`cloud/src/index.mjs` 約 L1244），附件數量大的 project/task（50m 自己的回歸測試用了 237 筆附件的 fixture）會撞上這個限制而不可行。
- 不修改 `deleteComment()` 的任何程式碼——trigger 設計自動涵蓋它的間接 CASCADE 路徑，不需要顯式 `DELETE FROM attachments` 陳述式或程式碼層級的遞增呼叫。
- 不修改 `deleteComment()` 觸發 R2 delete 的 `Promise.all` 並發策略／容錯行為——這是 `dashi-taskboard-3dq`（`task-hydration-row-caps`）已經規劃、尚未 apply 的範圍，不在本 change 重複處理。
- 不改動 `collectProjectReadmeAttachmentIds()`/`collectTaskAttachmentIds()` 的分頁邏輯本身——已通過獨立審查認可，本 change 只改「guard 比對什麼」與「補上計數器遞增機制」。

## Decisions

### 用 schema-level AFTER INSERT/DELETE trigger 遞增計數器，不是在每個 JS mutation 呼叫點手動加 UPDATE 陳述式

新增 `projects.attachment_revision INTEGER NOT NULL DEFAULT 0`、`tasks.attachment_revision INTEGER NOT NULL DEFAULT 0` 兩個欄位。遞增邏輯用 4 個 trigger 實作，掛在附件表本身而非擁有者表：

- `AFTER INSERT ON project_readme_attachments` / `AFTER DELETE ON project_readme_attachments`：各自執行 `UPDATE projects SET attachment_revision = attachment_revision + 1 WHERE id = NEW.project_id`（insert 用 `NEW`）/ `... WHERE id = OLD.project_id`（delete 用 `OLD`）。
- `AFTER INSERT ON attachments` / `AFTER DELETE ON attachments`：同理，`UPDATE tasks SET attachment_revision = attachment_revision + 1 WHERE id = NEW.task_id` / `... WHERE id = OLD.task_id`。

這個設計已經在 Context 一節用 sqlite3 CLI 獨立驗證：(1) 一增一減 race 場景下計數器正確移動、guard 正確拒絕；(2) cascade 刪除擁有者本身時 trigger 是安全的 no-op；(3) `deleteComment()` 的間接 CASCADE 附件刪除不需要任何程式碼修改就會被正確涵蓋。

備選方案（review doc `bd50m-review-h1.md` 建議修法方向 1 原始描述的做法）：在 `uploadAttachment()`/`uploadProjectReadmeAttachment()`/`deleteAttachment()` 這幾個 JS 函式裡，各自手動加一行 `UPDATE ... SET attachment_revision = attachment_revision + 1` 陳述式，與原本的 INSERT/DELETE 放進同一個 `env.DB.batch()`。**被拒絕**，理由：(a) 完全無法自動涵蓋 `deleteComment()` 的間接 CASCADE 路徑——需要額外把 `deleteComment()` 改成不依賴 CASCADE、改成顯式 `DELETE FROM attachments WHERE comment_id = ?` + 手動遞增，且要正確處理「comment 版本檢查失敗時整批 batch 都不該生效」的原子性問題（三個陳述式互相依賴同一個版本檢查結果，需要用 `NOT EXISTS` 子查詢串接，複雜度明顯更高）；(b) 即使做了 (a)，仍然只涵蓋「現在已知」的呼叫點，任何未來新增的附件 mutation 函式若忘記手動加遞增陳述式，guard 就形同虛設——這正是這次要修的 bug 的同一種風險模式（漏掉某個呼叫點）；trigger 綁在 schema 層，任何未來新增的 mutation 陳述式只要是走 `INSERT INTO attachments`/`DELETE FROM attachments`（或 `project_readme_attachments`），一律自動被涵蓋，不需要呼叫端記得任何事。(c) 與這個 repo 已經確立的 `global_revision` trigger 慣例完全一致，不是發明新抽象，是重用既有 pattern（決策優先序裡的 Consistency）。

### `deleteProject()`/`deleteArchivedTask()` 讀取 revisionAtStart 的方式不同，源自既有程式碼結構的差異

`deleteProject()` 開頭呼叫的 `getProject(env, id)` 是一個 `GROUP BY` 過的公開欄位子集查詢（`projects.id`/`name`/`workspace_path`/`labels`/`created_at`/`updated_at`/`issue_count`），刻意不包含內部欄位，也是直接餵給 client 回應的形狀——不適合為了內部 guard 用途去污染它的 SELECT 清單。因此 `deleteProject()` 需要新增一個小型專用查詢：`SELECT attachment_revision FROM projects WHERE id = ?`，插在 `collectProjectReadmeAttachmentIds()` 呼叫之前。

`deleteArchivedTask()` 開頭呼叫的 `requireTaskRow(env, id)` 則是 `SELECT * FROM tasks WHERE ...`（內部原始列，`assertTaskVersion()` 直接讀它的 `row.version`），一旦 migration 加上 `attachment_revision` 欄位，這個既有呼叫回傳的 `current` 物件就會自動帶有 `current.attachment_revision`，不需要任何新查詢——這是既有程式碼結構剛好對齊的巧合，不是刻意設計，但值得在這裡記錄，避免 apply 階段的實作者誤以為兩個函式需要對稱的新查詢。

### guard SQL 改寫：比對計數器版本，維持既有錯誤碼與 API 形狀

`deleteProject()` 的 `DELETE` guard 從

```
DELETE FROM projects
WHERE id = ?
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = ?)
  AND (SELECT COUNT(*) FROM project_readme_attachments WHERE project_id = ?) = ?
```

改成

```
DELETE FROM projects
WHERE id = ?
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = ?)
  AND (SELECT attachment_revision FROM projects WHERE id = ?) = ?
```

（最後一個 `?` 改 bind `revisionAtStart` 而非 `attachmentIds.length`）。`deleteArchivedTask()` 同理，`(SELECT COUNT(*) FROM attachments WHERE task_id = ?) = ?` 改成 `(SELECT attachment_revision FROM tasks WHERE id = ?) = ?`。兩者的 `changed(result)` 判斷邏輯、既有 409 錯誤碼（`PROJECT_ATTACHMENTS_CHANGED`/`TASK_ATTACHMENTS_CHANGED`）、錯誤訊息文字都維持不變——這是刻意的：guard 觸發的**時機**變得更精確（現在會正確攔截「淨值不變」的 race），但 guard 觸發後**回應給 client 的形狀**完全不變，client 端既有的重試邏輯不需要跟著改。

### 回歸測試：用 Miniflare service binding 作為確定性的 race 注入點，需要 apply 階段先做可行性驗證

「窗口內刪一增一」這個 race 的本質，是在 `deleteProject()`/`deleteArchivedTask()` 自己的執行過程中——讀 revisionAtStart 之後、guard `DELETE` 執行之前——插入一次外部併發 mutation。這個窗口只存在於**單一函式呼叫內部**的兩個 await 之間，光靠測試從外部發真實併發 HTTP 請求（`Promise.all([...])`）沒有時序保證，無法確定性命中這個窗口。

設計：在 `deleteProject()`/`deleteArchivedTask()` 內，`collectProjectReadmeAttachmentIds()`/`collectTaskAttachmentIds()` 分頁收集完成之後、guard `DELETE` 執行之前，各自加一行：

```
if (env.RACE_TEST_HOOK) {
  await env.RACE_TEST_HOOK.fetch("http://race-test-hook/after-collect");
}
```

`RACE_TEST_HOOK` 只在 `test/helpers/cloud-worker-harness.mjs` 的測試專用 Miniflare 設定裡，透過 `serviceBindings` 宣告成一個純 Node process 內執行的 function handler（Miniflare 支援把 `(request) => Response` 形式的 JS function 直接當作 service binding，在同一個 Node process 執行，不像 `env.DB`/`env.ATTACHMENTS` 需要跨 workerd isolate 邊界）；`wrangler.jsonc`（正式部署設定）完全不宣告這個 binding。這代表正式環境的 `env.RACE_TEST_HOOK` 永遠是 `undefined`，`if (env.RACE_TEST_HOOK)` 恆假，這一行在生產路徑上零開銷、零行為變化。測試在這個 hook 被呼叫時，同步執行「刪除一個既有附件（呼叫真正的 `DELETE /api/attachments/:id`）+ 上傳一個全新附件（呼叫真正的 `POST .../readme/attachments` 或 `POST .../attachments`）」，讓 hook 的 promise resolve 後，`deleteProject()`/`deleteArchivedTask()` 才繼續往下執行 guard `DELETE`；斷言最終回應是 409（`PROJECT_ATTACHMENTS_CHANGED`/`TASK_ATTACHMENTS_CHANGED`），且新上傳那個附件的 D1 row 與 R2 物件都還在（未被誤刪、未孤兒化）。

這個設計目前**未經本 worktree 實測驗證**——`node_modules/miniflare` 在這個 worktree沒有安裝（跟 `node_modules/wrangler` 缺失是同一個已知環境缺口，`cwe400-sweep`/`50m` 系列的多份 handoff 都提過），無法在 propose 階段跑一次最小可行性驗證。tasks.md 因此把這個驗證排在第一組任務，比照 `task-hydration-row-caps`（3dq）change 對「視窗函式相容性」的既有處理方式：先驗證，若 `serviceBindings` 的 function handler 形式與這個 repo 實際 pin 的 Miniflare 版本（`^4.20260722.0`）不相容，退回較弱的備選測試設計——不透過真實 HTTP 端點觸發，改成一個明確標示為「white-box」的獨立測試，直接對 `cloud.db`（測試 harness 既有的 D1 直接存取介面）依序執行「讀 revisionAtStart → 模擬併發的一增一刪 → 執行與 `deleteProject()`/`deleteArchivedTask()` 完全相同文字的 guard `DELETE` 陳述式」，驗證 guard SQL 本身在這個 race 下的行為（這個備選方案的已知弱點：它不是透過真正呼叫 `deleteProject()`/`deleteArchivedTask()` 觸發，如果未來有人修改這兩個函式卻忘記同步更新這個測試裡複製的 SQL 文字，測試不會抓到，需要在任務完成說明中明確記錄這是已知的較弱防護）。退回時必須在對應任務的完成說明中留下紀錄，不能悄悄退回不留痕跡。

備選方案：完全不嘗試 hook 機制，一開始就用備選的 white-box SQL 測試——被拒絕，因為 white-box 測試無法驗證 `deleteProject()`/`deleteArchivedTask()` 自己的程式碼真的在正確的時機讀取 revisionAtStart、真的用正確的參數呼叫 guard（例如漏讀 revisionAtStart、或 bind 錯參數這類實作疏失，white-box 測試因為是獨立複製的 SQL 文字，不會被真實呼叫路徑的疏失影響，等於測試自己而非測試實作），保真度明顯較低；應該先嘗試更高保真度的方案，備選方案只在技術不可行時才退回。

### 回滾方案

`ALTER TABLE ... ADD COLUMN ... DEFAULT 0` 對既有列是安全的 metadata-only 操作——SQLite／D1 對「新增欄位帶常數 DEFAULT」不需要逐列重寫或額外 backfill script，所有既有 `projects`/`tasks` 列會自動取得 `attachment_revision = 0`。

若需要完整回退（撤銷 schema 變更本身），這個 repo 已有直接先例：`cloud/migrations/0009_remove_workflow_schema.sql` 示範了同一種回退寫法（`DROP TRIGGER` x3 + `DROP TABLE` + `ALTER TABLE tasks DROP COLUMN workflow_id`），證實 D1 支援 `ALTER TABLE ... DROP COLUMN`。完整回退可以寫一個新的 forward migration：`DROP TRIGGER` x4（本 change 新增的 4 個 trigger）+ `ALTER TABLE projects DROP COLUMN attachment_revision` + `ALTER TABLE tasks DROP COLUMN attachment_revision`。

更保守、成本更低的部分回退：只還原 `cloud/src/index.mjs` 的 guard 邏輯（改回 `783befa` 的 count-based guard，或維持不修），保留 schema 變更不動——trigger 與欄位會變成未使用但完全無害的死重量（沒有任何程式碼讀取它們，遞增本身的 `UPDATE` 陳述式成本可忽略），不需要額外的資料修復步驟。除非有明確理由要徹底清乾淨 schema，這是風險最低的回退選項。

## Implementation Contract

**行為（Behavior）：** `DELETE /api/projects/:id`（manually-created project 且無殘留 task）與 `DELETE /api/tasks/:id`（已封存的 task）在正常、無併發的路徑下行為與 `783befa` 完全一致（撈完整附件 id 清單、刪除、清 R2）。當分頁收集完成到 `DELETE` 執行之間，該 project/task 名下的附件集合發生任何變動（不論是純新增、純刪除，或一增一減淨值不變的組合）時，`DELETE` 一律變成 no-op，回應 409（`PROJECT_ATTACHMENTS_CHANGED`/`TASK_ATTACHMENTS_CHANGED`），呼叫端可安全重試；這個判定範圍比 `783befa` 更廣（`783befa` 只能偵測到純新增/純刪除，偵測不到一增一減）。

**介面／資料形狀（Interface）：** `projects`、`tasks` 兩張表各自新增 `attachment_revision INTEGER NOT NULL DEFAULT 0` 欄位（內部欄位，不進入任何既有 `projectFromRow()`/公開 API 回應形狀）。4 個新 trigger：`project_readme_attachments_bump_revision_insert`/`_delete`（掛在 `project_readme_attachments`）、`attachments_bump_revision_insert`/`_delete`（掛在 `attachments`）。`deleteProject()`/`deleteArchivedTask()` 的 `DELETE` 陳述式改為比對 `attachment_revision`；既有 409 錯誤碼、訊息文字、`changed()` 之後的 fallback 檢查順序（先查 `issueCount`/`archived_at`，再判定是附件變動）全部維持不變。

**失敗模式（Failure modes）：** 與 `783befa` 相同的兩個 409 錯誤碼，觸發條件更精確（見上）。若 migration 的 4 個 trigger 因為某個尚未預期的併發寫入路徑漏掉遞增（理論上不應該發生，因為 trigger 綁在表層級、涵蓋所有 INSERT/DELETE），guard 會退化回原本 count-based guard 的行為（仍然是既有已知風險，不是本 change 引入的新風險）——這個退化情境無法被本 change 的測試直接證明「不存在」，只能證明「已知的 4 個呼叫點都正確」；Scope boundaries 一節說明為何這已經是可接受的完整性等級。

**驗收條件（Acceptance criteria）：** `test/cloud-shared-worker.test.mjs` 新增至少兩個回歸測試（`deleteProject()`/`deleteArchivedTask()` 各一），涵蓋「keyset pagination 收集完成後、`DELETE` 執行前，發生一次刪除既有附件 + 一次新增全新附件、淨值不變」的情境，斷言：(a) 回應狀態碼為 409，對應錯誤碼正確；(b) 新上傳的那個附件的 D1 metadata 列仍然存在；(c) 新上傳的那個附件的 R2 物件仍然存在（未被誤刪）。既有 50m 的分頁測試（跨兩頁、237 筆附件的無孤兒驗證）與既有全套 `npm test`/`npm run test:cloud` 維持綠燈。全 repo grep 確認 `uploadAttachment()`/`uploadProjectReadmeAttachment()`/`deleteAttachment()`/`deleteComment()` 沒有任何一個因為本 change 的修改而需要程式碼變動（trigger 設計的正確性驗證方式之一：這幾個函式的 diff 應該是空的）。

**範圍邊界（Scope boundaries）：** 範圍內：新 migration（欄位 + trigger）、`deleteProject()`/`deleteArchivedTask()` 的 guard 改寫、對應回歸測試。範圍外：`collectProjectReadmeAttachmentIds()`/`collectTaskAttachmentIds()` 分頁邏輯本身、`deleteComment()` 的任何程式碼（包含 `dashi-taskboard-3dq` 規劃中的 R2 delete 並發策略修改）、`uploadAttachment()`/`uploadProjectReadmeAttachment()`/`deleteAttachment()` 的程式碼（trigger 設計下這幾個函式不需要變動）、`NOT IN` id 清單方案（已排除）。

## Risks / Trade-offs

- [風險] trigger 遞增的時機與擁有者同時被刪除的 cascade 順序，只在 sqlite3 CLI 的最小重現實驗中驗證過，未在真實 D1/workerd 環境下驗證 → [緩解] D1 是受管的 SQLite 服務，trigger／cascade 語意預期一致；這個 repo 已經有 10 組以上結構相同的 `global_revision` trigger 在正式環境穩定運作多個 migration 版本，屬於已驗證過的既有模式，非全新未知行為；tasks.md 仍要求在 apply 階段用 miniflare 測試環境（真實 workerd D1 綁定）重新驗證一次，不完全依賴這次 propose 階段的 sqlite3 CLI 結果。
- [風險] `RACE_TEST_HOOK` 的 Miniflare `serviceBindings` function-handler 機制在 propose 階段沒有實測（`node_modules/miniflare` 未安裝於本 worktree）→ [緩解] design 已明訂驗證優先、備選方案明確（見 Decisions），且已知風險僅限於「測試覆蓋的保真度」，不影響 guard 本身的正確性（guard SQL 已用 sqlite3 CLI 獨立驗證）。
- [風險] `dashi-taskboard-3dq`（`task-hydration-row-caps`）也計畫修改 `deleteComment()`，兩個 change 若接近時間 apply，可能在 `cloud/src/index.mjs` 產生鄰近但不重疊的合併衝突（本 change 完全不改 `deleteComment()` 本身的程式碼，只是 migration 新增的 trigger 會在 `deleteComment()` 現有的 `DELETE FROM comments` cascade 執行時自動生效）→ [緩解] 兩者修改面在函式層級沒有重疊（本 change 動 `deleteProject()`/`deleteArchivedTask()` 與 migration；3dq 動 `deleteComment()` 的 R2 delete 並發邏輯），衝突風險僅限於檔案層級的 diff context 接近，屬於一般合併作業可處理的範圍，非本設計需要解決的架構問題；記錄於此供 apply 階段排序參考。
- [風險] 遞增邏輯完全依賴「schema trigger 涵蓋所有 mutation 路徑」這個假設；若未來有人繞過 `attachments`/`project_readme_attachments` 表本身、透過其他機制間接影響附件存在性（目前 repo 內沒有這種路徑，已用全 repo grep 確認），guard 會悄悄退化回舊行為而不會有任何錯誤提示 → [緩解] 這個假設的正確性由「trigger 綁在表層級」這個資料庫層機制本身保證，任何未來新增的 `INSERT`/`DELETE` 陳述式只要是對這兩張表操作，一律自動被涵蓋；比「靠人記得在每個呼叫點手動加遞增」的替代方案的失效模式更難踩中（需要繞過表本身而非忘記加一行程式碼）。

## Migration Plan

1. 新增 `cloud/migrations/0012_attachment_revision_counters.sql`（暫定檔名——apply 階段需先確認 `0012` 是否仍是下一個可用編號；這個 repo 的 migration 慣例允許同一數字前綴有多個檔案並存、依完整檔名字串排序套用，見既有的 `0009_project_readmes.sql`/`0009_remove_workflow_schema.sql`、`0010_project_readme_attachments.sql`/`0010_task_relation_origin.sql`，所以編號衝突風險低，但仍需重新確認）：兩個 `ALTER TABLE ... ADD COLUMN ... DEFAULT 0` + 四個 `CREATE TRIGGER`。
2. `cloud/src/index.mjs`：在 `work/50m`（`783befa`）的基礎上，修改 `deleteProject()`/`deleteArchivedTask()` 的 guard 邏輯（見 Decisions）。
3. `test/cloud-shared-worker.test.mjs`：新增 race 情境回歸測試；若 `RACE_TEST_HOOK` 機制驗證可行，同時需要修改 `test/helpers/cloud-worker-harness.mjs` 加上 `serviceBindings` 設定。
4. 部署順序沒有相依性限制——migration 是純新增（不修改既有欄位語意），可以與程式碼變更一起原子性部署；沒有「舊程式碼＋新 schema」或「新程式碼＋舊 schema」的相容性問題，因為新欄位在程式碼讀到它之前完全不影響既有查詢的行為。
5. Rollback 策略：見 Decisions 「回滾方案」一節——優先選擇「只還原程式碼、保留 schema」的低成本選項，除非有明確理由需要徹底清除 schema。

## Open Questions

- `serviceBindings` function-handler 在這個 repo pin 的 Miniflare 版本（`^4.20260722.0`）下是否真的能達成設計描述的同步、確定性 race 注入——交由 apply 階段第一組任務的可行性驗證決定，不在本設計文件預先假設答案（若不可行，退回 white-box SQL 測試備選方案）。
- migration 檔名的實際編號（`0012` 或更新的下一個可用編號）——交由 apply 階段開工前重新確認。
- 本 change 與 `dashi-taskboard-3dq`（`task-hydration-row-caps`）的 apply 順序是否需要協調——目前判斷不需要（修改面在函式層級不重疊，見 Risks/Trade-offs），但最終順序由 PM／orchestrator 決定，不在本設計文件範圍內。
