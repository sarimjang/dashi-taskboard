## Context

`server/ai-chat-catalog.mjs` 的 `resolvedWorkspace(projectId, project, workspaces)` 是唯一一個計算「AI 對話 turn 該有多少檔案系統存取範圍」的地方。它同時被兩個對外函式呼叫：`resolveAiWorkspace()`（線上路徑，由 `AiChatService` 建構子預設的 `resolveContext` 呼叫，也是 `server/app.mjs` 手動組出 fallback context 時的主要路徑）與 `resolveMappedAiWorkspace()`（目前在整個程式庫中零呼叫點的死程式碼，對應另一個待清理項目 dashi-taskboard-rxd）。

目前 `resolvedWorkspace()` 把 `addDirectories` 設成「所有已映射 project 的 workspace path 集合，扣掉自己」。這份清單經 `server/ai-chat.mjs` 的 `appServerThreadSettings()` 併入 `runtimeWorkspaceRoots`，也經同檔案呼叫 `buildCodexArgs(thread, resolved.addDirectories, imagePaths)` 傳入 `server/ai-chat-process.mjs`，逐一轉成 `--add-dir <directory>` 交給底層 codex 子行程（`exec`/`resume` 指令列）。也就是說，每次 AI turn 啟動時，codex 子行程實際能存取的檔案系統範圍是「使用者所有已映射 project」的聯集，而不是只有當前對話所屬的那一個 project。

調查已確認：整個 server/ 與 test/ 目錄底下，沒有任何程式碼路徑或測試明確依賴「AI 對話需要讀取其他 project workspace」這個能力。唯一提到這個行為的地方，是 test/ai-chat-runner.test.mjs 一個測試把當前實作行為（codex exec 參數含有指向另一個 project workspace 的 --add-dir）原封不動記錄成預期輸出，並非驗證一個刻意設計的跨 project 功能。`server/app.mjs` 裡 `resolveAiChatContext()` 對預設 project workspace 不可用時的 fallback，本身就手動把 `addDirectories` 設為空陣列，等於已經有一條程式碼路徑在實踐「這個欄位理應是空的」這個假設。

## Goals / Non-Goals

**Goals:**

- AI 對話 turn 啟動 codex 子行程時，檔案系統存取範圍（`runtimeWorkspaceRoots`、codex exec 參數上的 `--add-dir`）只包含該 turn 所屬 project 的 workspace，不包含任何其他已映射 project 的路徑。
- 這個收斂對線上路徑與死程式碼路徑（共用同一個 `resolvedWorkspace()` helper）同時生效，不需要分別修正兩個對外函式。
- 更新既有測試，讓它斷言收斂後的行為，而不是繼續把外洩行為當成預期輸出保留下來。

**Non-Goals:**

- 不設計、不實作任何跨 project 顯式授權機制（白名單、使用者主動勾選、設定檔開關等）。調查沒有找到任何需要保留的合理跨 project 使用情境；在證據不支持的情況下發明一個新的授權子系統，屬於過度設計。
- 不在本 change 內清理 `resolveMappedAiWorkspace()`／`loadMappedWorkspaces()` 這兩個零呼叫點的死程式碼本身（維持給 dashi-taskboard-rxd 處理），只確保它們共用的 `resolvedWorkspace()` helper 不再對外洩漏跨 project 路徑。
- 不變更 `server/app.mjs` 中 `resolveAiChatContext()` 的 fallback 邏輯或其他呼叫端的函式簽章／參數形狀——`addDirectories` 欄位本身保留，只改變它的值恆為空陣列，讓 `appServerThreadSettings()`、`buildCodexArgs()`、`server/ai-chat-process.mjs` 的 `--add-dir` 迴圈完全不需要異動。

## Decisions

### 收斂 addDirectories 為恆定空陣列，而非重新設計授權機制

`resolvedWorkspace()` 回傳值的 `addDirectories` 欄位，不再從 `workspaces.values()`（所有已映射 project 的 workspace 集合）計算，改為固定回傳空陣列。

理由：
- 這是能通過驗收標準（AI turn 檔案系統存取範圍限縮為僅其所屬 project）的最小修改——只改一個函式裡的一行運算邏輯，不新增任何抽象層、新檔案或新依賴。
- 調查確認沒有任何依賴「跨 project 存取」的產品功能或測試，因此不需要為了保留一個不存在的使用情境而設計顯式授權機制。
- `workspaces`（多 project 對照表）本身仍然必要——它是 `resolvedWorkspace()` 用來查出「目前這個 projectId 自己的 workspacePath」的手段（`workspaces.get(projectId)`），這部分邏輯不變，只有拿它去列舉「其他所有 project」這個副作用被移除。

備選方案（已考慮並放棄）：把 `addDirectories`／`runtimeWorkspaceRoots`／`--add-dir` 整條管線（`server/ai-chat.mjs`、`server/ai-chat-process.mjs`、`server/app.mjs`）都拔掉，因為修正後它們永遠是空的。放棄理由：這會多動 3 個檔案、移除既有介面形狀，卻對可觀察行為沒有任何額外差異（結果一樣是「不會有 --add-dir」），純粹增加變更面積與回歸風險，不符合最簡可行解原則；保留這條管線的形狀，未來若真的要做顯式跨 project 授權，也有現成的介面可以重新啟用，而不需要重新設計傳遞路徑。

### 死程式碼 resolveMappedAiWorkspace 隨 helper 一併修正，清理留給既有任務

`resolveMappedAiWorkspace()` 與 `loadMappedWorkspaces()` 目前在整個程式庫零呼叫點（已用全域搜尋確認），是另一個待清理項目 dashi-taskboard-rxd 的範圍。因為它們呼叫的正是同一個 `resolvedWorkspace()` helper，本次修正會自動讓它們的回傳值也不再外洩跨 project 路徑，不需要也不應該在這個 change 裡額外處理死程式碼移除本身——那是不同性質的工作（程式碼清理 vs. 安全收斂），混在一起會模糊這個 change 的驗收範圍。

### 更新既有測試斷言以反映新的存取範圍

test/ai-chat-runner.test.mjs 裡「Codex turns use stdin, explicit resume ids, server-owned cwd and sanitized visible events」這個測試的 fixture 建立了兩個 project（"project" 與 "other"），並且斷言 codex exec 參數清單裡含有指向 "other" project workspace 的 `--add-dir` 項目（在第一次與第二次 turn 的參數斷言各出現一次）。這兩處斷言必須改成：參數清單裡不再含有任何 `--add-dir` 項目。fixture 本身（建立兩個 project、兩個 workspace 目錄）予以保留，因為它同時也在驗證「resolvedWorkspace 能正確查到當前 project 自己的 workspacePath」這件事（`thread.origin.workspacePath` 斷言），與本次修正的驗收目標互補：即使裝置上映射了多個 project，當前 project 的路徑解析仍然正確，只是不再外溢到其他 project。

## Implementation Contract

**行為（Behavior）**：呼叫 `resolvedWorkspace(projectId, project, workspaces)`（或透過 `resolveAiWorkspace()`／`resolveMappedAiWorkspace()` 間接呼叫）時，回傳物件的 `addDirectories` 欄位一律為空陣列 `[]`，不論 `workspaces` 這個 Map 裡有多少個其他 project 的紀錄。

**介面／資料形狀（Interface / data shape）**：
- `resolvedWorkspace()` 回傳形狀不變（仍是 `{ workspacePath, addDirectories, project }`），只有 `addDirectories` 的值改變。
- `appServerThreadSettings(thread, resolved)`（server/ai-chat.mjs）產出的 `runtimeWorkspaceRoots` 陣列，長度恆為 1，內容只有 `resolved.workspacePath`。
- `buildCodexArgs(thread, addDirectories, imagePaths)`（server/ai-chat-process.mjs）在 `addDirectories` 為空陣列時，不會產生任何 `--add-dir` 參數；因為 `addDirectories` 一律為空，這條路徑的既有迴圈邏輯不需要修改，只是永遠不會執行迴圈本體。

**失效模式（Failure modes）**：本次修正不新增任何錯誤路徑或例外情況；`resolvedWorkspace()` 既有的 `ApiError(404, "PROJECT_NOT_FOUND", ...)` 與 `ApiError(409, "PROJECT_WORKSPACE_UNAVAILABLE", ...)` 拋出條件不變。

**驗收標準（Acceptance criteria）**：
- test/ai-chat-runner.test.mjs 中兩處對 codex exec 參數的 `assert.deepEqual` 斷言，更新後跑起來要綠燈，且清單裡不含任何 `--add-dir` 項目。
- 全 repo 執行 `npm test` 全部通過（含 node --test 與 vitest 部分）。
- 手動或以既有測試驗證：`resolvedWorkspace()` 在 `workspaces` Map 內有 2 個以上 project 紀錄時，回傳的 `addDirectories` 仍為 `[]`。

**範圍邊界（Scope boundaries）**：
- 範圍內：`server/ai-chat-catalog.mjs` 的 `resolvedWorkspace()` 函式本體；test/ai-chat-runner.test.mjs 中對應的既有斷言更新。
- 範圍外：`resolveMappedAiWorkspace()`／`loadMappedWorkspaces()` 死程式碼本身的移除；`server/ai-chat.mjs`、`server/ai-chat-process.mjs`、`server/app.mjs` 的函式簽章或呼叫方式；任何新的跨 project 授權 UI／設定機制。

## Risks / Trade-offs

- [風險] 如果未來真的有合理的跨 project 使用情境被提出，需要重新設計一個顯式授權機制，屆時是全新的功能開發，而不是「打開一個開關」這麼簡單 → 緩解：`resolvedWorkspace()` 與其下游管線（`runtimeWorkspaceRoots`、`buildCodexArgs`、`--add-dir`）的介面形狀刻意保留不動，只是值恆為空，未來要做顯式授權時，管線本身不需要重新設計，只需要決定「什麼情況下允許哪些其他 project 進入 addDirectories」這一個決策點。
- [風險] test/ai-chat-runner.test.mjs 的既有斷言若只改一半（例如只改第一次 turn 沒改第二次 turn的斷言），會造成測試繼續綠燈但沒有真正涵蓋 resume 路徑 → 緩解：Implementation Contract 明確列出兩處斷言都要更新，tasks.md 會拆成可獨立驗證的項目。

## Migration Plan

不需要資料遷移。`addDirectories` 不會被持久化在 thread 記錄裡——它是每次 `startTurn`／`resumeThread` 呼叫 `resolveContext()` 時即時算出來的（`server/ai-chat.mjs` 多處呼叫點），因此既有已建立的 AI 對話 thread 不需要任何資料轉換；效果只會反映在「這個修正部署之後的下一次 AI turn」上，該次 turn 啟動的 codex 子行程即不再取得其他 project 的路徑。

部署步驟：正常隨程式碼發布走既有部署流程，無需搭配資料庫遷移或功能旗標。

回滾方案：revert 對 `resolvedWorkspace()` 的修改（還原 `addDirectories` 計算邏輯）與對應測試斷言即可完整回滾，屬於單一函式層級的變更，風險低。

## Open Questions

（無：調查已確認範圍與解法，沒有需要在 apply 前另外決議的未知數）
