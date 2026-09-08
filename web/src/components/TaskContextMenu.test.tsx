import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TaskContextMenu } from "./TaskContextMenu";
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

// 6.1 acceptance test, targeting the two mappings pca-group6 introduced (createIssue for
// "Create copy", manualArchive for "Archive issue"): createIssue flips to true while
// manualArchive stays false, unlike both LOCAL_CAPABILITIES and JIRA_CAPABILITIES above. This
// exact object is what test/pca-group6-fake-provider.test.mjs registers into the real
// provider-registry.mjs under the source key "pca-group6-fake-createissue-provider" and
// asserts getProviderCapabilities returns unchanged — together the two tests show the two
// menu items are driven independently by their own capability bit, not by `source`.
const FAKE_PROVIDER_CAPABILITIES: ProviderCapabilities = { ...JIRA_CAPABILITIES, createIssue: true };

function buildTask(capabilities: ProviderCapabilities): Task {
  return {
    id: "task-1",
    identifier: "TASK-1",
    projectId: "project-1",
    title: "Sample task",
    description: "",
    status: "todo",
    priority: "none",
    labels: ["bug"],
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
    // Deliberately left as "jira": after the 6.2 fix, TaskContextMenu.tsx must gate on
    // `task.capabilities` alone and never read `task.source`.
    source: "jira",
    capabilities,
    isProviderManaged: true,
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

function renderMenu(capabilities: ProviderCapabilities) {
  return render(
    <TaskContextMenu
      task={buildTask(capabilities)}
      position={{ x: 0, y: 0 }}
      labels={["bug"]}
      onClose={() => {}}
      onEdit={() => {}}
      onStatusChange={() => {}}
      onPriorityChange={() => {}}
      onLabelsChange={() => {}}
      onDuplicate={() => {}}
      onCopy={() => {}}
      onOpenInThread={() => {}}
      onArchive={() => {}}
    />,
  );
}

describe("TaskContextMenu duplicate/archive visibility", () => {
  afterEach(() => {
    cleanup();
  });

  it("hides both 'Create copy' and 'Archive issue' for a Jira task (createIssue and manualArchive both false)", () => {
    renderMenu(JIRA_CAPABILITIES);
    expect(screen.queryByText("Create copy")).toBeNull();
    expect(screen.queryByText("Archive issue")).toBeNull();
  });

  it("shows both 'Create copy' and 'Archive issue' for a local task (createIssue and manualArchive both true)", () => {
    renderMenu(LOCAL_CAPABILITIES);
    expect(screen.queryByText("Create copy")).not.toBeNull();
    expect(screen.queryByText("Archive issue")).not.toBeNull();
  });

  it("shows 'Create copy' but not 'Archive issue' for a fake provider registered with createIssue: true, manualArchive: false", () => {
    expect(FAKE_PROVIDER_CAPABILITIES.createIssue).toBe(true);
    expect(FAKE_PROVIDER_CAPABILITIES.manualArchive).toBe(false);
    renderMenu(FAKE_PROVIDER_CAPABILITIES);
    expect(screen.queryByText("Create copy")).not.toBeNull();
    expect(screen.queryByText("Archive issue")).toBeNull();
  });
});
