# Dashi Taskboard 目標架構

## 文件狀態

本文件記錄截至 2026-08-27 為止，Dashi Taskboard 在本地工作管理、Jira、Linear、Cloudflare webhook、Codex Desktop 與 Herdr 之間的目標責任分工。
本文件依據目前 repository revision `5c96d1ab698362994283ba0af86021db0a98dd89`、現有 Jira 實作、2026-08-27 的 Linear MCP 唯讀探測，以及 Linear 與 Cloudflare 官方文件整理。
本文件是目標架構與遷移決策，不代表 Linear provider、webhook-only listener、Cloudflare Tunnel 或通用 provider abstraction 已經實作。
安全風險、攻擊前提、嚴重度與緩解細節請參考 [`risk-assessment.md`](./risk-assessment.md)。
Codex App private bridge、CDP injection 與 App Server 的調查請參考 [`investigate.md`](./investigate.md)。
Taskboard 與 Herdr control plane 的能力邊界請參考 [`herdr-comparison.md`](./herdr-comparison.md)。

## 一句話結論

Dashi Taskboard 應保留為 local-first 工作介面與 Codex execution overlay，Jira 或 Linear 應成為可選的共享 Issue source of truth，而 Cloudflare Tunnel 只應提供隔離的 Linear webhook ingress，不應重新公開整個本機 Taskboard。

Linear GraphQL API 負責正式讀寫與 reconciliation，Linear webhook 負責低延遲變更通知，Linear MCP 只作為可選的 Agent-facing command adapter。

Jira 可以保留目前以 pull 為主的同步策略，但應搬入和 Linear 共用的 provider contract。

Issue 狀態與本機 Agent execution 狀態必須分開保存，Herdr 等級的 watchdog、lease、receipt 與 Operations UI 仍屬獨立 control plane。

## 目的地形態判定

**Target:** 以 Jira 或 Linear 作為共享工作資料的 canonical source，以 Dashi 作為每台裝置的本機 materialized view、Codex thread/folder binding 與 execution surface。

**This proposal is:** destination architecture。

**After completion, will we actually have the target architecture/runtime?:** 對外部 Issue provider-backed Taskboard 是。

**If no, what will still be missing?:** 若目標另外包含 Herdr 等級的完整 loop engineering，仍缺少 Agent topology、Run、Attempt、Lane、Lease、Heartbeat、Intent、Receipt、Watchdog、Decision Inbox、Operations UI 與 recovery controller。

## 架構決策摘要

| 決策 | 結論 | 理由 |
| --- | --- | --- |
| 多裝置直接共用 Dashi Taskboard | 不列入目標架構 | 共享工作資料應透過 Jira 或 Linear，同步本機 Taskboard 會增加授權、隱私與衝突路徑 |
| LAN collaboration | 退出主要產品路徑 | 現況沒有帳號驗證，且會擴大 Jira、attachment、workspace metadata 與 board mutation 的攻擊面 |
| 現有 Cloudflare shared board | 視為可退場的既有模式 | D1、R2、shared password 與 local companion 重複承擔外部 tracker 已能處理的共享責任 |
| Jira | 保留 pull/reconciliation | 現況可在不公開本機 endpoint 的情況下運作，適合 Jira Server/Data Center 與內網環境 |
| Linear | 採 webhook-and-poll | Webhook 改善即時性，增量 polling 與啟動 reconciliation 提供恢復能力 |
| Cloudflare Tunnel | 只服務 webhook ingress | Tunnel 不應公開 Taskboard UI、普通 API、SSE、WebSocket 或 device-local capability |
| Linear MCP | 可選 Agent adapter | MCP 適合語意式查詢與 Agent 操作，不適合背景同步、checkpoint、delivery 去重或 daemon lifecycle |
| Codex App Server | Codex execution actuator | 它能執行 thread 與 turn，但不應成為 external issue synchronization transport |
| Herdr | 可選 orchestration control plane | 它處理 execution topology 與 lifecycle evidence，不是共享 Issue database |

## Current state

### 本機 Taskboard

目前產品以 React UI、Node HTTP service、SQLite、`taskctl`、Tauri launcher 與 Codex injection 組成。

Taskboard 保存 Project、Task、Comment、Attachment、Relation、Development Context 與 Conversation Binding。

Tauri launcher 會把服務綁定到 `127.0.0.1`，並使用每次啟動產生的 instance token 和 secret 保護 Launcher 路徑。

Standalone server 目前預設可以綁定 `0.0.0.0`，而 LAN mode 沒有 account authentication。

這項現況風險記錄於 `risk-assessment.md` 的 `RISK-001`。

### Jira 現況

目前 Jira integration 是 Dashi 唯一實作完成的 external issue provider。

它不是 webhook integration。

前端在 Jira project 開啟時每 60 秒呼叫一次 `GET /api/tasks`，server 再以 60 秒 TTL 執行 Jira pull。

App 啟動、project 切換與手動同步也會觸發 Jira reconciliation。

Jira 查詢只包含目前使用者被指派的未完成 Issues，以及最近 30 天更新過的 Done Issues。

Jira 寫入目前支援 title、description、labels、due date、priority 與 status transition。

建立 Jira Issue、修改 Jira assignee、刪除、手動 archive 與完整 comment/attachment/relation mirror 目前不支援。

### Linear 現況

Repository 目前沒有 Linear provider。

`Project.source` 與 `Task.source` 仍被寫死為 `"local" | "jira"`。

資料庫 mapper 會把所有非 Jira 的 `external_source` 當成 local，因此不能安全地只增加一個 Linear API route。

2026-08-27 的 Linear MCP 唯讀探測已確認可取得 Workspace、Team、Project、Issue、Status、Label、Comment、Attachment、Document、Cycle、Milestone、User 與 Relation 等資料。

Linear Issue 可取得 title、description、status、status type、priority、estimate、assignee、delegate、labels、project、team、cycle、milestone、parent、relation、日期、SLA、branch、attachment、document 與 state history。

Linear MCP 也暴露 Issue、Comment、Attachment、Relation 與 Project 的寫入工具。

這項能力證明 Linear 的資料模型足以成為共享 Issue source of truth，但不代表 MCP 應被當成 Dashi 的同步 backend。

## Target architecture

```text
                             Shared work data
                    ┌────────────────────────────┐
                    │                            │
              Jira REST API              Linear GraphQL API
                    │                            │
          poll + manual sync        write + incremental reconcile
                    │                            │
                    │                     Linear Webhook
                    │                            │
                    │                  Cloudflare Tunnel
                    │                            │
                    │                webhook-only listener
                    │                            │
                    └──────────────┬─────────────┘
                                   │
                         External Provider Layer
                                   │
                    normalize -> reconcile -> upsert
                                   │
                           Local SQLite store
                                   │
                     ┌─────────────┴─────────────┐
                     │                           │
              Work materialized view      Private execution overlay
              Issues / comments /         folder / thread / host /
              relations / metadata        worktree / agent runtime
                     │                           │
                     └─────────────┬─────────────┘
                                   │
                           EventHub / SSE
                                   │
                         Dashi Taskboard UI

        Optional agent plane                    Optional control plane
        Linear MCP -> Linear                    Herdr -> Operations UI
```

## 四個平面必須分離

### Shared work data plane

Jira 或 Linear 保存跨裝置、跨使用者共享的 Issue 資料。

它們是 external issue 的 canonical source of truth。

Dashi SQLite 對 external issue 只保存 materialized view、sync metadata 與本機 overlay。

### Event plane

Jira 現況使用 polling。

Linear 使用 webhook 作低延遲通知，並使用增量 polling 作補漏。

Webhook event 只表示某個 entity 需要 reconciliation，不直接成為 Taskboard task mutation。

### Agent command plane

Linear MCP 讓 Codex Agent 以自然語言查詢或操作 Linear。

MCP 不負責 Dashi background synchronization、checkpoint、webhook delivery、SQLite migration 或 App startup readiness。

任何 MCP 寫入都視為另一個 Linear client 所造成的 external change，最後透過 webhook 或 polling 回到 Dashi。

### Execution control plane

Codex App Server、Codex Desktop bridge、CDP、Herdr、Git/worktree 與本機 process state 都屬 execution plane。

這些狀態不能寫進 Jira 或 Linear 作為 Issue synchronization payload。

Herdr 若被整合，應透過版本化、唯讀優先的 adapter 提供 control-plane evidence，而不是改變 external issue provider 的責任。

## 資料所有權

### External provider-owned fields

| 類別 | 欄位 |
| --- | --- |
| Identity | provider、provider origin、provider issue ID、identifier、URL |
| Work content | title、description、shared comments、external attachments、documents |
| Workflow | status、status type、priority、estimate、due date、SLA |
| Organization | workspace、team、project、cycle、milestone、initiative |
| People | creator、reporter、assignee、delegate |
| Structure | parent、sub-issues、blocks、blockedBy、relatedTo、duplicateOf |
| Metadata | labels、createdAt、updatedAt、startedAt、completedAt、canceledAt、archivedAt |
| Shared development hint | provider-managed branch name或公開 repository link |

### Local-only fields

| 類別 | 欄位 |
| --- | --- |
| Filesystem | workspacePath、worktree absolute path、local checkout mapping |
| Codex identity | codexHostId、codexProjectId、threadId、conversation transcript |
| Runtime | process ID、pane、CDP session、Launcher token、instance secret |
| Execution | executionStatus、attempt、local queue、automation schedule、quota state |
| Git state | local branch checkout、uncommitted changes、local test artifacts |
| Herdr state | Agent instance、lane、lease、heartbeat、intent、receipt、watchdog result |
| Secrets | provider token、OAuth refresh token、Jira password、webhook secret、Tunnel credential |

Local-only fields不得出現在 external provider description、comment、attachment metadata、webhook response或 shared cloud payload。

如需跨裝置辨識同一個本機 mapping，應使用 opaque local mapping ID，而不是同步 absolute path。

## Issue status 與 execution status

External Issue status 回答「這項工作在團隊流程中位於哪個階段」。

Local execution status 回答「這台裝置上的 Agent 是否正在執行、等待、失敗或完成」。

兩者不得共用同一個 enum 或欄位。

```text
issueStatus
  backlog | todo | in_progress | in_review | blocked | done | canceled

executionStatus
  idle | queued | launching | running | waiting | interrupted |
  failed | completed | unknown
```

Linear 的 `backlog`、`unstarted`、`started`、`completed`、`canceled` 與 `duplicate` 是 provider status type。

Jira 的 status category 與名稱則需要透過 mapping policy 投影成 Dashi issueStatus。

`in_review` 與 `blocked` 應優先映射到 provider 的真實 custom status；若 provider 沒有對應狀態，才由明確的 project mapping policy 決定，而不是全域字串猜測。

`duplicate` 應保存為 resolution/relation，不應無條件壓成 `canceled`。

## Provider contract

Provider abstraction 應讓 Jira 與 Linear 共用 reconciliation 流程，但保留各自的 authentication、query、status mapping 與 sync strategy。

```ts
interface IssueProvider {
  configure(input: unknown): Promise<ProviderConnection>;
  status(): Promise<ProviderConnectionStatus>;
  listIssues(input: ProviderSyncQuery): Promise<ProviderIssuePage>;
  getIssue(id: string): Promise<ProviderIssue>;
  createIssue(input: ProviderIssueCreate): Promise<ProviderIssue>;
  updateIssue(id: string, changes: ProviderIssueChanges): Promise<ProviderIssue>;
  listStatuses(scope: ProviderScope): Promise<ProviderStatus[]>;
  listLabels(scope: ProviderScope): Promise<ProviderLabel[]>;
  listComments(issueId: string): Promise<ProviderCommentPage>;
  reconcileIssue(id: string): Promise<ProviderSyncResult>;
  reconcileSince(cursor: ProviderSyncCursor): Promise<ProviderSyncResult>;
}
```

Provider capabilities 必須顯式宣告，不應由 UI 以 `source === "jira"` 猜測。

```ts
interface ProviderCapabilities {
  createIssue: boolean;
  updateAssignee: boolean;
  comments: "none" | "read" | "read-write";
  attachments: "none" | "read" | "read-write";
  relations: "none" | "read" | "read-write";
  webhook: boolean;
  incrementalSync: boolean;
}
```

## Sync strategies

### Jira

Jira 第一階段應保留目前行為，以降低 provider refactor 對內網與 Jira Server/Data Center 的破壞。

```text
mode: poll
foreground refresh: 60 seconds
startup reconciliation: yes
manual force sync: yes
webhook: no
```

後續可以改善為 updated-since query，但不能在沒有 end-to-end 驗證的情況下改變目前 assigned issue scope。

### Linear

Linear 應採 webhook-and-poll。

```text
mode: webhook-and-poll
webhook: targeted reconciliation
startup: updatedAt > lastSuccessfulCheckpoint
periodic repair: incremental reconciliation
manual force sync: yes
occasional scope reconciliation: yes
```

Tunnel 或 webhook 未設定時，Linear integration 仍必須透過 API polling 完整可用。

MCP 未安裝、未授權或暫時不可用時，也不得影響 Dashi Linear project 的正常讀寫。

## Linear webhook ingress

### Listener isolation

推薦讓 Dashi Desktop process 同時擁有兩個 loopback listener。

```text
127.0.0.1:47823
  Main Taskboard UI / API / SSE

127.0.0.1:47824
  POST /webhooks/linear only
```

Webhook listener 應共用 provider service、database connection policy與 EventHub，但不應共用普通 Taskboard router。

Webhook listener 不提供 static UI、task list、comment、attachment、SSE、WebSocket、Codex、workspace、Git、MCP或 local capability route。

它應維持固定 path，不依賴 Codex Launcher 每次啟動產生的 instance token。

### Cloudflare Tunnel boundary

Cloudflare Tunnel 應只把單一 hostname 與單一 path 轉到 webhook-only listener。

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /path/to/<TUNNEL_UUID>.json

ingress:
  - hostname: hooks.example.com
    path: ^/webhooks/linear$
    service: http://127.0.0.1:47824
    originRequest:
      httpHostHeader: 127.0.0.1:47824

  - service: http_status:404
```

正式設定應以 Cloudflare 當期文件與 `cloudflared tunnel ingress validate` 驗證。

Cloudflare Tunnel 文件支援 hostname/path rule、catch-all route與 local service forwarding。

參考：<https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/>。

參考：<https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/>。

### Request processing

```text
POST /webhooks/linear
  -> verify method and content type
  -> read bounded raw body
  -> verify Linear-Signature with HMAC-SHA256
  -> verify webhook timestamp freshness
  -> validate organization and webhook identity
  -> deduplicate Linear-Delivery
  -> persist durable inbox event
  -> return HTTP 200 within five seconds
  -> asynchronously reconcile the affected entity from Linear API
  -> upsert SQLite
  -> emit Taskboard event
```

簽章驗證必須使用 raw body，不能對 parse 後的 JSON 重新 stringify。

比較 HMAC 時必須使用 constant-time comparison。

`Linear-Delivery` 應具有 unique constraint，讓重送不會造成重複 side effect。

`updatedFrom` 可以作為診斷資訊，但不能取代重新讀取 canonical entity。

Linear webhook 文件：<https://linear.app/developers/webhooks>。

## 真實操作路徑

### 路徑一：App 啟動與離線恢復

```text
Dashi starts
  -> load provider connections and checkpoints
  -> call Jira pull when configured
  -> call Linear listIssues(updatedAt > checkpoint)
  -> follow cursor until complete
  -> normalize and upsert in a transaction
  -> advance checkpoint only after success
  -> emit one bounded refresh event
  -> render current board
```

同步失敗時不能推進 checkpoint。

重試時應使用一段 overlap window，並依 provider issue ID 與 provider updatedAt 去重。

### 路徑二：Linear webhook

```text
Linear changes an Issue
  -> Cloudflare Tunnel forwards POST /webhooks/linear
  -> webhook-only listener verifies and stores delivery
  -> listener returns 200
  -> background worker calls getIssue(issueId)
  -> common reconciliation upserts SQLite
  -> EventHub notifies open Dashi windows
```

Webhook body 不應直接寫入 Task table。

### 路徑三：使用者在 Dashi 修改 external issue

```text
User edits task in Dashi
  -> validate provider capability and local task version
  -> send provider API mutation
  -> fetch or accept canonical provider response
  -> reconcile local materialized view
  -> emit UI event
  -> later webhook delivery is deduplicated or reconciled idempotently
```

如果 provider 更新成功但本機 reconciliation 失敗，UI 必須明確顯示 external success/local pending，並安排修復同步。

### 路徑四：Codex 透過 Linear MCP 修改

```text
User asks Codex to perform a semantic Linear operation
  -> Codex uses Linear MCP
  -> Linear changes canonical issue
  -> webhook or polling detects the change
  -> Dashi reconciles it as an external change
```

Dashi 不需要知道操作來自 Linear Web、Mobile App、MCP 或其他 OAuth client。

如操作同時需要更新 local thread binding、workspace、worktree 或 execution state，Codex 應使用 Dashi/taskctl 完成 local side effect，而不是把 local state 寫入 Linear。

### 路徑五：Tunnel 未啟動

```text
Webhook delivery fails
  -> Linear retries according to its delivery policy
  -> Dashi remains stale temporarily
  -> next startup or periodic incremental reconciliation repairs the gap
```

Webhook health 應在 UI 顯示，但 webhook unhealthy 不應讓 Linear project 失去基本可用性。

### 路徑六：純本地 Project

```text
User creates a local project
  -> Dashi writes SQLite
  -> local EventHub refreshes UI
  -> no provider API, webhook, Tunnel or MCP dependency
```

Local project 是一等模式，不應被 external provider architecture 移除。

## Sync metadata

現有 task external identity 可以保留，但 mapper 與 constraint 必須一般化。

至少需要以下資料物件。

### Provider connection

```text
provider_connections
  id
  provider_type
  provider_origin
  display_name
  auth_reference
  sync_strategy
  status
  created_at
  updated_at
```

### Provider issue identity

```text
tasks
  external_source
  external_origin
  external_id
  external_key
  external_url
  external_updated_at
  last_synced_at
  sync_state
  sync_error
```

### Incremental checkpoint

```text
provider_sync_cursors
  connection_id
  scope
  cursor
  updated_after
  last_success_at
  last_full_reconcile_at
```

### Webhook inbox

```text
provider_webhook_events
  delivery_id UNIQUE
  connection_id
  webhook_id
  organization_id
  event_type
  action
  entity_id
  event_created_at
  received_at
  payload_json
  processing_state
  processed_at
  attempt_count
  last_error
```

Webhook payload retention 應有明確期限，避免無限制保存 actor、comment 或 Issue 內容。

## Authentication 與 secrets

Linear GraphQL authentication、OAuth refresh token、Jira password、Linear webhook secret 與 Cloudflare Tunnel credential 是不同的 secret domain。

它們不應共用一個設定檔、shared password 或 transport token。

Desktop secret 應保存於作業系統 secure storage，SQLite 只保存 secret reference 與非敏感 metadata。

Jira 非 loopback connection 應要求 HTTPS。

Webhook secret 只授權 Linear event ingress，不能授權 Taskboard API、Linear GraphQL mutation 或 Codex capability。

Cloudflare Access 不應直接套在 Linear webhook path 上要求互動登入。

若使用 Worker 作前置 relay，Worker 可以先驗證 Linear HMAC，再以獨立 service credential 連到受保護的 origin。

## Conflict 與 ordering policy

External provider 是 shared field 的 canonical source。

Dashi local `version` 只能保護本機 concurrent mutation，不能被誤認為 provider revision。

Webhook delivery 是 at-least-once notification，因此所有 handler 必須 idempotent。

如果兩個 webhook 亂序到達，reconciliation 必須以目前 provider entity 為準，而不是最後收到的 payload。

如果 Dashi mutation 與 external mutation 同時發生，系統應保留 provider response、external updatedAt 與 local pending state，並讓 reconciliation 決定最後 canonical value。

不能以 actor 是目前 OAuth app 為由直接忽略 webhook，因為該 delivery 也是確認 provider 已接受 mutation 的證據。

## MCP 的正式定位

Linear MCP 是 optional agent-facing command adapter。

它不是 synchronization transport、application backend、event receiver、checkpoint store 或 source of truth。

MCP 適合以下操作。

- 讓 Codex 搜尋與分析跨 project Issue。
- 讓 Codex 建立、拆分或關聯 Issues。
- 讓 Codex閱讀 comments、documents、milestones與 project metadata。
- 讓 Codex 執行需要語意判斷的批次操作。
- 讓維運者進行唯讀診斷或人工修復。

MCP 不應負責以下操作。

- App 啟動同步。
- Background polling。
- Webhook 接收與簽章驗證。
- Delivery 去重。
- SQLite schema migration。
- Provider checkpoint 推進。
- Desktop process lifecycle。
- Herdr watchdog 或 orchestration recovery。

## Herdr 與 loop engineering 邊界

External provider integration 解決的是共享工作資料，不會自動取得 Herdr 的 execution observability。

Issue status 不應承載 pane、lease、heartbeat、receipt、retry、review lane 或 watchdog state。

若未來整合 Herdr，推薦增加獨立的 Operations UI 與版本化 adapter。

Work Board 顯示 Issue、project、priority、status、assignee與 due date。

Operations Board 顯示 Run、Attempt、Lane、Agent、Lease、Heartbeat、Receipt、Decision與 Evidence。

兩者可以在同一個 Dashi product 中呈現，但不能共用唯一狀態表。

## 風險改善摘要

本節只說明目標架構的改善方向。

詳細嚴重度、攻擊前提、證據、緩解與重新評估條件請參考 [`risk-assessment.md`](./risk-assessment.md)。

| 既有或新增風險 | 目標架構處理方式 |
| --- | --- |
| `RISK-001` LAN 未驗證存取 | Main Taskboard 全面 loopback-only，移除主要 LAN collaboration 路徑 |
| `RISK-004` cloud 保存本機 path/host | 不再使用 shared cloud board 作主要同步，local execution overlay 永不送往 provider |
| `RISK-006` Jira Basic over HTTP | 非 loopback Jira 強制 HTTPS，credential 改存 secure storage |
| `RISK-008` shared cloud password | External provider 使用個別帳號/OAuth，退場 shared-password board collaboration |
| `RISK-011` Tunnel 暴露整個 Taskboard | 使用獨立 webhook-only listener、單一路徑 ingress與 catch-all 404 |
| `RISK-012` 偽造或重播 Linear webhook | Raw-body HMAC、timestamp、organization check、constant-time compare與 delivery dedupe |
| `RISK-013` Desktop 離線導致 webhook gap | Startup、periodic與 manual incremental reconciliation |
| `RISK-014` API/MCP/webhook 多寫入路徑 | Linear canonical、單一 reconciliation pipeline、MCP 視為 external client |
| `RISK-015` provider sync 洩漏 local state | Shared/local field allowlist、outbound payload test與 opaque local mapping |
| `RISK-016` provider與Tunnel secrets | 分離 secret domain並使用 OS secure storage |

這項架構不會自動修復 `RISK-002`、`RISK-003`、`RISK-005`、`RISK-007`、`RISK-009` 或 `RISK-010`。

這些風險仍需要在 `risk-assessment.md` 所列的獨立 remediation 中處理。

## 遷移順序

### Phase 0：固定現況與安全邊界

**Classification:** foundation。

- 將 standalone 預設 listener 改為 loopback。
- 為現有 Jira main path 建立 regression coverage。
- 記錄 local-only field allowlist。
- 將 provider authentication 與 secret storage contract 定義清楚。

完成 Phase 0 後還沒有 Linear integration。

### Phase 1：通用 provider abstraction

**Classification:** foundation。

- 移除 `source === "jira"` 的散落能力判斷。
- 建立 provider registry、capabilities、normalizer與 reconciliation service。
- 讓 JiraProvider 使用新 contract，但保持現有 60 秒 refresh、手動同步、JQL scope與 write behavior。
- 一般化 external source mapper與 unique identity。

完成 Phase 1 後還沒有 Linear integration，但 Jira 行為應保持不變。

### Phase 2：Linear API baseline

**Classification:** destination。

- 建立 Linear authentication、connection settings與 project/team mapping。
- 實作 list/get/create/update、status、labels、comments、relations與 cursor pagination。
- 實作 startup、manual與 periodic incremental reconciliation。
- 即使沒有 MCP 或 Tunnel，也能完整使用 Linear-backed project。

完成 Phase 2 後已具備正確但非即時的 Linear integration。

### Phase 3：Webhook-only listener 與 Cloudflare Tunnel

**Classification:** destination。

- 新增獨立 loopback listener。
- 新增 HMAC、timestamp、delivery dedupe與 durable inbox。
- 建立 targeted reconciliation worker。
- 建立 Tunnel hostname/path/catch-all 設定與 health UI。
- 驗證 App 關閉、睡眠、Tunnel 中斷與 delivery 重送後的恢復。

完成 Phase 3 後已具備接近即時且可補漏的 Linear integration。

### Phase 4：Linear MCP optional adapter

**Classification:** optional enhancement。

- 文件化 MCP 與 Dashi provider 的權責邊界。
- 讓 Codex 能對 Linear 作跨 project 語意操作。
- 確認 MCP mutation 會透過 webhook/reconciliation 回到 Dashi。
- 禁止 core sync 依賴 MCP availability。

完成 Phase 4 後增加 Agent 能力，但不改變同步正確性。

### Phase 5：退場原生 shared-board collaboration

**Classification:** destination cleanup。

- 決定既有 LAN與 Cloudflare D1/R2 shared board 的 deprecation policy。
- 提供把 shared business data 移轉到 Jira、Linear或 local project 的路徑。
- 保留 device-local companion 與 execution overlay，但移除 shared password與 direct board synchronization 責任。
- 不刪除使用者資料，直到 migration 與 rollback 已被驗證。

完成 Phase 5 後，Dashi 不再自行承擔多裝置共享 Issue database。

## 驗收標準

### Provider correctness

- Jira 在 provider refactor 後保持原本 assigned scope、60 秒 refresh、手動同步與 supported writes。
- Linear 在沒有 Tunnel與 MCP 時仍能建立、讀取、更新與增量同步。
- 每個 external issue 具有穩定的 provider、origin與 external ID identity。
- Provider status mapping 是 connection/project scoped，而不是全域字串判斷。

### Webhook security

- Public hostname 只能到達 webhook-only listener。
- `/webhooks/linear` 以外的 path 由 Tunnel catch-all 回覆 404。
- Main Taskboard API 從 public hostname 不可達。
- 無效 HMAC、過期 timestamp、錯誤 organization與重複 delivery 都不造成 task mutation。
- Handler 在 durable acceptance 後五秒內回覆 200。

### Recovery

- Desktop 關閉超過 Linear delivery retry window 後，重新啟動仍能補回所有 provider changes。
- Checkpoint 只在完整 page transaction 成功後推進。
- Webhook 亂序與重送不會讓 task 回到舊狀態。
- Provider API 成功但 local write 失敗時，UI 顯示可恢復狀態並能重新 reconciliation。

### Privacy

- Linear、Jira與 webhook payload 不包含 workspacePath、worktree path、Codex host ID、thread ID、Launcher token或 Herdr runtime state。
- Secrets 不出現在 SQLite business tables、logs、comments、Issue description或 diagnostic export。
- MCP 讀寫不繞過 local-only field policy。

### Product behavior

- Local project 不依賴外部服務。
- External provider project 保留清楚的 source、sync health與 last successful sync。
- issueStatus 與 executionStatus 在 UI 與 persistence 中可分辨。
- Webhook unhealthy 不會阻止手動同步或 API polling。

## 非目標

- 本文件不要求把 Dashi Taskboard 整體部署到 Cloudflare。
- 本文件不要求多台裝置直接共用同一份 Dashi SQLite。
- 本文件不要求把 Taskboard UI 公開到 Internet。
- 本文件不要求 Linear MCP 成為必要依賴。
- 本文件不要求立即移除 Jira 或改變 Jira assigned issue scope。
- 本文件不把 Herdr control plane、pane visibility或 full loop engineering 視為 Linear integration 的一部分。
- 本文件不宣稱 Codex Desktop private bridge、CDP injection或 App Server 已成為穩定公開 extension API。

## 重新評估條件

發生以下事項時應重新評估本架構。

- Linear webhook payload、signature、retry或 OAuth contract 改變。
- Linear MCP tool schema 或官方定位改變。
- Cloudflare Tunnel path rule、origin header或 Access policy 行為改變。
- Jira authentication、REST API或 assigned issue scope改變。
- Dashi 決定重新支援多裝置 shared board。
- Local-only execution data需要跨裝置 portability。
- Herdr adapter 或 Dashi-native control plane進入實作。
- Codex App Server、Desktop bridge、CDP或 Launcher lifecycle改變。

## 相關文件與實作位置

- [`risk-assessment.md`](./risk-assessment.md) 記錄詳細安全風險、嚴重度、證據與 mitigation。
- [`investigate.md`](./investigate.md) 記錄 Codex App Server、browser pane、CDP、Desktop bridge與 private protocol 調查。
- [`herdr-comparison.md`](./herdr-comparison.md) 記錄 Work Board 與 orchestration control plane 的完整邊界。
- `server/jira-integration.mjs` 是目前 pull-based Jira provider 的實作基礎。
- `server/app.mjs` 是目前 main Taskboard HTTP router、SQLite service wiring與 EventHub 所在位置。
- `server/database.mjs` 保存 external issue identity與本機 task version。
- `web/src/App.tsx` 實作 Jira foreground refresh與 SSE-driven UI refresh。
- `scripts/codex-injector.mjs` 與 `src-tauri/src/main.rs` 定義 Launcher、instance token與 loopback runtime。
- `docs/cloud-collaboration.md` 描述現有 Cloudflare shared-board mode，該模式不是本文件的目標同步架構。
