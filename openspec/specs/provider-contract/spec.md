# provider-contract Specification

## Purpose

TBD - created by archiving change 'provider-contract-abstraction'. Update Purpose after archive.

## Requirements

### Requirement: Provider capabilities SHALL be explicitly declared, not inferred from source string comparison

The system SHALL expose task and project mutation permissions through an explicit `ProviderCapabilities` object (fields: `createIssue`, `updateAssignee`, `comments`, `attachments`, `relations`, `webhook`, `incrementalSync`, `manualArchive`, `manualDelete`, `manualMove`, `assigneeEdit`, `projectReassign`), obtained via a provider registry lookup keyed by the task or project's `source` value. No caller (server route handler, database mapper, or frontend component) SHALL compare `source` against the literal string `"jira"` to decide whether an operation is permitted.

#### Scenario: Jira task rejects manual assignee edit via capability check

- **WHEN** a client issues `PATCH /api/tasks/:id` with an `assigneeTarget` change for a task whose `source` is `"jira"`
- **THEN** the system SHALL reject the request with `JIRA_ASSIGNEE_UNAVAILABLE` because the resolved `ProviderCapabilities.assigneeEdit` for that task is `false`, and this rejection SHALL NOT be implemented via a literal `current.source === "jira"` comparison in the route handler

#### Scenario: Local task permits manual delete via capability check

- **WHEN** a client issues `DELETE /api/tasks/:id` for a task whose `source` is `"local"` (or any unregistered/null source)
- **THEN** the system SHALL permit the delete because the resolved `ProviderCapabilities.manualDelete` for that task is `true`

#### Scenario: New provider requires zero UI conditional changes

- **WHEN** a new provider is registered in the provider registry with a `ProviderCapabilities` object that differs from the Jira provider's (for example, `manualDelete: true` while Jira's is `false`)
- **THEN** frontend components (task property controls in TaskCard, IssueListView, TaskDetail) SHALL render the correct enabled/disabled state for tasks from that new provider using their existing capability-reading logic, without any component's conditional code being modified


<!-- @trace
source: provider-contract-abstraction
updated: 2026-09-11
code:
  - .deviation/issues.jsonl
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/design.md
  - openspec/changes/loopback-security-baseline/.openspec.yaml
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/loopback-security-baseline/proposal.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/.openspec.yaml
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/tasks.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/proposal.md
  - openspec/changes/loopback-security-baseline/design.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/design.md
  - openspec/changes/retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/specs/shared-board-migration/spec.md
  - .deviation/ISSUES.md
  - openspec/specs/network-access-control/spec.md
  - .beads/interactions.jsonl
  - openspec/changes/retire-shared-board/tasks.md
  - handoff.md
  - openspec/changes/retire-shared-board/design.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/.openspec.yaml
  - openspec/changes/loopback-security-baseline/tasks.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/proposal.md
  - openspec/changes/loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/tasks.md
  - openspec/changes/retire-shared-board/proposal.md
  - openspec/changes/retire-shared-board/.openspec.yaml
  - openspec/changes/archive/2026-09-11-retire-shared-board/specs/shared-board-migration/spec.md
-->

---
### Requirement: Jira provider SHALL implement the IssueProvider interface while preserving existing behavior

The system SHALL restructure `server/jira-integration.mjs` so that `createJiraIntegration` returns an object implementing the `IssueProvider` interface (`configure`, `status`, `listIssues`, `getIssue`, `createIssue`, `updateIssue`, `listStatuses`, `listLabels`, `listComments`, `reconcileIssue`, `reconcileSince`) plus a `capabilities` property. This restructuring SHALL NOT change the existing 60-second refresh interval, manual sync trigger behavior, JQL scope construction (`buildJiraJql`), or write behavior (`updateTask`/`moveTask`/`reconcile` semantics) observable before this change.

#### Scenario: Existing Jira sync test suite passes unmodified in observable behavior

- **WHEN** the full `npm test` suite runs after the `IssueProvider` restructuring
- **THEN** all existing test assertions covering Jira sync behavior (refresh timing, JQL scope, write reconciliation) SHALL pass, and any assertion that must be rewritten SHALL verify an externally observable behavior equivalent to what it verified before the rewrite

#### Scenario: Zero remaining literal source string comparisons

- **WHEN** a repository-wide search for `source === "jira"` and `source !== "jira"` is run across `server/database.mjs`, `server/app.mjs`, `web/src/App.tsx`, `web/src/components/TaskCard.tsx`, `web/src/components/IssueListView.tsx`, and `web/src/components/TaskDetail.tsx` after this change is complete
- **THEN** the search SHALL return zero matches, except for the single line in `server/database.mjs` that defines the `source` field's value from the raw `external_source` database column (this is the definition of `source`, not a consumer decision based on it)

<!-- @trace
source: provider-contract-abstraction
updated: 2026-09-11
code:
  - .deviation/issues.jsonl
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/design.md
  - openspec/changes/loopback-security-baseline/.openspec.yaml
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/loopback-security-baseline/proposal.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/.openspec.yaml
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/tasks.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/proposal.md
  - openspec/changes/loopback-security-baseline/design.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/design.md
  - openspec/changes/retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/specs/shared-board-migration/spec.md
  - .deviation/ISSUES.md
  - openspec/specs/network-access-control/spec.md
  - .beads/interactions.jsonl
  - openspec/changes/retire-shared-board/tasks.md
  - handoff.md
  - openspec/changes/retire-shared-board/design.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/.openspec.yaml
  - openspec/changes/loopback-security-baseline/tasks.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/proposal.md
  - openspec/changes/loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/tasks.md
  - openspec/changes/retire-shared-board/proposal.md
  - openspec/changes/retire-shared-board/.openspec.yaml
  - openspec/changes/archive/2026-09-11-retire-shared-board/specs/shared-board-migration/spec.md
-->