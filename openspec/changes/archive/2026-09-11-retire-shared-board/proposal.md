## Why

Hard fork 之下，`cloud/`（Cloudflare Worker）與其代理路徑會把使用者的本機路徑、host 識別碼（`workspacePath`、`codexHostId`、`codexProjectId`）送到遠端，且所有使用者共用同一把靜態密碼（`sharedKey`）存取同一個 Worker（RISK-004、RISK-008）。這兩項風險源自同一條 cloud sync 路徑，且 `cloud/` 與 `wrangler.jsonc` 本來就是 `architect.md` Phase 5 規劃要退場的元件——本次是提前執行退場，而非修復。刪除比修復（例如改個別可撤銷身分）成本低很多，適合這個規模的 fork 維護者。

## What Changes

- **BREAKING**：移除共享雲端看板同步路徑——`server/cloud-proxy.mjs` 的 `createCloudProxy`/`forward`/`webSocketTarget`/`basicAuthorization`，以及 `server/cloud-config.mjs` 整個共享金鑰設定 schema 與 store（`remoteUrl`/`actorName`/`sharedKey`）。
- **BREAKING**：移除 `server/app.mjs` 內驗證並轉發 `threadBinding.{codexProjectId, codexHostId, workspacePath}` 的區塊（含 `codexProjectKind` 與 `codexHostId` 一致性檢查），以及呼叫 `createCloudProxy` 的接線。
- 移除 `cloud/`（Cloudflare Worker 原始碼與 migrations）、`wrangler.jsonc`、`docs/cloud-collaboration.md`。
- 新增一條把既有 shared board 資料匯出到 local project 的遷移路徑（目前完全不存在，需從零建立；不得在遷移與 rollback 被驗證前刪除使用者資料）。
- `cli/taskctl.mjs` 移除依賴 `normalizeCloudUrl` 的 cloud-configure 子指令，新增遷移子指令。
- 明確保留：`server/cloud-proxy.mjs` 的 `isLocalCompanionRoute` allowlist（`/health`、`/api/meta`、`/api/device-workspaces`、`/api/local/cloud-session`、所有 `/api/local/*`、每專案 `/development-contexts`）與其對應的 local companion 功能——這是與雲端同步乾淨分離的既有機制，本 change 不動它。
- 明確保留：`resolveDevelopmentContext`/`resolveProjectWorkspace`（`server/app.mjs`）等本機開發環境/worktree 解析邏輯——只移除它們被雲端轉發呼叫的接線，不移除函式本身。

## Non-Goals

（design.md 將建立，Non-Goals 記錄於該檔）

## Capabilities

### New Capabilities

- `shared-board-migration`：把既有 shared cloud board 的資料（tasks、comments、attachments 等）匯出並匯入到使用者的 local project，作為刪除共享同步路徑前的資料保護機制。

### Modified Capabilities

（無現有 spec 承載雲端代理行為，本次是移除舊實作路徑，不改變既有 spec 定義的需求）

## Impact

- Affected specs：新增 `shared-board-migration`
- Affected code：
  - Removed：`cloud/`（含 `cloud/src/index.mjs` 與 `cloud/migrations/`）、`wrangler.jsonc`、`docs/cloud-collaboration.md`、`server/cloud-proxy.mjs`、`server/cloud-config.mjs`
  - Modified：`server/app.mjs`（移除 `threadBinding` 的 `codexProjectId`/`codexHostId`/`workspacePath` 驗證區塊與 `createCloudProxy` 接線，保留 `isLocalCompanionRoute` 與本機開發環境解析邏輯）、`cli/taskctl.mjs`（移除 cloud-configure 子指令、新增遷移子指令）、`test/cloud-shared-worker.test.mjs`、`test/cloud-companion.test.mjs`、`test/server.test.mjs`（移除或改寫雲端代理路由相關測試）
  - New：一支資料遷移腳本或 CLI 子指令（實際路徑於 design.md 決定），用於把 shared board 資料匯出到 local project
