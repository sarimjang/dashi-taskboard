## 1. 範圍核實（Investigation）

- [x] 1.1 逐一追蹤 `web/src/App.tsx`、`web/src/api.ts`、`web/src/taskConversations.ts`、`web/src/types.ts`、`web/src/components/TaskEditor.tsx`、`server/ai-chat*.mjs`、`server/codex-app-server.mjs`、`server/database.mjs`、`server/project-summary.mjs`、`scripts/codex-injector*.mjs`、`shared/taskboard-automation.mjs` 裡出現的 `workspacePath`/`codexHostId`/`codexProjectId` 呼叫鏈，確認是否真的呼叫 `server/cloud-proxy.mjs`/`server/cloud-config.mjs` 的雲端轉發邏輯（即設計文件「刪除而非修復雲端寫入路徑」決策範圍內的耦合檔案），產出一份確認清單——驗證方式：清單存在，且每個檔案都有明確結論（耦合／不耦合／需要進一步任務）
- [x] 1.2 [P] 確認 fork-plan.md 提到的「execution overlay」在 UI 原始碼中具體對應哪個功能或元件，記錄結論——驗證方式：在備註中補上找到的對應功能名稱與檔案位置，或明確記錄「未找到對應功能，維持只保護 resolveDevelopmentContext/resolveProjectWorkspace」的結論

## 2. Shared-board-migration 遷移子指令

- [x] 2.1 在 `cli/taskctl.mjs` 新增遷移子指令，讀取 `cloud-companion.json` 設定並列出來源雲端看板的 tasks/comments/attachments 清單（dry-run，僅列出不寫入）——驗證方式：對一個測試用雲端看板執行 dry-run，輸出清單筆數與雲端資料庫直接查詢的筆數一致，對應 spec 需求「Migrate shared cloud board data to a local project」
- [x] 2.2 實作遷移子指令的實際寫入邏輯，將 tasks/comments/attachments 匯入指定 local project 的本機資料庫（設計文件「遷移路徑從零建立，不重用既有 CLI 匯出/匯入機制」決策的具體實作）——驗證方式：對測試用雲端看板快照執行完整遷移，比對 local project 資料庫筆數與內容雜湊跟來源一致，符合 spec 的 Successful full migration 情境
- [x] 2.3 [P] 讓遷移子指令具備冪等性：重複執行不會對已遷移項目建立重複記錄——驗證方式：對同一來源與目的地連續執行遷移子指令兩次，第二次執行後本機資料庫筆數與第一次相同，符合 spec 的 Re-running migration after a partial success 情境
- [x] 2.4 [P] 讓遷移子指令在部分項目失敗時（如附件下載失敗）繼續處理其餘項目並印出明確的失敗清單——驗證方式：模擬一個附件下載失敗的情境，執行後確認其餘項目仍完成遷移且終端機輸出包含該失敗項目與原因，符合 spec 的 Migration failure on a subset of items 情境
- [x] 2.5 對遷移子指令的資料完整性做獨立驗證（筆數比對、內容雜湊比對），不僅限一般單元測試——驗證方式：獨立 code-reviewer 對 2.1~2.4 的實作額外執行一次筆數與雜湊比對，並在 review handoff 中記錄比對結果

## 3. 移除雲端寫入路徑（僅在第 2 節任務全數驗證通過後才可開始）

- [x] 3.1 移除 `server/cloud-proxy.mjs` 的 `createCloudProxy`/`forward`/`webSocketTarget`/`basicAuthorization` 與相關雲端轉發邏輯，保留 `isLocalCompanionRoute` 及其呼叫點不變——驗證方式：`npm test` 通過，且對任一原本由 `createCloudProxy` 處理的路徑發送請求得到標準 404，符合 spec 的 Request to a retired cloud proxy endpoint 情境
- [x] 3.2 移除 `server/app.mjs` 內驗證 `threadBinding.{codexProjectId, codexHostId, workspacePath}` 的區塊與呼叫 `createCloudProxy` 的接線，確保「Cloud write path no longer accepts device/session identifiers after migration tooling ships」需求成立——驗證方式：`npm test` 通過，且伺服器 log 在對已刪除端點發送請求後不含任何 sharedKey/actorName/remoteUrl 相關記錄
- [x] 3.3 移除 `server/cloud-config.mjs` 整個共享金鑰設定 schema 與 store——驗證方式：`npm test` 通過，且全 repo grep 確認 `sharedKey`/`actorName`（雲端代理意義下）不再被任何程式碼路徑讀取
  - **範圍擴張（必要前提，非選擇性，獨立審查驗證通過）**：`setProjectWorkspace`/`projectMappings` 除 `normalizeCloudUrl` 外還被 `PUT /api/local/project-mappings/:id` 路由、`GET /api/projects` 的 workspacePath fallback、`GET .../development-contexts` 三處依賴，一併移除（含 `cli/taskctl.mjs` 的 `project map` 子指令，其唯一呼叫來源）；否則整檔刪除 `cloud-config.mjs` 會留下未定義引用。
- [x] 3.4 [P] 移除 `cloud/`（含 `cloud/src/index.mjs` 與 `cloud/migrations/`）與 `wrangler.jsonc`——驗證方式：`git status` 確認這些路徑已從 repo 移除，且既有建置腳本不再嘗試部署或引用這些檔案
  - **執行結果偏離字面文字，PM 已核准，獨立審查驗證通過（commit 925708a）**：`cloud/` 與 `wrangler.jsonc` 皆**原樣保留**，未刪除。`cloud/` 作為 `test/helpers/cloud-worker-harness.mjs` 的 miniflare 測試 fixture 留存（Option 1，供 §2 遷移子指令測試使用）；`wrangler.jsonc` 因既有、無關的 `test/cloud-migration.test.mjs` 有案例會實際呼叫真正 `wrangler` CLI 讀取它（已 reproducible 驗證：搬走即 ENOENT），且該檔案不含任何密鑰（僅 `database_id` 資源識別碼）。實際刪除範圍：`wrangler.jsonc`/`cloud/` 相關的**部署** npm scripts（`dev:cloud`/`cloud:migrate(:local)`/`cloud:deploy(:dry-run)`），`isLocalCompanionRoute`/`test:cloud`/`cloud:data` 不受影響。詳見 `changes/retire-shared-board/handoffs/{rsb-remove-cloud-2-h1,rsb-remove-cloud-review-h1}.md`。
- [x] 3.5 確認 `resolveDevelopmentContext`/`resolveProjectWorkspace` 函式本身未被本節任何刪除動作影響——驗證方式：對這兩個函式涵蓋範圍內的既有測試全數執行，確認行為與刪除前一致，同時驗證 Local companion routes remain unaffected 情境

## 4. 測試與文件收尾

- [ ] 4.1 移除或改寫 `test/cloud-shared-worker.test.mjs`、`test/cloud-companion.test.mjs`、`test/server.test.mjs` 裡測試雲端代理轉發行為的案例，改為測試端點已退場（404）——驗證方式：`npm test` 全綠，且這三個測試檔案裡不再有任何斷言雲端代理成功轉發的案例
- [ ] 4.2 [P] 移除 `docs/cloud-collaboration.md`，並在 README 或對應文件補上共享雲端看板功能已退場、資料可透過遷移子指令匯出的說明——驗證方式：`docs/cloud-collaboration.md` 已不存在，且對應文件包含上述說明文字
- [ ] 4.3 [P] 移除 `cli/taskctl.mjs` 依賴 `normalizeCloudUrl` 的 cloud-configure 子指令——驗證方式：`taskctl --help`（或等效指令）的輸出不再列出 cloud-configure 子指令，且 `npm test` 中對應的舊測試已同步移除
  - **部分已完成（§3，commit 925708a，被迫非選擇）**：`cloud login`/`cloud status`/`cloud logout` 子指令與 `normalizeCloudUrl` import 已移除（`taskctl --help` 已確認不再列出）——其依賴的 `/api/local/cloud-session` 路由已在 3.2 隨之刪除，留著只會打一個永遠 404 的端點。**尚未完成**：`test/cloud-companion.test.mjs` 裡呼叫 `runCli(["cloud","status"|"login"|"logout"|...])`/`runCli(["project","map",...])` 的舊測試案例（目前計入 §3 已知的 23 個預期內失敗）尚未同步移除——這是本項驗證方式明確要求的「`npm test` 中對應的舊測試已同步移除」，仍待本節完成。
