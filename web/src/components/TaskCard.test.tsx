import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCard, TaskCardMedia } from "./TaskCard";
import type { ActorIdentity, ProviderCapabilities, Task } from "../types";
import type { TaskCardPresentation } from "../taskConversations";

const ACTOR: ActorIdentity = { type: "user", id: "user-1", name: "User One", avatarUrl: null };

const LOCAL_CAPABILITIES: ProviderCapabilities = {
  createIssue: true,
  updateAssignee: true,
  comments: "read-write",
  attachments: "read-write",
  relations: "read-write",
  webhook: true,
  incrementalSync: true,
  manualArchive: true,
  manualDelete: true,
  manualMove: true,
  assigneeEdit: true,
  projectReassign: true,
};

const JIRA_CAPABILITIES: ProviderCapabilities = {
  createIssue: false,
  updateAssignee: false,
  comments: "none",
  attachments: "none",
  relations: "none",
  webhook: false,
  incrementalSync: false,
  manualArchive: false,
  manualDelete: false,
  manualMove: false,
  assigneeEdit: false,
  projectReassign: false,
};

function buildTask(capabilities: ProviderCapabilities): Task {
  return {
    id: "task-1",
    identifier: "TASK-1",
    projectId: "project-1",
    title: "Sample task",
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    sortOrder: 0,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    conversationRefs: [],
    participants: [],
    previewImage: null,
    activityKey: "task-1:0",
    activityUpdatedAt: "2026-01-01T00:00:00.000Z",
    creatorType: "user",
    creatorId: ACTOR.id,
    creatorName: ACTOR.name,
    creatorAvatarUrl: null,
    assignee: ACTOR,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    source: capabilities.assigneeEdit ? "local" : "jira",
    capabilities,
    externalOrigin: null,
    externalKey: null,
    externalUrl: null,
    archivedAt: null,
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const PRESENTATION: TaskCardPresentation = {
  conversations: [],
  processing: { running: false, completed: null, total: null, startedAt: null },
  unread: false,
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("TaskCardMedia", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a Taskboard attachment cover image immediately, with no click required", () => {
    const { container } = render(<TaskCardMedia src="api/attachments/abc-123/content" />);
    expect(container.querySelector("img")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gates an external cover image behind a click before it loads", () => {
    const { container } = render(<TaskCardMedia src="https://tracker.invalid/pixel.png" />);
    expect(container.querySelector("img")).toBeNull();

    const gate = screen.getByRole("button");
    fireEvent.click(gate);

    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://tracker.invalid/pixel.png");
  });

  it("never offers to load a cover image pointing at a private network destination", () => {
    const { container } = render(<TaskCardMedia src="http://192.168.1.1/probe.png" />);
    expect(container.firstChild).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("TaskCard assignee control", () => {
  afterEach(() => {
    cleanup();
  });

  function renderCard(task: Task) {
    return render(
      <TaskCard
        task={task}
        variant="sidebar"
        presentation={PRESENTATION}
        now={Date.now()}
        isDragging={false}
        dragShift={0}
        isMoving={false}
        isSettling={false}
        isContextMenuOpen={false}
        availableLabels={[]}
        currentUser={ACTOR}
        showCover={false}
        showBody={false}
        onCreateLabel={async () => {}}
        onEdit={() => {}}
        onUpdate={async (updated) => updated}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onOpenConversation={() => {}}
      />,
    );
  }

  it("disables the assignee control when the task's provider capabilities disallow assigneeEdit", () => {
    renderCard(buildTask(JIRA_CAPABILITIES));
    const button = screen.getByRole("button", { name: "TASK-1 assignee" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("enables the assignee control when the task's provider capabilities allow assigneeEdit", () => {
    renderCard(buildTask(LOCAL_CAPABILITIES));
    const button = screen.getByRole("button", { name: "TASK-1 assignee" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
