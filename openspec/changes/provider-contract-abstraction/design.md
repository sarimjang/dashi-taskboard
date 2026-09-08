## Context

目前「一個 task/project 是不是 Jira 管理的」這件事，用字串比對 `source === "jira"` 決定，散落在五個檔案：`server/database.mjs`（`external_source` 欄位轉換為 `source` 欄位時做字面比對）、`server/app.mjs`（PATCH/DELETE/move/archive/restore task 路由中共 5 處，決定能否改指派人、能否改 projectId、能否手動歸檔/刪除/移動、是否需要呼叫 `jira.updateTask`/`jira.moveTask`/`jira.reconcile`）、`web/src/App.tsx`（`isJiraProject` 決定專案層級 UI 行為）、`web/src/components/TaskCard.tsx`/`IssueListView.tsx`/`TaskDetail.tsx`（決定欄位是否 disabled）。`server/jira-integration.mjs`（`createJiraIntegration`）目前是唯一的 provider 實作，透過 closure 回傳一組方法（如 `updateTask`/`moveTask`/`reconcile`），呼叫端直接假設「這組方法只可能是 Jira 這一種」。

這是 fork-plan.md change 3（對應 architect.md Phase 1），前置條件 change 1（loopback-security-baseline）與 change 2（retire-shared-board）皆已完成並併入 `integration/dashi-taskboard`。本 change 完成後仍不引入 Linear 或任何新 provider（那是 Phase 2，不在本輪），純粹是把現有唯一的 Jira provider 改成走顯式 contract。

## Goals / Non-Goals

**Goals:**

- 建立 `IssueProvider` 介面與 `ProviderCapabilities` 顯式宣告，取代所有 `source === "jira"` 字面比對。
- `server/jira-integration.mjs` 改為實作該介面，但 60 秒 refresh、手動同步、既有 JQL scope（`buildJiraJql`）、write behavior（`updateTask`/`moveTask`/`reconcile` 的既有語意）逐項不變。
- 新增一個假的 provider（測試用途，不對外曝露）不需要修改任何 UI 條件判斷即可宣告能力，驗證 contract 真的達到去耦合。

**Non-Goals:**

- 不新增 Linear 或任何真實的第二個 provider（architect.md Phase 2，另議）。
- 不改變 Jira 同步的任何既有行為、時序或 API 呼叫方式——這是重構，行為必須逐項不變。
- 不改變 `server/database.mjs` 的資料庫 schema（`external_source`/`external_id`/`external_origin`/`external_key`/`external_url` 欄位不變），只改變讀出後的映射邏輯。
- 不處理 RISK-011~016 或 architect-v2.md 的 Herdr Operations Portal 路線。
- 不引入新的建置工具、測試框架或格式化設定。

## Decisions

### 採用 architect.md 既定的 IssueProvider 介面形狀，不自行設計新介面

`docs/planning/architect.md` 的「Provider contract」章節已定義 `IssueProvider`（configure/status/listIssues/getIssue/createIssue/updateIssue/listStatuses/listLabels/listComments/reconcileIssue/reconcileSince）與 `ProviderCapabilities`（createIssue/updateAssignee/comments/attachments/relations/webhook/incrementalSync）。直接採用這組既定介面，不重新發明，理由：這是本專案目標架構文件已經過設計討論、供 Phase 2 Linear provider 未來直接沿用的介面，本 change 若另創一套會在 Phase 2 產生二次遷移成本。

> **§2 執行後校正（apply-executor pca-group2 發現，非阻斷，PM 已拍板）**：architect.md 只列出 `IssueProvider` 這 9 個新方法的名稱與回傳型別骨架，從未定義 `ProviderSyncQuery`/`ProviderIssuePage`/`ProviderIssue`/`ProviderIssueCreate`/`ProviderIssueChanges`/`ProviderScope`/`ProviderStatus`/`ProviderLabel`/`ProviderCommentPage`/`ProviderSyncResult`/`ProviderSyncCursor` 這些 payload 型別的欄位（repo 全域 grep 確認，PM 已獨立覆核零命中）。§2 實作決定：這 9 個方法先落地為明確標註「型別未定義、非隱藏行為」的 stub（拋出 `ApiError(501, "JIRA_PROVIDER_METHOD_UNSPECIFIED", ...)`），不臆造 payload 形狀；`registerProvider("jira", { capabilities })` 呼叫點放在 `jira-integration.mjs` 模組載入時（而非字面寫在 `provider-registry.mjs` 內部），理由是避免兩個模組互相 import 造成循環依賴與初始化順序耦合——`provider-registry.mjs` 維持零 I/O、零對特定 provider 的知識，各 provider 自行在載入時向 registry 登記，這與 §1 建立的 registry 職責邊界（純查表、不內建任何 provider 知識）一致。PM 已獨立驗證：diff 對 `server/jira-integration.mjs` 純新增（`git diff` 零刪除行），`SYNC_INTERVAL_MS`/`buildJiraJql`/`configure`/`status`/`sync`/`reconcile`/`updateTask`/`moveTask` 逐行核對未變動；`npm test` 384/383 pass/1 skip/0 fail、`npm run typecheck` 乾淨，皆為 PM 自行重跑而非採信 handoff 數字。**維持此實作，不要求 §2 返工**；11 個方法載荷型別的正式定義留待後續回合（若 architect.md 補齊型別定義時再實作），不在本 change 範圍內。

### 擴充 ProviderCapabilities 涵蓋 task-mutation 層級的能力位元

architect.md 原始的 `ProviderCapabilities` 是給「provider 本身」的能力宣告（如整個 provider 支不支援 comments）。但 `server/app.mjs` 現有的 5 處 `source === "jira"` 判斷，實際問的是更細的問題：這個 task 能不能改指派人、能不能改 projectId、能不能手動歸檔/刪除/移動。決定新增一組 task-mutation 能力位元（`manualArchive` / `manualDelete` / `manualMove` / `assigneeEdit` / `projectReassign`），做為 `ProviderCapabilities` 的擴充欄位，而非另開一個平行介面——理由：這些仍然是「provider 對這個 task 允許哪些操作」的宣告，語意上屬於同一個 capabilities 物件，只是比 architect.md 原稿更細顆粒。Jira provider 的這五項全部宣告為 `false`（比照現有行為：Jira task 不能被手動歸檔/刪除/移動、不能改指派人、不能改 projectId）。

### provider registry 用 `source` 字串做 key，registry 本身不對外暴露 `source` 字面比對

`server/database.mjs` 讀出的 `row.external_source`（資料庫既有欄位值，如 `"jira"`）當作 registry 的查表 key，不改變資料庫欄位本身的字面值（維持向後相容，change 2 已確立的 schema 不變原則）。新增 `server/provider-registry.mjs`，匯出 `getProviderCapabilities(source: string | null): ProviderCapabilities`（`source` 為 `null` 或未註冊值時回傳 local-only 的預設能力：全部 mutation 能力為 `true`，因為本機 task 什麼都能改）與 `getProvider(source: string): RegisteredProvider | null`（`RegisteredProvider` 為 `provider-registry.mjs` 自身 JSDoc 定義的型別，目前僅含 `capabilities` 欄位；本段先前誤寫為 `IssueProvider | null`，經 §2 獨立審查 pca-group2-review 發現此型別簽章與 §1 起的實際實作不符而訂正——純文件修正，非行為變更）。呼叫端（`app.mjs`/`database.mjs`/前端）一律透過這兩個函式查詢，不再自行字面比對。

> **§1 執行後校正（獨立審查 pca-group1-review 發現，非阻斷，PM 已拍板）**：本段文字「全部 mutation 能力為 `true`」逐字所指的是下段新增的 5 個 task-mutation 位元（`manualArchive`/`manualDelete`/`manualMove`/`assigneeEdit`/`projectReassign`），未明確規定 `webhook`/`incrementalSync`（provider 整體同步機制宣告）與 `comments`/`attachments`/`relations`（三值列舉）這 5 個欄位的 local 預設值。§1 實作採用「所有欄位一律取值域最大值」（9 個 boolean 皆 `true`、3 個列舉皆 `"read-write"`）作為合理外推，已獨立審查確認無反例、且本輪尚未有任何 consumer 讀取這些欄位（零行為影響半徑）。PM 決定：**維持此實作，作為本 change 對 local 預設值的正式定義**，不要求 §1 返工。§2/§3 的 apply-executor 開始消費這些欄位時，以此為準，不需重新拍板。

### 前端透過一個新的共用 API 欄位取得 capabilities，不在前端重建 registry

後端在回傳 task/project JSON 時新增 `capabilities: ProviderCapabilities` 欄位（透過 `getProviderCapabilities` 計算），前端元件（TaskCard/IssueListView/TaskDetail/App.tsx）改讀 `task.capabilities.assigneeEdit`/`task.capabilities.manualDelete` 等，取代 `task.source === "jira"`。理由：capabilities 的定義權應該在後端（provider registry 所在處），前端不應該重複維護一份「source 字串對應哪些能力」的邏輯，否則前後端會再度出現本次要移除的那種散落判斷。

## Implementation Contract

**行為（不變）**：Jira task 的既有限制邏輯 100% 保持——不能手動歸檔/刪除/移動/改指派人/改 projectId，PATCH 時仍會呼叫 `jira.updateTask`，move 時仍會呼叫 `jira.moveTask`，寫入失敗時仍會呼叫 `jira.reconcile` 並在失敗時回傳 `JIRA_RECONCILE_FAILED`。本機 task 的既有自由度 100% 保持。

**介面/資料形狀**：

- `server/provider-registry.mjs` 匯出 `getProviderCapabilities(source)` 與 `getProvider(source)`，兩者皆為同步函式（不做任何 I/O）。
- `ProviderCapabilities` 型別擴充 architect.md 原稿，新增 `manualArchive: boolean`、`manualDelete: boolean`、`manualMove: boolean`、`assigneeEdit: boolean`、`projectReassign: boolean` 五個欄位，與原稿的 `createIssue`/`updateAssignee`/`comments`/`attachments`/`relations`/`webhook`/`incrementalSync` 並列於同一物件。
- `server/jira-integration.mjs` 的 `createJiraIntegration` 回傳物件新增 `capabilities: ProviderCapabilities` 屬性（靜態值，不隨呼叫變動）。
- API 回應（`GET /api/tasks/:id`、task 列表、task.updated/created/moved 等事件 payload 中的 task 物件）新增 `capabilities` 欄位。

**驗收判準**：

1. 對 `server/database.mjs`、`server/app.mjs`、`web/src/App.tsx`、`web/src/components/TaskCard.tsx`、`web/src/components/IssueListView.tsx`、`web/src/components/TaskDetail.tsx` 全 repo grep `source === "jira"` 與 `source !== "jira"`，結果應為零筆（`server/database.mjs` 內部把資料庫欄位值轉換成 `source` 欄位本身的那一行映射邏輯除外，因為那是定義 `source` 的來源、不是消費端判斷）。
2. 新增一個測試專用的假 provider（不對外暴露路由或設定介面，僅供 `npm test` 內部驗證 registry 機制），將其註冊進 registry 並宣告與 Jira 不同的 capabilities 組合，驗證前端元件（或元件測試中模擬的資料）在收到該假 provider 的 task 資料時，UI disabled 狀態正確反映其 capabilities，且過程中不需要修改任何一個前端條件判斷式（只需要在測試資料的 capabilities 欄位帶入不同值）。
3. `npm test` 全綠，且既有涵蓋 Jira 同步行為的測試案例（`test/server.test.mjs` 等）逐項通過、斷言內容不變（除非斷言本身依賴的是即將移除的 `source === "jira"` 實作細節而非外部可觀察行為，此類斷言可以改寫，但改寫後驗證的可觀察行為必須與改寫前等價）。
4. `npm run typecheck`（若專案有此腳本）與 `npm run build:web` 乾淨。

**排除範圍**：不新增任何真實的第二個 provider、不變動資料庫 schema、不變動 `buildJiraJql`/`taskStatusFromJira`/`taskPriorityFromJira` 既有的資料轉換邏輯本身（這些函式維持原樣，只是被納入實作 `IssueProvider` 介面的物件內）。

> **§5 執行後校正 v2（pca-group5-review 獨立審查發現、PM 已核實並修正 v1 的兩個錯誤，`patch_required` → 立即修復，非延後至 §6）**：v1（apply-executor pca-group5 與 PM 原始判斷）正確指出 `web/src/App.tsx:1898` 與 `web/src/components/TaskDetail.tsx:1772` 這兩處字面 `source` 比對問的是「這個 task/project 的資料是否由外部 provider 管理／衍生」而非任何一個 capabilities 欄位、正確判斷不應新增第 13 個欄位、正確識別 `getProvider(source) !== null` 是語意正確的替代邏輯——但 v1 有兩個未被指出的錯誤，由 pca-group5-review 獨立驗證發現並經 PM 逐一覆核成立：(1) 兩處殘留**不是同一類缺口**——`App.tsx:1898` 是 `source !== "jira"`，只違反 design.md 本判準第 1 項（含 `!==`）的較嚴格版本，不影響 tasks.md 5.1 自身判準（5.1 只檢查 `===`）；但 `TaskDetail.tsx:1772` 是 `source === "jira"`，且 **tasks.md 5.2 本文逐字點名「`TaskDetail.tsx` 兩處（含 `onDeleteLabel` 三元判斷）」為本輪應轉換範圍**，其驗證文字明確要求「對這四個檔案 grep `source === "jira"` 結果為零」——這一筆屬於 5.2 自身判準內、非「design.md 較嚴格判準」那一類可暫緩的缺口，5.2 因此**尚未達成**。(2) `getProvider` 是 `server/provider-registry.mjs` 匯出的 **server-only** 函式，前端 `web/src/` 沒有、也不能直接 import server 端模組（`web/tsconfig.json` include 僅 `src`，`web/src` 內零筆 `from .*server/` import）——v1 annotation「沿用 `getProvider(source) !== null`...見 `server/app.mjs` 的 PATCH 路由」字面上暗示前端可直接呼叫同一個函式，這不成立。**修正後的正確修法**：在 `server/database.mjs` 的 `taskFromRow`/`projectFromRow` 新增一個布林 API 欄位 `isProviderManaged`（緊鄰既有 `capabilities: getProviderCapabilities(source)`，以 `getProvider(source) !== null` 計算，需額外 `import { getProvider } from "./provider-registry.mjs"`），`web/src/types.ts` 的 `Task`/`Project` 介面同步新增此欄位，`App.tsx:1898` 改讀 `!project.isProviderManaged`、`TaskDetail.tsx:1772` 改讀 `currentTask.isProviderManaged`。此修法同時解決 design.md 判準第 1 項的 `!==` 缺口（`App.tsx:1898`）與 tasks.md 5.2 自身的 `===` 缺口（`TaskDetail.tsx:1772`）。因為需要重新觸碰 `server/database.mjs`（§3 已完成的檔案）並新增 API 欄位，範圍大於「前端兩行替換」，**改為立即執行獨立的修復輪（`pca-group5-repair`），不併入 §6**——§6 屆時只需重新確認全 repo 掃描為零筆（收尾驗證，不含新實作）。

## Risks / Trade-offs

[新增的 `capabilities` API 欄位可能被前端某處遺漏未讀取，導致該處 UI 判斷邏輯未被替換乾淨] → 全 repo grep `source === "jira"`/`source !== "jira"` 作為驗收判準第 1 項，不依賴人工逐一檢查。

[`server/app.mjs` 的 5 處判斷分別對應不同的操作語意（歸檔/刪除/移動/改指派人/改 projectId），若用單一 capabilities 欄位籠統取代可能遺漏語意差異] → 設計為 5 個獨立布林欄位（`manualArchive`/`manualDelete`/`manualMove`/`assigneeEdit`/`projectReassign`）而非單一「isExternal」旗標，逐一對應現有 5 處判斷的語意。

[Jira provider 的 `capabilities` 若寫死在程式碼中，未來 Phase 2 若 Jira 本身開放更多操作權限需要修改常數位置不明確] → capabilities 定義於 `createJiraIntegration` 回傳物件的頂層屬性，與其他 provider 方法並列，位置單一明確。

## Migration Plan

分階段實作，每階段可獨立驗證：

1. 新增 `server/provider-registry.mjs` 與擴充後的 `ProviderCapabilities` 型別/JSDoc 定義，此階段不改動任何既有呼叫端，`npm test` 應仍全綠（純新增，無行為改變）。
2. `server/jira-integration.mjs` 的 `createJiraIntegration` 回傳物件新增 `capabilities` 屬性，`server/database.mjs` 新增透過 registry 查詢 capabilities 並附加到 task/project 回傳物件的邏輯，但先不移除既有的 `source === "jira"` 判斷（新舊並存），驗證新欄位輸出正確。
3. 逐一將 `server/app.mjs` 的 5 處判斷、`web/src/App.tsx` 的 `isJiraProject`、三個前端元件的 disabled 判斷改為讀取 `capabilities`，每改一處立即跑對應測試，改完全部後執行驗收判準第 1 項的全 repo grep 確認零殘留。
4. 新增假 provider 測試（驗收判準第 2 項），確認去耦合成立。

無需 rollback 特殊設計——每個階段都是可獨立回退的程式碼變更（git revert 單一 commit），不涉及資料庫 migration 或外部狀態變更。

## Open Questions

- `server/provider-registry.mjs` 是否需要支援執行期動態註冊（例如測試案例動態插入假 provider），或是否用編譯期／模組載入期靜態註冊即可——留給實作階段依測試需求決定，不影響本設計的介面形狀。
- API 回應新增 `capabilities` 欄位是否會被現有前端型別定義（TypeScript interface）視為未預期欄位而需要同步更新型別——留給實作階段依 `npm run typecheck` 實際結果處理。
