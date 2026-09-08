import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ArchivedTasksColumn } from "./OtherTasksPanel";
import type { ActorIdentity, ProviderCapabilities, Task } from "../types";

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

// 6.1 acceptance test: a capability combination that was never named in OtherTasksPanel.tsx
// and matches neither LOCAL_CAPABILITIES nor JIRA_CAPABILITIES above (manualDelete flips to
// true while manualArchive stays false, per tasks.md 6.1's own example). This exact object is
// what test/pca-group6-fake-provider.test.mjs registers into the real provider-registry.mjs
// under the source key "pca-group6-fake-provider" and asserts getProviderCapabilities returns
// unchanged — the two tests together prove a provider registered with this combination reaches
// the UI and renders correctly without editing a single conditional in OtherTasksPanel.tsx.
const FAKE_PROVIDER_CAPABILITIES: ProviderCapabilities = { ...JIRA_CAPABILITIES, manualDelete: true };

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
    // `source` is deliberately left as "jira" even for the local/fake cases below: after the
    // 6.2 fix, OtherTasksPanel.tsx must not read `task.source` at all, only `task.capabilities`.
    source: "jira",
    capabilities,
    isProviderManaged: true,
    externalOrigin: null,
    externalKey: null,
    externalUrl: null,
    archivedAt: "2026-01-01T00:00:00.000Z",
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderColumn(capabilities: ProviderCapabilities) {
  return render(
    <ArchivedTasksColumn
      tasks={[buildTask(capabilities)]}
      hasActiveFilters={false}
      restoringTaskId={null}
      deletingTaskId={null}
      onRestore={() => {}}
      onDelete={() => {}}
    />,
  );
}

describe("ArchivedTaskCard restore/delete visibility", () => {
  afterEach(() => {
    cleanup();
  });

  it("hides both restore and delete for a Jira task (manualArchive and manualDelete both false)", () => {
    renderColumn(JIRA_CAPABILITIES);
    expect(screen.queryByText("Restore")).toBeNull();
    expect(screen.queryByLabelText(/Permanently delete/)).toBeNull();
  });

  it("shows both restore and delete for a local task (manualArchive and manualDelete both true)", () => {
    renderColumn(LOCAL_CAPABILITIES);
    expect(screen.queryByText("Restore")).not.toBeNull();
    expect(screen.queryByLabelText(/Permanently delete/)).not.toBeNull();
  });

  it("shows only delete (not restore) for a fake provider registered with manualDelete: true, manualArchive: false", () => {
    expect(FAKE_PROVIDER_CAPABILITIES.manualArchive).toBe(false);
    expect(FAKE_PROVIDER_CAPABILITIES.manualDelete).toBe(true);
    renderColumn(FAKE_PROVIDER_CAPABILITIES);
    expect(screen.queryByText("Restore")).toBeNull();
    expect(screen.queryByLabelText(/Permanently delete/)).not.toBeNull();
  });
});
