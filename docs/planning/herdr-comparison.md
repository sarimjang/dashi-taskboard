# Taskboard 與 Herdr 的完整比較

## 文件狀態

本文件記錄截至 2026-08-26 為止，對本 repository 與 Herdr 執行模型的完整比較結論。
檢視的 repository revision 是 `main` 上的 `5c96d1ab698362994283ba0af86021db0a98dd89`。
本文件以 repository 現有程式碼、`investigate.md` 的 Codex App 介接調查，以及目前安裝的 Herdr skill 契約作為主要依據。
本次只做唯讀分析與文件整理，沒有啟動、控制或修改任何 Herdr session、pane、Agent、watchdog 或 PM state。
本文件描述目前版本的能力邊界，不代表 Taskboard 或 Herdr 未來版本的相容性承諾。

## 一句話結論

Taskboard 現在是一個工作管理與 Codex 對話入口，而 Herdr 是一個把 Agent 執行拓撲、終端 pane、生命週期與 orchestration control plane 顯式化的執行環境。
Taskboard 能顯示工作做到哪裡、哪個 Issue 綁定哪個對話，以及部分對話活動，但目前不能像 Herdr 一樣在同一個控制面完整巡檢每個 Agent pane、lane、heartbeat、dispatch receipt、queue、decision request 與 PM 狀態。
Taskboard 可以用 Issue 狀態表達高階流程，但不應把所有底層控制事件都壓縮成 Task 狀態，因為業務工作狀態與執行控制狀態是兩種不同的資料。
若目標是把 Herdr 等級的可觀測性放進 Taskboard，正確方向是增加獨立的 orchestration control plane 與 Operations UI，而不是單純增加更多 Issue status。

## 先分清楚三種可視性

本次討論中最重要的區分，是「工作可視性」、「對話可視性」與「執行控制面可視性」不是同一件事。

| 可視性層級 | 核心問題 | Taskboard 現況 | Herdr 現況 |
| --- | --- | --- | --- |
| 工作可視性 | 要做什麼，以及做到哪裡 | 強 | 可整合外部 tracker，但不是主要 UI |
| 對話可視性 | Agent 回覆了什麼，以及公開了哪些活動 | 部分具備 | 可從 Agent pane 與 handoff 觀察 |
| 執行拓撲可視性 | 哪個 Agent 在哪個 runtime、pane、worktree 或 host | 很有限 | 強 |
| 控制狀態可視性 | 誰擁有工作、是否收到指令、是否仍存活、是否等待決策 | 很有限 | 透過 blackboard、watchdog 與 pm-board 顯式管理 |
| 恢復可視性 | crash 或 context loss 後能否從 durable state 重建 | Issue 與本地對話可恢復，但沒有完整 orchestration recovery model | 以 state、journal、lane、handoff、receipt 與 decision log 為核心 |

## Taskboard 的本質

這個 repository 的 Taskboard 本質上是一個 local-first 工作管理介面。
它可以單獨管理本地專案，也可以選擇把 Jira 等外部服務當成 Issue 來源或同步目標。
它的核心資料單位是 Project、Issue、Comment、Relation、Attachment、Development Context 與 Conversation Binding。
它不是單純把 Jira backlog 換一個皮膚，也不是只有嵌入 Codex Desktop 的 Jira client。
即使完全不連 Jira 或其他外部 tracker，它仍然可以作為本地 Taskboard 使用。

Taskboard 目前已經具備以下工作管理能力。

- 它可以用 `backlog`、`todo`、`in_progress`、`in_review`、`blocked`、`done` 與 `canceled` 等狀態呈現工作進度。
- 它可以記錄 Issue 的依賴、comment、attachment、branch、worktree 與其他 development context。
- 它可以把 Issue 綁定到特定 Codex thread、Codex project、host 與 workspace path。
- 它可以從 Dashboard 顯示目前正在處理的 Task 與 active conversation。
- 它可以透過 local AI chat 在 Taskboard 內直接建立與瀏覽 Codex 對話。
- 它可以透過 deep link 或 injected host bridge 打開原生 Codex conversation。
- 它可以建立週期性 Codex automation，自動尋找可執行的 `todo`、認領工作、執行、記錄結果並移到 `in_review`。

## Taskboard 現在實際能看到哪些 Agent 活動

Taskboard 並不是完全看不到 Agent 執行過程。
它已經具有一層結構化的 conversation activity visibility。

`web/src/components/AiChat.tsx:1054-1160` 會把 local AI chat 的事件整理成可展開的 Thinking Steps。
這些事件可以呈現 running、failed 與 completed 狀態，也可以顯示檔案、file change、todo、warning 與其他公開活動摘要。
`web/src/components/AiChat.tsx:2942-3008` 會顯示 local chat history、thread status、message timeline 與 Codex working indicator。
`web/src/components/DashboardView.tsx:591-624` 會顯示 Active conversations，並讓使用者從執行中的 Task 打開相關對話。
`web/src/App.tsx:2828-2873` 會依 conversation binding 打開 Taskboard local AI chat、原生 Codex thread 或 SSH remote conversation。

因此，Taskboard 現有可視性比較接近以下模型。

```text
Task
  -> status
  -> comments
  -> conversation binding
  -> local structured activity timeline
  -> open the corresponding Codex thread
```

這個模型適合回答「這個工作目前由哪個對話處理」、「對話正在執行還是完成」與「Agent 公開了哪些活動」。
這個模型不能直接回答「目前總共有多少 pane」、「哪個 Agent 在哪個 pane」、「pane 是否仍有前景程序」、「哪個 dispatch 已送出但尚未收到 receipt」或「PM 為什麼沒有派送下一個 lane」。

## Taskboard 目前的 automation loop

Taskboard 已經具有一個有實際 side effect 的自動化循環，而不只是視覺化看板。
`shared/taskboard-automation.mjs:95-131` 會產生自動認領 prompt。
`shared/taskboard-automation.mjs:146-157` 會把它建立成以分鐘為間隔的 Codex automation。

這個自動化目前可以執行以下主路徑。

```text
週期觸發
  -> 讀取 todo
  -> 檢查 dependency、comment、version 與 thread binding
  -> 認領一個 Issue
  -> 綁定或恢復 Codex thread
  -> 執行或派送遠端工作
  -> 等待 thread
  -> 寫入結果 comment
  -> 移動到 in_review 或 blocked
```

這是一個有用的 per-issue bounded automation loop。
它還不是 Herdr resident-PM 意義下完整的可恢復 multi-agent engineering loop。

目前 automation 的主要可視狀態仍然集中在 Issue status、comment、thread binding、automation active/paused 與 quota state。
`web/src/components/ProjectAutomationMenu.tsx:84-97` 會顯示 Running、Paused、Paused by quota、Quota unavailable 與 Quota unknown。
這些狀態能說明 automation policy 是否啟用，但不能完整說明當前 run 的角色拓撲、dispatch receipt、lane ownership、retry history、heartbeat、integration gate 或 closure obligation。

## Herdr 的本質

Herdr 首先是一個能識別 coding agent 的 terminal multiplexer 與 Agent control surface。
它把 workspace、tab、pane、ordinary process 與 coding agent 視為可分別讀取和操作的執行物件。
它可以顯示或查詢 pane topology，並辨識 Agent 的 `idle`、`working`、`blocked`、`done` 與 `unknown` 等 lifecycle state。
它也可以讀取 pane 的 visible、recent、recent-unwrapped 與 detection output。

Herdr 的 resident-PM workflow 又在 terminal substrate 之上增加了一套 orchestration control plane。
這個 control plane 的核心不是 prompt，而是 `.spectra/blackboard` 下的 durable state、append-only event、handoff、decision、request、queue 與 receipt。
Pane message 在這個模型中只負責通知，實際內容與恢復依據由檔案承載。

Herdr resident-PM workflow 所提供的主要控制面能力包括以下項目。

- 它會把 orchestrator、resident PM、PM Leader、implementer、reviewer、repairer、integration agent 與 final verifier 視為不同角色。
- 它會把每個 Agent 指派到明確的 pane、tab、worktree、assignment、lane 與 handoff path。
- 它會在執行 side effect 前寫入 intent 或 decision，再執行動作並記錄 result 或 receipt。
- 它會將 queue、blocked decision request、next intent、PM phase 與 wake condition durable 化。
- 它會以 watchdog 機械化檢查 resident 與 leaf liveness。
- 它會以 pm-board 把 blackboard state 彙整成巡檢用 dashboard。
- 它會區分 planning、execution、verification、review、repair、integration、rollout、rollback、cleanup 與 closure evidence。
- 它會要求 completion gate，而不把單一成功回覆、綠色測試或 idle pane 當成整個 workflow 完成。

## Herdr 的可視性為什麼比 Taskboard 完整

Herdr 的優勢不是只有同時打開很多 terminal。
它的關鍵能力是把執行拓撲與控制狀態變成一等資料。

| Herdr 物件 | 代表的問題 | Taskboard 目前是否有等價物 |
| --- | --- | --- |
| Workspace、tab、pane | Agent 在哪個執行位置 | 沒有完整等價物 |
| Agent lifecycle | Agent 是否 working、blocked、idle、done 或 unknown | 只有 conversation 與 task 的部分狀態 |
| Assignment | Agent 被授權做什麼，以及不可做什麼 | Issue description 與 automation prompt 只能部分表達 |
| Lane event stream | 一次角色執行的 append-only 過程 | 沒有獨立 lane model |
| Handoff | Agent 交付了什麼，以及有哪些證據與未完成項目 | Comment 可以承載摘要，但沒有固定 handoff contract |
| Intent/result receipt | Side effect 是否真的送出並完成 | 沒有通用的 control-plane receipt model |
| Queue與lease | 誰擁有下一個可執行工作 | Issue claim 與 version binding 只能覆蓋部分問題 |
| Watchdog result | Runtime 是否可觀測、停滯或消失 | 沒有等價的 runtime observer |
| PM phase與next intent | PM 是否可合法繼續派送 | 沒有 resident PM state model |
| Decision request | 哪個權限或架構決策正在阻塞 lane | 可以用 blocked comment 表達，但不是機器可驅動控制物件 |
| PM-board | 控制面的衍生巡檢介面 | 現有 Dashboard 是工作面板，不是 orchestration patrol board |

Herdr 的 pane topology 讓人可以在畫面上同時看到多個 Agent 的公開輸出。
Blackboard 又讓這些 pane 即使消失、重啟或 context compaction，也不至於成為唯一的狀態來源。
這兩者結合後，Herdr 才形成比一般 Taskboard 更完整的 execution visibility。

## Herdr 也不是看到模型的全部內部思考

「Herdr 可以完全看到每個 Agent 的執行過程」需要加上一個重要限制。
Herdr 能看到的是 Agent 在 terminal 公開輸出的內容、pane lifecycle、Agent status，以及寫入 durable artifacts 的計畫、handoff、verdict 與 evidence。
Herdr 不能看到模型沒有公開的隱藏 chain of thought。
Herdr 的 pane scrollback 也不是無限且永久的記錄。
當 Agent 使用 terminal alternate screen 時，離開 alternate screen 的內容不一定能從 host scrollback 恢復。

因此，Herdr 契約明確把 terminal scrollback 降級為觀察證據，而不是最終 source of truth。
真正可恢復的事實來源是 assignment、state、journal、lane、handoff、decision、request、queue 與 receipt。
Herdr 真正做到的是高度顯式的 execution observability，而不是存取模型未公開的內部推理。

## 為什麼 Task 狀態不能取代 orchestration control state

Taskboard 可以加入更多狀態，來表達高階工程流程。

```text
todo
  -> planning
  -> plan_review
  -> executing
  -> verifying
  -> code_review
  -> repairing
  -> integration_trial
  -> post_merge_verification
  -> in_review
```

這種狀態機能改善使用者對工作階段的理解。
它仍然不能取代底層 Agent runtime state。

例如，以下事件不適合直接變成 Issue status。

- Agent heartbeat 是否超時。
- Pane 是否消失。
- Dispatch intent 是否已送出。
- Receiver 是否已回覆 receipt。
- 同一個 Task 的第幾次 attempt 正在執行。
- Lease 是否過期，以及新 owner 是否持有 fencing token。
- Reviewer 是否在等待 worktree 或 predecessor handoff。
- Watchdog 本輪是否因 socket、permission 或 protocol mismatch 而沒有真正完成巡檢。
- PM 是否因 authority request 而合法 parked。
- Integration trial 是否因 base branch 改變而失效。

若把上述事件全部壓縮成 `in_progress` 或 `blocked`，Taskboard 會失去診斷所需的細節。
若把每一個事件都變成新的 Issue status，Taskboard 又會變得極度吵雜，並且把使用者工作流程和基礎設施狀態混在一起。

因此，較健全的模型應該把 Task status 視為業務投影，而不是控制面的唯一狀態。

## Watchdog 的正確定位

Herdr watchdog 不是另一個會自行決策的 Agent。
它是一個普通 shell process，持續觀察 lifecycle 與 durable state，並在規則判定為 actionable 時通知 PM 或 orchestrator。
它沒有派送、修改 blackboard、解讀 leaf 工作、批准決策或自動完成任務的權限。
它的價值來自零權限觀察、bounded check、deduplication 與可見告警。

如果把這個概念整合進 Taskboard，watchdog 不需要變成一個前端頁面或 AI chat。
它可以在 backend 或 runtime adapter 中持續執行，並把結構化觀察結果寫入 control-plane event store。
Taskboard UI 只需要顯示 watchdog 的健康狀態、最後檢查時間、判定原因、actionable flag 與 evidence reference。

## PM-board 的正確定位

Herdr pm-board 是 orchestration patrol dashboard，而不是另一套 Issue backlog。
它把 lane、queue、request、PM phase、staleness、watchdog result 與 next intent 彙整成可快速巡檢的畫面。
它本身是 derived view，不能取代 `pm/state.json`、`requests/*.md`、journal、lane 或 receipt 等來源資料。

目前 Taskboard Dashboard 主要回答「有哪些工作、有哪些進度、有哪些進行中的對話」。
Herdr pm-board 主要回答「控制面是否健康、誰正在執行、哪個 lane 被什麼阻塞、下一個合法動作是什麼」。
兩者名稱都包含 board，但服務的是不同層級。

如果要在 Taskboard 中提供 Herdr 等級的管理能力，應新增獨立的 Operations Board，而不是把現有 Issue Board 直接改造成 pm-board。

## Watchdog 與 PM-board 不必只能存在 terminal

Herdr 的現有實作利用 terminal pane 顯示 watchdog 與 pm-board，因為 Herdr 本身就是 terminal multiplexer。
這不代表 watchdog 與 pm-board 的概念只能在 terminal 中實作。
它們真正依賴的是可讀取的 Agent topology、durable blackboard、lifecycle result、queue、receipt 與 decision state。

只要 Taskboard backend 能取得這些資料，就可以在 Web UI 建立等價甚至更易讀的操作介面。
Terminal 可以保留為深入診斷用的 optional drawer，而不必成為主要使用介面。

可能的 Taskboard Operations UI 可以包含以下畫面。

- Agent Topology 顯示 workspace、tab、pane、thread、host 與 worktree 關係。
- Lane Board 顯示 planner、executor、reviewer、repairer、integration 與 verifier 的執行階段。
- Run Detail 顯示 attempt、prompt、public activity、intent、result、receipt、heartbeat 與 evidence。
- Decision Inbox 顯示 authority、architecture、destructive action 與 human acceptance request。
- Runtime Health 顯示 watchdog、socket、host、quota、queue age、retry 與 dead-letter 狀態。
- Evidence Panel 顯示 handoff、test result、review verdict、commit、branch、worktree 與 closure gate。
- Terminal Drawer 在必要時顯示唯讀 pane output 或提供前往 Herdr pane 的入口。

## Browser pane、CDP injection 與 Codex bridge 為什麼不能直接補上這個缺口

Browser pane 的作用是讓 Codex App 承載 Taskboard Web UI。
CDP injection 的作用是把 Taskboard 更深地嵌入 Codex renderer，並讓 injected code 操作 DOM、route、composer 與非公開 Desktop bridge。
`window.electronBridge` 與 `mcp-request` bridge 可以幫助 Taskboard 呼叫 Codex Desktop 內部能力或轉送 App Server method。
這些技術都不會自動提供 Herdr 的 PTY、pane topology、Agent registry、heartbeat、lease、receipt、watchdog 或 blackboard。

CDP 能看到的是 Codex renderer 層的 UI 與 bridge，而不是所有底層 shell process 的真實控制狀態。
即使 CDP 能打開 conversation、觀察 DOM 或送出 prompt，也不能單靠 renderer state 證明 Agent 已收到工作、仍然存活、完成正確 worktree 的修改，或通過獨立 review 與 integration gate。

此外，CDP injection、Desktop renderer message 與 `window.electronBridge` 是相容性風險較高的非公開整合面。
它們適合用作 UI integration adapter，但不適合作為完整 loop 的唯一 durable control plane。
相關介面分類與風險已記錄在 `investigate.md` 與 `risk-assessment.md`。

## Codex App Server 能提供什麼，以及不能提供什麼

Taskboard 已經會直接啟動 `codex app-server --stdio`。
`server/codex-app-server.mjs:18-225` 會管理 App Server process、request ID、timeout、response 與 notification。
它會使用 `skills/list`、`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt` 與 `thread/compact/start` 等 method。

App Server 是目前最適合用來做 Codex execution actuator 的介面。
它可以建立 thread、送出 turn、接收 structured event、等待結果、interrupt 與恢復 conversation。
它不會自動成為 orchestration control plane。

如果沒有另外建立持久化 controller，App Server 不會自行提供以下保證。

- 它不會替 Taskboard 決定角色拓撲。
- 它不會替 Taskboard 管理跨 Agent lane ownership。
- 它不會替 Taskboard建立 intent/result receipt protocol。
- 它不會替 Taskboard建立 crash recovery、lease、fencing、retry、dead-letter 與 fairness。
- 它不會替 Taskboard完成 independent review、trial integration 與 closure gate。

因此，App Server 適合當執行引擎，而不是單獨承擔 PM、watchdog、board 與 workflow state machine。

## 與完整 loop engineering 的比較

Taskboard 現有 automation 已經能做到 bounded per-issue loop。
Herdr resident-PM workflow 則希望做到 recoverable multi-role engineering loop。

| Loop 能力 | Taskboard 現況 | Herdr workflow |
| --- | --- | --- |
| 週期觸發 | 有 | 可由 PM、watchdog 與 queue 驅動 |
| 自動挑選工作 | 有，每輪一個符合條件的 Issue | 有，可依 queue、partition 與 role dispatch |
| Issue claim | 有 version 與 binding 檢查 | 有 assignment、queue、lease 與 receipt |
| Codex execution | 有 local App Server 與 remote thread | 有多 runtime leaf 與 pane control |
| 對話活動 | 有 local structured event 與 thread link | 有 pane output、lane 與 handoff |
| 獨立 planning | 沒有完整機械角色分離 | 有 planner 與 proposal review |
| 獨立 code review | 沒有完整機械角色分離 | 有 reviewer 與 repair loop |
| Worktree lane isolation | Issue 可記錄 development context | 有明確 worktree、assignment 與 single-writer rule |
| Dispatch receipt | 沒有通用 control-plane contract | 有 intent、result、ack 與 receive verification |
| Liveness | conversation running 與 automation state | 有 Agent lifecycle、watchdog 與 resident phase |
| Crash recovery | 可恢復 Issue 與對話資料 | 以 blackboard、journal、lane、handoff 與 queue 重建 |
| Integration trial | 沒有完整 loop controller | 有 integration lane 與 verification gate |
| Lifecycle closure | 以 Issue status 與人類確認為主 | 有 obligation ledger 與 closure gate |
| Pane-level visualization | 沒有 | 有 |

因此，用 Taskboard 現有方式可以做到自動化工程循環的主要 happy path。
若要求 Herdr 等級的可恢復性、可稽核性、角色隔離與控制面可視性，現有 automation prompt 與 Issue status 還不足以單獨達成目標。

## 建議的長期分層

最清楚且可維護的架構，是保留 Taskboard 作為工作資料面，再增加獨立的 orchestration control plane。

```text
使用者
  -> Taskboard Web UI
       -> Work Board
       -> Operations Board
       -> Agent Run Detail
       -> Decision Inbox

Taskboard service
  -> Work store
       -> Project / Issue / Comment / Relation / Attachment
  -> Control-plane store
       -> Run / Attempt / Lane / Lease / Intent / Receipt
       -> Heartbeat / Queue / Decision Request / Evidence
  -> Runtime adapters
       -> Codex App Server adapter
       -> Herdr adapter
       -> Git and worktree adapter
       -> Optional remote-host adapter

Execution runtimes
  -> Codex App Server thread and turn
  -> Herdr workspace, tab, pane and Agent
  -> Shell process, test process and integration process
```

在這個模型中，Taskboard Issue 仍然是使用者理解工作的主要物件。
每次 Agent 執行則建立獨立 Run 或 Attempt。
一個 Issue 可以有多個 Run，而一個 Run 可以包含多個 role lane。
Issue status 只投影目前整體工作狀態，不需要承載每一個 heartbeat 或 receipt。

## 建議的控制面資料物件

若未來要實作 Herdr 等級的可視性，至少需要以下獨立物件。

| 物件 | 目的 |
| --- | --- |
| `Run` | 一次端到端 workflow instance |
| `Attempt` | Run 中某個可重試的執行嘗試 |
| `Lane` | planner、executor、reviewer、repairer 或 integration 的角色工作流 |
| `AgentInstance` | 實際 Agent、thread、pane、host 與 process identity |
| `ExecutionTarget` | project、workspace、branch、worktree、host 與 runtime |
| `Lease` | 宣告目前誰擁有可執行權，並提供 fencing token |
| `Intent` | Side effect 執行前的 durable write-ahead record |
| `Receipt` | Transport、receive 與 result 的分階段確認 |
| `Heartbeat` | Agent、PM、watchdog 與 adapter 的 liveness evidence |
| `QueueItem` | 待執行、等待條件、優先序與公平排程 |
| `DecisionRequest` | 需要 orchestrator 或人類授權的阻塞項目 |
| `Evidence` | Test、review、commit、handoff、screenshot 與 artifact reference |
| `LifecycleObligation` | Review、integration、rollout、rollback、cleanup 與 closure requirements |

這些物件可以由 Taskboard 自己實作，也可以部分投影 Herdr blackboard 與 runtime state。
關鍵要求是它們必須有 durable identity、single-writer 或 concurrency contract，以及明確的 source of truth。

## 三種可行整合形態

### 形態一：維持目前 Taskboard 與 Codex App Server

這個形態保留目前的 Issue Board、local AI chat、thread binding 與 automation。
它可以繼續改善 structured activity timeline 與 per-issue automation。
它最適合單一使用者、單一專案或 bounded happy-path automation。
它不會自然取得 Herdr pane topology 與 resident-PM control plane。

### 形態二：Taskboard 加上 Herdr adapter

這個形態讓 Taskboard backend 讀取 Herdr Agent topology、blackboard、watchdog result、pm-board source、lane、handoff、queue 與 receipt。
Taskboard Operations UI 再把這些資料投影成 Web dashboard。
需要深入診斷時，使用者可以從 Agent Run Detail 跳到對應 Herdr pane 或查看唯讀 output。

如果目標是保留 Herdr 的 runtime 與成熟 control contract，同時取得 Taskboard 的產品化 UI，這是最接近目的地的形態。
這個形態也能避免用 CDP private bridge 重新發明 terminal multiplexer。

### 形態三：Taskboard 自己實作 Herdr 類型的 orchestration runtime

這個形態不依賴 Herdr，而是在 Taskboard service 中自行實作 Agent registry、PTY 或 headless process、lane、lease、watchdog、receipt、recovery 與 Operations UI。
它可以提供最一致的單一產品體驗。
它的實質範圍不是新增幾個 status，而是重新實作一個 Agent orchestration runtime 與 control plane。

如果希望 Taskboard 最終獨立於 Herdr，這是直接目的地。
如果只是希望快速取得 Herdr 等級的可視性，這個形態會重複大量已經由 Herdr 契約處理的問題。

## 推薦判斷

若主要目標是讓使用者在 Taskboard 看到 Herdr resident-PM workflow 的完整執行狀態，推薦「Taskboard 加上 Herdr adapter」。
Taskboard 應保留為工作與產品管理介面，Herdr 應保留為 terminal execution substrate 與 orchestration evidence source。
兩者之間應透過公開、版本化、唯讀優先的 adapter contract 連接。

若主要目標是建立不依賴 Herdr 的完整本地 Agent 作業系統，才應選擇由 Taskboard 自己實作 control plane。
這時應直接承認目標是新的 runtime，而不是把它描述成 Taskboard UI 增強。

無論選擇哪個方向，`codex app-server` 都適合繼續作為 Codex execution actuator。
CDP injection 與 Desktop bridge 應留在 UI 整合或相容性 adapter 層，不應成為 durable orchestration state 的唯一來源。

## 目的地形態判定

**Target:** 在 Taskboard 中提供 Herdr 等級的可觀測、可恢復、可稽核 Agent engineering loop，並讓使用者從同一個產品介面看到工作狀態與執行控制狀態。

**This document is:** 架構比較與目的地定義，不是實作交付。

**After completion, will we actually have the target architecture/runtime?:** 否。

**If no, what will still be missing?:** 仍缺少 control-plane schema、persistent loop controller、Herdr 或 runtime adapter、Agent run event ingestion、lease 與 receipt contract、watchdog integration、Operations UI、recovery protocol、review與integration lane，以及 closure gate。

## 已觀察、推論與尚未實作的區分

### 已觀察

- Taskboard 有 Issue workflow、comment、relation、development context 與 conversation binding。
- Taskboard 有 local AI chat、structured activity timeline 與 conversation history。
- Taskboard 可以打開原生 Codex thread。
- Taskboard 會直接啟動 Codex App Server。
- Taskboard 有每隔數分鐘執行的 per-project automation。
- 現有 automation 能認領一個符合條件的 Issue，執行或派送工作，等待結果，寫入 comment 並移動狀態。
- 現有 repository 沒有 Herdr workspace、tab、pane、blackboard、watchdog 或 pm-board integration。

### 合理推論

- Taskboard 可以成為 Herdr control plane 的 Web presentation layer。
- Codex App Server 適合作為 Taskboard loop controller 的主要 Codex actuator。
- Herdr adapter 比單靠 CDP injection 更能提供 pane 與 orchestration visibility。
- 工作資料面與執行控制面分離，會比把所有事件塞進 Issue status 更容易恢復與維護。

### 尚未實作

- 沒有證據顯示 Taskboard 已能枚舉或控制 Herdr pane。
- 沒有證據顯示 Taskboard 已讀取 Herdr blackboard、watchdog result 或 pm-board source。
- 沒有通用 Agent Run、Attempt、Lane、Lease、Intent 或 Receipt 資料模型。
- 沒有 Web 版 Operations Board。
- 沒有 Herdr 等級的 resident-PM recovery、review loop、integration queue 與 lifecycle closure gate。

## 最終結論

使用者目前對兩者的直覺是正確的。
Taskboard 可以透過 Task、狀態、comment 與 conversation 持續呈現工作進度，也能執行一定程度的自動化 loop。
Taskboard 目前沒有 Herdr 那種 pane-first、lane-first 與 control-plane-first 的完整可視性。
Herdr 的 watchdog、PM state、pm-board、receipt、queue 與 recovery model 若要出現在 Taskboard，必須新增 adapter、資料模型與 Operations UI。
這些能力不必永遠只能在底層 terminal 運作，因為真正需要被呈現的是 durable state 與 runtime evidence，而不是 terminal 本身。
Terminal pane 適合保留為執行 substrate 與深入診斷入口，Taskboard 則可以成為更高階、更產品化的統一管理介面。

最合理的責任分工是以下形式。

```text
Taskboard 管理「要做什麼，以及整體做到哪裡」。
Control plane 管理「誰正在做、是否真的收到、是否仍然活著，以及下一個合法動作」。
Codex App Server 或 Herdr 管理「實際在哪個 runtime 執行」。
Evidence artifacts 管理「為什麼可以相信它真的完成」。
```

## 相關資料

- `investigate.md` 記錄 Codex App Server、browser pane、CDP injection、Desktop bridge 與 deep link 的調查。
- `risk-assessment.md` 記錄目前 repository 的安全風險與非公開整合面風險。
- `server/codex-app-server.mjs` 是 Taskboard 直接操作 Codex App Server 的 wrapper。
- `shared/taskboard-automation.mjs` 定義 Taskboard 週期性自動認領與處理 Issue 的 prompt 與 automation spec。
- `web/src/components/AiChat.tsx` 定義 Taskboard local AI chat、message timeline 與 structured activity UI。
- `web/src/components/DashboardView.tsx` 定義 Active conversations 與工作摘要。
- `web/src/App.tsx` 定義 Taskboard conversation 與原生 Codex thread 的開啟路徑。
- `scripts/codex-injector.mjs` 定義 browser-pane fallback、CDP injection 與 Desktop bridge 介接。
- `$HOME/.agents/skills/herdr/SKILL.md` 描述 Herdr pane、Agent control 與 resident-PM workflow。
- `$HOME/.agents/skills/herdr/references/pm-blackboard-contract.md` 描述 durable blackboard、file-first handoff、watchdog、receipt 與 recovery contract。
- `$HOME/.agents/skills/herdr/references/pane-layout.md` 描述 Herdr tab、pane 與 Agent 的顯式布局模型。
