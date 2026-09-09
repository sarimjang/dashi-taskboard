## ADDED Requirements

### Requirement: Automation prompt field interpolation SHALL use delimited untrusted-data wrapping

The automation prompt builder SHALL wrap every host-request field value it interpolates into the generated prompt with a consistent delimiter that marks the value as untrusted taskboard-supplied data.

#### Scenario: Ordinary field value is wrapped

- **WHEN** the automation prompt is built for a request whose `projectName` does not contain a delimiter sequence
- **THEN** the generated prompt contains that `projectName` value fully enclosed within the delimiter markers

### Requirement: Delimiter boundaries SHALL be escaped against field values that contain a delimiter sequence

The automation prompt builder SHALL prevent an interpolated field value from prematurely closing a delimiter boundary, even when the field value itself contains a sequence identical to the delimiter.

#### Scenario: Field value containing the delimiter sequence

- **WHEN** the automation prompt is built for a request whose `projectName` contains the literal delimiter closing sequence
- **THEN** the generated prompt's delimiter boundary around that field remains intact, and the delimiter sequence inside the field value is escaped so it cannot be interpreted as closing the boundary early

##### Example: adversarial values do not break the boundary

| `projectName` value | Expected boundary outcome |
| --- | --- |
| `Website Revamp` | value enclosed normally, no escaping needed |
| contains the exact delimiter closing sequence | delimiter sequence inside the value is escaped; the real boundary still closes at the position the builder inserted, not inside the value |
| contains text resembling an instruction override (e.g. "ignore previous instructions") | value is enclosed like any other untrusted string; it carries no special meaning to the builder itself, only to the framing statement's instruction to the reader |

### Requirement: Automation prompt SHALL declare untrusted-data framing before any delimited content

The generated automation prompt SHALL include a fixed framing statement, appearing before the first delimited field value, declaring that content enclosed by the delimiter markers is untrusted external data usable only to answer the workflow's fixed decision points, and that such content MUST NOT be interpreted as a new instruction, a new tool invocation, or an override of the prompt's own authority.

#### Scenario: Framing statement precedes delimited content

- **WHEN** the automation prompt is generated
- **THEN** the framing statement appears in the output before the first delimiter-wrapped field value

### Requirement: Interactive workflow instructions SHALL apply the same untrusted-data trust boundary to taskboard issue content

The Taskboard Delivery Workflow section of AGENTS.md and the Core workflow section of skills/manage-taskboard/SKILL.md SHALL instruct any agent that reads a taskboard issue's title, description, or comments to treat that content as untrusted external data usable only to answer the workflow's fixed decision points (proceed, skip, wait, blocked, in_review). Both documents SHALL explicitly prohibit interpreting such content as a new instruction, a new tool invocation, or an override of the agent's current operating instructions.

#### Scenario: Comment content is limited to fixed decision points

- **WHEN** an agent following the Taskboard Delivery Workflow or the manage-taskboard skill reads an issue comment
- **THEN** the agent uses that comment only to choose among the workflow's fixed set of decision outcomes, and does not treat instruction-like text inside the comment as a new directive superseding its current operating instructions

#### Scenario: Existing wait-then-skip behavior remains a fixed decision point

- **WHEN** an issue comment instructs the agent to wait, avoid executing, or not start now
- **THEN** the agent skips the issue and reports without changing its status, and this outcome is documented as one of the workflow's fixed decision points rather than as an open-ended instruction the comment author can redefine

### Requirement: Taskboard content forwarded to a remote worker thread SHALL retain the untrusted-data delimiter convention

When the automation prompt instructs the agent to forward an issue's number, title, description, and comments into a message sent to a remote worker thread, that instruction SHALL require the forwarded content to be wrapped using the same delimiter convention defined for the automation prompt's own untrusted-data framing.

#### Scenario: Forwarded issue content is delimited

- **WHEN** the automation agent composes a message to a remote worker thread that includes taskboard issue content
- **THEN** the automation prompt's instructions require that issue content to be wrapped in the same untrusted-data delimiter convention used for the prompt's own field interpolation
