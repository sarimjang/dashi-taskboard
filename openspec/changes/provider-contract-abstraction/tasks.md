## 1. Provider registry 骨架（新增，不改動既有呼叫端）

- [ ] 1.1 新增 `server/provider-registry.mjs`，匯出 `getProviderCapabilities(source)`（source 為 `null`/未註冊值時回傳 local 預設能力，全部 mutation 欄位為 `true`）與 `getProvider(source)`（未註冊時回傳 `null`）——落實設計決策「provider registry 用 `source` 字串做 key，registry 本身不對外暴露 `source` 字面比對」，實現規格要求「Provider capabilities SHALL be explicitly declared, not inferred from source string comparison」。驗證：新增單元測試涵蓋「已註冊 source」「未註冊 source」「null source」三種輸入各自的回傳值。
- [ ] 1.2 定義擴充後的 `ProviderCapabilities` 型別/JSDoc（`createIssue`/`updateAssignee`/`comments`/`attachments`/`relations`/`webhook`/`incrementalSync`/`manualArchive`/`manualDelete`/`manualMove`/`assigneeEdit`/`projectReassign` 十二個欄位）——落實設計決策「擴充 ProviderCapabilities 涵蓋 task-mutation 層級的能力位元」。驗證：`npm run typecheck`（若存在）乾淨，或以型別測試/JSDoc 型別檢查工具確認欄位齊全。
- [ ] 1.3 [P] 執行 `npm test`，確認新增模組不影響既有測試（純新增，此階段 `npm test` 結果應與變更前完全一致）。

## 2. Jira provider 實作 IssueProvider 介面（新舊並存）

- [ ] 2.1 `server/jira-integration.mjs` 的 `createJiraIntegration` 回傳物件改為實作 architect.md 既定的 `IssueProvider` 介面形狀（configure/status/listIssues/getIssue/createIssue/updateIssue/listStatuses/listLabels/listComments/reconcileIssue/reconcileSince）並新增 `capabilities` 屬性——落實設計決策「採用 architect.md 既定的 IssueProvider 介面形狀，不自行設計新介面」，實現規格要求「Jira provider SHALL implement the IssueProvider interface while preserving existing behavior」。`capabilities` 值為靜態 `ProviderCapabilities`（Jira 的 `manualArchive`/`manualDelete`/`manualMove`/`assigneeEdit`/`projectReassign` 全部為 `false`，其餘欄位依 Jira 實際能力宣告：`createIssue: false`、`updateAssignee: false`、`comments`/`attachments`/`relations`/`webhook`/`incrementalSync` 依現有 `jira-integration.mjs` 行為逐一核實後填入，不得憑空假設）。驗證：新增測試斷言 `createJiraIntegration(...).capabilities` 回傳值符合上述宣告，且既有涵蓋 60 秒 refresh/手動同步/JQL scope/write behavior 的測試案例逐項通過、斷言內容不變。
- [ ] 2.2 在 `server/provider-registry.mjs` 中把 `"jira"` 這個 source key 註冊為 2.1 的 provider 實例，`getProviderCapabilities("jira")` 應回傳 2.1 的 capabilities。驗證：單元測試確認 `getProviderCapabilities("jira")` 與 `createJiraIntegration(...).capabilities` 內容一致。
- [ ] 2.3 [P] 執行 `npm test`，確認既有涵蓋 Jira 同步行為（60 秒 refresh、手動同步、JQL scope、write behavior）的測試案例全數通過、斷言內容與變更前一致（此階段仍未移除任何呼叫端的 `source === "jira"` 判斷，只是新增了未被消費的 capabilities 資訊）。

## 3. database.mjs 附加 capabilities 到 task/project 回傳物件

- [ ] 3.1 `server/database.mjs` 在組裝 task 回傳物件（含 `row.external_source === "jira" ? "jira" : "local"` 映射邏輯所在處）與 project 回傳物件（含 `row.id === JIRA_PROJECT_ID ? "jira" : "local"` 映射邏輯所在處）時，各自呼叫 `getProviderCapabilities(source)` 並附加為 `capabilities` 欄位——這是設計決策「前端透過一個新的共用 API 欄位取得 capabilities，不在前端重建 registry」的後端前置步驟，capabilities 的定義權留在後端 registry。驗證：新增測試確認回傳的 task/project 物件皆含正確的 `capabilities` 欄位，且既有的 `source` 欄位值與計算方式維持不變。
- [ ] 3.2 [P] 執行 `npm test`，確認新增欄位不破壞任何既有斷言（若既有測試對 task/project 物件做深度相等比對而未預期新欄位，需要更新該測試的預期值以包含 `capabilities`，但不得刪除或放寬其原有斷言範圍）。

## 4. 移除 server/app.mjs 的字面 source 判斷

- [ ] 4.1 `PATCH /api/tasks/:id` 路由中，判斷是否拋出 `JIRA_ASSIGNEE_UNAVAILABLE` 的邏輯改為讀取 `current.capabilities.assigneeEdit`；判斷是否拋出 `JIRA_PROJECT_MOVE_UNAVAILABLE`（含本地任務不能移入 Jira 項目與 Jira 任務不能移出兩個方向）的邏輯改為讀取對應的 `projectReassign` 能力；判斷是否需要呼叫 `jira.updateTask` 的邏輯改為讀取 provider 是否存在（`getProvider(current.source) !== null`）而非字面比對 `"jira"`。驗證：既有涵蓋這幾個錯誤碼（`JIRA_ASSIGNEE_UNAVAILABLE`/`JIRA_PROJECT_MOVE_UNAVAILABLE`）的測試案例逐項通過，斷言的錯誤碼與觸發條件不變。
- [ ] 4.2 `DELETE /api/tasks/:id` 路由中，判斷是否拋出 `JIRA_DELETE_UNAVAILABLE` 的邏輯改為讀取 `current.capabilities.manualDelete`。驗證：既有涵蓋 `JIRA_DELETE_UNAVAILABLE` 的測試案例通過。
- [ ] 4.3 `POST /api/tasks/:id/move` 路由中，判斷是否需要版本衝突檢查、封存檢查、呼叫 `jira.moveTask` 的邏輯改為讀取 `current.capabilities.manualMove`。驗證：既有涵蓋 move 相關錯誤碼與 Jira move 呼叫時機的測試案例通過。
- [ ] 4.4 `POST /api/tasks/:id/archive` 與 `POST /api/tasks/:id/restore` 路由中，判斷是否拋出 `JIRA_ARCHIVE_UNAVAILABLE`/`JIRA_RESTORE_UNAVAILABLE` 的邏輯改為讀取 `current.capabilities.manualArchive`。驗證：既有涵蓋這兩個錯誤碼的測試案例通過。
- [ ] 4.5 對 `server/app.mjs`、`server/database.mjs` 全檔執行 `grep -n 'source === "jira"\|source !== "jira"'`，確認除了 `database.mjs` 中定義 `source` 欄位本身值的那一行映射邏輯外零殘留——驗證規格要求「Zero remaining literal source string comparisons」成立。驗證：grep 結果附在該任務的完成紀錄中。

## 5. 前端改讀 capabilities

- [ ] 5.1 `web/src/App.tsx` 的 `isJiraProject` 判斷改為讀取 `selectedProject?.capabilities`（依實際受影響的 UI 行為決定讀取哪個/哪些欄位，例如專案層級的 `projectReassign` 或既有等效欄位），移除字面比對 `selectedProject?.source === "jira"`——落實設計決策「前端透過一個新的共用 API 欄位取得 capabilities，不在前端重建 registry」，前端不重複維護 source-to-capabilities 的映射邏輯。驗證：該檔案內 grep `source === "jira"` 結果為零。
- [ ] 5.2 `web/src/components/TaskCard.tsx` 兩處 `disabled={propertyDisabled || task.source === "jira"}` 改為讀取對應的 `task.capabilities`（如 `assigneeEdit`），`web/src/components/IssueListView.tsx` 一處、`web/src/components/TaskDetail.tsx` 兩處（含 `onDeleteLabel` 三元判斷）比照辦理，同樣落實「前端透過一個新的共用 API 欄位取得 capabilities，不在前端重建 registry」。驗證：既有涵蓋這些元件 disabled 狀態的元件測試（`test:components`）通過，且對這四個檔案 grep `source === "jira"` 結果為零。
- [ ] 5.3 [P] 執行 `npm run typecheck`（若存在）與 `npm run build:web`，確認型別與建置皆乾淨。

## 6. 假 provider 驗收測試與收尾

- [ ] 6.1 新增一個測試專用的假 provider（僅存在於測試檔案內，不對外暴露路由或設定介面），註冊進 provider registry 並宣告與 Jira 不同的 capabilities 組合（例如 `manualDelete: true`），驗證「新增一個假的 provider 不需要修改 UI 條件判斷即可宣告能力」這項完成判準與規格要求「New provider requires zero UI conditional changes」成立。驗證：新增測試確認前端元件（或元件測試中模擬的資料）在收到該假 provider 的 task 資料時，UI disabled 狀態正確反映其 capabilities，且該測試的建立過程未修改任何一個前端元件的條件判斷式（只在測試資料的 capabilities 欄位帶入不同值）。
- [ ] 6.2 全 repo（含 `server/`、`web/src/`、`cli/`）執行 `grep -rn 'source === "jira"\|source !== "jira"'`，確認 design.md Implementation Contract 驗收判準第 1 項與規格要求「Provider capabilities SHALL be explicitly declared, not inferred from source string comparison」成立（零殘留，資料庫欄位映射定義處除外）。
- [ ] 6.3 執行完整 `npm test`（全數通過）、`npm run typecheck`（若存在，乾淨）、`npm run build:web`（乾淨），並在 handoff 中列出與變更前的 baseline 測試數比對，確認無既有測試被刪除或跳過（除已知的既有 skip 案例外）。
