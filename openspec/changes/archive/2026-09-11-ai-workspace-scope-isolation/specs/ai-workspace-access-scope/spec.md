## ADDED Requirements

### Requirement: AI turn filesystem access SHALL be scoped to the thread's own project workspace

When the system resolves the filesystem access scope for an AI chat turn (via `resolvedWorkspace`, `resolveAiWorkspace`, or `resolveMappedAiWorkspace`), the resulting `addDirectories` list SHALL be empty regardless of how many other projects are mapped on the device or in the database. The only filesystem root granted to the spawned codex subprocess for a turn SHALL be the workspace path of the project the thread belongs to.

#### Scenario: Single mapped project

- **WHEN** the system resolves the AI workspace for a project and only that project is mapped
- **THEN** the resolved `addDirectories` SHALL be an empty array
- **AND** the codex subprocess SHALL be launched with `runtimeWorkspaceRoots` containing only that project's workspace path

#### Scenario: Multiple mapped projects on the same device

- **WHEN** the system resolves the AI workspace for a project and two or more other projects are also mapped on the device
- **THEN** the resolved `addDirectories` SHALL still be an empty array
- **AND** none of the other projects' workspace paths SHALL appear in the codex exec arguments (no `--add-dir` flag SHALL be emitted for them)

##### Example: three mapped projects, one active thread

| Mapped projects (workspace paths) | Active thread's project | Resolved `addDirectories` | `--add-dir` flags emitted |
| ---------------------------------- | ------------------------ | -------------------------- | -------------------------- |
| A, B, C | A | `[]` | none |
| A, B, C | B | `[]` | none |

### Requirement: Cross-project filesystem access SHALL NOT be granted implicitly or through an undocumented default

The system SHALL NOT provide any mechanism — implicit, default-on, or otherwise — that grants an AI chat turn filesystem access to a project other than the one the thread belongs to. No user-facing or configuration-driven cross-project authorization mechanism SHALL be introduced as part of this capability; cross-project access is explicitly unsupported.

#### Scenario: No cross-project opt-in exists

- **WHEN** a user or operator looks for a way to grant an AI chat turn access to another project's workspace
- **THEN** the system SHALL NOT expose any such setting, flag, or API parameter
- **AND** the codex subprocess SHALL remain confined to the single project workspace resolved for that thread's turn
