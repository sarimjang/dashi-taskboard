## 1. 預設綁定改為 loopback-only，LAN 存取改為顯式 opt-in

- [x] 1.1 新增顯式的 LAN 存取旗標，未設定該旗標時 `resolveHost` 只能解析出 loopback 位址；驗證方式：新增自動化測試對應 spec `network-access-control` 的 Requirement「Default loopback-only binding」中「Server starts without the LAN access flag」情境，確認伺服器只在 loopback 位址可被連線。
- [x] 1.2 設定 LAN 存取旗標後，`resolveHost` 允許解析出涵蓋所有介面的位址；驗證方式：新增自動化測試對應同一 Requirement 的「Server starts with the LAN access flag set」情境，確認伺服器在所有介面上可被連線。

## 2. HTTP、SSE、WebSocket 三種連線方式共用同一個驗證閘門

- [x] 2.1 建立一個單一的驗證判斷點，HTTP 路由、SSE 訂閱建立、WebSocket upgrade handshake 三者在建立連線的最早時機都呼叫它；驗證方式：新增自動化測試對應 spec Requirement「Uniform authentication across connection types under LAN access」的四個情境（未驗證的 HTTP、SSE、WebSocket 個別被拒絕，已驗證的三者皆成功）。**註（lsb-review 修復後補註）**：WebSocket upgrade（`/api/events`）在 cloud 模式下本質是 cloud-relay 專用端點，既有 HTTP/SSE 邏輯對此路徑無條件要求 loopback-only；本 repo 目前沒有非 cloud 用途的 WS 端點，因此 LAN+token 放寬情境不適用於 WS upgrade——WS upgrade 維持無條件 `assertLoopbackRequest`，「已驗證的三者皆成功」僅適用於 HTTP 與 SSE。
- [x] 2.2 改寫既有測試「accepts private LAN requests and rejects public Host and Origin headers」（一般 API 對 LAN client 可用），使其反映「未開啟旗標時 LAN 不可達、開啟後需通過驗證」的新行為；驗證方式：改寫後的測試案例執行通過。
- [x] 2.3 改寫既有測試「task changes from one LAN client are broadcast to another client」（LAN client 間廣播任務變更），使其反映相同的新驗證要求；驗證方式：改寫後的測試案例執行通過。

## 3. 使用者身份標頭只在 loopback 來源被信任

- [x] 3.1 為 `actorFromRequest` 新增一個基於連線層級來源位址的判定前置步驟，只有 loopback 來源才進入既有的 `X-Taskboard-User-*` 標頭解析分支，LAN 來源一律退回匿名本地使用者預設身份；驗證方式：新增自動化測試對應 spec Requirement「Actor identity headers trusted only from loopback callers」的兩個情境（loopback 來源標頭生效、已驗證 LAN 來源標頭被忽略）。

## 4. 機器層級 metadata 與 capability 路由維持無條件 loopback-only

- [x] 4.1 機器層級 metadata 與 capability 路由的存取檢查獨立於 LAN 旗標與驗證狀態，永遠只接受 loopback 來源；驗證方式：新增自動化測試對應 spec Requirement「Machine-level metadata and capability routes remain loopback-only unconditionally」的兩個情境（已驗證 LAN client 被拒絕、loopback client 正常服務）。

## 5. 跨佈署形態的一致性驗證

- [x] 5.1 確認 standalone CLI、Tauri Launcher、Codex injector 三種佈署形態共用的 host 解析與驗證路徑在三者之下行為一致；驗證方式：執行完整 `npm test` baseline 且全數通過，並手動確認三種啟動方式各自傳遞 LAN 存取旗標與驗證設定的環境變數路徑一致。
