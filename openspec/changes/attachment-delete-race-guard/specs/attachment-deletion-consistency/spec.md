## ADDED Requirements

### Requirement: Attachment deletion guard detects any change to the attachment set, not just a count match

For `deleteProject()` and `deleteArchivedTask()`, the system SHALL reject the deletion of the parent resource (project or archived task) unless the attachment revision counter of that resource — read immediately before the attachment ids are collected for cleanup — is still identical to the counter's value at the moment the deletion statement executes. The system SHALL NOT determine whether it is safe to proceed by comparing only the number of currently existing attachment rows to the number of ids collected during pagination.

#### Scenario: No concurrent attachment change allows deletion to proceed

- **WHEN** a project's README attachments or a task's attachments are deleted with no concurrent attachment mutation occurring between id collection and the delete statement
- **THEN** the parent resource and all of its collected attachments are removed from the database, and the corresponding storage objects are deleted

#### Scenario: A concurrent attachment insertion blocks deletion

- **WHEN** a new attachment is uploaded for the project or task after attachment ids have already been collected but before the delete statement executes
- **THEN** the delete statement affects zero rows, and the caller receives a retryable conflict response instead of the project or task being deleted

#### Scenario: A net-zero concurrent change (one deletion, one insertion) still blocks deletion

- **WHEN**, after attachment ids have been collected, one previously-collected attachment is deleted and a new attachment is uploaded for the same project or task before the delete statement executes, leaving the total attachment count unchanged
- **THEN** the delete statement affects zero rows, the caller receives a retryable conflict response, and the newly uploaded attachment's database row and storage object both remain

##### Example: one delete + one upload leaves the count unchanged but the deletion is still rejected

- **GIVEN** a project has README attachments {A, B} and a deletion request has already collected ids {A, B}
- **WHEN** attachment A is deleted and a new attachment C is uploaded for the same project before the delete statement runs
- **THEN** the project's attachment set is now {B, C} (count still 2, matching the originally collected count), the delete statement is rejected, and attachment C's database row and storage object are not removed

### Requirement: Attachment mutations automatically advance the owning resource's attachment revision counter

Every insertion into, or deletion from, the `project_readme_attachments` table SHALL advance the attachment revision counter of the referenced project. Every insertion into, or deletion from, the `attachments` table SHALL advance the attachment revision counter of the referenced task, regardless of whether the affected attachment row is directly associated with the task or is associated with one of the task's comments. This SHALL hold both for direct deletion of an individual attachment and for attachment rows removed as a cascading side effect of deleting their owning comment.

#### Scenario: Uploading an attachment advances the task's counter

- **WHEN** a new attachment is uploaded for a task, either directly on the task or attached to one of the task's comments
- **THEN** the task's attachment revision counter increases

#### Scenario: Deleting an individual attachment advances the owning resource's counter

- **WHEN** an individual task attachment or project README attachment is deleted directly
- **THEN** the attachment revision counter of its owning task or project increases

#### Scenario: Deleting a comment advances its task's attachment counter when the comment had attachments

- **WHEN** a comment that has one or more attachments is deleted, causing those attachment rows to be removed by cascading delete
- **THEN** the attachment revision counter of the comment's task increases

#### Scenario: Deleting a comment with no attachments does not require any attachment row change

- **WHEN** a comment that has no attachments is deleted
- **THEN** no attachment rows are affected and the comment's task attachment revision counter is not required to change
