# Security Risk Assessment

## Document status

This document records security risks identified during a read-only repository review on 2026-08-26.
The reviewed revision was `5c96d1ab698362994283ba0af86021db0a98dd89` on `main`.
The findings are risk records rather than claims that every deployment is currently exploitable.
Each risk states the execution mode and attacker prerequisites that make it relevant.
An architecture addendum was added on 2026-08-27 for the proposed Jira and Linear provider model, Linear webhook ingress, Cloudflare Tunnel boundary, and MCP role.
Those proposed controls are not implemented mitigations and must remain marked as open until code and deployment evidence prove otherwise.
The complete target architecture and migration sequence are documented in [`architect.md`](./architect.md).

## System context

Codex Taskboard is a local-first issue board with a React UI, a Node HTTP service, a `taskctl` CLI, and a bundled Codex Skill.
The Tauri launcher can start the service and embed the board into Codex Desktop through a browser panel or CDP injection.
Jira is an optional integration that imports Jira issues into the Taskboard interface and can write supported task changes back to Jira.
Cloudflare deployment is an optional collaboration mode and is not required for the local product.

The proposed destination keeps Dashi local-first and uses Jira or Linear as the canonical system for shared Issue fields.
The main Taskboard service remains loopback-only, while a separate webhook-only listener receives Linear notifications through a narrowly routed Cloudflare Tunnel.
Linear GraphQL API calls perform authoritative reads, writes, and reconciliation, while Linear MCP remains an optional Agent-facing client rather than a synchronization backend.
The existing Cloudflare shared-board mode remains an observed current surface until it is explicitly retired or migrated.

The main security boundaries are therefore:

- The packaged Tauri launcher, which uses loopback binding and an instance token.
- The standalone Node server, which can expose the board to a private LAN.
- The direct Codex injector, which launches or attaches to Codex outside the packaged launcher path.
- The optional Cloudflare collaboration service and local companion.
- The Jira connection, which gives the local service authority to read and modify an external Jira system.
- The release pipeline that publishes desktop installers.

## Risk summary

| ID | Severity | Status | Evidence | Risk | Primary scope |
| --- | --- | --- | --- | --- | --- |
| RISK-001 | High | Open | Focused tests and code review | Standalone server exposes unauthenticated board and integration operations to the LAN | Standalone server and LAN mode |
| RISK-002 | High | Open | Code review | Direct injector stores imported Codex browser databases under a predictable shared temporary path | Direct injector without a launcher-provided profile |
| RISK-003 | High | Open | `npm audit` and code review | Reachable `js-yaml` advisories allow quadratic CPU denial of service | Every UI mode that renders Taskboard Markdown or Mermaid |
| RISK-004 | Medium | Open | Code review and documentation comparison | Cloud conversation data can persist and disclose device-local paths and host identifiers | Cloud collaboration mode |
| RISK-005 | Medium | Open | Code review | Unrestricted external images enable passive tracking and client-side network requests | Task, comment, and avatar rendering |
| RISK-006 | Medium | Open | Code review | Jira Basic credentials may be transmitted over unencrypted HTTP | Jira connections configured with HTTP |
| RISK-007 | Medium | Open | Release-workflow review | The release workflow publishes an unsigned Windows installer | Windows release assets |
| RISK-008 | Medium-Low | Accepted design risk | Documentation and code review | A single shared cloud password grants complete board access and permits actor-name impersonation | Cloud collaboration mode |
| RISK-009 | Low | Open | Code review | The WorkBuddy iframe lacks the sandbox and capability boundary used by the Codex embed | WorkBuddy injection |
| RISK-010 | Low | Monitor | `cargo audit` and reachability review | Rust dependencies include an unsound `glib` version and several unmaintained GTK3 crates | Primarily the Linux desktop dependency graph |
| RISK-011 | High | Proposed boundary, open | Architecture review | A Tunnel routing error can expose the complete local Taskboard instead of only the Linear webhook receiver | Cloudflare Tunnel and local server topology |
| RISK-012 | High | Design required, open | Architecture review and provider requirements | Forged, replayed, duplicated, or out-of-order Linear webhook deliveries can trigger unauthorized or stale synchronization | Linear webhook ingress and reconciliation |
| RISK-013 | Medium | Design required, open | Failure-mode analysis | Desktop sleep, application downtime, or Tunnel outage can create notification gaps after finite provider retries | Linear synchronization availability |
| RISK-014 | Medium | Design required, open | Data-flow analysis | Independent local API, provider UI, MCP, and webhook paths can create divergence or ambiguous audit history | Provider write and reconciliation paths |
| RISK-015 | Medium | Design required, open | Data-classification analysis | Provider synchronization can disclose workspace paths, Codex identities, thread identifiers, or runtime metadata | Jira and Linear outbound payloads |
| RISK-016 | Medium | Design required, open | Credential-boundary analysis | Jira, Linear, OAuth, webhook, and Tunnel credentials can be over-broadly stored, logged, or reused | Provider and ingress secrets |

## Detailed risks

### RISK-001: Unauthenticated LAN access to board and integration operations

**Severity:** High.

**Affected mode:** The standalone or script-started Node service when `CODEX_TASKBOARD_HOST` is not explicitly restricted to `127.0.0.1`.
The normal packaged Tauri launcher is not affected because it supplies a loopback host and instance authentication values.

`server/app.mjs:1640` defaults the listener host to `0.0.0.0`.
`server/app.mjs:202-227` accepts requests with a local or private `Host` and returns early when the request has no `Origin` header.
Ordinary project, task, comment, attachment, event, and client-storage routes do not require account authentication.
`server/app.mjs:559-600` also accepts caller-supplied `X-Taskboard-User-*` headers, which allows a reachable client to persist a false actor identity.

When Jira is enabled, this authority crosses the local data boundary.
A LAN client can read a Jira-backed task, submit a versioned task update through `server/app.mjs:3059-3124`, and cause `server/jira-integration.mjs:398-447` to update the external Jira issue with the locally stored Jira credentials.

The observable impact includes unauthorized board reads and writes, attachment access, local workspace metadata disclosure, actor impersonation, event subscription, and Jira mutation when Jira is configured.

The preferred remediation is to default every local launch path to `127.0.0.1`.
LAN access should require an explicit mode with authentication applied consistently to HTTP, SSE, and WebSocket endpoints.
Machine-specific metadata and capabilities should remain loopback-only even in an authenticated LAN mode.
Untrusted callers should not be allowed to choose persistent actor headers.

### RISK-002: Predictable shared temporary directory for imported Codex browser data

**Severity:** High with a local-attacker prerequisite.

**Affected mode:** The direct injector when `CODEX_TASKBOARD_CODEX_PROFILE` is not supplied by the packaged launcher.
The normal packaged launcher path is not directly affected when it supplies its private application profile directory.

`scripts/codex-injector.mjs:37-41` selects a fixed path named `codex-taskboard-independent-profile-v2` under a shared temporary directory.
`scripts/codex-injector.mjs:256-299` imports the Codex browser `Cookies`, `Login Data`, and `Login Data For Account` databases into that path.
The code does not verify directory ownership, permissions, or symlink status before creating subdirectories and destination databases.

A local attacker can pre-create the predictable directory or plant links before the injector runs.
This can expose copied browser databases, redirect writes, or persistently contaminate the managed Codex profile.

The preferred remediation is a randomly generated per-user profile under the application's private data directory.
The directory should be created with mode `0700`, checked with `lstat`, and rejected when ownership, permissions, or file types are unexpected.

### RISK-003: Reachable `js-yaml` denial of service

**Severity:** High.

**Affected mode:** Every desktop, browser, embedded, or cloud UI that renders attacker-controlled Taskboard Markdown or Mermaid content with the affected frontend bundle.

`package.json:48` pins the production dependency `js-yaml` to `4.1.1`.
An `npm audit --omit=dev` scan reported three advisories involving quadratic CPU consumption: `GHSA-h67p-54hq-rp68`, `GHSA-52cp-r559-cp3m`, and `GHSA-5p4m-2wfm-xmqj`.

The dependency is reachable from user-controlled content.
`web/src/components/MarkdownDocument.tsx:125-160` parses Mermaid object metadata and frontmatter with `loadYaml`.
A crafted task description, comment, or project README can therefore consume excessive CPU when a user opens the affected content and can freeze the Taskboard renderer.

The available non-major remediation is to upgrade `js-yaml` to `4.3.1` or newer and regenerate the lockfile.

### RISK-004: Cloud persistence of device-local path and host metadata

**Severity:** Medium.

`server/cloud-proxy.mjs:99-107` can add a complete resolved `threadBinding` to a conversation mutation before forwarding it to the cloud.
`cloud/src/index.mjs:299-345` accepts `workspacePath`, `codexHostId`, `codexProjectId`, and related identity fields.
The cloud database persists these fields and returns them through task, comment, and conversation-reference responses.

Any collaborator with the shared cloud password can consequently receive another device's absolute checkout path and host or project identifiers.
This behavior conflicts with the promise in `docs/cloud-collaboration.md:25` that device absolute paths are not stored in the cloud.

The cloud payload should retain only the minimum portable thread identity.
Device paths and host identifiers should be mapped locally through opaque identifiers and removed from cloud writes and responses.

### RISK-005: External-image tracking and client-side network requests

**Severity:** Medium.

`web/src/api.ts:800-813` preserves most arbitrary image URLs.
Task Markdown, card previews, persisted media, and actor avatars can render those values as automatically loaded image sources.

An attacker who can control task content, a comment, or an avatar URL can make a viewer's browser issue a request without a click.
This exposes the viewer's IP address, user-agent, and access time and can send GET requests to loopback or private-network services reachable from the viewer.

Automatically loaded media should be limited to Taskboard attachment URLs or a controlled HTTPS proxy or allowlist.
Loopback, link-local, and private-network destinations should be rejected, and untrusted external media can be offered through an explicit click-to-load action.

### RISK-006: Jira credentials over HTTP

**Severity:** Medium.

`server/jira-config.mjs:15-41` permits both HTTP and HTTPS Jira base URLs.
`server/jira-integration.mjs:154-170` sends the configured username and password in an HTTP Basic `Authorization` header.

When an HTTP Jira URL is used across a network, the credentials and Jira traffic lack transport encryption.
The application should require HTTPS except for an explicitly marked loopback-only development mode.

### RISK-007: Unsigned Windows release installer

**Severity:** Medium.

`package.json:21` builds the Windows NSIS installer with `--no-sign`.
`.github/workflows/release-macos.yml:121-129` identifies it as an unsigned preview, but the later release steps copy and upload the executable as a GitHub Release asset.

Windows users cannot verify an Authenticode publisher identity for that asset and receive weaker operating-system reputation signals.
The installer should be Authenticode-signed before publication, or the unsigned build should remain a CI-only preview artifact.

### RISK-008: Shared-password cloud authorization model

**Severity:** Medium-Low as an explicitly documented architectural risk.

Cloud collaboration uses one shared password for complete read and write access.
Anyone who knows the password can choose any displayed actor name, and an individual collaborator cannot be revoked without rotating the shared password for everyone.
The public `workers.dev` deployment surface also makes password strength and rate limiting important.

For broader or less-trusted collaboration, the preferred destination is per-user authentication through Cloudflare Access, OIDC, or individually revocable credentials.

### RISK-009: WorkBuddy iframe isolation gap

**Severity:** Low unless another frame-content script vulnerability is present.

`inject/workbuddy-taskboard.user.js:67-78` embeds Taskboard in an iframe without a `sandbox` attribute or the capability and challenge handshake used by the Codex injection path.
This does not independently create script execution, but it increases the impact of a future Taskboard frame compromise.

The WorkBuddy integration should use the same sandbox, external-navigation delegation, and authenticated message bridge used by the Codex embed.

### RISK-010: Rust dependency maintenance and unsoundness warnings

**Severity:** Low pending reachability analysis.

`cargo audit` scanned 475 dependencies and reported no entries classified as RustSec vulnerabilities.
It did report `RUSTSEC-2024-0429` for undefined behavior in specific `glib::VariantStrIter` iterator methods in `glib 0.18.5`.
It also reported multiple unmaintained GTK3 bindings and related transitive packages.

No direct use of the affected `VariantStrIter` methods was established during this review.
The Linux desktop dependency graph should nevertheless be updated toward maintained GTK bindings and a patched `glib` version when the upstream Tauri and WebView stack permits it.

## Proposed architecture risks

The following risks arise from the target design in [`architect.md`](./architect.md).
They do not assert that the repository currently contains a Linear webhook or Tunnel implementation.
They define the conditions that must be satisfied before those components can be considered safe to enable.

### RISK-011: Tunnel accidentally exposes the complete local Taskboard

**Severity:** High.

**Affected mode:** Any deployment that routes a public Cloudflare hostname to the current Taskboard server or uses a path rule that can fall through to ordinary Taskboard routes.

The standalone service currently defaults to `0.0.0.0`, ordinary APIs do not require account authentication, and requests without an `Origin` header can pass the origin check after Host validation.
The launcher instance token protects a dynamic private App instance, but it is not a suitable stable public webhook credential.
A Tunnel configuration that points at the main service would therefore transform RISK-001 from a private-LAN exposure into an Internet-reachable exposure.

The required mitigation is a separate process or strictly separate listener bound to `127.0.0.1` on its own port.
That listener should expose only `POST /webhooks/linear` and no health, Taskboard UI, project, task, attachment, SSE, WebSocket, Launcher, or client-storage route through the public listener.
The Tunnel ingress configuration should match one exact hostname and path, set the expected local Host header, and end with an explicit catch-all HTTP 404 rule.
Deployment verification must prove that the intended webhook path is reachable and that `/`, `/api/tasks`, `/events`, attachment routes, WebSocket upgrades, and alternate methods remain unreachable from the public hostname.
The main Taskboard service should independently default to loopback so a Tunnel mistake does not inherit a listening service on every interface.

### RISK-012: Forged, replayed, duplicate, or stale webhook delivery

**Severity:** High.

**Affected mode:** The proposed Linear webhook receiver.

A public webhook URL will receive attacker-controlled requests and normal provider retries.
Processing the JSON payload before authenticating it, comparing a recomputed signature with an ordinary string comparison, accepting old timestamps, or applying duplicate deliveries directly to SQLite can create unauthorized or stale mutations.
Delivery order must also not be treated as entity version order.

The receiver must retain the exact raw body and verify Linear's HMAC signature with a constant-time comparison before JSON parsing or any side effect.
It must validate the event timestamp against a bounded clock-skew window, enforce the configured organization and webhook identifiers, require the expected content type, and reject oversized bodies.
The `Linear-Delivery` identifier must have a durable unique constraint so retries are idempotent across restarts.
The receiver should persist a minimal inbox record before returning success, then acknowledge within Linear's response deadline and perform reconciliation asynchronously.
The webhook payload should be treated only as an authenticated change hint.
The worker must fetch the current entity from the Linear GraphQL API and apply a version-aware upsert rather than copying possibly stale payload fields directly into the local database.

### RISK-013: Notification gaps during desktop or Tunnel downtime

**Severity:** Medium.

**Affected mode:** A desktop-hosted Linear webhook receiver that is unavailable while the computer sleeps, the App is closed, the network changes, or the Tunnel process stops.

Linear retries failed webhook deliveries, but those retries are finite and cannot replace durable receiver availability.
A webhook-only synchronization strategy can therefore leave Dashi stale without an obvious error.

Webhook delivery must be paired with startup reconciliation, periodic incremental polling, and a manual full or bounded resynchronization control.
The provider checkpoint should use the provider's `updatedAt` ordering plus a stable cursor or tie-breaker and should advance only after a page is committed locally.
Each incremental query should overlap the previous checkpoint by a bounded window and rely on idempotent upserts to cover clock, ordering, and transaction edges.
The UI should show last successful API reconciliation, last accepted webhook, current Tunnel or listener health, and any pending or failed inbox item.
If the product later requires guaranteed always-on ingestion, the receiver should move to an always-on managed ingress such as a Worker and durable queue rather than pretending a sleeping desktop is continuously available.

### RISK-014: Divergence across API, provider UI, MCP, and local write paths

**Severity:** Medium.

**Affected mode:** Jira or Linear projects that can be modified from Dashi, the provider's own UI, an MCP-enabled Agent, or another integration.

If Dashi treats its SQLite copy as authoritative while MCP or provider-native edits also occur, the same Issue can acquire conflicting values and an unclear audit trail.
A webhook handler that performs its own mutation logic would create another implementation of field mapping and conflict resolution.

External provider-backed fields must have Jira or Linear as their canonical source of truth.
All external changes, including MCP writes, should converge through the same provider API read and reconciliation pipeline.
The webhook should enqueue reconciliation and must not bypass the provider adapter with direct task mutations.
Local edits should be recorded as pending outbound changes with provider request identity and outcome, then replaced by the provider-confirmed representation.
The provider adapter should use optimistic concurrency signals where available and record explicit conflict outcomes instead of silently using last local write wins.
Issue workflow state must remain separate from local Agent execution state so an interrupted process does not silently rewrite the shared team's Issue status.

### RISK-015: Leakage of device-local execution metadata into providers

**Severity:** Medium.

**Affected mode:** Any Jira or Linear synchronization path that serializes a complete local Task, Conversation Binding, comment, attachment, or development context object.

RISK-004 demonstrates that the current cloud collaboration path can persist `workspacePath`, `codexHostId`, and `codexProjectId` when a boundary accepts an overly broad object.
Repeating that pattern for Jira or Linear could expose absolute filesystem paths, thread identifiers, local host identity, worktree details, process state, CDP state, or Herdr control-plane records to external collaborators and provider logs.

The provider layer must use an explicit outbound allowlist rather than serializing database or API objects wholesale.
Shared Issue fields and local execution overlay fields should use separate data types and storage columns.
Outbound contract tests should fail when local-only fields such as `workspacePath`, `worktreePath`, `threadId`, `codexHostId`, `codexProjectId`, Launcher secrets, process IDs, or Herdr lease and receipt data appear in provider payloads.
Cross-device correlation should use an opaque mapping identifier stored locally rather than an absolute path or host name.
Comments, generated descriptions, and attachment metadata require the same classification because free-form synchronization can bypass an otherwise safe Issue schema.

### RISK-016: Provider, webhook, and Tunnel secret sprawl

**Severity:** Medium.

**Affected mode:** Jira Basic authentication, Linear OAuth or API credentials, Linear webhook verification, and Cloudflare Tunnel operation.

These credentials authorize different actions and have different rotation and exposure requirements.
Reusing one token, storing raw values in SQLite or project configuration, exposing them through process arguments, or logging request headers and webhook bodies increases the blast radius of a local compromise or support bundle.

Provider access tokens, OAuth refresh tokens, Jira passwords, webhook signing secrets, and Tunnel credentials must remain separate and use least-privilege scopes.
Desktop secrets should be stored through the operating system's secure credential facility, while SQLite keeps only a credential reference and non-secret connection metadata.
The webhook listener must not reuse the Launcher instance token, the cloud collaboration password, or a provider API token as its verification secret.
Logs and diagnostic exports must redact authorization headers, cookies, webhook signatures, Tunnel credentials, and raw provider bodies that may contain sensitive Issue data.
The operational design must include independent rotation, revocation, health reporting, and a safe reconnect path for each credential domain.

## Architecture risk treatment matrix

This matrix maps the proposed architecture to the existing and new risks.
Every control in the “Required target-state treatment” column remains proposed until an implementation and deployment check is recorded.

| Risk | Architecture decision | Required target-state treatment | Closure evidence |
| --- | --- | --- | --- |
| RISK-001 | Remove direct LAN board sharing from the primary design | Default every main-service launch path to `127.0.0.1` and require a separately designed authenticated mode for any future remote UI | Network tests for standalone, Launcher, injector, SSE, and WebSocket paths |
| RISK-004 | Use Jira or Linear for shared Issue data instead of copying the local board | Retire or migrate the shared cloud-board mode and enforce a shared-field allowlist | Storage migration review and payload tests proving local paths are absent |
| RISK-006 | Keep Jira as a provider | Require HTTPS for remote Jira and isolate any explicit loopback-only development exception | Configuration tests and a real HTTPS connection check |
| RISK-008 | Do not make the shared-password board the target collaboration model | Retire the mode or place it behind individually revocable identity before continued multi-user use | Deployment configuration and revocation test |
| RISK-011 | Use a dedicated webhook ingress | Separate port and route surface, exact Tunnel path, catch-all 404, public negative-path tests, and loopback main server | External reachability matrix and process-boundary review |
| RISK-012 | Treat webhooks as authenticated hints | Raw-body HMAC, timestamp validation, identifier allowlist, durable delivery deduplication, inbox persistence, and API refetch | Signature, replay, duplicate, restart, and out-of-order delivery tests |
| RISK-013 | Pair webhook with reconciliation | Startup sync, periodic incremental sync, overlap window, checkpoint transaction, manual repair, and visible health | Offline, sleep, Tunnel outage, and missed-delivery recovery tests |
| RISK-014 | Make provider data canonical and MCP a separate client | One provider adapter and reconciliation pipeline, pending outbound record, conflict outcome, and separate execution state | Multi-writer conflict and audit-history tests |
| RISK-015 | Separate shared Issue schema from local execution overlay | Explicit outbound allowlist and negative tests for every local-only field | Serialized-payload snapshots and provider-side inspection |
| RISK-016 | Separate credential domains | OS secure storage, least privilege, redaction, independent rotation, and no token reuse | Secret-storage review, redaction tests, and rotation runbook exercise |

RISK-002, RISK-003, RISK-005, RISK-007, RISK-009, and RISK-010 are not materially solved by the provider architecture and still require their own remediations.
The implementation phases and operation paths for the treatments above are specified in [`architect.md`](./architect.md).

## Existing protections observed

The following controls were observed in the reviewed revision.
Proposed controls from [`architect.md`](./architect.md) are intentionally excluded until they are implemented and verified.

- The packaged launcher binds its service to loopback and protects routes with an instance token and launcher proof.
- The Tauri capability file exposes only `core:default`.
- The updater verifies signed update artifacts before installation.
- Attachment filenames are validated, stored under generated identifiers, and served with restrictive content headers.
- Markdown and Mermaid SVG output is sanitized, and external Mermaid resources are rejected.
- Database queries reviewed during this assessment use parameter binding rather than externally controlled SQL concatenation.
- Process execution reviewed during this assessment uses argument arrays and did not expose a confirmed shell-command injection path.
- Repository scanning did not find a high-confidence committed private key or access token.

## Validation evidence and gaps

- `node --test test/server.test.mjs test/ai-chat-server.test.mjs` passed all 39 focused tests.
- The server test suite explicitly confirms that local AI routes reject private-LAN clients while ordinary APIs remain available to LAN clients.
- `npm audit --omit=dev` reported one vulnerable direct production dependency, `js-yaml`, with an available fix at `4.3.1`.
- `cargo audit` used a RustSec database updated on 2026-08-24 and reported zero classified vulnerabilities, one unsoundness warning, and multiple unmaintained-package warnings.
- Component tests could not be rerun because the current installation lacks the `vitest` executable.
- Cloud worker tests could not be rerun because the current installation lacks `miniflare`.
- The optional `codex-security` scanner was not installed, so the review used manual attack-surface analysis, dependency scanners, focused tests, and repository secret-pattern checks.
- The reviewed revision does not contain a Linear provider, Linear webhook receiver, durable delivery inbox, or Cloudflare Tunnel configuration for Linear.
- The Linear MCP field probe and provider documentation establish data-model feasibility but do not validate a synchronization implementation or security control.
- No proposed Tunnel route, public negative-path test, provider checkpoint, secret-storage choice, or conflict-resolution implementation was deployed or verified during this review.

## Recommended remediation order

1. Restrict every main Taskboard launch path to loopback by default and retire unauthenticated LAN sharing from the primary product path.
2. Before enabling a Tunnel, build a separate webhook-only listener and prove that the public hostname cannot reach the Taskboard UI, ordinary APIs, SSE, WebSocket, attachments, or Launcher routes.
3. Add raw-body HMAC verification, timestamp and source validation, durable delivery deduplication, an inbox transaction, asynchronous provider refetch, and missed-event reconciliation.
4. Introduce a provider contract and shared reconciliation path while preserving the existing Jira pull behavior before adding Linear writes.
5. Enforce a strict external-provider payload allowlist, separate local execution state, require HTTPS for remote Jira, and place every credential domain in secure storage with independent rotation.
6. Remove device paths and host identity from the existing cloud persistence path, then retire or explicitly redesign shared-password collaboration.
7. Replace the fixed injector profile directory with a private, random, ownership-checked directory.
8. Upgrade `js-yaml` to `4.3.1` or newer.
9. Restrict or proxy externally loaded images.
10. Sign Windows release installers before publication.
11. Add WorkBuddy iframe isolation equivalent to the Codex embed.
12. Plan Linux desktop dependency maintenance and verify the reachable `glib` surface.

## Reassessment triggers

This assessment should be updated when any of the following occurs:

- The default listener or LAN authentication model changes.
- The injector profile lifecycle changes.
- Jira write support or credential storage changes.
- Cloud thread identity or authorization changes.
- A Linear provider, webhook subscription, MCP write path, or synchronization cursor is added or changed.
- A Cloudflare Tunnel hostname, ingress path, Access policy, local service target, or catch-all rule is added or changed.
- A provider field changes ownership between the external shared model and the local execution overlay.
- Provider, OAuth, webhook, or Tunnel secret storage, logging, rotation, or revocation behavior changes.
- The existing Cloudflare shared-board mode is migrated, retired, or retained as a supported product path.
- A new desktop release pipeline or signing process is introduced.
- `js-yaml`, Tauri, WebView, GTK, or `glib` dependencies are upgraded.
- A concrete exploit, production incident, or new advisory changes the current likelihood or impact assumptions.
