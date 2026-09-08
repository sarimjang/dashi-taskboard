import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
// Importing jira-integration.mjs triggers its module-load-time `registerProvider("jira", ...)`
// call (design.md §2 correction) — without it `getProviderCapabilities("jira")` falls back to
// the local defaults because no provider is registered under that key.
import "../server/jira-integration.mjs";
import { getProviderCapabilities } from "../server/provider-registry.mjs";
import { JIRA_PROJECT_ID } from "../shared/domain.mjs";

const actor = {
  type: "user",
  id: "capabilities-tester",
  name: "Capabilities Tester",
  avatarUrl: null,
};

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-capabilities-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  return {
    database,
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function createLocalTask(database, projectId, title, overrides = {}) {
  return database.createTask({
    projectId,
    title,
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor,
    assignee: actor,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    ...overrides,
  });
}

function insertJiraTaskRow(database, { id, identifier }) {
  const timestamp = new Date().toISOString();
  database.database.prepare(`
    INSERT INTO tasks (
      id, identifier, project_id, title, status, priority,
      external_source, external_origin, external_id, external_key,
      sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'todo', 'none', 'jira', 'test-origin', ?, ?, 1000, ?, ?)
  `).run(id, identifier, JIRA_PROJECT_ID, `Jira task ${identifier}`, id, identifier, timestamp, timestamp);
}

test("taskFromRow attaches local default capabilities to a local task without changing its source", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.createProject({
      id: "capabilities-local",
      name: "Capabilities Local",
      workspacePath: null,
    });
    const task = createLocalTask(fixture.database, "capabilities-local", "Local task");

    assert.equal(task.source, "local");
    assert.deepEqual(task.capabilities, getProviderCapabilities(null));

    const fetched = fixture.database.getTask(task.id);
    assert.equal(fetched.source, "local");
    assert.deepEqual(fetched.capabilities, getProviderCapabilities(null));
  } finally {
    await fixture.close();
  }
});

test("taskFromRow attaches the jira provider's capabilities to a jira-sourced task without changing its source", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.ensureJiraProject("Jira Test Project");
    insertJiraTaskRow(fixture.database, { id: "jira-task-1", identifier: "JIRA-1" });

    const task = fixture.database.getTask("jira-task-1");
    assert.equal(task.source, "jira");
    assert.deepEqual(task.capabilities, getProviderCapabilities("jira"));
    assert.notDeepEqual(task.capabilities, getProviderCapabilities(null));
  } finally {
    await fixture.close();
  }
});

test("projectFromRow attaches local default capabilities to a local project without changing its source", async () => {
  const fixture = await createFixture();
  try {
    const created = fixture.database.createProject({
      id: "capabilities-local-project",
      name: "Capabilities Local Project",
      workspacePath: null,
    });

    assert.equal(created.source, "local");
    assert.deepEqual(created.capabilities, getProviderCapabilities(null));

    const fetched = fixture.database.getProject("capabilities-local-project");
    assert.equal(fetched.source, "local");
    assert.deepEqual(fetched.capabilities, getProviderCapabilities(null));
  } finally {
    await fixture.close();
  }
});

test("projectFromRow attaches the jira provider's capabilities to the jira project without changing its source", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.ensureJiraProject("Jira Test Project");

    const project = fixture.database.getProject(JIRA_PROJECT_ID);
    assert.equal(project.source, "jira");
    assert.deepEqual(project.capabilities, getProviderCapabilities("jira"));
    assert.notDeepEqual(project.capabilities, getProviderCapabilities(null));
  } finally {
    await fixture.close();
  }
});
