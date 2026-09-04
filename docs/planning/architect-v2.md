# Dashi Taskboard 目標架構 V2：Herdr Autonomous Loop Portal

## 文件狀態

本文件記錄截至 2026-08-27 為止，Dashi Taskboard 與 Herdr 結合成 Agentic Operations Portal 的另一條演進路線。
本文件依據目前 repository revision `5c96d1ab698362994283ba0af86021db0a98dd89`、現有 Taskboard automation、Codex App Server wrapper，以及既有的 Taskboard／Herdr 能力比較整理。
本文件是目標架構與遷移決策，不代表 repository 已經具有 Herdr adapter、Run projection、Operations UI、dispatch protocol 或 durable execution receipt。
本次只建立文件，沒有啟動、控制或修改任何 Herdr session、pane、Agent、watchdog、PM、queue 或 runtime state。

以 Jira、Linear 與 Cloudflare webhook 為主的 provider 架構請參考 [`architect.md`](./architect.md)。
Taskboard 與 Herdr 的現況能力比較請參考 [`herdr-comparison.md`](./herdr-comparison.md)。
Codex App Server、CDP injection 與 Desktop private bridge 的調查請參考 [`investigate.md`](./investigate.md)。
既有安全風險與詳細 remediation 請參考 [`risk-assessment.md`](./risk-assessment.md)。

## 一句話結論

Herdr 應保留為可獨立運作的 autonomous loop engine，Dashi 應進化為工作入口、執行派發、人類決策與結構化 loop observability portal。

Dashi 可以把 Task 派發給 Herdr，Herdr 可以自行 decomposition、執行、驗證、重試與恢復，再把 Run、Stage、Attempt、Agent、Decision 與 Receipt 投影回 Dashi。

Dashi 不應重新實作 Herdr，也不應以 Codex App、browser pane 或 CDP session 的存活作為 full autonomous loop 的可靠性基礎。

## 目的地形態判定

**Target:** 讓 Herdr 同時支援 standalone autonomous loop 與 Dashi-dispatched loop，並讓 Dashi 提供 Work Board、Operations Board、Task-to-Run binding、human decision inbox 與 execution evidence portal。

**This proposal is:** destination architecture。

**After completion, will we actually have the target architecture/runtime?:** 若完成 Herdr intake contract、版本化 adapter、durable event projection、dispatch／decision／receipt protocol 與 Operations UI，答案是。

**If no, what will still be missing?:** 若只完成唯讀 Run projection，仍缺少 Dashi dispatch、decomposition materialization、human decision round-trip、cancel／retry control、completion receipt 與 reconnect recovery。

## 與 V1 架構的關係

[`architect.md`](./architect.md) 與本文件回答不同問題。

| 文件 | 主要問題 | 核心目的地 |
| --- | --- | --- |
| `architect.md` | 多裝置與團隊如何共享 Issue 資料 | Jira／Linear canonical，Dashi local materialized view |
| `architect-v2.md` | Task 如何成為可監控、可恢復的 autonomous execution loop | Herdr canonical execution control plane，Dashi Operations Portal |

兩條路線不是互斥方案。

V1 可以先完成 provider integration，而不導入 Herdr。
V2 可以先以 local Dashi Task 作為工作來源，而不依賴 Jira 或 Linear。
完整產品可以同時採用兩者，形成以下分層。

```text
Jira / Linear / Local Project
  -> Dashi Work Board
  -> Herdr Autonomous Loop
  -> Dashi Operations Board
  -> Human acceptance
  -> Jira / Linear workflow update
```

## 核心架構原則

### Herdr 必須可以獨立運作

Herdr 不應依賴 Dashi process、Codex App window、browser pane 或 provider connection 才能繼續既有 Run。

Dashi 關閉、重新啟動或升級時，Herdr 必須保留 Run ownership、lease、heartbeat、queue、decision、receipt 與 recovery state。

Dashi 是 Herdr 的 client 與 presentation layer，不是 Herdr durable state 的唯一保存位置。

### 同一套 engine 接受兩種 intake

Herdr 應以同一套 Run、Stage、Attempt、Lane、Lease、Watchdog 與 Receipt engine 接受 standalone goal 或 Dashi Task。

不能為 Dashi-dispatched Task 建立另一套簡化 loop，否則兩種入口會逐漸產生不同的 recovery、review 與 completion semantics。

### Work state 與 execution state 分離

Dashi Task 回答「要完成什麼工作，以及人類工作流程走到哪裡」。

Herdr Run 回答「這次執行由誰擁有、進行到哪個 stage、是否存活、是否需要決策，以及是否具有完成證據」。

Issue status、execution status 與 Herdr internal state 必須是三個不同層級。

### Structured evidence 優先於 raw pane

Dashi 應優先顯示 topology、event、decision、receipt、evidence 與 health projection。

Terminal pane 與逐行輸出可以作為深入診斷入口，但不能成為唯一的生命週期或完成證據來源。

### 關閉 Codex App 不得停止 control loop

Codex App 可以提供互動、人工接管、thread history 與 App Server actuator。

Full autonomous loop 的正確性不能依賴 Codex App 視窗保持開啟。

### Decomposition 不應污染 Work Board

Herdr internal Stage、Attempt、retry 與 verification step 預設只存在於 execution control plane。

只有具有獨立交付物、可單獨接受、需要不同負責人或需要跨 Run 保存的工作，才 materialize 成 Dashi child Task。

## 已觀察的現況

目前 Dashi 已經具備 Task、Project、Comment、Relation、Development Context、Conversation Binding 與 local AI chat。

Taskboard 可以開啟原生 Codex thread，也會直接啟動 `codex app-server --stdio` 作為 Codex execution actuator。

`shared/taskboard-automation.mjs` 已經提供 bounded per-issue automation loop。

目前 automation 可以認領 Task、建立 conversation、執行 turn、更新 Task 與重複處理，但沒有通用的 Run topology、cross-Agent lease、fencing、heartbeat、receipt、watchdog、fairness、dead-letter 或 closure contract。

目前 repository 沒有 Herdr workspace、pane topology、blackboard、pm-board、watchdog 或 receipt adapter。

因此，V2 是新的 integration destination，不是既有功能的重新命名。

## Target architecture

```text
                 Shared and local work data
       ┌────────────────────────────────────────┐
       │                                        │
 Jira / Linear                            Local Project
       │                                        │
       └──────────────────┬─────────────────────┘
                          │
                   Dashi Work Board
              Task / priority / issueStatus
              folder / thread / worktree map
                          │
                   Execution Request
                          │
                Dashi Orchestration Gateway
            idempotency / policy / authorization
                          │
                  Versioned Herdr Adapter
                          │
                 Herdr Autonomous Engine
       ┌──────────────────┼──────────────────────┐
       │                  │                      │
    Planner          Execution lanes       Watchdog / PM
       │                  │                      │
       └─────── Run / Stage / Attempt / Receipt ┘
                          │
              Codex CLI / App Server executors
                          │
                 Git / worktree / tests
                          │
               Durable Herdr event stream
                          │
                    Dashi Projector
                          │
          Execution summary / timeline / evidence
                          │
               Dashi Operations Board
                          │
           Human decision / acceptance / retry
```

## 責任分工

| 系統 | Canonical responsibility |
| --- | --- |
| Jira／Linear | External Issue 內容、priority、assignee 與共享 workflow state |
| Dashi Work Board | Local Task、provider projection、folder/thread/worktree mapping 與 human acceptance |
| Dashi Orchestration Gateway | 把 Task 轉成具 idempotency 與 policy 的 execution request |
| Herdr | Run、Stage、Attempt、Lane、Agent、Lease、Heartbeat、Watchdog、Decision、Receipt 與 recovery |
| Codex CLI／App Server | 執行受控的 Agent attempt |
| Dashi Projector | 把 Herdr snapshot 與 event 轉成 read model |
| Dashi Operations Board | 顯示 execution topology、health、timeline、evidence 與 action controls |

## Herdr 的兩種執行入口

### Standalone autonomous loop

Herdr 可以直接接受 goal、spec、issue reference 或 operator request。

它自行建立 Run、decompose stages、安排 lanes、派發 Agents、執行 verification、處理 decision 與完成 closure。

Dashi 不是這條路徑的必要依賴。

Herdr 可以在 Run 建立後或執行途中選擇性地 attach 到 Dashi Task，以取得 Work Board visibility。

### Dashi-dispatched loop

Dashi 使用者從 Task Detail 選擇 Start autonomous execution。

Dashi Orchestration Gateway 建立一個具有 stable request ID 的 execution request，並交給 Herdr adapter。

Herdr 以相同 engine 建立 Run，回傳 Run identity 與 accepted receipt。

Dashi 保存 Task-to-Run binding，接著只透過 Herdr snapshot 與 event 更新 execution projection。

## Execution request contract

建議的最小 request contract 如下。

```ts
interface ExecutionRequest {
  protocolVersion: string;
  requestId: string;
  taskRef: {
    dashiTaskId: string;
    source: "local" | "jira" | "linear";
    externalRef?: string;
  };
  objective: string;
  acceptanceCriteria: string[];
  contextRefs: ContextReference[];
  workspaceRef: string;
  executionPolicy: {
    autonomy: "supervised" | "bounded-autonomous" | "autonomous";
    allowDecomposition: boolean;
    allowChildTaskMaterialization: boolean;
    requireHumanAcceptance: boolean;
    maxParallelLanes?: number;
  };
  requestedBy: ActorReference;
  requestedAt: string;
}
```

`requestId` 必須具有 durable unique constraint。

同一個 request 重送時，Herdr 必須回傳既有 Run identity，而不是建立第二個 Run。

`workspaceRef` 應是 Dashi 與 Herdr 本機 adapter 共同解析的 opaque reference，不應直接傳送到 Jira、Linear 或外部 webhook。

Request 不應包含 provider token、Launcher token、Codex cookie、CDP session、absolute path dump 或未經分類的完整 Task JSON。

## Run acceptance contract

Herdr 接受 request 後應回傳具 durable identity 的 receipt。

```ts
interface ExecutionAccepted {
  protocolVersion: string;
  requestId: string;
  runId: string;
  runVersion: number;
  acceptedAt: string;
  status: "accepted" | "already-accepted";
}
```

Dashi 只能在收到 `accepted` 或 `already-accepted` receipt 後，把 executionStatus 改為 `queued`。

HTTP、socket 或 process transport 成功不代表 Herdr 已接受 request。

## Herdr decomposition model

Herdr 可以把一個 Dashi Task 分解成 Run internal graph。

```text
Dashi Task
  -> Herdr Run
       -> Stage: discovery
            -> Attempt 1
       -> Stage: implementation
            -> Lane: backend
            -> Lane: frontend
       -> Stage: verification
            -> Attempt 1 failed
            -> Attempt 2 passed
       -> Stage: review
       -> Stage: integration
```

### Internal Stage

Internal Stage 是 Herdr control-plane object。

它適用於分析、實作步驟、retry、verification、review、integration 與 closure obligation。

Internal Stage 在 Dashi 中以 virtual execution node 顯示，不建立正式 Task。

### Materialized child Task

只有符合以下至少一項時，Herdr 才可以請求建立 Dashi child Task。

- 子工作具有可獨立接受的業務交付物。
- 子工作需要不同的人類 owner 或外部 assignee。
- 子工作會跨越目前 Run lifecycle。
- 子工作需要獨立 priority、deadline 或 provider visibility。
- 子工作被明確要求同步到 Jira 或 Linear。

Materialization 必須透過 Dashi API 完成，Herdr 不應直接寫入 Dashi SQLite。

每一個 materialization request 必須包含 deterministic child key，避免 reconnect 或 retry 建立重複 Task。

Herdr internal Stage 完成時，不應自動刪除或關閉已 materialize 的 child Task。

## 三層狀態模型

### Issue status

Issue status 是團隊工作流程狀態。

```text
backlog | todo | in_progress | in_review | blocked | done | canceled
```

### Dashi execution status

Dashi execution status 是 Herdr Run 的簡化 projection。

```text
idle | dispatching | queued | running | waiting | recovering |
failed | completed | canceled | stale | unknown
```

### Herdr internal state

Herdr internal state 保存完整 Run、Stage、Attempt、Lane、Lease、Heartbeat、Intent、Result、Receipt、Decision、Watchdog 與 closure state。

Dashi execution status 不能反向覆寫 Herdr internal state。

Issue status 也不能作為 Herdr liveness 或 ownership 的判斷依據。

## 狀態投影規則

| Herdr observation | Dashi executionStatus | Issue status effect |
| --- | --- | --- |
| Request 尚未收到 accepted receipt | `dispatching` | 不變 |
| Run 已排入 queue | `queued` | 可依 policy 改成 `in_progress`，預設不自動改 |
| 至少一個 active Attempt 且 lease 健康 | `running` | 不變 |
| 等待 human decision | `waiting` | 可顯示 blocked reason，但不自動改 Issue status |
| Watchdog 正在恢復 Run | `recovering` | 不變 |
| Run 無法繼續且有 terminal failure receipt | `failed` | 不自動改成 `blocked` |
| Run 產生 verified completion receipt | `completed` | 預設改成 `in_review`，不直接改成 `done` |
| Projection 超過 freshness threshold | `stale` | 不變 |

「Agent 執行完成」與「工作已被接受」是兩件事。

只有使用者明確接受，或 Task 擁有事先定義的 acceptance policy，Dashi 才能把 Issue status 更新為 `done` 並同步到 Jira 或 Linear。

## Durable event contract

Dashi 不應透過輪詢 terminal text 猜測 Herdr lifecycle。

Herdr adapter 應提供版本化 snapshot 與可恢復 event stream。

```ts
interface HerdrEventEnvelope {
  protocolVersion: string;
  runId: string;
  sequence: number;
  eventId: string;
  eventType: string;
  occurredAt: string;
  payload: unknown;
}
```

`eventId` 必須全域唯一或至少在 Run 內唯一。

`sequence` 必須在 Run 內單調遞增。

Dashi projector 必須以 `(runId, eventId)` 去重，並保存最後連續 sequence。

發現 sequence gap 時，projector 必須停止宣稱 projection 為 fresh，重新抓取 Run snapshot，再從 snapshot cursor 繼續。

Raw pane output 可以保存 reference、offset 與摘要，但不能取代 structured event。

## Operations projection

Dashi 可以保存以下 read model。

```text
execution_runs
  run_id
  task_id
  request_id
  protocol_version
  run_version
  execution_status
  current_stage
  last_sequence
  last_event_at
  projection_freshness
  completion_receipt_id

execution_stages
  stage_id
  run_id
  parent_stage_id
  title
  stage_type
  state
  order_key

execution_attempts
  attempt_id
  stage_id
  agent_ref
  lane_ref
  state
  started_at
  ended_at
  evidence_summary

execution_decisions
  decision_id
  run_id
  stage_id
  state
  prompt
  options
  requested_at
  resolved_at

execution_evidence
  evidence_id
  run_id
  stage_id
  evidence_type
  summary
  reference
  recorded_at
```

這些資料是 Herdr state 的 projection，不是第二份 canonical control-plane database。

Dashi 可以重建 projection，因此不能讓 Herdr recovery 依賴這些 read model。

## Dashi Operations UI

### Task execution summary

Task Detail 顯示 executionStatus、Run、current stage、active Agents、last heartbeat、freshness、decision count 與 evidence summary。

### Loop timeline

Timeline 顯示 Run accepted、Stage transition、Attempt、retry、watchdog action、decision、review、integration 與 completion receipt。

### Stage graph

Stage graph 顯示 decomposition、dependency、parallel lane 與目前 critical path。

### Current Agents

Current Agents 顯示 Agent identity、role、lane、attempt、lease health、last heartbeat 與 public activity summary。

### Decision Inbox

Decision Inbox 顯示等待人工 approval、選擇、credential、scope change 或 destructive action 的 request。

### Evidence

Evidence 顯示 test、review、commit、PR、artifact、screenshot、receipt 與 closure reason。

### Deep diagnostics

Open in Herdr Operations 可以打開 Herdr 原生 Operations UI 或 terminal substrate。

Dashi 不必把所有 PTY bytes、pane control 或 terminal emulator 能力重新實作一次。

## Dashi 可以發送的控制命令

Dashi 第一階段應以唯讀 projection 開始。

後續可加入以下明確 command。

- Start execution。
- Submit decision。
- Request pause。
- Request resume。
- Request cancel。
- Request retry from Stage。
- Accept completion。
- Reject completion with reason。

每個 command 必須有 command ID、actor、expected Run version、requestedAt 與 durable result receipt。

Dashi 不應直接修改 Herdr state file、blackboard、pane process 或 lease record。

「按鈕已送出」和「Herdr 已完成 command」必須在 UI 中顯示為不同狀態。

## 真實操作路徑

### 路徑一：Dashi 派發 Task

```text
User opens a Dashi Task
  -> selects Start autonomous execution
  -> Dashi validates folder, objective and acceptance criteria
  -> Orchestration Gateway creates stable requestId
  -> Herdr adapter submits ExecutionRequest
  -> Herdr durably accepts or returns existing Run
  -> Dashi stores Task-to-Run binding
  -> executionStatus becomes queued
  -> Herdr continues independently
```

Dashi 在 durable accepted receipt 前不能宣稱 Run 已啟動。

### 路徑二：Herdr standalone Run attach 到 Dashi

```text
Herdr creates a standalone Run
  -> operator or policy selects a Dashi Task reference
  -> Herdr sends attach request
  -> Dashi validates Task and current binding
  -> Dashi records Run binding idempotently
  -> existing Herdr snapshot is projected
```

Attach 不得改變 Herdr Run ownership 或重啟 execution。

### 路徑三：Herdr 自行 decomposition

```text
Herdr planner decomposes Run
  -> internal Stages are written to Herdr durable state
  -> Herdr emits topology events
  -> Dashi projector updates virtual Stage graph
  -> only approved materialization requests create child Tasks
```

### 路徑四：等待人工決策

```text
Herdr reaches a decision boundary
  -> records durable DecisionRequest
  -> emits waiting event
  -> Dashi executionStatus becomes waiting
  -> Decision Inbox notifies the user
  -> user submits decision
  -> Dashi sends versioned DecisionResponse
  -> Herdr records receipt and resumes Run
```

Dashi notification 消失或 App 關閉時，DecisionRequest 必須仍保存在 Herdr。

### 路徑五：完成與接受

```text
Herdr finishes implementation and verification
  -> produces CompletionReceipt with evidence references
  -> Dashi executionStatus becomes completed
  -> Task enters in_review when policy allows
  -> user inspects evidence
  -> user accepts or rejects
  -> accepted Task may move to done
  -> provider-backed Task synchronizes workflow status
```

### 路徑六：Dashi 關閉後重連

```text
Dashi process stops
  -> Herdr keeps executing and recording events
  -> Dashi starts later
  -> projector loads last sequence
  -> adapter provides missing events or current snapshot
  -> projection catches up
  -> UI marks state fresh only after continuity is proven
```

### 路徑七：Codex App 或 executor 重啟

```text
Codex executor exits unexpectedly
  -> Herdr detects missing heartbeat or process result
  -> watchdog classifies the failure
  -> lease and attempt are closed or fenced
  -> recovery policy starts a new Attempt
  -> Dashi displays recovering and the new Attempt
```

Codex App restart 不應讓 Dashi 自行猜測 Run 已失敗或完成。

### 路徑八：取消

```text
User requests cancel in Dashi
  -> Dashi records command pending
  -> Herdr validates authority and current Run version
  -> Herdr records cancel intent
  -> Herdr stops or fences active Attempts
  -> Herdr writes cancel result receipt
  -> Dashi projection becomes canceled
```

取消按鈕不能直接 kill 未解析 PID 或透過 CDP 關閉不明視窗。

## Codex App 的正式定位

Codex App 是互動式 execution cockpit，不是 durable control plane。

它適合提供以下能力。

- Folder-based project context。
- Conversation thread 與人類可讀 trace。
- Git diff、commit、review 與人工接管。
- Codex App Server actuator。
- Taskboard browser pane 或 injected UI surface。

它不應負責以下能力。

- Canonical Run ownership。
- Cross-Agent lease 與 fencing。
- Durable queue 與 fairness。
- Watchdog 與 crash recovery。
- Intent／result receipt protocol。
- Event replay 與 sequence repair。
- Completion acceptance policy。

Browser pane、CDP injection 與 Desktop bridge 可以作為 UI integration adapter。

它們不應成為 Herdr command、receipt、heartbeat 或 recovery state 的唯一 transport。

## 故障與恢復語意

| 故障 | 正確行為 |
| --- | --- |
| Dashi UI 關閉 | Herdr Run 繼續，event 持續保存 |
| Dashi backend 關閉 | Herdr Run 繼續，Dashi command 暫停，重啟後補投影 |
| Herdr 暫時不可達 | Dashi Taskboard 繼續可用，executionStatus 標示 `stale` |
| Adapter event gap | 重新取得 snapshot，不用最後收到的 event 猜 state |
| Duplicate dispatch | 以 requestId 回傳既有 Run |
| Duplicate event | 以 eventId 去重 |
| Out-of-order event | 以 Run sequence 偵測並 repair |
| Codex executor crash | Herdr 關閉或 fence Attempt，再依 policy recovery |
| Jira／Linear outage | Herdr local Run 可繼續，provider workflow update 保持 pending |
| Human decision 長時間未回覆 | Herdr 保持 waiting，不能讓 watchdog 擅自猜測業務決策 |

## 安全與權限邊界

Herdr adapter 應使用 loopback-only、authenticated、versioned transport。

Dashi UI 不應直接連接 Herdr socket 或讀取 blackboard filesystem。

Dashi backend 應驗證使用者是否有權對特定 Task 與 Run 發送 start、cancel、retry、decision 或 acceptance command。

每個 command 必須保存 actor identity、request body digest、expected version、accepted receipt 與 final result。

Workspace、worktree、thread、pane、host、lease 與 process metadata 必須保持 local-only。

Jira、Linear、webhook、comment 與 provider attachment 不得接收完整 Herdr event、absolute path、pane output、Agent credential 或 Codex session identity。

Provider、Dashi、Herdr、Codex App Server 與 Tunnel credential 是不同的 secret domain，不能互相重用。

詳細既有安全風險與 provider boundary 請參考 [`risk-assessment.md`](./risk-assessment.md)。

## V2 特有風險

### Split-brain control

如果 Dashi 與 Herdr 都能直接改寫 Run state，可能出現兩個 controller 同時認為自己擁有 execution。

緩解方式是讓 Herdr 保持唯一 execution authority，Dashi 只送 command 並等待 receipt。

### Duplicate dispatch

Transport timeout 可能讓 Dashi 不知道 request 是否已被 Herdr 接受。

緩解方式是 durable requestId、idempotent accept 與可查詢的 request receipt。

### Stale projection

Dashi 可能顯示過期的 Agent、Stage 或 heartbeat。

緩解方式是 sequence、freshness、snapshot recovery 與明確的 stale UI。

### Child Task explosion

Herdr decomposition 可能把 runtime steps 大量 materialize 成正式 Task，造成 Work Board 與 Jira／Linear 汙染。

緩解方式是 internal Stage 預設、explicit materialization policy 與 deterministic child key。

### Protocol drift

Herdr、Dashi 與 Codex runtime 升級可能讓 event 或 command schema 不相容。

緩解方式是 protocol version negotiation、capability discovery、backward compatibility window 與 fail-closed command behavior。

### Local execution data leakage

Operations projection 包含比普通 Task 更敏感的 workspace、Agent、process、evidence 與 pane reference。

緩解方式是 local-only schema、outbound allowlist、redacted evidence summary 與 provider negative payload tests。

這些 V2 風險在進入實作前，應再正式編號並加入 [`risk-assessment.md`](./risk-assessment.md)。

## 演進順序

### Phase 0：定義 contract 與 authority

**Classification:** foundation。

- 定義 ExecutionRequest、ExecutionAccepted、EventEnvelope、Command、Decision 與 CompletionReceipt。
- 明確指定 Herdr 是 execution source of truth。
- 定義 Task、Run、Stage、Attempt 與 materialized child Task 的 identity。
- 定義 protocol version、capabilities、freshness 與 recovery semantics。
- 把 V2 特有風險加入 `risk-assessment.md`。

完成 Phase 0 後還不能從 Dashi 監控或派發 Herdr。

### Phase 1：唯讀 Herdr adapter

**Classification:** mixed foundation and destination。

- 建立 loopback-only、authenticated、versioned adapter。
- 讀取 Run snapshot 與 durable event stream。
- 建立 idempotent Dashi projector。
- 顯示 executionStatus、Run timeline、Stage graph、Agents 與 freshness。
- 保留 Open in Herdr 深入診斷入口。

完成 Phase 1 後，Dashi 可以監控 Herdr Run，但不能派發或控制。

### Phase 2：Dashi dispatch

**Classification:** destination。

- 建立 Orchestration Gateway。
- 實作 durable requestId 與 Task-to-Run binding。
- 從 Dashi Task 建立 Herdr Run。
- 支援 Herdr standalone Run attach 到 Dashi。
- 驗證 duplicate、timeout、restart 與 already-accepted path。

完成 Phase 2 後，Herdr 同時具備 standalone 與 Dashi-dispatched intake。

### Phase 3：Decision 與 command round-trip

**Classification:** destination。

- 建立 Decision Inbox。
- 實作 decision、pause、resume、cancel 與 retry command receipt。
- 加入 expected Run version 與 authority check。
- 區分 command pending、accepted、completed 與 rejected。
- 驗證 Dashi 關閉期間 DecisionRequest 不會遺失。

完成 Phase 3 後，Dashi 可以作為 human-in-the-loop control surface。

### Phase 4：Decomposition projection 與 materialization

**Classification:** destination enhancement。

- 顯示完整 Stage graph、parallel lanes、Attempts 與 evidence。
- 實作 internal Stage 與 child Task policy。
- 使用 deterministic child key 防止重複 materialization。
- 只把業務可追蹤交付物同步到 Jira 或 Linear。
- 驗證 retry 與 reconnect 不會產生 Task explosion。

完成 Phase 4 後，使用者可以在 Dashi 理解 Herdr 如何拆解與推進工作。

### Phase 5：Completion、acceptance 與 recovery closure

**Classification:** destination。

- 顯示 CompletionReceipt 與 evidence bundle。
- 實作人類 acceptance 或明確的 policy acceptance。
- 把 Run completed 與 Issue done 分離。
- 驗證 Dashi、Herdr、Codex App、executor 與 provider outage recovery。
- 建立 stale、dead-letter、unresolved decision 與 failed closure views。

完成 Phase 5 後，才具備可監控、可恢復、可稽核的完整 Dashi-to-Herdr loop。

### Phase 6：與 V1 provider architecture 結合

**Classification:** optional convergence。

- 讓 Jira／Linear Task 使用相同 Dashi dispatch path。
- 只把工作摘要、review 與 acceptance 投影回 provider。
- 不同步 heartbeat、lease、pane、absolute path 或 raw Herdr event。
- Provider outage 不得阻止已接受的 local Herdr Run。
- 避免 provider webhook、MCP、Dashi command 與 Herdr event 形成回授迴圈。

完成 Phase 6 後，Dashi 同時成為 external Work Board 與 local autonomous execution portal。

## 驗收標準

### Independent engine

- Herdr 在 Dashi 與 Codex App UI 關閉時仍能保存並推進已接受的 Run。
- Herdr standalone Run 不依賴 Dashi connection。
- Dashi 重啟後可以從 snapshot 與 event sequence 重建 projection。

### Dispatch correctness

- 同一個 requestId 永遠只對應一個 Herdr Run。
- Transport timeout 後重送不會建立 duplicate Run。
- Dashi 只有在收到 durable accepted receipt 後才顯示 queued。

### State ownership

- Dashi command 不直接修改 Herdr state、lease、pane 或 process。
- Herdr event 不直接修改 Jira／Linear Issue status。
- executionStatus、issueStatus 與 Herdr internal state 可以明確區分。

### Decomposition

- Herdr internal Stage 預設只出現在 Operations projection。
- Child Task materialization 具有明確 policy 與 deterministic identity。
- Retry、reconnect 與 event replay 不會建立重複 Task。

### Observability

- Dashi 可以顯示 Run、Stage、Attempt、Agent、health、decision、retry、watchdog、evidence 與 completion receipt。
- Event gap 或 adapter outage 時，UI 明確顯示 stale，而不是顯示舊資料為目前狀態。
- 使用者可以從 Dashi 進入 Herdr 深入診斷介面。

### Recovery

- Dashi backend outage 不會中止 Herdr Run。
- Codex executor crash 由 Herdr 關閉或 fence 舊 Attempt 後再 recovery。
- Snapshot recovery 可以修復 duplicate、out-of-order 與 missing event。
- Pending decision、command 與 receipt 在 process restart 後仍可重建。

### Acceptance

- CompletionReceipt 包含可追蹤的 evidence reference。
- Run completed 不會無條件把 Issue 改成 done。
- User rejection 可以建立新的 Herdr recovery／rework path，而不覆寫舊 receipt。

### Privacy and security

- Jira、Linear 與 webhook payload 不包含 Herdr internal event、workspace path、pane、lease、heartbeat 或 Codex identity。
- Adapter、provider、Codex 與 Tunnel credential 不互相重用。
- 所有 execution command 都具有 actor、authorization、idempotency 與 durable receipt。

## 非目標

- 本文件不要求把 Herdr runtime 重寫進 Dashi backend。
- 本文件不要求 Dashi 自己管理 PTY、tmux pane 或 Agent process。
- 本文件不要求把每個 Herdr Stage 建立成 Dashi、Jira 或 Linear Task。
- 本文件不要求把 raw model reasoning 顯示在 Dashi。
- 本文件不要求 Codex App 視窗保持開啟。
- 本文件不把 CDP injection 或 private Desktop bridge 當作 durable control protocol。
- 本文件不要求 Jira、Linear 或 Cloudflare 保存 local execution control state。
- 本文件不要求 V1 provider integration 必須先完成。

## 重新評估條件

發生以下事項時應重新評估本架構。

- Herdr Run、Stage、Attempt、receipt、watchdog 或 blackboard contract 改變。
- Herdr 提供正式 daemon API、event stream 或 Operations UI。
- Codex App Server、Codex CLI、Desktop bridge 或 CDP lifecycle 改變。
- Dashi 決定自行實作 orchestration runtime。
- Dashi 需要跨裝置控制同一個 active Herdr Run。
- Jira／Linear 開始承載 execution policy 或 acceptance workflow。
- Provider、Dashi 與 Herdr 之間出現新的 bidirectional write path。
- 任一 integration 需要把 local-only execution data 傳到外部服務。

## 決策摘要

| 決策 | 結論 |
| --- | --- |
| Herdr 是否可以獨立 autonomous | 必須可以 |
| Herdr 是否可以接收 Dashi Task | 可以，透過 idempotent ExecutionRequest |
| Herdr 是否可以自行 decomposition | 可以，預設形成 internal Stage graph |
| 每個 Stage 是否建立 Dashi Task | 否，只有符合 materialization policy 才建立 |
| Dashi 是否監控完整 loop | 顯示完整 structured lifecycle，raw pane 以 drill-down 方式提供 |
| Dashi 是否控制 Herdr state | 不直接控制，只送 versioned command 並等待 receipt |
| Codex App 是否是 loop engine | 否，它是 execution cockpit 與 actuator surface |
| Dashi 關閉後 Run 是否繼續 | 必須繼續 |
| Herdr completed 是否等於 Issue done | 不等於，仍需要 acceptance policy |
| V1 與 V2 是否互斥 | 不互斥，可以最後收斂成完整產品 |

## 最終結論

Dashi V2 的價值不是把 Taskboard 變成另一套 Herdr，而是把 Herdr 的 autonomous execution capability 產品化成可派發、可觀察、可決策與可接受的 Work Portal。

Herdr 保留完整 runtime authority、failure recovery 與 durable evidence。

Dashi 保留 Task、folder、thread、worktree、Issue workflow 與 human acceptance。

兩者透過版本化、authenticated、idempotent、receipt-driven adapter 連接。

這條演進路線可以讓 Herdr 同時作為獨立 autonomous loop engine，也能承接 Dashi 派發的 Task 並自行 decomposition，而使用者可以在 Dashi 監控完整的結構化 loop lifecycle。

## 相關文件與實作位置

- [`architect.md`](./architect.md) 定義 Jira／Linear provider、webhook 與 local-first data architecture。
- [`herdr-comparison.md`](./herdr-comparison.md) 記錄 Taskboard 與 Herdr 的現況能力差異。
- [`investigate.md`](./investigate.md) 記錄 Codex App Server、browser pane、CDP 與 Desktop bridge 邊界。
- [`risk-assessment.md`](./risk-assessment.md) 記錄既有安全風險、嚴重度與 remediation。
- `server/codex-app-server.mjs` 是目前 Codex App Server execution wrapper。
- `shared/taskboard-automation.mjs` 是目前 bounded per-issue automation loop。
- `server/app.mjs` 是目前 Taskboard HTTP API、SQLite wiring 與 EventHub 所在位置。
- `web/src/components/AiChat.tsx` 是目前 local AI activity surface。
- `web/src/App.tsx` 是目前 Task、conversation 與 native Codex thread 的主要 UI wiring。
