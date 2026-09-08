# Handoff：Hard Fork 前置作業完成，待啟動 Herdr

## 這份文件的定位

本文件只記錄「現在狀態與下一步」。決策細節、風險證據、架構目標都在 `docs/planning/`，不重複搬過來。

| 文件 | 內容 |
| --- | --- |
| [`docs/planning/handoff.md`](./docs/planning/handoff.md) | 上一輪（hard fork 決策拍板時）的 handoff，決策背景仍然有效 |
| [`docs/planning/fork-plan.md`](./docs/planning/fork-plan.md) | 執行計畫本體：Step 0-3、bd-1~7、change 1~3、依賴圖。**2026-09-04 已修正六處與程式碼不符的地方**（bd-6 範圍、bd-4/bd-5 行號、Step 0 前提、Step 1 硬編 URL 清單、change 1 第二處 host 檢查），已 commit |
| [`docs/planning/risk-assessment.md`](./docs/planning/risk-assessment.md) | RISK-001~016 證據 |
| [`docs/planning/architect.md`](./docs/planning/architect.md) | V1 目標架構 |
| CLAUDE.md / AGENTS.md 的「Linear Sync」段落 | `bd linear sync --push` 批次模式已知會全數 skip 的 workaround |

## 已完成（不要重做）

1. **Git remote 已切換**：`origin` → `https://github.com/sarimjang/dashi-taskboard.git`（已確認存在），`upstream` 保留唯讀指向 `chuspeeism/dashi-taskboard`。
2. **Step 0 完成**：`npm ci` 裝了 368 個套件，`npm test` baseline 綠燈。`test/inject-fullheight-regression.test.mjs` 在全套件併發下曾出現一次失敗，單獨重跑與整套重跑各驗證過一次都是綠燈，判定為環境層 flaky，記錄在 CLAUDE.md / AGENTS.md 的 Build & Test 段落。
3. **Beads 與 Spectra 已初始化**：`bd init`、`spectra init --tools claude,codex`，`.spectra.yaml` 開了 `claude_slash_commands`、`worktree`。
4. **計畫文件已歸檔**：七份原本在 repo 根目錄的規劃文件移到 `docs/planning/`，內部相對連結未受影響。`.codex-tmp/`、`.omc/` 已加入 `.gitignore`。
5. **7 個 bd issue 已建立**（依 `fork-plan.md` 逐項，見下表），且已推上 Linear。
6. **Linear project 已建立**：`dashi-taskboard · Hard Fork Delivery`（Mebase team，project id `2a9d8cd6-15e4-4a5c-988f-89e0871fd861`，team id `16a27a53-b8a6-439a-b21e-c89ee7a9e49c`），Beads 為 SSOT，`bd config` 已設好 `linear.team_id`、`linear.project_id`、`linear.state_map.*`、`linear.priority_map.*`。
7. **`loopback-security-baseline`（Spectra change 1）已 propose 並 park**：proposal / design / specs / tasks 四份 artifact 齊全，`spectra analyze` 只有 7 個 Suggestion 級建議（缺具體範例，無 Critical/Warning），`spectra validate` 通過。`spectra list --parked` 可查到，跑 `/spectra-apply loopback-security-baseline` 會自動 unpark。
8. **`~/.zshrc` 修過一個環境問題**：Claude Code 的 Bash 工具會強制 `setopt NO_BARE_GLOB_QUAL`，這會讓 oh-my-zsh 的 `pattern(N)` 語法報錯並中斷 `.zshrc` 剩餘內容的執行（你的 `export LINEAR_API_KEY=...` 在後面因此讀不到）。已在 `~/.zshrc` Homebrew 那行之後加 `setopt BARE_GLOB_QUAL` 修好，不影響一般互動式 terminal。**注意：這個修正只對新開的 session 生效**，同一個 session 裡若殼是舊的，仍需手動 `source ~/.zshrc` 才讀得到新環境變數。

### 7 個 bd issue

| bd id | Linear | 內容 | Priority |
| --- | --- | --- | --- |
| `dashi-taskboard-1ak` | MEB-616 | RISK-002 injector profile 目錄 | P1 |
| `dashi-taskboard-7mj` | MEB-618 | RISK-006 Jira 強制 HTTPS | P1 |
| `dashi-taskboard-cov` | MEB-617 | RISK-009 移除 WorkBuddy/DeepSeek | P1 |
| `dashi-taskboard-cnw` | MEB-620 | RISK-005 外部圖片收斂 | P2 |
| `dashi-taskboard-cwj` | MEB-619 | RISK-007 Windows release asset | P2 |
| `dashi-taskboard-rgw` | MEB-621 | RISK-003 js-yaml 升版 | P2 |
| `dashi-taskboard-coh` | MEB-622 | RISK-010 Rust 依賴監控 | P3 |

## 下一步：啟動 Herdr

使用者已表態要啟動 Herdr 的 resident-PM 多代理工作流，上一輪對話結束在「等使用者確認是否現在跑 `/herdr`」，**尚未回覆**。

啟動前的檔案佈局判斷（供接手 agent 參考，不是待辦）：

- P1 三項（`dashi-taskboard-1ak`、`7mj`、`cov`）彼此檔案不重疊，理論上可並行分派到不同 worktree。
- change 1 `loopback-security-baseline` 動 `server/app.mjs` 與 `test/server.test.mjs`；`dashi-taskboard-1ak`（injector）、`7mj`（jira-config.mjs）不衝突，但任何同樣動 `server/app.mjs` 的項目要序列化，避免併發寫入同檔。
- `dashi-taskboard-cov`（移除 WorkBuddy/DeepSeek）動 `web/src/App.tsx`、`web/src/api.ts`，與 change 1 不衝突。

## 已知的坑（來自本輪 session，不在 `docs/planning/` 裡）

1. **`bd linear sync --push` 批次模式會把全部 issue 判定為 `skipped`**，即使 `linear.state_map.*`／`linear.priority_map.*` 都設好了。原因未查出。Workaround：改用 `bd linear push <id> [<id>...]` 逐筆指名推送，這個方式驗證過對 7 個 issue 都成功。細節記在 CLAUDE.md / AGENTS.md 的「Linear Sync」段落，**不要重新踩一次這個坑去查批次模式為什麼壞掉**，除非要順手修 bd 本身。
2. **`LINEAR_API_KEY` 只能放環境變數**，不能 `bd config set linear.api_key`，因為 `.beads/config.yaml` 預設會被 git 追蹤，這個 fork 是要推上公開 remote 的。
3. **這個 Bash 工具的 shell 初始化用的是 session 開始時的 snapshot**，不是即時重讀 `~/.zshrc`。同一個 session 裡要用新 export 的環境變數，得在該次指令裡手動 `source ~/.zshrc`。
4. **fork-plan.md 的行號引用曾經跟實際程式碼對不上**（bd-4、bd-5 的行號、bd-6 的刪除範圍），已在 2026-09-04 用 Codex 獨立複核並修正，細節見 `docs/planning/fork-plan.md` 開頭的修正紀錄。之後若又發現行號跟程式碼對不上，優先假設是程式碼在這之後又變了，重新核對一次，不要照抄舊行號動刀。

## 建議 skills

| 時機 | Skill | 用途 |
| --- | --- | --- |
| 啟動多代理派工 | `herdr` | 前置作業已全數完成，`HERDR_ENV=1` 已設，可直接啟動 |
| Herdr 內對每個 bd issue / change 動工前 | `/spectra:apply`（跨模組）或直接改（單點） | change 1 已 park，跑 `/spectra-apply loopback-security-baseline` 會自動 unpark |
| 完成一批修補後 | `security-review` | 驗證 RISK-001~010 是否真的關閉 |
| 動到 Tauri / Vite / Linear API 版本細節時 | `context7` MCP | 不要憑記憶回答版本相關問題 |
| 大範圍符號重構（change 3 provider abstraction） | `serena` MCP | 移除散落的 `source === "jira"` 判斷（現況：12 處，web 6、`app.mjs` 5、`database.mjs` 1） |
| 踩到新坑時 | 更新本檔「已知的坑」段落，或 `~/.claude/harness/PITFALLS.md` | 依內容性質二選一：專案特定坑留這裡，通用坑進 harness |
