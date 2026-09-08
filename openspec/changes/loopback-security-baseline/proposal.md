## Why

這是 dashi-taskboard hard fork（chuspeeism/dashi-taskboard → sarimjang/dashi-taskboard）risk remediation 對應 RISK-001 的第一個跨模組 Spectra change。目前 server 預設綁定所有網路介面，且沒有顯式的 LAN 存取開關；只要主機在同一區網，就能觸及本應僅供本機使用的 API。這在 hard fork 之後成為第一優先要收斂的攻擊面，因為後續的單點修補（bd-2 至 bd-6）都建立在「網路邊界已收斂」的前提上。

## What Changes

- Server 預設 host 綁定由「監聽所有介面」改為「僅本機 loopback」。
- 新增顯式的 LAN 存取旗標；不開啟該旗標時，伺服器完全不對外監聽。**BREAKING**：既有「伺服器預設可被同網段其他主機存取」的行為被移除。
- LAN 旗標開啟後，HTTP、SSE（Server-Sent Events）與 WebSocket 三種連線方式一致地要求身份驗證，不允許任一種連線方式繞過驗證直接存取。
- 呼叫端自報的使用者身份標頭（`X-Taskboard-User-*`）只在來自本機 loopback 的請求上被信任；來自 LAN 的請求即使通過驗證，也不得用這組標頭宣告身份。
- 機器層級 metadata 與 capability 相關路由，不論 LAN 模式是否開啟、是否已驗證，一律維持僅限本機存取。
- 對應改寫既有測試中「一般 API 對 LAN client 可用」與「LAN client 間廣播任務變更」的既有預期，使其反映新的預設拒絕與顯式 opt-in 行為。

## Capabilities

### New Capabilities

- `network-access-control`：定義伺服器的網路存取邊界，涵蓋預設綁定範圍、LAN 存取的顯式 opt-in 機制、HTTP/SSE/WebSocket 三種連線方式的一致驗證要求，以及使用者身份標頭與機器層級路由的信任範圍。

### Modified Capabilities

(none — 此為全新引入的邊界規則，repo 內尚無既有 spec 描述網路存取邊界)

## Impact

- Affected specs: `network-access-control`（新增）
- Affected code:
  - Modified: `server/app.mjs`（host 解析、host 白名單、身份標頭信任範圍、機器層級與 capability 路由的存取限制）
  - Modified: `test/server.test.mjs`（改寫驗證 LAN 存取行為的既有測試案例，使其反映新的預設拒絕與顯式 opt-in 行為）
