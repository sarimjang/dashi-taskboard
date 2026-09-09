## Context

現況：`server/cloud-proxy.mjs` 的 `prepareRequest()` 會把 payload 的 `threadId` 解析成 `threadBinding`（含 `codexProjectId`/`codexHostId`/`workspacePath`），附加到請求上；`createCloudProxy({...}).forward(request)` 再把整個請求（含這個 binding）用 `basicAuthorization(actorName, sharedKey)` 這把靜態共享金鑰簽章後轉發到遠端 Cloudflare Worker（`cloud/src/index.mjs`，由 `wrangler.jsonc` 部署）。金鑰與遠端網址存在 `server/cloud-config.mjs` 管理的 `cloud-companion.json` 設定檔裡（`remoteUrl`/`actorName`/`sharedKey`，`server/app.mjs` 約 1611 行）。

這條路徑本身已經跟兩個必須保留的機制乾淨分離：`isLocalCompanionRoute(pathname)`（`server/cloud-proxy.mjs`）明確 allowlist 了 `/health`、`/api/meta`、`/api/device-workspaces`、`/api/local/cloud-session`、所有 `/api/local/*` 與每專案 `/development-contexts`，這些路由永遠不會被代理到雲端；`resolveDevelopmentContext`/`resolveProjectWorkspace`（`server/app.mjs`）則是把 task 對應到本機開發 worktree 的邏輯，雲端與本機路徑都會呼叫它，但它本身不含任何雲端轉發程式碼。

> **§3 執行後校正（獨立審查 rsb-remove-cloud-review 發現，非阻塞）**：`resolveDevelopmentContext` 實際上從未以此名稱作為頂層函式存在——它只是 `createCloudProxy({...})` 呼叫時傳入的一個內聯匿名回呼（option key 叫這個名字），本身依賴 `cloudConfig.read()`/`projectMappings`，屬雲端專屬邏輯，已隨 §3 一併刪除（正確行為）。真正「本機、雲端與本機路徑共用、不含雲端轉發程式碼」的那部分邏輯是 `scanDevelopmentContexts` 函式，此函式定義本身在 §3 未被觸碰（逐字元未變，已獨立驗證）。`resolveProjectWorkspace` 的敘述準確無誤。

`workspacePath`/`codexHostId`/`codexProjectId` 這三個欄位名稱也出現在約 20 個與雲端代理無關的檔案（`web/src/App.tsx`、`server/ai-chat*.mjs`、`scripts/codex-injector*.mjs` 等）——初步研判是本機開發環境識別用途的同名欄位，非本 change 範圍，但尚未逐一確認，列為本 change 執行期間需要 apply-executor 逐檔核實的項目。

## Goals / Non-Goals

**Goals:**

- 移除 `server/cloud-proxy.mjs` 的雲端轉發機制（`createCloudProxy`/`forward`/`webSocketTarget`/`basicAuthorization`）與 `server/cloud-config.mjs` 的共享金鑰設定 schema/store。
- 移除 `server/app.mjs` 內驗證並轉發 `threadBinding.{codexProjectId, codexHostId, workspacePath}` 的區塊。
- 移除 `cloud/`（Cloudflare Worker 原始碼、`cloud/migrations/`）、`wrangler.jsonc`、`docs/cloud-collaboration.md`。
- 建立 `shared-board-migration` 能力：把既有 shared board 資料（tasks、comments、attachments）匯出到 local project，在刪除雲端寫入路徑前先驗證這條遷移與其 rollback 皆可用。
- `cli/taskctl.mjs` 移除依賴 `normalizeCloudUrl` 的 cloud-configure 子指令，新增遷移子指令。

**Non-Goals:**

- 不移除或改寫 `isLocalCompanionRoute` 的 allowlist 邏輯本身，也不移除任何 `/api/local/*` 路由的實作——這是既有、乾淨分離的本機功能，本 change 只是確認它不受影響，不對它做任何修改。
- 不移除或改寫 `resolveDevelopmentContext`/`resolveProjectWorkspace` 函式本身——只移除呼叫端裡屬於雲端轉發的接線（如果有的話），函式其餘用途（本機 worktree 解析）維持原樣。
- 不假設 `web/src/App.tsx`、`web/src/api.ts`、`server/ai-chat*.mjs`、`scripts/codex-injector*.mjs` 等約 20 個檔案裡出現的同名欄位（`workspacePath`/`codexHostId`/`codexProjectId`）屬於本 change 範圍——這些欄位很可能是本機開發環境識別用途的同名巧合，apply-executor 必須先確認該檔案的用法是否真的呼叫 `cloud-proxy.mjs`/`cloud-config.mjs` 的雲端轉發鏈路，未確認前不得修改。
- 不引入新的建置工具、測試框架或格式化設定。
- 不在遷移與 rollback 被驗證前刪除任何使用者資料——這是本 change 的硬性約束，不是選項。

## Decisions

### 刪除而非修復雲端寫入路徑

RISK-004（雲端保存本機 path/host）與 RISK-008（共享雲端密碼）源自同一條 cloud sync 路徑，且 `cloud/` 與 `wrangler.jsonc` 本來就是 `architect.md` Phase 5 規劃要退場的元件。相較於「改成個別可撤銷身分」的修復路線，直接刪除整條路徑成本更低、且提前完成既定的架構退場計畫，不需要維護兩套身分機制。替代方案（改用個別 API token）被拒絕，因為這個 fork 的維運規模不需要多使用者雲端協作，維護一套已規劃要退場的身分系統沒有效益。

### 遷移路徑從零建立，不重用既有 CLI 匯出/匯入機制

`cli/taskctl.mjs` 目前沒有任何 export/import/migrate 子指令可以重用（已於研究階段確認）。決定新增一個獨立的遷移子指令，直接讀取雲端資料庫的 tasks/comments/attachments 並寫入 local project 的資料層，而非嘗試改造既有的 cloud-proxy 轉發邏輯來做匯出——因為轉發邏輯本身就是要被刪除的目標，重用它會讓刪除步驟與遷移步驟互相依賴，增加執行順序上的風險。

## Implementation Contract

**Behavior：** 執行遷移子指令後，使用者原本存在 shared cloud board 上的 tasks、comments、attachments 會完整出現在指定的 local project 裡，且原始雲端資料在使用者確認遷移結果正確之前不會被刪除。遷移完成、雲端寫入路徑退場後，任何嘗試以 `workspacePath`/`codexHostId`/`codexProjectId` 呼叫雲端代理端點的請求，該端點本身已不存在（回傳一般路由層級的 404，而非應用層驗證錯誤）。

**Interface / data shape：**

- `cli/taskctl.mjs` 新增一個遷移子指令（子指令名稱、參數格式由 tasks.md 依實作階段細化），輸入為現有 `cloud-companion.json` 設定（`remoteUrl`/`actorName`/`sharedKey`），輸出為寫入本機資料庫的 tasks/comments/attachments 記錄，並印出遷移摘要（筆數、失敗項目清單）。
- `server/cloud-proxy.mjs`、`server/cloud-config.mjs`、`cloud/`、`wrangler.jsonc` 整檔/整目錄刪除，不保留部分相容層。
- `server/app.mjs` 內原本驗證 `threadBinding.{codexProjectId, codexHostId, workspacePath}` 的程式碼路徑整段移除，`isLocalCompanionRoute` 呼叫點與其餘路由邏輯維持不動。

**Failure modes：** 遷移子指令若在中途失敗（網路中斷、雲端資料格式不符預期），必須明確印出已完成與未完成的項目清單，不得靜默略過；重跑遷移子指令對已成功遷移的項目必須是冪等的（不重複建立）。雲端寫入路徑刪除後，任何舊版前端或腳本對已刪除端點發出的請求，只會得到路由層級的標準 404，不需要額外的相容性錯誤訊息。

**Acceptance criteria：**

- `npm test` 全綠，且 `test/cloud-shared-worker.test.mjs`、`test/cloud-companion.test.mjs`、`test/server.test.mjs` 裡原本測試雲端代理轉發行為的案例已移除或改寫為測試「端點不存在」。
- 手動驗證：對任一已刪除的雲端代理端點發送請求，回應為標準 404，且伺服器 log 不含任何 `sharedKey`/`actorName`/`remoteUrl` 相關的存取嘗試記錄。
- 遷移子指令對一個測試用的 shared board 快照執行後，比對 local project 資料庫的 tasks/comments/attachments 筆數與內容跟原始快照一致。

**Scope boundaries：** 本 change 只處理 `server/cloud-proxy.mjs`、`server/cloud-config.mjs`、`cloud/`、`wrangler.jsonc`、`docs/cloud-collaboration.md`、`server/app.mjs` 裡的雲端轉發驗證區塊，以及新增的遷移子指令。不涉及 `isLocalCompanionRoute` 允許清單內的任何路由實作、`resolveDevelopmentContext`/`resolveProjectWorkspace` 函式本身，以及本 change 尚未逐檔確認用途的約 20 個同名欄位檔案（見 Context 段落清單）。

## Risks / Trade-offs

- [使用者尚未遷移就升級，遺失雲端專屬資料] → 遷移子指令必須在雲端寫入路徑刪除的同一個 change 內先行提供並可獨立驗證；在遷移與 rollback 被驗證之前不合併刪除雲端寫入路徑的那一半改動。
- [約 20 個同名欄位檔案中，其實有檔案真的耦合雲端轉發但被誤判為本機用途] → apply-executor 必須對每個檔案實際追蹤呼叫鏈到 `cloud-proxy.mjs`/`cloud-config.mjs`，不得只憑欄位名稱判斷；若發現真正耦合，在該檔案的 review 階段回報並更新 tasks.md 範圍，不得默默擴大或縮小範圍。
- [遷移子指令是全新程式碼，沒有既有機制可重用，品質風險較高] → 要求獨立 code-reviewer 對遷移子指令做額外的資料完整性驗證（筆數比對、內容雜湊比對），不能只跑一般單元測試。

## Migration Plan

1. 先實作並驗證遷移子指令（`cli/taskctl.mjs` 新增子指令），對一個真實或模擬的 shared board 快照跑過一次完整遷移，人工核對資料完整性。
2. 遷移驗證通過後，才移除 `server/cloud-proxy.mjs`、`server/cloud-config.mjs`、`cloud/`、`wrangler.jsonc`、`docs/cloud-collaboration.md`，以及 `server/app.mjs` 的雲端轉發驗證區塊。
3. Rollback 策略：由於雲端 Worker 與設定檔在此 change 內是整個刪除（非漸進式關閉），rollback 等同於 revert 這個 change 的 commit——在 `retire-shared-board` 對應的 lifecycle obligation 收尾（依 decisions.jsonl#seq4，spectra archive 延後到最終 `integration/dashi-taskboard` 併入 `main`）之前，維持可以整批 revert 的能力，不做無法回退的資料庫 schema 破壞性變更。

## Open Questions

- 「execution overlay」在 `docs/planning/fork-plan.md` 裡提到要保留，但研究階段沒有在 `web/src/App.tsx`/`web/src/api.ts` 找到這個字面詞——需要在 tasks.md 執行前跟 fork-plan.md 的原作者（或直接讀 UI 原始碼確認）核實它具體對應到哪個功能，避免誤刪或誤判範圍。
- 約 20 個同名欄位檔案的實際歸屬（見 Context／Risks），需要在 tasks.md 的第一批任務裡安排一個「逐檔確認」的獨立任務，而非假設全部無關。
