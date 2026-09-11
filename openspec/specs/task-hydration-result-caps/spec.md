# task-hydration-result-caps Specification

## Purpose

TBD - created by archiving change 'task-hydration-row-caps'. Update Purpose after archive.

## Requirements

### Requirement: Per-task relation result caps in hydration paths

For a single task, the system SHALL cap each of the four relation collections (`subIssues`, `blockedBy`, `blocks`, `related`) independently to at most `TASK_RELATION_MAX_RESULTS` entries when hydrating that task through `GET /api/tasks/:id` or `GET /api/tasks`. The `parent` relation is exempt from this cap because the schema enforces at most one parent per task. When a collection exceeds the cap, the system SHALL retain the most recently created entries up to the cap, discard the remainder, and set a corresponding truncation flag (`relations.subIssuesTruncated`, `relations.blockedByTruncated`, `relations.blocksTruncated`, `relations.relatedTruncated`) to `true`. The system SHALL NOT reject the request or omit the task from the response because a relation collection exceeded the cap.

#### Scenario: A relation collection at exactly the cap is returned in full

- **WHEN** a task has exactly `TASK_RELATION_MAX_RESULTS` entries in one of its relation collections
- **THEN** the response includes all of those entries for that collection and the corresponding truncation flag is `false`

#### Scenario: A relation collection exceeding the cap is truncated, not rejected

- **WHEN** a task has more than `TASK_RELATION_MAX_RESULTS` entries in one of its relation collections
- **THEN** the response includes exactly `TASK_RELATION_MAX_RESULTS` entries for that collection, the corresponding truncation flag is `true`, and the request succeeds with the task's other fields unaffected

#### Scenario: Truncation keeps the most recently created entries

- **WHEN** a relation collection exceeds the cap and a new relation entry is created afterward
- **THEN** the newly created entry is present in the truncated collection and the oldest entries are the ones excluded

##### Example: newest relation survives truncation

- **GIVEN** a task already has `TASK_RELATION_MAX_RESULTS` `blockedBy` entries created on earlier days, and one more `blockedBy` relation is then created pointing at task `T-9001`
- **WHEN** the task is hydrated through `GET /api/tasks/:id`
- **THEN** the `blockedBy` collection contains exactly `TASK_RELATION_MAX_RESULTS` entries, includes the entry pointing at `T-9001`, and excludes the single oldest entry that would otherwise have made the count `TASK_RELATION_MAX_RESULTS + 1`


<!-- @trace
source: task-hydration-row-caps
updated: 2026-09-11
code:
  - openspec/changes/provider-contract-abstraction/tasks.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/proposal.md
  - openspec/changes/taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/design.md
  - openspec/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/attachment-delete-race-guard/proposal.md
  - openspec/changes/taskboard-trust-boundary/tasks.md
  - openspec/changes/attachment-delete-race-guard/design.md
  - openspec/changes/attachment-delete-race-guard/tasks.md
  - openspec/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/tasks.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/design.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/loopback-security-baseline/design.md
  - openspec/changes/provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/ai-workspace-scope-isolation/tasks.md
  - openspec/changes/attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/provider-contract-abstraction/design.md
  - openspec/changes/ai-workspace-scope-isolation/design.md
  - openspec/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/design.md
  - openspec/changes/provider-contract-abstraction/proposal.md
  - openspec/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/design.md
  - openspec/changes/loopback-security-baseline/.openspec.yaml
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/proposal.md
  - openspec/changes/taskboard-trust-boundary/proposal.md
  - openspec/changes/ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/proposal.md
  - .beads/interactions.jsonl
  - openspec/changes/archive/2026-09-11-retire-shared-board/.openspec.yaml
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/tasks.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/proposal.md
  - openspec/changes/loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/retire-shared-board/proposal.md
  - openspec/changes/retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/design.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - .deviation/issues.jsonl
  - openspec/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/proposal.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/tasks.md
  - handoff.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/design.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/tasks.md
  - openspec/changes/loopback-security-baseline/tasks.md
  - openspec/changes/loopback-security-baseline/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/.openspec.yaml
  - openspec/specs/shared-board-migration/spec.md
  - .deviation/ISSUES.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/design.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/design.md
-->

---
### Requirement: Per-task comment result cap in hydration paths

When hydrating a task through `GET /api/tasks/:id` or `GET /api/tasks`, the system SHALL cap the comments used to compute that task's `commentsTruncated`, `participants`, `conversationRefs`, `activityKey`, and `activityUpdatedAt` fields to at most `COMMENT_LIST_MAX_RESULTS` entries per task. When a task's comment count exceeds the cap, the system SHALL retain the most recently changed comments up to the cap, discard the remainder, and set `commentsTruncated` to `true`. The system SHALL NOT reject the request because a task's comment count exceeded the cap.

#### Scenario: A task's comment count at exactly the cap is used in full

- **WHEN** a task has exactly `COMMENT_LIST_MAX_RESULTS` comments
- **THEN** all of those comments are used to compute the task's hydrated fields and `commentsTruncated` is `false`

#### Scenario: A task's comment count exceeding the cap is truncated, not rejected

- **WHEN** a task has more than `COMMENT_LIST_MAX_RESULTS` comments
- **THEN** exactly `COMMENT_LIST_MAX_RESULTS` comments are used to compute the task's hydrated fields, `commentsTruncated` is `true`, and the request succeeds

#### Scenario: activityKey advances past a comment-count truncation

- **WHEN** a task's comment count exceeds the cap and a new comment is added afterward
- **THEN** the task's `activityKey` and `activityUpdatedAt` change to reflect the new comment on the next hydration


<!-- @trace
source: task-hydration-row-caps
updated: 2026-09-11
code:
  - openspec/changes/provider-contract-abstraction/tasks.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/proposal.md
  - openspec/changes/taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/design.md
  - openspec/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/attachment-delete-race-guard/proposal.md
  - openspec/changes/taskboard-trust-boundary/tasks.md
  - openspec/changes/attachment-delete-race-guard/design.md
  - openspec/changes/attachment-delete-race-guard/tasks.md
  - openspec/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/tasks.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/design.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/loopback-security-baseline/design.md
  - openspec/changes/provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/ai-workspace-scope-isolation/tasks.md
  - openspec/changes/attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/provider-contract-abstraction/design.md
  - openspec/changes/ai-workspace-scope-isolation/design.md
  - openspec/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/design.md
  - openspec/changes/provider-contract-abstraction/proposal.md
  - openspec/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/design.md
  - openspec/changes/loopback-security-baseline/.openspec.yaml
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/proposal.md
  - openspec/changes/taskboard-trust-boundary/proposal.md
  - openspec/changes/ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/proposal.md
  - .beads/interactions.jsonl
  - openspec/changes/archive/2026-09-11-retire-shared-board/.openspec.yaml
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/tasks.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/proposal.md
  - openspec/changes/loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/retire-shared-board/proposal.md
  - openspec/changes/retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/design.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - .deviation/issues.jsonl
  - openspec/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/proposal.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/tasks.md
  - handoff.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/design.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/tasks.md
  - openspec/changes/loopback-security-baseline/tasks.md
  - openspec/changes/loopback-security-baseline/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/.openspec.yaml
  - openspec/specs/shared-board-migration/spec.md
  - .deviation/ISSUES.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/design.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/design.md
-->

---
### Requirement: Per-task activity result cap in hydration paths

When hydrating a task through `GET /api/tasks/:id` or `GET /api/tasks`, the system SHALL cap the activities used to compute that task's `activitiesTruncated`, `participants`, `activityKey`, and `activityUpdatedAt` fields to at most `TASK_ACTIVITY_MAX_RESULTS` entries per task. When a task's activity count exceeds the cap, the system SHALL retain the most recently created activities up to the cap, discard the remainder, and set `activitiesTruncated` to `true`. The system SHALL NOT reject the request because a task's activity count exceeded the cap.

#### Scenario: A task's activity count at exactly the cap is used in full

- **WHEN** a task has exactly `TASK_ACTIVITY_MAX_RESULTS` activities
- **THEN** all of those activities are used to compute the task's hydrated fields and `activitiesTruncated` is `false`

#### Scenario: A task's activity count exceeding the cap is truncated, not rejected

- **WHEN** a task has more than `TASK_ACTIVITY_MAX_RESULTS` activities
- **THEN** exactly `TASK_ACTIVITY_MAX_RESULTS` activities are used to compute the task's hydrated fields, `activitiesTruncated` is `true`, and the request succeeds


<!-- @trace
source: task-hydration-row-caps
updated: 2026-09-11
code:
  - openspec/changes/provider-contract-abstraction/tasks.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/proposal.md
  - openspec/changes/taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/design.md
  - openspec/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/attachment-delete-race-guard/proposal.md
  - openspec/changes/taskboard-trust-boundary/tasks.md
  - openspec/changes/attachment-delete-race-guard/design.md
  - openspec/changes/attachment-delete-race-guard/tasks.md
  - openspec/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/tasks.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/design.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/loopback-security-baseline/design.md
  - openspec/changes/provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/ai-workspace-scope-isolation/tasks.md
  - openspec/changes/attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/provider-contract-abstraction/design.md
  - openspec/changes/ai-workspace-scope-isolation/design.md
  - openspec/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/design.md
  - openspec/changes/provider-contract-abstraction/proposal.md
  - openspec/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/design.md
  - openspec/changes/loopback-security-baseline/.openspec.yaml
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/proposal.md
  - openspec/changes/taskboard-trust-boundary/proposal.md
  - openspec/changes/ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/proposal.md
  - .beads/interactions.jsonl
  - openspec/changes/archive/2026-09-11-retire-shared-board/.openspec.yaml
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/tasks.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/proposal.md
  - openspec/changes/loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/retire-shared-board/proposal.md
  - openspec/changes/retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/design.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - .deviation/issues.jsonl
  - openspec/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/proposal.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/tasks.md
  - handoff.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/design.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/tasks.md
  - openspec/changes/loopback-security-baseline/tasks.md
  - openspec/changes/loopback-security-baseline/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/.openspec.yaml
  - openspec/specs/shared-board-migration/spec.md
  - .deviation/ISSUES.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/design.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/design.md
-->

---
### Requirement: Per-comment attachment result cap in hydration read paths

When hydrating a comment for a response — through `POST /api/tasks/:id/comments`, `PATCH /api/comments/:id`, `GET /api/tasks/:id/comments`, or `GET /api/tasks/:id/comments?after=` — the system SHALL cap that comment's `attachments` list to at most `COMMENT_ATTACHMENT_MAX_RESULTS` entries. When a comment's attachment count exceeds the cap, the system SHALL retain the most recently changed attachments up to the cap, discard the remainder from the response, and set `attachmentsTruncated` to `true` on that comment. The system SHALL NOT reject the request because a comment's attachment count exceeded the cap.

#### Scenario: A comment's attachment count at exactly the cap is returned in full

- **WHEN** a comment has exactly `COMMENT_ATTACHMENT_MAX_RESULTS` attachments
- **THEN** the hydrated comment includes all of those attachments and `attachmentsTruncated` is `false`

#### Scenario: A comment's attachment count exceeding the cap is truncated, not rejected

- **WHEN** a comment has more than `COMMENT_ATTACHMENT_MAX_RESULTS` attachments
- **THEN** the hydrated comment includes exactly `COMMENT_ATTACHMENT_MAX_RESULTS` attachments, `attachmentsTruncated` is `true`, and the request succeeds


<!-- @trace
source: task-hydration-row-caps
updated: 2026-09-11
code:
  - openspec/changes/provider-contract-abstraction/tasks.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/proposal.md
  - openspec/changes/taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/design.md
  - openspec/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/attachment-delete-race-guard/proposal.md
  - openspec/changes/taskboard-trust-boundary/tasks.md
  - openspec/changes/attachment-delete-race-guard/design.md
  - openspec/changes/attachment-delete-race-guard/tasks.md
  - openspec/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/tasks.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/design.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/loopback-security-baseline/design.md
  - openspec/changes/provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/ai-workspace-scope-isolation/tasks.md
  - openspec/changes/attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/provider-contract-abstraction/design.md
  - openspec/changes/ai-workspace-scope-isolation/design.md
  - openspec/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/design.md
  - openspec/changes/provider-contract-abstraction/proposal.md
  - openspec/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/design.md
  - openspec/changes/loopback-security-baseline/.openspec.yaml
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/proposal.md
  - openspec/changes/taskboard-trust-boundary/proposal.md
  - openspec/changes/ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/proposal.md
  - .beads/interactions.jsonl
  - openspec/changes/archive/2026-09-11-retire-shared-board/.openspec.yaml
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/tasks.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/proposal.md
  - openspec/changes/loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/retire-shared-board/proposal.md
  - openspec/changes/retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/design.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - .deviation/issues.jsonl
  - openspec/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/proposal.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/tasks.md
  - handoff.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/design.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/tasks.md
  - openspec/changes/loopback-security-baseline/tasks.md
  - openspec/changes/loopback-security-baseline/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/.openspec.yaml
  - openspec/specs/shared-board-migration/spec.md
  - .deviation/ISSUES.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/design.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/design.md
-->

---
### Requirement: Batch task hydration truncation is isolated per task

When `GET /api/tasks` hydrates multiple tasks in one response, the system SHALL apply the relation, comment, and activity caps independently to each task. A task whose relations, comments, or activities exceed their respective caps SHALL NOT cause any other task in the same response to be omitted, truncated, or altered, and SHALL NOT cause the overall request to fail.

#### Scenario: One task's oversized sub-resource does not affect sibling tasks in the same list response

- **WHEN** a `GET /api/tasks` response includes one task whose comment count exceeds `COMMENT_LIST_MAX_RESULTS` alongside other tasks whose sub-resource counts are within all caps
- **THEN** the request succeeds with status 200, the oversized task's `commentsTruncated` is `true`, and every other task in the response is returned unmodified with its truncation flags `false`


<!-- @trace
source: task-hydration-row-caps
updated: 2026-09-11
code:
  - openspec/changes/provider-contract-abstraction/tasks.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/proposal.md
  - openspec/changes/taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/design.md
  - openspec/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/attachment-delete-race-guard/proposal.md
  - openspec/changes/taskboard-trust-boundary/tasks.md
  - openspec/changes/attachment-delete-race-guard/design.md
  - openspec/changes/attachment-delete-race-guard/tasks.md
  - openspec/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/tasks.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/design.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/loopback-security-baseline/design.md
  - openspec/changes/provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/ai-workspace-scope-isolation/tasks.md
  - openspec/changes/attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/provider-contract-abstraction/design.md
  - openspec/changes/ai-workspace-scope-isolation/design.md
  - openspec/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/design.md
  - openspec/changes/provider-contract-abstraction/proposal.md
  - openspec/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/design.md
  - openspec/changes/loopback-security-baseline/.openspec.yaml
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/proposal.md
  - openspec/changes/taskboard-trust-boundary/proposal.md
  - openspec/changes/ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/proposal.md
  - .beads/interactions.jsonl
  - openspec/changes/archive/2026-09-11-retire-shared-board/.openspec.yaml
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/tasks.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/proposal.md
  - openspec/changes/loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/retire-shared-board/proposal.md
  - openspec/changes/retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/design.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - .deviation/issues.jsonl
  - openspec/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/proposal.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/tasks.md
  - handoff.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/design.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/tasks.md
  - openspec/changes/loopback-security-baseline/tasks.md
  - openspec/changes/loopback-security-baseline/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/.openspec.yaml
  - openspec/specs/shared-board-migration/spec.md
  - .deviation/ISSUES.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/design.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/design.md
-->

---
### Requirement: Comment deletion attachment cleanup stays complete and fault-tolerant

When deleting a comment, the system SHALL read that comment's entire attachment set without applying `COMMENT_ATTACHMENT_MAX_RESULTS` or any other result cap, because the corresponding database rows are removed by cascading delete and any attachment excluded from this read would never be cleaned up. The system SHALL delete the underlying storage objects for those attachments using bounded-concurrency batches rather than a single unbounded concurrent operation, and a failure to delete an individual storage object SHALL NOT cause the comment deletion request to fail or report an error to the caller.

#### Scenario: Deleting a comment with more attachments than the concurrency batch size still removes all of them

- **WHEN** a comment with more attachments than the deletion batch size is deleted
- **THEN** the comment and all of its attachment rows are removed from the database, and the deletion request succeeds with status 204

#### Scenario: An individual storage cleanup failure does not fail the delete request

- **WHEN** deleting a comment's attachments and one storage object deletion fails while the others succeed
- **THEN** the comment deletion request still succeeds with status 204 and the failure is recorded for later investigation

<!-- @trace
source: task-hydration-row-caps
updated: 2026-09-11
code:
  - openspec/changes/provider-contract-abstraction/tasks.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/proposal.md
  - openspec/changes/taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/design.md
  - openspec/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/attachment-delete-race-guard/proposal.md
  - openspec/changes/taskboard-trust-boundary/tasks.md
  - openspec/changes/attachment-delete-race-guard/design.md
  - openspec/changes/attachment-delete-race-guard/tasks.md
  - openspec/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/tasks.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/design.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/loopback-security-baseline/design.md
  - openspec/changes/provider-contract-abstraction/.openspec.yaml
  - openspec/changes/retire-shared-board/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/ai-workspace-scope-isolation/tasks.md
  - openspec/changes/attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/provider-contract-abstraction/design.md
  - openspec/changes/ai-workspace-scope-isolation/design.md
  - openspec/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/.openspec.yaml
  - openspec/changes/ai-workspace-scope-isolation/.openspec.yaml
  - openspec/changes/taskboard-trust-boundary/design.md
  - openspec/changes/provider-contract-abstraction/proposal.md
  - openspec/specs/network-access-control/spec.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/design.md
  - openspec/changes/loopback-security-baseline/.openspec.yaml
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/proposal.md
  - openspec/changes/taskboard-trust-boundary/proposal.md
  - openspec/changes/ai-workspace-scope-isolation/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/proposal.md
  - .beads/interactions.jsonl
  - openspec/changes/archive/2026-09-11-retire-shared-board/.openspec.yaml
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/tasks.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/proposal.md
  - openspec/changes/loopback-security-baseline/specs/network-access-control/spec.md
  - openspec/changes/retire-shared-board/proposal.md
  - openspec/changes/retire-shared-board/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/.openspec.yaml
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/design.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/provider-contract-abstraction/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/specs/ai-workspace-access-scope/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/tasks.md
  - openspec/changes/archive/2026-09-11-taskboard-trust-boundary/specs/taskboard-content-trust-boundary/spec.md
  - openspec/changes/retire-shared-board/specs/shared-board-migration/spec.md
  - openspec/changes/attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - .deviation/issues.jsonl
  - openspec/specs/provider-contract/spec.md
  - openspec/changes/archive/2026-09-11-retire-shared-board/proposal.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/tasks.md
  - handoff.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/design.md
  - openspec/changes/archive/2026-09-11-provider-contract-abstraction/tasks.md
  - openspec/changes/loopback-security-baseline/tasks.md
  - openspec/changes/loopback-security-baseline/proposal.md
  - openspec/changes/archive/2026-09-11-attachment-delete-race-guard/specs/attachment-deletion-consistency/spec.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/.openspec.yaml
  - openspec/specs/shared-board-migration/spec.md
  - .deviation/ISSUES.md
  - openspec/changes/archive/2026-09-11-loopback-security-baseline/design.md
  - openspec/changes/archive/2026-09-11-ai-workspace-scope-isolation/design.md
-->