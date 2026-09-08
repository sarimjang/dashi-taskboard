## Why

`server/database.mjs`、`server/app.mjs`、`web/src/App.tsx` 與多個前端元件（TaskCard.tsx、IssueListView.tsx、TaskDetail.tsx）中散落十餘處 `source === "jira"` 硬編碼判斷，是目前唯一用來決定「這個 task 能不能改指派人／能不能刪標籤／欄位要不要唯讀」的機制。這是 hard fork risk remediation 的 Track C 第三個、也是最後一個跨模組 change，對應 architect.md Phase 1（`docs/planning/fork-plan.md` change 3），目的是在後續（Phase 2 及以後，本輪不做）要新增 Linear 或其他 provider 之前，先把「provider 能力」變成顯式宣告的 contract，而不是繼續用字串比對猜測。change 2（retire-shared-board）已完成並併入 integration/dashi-taskboard，本 change 建立在其確立的安全邊界之上。

## What Changes

- 新增 `ProviderCapabilities` 顯式能力宣告介面（createIssue / updateAssignee / comments / attachments / relations / webhook / incrementalSync），取代 UI 端對 `source === "jira"` 的猜測。
- 新增 provider registry：把「這個 source 字串對應到哪個 provider、該 provider 有哪些能力」集中到一個模組，而不是散落在呼叫端。
- `server/jira-integration.mjs` 改為實作 `IssueProvider` 介面（configure/status/listIssues/getIssue/createIssue/updateIssue/listStatuses/listLabels/listComments/reconcileIssue/reconcileSince），但底層行為（60 秒 refresh、手動同步、既有 JQL scope、write behavior）逐項保持不變 —— 這是重構，不是重寫。
- `server/database.mjs` 的 external source mapper（目前 `row.external_source === "jira" ? "jira" : "local"` 這類寫法）改為透過 provider registry 查表，不再把「非 Jira 的外部來源」直接歸類成 local。
- 前端（`web/src/App.tsx` 的 `isJiraProject`、`TaskCard.tsx`/`IssueListView.tsx`/`TaskDetail.tsx` 的 `task.source === "jira"` disabled 判斷）改為讀取該 task/project 對應 provider 的 `ProviderCapabilities`，不再字面比對 `"jira"`。
- `server/app.mjs` 中 4 處 `current.source === "jira"` / `current?.source === "jira"` 判斷（約在 3078/3128/3147/3173/3191 行附近，因應重構過程行號會變動，實際範圍以「處理 task 屬性更新時判斷是否為外部 provider 管理欄位」的邏輯段落為準）改為透過 capabilities 查詢。

## Non-Goals (optional)

（design.md 將建立，Non-Goals 移至該處記錄）

## Capabilities

### New Capabilities

- `provider-contract`: 定義 `IssueProvider` 介面與 `ProviderCapabilities` 宣告、provider registry 查表機制，以及 Jira provider 對該介面的實作方式，取代目前散落的 `source === "jira"` 判斷。

### Modified Capabilities

（無既有 spec capability，本專案 openspec/specs/ 目前為空，不涉及既有 capability 的需求變更）

## Impact

- Affected specs: provider-contract（新增）
- Affected code:
  - Modified: server/jira-integration.mjs, server/database.mjs, server/app.mjs, web/src/App.tsx, web/src/components/TaskCard.tsx, web/src/components/IssueListView.tsx, web/src/components/TaskDetail.tsx
  - New: server/provider-registry.mjs（暫定檔名，實際命名於 design.md 確認）
  - Removed: 無檔案刪除，僅移除散落於上述檔案中的 `source === "jira"` 字面比對邏輯
