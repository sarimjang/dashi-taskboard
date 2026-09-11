## ADDED Requirements

### Requirement: Migrate shared cloud board data to a local project

The system SHALL provide a CLI command that exports all tasks, comments, and attachments belonging to a shared cloud board (identified by the existing `cloud-companion.json` configuration: `remoteUrl`, `actorName`, `sharedKey`) and imports them into a specified local project, without requiring the shared cloud proxy or Cloudflare Worker to remain available afterward.

The migration command SHALL be idempotent: running it more than once against the same source and destination SHALL NOT create duplicate tasks, comments, or attachments for items already migrated in a prior run.

The migration command SHALL NOT delete or modify the source cloud board data. Deletion of cloud-side data is out of scope for this capability and MUST be a separate, explicit user action taken only after the user has verified the migrated local data.

#### Scenario: Successful full migration

- **WHEN** a user runs the migration command against a shared cloud board containing tasks, comments, and attachments, targeting an existing local project
- **THEN** every task, comment, and attachment present on the cloud board SHALL appear in the local project's database with equivalent content, and the command SHALL print a summary reporting the count of migrated items

##### Example: migration summary counts

| Source item type | Source count | Migrated count |
| ----------------- | ------------- | --------------- |
| tasks | 42 | 42 |
| comments | 118 | 118 |
| attachments | 7 | 7 |

#### Scenario: Re-running migration after a partial success

- **WHEN** a user re-runs the migration command after a prior run that migrated some items but was interrupted before completing
- **THEN** the command SHALL skip items already present in the local project and SHALL only migrate the remaining items, without creating duplicates of the already-migrated items

#### Scenario: Migration failure on a subset of items

- **WHEN** the migration command encounters malformed or unreachable data for a subset of items during a run (for example, an attachment that fails to download)
- **THEN** the command SHALL continue migrating the remaining items, SHALL NOT silently drop the failed items, and SHALL print an explicit list identifying each failed item and the reason it failed

### Requirement: Cloud write path no longer accepts device/session identifiers after migration tooling ships

Once the shared cloud proxy is retired, the system SHALL NOT expose any endpoint that accepts `workspacePath`, `codexHostId`, or `codexProjectId` for the purpose of forwarding a request to a remote cloud service. Any request to a formerly-existing cloud proxy endpoint SHALL receive a standard routing-layer 404, not an application-level validation error referencing those fields.

#### Scenario: Request to a retired cloud proxy endpoint

- **WHEN** a client sends a request to a URL path that previously routed to the cloud proxy forwarding logic
- **THEN** the server SHALL respond with a standard 404 Not Found, and the server log SHALL NOT contain any record of an authorization attempt using a shared key, actor name, or remote URL

#### Scenario: Local companion routes remain unaffected

- **WHEN** a client sends a request to a route on the `isLocalCompanionRoute` allowlist (for example, `/api/local/cloud-session` or any path under `/api/local/`)
- **THEN** the server SHALL continue to serve that route exactly as before this change, since local companion routes are explicitly out of scope for retirement
