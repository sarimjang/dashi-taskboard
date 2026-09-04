# Hard Fork 與 Risk Remediation 執行計畫

## 文件狀態

本文件是執行計畫，不是架構決策。
架構決策見 [`architect.md`](./architect.md)，風險證據見 [`risk-assessment.md`](./risk-assessment.md)。
本計畫依據 repository revision `5c96d1ab698362994283ba0af86021db0a98dd89`，並已在 2026-08-27 重新驗證下列事實。
2026-09-04 再次對照程式碼（Claude 審查 + Codex 獨立複核），修正六處：bd-6 範圍、bd-4 與 bd-5 行號、Step 0 前提、Step 1 硬編 URL 清單、change 1 的第二處 host 檢查。

- `server/app.mjs:1640` `resolveHost` 預設值確為 `"0.0.0.0"`；`:1642-1643` 與 `:3359-3360` 另有兩處把 host 硬限為 `127.0.0.1` 或 `0.0.0.0`。
- `package.json:48` `js-yaml` 確為 `4.1.1`。
- `scripts/codex-injector.mjs:37-41` 確為固定路徑 `codex-taskboard-independent-profile-v2`（macOS 走 `/private/tmp`，Linux 走 `os.tmpdir()`）。
- `origin` 目前直接指向 upstream `https://github.com/chuspeeism/dashi-taskboard.git`，尚無個人 fork remote。

## 已確認的三項決策

| 決策 | 選擇 | 對計畫的影響 |
| --- | --- | --- |
| Fork 路線 | Hard fork，切斷上游 | 「刪除功能」成為合法的 risk 消解手段，不需保持 patch 可 upstream |
| 修補範圍 | RISK-001 ～ RISK-010 全部 | RISK-011 ～ RISK-016 不在本輪，它們是 architect.md Phase 3 的驗收條件 |
| 變更管理 | 混合 | 單點修補走 Beads；跨模組退場與 provider 重構走 Spectra |

## Hard fork 帶來的關鍵簡化

RISK-004、RISK-007、RISK-008、RISK-009 在 hard fork 下都有「刪除比修復便宜」的選項。

| 風險 | 修復路線 | 刪除路線 | 建議 |
| --- | --- | --- | --- |
| RISK-004 cloud 保存本機 path/host | 收斂 cloud payload 為 allowlist | 隨 `cloud/` 與 `wrangler.jsonc` 一併退場 | 刪除，architect.md Phase 5 本來就要退場 |
| RISK-008 shared cloud password | 改為個別可撤銷身分 | 同上 | 刪除，與 RISK-004 同一個 change |
| RISK-007 未簽章 Windows installer | 取得 Authenticode 憑證 | 從 Release assets 移除，只留 CI artifact | 移除，個人 fork 短期不會有憑證 |
| RISK-009 WorkBuddy iframe | 補 sandbox 與 message bridge | 刪除 `inject/workbuddy-taskboard.user.js` 與其前端分支 | 刪除，理由見下節 |

### WorkBuddy 判定（2026-08-27 查證）

`inject/workbuddy-taskboard.user.js` 是把 Taskboard 掛進第三方 App 側邊欄的 userscript。
它複製 WorkBuddy 原生 tab、改寫 icon 與文字，再插入一個裸 `<iframe>` 指向 `http://127.0.0.1:47823/?project=local&host=workbuddy`。
Codex embed 具備的 `sandbox`、capability handshake 與外部導覽委派它都沒有，這正是 RISK-009 的成因。

判定為可刪除，依據三項查證結果：

- 它不在 [`architect.md`](./architect.md) 的目標架構中，與 provider 抽象、webhook ingress 或 loopback 邊界皆無關。
- 全 repo 只有四個引用點，且 `docs/`、`README.md`、`README.zh-CN.md`、`AGENTS.md` 完全沒有提及，沒有 npm script 也沒有測試。
- 它是 `web/src/api.ts:216` `getHostRuntime` 的唯一呼叫端。

`hostContext` 有兩個 setter：`web/src/App.tsx:1725` 的 postMessage handshake 供 Codex embed 使用，以及 `web/src/App.tsx:1755` 每秒一次的 HTTP 輪詢，後者只服務 WorkBuddy。
WorkBuddy 因為無法完成 postMessage handshake 才改用輪詢。
刪除它同時消除該常駐 interval 與其後的 server route。

**必須保留：** `web/src/App.tsx:685` 的 `embedded` 抽象。Codex embed 依賴它，只需將 `workbuddy` 從該 union 移除，不是拆除整個 embedded 機制。

## Step 0：建立驗收基礎（阻塞後續所有工作）

`risk-assessment.md` 記錄 component tests 與 cloud worker tests 因缺少 `vitest` 與 `miniflare` 而無法重跑。
2026-09-04 查證：兩者都已宣告在 `package.json:70,73` 的 `devDependencies`，lockfile 也有對應項目，「缺少」只是本機沒有 `node_modules`。
在沒有可執行的測試迴圈之前，任何修補都無法被驗收。

- 執行 `npm ci`，確認 `npm test`、`npm run test:components`、`npm run test:cloud` 三條指令都能啟動。
- 跑一次完整測試並記錄 baseline 綠燈狀態與耗時。
- ~~執行 `bd` 初始化與 `spectra init`~~ 已於 2026-09-04 完成（commits `dd9d47c`、`a3cad64`、`18f22d0`）。

**完成判準：** 所有既有測試在修改任何程式碼之前為綠燈，且該結果被記錄下來。

## Step 1：Fork 身分切換（Track A）

Hard fork 最容易遺漏的是**更新通道**。若沿用 upstream 的 updater endpoint 與 signing public key，你打包出的 App 會被上游推送的更新覆蓋。

- 建立個人 repository，將 `origin` 指向自己，`upstream` 保留為唯讀 remote 或直接移除。
- 保留 `LICENSE` 全文，並在 README 加上一句出處聲明。授權查證結果見下方。
- 改名與品牌：`package.json` 的 `name`、`README.md`、`README.zh-CN.md`、`PRIVACY.md`。
- **`src-tauri/tauri.conf.json` 的 bundle identifier（`:5`）、updater endpoint（`:30`）與 updater public key 必須全部換成自有值**，否則更新來源仍是上游。
- **updater 下載 URL 另有四處硬編在 `tauri.conf.json` 之外**，漏掉任何一處，產出的 `latest.json` 仍會指回上游：
  - `scripts/create-macos-updater.mjs:39`
  - `scripts/verify-macos-release.mjs:137`
  - `scripts/verify-linux-updater.mjs:47`
  - `.github/workflows/release-macos.yml:397-398`（Linux deb 與 AppImage URL）
- `.github/workflows/*` 的 repository 指向、release 目標與 secrets 名稱調整。

**完成判準：** 本機 build 產出的 App 其 updater endpoint 指向自有位置，且 `git remote -v` 不再以 upstream 為 push 目標。

### 授權查證（2026-08-27）

Upstream `LICENSE` 是未修改的 Apache License 2.0 全文，共 201 行。
Apache 2.0 允許 fork、改名、閉源、商用與再散布，且不要求把修改開源回上游。

本 fork 的義務只有兩項：

- 保留 `LICENSE` 全文。
- 在 README 標示本專案改作自 upstream。

Repository 中沒有 `NOTICE` 檔案，因此 Apache 2.0 第 4(d) 條的 NOTICE 保留義務不適用。
`LICENSE:189` 仍是未填寫的樣板 `Copyright [yyyy] [name of copyright owner]`，upstream 從未主張具名版權行。
這不影響授權效力，但代表本 fork 可以加上自己的版權行而不會覆蓋他人的既有宣告。

**授權不是本計畫的阻塞項。**

## Step 2：Beads 單點修補批次（Track B）

以下每項對應一個 `bd` issue，順序由低風險到高風險。

### bd-1 — RISK-003 `js-yaml` 升版

`package.json:48` 由 `4.1.1` 升至 `4.3.1` 或更新，重新產生 lockfile。
這是最小風險項，同時用來驗證 Step 0 建立的測試迴圈確實可用。

**完成判準：** `npm audit --omit=dev` 不再回報 `js-yaml` advisory，且 `web/src/components/MarkdownDocument.tsx` 的 Mermaid 與 frontmatter 解析仍正確。

### bd-2 — RISK-002 injector profile 目錄

`scripts/codex-injector.mjs:37-41` 的固定路徑改為應用程式私有資料目錄下的隨機命名目錄。
以 `0700` 建立，使用 `lstat` 檢查擁有者、權限與檔案型別，遇到非預期狀態時拒絕啟動而非沉默繼續。

**完成判準：** 預先植入同名目錄或 symlink 時，injector 拒絕執行並回報明確錯誤。

### bd-3 — RISK-006 Jira 強制 HTTPS

`server/jira-config.mjs:15-41` 對非 loopback base URL 要求 HTTPS。
loopback 開發例外必須是顯式旗標，不能是預設行為。

**完成判準：** 設定 `http://` 遠端 Jira URL 時連線被拒並顯示原因。

### bd-4 — RISK-005 外部圖片限制

`risk-assessment.md` 引用的 `web/src/api.ts:800-813` 是 `resolvePersistedAttachmentUrl`，只負責把 loopback attachment URL 正規化，不是圖片載入點。
實際的 `<img src>` render 點有三個：Markdown 圖片 `web/src/components/MarkdownDocument.tsx:558-561`、卡片預覽 `web/src/components/TaskCard.tsx:151-152`、actor avatar `web/src/components/ActorAvatar.tsx:17,23`（`TaskCard.tsx:418` 與 `TaskDetail.tsx:1249,1339` 只是把 `avatarUrl` 傳給它）。
修法：新增一個集中式 URL policy 函式，只放行 Taskboard attachment URL 自動載入，套用到上述三個 render 點。
外部來源改為明確點擊載入，並拒絕 loopback、link-local 與私有網段目的地。這項會跨三個 component，仍走 Beads，但不是單檔修改。

**完成判準：** task 內容、comment 與 avatar 中的外部 URL 在未點擊前不產生網路請求。

### bd-5 — RISK-007 Windows release asset

`.github/workflows/release-macos.yml:124-128` 的 `upload-artifact` 本來就是 CI-only，**保留不動**。
要移除的是把該 exe 推上 GitHub Release 的三段：`:375-378`（`download-artifact`）、`:422-424`（複製為 `*_NSIS-x64-unsigned.exe` 進 `RELEASE_ASSETS`）、`:484-486`（`gh release upload`）。

**完成判準：** GitHub Release 不再包含未簽章的 Windows 執行檔。

### bd-6 — RISK-009 收斂第三方注入面

依上方判定直接刪除 WorkBuddy，不補 sandbox。
`integrations/deepseek-harness/` 已於 2026-08-27 確認未使用，一併移除。

刪除範圍：

- `inject/workbuddy-taskboard.user.js` 整檔。
- `web/src/App.tsx:375` 與 `web/src/App.tsx:685` 中 `host === "workbuddy"` 的判斷，保留 `embedded` 抽象與 `codex` 分支。
- `web/src/App.tsx:1749-1764` 每秒一次的 `getHostRuntime` 輪詢 effect。
- `web/src/api.ts:216` 的 client 端 `getHostRuntime` 函式。

**不得刪除 `/api/local/host-runtime` server route。** 2026-09-04 查證它不是 WorkBuddy 專用：Codex embed 在 `web/src/App.tsx:1728` 透過 `web/src/api.ts:264-271` 的 `publishHostRuntime` 對它 `PUT`，server 端 `server/app.mjs:1698-1717` 的 `currentHostThreadBinding` 拿 `hostRuntime` 做 thread binding，`test/server.test.mjs:532,555,851` 也直接測這條 route。GET handler 一併保留，避免改動既有測試。
- `integrations/deepseek-harness/` 整個目錄，以及 `web/src/App.tsx:375` 與 `web/src/App.tsx:685` 中的 `deepseek-harness` 判斷。

**完成判準：** `embedded` 判斷收斂為只剩 `host === "codex"`，Codex embed 的 postMessage handshake、`publishHostRuntime`、主題同步與 `hostContext` 相關行為完全不變，`test/server.test.mjs` 對 host-runtime route 的三條斷言仍為綠燈，且 repo 中不再有 `workbuddy` 或 `deepseek-harness` 字串。

刪除完全可逆，git history 保留兩者的完整實作，日後需要時可還原。

### bd-7 — RISK-010 Rust 依賴（monitor）

升級 Tauri 與 WebView 堆疊到允許的最新版本，確認 `glib` 已修補或確認 `VariantStrIter` 不可達。
此項為監控級，不阻塞其他工作。

**完成判準：** `cargo audit` 結果被記錄，且 `RUSTSEC-2024-0429` 的可達性有明確結論。

## Step 3：Spectra 跨模組變更（Track C）

以下三項各自是一個 Spectra change，因為它們跨越 server、UI、Tauri、文件與測試。

### change 1 — `loopback-security-baseline`（對應 RISK-001，architect.md Phase 0）

- `server/app.mjs:1640` 預設改為 `127.0.0.1`。
- `server/app.mjs:1642-1643` 與 `:3359-3360` 兩處 host 白名單一併改寫，否則 opt-in 值無法通過檢查。
- LAN 模式改為顯式 opt-in，且 opt-in 後 HTTP、SSE 與 WebSocket 必須一致地要求驗證。
- `server/app.mjs:559-600` 的 `X-Taskboard-User-*` header 只在 loopback 呼叫端被接受。
- 機器層級 metadata 與 capability route 即使在已驗證的 LAN 模式也維持 loopback-only。

**注意：** `test/server.test.mjs:423-437` 與 `:1697-1703` 兩條測試目前明確驗證「普通 API 對 LAN client 可用」，全檔沒有其他 `192.168` 引用。這是刻意的行為變更，測試必須在同一個 change 內一起改寫，不得以停用測試代替修復。

**完成判準：** standalone、Launcher、injector、SSE 與 WebSocket 五條路徑都通過網路可達性測試，預設皆不對外監聽。

### change 2 — `retire-shared-board`（對應 RISK-004 與 RISK-008，architect.md Phase 5 提前）

- 決定 `cloud/`、`wrangler.jsonc` 與 `docs/cloud-collaboration.md` 的退場政策。
- 提供把既有 shared board 資料轉出到 local project 的路徑。
- 保留 device-local companion 與 execution overlay，移除 shared password 與 direct board synchronization 責任。
- 在 migration 與 rollback 被驗證之前不刪除使用者資料。

**完成判準：** cloud 寫入路徑不再接受 `workspacePath`、`codexHostId` 或 `codexProjectId`，或該路徑整體已退場。

### change 3 — `provider-contract-abstraction`（architect.md Phase 1）

- 移除散落的 `source === "jira"` 能力判斷，改用顯式宣告的 `ProviderCapabilities`。
- 建立 provider registry、normalizer 與共用 reconciliation service。
- `server/jira-integration.mjs` 改用新 contract，但保持現有 60 秒 refresh、手動同步、JQL scope 與 write behavior 完全不變。
- 一般化 `server/database.mjs` 的 external source mapper，使其不再把所有非 Jira 來源當成 local。

**完成判準：** Jira 行為與重構前逐項一致，且新增一個假的 provider 不需要修改 UI 條件判斷即可宣告能力。

## 執行順序與依賴

```text
Step 0  npm ci + 測試 baseline（spectra init / bd init 已完成）
   │
   ├─> Step 1  fork 身分切換（可與 Step 2 並行）
   │
   └─> bd-1 js-yaml 升版（驗證測試迴圈）
         │
         └─> change 1  loopback-security-baseline
               │
               ├─> bd-2 injector profile
               ├─> bd-3 Jira HTTPS
               ├─> bd-4 外部圖片
               ├─> bd-5 Windows release asset
               ├─> bd-6 收斂第三方注入面
               │
               └─> change 2  retire-shared-board
                     │
                     └─> change 3  provider-contract-abstraction
                           │
                           └─> （本輪範圍結束，Phase 2 Linear 另議）

bd-7 Rust 依賴：獨立進行，不阻塞任何項目
```

`change 1` 排在小修補之前，是因為它會改動 `test/server.test.mjs` 的既有預期。
先完成它可以避免後續每個修補都要處理同一批測試的衝突。

`change 3` 排在最後，是因為 provider 重構的驗收基礎是「Jira 行為不變」，而該基礎必須建立在已穩定的安全邊界之上。

## 本輪不做的事

- RISK-011 至 RISK-016 不在本輪。它們是 architect.md Phase 3 的前置條件，在沒有 Linear provider、webhook listener 與 Tunnel 的情況下沒有可修補的實作。
- architect.md Phase 2 的 Linear provider 不在本輪。
- architect-v2.md 的 Herdr Operations Portal 路線不在本輪。
- 不引入新的建置工具、測試框架或格式化設定。

## 重新評估條件

- Step 0 發現既有測試在未修改程式碼前即為紅燈。
- `change 1` 的 LAN 退場影響到目前實際使用中的工作流程。
- 未來需要重新支援 WorkBuddy、DeepSeek Harness 或其他第三方 embed host，此時必須採用 Codex embed 的 sandbox 與 handshake，不得還原裸 iframe 實作。
- 決定保留而非退場 Cloudflare shared board，此時 RISK-004 與 RISK-008 必須改走修復路線。
