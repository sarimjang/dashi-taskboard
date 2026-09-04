# Codex App 介接機制調查

## 文件狀態

本文件記錄截至 2026-08-26 為止，本 repository 使用的 Codex App 介接面，以及本次討論與調查所收集的證據。
檢視的 repository revision 是 `main` 上的 `5c96d1ab698362994283ba0af86021db0a98dd89`。
用來驗證協定的本機 Codex CLI 版本是 `codex-cli 0.149.1`。
本文件會明確區分直接證據、合理推論與目前仍無法確認的事項。
本文件描述的是目前版本的實作快照，不代表 OpenAI 對未來版本所作的相容性承諾。

## 調查問題

這個 repository 為了把 Taskboard 嵌入 Codex App、開啟原生 Codex 對話，以及和 Codex 執行環境通訊，使用了哪些官方、實驗性、公開標準或非公開介面？

## 分類定義

本文件使用「官方發行」表示該功能由 OpenAI 隨 Codex CLI 或 Codex App 發布。
本文件只有在介面具有公開參考文件與明確對外契約時，才稱其為「公開文件化 API」。
本文件使用「實驗性介面」表示官方執行檔有提供該介面，但官方工具本身將其標示為 experimental。
本文件使用「非公開介面」表示該介面是 renderer bridge、訊息格式、URL 行為、DOM marker 或其他沒有公開相容性契約的實作細節。
本文件使用「公開平台協定」表示該技術由 Chromium 或 Electron 等平台公開文件化，但它並不是 Codex 的 extension API。

因此，一個介面可以由官方發行，同時仍然不是穩定且公開支援的第三方整合 API。

## 核心結論

| 排名 | 結論 | 信心 | 分類 | 主要依據 |
| --- | --- | --- | --- | --- |
| 1 | 本 repository 會直接啟動並呼叫 `codex app-server`。 | 高 | 官方發行、實驗性、可產生機器可讀協定 | CLI help、產生的 Schema、`server/codex-app-server.mjs` |
| 2 | 較完整的 Codex Desktop 整合依賴非公開 renderer 與 host 介面。 | 高 | Codex Desktop 非公開實作 | `window.electronBridge`、內部訊息、URL handler、DOM marker 與測試 |
| 3 | Launcher 另有一條不使用 CDP 的路徑，透過 deep link 要求 Codex 在原生 browser pane 開啟 Taskboard。 | 高 | 非公開 Codex deep-link 行為 | `codex://threads/new?browserUrl=...` |
| 4 | CDP 提供 renderer 層級的執行與注入能力，但 CDP 本身不是 Codex App API。 | 高 | 公開 Chromium 協定，用於非官方 Codex 整合面 | `scripts/codex-injector.mjs` 中的 CDP 連線與命令 |
| 5 | `window.electronBridge` 很可能由 Electron preload 的 `contextBridge` 暴露，並由 Electron IPC 接到主程序。 | 中 | 架構推論 | 介面外型符合 Electron 標準模式，但沒有取得可閱讀的 Codex preload 原始碼 |
| 6 | 現有證據無法證明 OpenAI 對 Desktop bridge、deep link、內部訊息或 DOM marker 承諾相容性。 | 高 | 未知的公開契約 | 官方文件搜尋沒有找到對應的 protocol reference |

## 三條實際整合路徑

```text
無 CDP 的 browser-pane 路徑

Taskboard launcher
  -> codex://threads/new?browserUrl=<Taskboard URL>
  -> Codex App 原生 browser pane
  -> Taskboard Web UI

CDP injection 路徑

Taskboard launcher
  -> Chrome DevTools Protocol
  -> Codex renderer
     -> 注入 codex-taskboard.user.js
     -> 建立原生風格 sidebar entry 與 Taskboard iframe
     -> 呼叫 window.electronBridge 與 renderer 內部訊息
     -> 使用 Codex 原生 route、project、automation 與 App Server bridge

Taskboard 本地 AI 路徑

Taskboard Node service
  -> 啟動 codex app-server --stdio
  -> 以逐行 JSON 傳送 request、response 與 notification
  -> 操作 Codex thread、turn、skill 與 compaction
```

Browser pane 與 CDP injection 是兩條替代路徑，不是必須依序執行的兩個階段。
Taskboard 本地 AI 使用的直接 App Server 路徑也不依賴 renderer 注入。

## 介面總表

| 本 repository 使用的介面 | 分類 | 用途 | 證據 |
| --- | --- | --- | --- |
| `codex app-server --stdio` | 官方發行、實驗性 | 從 Taskboard service 執行 Codex thread 與 turn | `server/codex-app-server.mjs:94-139` |
| App Server JSON request 與 notification protocol | 官方發行、實驗性 | 初始化、讀取 skill、管理 thread、管理 turn 與壓縮 context | `server/codex-app-server.mjs:37-64`、`server/codex-app-server.mjs:141-220` |
| App Server JSON Schema 與 TypeScript binding generator | 官方發行、實驗性工具 | 取得與目前 CLI 版本相符的協定定義 | `codex app-server generate-json-schema`、`codex app-server generate-ts` |
| `codex://threads/new?browserUrl=...` | 非公開 Codex deep link | 在無 CDP 時於 Codex 原生 browser pane 開啟 Taskboard | `scripts/codex-injector.mjs:2122-2141` |
| `codex://threads/new?path=...&prompt=...` | 非公開 Codex deep link | 從獨立 Taskboard 開啟新的原生 Codex 對話 | `web/src/App.tsx:2999-3012` |
| `codex://threads/<thread-id>` | 非公開 Codex deep link | 開啟已記錄的原生 Codex thread | `web/src/App.tsx:2837-2860` |
| Chrome DevTools Protocol | 公開 Chromium 協定，不是 OpenAI API | 尋找 renderer、注入 script、略過 CSP、建立 binding、執行 JavaScript、送出鍵盤事件與截圖 | `scripts/codex-injector.mjs` |
| `window.electronBridge.getInitialSidebarBootstrap()` | 非公開 Codex Desktop bridge | 讀取 project 與 sidebar bootstrap state | `inject/codex-taskboard.user.js:482-507`、`inject/codex-taskboard.user.js:981-989` |
| `window.electronBridge.sendMessageFromView(...)` | 非公開 Codex Desktop bridge | 傳送內部 request 與原生 workspace action | `inject/codex-taskboard.user.js:431-472`、`inject/codex-taskboard.user.js:1066-1100` |
| `type: "fetch"` 搭配 `vscode://codex/...` | 非公開 Codex Desktop message envelope | 讀取 global state 與管理 Codex automation | `scripts/codex-injector.mjs:959-1037`、`inject/codex-taskboard.user.js:431-472` |
| `type: "mcp-request"` 與 `type: "mcp-response"` | 非公開 Codex Desktop message envelope | 經過指定 Codex host 轉送 App Server 類型的 request | `scripts/codex-injector.mjs:1045-1130` |
| `type: "electron-add-new-workspace-root-option"` | 非公開 Codex Desktop action | 選擇或新增原生 Codex workspace root | `inject/codex-taskboard.user.js:1089-1095` |
| `type: "navigate-to-route"` | 非公開 renderer message | 導航至 Codex 原生 route 並預填 composer | `inject/codex-taskboard.user.js:799-801`、`inject/codex-taskboard.user.js:1099-1108` |
| `type: "toggle-browser-panel"` | 非公開 renderer message | 暫時關閉並恢復 Codex 原生 browser pane | `inject/codex-taskboard.user.js:1629-1665` |
| Codex DOM `data-*` marker | 非公開 renderer 結構 | 尋找 project、thread、composer、browser pane、sidebar 與頁面掛載點 | `inject/codex-taskboard.user.js`、`scripts/codex-injector.mjs:1446-1538` |
| Taskboard isolated-world host binding | 本 repository 自有協定 | 連接注入頁面與 Taskboard launcher process | `scripts/codex-injector.mjs:80-89`、`scripts/codex-injector.mjs:1657-1753` |
| Taskboard iframe `postMessage` | 本 repository 自有協定 | 在 Taskboard UI 與注入的 host page 之間交換狀態與 action | `inject/codex-taskboard.user.js:791-828` |
| Loopback companion HTTP service | 本 repository 自有協定 | 提供本機驗證、path mapping、Git、Skill、MCP 與裝置能力 | `README.md:47-52`、`README.md:193-199` |

## 官方發行但仍屬實驗性的 Codex App Server

### 直接證據

本機 `codex app-server --help` 將該命令描述為 `[experimental] Run the app server or related tooling`。
該命令以 `stdio://` 作為預設 transport，並另外列出 `unix://`、`ws://IP:PORT` 與 `off`。
同一命令提供 `generate-json-schema` 與 `generate-ts` 兩個 protocol generator。
`generate-json-schema` 可以透過 `--experimental` 包含實驗性 method 與 field。

本次調查實際執行了 Schema generator。
產物包含 `ClientRequest.json`、`ServerRequest.json`、`ClientNotification.json`、`ServerNotification.json`、JSON-RPC message schema、整合後的 protocol bundle，以及數百個 versioned parameter 與 response schema。
`codex-cli 0.149.1` 產生的 `ClientRequest.json` 包含本 repository 目前使用的所有 App Server method。

### Taskboard service 直接使用的方法

| Method | Repository 中的用途 |
| --- | --- |
| `initialize` | 將 client 識別為 `codex-taskboard`，要求 experimental API，並建立 session |
| `initialized` | 通知 server 初始化已完成 |
| `skills/list` | 讀取 workspace 可用的 Codex skill |
| `thread/start` | 建立 Codex thread |
| `thread/resume` | 恢復既有 Codex thread |
| `turn/start` | 提交 user input 並開始 model turn |
| `turn/interrupt` | 中斷執行中的 turn |
| `thread/compact/start` | 要求壓縮 thread context |

這些呼叫由 `server/codex-app-server.mjs:25-220` 的 `CodexAppServer` wrapper 負責。
該 wrapper 啟動 `codex app-server --stdio`，將每個 JSON object 以一行寫入 standard input，依 numeric request ID 配對 response，並從 standard output 接收 notification。
Taskboard 的本地 AI 實作會在 `server/ai-chat.mjs:897-945` 消費 `turn/started`、`item/completed` 與 `turn/completed` 等 notification。

### 經 Codex Desktop bridge 使用的方法

CDP 整合在建立原生對話後，會透過 Desktop 的 `mcp-request` bridge 呼叫 `thread/read` 與 `thread/name/set`。
`thread/read` 用來確認新 thread ID 與 working directory。
`thread/name/set` 用來將 Taskboard issue title 設為原生 Codex conversation title。
本次產生的 App Server Schema 確認這兩個 method 都存在於目前安裝版本。

### 判定

App Server 是官方實作面，因為它由 Codex CLI 發行，而且能產生自己的 machine-readable protocol definition。
它仍應被歸類為實驗性介面，而不是穩定公開 SDK，因為執行檔明確將 server 與 generator 標示為 experimental。
對這一層而言，使用實際安裝版本產生的 Schema 是目前最可靠的相容性參考。

## 無 CDP 的原生 browser-pane 路徑

### 直接證據

當 Launcher 偵測到一般 Codex instance，但沒有可連線的 CDP renderer 時，`requestTaskboardOpen()` 會建立 `codex://threads/new` URL，並將 Taskboard 頁面放入 `browserUrl` query parameter。
在 macOS 上，Launcher 會將該 URL 傳給 `/usr/bin/open`，再由系統交給已安裝的 Codex App 處理。
README 將這個行為描述為在沒有 CDP 的普通 Codex 中，於原生 browser pane 開啟 Taskboard。

### 判定

這條路徑要求 Codex 以既有 browser pane 承載 Taskboard URL。
它不會注入 Taskboard sidebar、不會安裝 renderer script、不會略過 CSP，也不會建立 CDP binding。
它的能力因此比 CDP 路徑少，但仍依賴沒有公開文件的 `codex://threads/new?browserUrl=...` 行為。

### 未知事項

Repository 中沒有權威的 Codex deep-link schema。
目前證據無法確認哪些 Codex 版本承諾支援 `browserUrl`、`path` 或 `prompt` parameter。
本次官方文件查核沒有找到相符的 OpenAI compatibility document。

## CDP injection 路徑

### 使用的公開平台協定

Injector 透過 loopback WebSocket 或 inherited pipe，使用 Chrome DevTools Protocol 連接 Codex 的 Chromium renderer。
Chrome DevTools Protocol 是公開的 Chromium 協定，但使用它修改 Codex renderer 並不等同使用 OpenAI 支援的 Codex extension API。

本 repository 使用的 CDP command family 包含：

- `Target.getTargets` 用來尋找候選 renderer target。
- `Page.getFrameTree` 與 `Page.setDocumentContent` 用來檢查與填入 frame。
- `Page.createIsolatedWorld` 用來建立 Taskboard host binding 的隔離 execution context。
- `Page.addScriptToEvaluateOnNewDocument` 與 `Page.removeScriptToEvaluateOnNewDocument` 用來管理持續性的 renderer injection。
- `Page.setBypassCSP` 用來停用注入表面的 renderer Content Security Policy。
- `Runtime.enable`、`Runtime.evaluate` 與 `Runtime.addBinding` 用來執行程式碼，以及在 JavaScript 與 Launcher 之間橋接 event。
- `Input.dispatchKeyEvent` 用 Enter key event 送出已預填的原生 Codex composer。
- `Page.captureScreenshot` 用來擷取可選的視覺驗證證據。

### 相較 browser pane 增加的能力

CDP injection 可以增加原生風格的 Taskboard sidebar entry，並讓注入頁面佔用 Codex 主工作區，而不只是使用 browser pane。
它可以讀取目前 Codex renderer state、觀察或點擊 project 與 thread row、預填並送出原生 composer，以及辨識新建立的 thread ID。
它可以建立隔離的 host binding 回到 Taskboard Launcher，並在 page reload 或 renderer replacement 後維持注入。
它可以從 renderer execution context 呼叫非公開 Desktop bridge operation。
它可以略過 renderer CSP，使 Taskboard frame 在一般 HTTP iframe 被封鎖時仍可載入。

這些能力解釋了為什麼 CDP integration 比 browser-pane fallback 完整。
這也表示 Injector 對 Codex 具有遠高於一般嵌入網站的控制能力。

## 非公開 Codex Desktop bridge

### `window.electronBridge`

Injected user script 與經 CDP 執行的 JavaScript 都會從 Codex renderer global object 讀取 `window.electronBridge`。
Repository 會呼叫 `getInitialSidebarBootstrap()`，讀取描述 local 與 remote Codex project 的 global-state entry。
Repository 也會呼叫 `sendMessageFromView()`，傳送 native host operation。

名稱與 JavaScript 暴露方式符合 Electron preload `contextBridge` 的標準架構。
這仍是推論，因為本次調查沒有取得可閱讀的 Codex App preload source。

### Internal fetch bridge

Repository 透過 `sendMessageFromView()` 傳送 `type: "fetch"` 訊息，並以 POST request 呼叫 `vscode://codex/<method>`。
Repository 監聽相同 request ID 的 `type: "fetch-response"` window message，並讀取其中的 `responseType`、HTTP-like `status` 與 `bodyJsonString`。

`scripts/codex-injector.mjs:88-92` 的固定 automation method allowlist 包含：

- `list-automations`
- `automation-create`
- `automation-update`

Injected script 也會呼叫 `vscode://codex/get-global-state`，取得目前選擇的原生 project。

`vscode://` prefix 不能被解讀為這是公開 Visual Studio Code extension API 的證明。
在本 repository 中，它是經由 renderer bridge 使用的 Codex Desktop 內部 request dispatcher。

### Internal App Server forwarding bridge

Repository 會傳送 `type: "mcp-request"` 訊息，其中包含 `hostId`、request object、priority、source、timeout 與 expiration metadata。
Repository 會監聽 `type: "mcp-response"`，比對 host 與 request ID，再回傳內層的 result 或 error。

`mcp-request` 這個名稱本身不能證明它是公開 Model Context Protocol transport。
目前觀察到的是 Codex Desktop 實作專用的 message envelope，它會轉送 App Server 類型的 method call。

### Native workspace 與 navigation action

Injected script 在建立 local-project conversation 前，會傳送帶有 filesystem root 的 `type: "electron-add-new-workspace-root-option"`。
它會 dispatch `type: "navigate-to-route"` window message，開啟 Codex 原生 route，並傳入 `prefillPrompt` 等 composer state。
它也會 dispatch `type: "toggle-browser-panel"` message，在 Taskboard 使用主工作區時暫時關閉既有 browser pane，結束後再恢復。

本次調查沒有找到這些訊息格式的 OpenAI 公開契約。

## 非公開 Codex renderer DOM dependency

整合程式會讀取並操作以 implementation-specific data attribute 標記的 Codex renderer DOM element。
這些 element 包含 project row、thread row、composer root、content-editable composer、conversation ID、sidebar state、contextual header state 與 native browser webview。

重要 marker 包含：

- `data-codex-composer-root`
- `data-composer-placement`
- `data-codex-composer="true"`
- `data-above-composer-conversation-id`
- `data-app-action-sidebar-thread-id`
- `data-app-action-sidebar-thread-active`
- `data-app-action-sidebar-section-collapsed`
- `data-browser-sidebar-webview`
- `data-browser-sidebar-conversation-id`
- `data-browser-sidebar-browser-tab-id`

README 明確表示這個整合使用 Codex 現有的 project、composer 與 route marker，而不是 patch React、replace `fetch`、載入 private chunk 或修改 Codex data file。
這個設計沒有修改已安裝的 App bundle，但使用的 marker 仍然是非公開且具有版本敏感性。

## 不是 Codex API 的 repository 自有 bridge

Injector 會建立名為 `__codexTaskboardHostV1` 的 isolated-world binding。
它以隨機產生的 capability value 驗證自有 host message，並檢查目前的 CDP execution context。
它支援 `ensure`、`load-frame`、`open-external`、`open-attachment`、`automation` 與 `start-task-conversation` 等 Taskboard 自有 action。
這些 message 用來連接 injected renderer code 與 Taskboard Launcher，不應被描述成 OpenAI 或 Codex API。

Taskboard iframe 也會透過 repository 定義的 `taskboard:*` window message 與 injected host page 交換資料。
Loopback companion 同樣是 Taskboard 自有元件，用來提供本機驗證、path mapping、Git、Skill、MCP 與裝置能力。
它不是 Codex companion service，也不是 Codex Desktop bridge。

## 證據、推論與未知事項

### 直接證據

- `README.md:3-5` 表示 Taskboard 是 local-first issue board，並可透過 CDP Launcher 或 injection script 嵌入 Codex。
- `README.md:66-94` 記錄專用 CDP port 與 injection flow。
- `README.md:90-115` 區分 CDP injection 與 native browser-pane fallback。
- `README.md:161-176` 記錄 CSP bypass、renderer iframe、native route integration 與 local CDP exposure warning。
- `server/codex-app-server.mjs:25-220` 實作直接 App Server client。
- `server/ai-chat.mjs:820-945` 使用該 client 執行 Taskboard local AI conversation，並消費 App Server notification。
- `scripts/codex-injector.mjs:959-1130` 經由 `electronBridge` 實作 internal automation 與 App Server forwarding call。
- `scripts/codex-injector.mjs:1446-1620` 準備並提交 native composer、辨識 thread、驗證 working directory 並設定 title。
- `scripts/codex-injector.mjs:1657-1753` 安裝 Taskboard 自有 isolated-world CDP binding。
- `scripts/codex-injector.mjs:1846-1964` 註冊 document-start injection、略過 CSP、執行 script 並驗證 frame。
- `scripts/codex-injector.mjs:2122-2141` 實作無 CDP 的 browser-pane deep link。
- `inject/codex-taskboard.user.js:431-507` 經由 internal renderer bridge 讀取 Codex project state。
- `inject/codex-taskboard.user.js:940-1110` 導航 native thread、切換 project 並準備 Codex conversation。
- `inject/codex-taskboard.user.js:1629-1665` 經由 renderer message 關閉並恢復 native browser pane。
- `test/injector.test.mjs:35-106` 將目前的 CDP、App Server forwarding 與 automation bridge behavior 固定為 repository expectation。
- `codex-cli 0.149.1` 產生的 Schema 包含 `skills/list`、`thread/start`、`thread/resume`、`thread/read`、`thread/name/set`、`thread/compact/start`、`turn/start` 與 `turn/interrupt`。

### 合理推論

- `window.electronBridge` 很可能由 Electron preload script 使用 `contextBridge` 建立，因為這是 Electron 暴露受限 renderer API 的標準方式。
- Desktop `mcp-request` bridge 很可能將 request 送到對應 Codex host 的 App Server connection，因為 method 與回傳 result shape 符合產生的 App Server protocol。
- `vscode://codex/...` handler 很可能進入 Codex Desktop 或 IDE 架構共用的 internal request-routing layer。

這些推論受到觀察行為支持，但不是 Codex App main-process implementation 的直接證明。

### 未知事項與限制

- Repository 不包含實作 `electronBridge` 的 Codex Desktop preload 或 main-process source。
- 本次調查無法確認 Desktop bridge、deep-link parameter、renderer message 或 DOM marker 具有 OpenAI 公開相容性保證。
- 本次調查無法確認 Desktop `mcp-request` envelope 是否預定供第三方使用。
- 本次調查沒有找到能讓 Taskboard 在不使用 CDP 的情況下註冊相同 native UI 的正式 extension 或 plugin manifest。
- 本次調查無法確認 internal renderer message 到達 main process 後，Codex 所套用的完整 authorization policy。
- 後續 Codex CLI 或 Codex App 版本可能具有不同的行為。

## 穩定性與安全意義

| Dependency | 相容性風險 | 安全意義 |
| --- | --- | --- |
| Generated App Server protocol | 中，因為它仍是 experimental，但可以用 Schema 機械式比對變更 | 它可以啟動與控制 Codex 工作，因此 method 與 permission 變動具有實質影響 |
| `codex://` deep-link parameter | 中至高，因為沒有找到公開 schema | Parameter 變更可能影響 navigation、prompt 或 hosted URL |
| `window.electronBridge` method | 高，因為它是 private preload API | Bridge 會從 renderer JavaScript 跨入具有較高權限的 Desktop behavior |
| Internal `fetch`、`mcp-request` 與 native-action envelope | 高，因為名稱與 payload 都是 private | 它們可接觸 global state、automation、host、workspace selection 與 App Server operation |
| Codex renderer DOM marker | 很高，因為 renderer markup 可以獨立變更 | DOM drift 可能造成錯誤 click、project selection、composer submission 或 thread attribution |
| CDP renderer control | 協定本身相對穩定，但整合風險高 | Injector 可以執行程式碼、略過 CSP、送出 input 並安裝 document-start script |
| Taskboard isolated bridge | 由本 repository 控制 | Capability check 與 execution-context validation 是重要的本機 trust boundary |

最穩定的整合面是針對確切已安裝 CLI 版本產生的 App Server Schema。
最不穩定的整合面是 Codex DOM marker、renderer message type 與 private `electronBridge` payload 的組合。
權限最高的整合面是 CDP，因為它提供 Launcher renderer-level execution 與 CSP-bypass 能力。

Repository 的其他安全風險，包括 local CDP exposure 與 Injector profile handling，另外記錄在 `risk-assessment.md`。

## Codex 更新後的重新查核方式

先針對新安裝的 Codex CLI 執行：

```bash
codex --version
codex app-server --help
codex app-server generate-json-schema --out /tmp/codex-app-server-schema --experimental
codex app-server generate-ts --out /tmp/codex-app-server-types --experimental
```

接著將新產生的 request method 與 parameter schema，和本文件列出的所有 method 比對。
在進行 live Codex Desktop 驗證前，應先執行 Injector 與 App Server 的 focused test。

最小的 focused repository check 是：

```bash
node --test test/injector.test.mjs test/inject.test.mjs test/codex-cdp-pipe.test.mjs
node --test test/ai-chat-server.test.mjs test/ai-chat-runner.test.mjs
```

Live Desktop check 應分別驗證無 CDP browser pane 與 CDP injection，因為兩者使用不同的 Codex integration surface。
如果失敗點涉及 `electronBridge`、`codex://` parameter、message type 或 DOM marker，應先將其視為 private-interface compatibility change，而不是立即歸因於 Taskboard business API。

## 外部參考資料

- OpenAI Developers 文件入口：<https://developers.openai.com/>
- Installed CLI 所連結的 OpenAI Codex advanced configuration 與 metrics 文件：<https://developers.openai.com/codex/config-advanced/#metrics>
- Chrome DevTools Protocol reference：<https://chromedevtools.github.io/devtools-protocol/>
- Electron `contextBridge` reference：<https://www.electronjs.org/docs/latest/api/context-bridge>
- Electron `ipcRenderer` reference：<https://www.electronjs.org/docs/latest/api/ipc-renderer>

本次 OpenAI 官方文件搜尋沒有找到 Codex Desktop `electronBridge`、`sendMessageFromView`、`mcp-request`、`vscode://codex/...`、deep-link parameter schema 或 renderer IPC contract 的專用公開參考文件。
