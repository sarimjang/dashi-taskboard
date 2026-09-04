# Handoff：Dashi Taskboard Hard Fork 與風險修補

## 這份文件的定位

本文件只記錄「決策與現在該做什麼」。
計畫細節不在這裡，全部在 [`fork-plan.md`](./fork-plan.md)，請先讀它。

| 文件 | 內容 | 何時讀 |
| --- | --- | --- |
| [`fork-plan.md`](./fork-plan.md) | 本輪執行計畫、Step 0-3、bd-1~7、change 1~3、依賴圖 | **接手時必讀** |
| [`risk-assessment.md`](./risk-assessment.md) | RISK-001~016 的證據、嚴重度、攻擊前提 | 動手修某條風險前 |
| [`architect.md`](./architect.md) | V1 目標架構：Jira/Linear provider、webhook ingress | 做 change 3 前 |
| [`architect-v2.md`](./architect-v2.md) | V2 路線：Herdr Operations Portal | **本輪不涉及** |
| [`investigate.md`](./investigate.md) | Codex App Server、CDP、Desktop bridge 調查 | 動到 injector 時 |
| [`herdr-comparison.md`](./herdr-comparison.md) | Taskboard 與 Herdr 能力邊界 | 本輪不涉及 |

## 使用者已拍板的決策（不要重新討論）

1. **Hard fork，切斷上游。** 因此「刪除功能」是合法的風險消解手段，不需要保持 patch 可 upstream。
2. **本輪範圍是 RISK-001 ～ RISK-010。** RISK-011~016 是 architect.md Phase 3 的驗收條件，目前 repo 沒有 Linear provider、webhook listener 或 Tunnel，沒有對應實作可修。
3. **變更管理採混合制。** 單點修補走 Beads，跨模組退場與 provider 重構走 Spectra。
4. **WorkBuddy 與 DeepSeek Harness 都沒在用，一併刪除。**（bd-6）

## 目前狀態

- **尚未寫任何程式碼。** 本次 session 只做了調查與計畫。
- Git 乾淨在 `main`，未 commit。未追蹤檔案：`architect.md`、`architect-v2.md`、`herdr-comparison.md`、`investigate.md`、`risk-assessment.md`、`fork-plan.md`、`handoff.md`、`.codex-tmp/`。
- `origin` 仍直接指向 upstream `chuspeeism/dashi-taskboard`，**個人 fork remote 尚未建立**。
- 沒有 `.spectra.yaml`，沒有 `openspec/`，Beads 尚未在本 repo 初始化。
- `gh` 已登入帳號 `sarimjang`。

## 下一步：Step 0（阻塞後續所有工作）

細節見 `fork-plan.md` 的 Step 0。使用者在 session 結束時正被詢問是否開始，尚未回覆。

Step 0 存在的原因是 `risk-assessment.md` 記錄 component tests 與 cloud worker tests 因缺少 `vitest` 與 `miniflare` 而無法重跑。
**在測試迴圈可用之前不要動任何程式碼**，否則沒有驗收基礎。

## 本次 session 查證過的事實（可直接引用，不必重查）

- `server/app.mjs:1640` `resolveHost` 預設值確為 `"0.0.0.0"`。
- `package.json:48` `js-yaml` 確為 `4.1.1`。
- `scripts/codex-injector.mjs:37-41` 固定路徑 `codex-taskboard-independent-profile-v2`，macOS 走 `/private/tmp`，Linux 走 `os.tmpdir()`。
- `LICENSE` 是未修改的 Apache 2.0 全文（201 行），無 `NOTICE` 檔，`LICENSE:189` 版權人從未填寫。授權不是阻塞項。
- `hostContext` 有兩個 setter：`web/src/App.tsx:1725` 的 postMessage handshake 服務 Codex embed，`web/src/App.tsx:1755` 每秒輪詢只服務 WorkBuddy。
- `web/src/api.ts:216` `getHostRuntime` 的唯一呼叫端是 WorkBuddy 那個輪詢。
- `integrations/deepseek-harness/` 只被 `web/src/App.tsx:375` 與 `:685` 引用，不由本 repo build 產出。

## 三個容易踩的坑

1. **Tauri updater 必須換掉。** `src-tauri/tauri.conf.json` 的 updater endpoint 與 signing public key 若沿用上游，你打包的 App 會被上游推的更新覆蓋。這是 hard fork 最貴的漏網之魚。
2. **`test/server.test.mjs` 目前明確驗證「普通 API 對 LAN client 可用」。** 修 RISK-001 是刻意的行為變更，那批測試必須在同一個 change 內改寫。**不得停用測試代替修復。**
3. **刪 WorkBuddy 時要保留 `embedded` 抽象**（`web/src/App.tsx:685`）。Codex embed 依賴它，只是把 `workbuddy` 與 `deepseek-harness` 從 union 移除，不是拆掉整個機制。

## 使用者的協作偏好（本次 session 觀察到）

- 直說結論，不要鋪陳。已設定 Concise output style，回應用繁體中文。
- **不要用不必要的問題擋住流程。** 本次因為詢問 deepseek-harness 是否在使用而被質疑——在 hard fork 且刪除可逆的前提下，正確做法是直接建議刪除並附註可還原，而不是停下來等答覆。範圍類問題若使用者已回答過一次，不要換個對象再問一次。
- 會追問文件裡出現的名詞（LICENSE、WorkBuddy），期待的是「它是什麼、用途為何、對我們的決策有何影響」的完整解釋，不是一句帶過。
- 推論與事實要分開標示。

## Suggested skills

| 時機 | Skill | 用途 |
| --- | --- | --- |
| Step 0 之後每個 change | `/spectra:propose` → `apply` → `audit` → `archive` | change 1~3 走正典 spec 流程。需先在本 repo `spectra init` |
| bd-1~7 | Beads（`bd create` / `bd ready` / `bd close`） | 單點修補追蹤。**不要用 TodoWrite 或 markdown 清單** |
| 修補完成後 | `security-review` | 驗證 RISK-001~010 確實關閉，而非表面修掉 |
| change 3 provider 重構 | `tdd` | Jira 行為不變是驗收基礎，先寫 characterization test |
| change 1 與 change 3 完成後 | `/code-review` | 跨模組變更需獨立審查 |
| 動到 Tauri / Vite / Linear API 時 | `context7` MCP | **不要憑記憶回答版本相關問題** |
| 大範圍符號重構（change 3） | `serena` MCP | 移除散落的 `source === "jira"` 判斷 |
| 踩坑時 | append `~/.claude/harness/PITFALLS.md` | 格式見 `harness/F-KNOWLEDGE-PROTOCOL.md` |

## 明確不在本輪範圍

- RISK-011 ～ RISK-016（architect.md Phase 3 的前置條件）
- architect.md Phase 2 的 Linear provider
- architect-v2.md 的 Herdr Operations Portal 路線
- 引入新的建置工具、測試框架或格式化設定
