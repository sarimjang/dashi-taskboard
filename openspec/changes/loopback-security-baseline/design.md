## Context

Dashi-taskboard server 目前的 host 解析函式 `resolveHost` 預設綁定所有網路介面，且伺服器啟動時的 host 驗證邏輯只接受兩個值：本機 loopback 或「所有介面」。這代表 LAN 可達性是預設行為，不是一個被明確選擇過的狀態。同一份程式碼被三種佈署形態共用：standalone CLI、Tauri Launcher 打包的桌面 App、以及 Codex injector 注入的 embedded 模式，三者都經過同一個 host 解析與驗證路徑。

伺服器對外提供三種連線方式：一般 HTTP API、SSE（Server-Sent Events，用於任務變更的即時推播）、以及 WebSocket（用於雙向即時通訊）。目前 `actorFromRequest` 這個身份解析函式會信任呼叫端自報的 `X-Taskboard-User-*` 系列標頭，不論請求來源是 loopback 還是 LAN。另有一組機器層級 metadata 與 capability 路由，設計上只應提供給本機呼叫端。

此變更是 hard fork risk remediation 中排序最前的跨模組 change，後續的單點修補（bd-2 injector profile、bd-3 Jira HTTPS、bd-4 外部圖片、bd-6 移除第三方注入面）都假設網路邊界已經收斂，因此本設計必須先把「預設拒絕、顯式 opt-in」的邊界定義清楚。

## Goals / Non-Goals

**Goals:**

- 伺服器在未經任何設定的情況下，只監聽本機 loopback，對網路上其他主機完全不可見。
- 提供一個顯式、需要主動選擇才會生效的 LAN 存取旗標，開啟後才允許非 loopback 來源連線。
- LAN 旗標開啟後，HTTP、SSE、WebSocket 三種連線方式套用同一組身份驗證要求，不存在「其中一種方式可以繞過驗證」的落差。
- 使用者身份標頭（`X-Taskboard-User-*`）只在請求來源是本機 loopback 時被信任；LAN 來源即使通過驗證，也不能靠自報標頭宣告身份。
- 機器層級 metadata 與 capability 路由，不論 LAN 旗標與驗證狀態為何，永遠只接受 loopback 來源。

**Non-Goals:**

- 不涉及 RISK-002（injector profile 目錄）、RISK-005（外部圖片載入）、RISK-006（Jira HTTPS）等已個別建立 bd issue 的單點修補，這些修補假設本 change 完成後的網路邊界已經生效，但實作內容互相獨立。
- 不涉及 RISK-004、RISK-008 對應的 cloud 共享看板退場（Spectra change `retire-shared-board`），本 change 只處理本機/LAN 伺服器層的存取邊界，不處理 cloud worker 的身份與授權模型。
- 不引入新的驗證機制種類（例如 OAuth、SSO）；沿用 repo 現有的驗證原語，只調整其套用範圍與觸發條件。
- 不改變 Codex embed 既有的 postMessage handshake 或 `hostContext`／`publishHostRuntime` 機制，這些屬於 embedded host 的信任模型，與本 change 的網路邊界無關。

## Decisions

### 預設綁定改為 loopback-only，LAN 存取改為顯式 opt-in

現行行為把「監聽所有介面」當作與「只監聽 loopback」平行的兩個合法選項，選擇權交給執行時的環境變數，沒有安全的預設值。改為：未設定任何 LAN 相關旗標時，`resolveHost` 只能解析出 loopback 位址；只有當呼叫端明確設定一個新的 LAN 存取旗標時，才允許解析出「監聽所有介面」。

備選方案是維持雙值語意但把預設值改成 loopback——被拒絕，因為這無法防止使用者複製舊的啟動腳本或環境變數設定檔，等於只是換了預設值，沒有建立「必須主動選擇」的機制。改為獨立旗標可以確保任何沿用舊設定的啟動方式都會退回安全預設。

### HTTP、SSE、WebSocket 三種連線方式共用同一個驗證閘門

現行程式碼中一般 HTTP API 路由與 SSE／WebSocket 建立連線的路徑是分開處理的，容易出現「HTTP 有驗證、SSE 或 WebSocket 忘記加」的落差。設計上把 LAN opt-in 生效後的身份驗證要求抽成一個單一的驗證判斷點，HTTP 路由、SSE 訂閱建立、WebSocket upgrade handshake 三者在建立連線的最早時機都呼叫同一個判斷點，任何一種連線方式都不能繞過。

備選方案是在三個入口點各自複製一份驗證邏輯——被拒絕，因為這正是目前這個風險存在的原因：邏輯分散導致其中一處被遺漏。

### 使用者身份標頭只在 loopback 來源被信任

`actorFromRequest` 目前不區分請求來源就信任 `X-Taskboard-User-*` 標頭。設計上讓這個函式先取得請求的來源判定（loopback 或 LAN），只有 loopback 來源才進入標頭解析分支；LAN 來源即使通過了 LAN 存取的身份驗證，也一律視為未提供身份標頭，退回既有「匿名本地使用者」的預設身份邏輯，不得以標頭宣告任意身份。

備選方案是允許 LAN 來源也使用標頭但額外要求簽章——被拒絕，因為這會把驗證複雜度提高到超出本 change 的範圍，且引入新的密鑰管理需求，違反 Non-Goals 中「不引入新驗證機制」的邊界。

### 機器層級 metadata 與 capability 路由維持無條件 loopback-only

這組路由的既有設計就是給同機器上的其他行程（例如 Launcher、injector）查詢執行環境用的，語意上不應該被 LAN 存取涵蓋。設計上讓這組路由的存取檢查獨立於 LAN opt-in 與驗證狀態之外，永遠只接受 loopback 來源請求，即使 LAN 模式已開啟且呼叫端已通過驗證也一樣。

## Implementation Contract

**行為（Behavior）：**

- 未設定 LAN 存取旗標時，伺服器只在本機 loopback 位址上可被連線；從同網段的另一台主機對伺服器發出的任何 HTTP、SSE 或 WebSocket 請求都無法建立連線（連線層級被拒絕，而非應用層回應 403）。
- 設定 LAN 存取旗標後，伺服器在所有介面上可被連線，但任何非 loopback 來源的請求，不論是 HTTP、SSE 或 WebSocket，若未通過既有的身份驗證要求，一律在連線建立的最早時機被拒絕。
- LAN 來源即使通過驗證，帶有 `X-Taskboard-User-*` 標頭的請求會被視為未提供該標頭，身份解析退回既有的匿名本地使用者預設值；只有 loopback 來源的請求，這組標頭才會被實際解析成使用者身份。
- 機器層級 metadata 與 capability 路由，對任何非 loopback 來源的請求一律拒絕，不受 LAN 旗標或驗證狀態影響。

**介面（Interface）：**

- 新增一個顯式的 LAN 存取旗標（環境變數形式，與現有 `resolveHost` 讀取環境變數的方式一致），未設定時視為關閉。
- `resolveHost` 的回傳值語意調整為：旗標關閉時只能得到 loopback 位址；旗標開啟時才能得到涵蓋所有介面的位址。
- `actorFromRequest` 新增一個來源判定的前置步驟，其輸出（loopback 或非 loopback）決定是否進入既有的標頭解析分支。

**失敗模式（Failure modes）：**

- LAN 旗標關閉時的非 loopback 連線嘗試：連線層級被拒絕，不產生應用層錯誤訊息（與現行「未監聽該介面即無法連線」的行為一致）。
- LAN 旗標開啟但驗證失敗的非 loopback 請求：HTTP 回應既有的未驗證錯誤格式；SSE 與 WebSocket 在 handshake 階段直接關閉連線，不建立串流。
- 非 loopback 來源請求機器層級 metadata 或 capability 路由：一律回應既有的存取拒絕格式，不因 LAN 旗標或驗證狀態而有例外。

**驗收條件（Acceptance criteria）：**

- `test/server.test.mjs` 中「一般 API 對 LAN client 可用」與「LAN client 間廣播任務變更」的既有測試案例被改寫，反映「未開啟旗標時 LAN 不可達、開啟後需通過驗證」的新行為，且改寫後的測試通過。
- 新增測試涵蓋：LAN 旗標關閉時的連線不可達性；LAN 旗標開啟後 HTTP、SSE、WebSocket 三種連線方式在未驗證時一致被拒絕；LAN 來源攜帶 `X-Taskboard-User-*` 標頭時身份仍解析為匿名本地使用者；機器層級 metadata 與 capability 路由在 LAN 旗標開啟且已驗證的情況下仍拒絕非 loopback 來源。
- Standalone、Tauri Launcher、Codex injector 三種佈署形態都完整跑過上述測試，確認三者共用的 host 解析與驗證路徑行為一致。

**範圍邊界（Scope boundaries）：**

- 範圍內：`resolveHost` 的預設值與 LAN 旗標語意、HTTP/SSE/WebSocket 的共用驗證判斷點、`actorFromRequest` 的來源判定與標頭信任範圍、機器層級 metadata 與 capability 路由的存取檢查、`test/server.test.mjs` 中對應既有測試的改寫。
- 範圍外：Jira 整合的憑證傳輸方式（RISK-006，獨立 bd issue）、injector profile 目錄的安全性（RISK-002，獨立 bd issue）、外部圖片自動載入（RISK-005，獨立 bd issue）、cloud 共享看板的身份與授權模型（RISK-004／RISK-008，獨立 Spectra change `retire-shared-board`）、WorkBuddy 與 DeepSeek Harness 的移除（RISK-009，獨立 bd issue）。

## Risks / Trade-offs

- [風險] 既有使用者若依賴目前「伺服器預設可被 LAN 存取」的行為（例如透過區網其他裝置操作 Taskboard），升級後會直接斷線，且不會有任何錯誤訊息說明原因 → [緩解] 在發行說明與 README 中明確記載這是刻意的安全性行為變更，並說明如何設定 LAN 存取旗標以恢復原有可達性。
- [風險] HTTP、SSE、WebSocket 共用同一個驗證判斷點，若該判斷點本身有邏輯缺陷，會同時影響三種連線方式，风险集中度變高 → [緩解] 針對這個共用判斷點單獨撰寫測試案例，覆蓋三種連線方式各自呼叫它的路徑，而不只測試端到端行為。
- [風險] `actorFromRequest` 的來源判定新增了一個前置步驟，若判定邏輯本身可被偽造（例如透過偽造的 forwarded header），會讓 LAN 來源冒充 loopback 身份 → [緩解] 來源判定必須基於連線層級的實際來源位址，不得信任任何可由呼叫端自訂的標頭欄位作為 loopback 判斷依據。

## Migration Plan

- 這是本機／桌面應用程式，沒有伺服器端滾動升級的概念；「部署」等同於使用者升級到含有本次變更的版本並重新啟動。
- 沒有既有使用者資料需要遷移；此變更只影響網路存取邊界的行為，不涉及資料庫 schema 或儲存格式。
- Rollback 策略：若升級後發現此變更造成無法接受的可用性問題，可透過設定 LAN 存取旗標暫時恢復 LAN 可達性，而不需要回退整個版本；徹底回退則等同於回退到變更前的版本。

## Open Questions

- LAN 存取旗標的實際命名，以及開啟後所需驗證機制的具體形式（例如沿用某種既有的 token 或密碼機制），交由 tasks 階段依 repo 現有的驗證原語決定，不在本設計文件中預先指定命名以避免與最終實作的旗標名稱不一致。
