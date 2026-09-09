## Why

`server/ai-chat-catalog.mjs` 的 `resolvedWorkspace(projectId, project, workspaces)` 在解析單一 project 的 AI workspace 時，把「使用者機器上所有已映射 project 的 workspace path（扣掉自己）」全部塞進回傳值的 `addDirectories`。這份清單接著在 `server/ai-chat.mjs` 的 `appServerThreadSettings()` 被原封不動併入 `runtimeWorkspaceRoots`，也在同檔案呼叫 `buildCodexArgs()` 時傳入 `server/ai-chat-process.mjs`，逐一轉成 `--add-dir <directory>` 交給底層 codex 子行程。

結果是：每一次 AI turn 啟動時，被 spawn 出來的 codex 子行程實際拿到的檔案系統存取範圍是「使用者所有已映射 project」的聯集，而不是只有當前對話所屬的那一個 project（codex-security scan 0e8da15f，CWE-863）。在本專案大量使用 bypassPermissions agent 的操作模式下，任何一個 project 的 AI 對話被誘導執行惡意操作時，blast radius 涵蓋使用者機器上所有其他已映射的 project，不只當前 project。

這不是一個被刻意設計出來的跨 project 功能：現有程式碼與測試都找不到任何依賴這個「可看到其他 project」行為的產品功能；唯一提到它的地方是 test/ai-chat-runner.test.mjs 裡一個測試，把這個外洩行為（codex exec 參數含有指向另一個 project workspace 的 --add-dir）當成理所當然的預期輸出斷言下來——這說明它是早期實作沒收斂範圍所留下的預設行為，而非審慎設計的能力。

## What Changes

- `resolvedWorkspace()`（server/ai-chat-catalog.mjs）不再把「其他已映射 project 的 workspace path」塞進 `addDirectories`；`addDirectories` 改為恆定回傳空陣列，AI turn 的檔案系統存取範圍收斂為僅其所屬 project 的 workspace。
- 這個修正對線上路徑 `resolveAiWorkspace()`（經 AiChatService 與 server/app.mjs 呼叫）與零呼叫點的死程式碼 `resolveMappedAiWorkspace()`（dashi-taskboard-rxd 待清理項目）同時生效，因為兩者共用同一個 `resolvedWorkspace()` helper，不需要分別修改各自的呼叫端。
- **BREAKING**：任何依賴「AI 對話可讀寫其他已映射 project workspace」這個隱性行為的使用方式，從此版本起將不再運作；跨 project 存取明確判定為不支援，不提供替代的顯式授權機制（理由見 Non-Goals）。
- 更新 test/ai-chat-runner.test.mjs 中斷言 codex exec 參數含有指向另一個 project workspace 的 --add-dir 的既有測試，改為斷言該參數清單不再包含任何 --add-dir。

## Non-Goals

- 不新增任何跨 project 顯式授權 UI 或設定機制。針對 server/ 與 test/ 目錄搜尋 addDirectories、runtimeWorkspaceRoots、loadMappedWorkspaces、resolveMappedAiWorkspace 等識別字後，沒有發現任何產品功能、UI 或既有測試明確依賴/驗證「AI 對話需要存取其他 project」這個能力；唯一斷言到這個行為的測試只是把當時的預設實作行為原封不動記錄下來，並非在驗證一個被設計出來的跨 project 功能。因此本次不做「顯式白名單／使用者主動授權」的擴充設計——移除跨 project 的隱式全開，就是完整且正確的解法。
- 不在本 change 內清理 `resolveMappedAiWorkspace()` 與 `loadMappedWorkspaces()` 死程式碼（dashi-taskboard-rxd 既定範圍）；本 change 只確保它們共用的 `resolvedWorkspace()` helper 本身不再洩漏跨 project 路徑，不順便處理該死程式碼本身的移除。
- 不變更 server/app.mjs 中 `resolveAiChatContext()` 對預設 project workspace 不可用時的 fallback 邏輯——該 fallback 本來就手動把 addDirectories 設為空陣列，行為已經與本次修正後的預設一致。

## Capabilities

### New Capabilities

- `ai-workspace-access-scope`: 定義 AI 對話 turn 的檔案系統存取範圍規則——每次 AI turn 啟動時，codex 子行程只能存取其所屬 project 的 workspace，不含任何其他已映射 project 的路徑，且不提供跨 project 存取機制。

### Modified Capabilities

（無：openspec/specs/ 目前沒有既有 capability 涵蓋這個行為）

## Impact

- Affected specs: `ai-workspace-access-scope`（新建）
- Affected code:
  - Modified: server/ai-chat-catalog.mjs（`resolvedWorkspace()` 函式本體）
  - Modified: test/ai-chat-runner.test.mjs（更新對 codex exec 參數中 --add-dir 的既有斷言）
  - Verified no change needed: server/ai-chat.mjs（`appServerThreadSettings()`、`buildCodexArgs()` 呼叫點）、server/ai-chat-process.mjs（`buildCodexArgs()`）、server/app.mjs（`resolveAiChatContext()` fallback 邏輯）
