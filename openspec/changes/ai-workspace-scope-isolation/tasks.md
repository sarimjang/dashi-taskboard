## 1. 更新既有測試斷言以反映新的存取範圍（TDD 紅燈步驟）

- [x] 1.1 更新 test/ai-chat-runner.test.mjs 中「Codex turns use stdin, explicit resume ids, server-owned cwd and sanitized visible events」測試對第一次 turn 的 codex exec 參數斷言（`assert.deepEqual(captures[0].args, ...)`），移除其中指向 "other" project workspace 的 `--add-dir` 項目，改為斷言該參數清單不再包含任何 `--add-dir` 旗標。驗證方式：在完成本任務、尚未完成 2.1 之前單獨執行 `node --test test/ai-chat-runner.test.mjs`，此斷言應為紅燈（因為實作尚未改）。
- [x] 1.2 對同一測試中第二次（resume）turn 的 codex exec 參數斷言（`assert.deepEqual(captures[1].args, ...)`）做相同更新，移除其中的 `--add-dir` 項目。驗證方式：同一次 `node --test test/ai-chat-runner.test.mjs` 執行中，此斷言在完成 2.1 之前同樣應為紅燈。

## 2. 收斂 resolvedWorkspace() 的存取範圍（對應設計文件「收斂 addDirectories 為恆定空陣列，而非重新設計授權機制」）

- [x] 2.1 [P] 修改 server/ai-chat-catalog.mjs 的 `resolvedWorkspace(projectId, project, workspaces)`，讓回傳物件的 `addDirectories` 欄位恆為空陣列 `[]`，不再從 `workspaces.values()` 計算「所有其他已映射 project 的 workspace path」，實現規格要求「AI turn filesystem access SHALL be scoped to the thread's own project workspace」。`workspacePath` 欄位的查找邏輯（`workspaces.get(projectId)`）與既有的 `ApiError(404, "PROJECT_NOT_FOUND", ...)`／`ApiError(409, "PROJECT_WORKSPACE_UNAVAILABLE", ...)` 拋出條件維持不變。驗證方式：重新執行 `node --test test/ai-chat-runner.test.mjs`，1.1 與 1.2 更新後的斷言轉為綠燈。

## 3. 確認修正涵蓋線上與死程式碼路徑，且全 repo 測試維持綠燈

- [x] 3.1 執行完整測試套件 `npm test`，確認所有測試（含 test/ai-chat-runner.test.mjs 中建立 "project" 與 "other" 兩個 project 的 fixture，對應 spec 中「Multiple mapped projects on the same device」情境）全數通過，驗證規格要求「Cross-project filesystem access SHALL NOT be granted implicitly or through an undocumented default」；若本次變更觸及的檔案也被 miniflare-based cloud worker 測試涵蓋，一併執行 `npm run test:cloud` 並確認通過。驗證方式：兩個指令的結束代碼皆為 0，且輸出不含失敗測試。
- [x] 3.2 [P] 追蹤確認 `resolveMappedAiWorkspace()`（server/ai-chat-catalog.mjs，目前零呼叫點的死程式碼）在完成 2.1 後，因為共用同一個 `resolvedWorkspace()` helper，回傳的 `addDirectories` 同樣恆為空陣列，不需要另外修改（對應設計文件「死程式碼 resolveMappedAiWorkspace 隨 helper 一併修正，清理留給既有任務」）。驗證方式：在 handoff 記錄中寫下這項追蹤確認的結論（函式呼叫鏈與程式碼引用），作為本任務的完成證據；不在本 change 內執行 `resolveMappedAiWorkspace()`／`loadMappedWorkspaces()` 本身的死程式碼清理。
