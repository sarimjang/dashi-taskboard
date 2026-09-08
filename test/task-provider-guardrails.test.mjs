import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/app.mjs";
import { JIRA_PROJECT_ID } from "../shared/domain.mjs";

// Pinning tests for the five 409 guardrails in server/app.mjs (PATCH/DELETE/move/
// archive/restore task routes) that pca-group4 rewrites from literal
// `current.source === "jira"` comparisons to ProviderCapabilities reads. See
// openspec/changes/provider-contract-abstraction/tasks.md §4 and the pca-group4
// assignment: these five error codes had zero prior test coverage anywhere in the
// repo (confirmed by grep before this file was added), so this file is the sole
// behavior-preservation evidence for the rewrite, not a supplement to existing
// coverage.

const actor = {
  type: "user",
  id: "guardrail-tester",
  name: "Guardrail Tester",
  avatarUrl: null,
};

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-provider-guardrail-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  const address = await app.listen({ port: 0 });
  runningApps.push({ app, directory });
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : undefined,
  };
}

let jiraTaskCounter = 0;

/**
 * Inserts a task row with external_source = 'jira' directly via SQL, mirroring
 * test/database-capabilities.test.mjs's insertJiraTaskRow helper. Jira tasks are
 * never created through the HTTP API (they only arrive via sync), so this is the
 * established pattern in this repo for producing a jira-sourced task fixture.
 */
function insertJiraTask(app, overrides = {}) {
  jiraTaskCounter += 1;
  const id = overrides.id ?? `jira-task-${jiraTaskCounter}`;
  const identifier = overrides.identifier ?? `JIRA-${jiraTaskCounter}`;
  const timestamp = new Date().toISOString();
  app.database.database.prepare(`
    INSERT INTO tasks (
      id, identifier, project_id, title, status, priority,
      external_source, external_origin, external_id, external_key,
      sort_order, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'none', 'jira', ?, ?, ?, 1000, ?, ?, ?)
  `).run(
    id,
    identifier,
    JIRA_PROJECT_ID,
    `Jira task ${identifier}`,
    overrides.status ?? "todo",
    "test-origin",
    id,
    identifier,
    overrides.archivedAt ?? null,
    timestamp,
    timestamp,
  );
  return app.database.getTask(id);
}

async function createLocalTask(baseUrl, overrides = {}) {
  const result = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: { title: "Local task", ...overrides },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.task;
}

async function withJiraProject(app) {
  app.database.ensureJiraProject("Guardrail Jira Project");
}

// ---------------------------------------------------------------------------
// PATCH /api/tasks/:id — JIRA_ASSIGNEE_UNAVAILABLE
// ---------------------------------------------------------------------------

test("PATCH rejects assigneeTarget changes on a jira-sourced task with JIRA_ASSIGNEE_UNAVAILABLE", async () => {
  const { app, baseUrl } = await startServer();
  await withJiraProject(app);
  const task = insertJiraTask(app);

  const result = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, assigneeTarget: "current-user" },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "JIRA_ASSIGNEE_UNAVAILABLE");
  assert.equal(result.body.error.message, "请在 Jira 中修改经办人");
});

test("PATCH permits assigneeTarget changes on a local task", async () => {
  const { app, baseUrl } = await startServer();
  const task = await createLocalTask(baseUrl);

  const result = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, assigneeTarget: "current-user" },
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
});

// ---------------------------------------------------------------------------
// PATCH /api/tasks/:id — JIRA_PROJECT_MOVE_UNAVAILABLE (both directions)
// ---------------------------------------------------------------------------

test("PATCH rejects a local task moving into the Jira project with JIRA_PROJECT_MOVE_UNAVAILABLE (direction 1: local -> jira)", async () => {
  const { app, baseUrl } = await startServer();
  await withJiraProject(app);
  const task = await createLocalTask(baseUrl);

  const result = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, projectId: JIRA_PROJECT_ID },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "JIRA_PROJECT_MOVE_UNAVAILABLE");
  assert.equal(result.body.error.message, "本地任务不能移入 Jira 同步项目");
});

test("PATCH permits a local task moving into another local project", async () => {
  const { baseUrl } = await startServer();
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "guardrail-target", name: "Guardrail Target" },
  });
  const task = await createLocalTask(baseUrl);

  const result = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, projectId: "guardrail-target" },
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.task.projectId, "guardrail-target");
});

test("PATCH rejects a jira task being reassigned to its own project with JIRA_PROJECT_MOVE_UNAVAILABLE (direction 2: jira -> jira, no-op reassignment)", async () => {
  const { app, baseUrl } = await startServer();
  await withJiraProject(app);
  const task = insertJiraTask(app);

  const result = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, projectId: JIRA_PROJECT_ID },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "JIRA_PROJECT_MOVE_UNAVAILABLE");
  assert.equal(result.body.error.message, "Jira 任务不能移到本地项目");
});

test("PATCH rejects a jira task moving to a local project with JIRA_PROJECT_MOVE_UNAVAILABLE (direction 2: jira -> local)", async () => {
  const { app, baseUrl } = await startServer();
  await withJiraProject(app);
  await request(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "guardrail-target-2", name: "Guardrail Target 2" },
  });
  const task = insertJiraTask(app);

  const result = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, projectId: "guardrail-target-2" },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "JIRA_PROJECT_MOVE_UNAVAILABLE");
  assert.equal(result.body.error.message, "Jira 任务不能移到本地项目");
});

// ---------------------------------------------------------------------------
// PATCH /api/tasks/:id — provider-existence gate for calling jira.updateTask
// ---------------------------------------------------------------------------

test("PATCH on a local task never invokes the jira provider (succeeds without Jira configured)", async () => {
  const { baseUrl } = await startServer();
  const task = await createLocalTask(baseUrl);

  const result = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, title: "Renamed locally" },
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.task.title, "Renamed locally");
});

test("PATCH on a jira task invokes the jira provider even for unrestricted fields (surfaces JIRA_NOT_CONFIGURED since no Jira config exists)", async () => {
  const { app, baseUrl } = await startServer();
  await withJiraProject(app);
  const task = insertJiraTask(app);

  const result = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, title: "Renamed via Taskboard" },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "JIRA_NOT_CONFIGURED");
});

// ---------------------------------------------------------------------------
// DELETE /api/tasks/:id — JIRA_DELETE_UNAVAILABLE
// ---------------------------------------------------------------------------

test("DELETE rejects a jira-sourced task with JIRA_DELETE_UNAVAILABLE", async () => {
  const { app, baseUrl } = await startServer();
  await withJiraProject(app);
  const task = insertJiraTask(app);

  const result = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "DELETE",
    body: { version: task.version },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "JIRA_DELETE_UNAVAILABLE");
  assert.equal(result.body.error.message, "Jira 任务不能从 Taskboard 永久删除");
});

test("DELETE permits deleting an archived local task", async () => {
  const { baseUrl } = await startServer();
  const task = await createLocalTask(baseUrl);
  const archived = await request(baseUrl, `/api/tasks/${task.id}/archive`, {
    method: "POST",
    body: { version: task.version },
  });
  assert.equal(archived.response.status, 200, JSON.stringify(archived.body));

  const result = await request(baseUrl, `/api/tasks/${task.id}`, {
    method: "DELETE",
    body: { version: archived.body.task.version },
  });

  assert.equal(result.response.status, 204);
});

test("DELETE on a nonexistent task returns 404 TASK_NOT_FOUND, not the jira guardrail (current is null/undefined edge case)", async () => {
  const { baseUrl } = await startServer();

  const result = await request(baseUrl, "/api/tasks/does-not-exist", {
    method: "DELETE",
    body: { version: 1 },
  });

  assert.equal(result.response.status, 404);
  assert.equal(result.body.error.code, "TASK_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/move — manualMove-gated version/archived pre-checks and
// the Jira move-call timing
// ---------------------------------------------------------------------------

test("move on a jira task with a stale version rejects with VERSION_CONFLICT before contacting Jira", async () => {
  const { app, baseUrl } = await startServer();
  await withJiraProject(app);
  const task = insertJiraTask(app);

  const result = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version + 1, status: "in_progress" },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "VERSION_CONFLICT");
});

test("move on an archived jira task rejects with TASK_ARCHIVED before contacting Jira", async () => {
  const { app, baseUrl } = await startServer();
  await withJiraProject(app);
  const task = insertJiraTask(app);
  const archived = app.database.archiveTask(task.id, task.version, undefined, undefined, actor);

  const result = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: archived.version, status: "in_progress" },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "TASK_ARCHIVED");
});

test("move on a jira task with a real status change invokes the jira provider (surfaces JIRA_NOT_CONFIGURED since no Jira config exists)", async () => {
  const { app, baseUrl } = await startServer();
  await withJiraProject(app);
  const task = insertJiraTask(app, { status: "todo" });

  const result = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status: "in_progress" },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "JIRA_NOT_CONFIGURED");
});

test("move on a local task never invokes the jira provider (succeeds without Jira configured, no pre-checks)", async () => {
  const { baseUrl } = await startServer();
  const task = await createLocalTask(baseUrl);

  const result = await request(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status: "in_progress" },
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.task.status, "in_progress");
});

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/archive — JIRA_ARCHIVE_UNAVAILABLE
// ---------------------------------------------------------------------------

test("archive rejects a jira-sourced task with JIRA_ARCHIVE_UNAVAILABLE", async () => {
  const { app, baseUrl } = await startServer();
  await withJiraProject(app);
  const task = insertJiraTask(app);

  const result = await request(baseUrl, `/api/tasks/${task.id}/archive`, {
    method: "POST",
    body: { version: task.version },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "JIRA_ARCHIVE_UNAVAILABLE");
  assert.equal(result.body.error.message, "Jira 任务由同步范围自动管理，不能手动归档");
});

test("archive permits archiving a local task", async () => {
  const { baseUrl } = await startServer();
  const task = await createLocalTask(baseUrl);

  const result = await request(baseUrl, `/api/tasks/${task.id}/archive`, {
    method: "POST",
    body: { version: task.version },
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.notEqual(result.body.task.archivedAt, null);
});

test("archive on a nonexistent task returns 404 TASK_NOT_FOUND, not the jira guardrail (current is null/undefined edge case)", async () => {
  const { baseUrl } = await startServer();

  const result = await request(baseUrl, "/api/tasks/does-not-exist/archive", {
    method: "POST",
    body: { version: 1 },
  });

  assert.equal(result.response.status, 404);
  assert.equal(result.body.error.code, "TASK_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// POST /api/tasks/:id/restore — JIRA_RESTORE_UNAVAILABLE
// ---------------------------------------------------------------------------

test("restore rejects a jira-sourced task with JIRA_RESTORE_UNAVAILABLE", async () => {
  const { app, baseUrl } = await startServer();
  await withJiraProject(app);
  const task = insertJiraTask(app);
  const archived = app.database.archiveTask(task.id, task.version, undefined, undefined, actor);

  const result = await request(baseUrl, `/api/tasks/${task.id}/restore`, {
    method: "POST",
    body: { version: archived.version },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, "JIRA_RESTORE_UNAVAILABLE");
  assert.equal(result.body.error.message, "Jira 任务由同步范围自动管理，不能手动恢复");
});

test("restore permits restoring an archived local task", async () => {
  const { baseUrl } = await startServer();
  const task = await createLocalTask(baseUrl);
  const archived = await request(baseUrl, `/api/tasks/${task.id}/archive`, {
    method: "POST",
    body: { version: task.version },
  });
  assert.equal(archived.response.status, 200, JSON.stringify(archived.body));

  const result = await request(baseUrl, `/api/tasks/${task.id}/restore`, {
    method: "POST",
    body: { version: archived.body.task.version },
  });

  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.task.archivedAt, null);
});

test("restore on a nonexistent task returns 404 TASK_NOT_FOUND, not the jira guardrail (current is null/undefined edge case)", async () => {
  const { baseUrl } = await startServer();

  const result = await request(baseUrl, "/api/tasks/does-not-exist/restore", {
    method: "POST",
    body: { version: 1 },
  });

  assert.equal(result.response.status, 404);
  assert.equal(result.body.error.code, "TASK_NOT_FOUND");
});
