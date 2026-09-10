import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

let cloud;
const alice = "Alice";
const bob = "Bob";

before(async () => {
  cloud = await createCloudWorkerHarness();
});

after(async () => {
  await cloud?.dispose();
});

async function createProject(id, actorName = alice) {
  return cloud.request("/api/projects", {
    method: "POST",
    actorName,
    json: {
      id,
      name: id.toUpperCase(),
      workspacePath: `/Users/${actorName.toLowerCase()}/${id}`,
    },
  });
}

async function createTask(projectId, title, actorName = alice, extra = {}) {
  return cloud.request("/api/tasks", {
    method: "POST",
    actorName,
    json: {
      projectId,
      title,
      description: "",
      status: "backlog",
      priority: "none",
      labels: [],
      ...extra,
    },
  });
}

test("Basic authentication protects static assets, APIs, and attachment content", async () => {
  for (const pathname of ["/", "/api/projects", "/api/attachments/missing/content"]) {
    const missing = await cloud.request(pathname);
    assert.equal(missing.response.status, 401);
    assert.match(missing.response.headers.get("www-authenticate") ?? "", /^Basic\b/i);

    const invalid = await cloud.request(pathname, {
      actorName: alice,
      password: "wrong",
    });
    assert.equal(invalid.response.status, 401);
    assert.match(invalid.response.headers.get("www-authenticate") ?? "", /^Basic\b/i);
  }
});

test("Basic authentication requires an exact shared-secret match", async () => {
  const accepted = await cloud.request("/api/projects", { actorName: alice });
  assert.equal(accepted.response.status, 200);

  const lastCharacter = cloud.sharedSecret.at(-1);
  const sameLengthWrongSecret = `${cloud.sharedSecret.slice(0, -1)}${
    lastCharacter === "x" ? "y" : "x"
  }`;
  assert.equal(sameLengthWrongSecret.length, cloud.sharedSecret.length);
  const rejected = await cloud.request("/api/projects", {
    actorName: alice,
    password: sameLengthWrongSecret,
  });
  assert.equal(rejected.response.status, 401);
  assert.match(rejected.response.headers.get("www-authenticate") ?? "", /^Basic\b/i);
});

test("the Basic username becomes the trusted actor while the shared password grants access", async () => {
  const project = await createProject("alpha");
  assert.equal(project.response.status, 201);
  assert.equal(project.body.project.workspacePath, null);

  const userTask = await createTask("alpha", "Created in browser", alice);
  assert.equal(userTask.response.status, 201);
  assert.equal(userTask.body.task.creatorType, "user");
  assert.equal(userTask.body.task.creatorName, alice);
  assert.match(userTask.body.task.creatorId, /^basic:/);

  const agentTask = await cloud.request("/api/tasks", {
    method: "POST",
    actorName: bob,
    headers: { "x-taskboard-client": "taskctl" },
    json: {
      projectId: "alpha",
      title: "Created through taskctl",
      status: "backlog",
      priority: "none",
      labels: [],
    },
  });
  assert.equal(agentTask.response.status, 201);
  assert.equal(agentTask.body.task.creatorType, "agent");
  assert.match(agentTask.body.task.creatorName, /Codex Agent/);
  assert.match(agentTask.body.task.creatorName, /Bob/);
});

test("projects, tasks, comments, and relations preserve the current API contract", async () => {
  const parent = await createTask("alpha", "Parent");
  const child = await createTask("alpha", "Child");
  const relation = await cloud.request(
    `/api/tasks/${child.body.task.id}/relations/parent/${parent.body.task.id}`,
    {
      method: "POST",
      actorName: alice,
      json: { version: child.body.task.version },
    },
  );
  assert.equal(relation.response.status, 200);
  assert.equal(relation.body.task.relations.parent.id, parent.body.task.id);

  const comment = await cloud.request(`/api/tasks/${child.body.task.id}/comments`, {
    method: "POST",
    actorName: bob,
    json: { body: "Review note" },
  });
  assert.equal(comment.response.status, 201);
  assert.equal(comment.body.comment.authorName, bob);

  const listed = await cloud.request("/api/tasks?projectId=alpha&archived=false", {
    actorName: alice,
  });
  assert.equal(listed.response.status, 200);
  assert.ok(listed.body.tasks.some((task) => task.id === child.body.task.id));
});

test("concurrent issue creation has unique identifiers and stale writes return 409", async () => {
  const created = await Promise.all(
    Array.from({ length: 25 }, (_, index) => createTask("alpha", `Concurrent ${index}`)),
  );
  for (const result of created) assert.equal(result.response.status, 201);
  const identifiers = created.map((result) => result.body.task.identifier);
  assert.equal(new Set(identifiers).size, identifiers.length);
  const numbers = identifiers
    .map((identifier) => Number(identifier.slice(identifier.lastIndexOf("-") + 1)))
    .sort((left, right) => left - right);
  numbers.forEach((number, index) => {
    assert.equal(number, numbers[0] + index);
  });

  const task = created[0].body.task;
  const winner = await cloud.request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    actorName: alice,
    json: { version: task.version, title: "Winner" },
  });
  assert.equal(winner.response.status, 200);

  const stale = await cloud.request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    actorName: bob,
    json: { version: task.version, title: "Stale" },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  assert.deepEqual(stale.body.error.details, {
    expectedVersion: task.version,
    actualVersion: winner.body.task.version,
  });
});

test("PATCH moves an issue to an existing project and records the change", async () => {
  await createProject("move-source");
  await createProject("move-target");
  const targetTask = await createTask("move-target", "Target issue", alice, {
    status: "todo",
    sortOrder: 5000,
  });
  assert.equal(targetTask.response.status, 201);
  const sourceTask = await createTask("move-source", "Issue to move", alice, {
    status: "todo",
    sortOrder: 5000,
    threadId: "thread-to-preserve",
  });
  assert.equal(sourceTask.response.status, 201);
  await cloud.db.prepare(`
    UPDATE projects SET updated_at = '2000-01-01T00:00:00.000Z'
    WHERE id IN ('move-source', 'move-target')
  `).run();

  const moved = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    method: "PATCH",
    actorName: bob,
    headers: { "x-taskboard-client": "taskctl" },
    json: {
      version: sourceTask.body.task.version,
      projectId: "move-target",
      threadId: "thread-from-move",
    },
  });

  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.task.projectId, "move-target");
  assert.equal(moved.body.task.status, "todo");
  assert.equal(moved.body.task.sortOrder, sourceTask.body.task.sortOrder);
  assert.equal(moved.body.task.threadId, "thread-to-preserve");
  assert.equal(moved.body.task.version, sourceTask.body.task.version + 1);
  const projects = await cloud.db.prepare(`
    SELECT id, updated_at FROM projects
    WHERE id IN ('move-source', 'move-target')
    ORDER BY id
  `).all();
  assert.deepEqual(
    projects.results.map((project) => project.updated_at),
    [moved.body.task.updatedAt, moved.body.task.updatedAt],
  );

  const activity = await cloud.request(
    `/api/tasks/${sourceTask.body.task.id}/activities`,
    { actorName: alice },
  );
  assert.equal(activity.response.status, 200);
  assert.equal(activity.body.activities.at(-1).actorType, "agent");
  assert.match(activity.body.activities.at(-1).actorName, /Bob/);
  assert.deepEqual(activity.body.activities.at(-1).changes, [{
    field: "projectId",
    before: "move-source",
    after: "move-target",
  }]);

  const stale = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    method: "PATCH",
    actorName: alice,
    json: {
      version: sourceTask.body.task.version,
      projectId: "move-source",
      threadId: "stale-thread",
    },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
});

test("remote thread identity survives controller moves and clears after create failure", async () => {
  await createProject("remote-binding");
  const legacy = await createTask("remote-binding", "Legacy local binding", alice, {
    threadId: "legacy-local-thread",
  });
  assert.equal(legacy.body.task.threadBinding, null);
  assert.equal(legacy.body.task.legacyLocalThreadId, "legacy-local-thread");
  assert.equal(legacy.body.task.conversationRefs[0].legacyLocal, true);
  const binding = {
    threadId: "remote-thread-a",
    codexProjectId: "remote-project-a",
    codexProjectKind: "remote",
    codexHostId: "ssh-a",
    workspacePath: "/same/remote/path",
  };
  const created = await createTask("remote-binding", "Remote binding", alice, {
    status: "todo",
    threadId: binding.threadId,
    threadBinding: binding,
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.task.threadBinding, binding);

  const comment = await cloud.request(`/api/tasks/${created.body.task.id}/comments`, {
    method: "POST",
    actorName: bob,
    headers: { "x-taskboard-client": "taskctl" },
    json: { body: "Controller note", threadId: "controller-thread" },
  });
  assert.equal(comment.body.comment.threadBinding, null);
  assert.equal(comment.body.comment.legacyLocalThreadId, "controller-thread");

  const blocked = await cloud.request(`/api/tasks/${created.body.task.id}/move`, {
    method: "POST",
    actorName: bob,
    headers: { "x-taskboard-client": "taskctl" },
    json: {
      version: created.body.task.version,
      status: "blocked",
      threadId: "controller-thread",
      threadBinding: binding,
    },
  });
  assert.equal(blocked.response.status, 200, JSON.stringify(blocked.body));
  assert.deepEqual(blocked.body.task.threadBinding, binding);
  assert.deepEqual(blocked.body.task.conversationRefs.map((ref) => ref.threadId), [
    binding.threadId,
    "controller-thread",
  ]);

  const todo = await cloud.request(`/api/tasks/${created.body.task.id}/move`, {
    method: "POST",
    actorName: bob,
    headers: { "x-taskboard-client": "taskctl" },
    json: {
      version: blocked.body.task.version,
      status: "todo",
      threadId: "controller-thread",
      threadBinding: null,
    },
  });
  assert.equal(todo.response.status, 200, JSON.stringify(todo.body));
  assert.equal(todo.body.task.threadId, null);
  assert.equal(todo.body.task.threadBinding, null);
  assert.deepEqual(todo.body.task.conversationRefs.map((ref) => ref.threadId), ["controller-thread"]);
});

test("local thread bindings never expose the creator's workspace path, remote bindings still do", async () => {
  await createProject("thread-binding-privacy");
  const localBinding = {
    threadId: "local-thread-a",
    codexProjectId: "local-project-a",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath: "/Users/alice/secret-project",
  };
  const created = await createTask("thread-binding-privacy", "Local binding", alice, {
    threadId: localBinding.threadId,
    threadBinding: localBinding,
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  // Even the actor who set the binding never gets the local workspace path back.
  assert.equal(created.body.task.threadBinding.workspacePath, null);
  assert.equal(created.body.task.threadBinding.codexHostId, "local");
  assert.equal(created.body.task.threadBinding.threadId, localBinding.threadId);
  assert.equal(created.body.task.threadBinding.codexProjectId, localBinding.codexProjectId);
  assert.equal(created.body.task.conversationRefs[0].workspacePath, null);

  const commentWithLocalBinding = await cloud.request(
    `/api/tasks/${created.body.task.id}/comments`,
    {
      method: "POST",
      actorName: bob,
      json: {
        body: "Local comment thread",
        threadBinding: { ...localBinding, threadId: "local-thread-comment" },
      },
    },
  );
  assert.equal(
    commentWithLocalBinding.response.status,
    201,
    JSON.stringify(commentWithLocalBinding.body),
  );
  assert.equal(commentWithLocalBinding.body.comment.threadBinding.workspacePath, null);

  // A different collaborator reading the task afterwards still sees no workspace path,
  // for either the task's own binding or the comment's.
  const readByOther = await cloud.request(`/api/tasks/${created.body.task.id}`, {
    actorName: bob,
  });
  assert.equal(readByOther.response.status, 200);
  assert.equal(readByOther.body.task.threadBinding.workspacePath, null);
  assert.equal(readByOther.body.task.conversationRefs.length, 2);
  assert.ok(readByOther.body.task.conversationRefs.every((ref) => ref.workspacePath === null));

  // Remote bindings keep their real host/workspace identity for every viewer: the
  // web client needs those values, for any project collaborator, to detect whether
  // an SSH remote thread can be reopened from that viewer's own device.
  const remoteBinding = {
    threadId: "remote-thread-privacy",
    codexProjectId: "remote-project-privacy",
    codexProjectKind: "remote",
    codexHostId: "ssh-shared-box",
    workspacePath: "/srv/shared/privacy-project",
  };
  const remoteCreated = await createTask("thread-binding-privacy", "Remote binding", alice, {
    threadId: remoteBinding.threadId,
    threadBinding: remoteBinding,
  });
  assert.equal(remoteCreated.response.status, 201, JSON.stringify(remoteCreated.body));
  const remoteReadByOther = await cloud.request(`/api/tasks/${remoteCreated.body.task.id}`, {
    actorName: bob,
  });
  assert.equal(remoteReadByOther.response.status, 200);
  assert.deepEqual(remoteReadByOther.body.task.threadBinding, remoteBinding);
});

test("PATCH rejects moving an issue that still has relations", async () => {
  await createProject("move-related-cloud-source");
  await createProject("move-related-cloud-target");
  const sourceTask = await createTask(
    "move-related-cloud-source",
    "Cloud related source",
  );
  const relatedTask = await createTask(
    "move-related-cloud-source",
    "Cloud related peer",
  );
  const linked = await cloud.request(
    `/api/tasks/${sourceTask.body.task.id}/relations/related/${relatedTask.body.task.id}`,
    {
      method: "POST",
      actorName: alice,
      json: { version: sourceTask.body.task.version },
    },
  );
  assert.equal(linked.response.status, 200);

  const rejected = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    method: "PATCH",
    actorName: alice,
    json: {
      version: linked.body.task.version,
      projectId: "move-related-cloud-target",
    },
  });

  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, "CROSS_PROJECT_RELATION");
  const unchanged = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    actorName: alice,
  });
  assert.equal(unchanged.body.task.projectId, "move-related-cloud-source");
  assert.equal(unchanged.body.task.version, linked.body.task.version);
  assert.deepEqual(
    unchanged.body.task.relations.related.map((task) => task.id),
    [relatedTask.body.task.id],
  );
});

test("PATCH project and status updates use the target status ordering", async () => {
  await createProject("move-sort-source-cloud");
  await createProject("move-sort-target-cloud");
  await createTask("move-sort-target-cloud", "Cloud target first", alice, {
    status: "done",
    sortOrder: 5000,
  });
  await createTask("move-sort-target-cloud", "Cloud target second", alice, {
    status: "done",
    sortOrder: 7000,
  });
  const sourceTask = await createTask(
    "move-sort-source-cloud",
    "Cloud move and complete",
    alice,
    { status: "todo", sortOrder: 9000 },
  );

  const moved = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    method: "PATCH",
    actorName: alice,
    json: {
      version: sourceTask.body.task.version,
      projectId: "move-sort-target-cloud",
      status: "done",
    },
  });

  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.task.projectId, "move-sort-target-cloud");
  assert.equal(moved.body.task.status, "done");
  assert.equal(moved.body.task.sortOrder, 4000);
});

test("PATCH rejects moving an issue to a project that does not exist", async () => {
  await createProject("missing-target-source");
  const sourceTask = await createTask(
    "missing-target-source",
    "Issue that stays in source",
    alice,
    { threadId: "unchanged-thread" },
  );
  assert.equal(sourceTask.response.status, 201);

  const rejected = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    method: "PATCH",
    actorName: alice,
    json: {
      version: sourceTask.body.task.version,
      projectId: "missing-target",
      threadId: "rejected-thread",
    },
  });

  assert.equal(rejected.response.status, 404);
  assert.equal(rejected.body.error.code, "PROJECT_NOT_FOUND");
  const unchanged = await cloud.request(`/api/tasks/${sourceTask.body.task.id}`, {
    actorName: alice,
  });
  assert.equal(unchanged.body.task.projectId, "missing-target-source");
  assert.equal(unchanged.body.task.threadId, "unchanged-thread");
  assert.equal(unchanged.body.task.version, sourceTask.body.task.version);
});

test("a failed task insert rolls back its reserved project identifier", async () => {
  await createProject("atomic-counter");
  await cloud.db.exec(
    "CREATE TRIGGER fail_task_insert BEFORE INSERT ON tasks WHEN NEW.title = 'Fail counter' BEGIN SELECT RAISE(ABORT, 'intentional task insert failure'); END;",
  );
  const failed = await createTask("atomic-counter", "Fail counter");
  assert.equal(failed.response.status, 500);

  const counter = await cloud.db.prepare(
    "SELECT next_task_number FROM projects WHERE id = 'atomic-counter'",
  ).first("next_task_number");
  assert.equal(counter, 1);

  const succeeded = await createTask("atomic-counter", "First real issue");
  assert.equal(succeeded.response.status, 201);
  assert.equal(succeeded.body.task.identifier, "ATO-1");
});

test("archived tasks are excluded from project issue counts", async () => {
  const project = await createProject("archive-count");
  assert.equal(project.response.status, 201);
  const task = await createTask("archive-count", "Archive me");
  const before = await cloud.request("/api/projects", { actorName: alice });
  assert.equal(
    before.body.projects.find((candidate) => candidate.id === "archive-count").issueCount,
    1,
  );

  const archived = await cloud.request(`/api/tasks/${task.body.task.id}/archive`, {
    method: "POST",
    actorName: alice,
    json: { version: task.body.task.version },
  });
  assert.equal(archived.response.status, 200);
  const after = await cloud.request("/api/projects", { actorName: alice });
  assert.equal(
    after.body.projects.find((candidate) => candidate.id === "archive-count").issueCount,
    0,
  );
});

test("R2 attachment upload, download, delete, and D1 failure compensation form one closed lifecycle", async () => {
  const task = await createTask("alpha", "Attachment owner");
  const uploaded = await cloud.request(`/api/tasks/${task.body.task.id}/attachments`, {
    method: "POST",
    actorName: alice,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("evidence.txt"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "attachment body",
  });
  assert.equal(uploaded.response.status, 201);
  const attachment = uploaded.body.attachment;
  const downloaded = await cloud.request(`/api/attachments/${attachment.id}/content`, {
    actorName: bob,
  });
  assert.equal(downloaded.response.status, 200);
  assert.equal(downloaded.body, "attachment body");

  const deleted = await cloud.request(`/api/attachments/${attachment.id}`, {
    method: "DELETE",
    actorName: alice,
  });
  assert.equal(deleted.response.status, 204);
  assert.equal((await cloud.listAttachmentKeys()).length, 0);

  await cloud.db.exec(
    "CREATE TRIGGER fail_attachment_insert BEFORE INSERT ON attachments WHEN NEW.filename = 'fail.txt' BEGIN SELECT RAISE(ABORT, 'intentional attachment metadata failure'); END;",
  );
  const beforeKeys = await cloud.listAttachmentKeys();
  const failed = await cloud.request(`/api/tasks/${task.body.task.id}/attachments`, {
    method: "POST",
    actorName: alice,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("fail.txt"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "must be compensated",
  });
  assert.equal(failed.response.status, 500);
  assert.deepEqual(await cloud.listAttachmentKeys(), beforeKeys);
});

test("permanent task deletion requires archiving and cleans D1 and R2", async () => {
  await createProject("temp-cloud-delete");
  const created = await createTask("temp-cloud-delete", "Delete permanently");
  const task = created.body.task;
  const keysBefore = await cloud.listAttachmentKeys();
  const uploaded = await cloud.request(`/api/tasks/${task.id}/attachments`, {
    method: "POST",
    actorName: alice,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": "evidence.txt",
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "attachment",
  });
  assert.equal(uploaded.response.status, 201);
  const comment = await cloud.request(`/api/tasks/${task.id}/comments`, {
    method: "POST",
    actorName: alice,
    json: { body: "Comment with attachment" },
  });
  assert.equal(comment.response.status, 201);
  const commentUpload = await cloud.request(
    `/api/comments/${comment.body.comment.id}/attachments`,
    {
      method: "POST",
      actorName: alice,
      headers: {
        "content-type": "text/plain",
        "x-taskboard-filename": "comment-evidence.txt",
        "x-taskboard-attachment-kind": "attachment",
      },
      body: "comment attachment",
    },
  );
  assert.equal(commentUpload.response.status, 201);
  const attachmentIds = [uploaded.body.attachment.id, commentUpload.body.attachment.id];
  const keysAfterUpload = await cloud.listAttachmentKeys();
  for (const attachmentId of attachmentIds) {
    assert.ok(keysAfterUpload.includes(attachmentId));
  }

  const activeDelete = await cloud.request(`/api/tasks/${task.id}`, {
    method: "DELETE",
    actorName: alice,
    json: { version: task.version },
  });
  assert.equal(activeDelete.response.status, 409);
  assert.equal(activeDelete.body.error.code, "TASK_NOT_ARCHIVED");

  const archived = await cloud.request(`/api/tasks/${task.id}/archive`, {
    method: "POST",
    actorName: alice,
    json: { version: task.version },
  });
  const deleted = await cloud.request(`/api/tasks/${task.id}`, {
    method: "DELETE",
    actorName: alice,
    json: { version: archived.body.task.version },
  });
  assert.equal(deleted.response.status, 204);
  assert.deepEqual(await cloud.listAttachmentKeys(), keysBefore);
  assert.equal((await cloud.request(`/api/tasks/${task.id}`, { actorName: alice })).response.status, 404);
  assert.equal(
    await cloud.db.prepare("SELECT 1 FROM tasks WHERE id = ?").bind(task.id).first(),
    null,
  );
  assert.equal(
    await cloud.db.prepare("SELECT 1 FROM comments WHERE id = ?")
      .bind(comment.body.comment.id).first(),
    null,
  );
  const remainingAttachments = await cloud.db.prepare(`
    SELECT id FROM attachments WHERE id IN (?, ?)
  `).bind(...attachmentIds).all();
  assert.deepEqual(remainingAttachments.results, []);
  assert.equal((await cloud.request("/api/projects/temp-cloud-delete", {
    method: "DELETE",
    actorName: alice,
  })).response.status, 204);
});

test("deleting an empty project also cleans up its R2 README attachment", async () => {
  await createProject("temp-readme-delete");
  const uploaded = await cloud.request("/api/projects/temp-readme-delete/readme/attachments", {
    method: "POST",
    actorName: alice,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": "readme-evidence.txt",
      "x-taskboard-attachment-kind": "inline",
    },
    body: "readme attachment",
  });
  assert.equal(uploaded.response.status, 201);
  const attachmentId = uploaded.body.attachment.id;
  assert.ok((await cloud.listAttachmentKeys()).includes(attachmentId));

  const deleted = await cloud.request("/api/projects/temp-readme-delete", {
    method: "DELETE",
    actorName: alice,
  });
  assert.equal(deleted.response.status, 204);

  assert.equal(
    await cloud.db.prepare("SELECT 1 FROM project_readme_attachments WHERE id = ?")
      .bind(attachmentId).first(),
    null,
  );
  assert.equal(await cloud.attachments.get(attachmentId), null);
  assert.ok(!(await cloud.listAttachmentKeys()).includes(attachmentId));
});

test("migration 0012 adds attachment_revision counters and bump triggers on the attachment tables", async () => {
  const triggers = await cloud.db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%bump_revision%'
    ORDER BY name
  `).all();
  assert.deepEqual(triggers.results.map((row) => row.name), [
    "attachments_bump_revision_delete",
    "attachments_bump_revision_insert",
    "project_readme_attachments_bump_revision_delete",
    "project_readme_attachments_bump_revision_insert",
  ]);
  const projectColumns = await cloud.db.prepare("PRAGMA table_info(projects)").all();
  assert.ok(projectColumns.results.some((column) => column.name === "attachment_revision"));
  const taskColumns = await cloud.db.prepare("PRAGMA table_info(tasks)").all();
  assert.ok(taskColumns.results.some((column) => column.name === "attachment_revision"));
});

test("attachment table INSERT/DELETE advances the owning resource's attachment_revision, and cascading owner deletion is a safe no-op", async () => {
  await createProject("temp-revision-project");
  const created = await createTask("temp-revision-project", "Revision counter task");
  const task = created.body.task;

  async function projectRevision(id) {
    return Number(
      await cloud.db.prepare("SELECT attachment_revision FROM projects WHERE id = ?")
        .bind(id).first("attachment_revision"),
    );
  }
  async function taskRevision(id) {
    return Number(
      await cloud.db.prepare("SELECT attachment_revision FROM tasks WHERE id = ?")
        .bind(id).first("attachment_revision"),
    );
  }

  const projectRevisionBefore = await projectRevision("temp-revision-project");
  const readmeAttachmentId = `revtest-readme-${randomUUID()}`;
  await cloud.db.prepare(`
    INSERT INTO project_readme_attachments (id, project_id, filename, content_type, size, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(readmeAttachmentId, "temp-revision-project", "revtest.txt", "text/plain", 4, new Date().toISOString())
    .run();
  assert.equal(await projectRevision("temp-revision-project"), projectRevisionBefore + 1);
  await cloud.db.prepare("DELETE FROM project_readme_attachments WHERE id = ?")
    .bind(readmeAttachmentId).run();
  assert.equal(await projectRevision("temp-revision-project"), projectRevisionBefore + 2);

  const taskRevisionBefore = await taskRevision(task.id);
  const taskAttachmentId = `revtest-attachment-${randomUUID()}`;
  await cloud.db.prepare(`
    INSERT INTO attachments (id, task_id, comment_id, kind, filename, content_type, size, created_at)
    VALUES (?, ?, NULL, 'attachment', ?, ?, ?, ?)
  `).bind(taskAttachmentId, task.id, "revtest.txt", "text/plain", 4, new Date().toISOString()).run();
  assert.equal(await taskRevision(task.id), taskRevisionBefore + 1);
  await cloud.db.prepare("DELETE FROM attachments WHERE id = ?").bind(taskAttachmentId).run();
  assert.equal(await taskRevision(task.id), taskRevisionBefore + 2);

  // Cascade safety: deleting the owner row itself while it still has attachment rows must not
  // throw, even though the trigger's UPDATE targets a project/task row that no longer exists by
  // the time the trigger body runs (AFTER DELETE fires after the owner row is already gone).
  await createProject("temp-revision-cascade-project");
  await cloud.db.prepare(`
    INSERT INTO project_readme_attachments (id, project_id, filename, content_type, size, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    `revtest-cascade-readme-${randomUUID()}`,
    "temp-revision-cascade-project",
    "cascade.txt",
    "text/plain",
    4,
    new Date().toISOString(),
  ).run();
  await assert.doesNotReject(
    cloud.db.prepare("DELETE FROM projects WHERE id = ?").bind("temp-revision-cascade-project").run(),
  );

  const cascadeTaskCreated = await createTask("temp-revision-project", "Cascade task");
  const cascadeTask = cascadeTaskCreated.body.task;
  await cloud.db.prepare(`
    INSERT INTO attachments (id, task_id, comment_id, kind, filename, content_type, size, created_at)
    VALUES (?, ?, NULL, 'attachment', ?, ?, ?, ?)
  `).bind(
    `revtest-cascade-attachment-${randomUUID()}`,
    cascadeTask.id,
    "cascade.txt",
    "text/plain",
    4,
    new Date().toISOString(),
  ).run();
  await assert.doesNotReject(
    cloud.db.prepare("DELETE FROM tasks WHERE id = ?").bind(cascadeTask.id).run(),
  );
});

test("deleteProject() rejects a net-zero concurrent attachment change (one delete, one upload) instead of orphaning the new attachment in R2", async () => {
  let raceCloud;
  let attachmentAId;
  let newAttachmentId;
  raceCloud = await createCloudWorkerHarness({
    serviceBindings: {
      async RACE_TEST_HOOK() {
        await raceCloud.request(`/api/attachments/${attachmentAId}`, {
          method: "DELETE",
          actorName: alice,
        });
        const uploaded = await raceCloud.request(
          "/api/projects/temp-race-project/readme/attachments",
          {
            method: "POST",
            actorName: alice,
            headers: {
              "content-type": "text/plain",
              "x-taskboard-filename": "race-new.txt",
              "x-taskboard-attachment-kind": "inline",
            },
            body: "race new attachment",
          },
        );
        newAttachmentId = uploaded.body.attachment.id;
        return new Response("ok");
      },
    },
  });
  try {
    await raceCloud.request("/api/projects", {
      method: "POST",
      actorName: alice,
      json: { id: "temp-race-project", name: "RACE", workspacePath: "/x/temp-race-project" },
    });
    const uploadedA = await raceCloud.request("/api/projects/temp-race-project/readme/attachments", {
      method: "POST",
      actorName: alice,
      headers: {
        "content-type": "text/plain",
        "x-taskboard-filename": "race-a.txt",
        "x-taskboard-attachment-kind": "inline",
      },
      body: "race attachment a",
    });
    attachmentAId = uploadedA.body.attachment.id;

    const deleted = await raceCloud.request("/api/projects/temp-race-project", {
      method: "DELETE",
      actorName: alice,
    });
    assert.equal(deleted.response.status, 409);
    assert.equal(deleted.body.error.code, "PROJECT_ATTACHMENTS_CHANGED");
    assert.ok(newAttachmentId, "race hook should have uploaded a new attachment");
    assert.notEqual(
      await raceCloud.db.prepare("SELECT 1 FROM project_readme_attachments WHERE id = ?")
        .bind(newAttachmentId).first(),
      null,
    );
    assert.notEqual(await raceCloud.attachments.get(newAttachmentId), null);
    assert.notEqual(
      await raceCloud.db.prepare("SELECT 1 FROM projects WHERE id = ?")
        .bind("temp-race-project").first(),
      null,
    );
  } finally {
    await raceCloud.dispose();
  }
});

test("deleteArchivedTask() rejects a net-zero concurrent attachment change (one delete, one upload) instead of orphaning the new attachment in R2", async () => {
  let raceCloud;
  let attachmentAId;
  let newAttachmentId;
  let taskId;
  raceCloud = await createCloudWorkerHarness({
    serviceBindings: {
      async RACE_TEST_HOOK() {
        await raceCloud.request(`/api/attachments/${attachmentAId}`, {
          method: "DELETE",
          actorName: alice,
        });
        const uploaded = await raceCloud.request(`/api/tasks/${taskId}/attachments`, {
          method: "POST",
          actorName: alice,
          headers: {
            "content-type": "text/plain",
            "x-taskboard-filename": "race-new.txt",
            "x-taskboard-attachment-kind": "attachment",
          },
          body: "race new attachment",
        });
        newAttachmentId = uploaded.body.attachment.id;
        return new Response("ok");
      },
    },
  });
  try {
    await raceCloud.request("/api/projects", {
      method: "POST",
      actorName: alice,
      json: { id: "temp-race-task", name: "RACE TASK", workspacePath: "/x/race-task" },
    });
    const created = await raceCloud.request("/api/tasks", {
      method: "POST",
      actorName: alice,
      json: {
        projectId: "temp-race-task",
        title: "race task",
        description: "",
        status: "backlog",
        priority: "none",
        labels: [],
      },
    });
    taskId = created.body.task.id;
    const uploadedA = await raceCloud.request(`/api/tasks/${taskId}/attachments`, {
      method: "POST",
      actorName: alice,
      headers: {
        "content-type": "text/plain",
        "x-taskboard-filename": "race-a.txt",
        "x-taskboard-attachment-kind": "attachment",
      },
      body: "race attachment a",
    });
    attachmentAId = uploadedA.body.attachment.id;

    const archived = await raceCloud.request(`/api/tasks/${taskId}/archive`, {
      method: "POST",
      actorName: alice,
      json: { version: created.body.task.version },
    });
    assert.equal(archived.response.status, 200);

    const deleted = await raceCloud.request(`/api/tasks/${taskId}`, {
      method: "DELETE",
      actorName: alice,
      json: { version: archived.body.task.version },
    });
    assert.equal(deleted.response.status, 409);
    assert.equal(deleted.body.error.code, "TASK_ATTACHMENTS_CHANGED");
    assert.ok(newAttachmentId, "race hook should have uploaded a new attachment");
    assert.notEqual(
      await raceCloud.db.prepare("SELECT 1 FROM attachments WHERE id = ?")
        .bind(newAttachmentId).first(),
      null,
    );
    assert.notEqual(await raceCloud.attachments.get(newAttachmentId), null);
    assert.equal(
      (await raceCloud.request(`/api/tasks/${taskId}`, { actorName: alice })).response.status,
      200,
    );
  } finally {
    await raceCloud.dispose();
  }
});

test("uploadAttachment/uploadProjectReadmeAttachment/deleteAttachment/deleteComment each advance the owning resource's attachment_revision without any code changes of their own (Fix-then-Audit)", async () => {
  await createProject("temp-audit-project");
  const created = await createTask("temp-audit-project", "Audit task");
  const task = created.body.task;

  async function taskRevision(id) {
    return Number(
      await cloud.db.prepare("SELECT attachment_revision FROM tasks WHERE id = ?")
        .bind(id).first("attachment_revision"),
    );
  }
  async function projectRevision(id) {
    return Number(
      await cloud.db.prepare("SELECT attachment_revision FROM projects WHERE id = ?")
        .bind(id).first("attachment_revision"),
    );
  }

  // uploadAttachment(): POST /api/tasks/:id/attachments
  const taskRevBeforeUpload = await taskRevision(task.id);
  const uploaded = await cloud.request(`/api/tasks/${task.id}/attachments`, {
    method: "POST",
    actorName: alice,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": "audit-task.txt",
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "audit attachment",
  });
  assert.equal(uploaded.response.status, 201);
  assert.equal(await taskRevision(task.id), taskRevBeforeUpload + 1);

  // uploadProjectReadmeAttachment(): POST /api/projects/:id/readme/attachments
  const projectRevBeforeUpload = await projectRevision("temp-audit-project");
  const uploadedReadme = await cloud.request(
    "/api/projects/temp-audit-project/readme/attachments",
    {
      method: "POST",
      actorName: alice,
      headers: {
        "content-type": "text/plain",
        "x-taskboard-filename": "audit-readme.txt",
        "x-taskboard-attachment-kind": "inline",
      },
      body: "audit readme attachment",
    },
  );
  assert.equal(uploadedReadme.response.status, 201);
  assert.equal(await projectRevision("temp-audit-project"), projectRevBeforeUpload + 1);
  // Deleted immediately (rather than left for deleteProject() to clean up) so this test doesn't
  // leave an orphaned R2 object behind for later tests that assert an empty shared bucket.
  const deletedReadme = await cloud.request(
    `/api/attachments/${uploadedReadme.body.attachment.id}`,
    { method: "DELETE", actorName: alice },
  );
  assert.equal(deletedReadme.response.status, 204);

  // deleteAttachment(): DELETE /api/attachments/:id
  const taskRevBeforeDelete = await taskRevision(task.id);
  const deletedAttachment = await cloud.request(
    `/api/attachments/${uploaded.body.attachment.id}`,
    { method: "DELETE", actorName: alice },
  );
  assert.equal(deletedAttachment.response.status, 204);
  assert.equal(await taskRevision(task.id), taskRevBeforeDelete + 1);

  // deleteComment(): DELETE /api/comments/:id, cascading through attachments.comment_id
  const comment = await cloud.request(`/api/tasks/${task.id}/comments`, {
    method: "POST",
    actorName: alice,
    json: { body: "Comment with an attachment" },
  });
  assert.equal(comment.response.status, 201);
  const commentUpload = await cloud.request(
    `/api/comments/${comment.body.comment.id}/attachments`,
    {
      method: "POST",
      actorName: alice,
      headers: {
        "content-type": "text/plain",
        "x-taskboard-filename": "audit-comment.txt",
        "x-taskboard-attachment-kind": "attachment",
      },
      body: "audit comment attachment",
    },
  );
  assert.equal(commentUpload.response.status, 201);
  const taskRevBeforeCommentDelete = await taskRevision(task.id);
  const deletedComment = await cloud.request(`/api/comments/${comment.body.comment.id}`, {
    method: "DELETE",
    actorName: alice,
    json: { version: comment.body.comment.version },
  });
  assert.equal(deletedComment.response.status, 204);
  assert.equal(await taskRevision(task.id), taskRevBeforeCommentDelete + 1);
});

test("the global revision is monotonic and lets clients poll only when data changed", async () => {
  const initial = await cloud.request("/api/revisions?since=0", { actorName: alice });
  assert.equal(initial.response.status, 200);
  const baseline = initial.body.revision;

  const unchanged = await cloud.request(`/api/revisions?since=${baseline}`, {
    actorName: alice,
  });
  assert.equal(unchanged.body.changed, false);

  await createTask("alpha", "Revision mutation");
  const changed = await cloud.request(`/api/revisions?since=${baseline}`, {
    actorName: bob,
  });
  assert.equal(changed.body.changed, true);
  assert.ok(changed.body.revision > baseline);

  const current = await cloud.request(`/api/revisions?since=${changed.body.revision}`, {
    actorName: alice,
  });
  assert.equal(current.body.changed, false);
});

test("authenticated WebSockets receive a revision only after business data changes", async () => {
  const unauthorized = await cloud.connectWebSocket();
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.socket, null);

  const { response, socket } = await cloud.connectWebSocket("/api/events", {
    actorName: alice,
  });
  assert.equal(response.status, 101);
  assert.ok(socket);

  const message = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for revision push")), 1_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(event.data));
    }, { once: true });
  });
  const created = await createTask("alpha", "WebSocket revision mutation", bob);
  assert.equal(created.response.status, 201);
  const payload = await message;
  assert.equal(payload.type, "revision");
  assert.ok(Number.isSafeInteger(payload.revision));
  socket.close(1000, "test complete");
});

test("browser session cookie authenticates API reads and WebSocket reconnects", async () => {
  const login = await cloud.request("/api/meta", { actorName: alice });
  assert.equal(login.response.status, 200);
  const setCookie = login.response.headers.get("set-cookie");
  assert.match(setCookie, /^__Host-taskboard_session=/);
  assert.match(setCookie, /; HttpOnly; Secure; SameSite=Strict$/);
  const cookie = setCookie.split(";", 1)[0];

  const projects = await cloud.request("/api/projects", {
    headers: { cookie },
  });
  assert.equal(projects.response.status, 200);

  const { response, socket } = await cloud.connectWebSocket("/api/events", { cookie });
  assert.equal(response.status, 101);
  assert.ok(socket);
  socket.close(1000, "cookie authentication test complete");
});

test("cloud-only local capability routes return an explicit companion requirement", async () => {
  const meta = await cloud.request("/api/meta", { actorName: alice });
  assert.equal(meta.response.status, 200);
  assert.equal(meta.body.mode, "cloud");
  assert.deepEqual(meta.body.realtime, {
    transport: "websocket",
    endpoint: "/api/events",
  });
  assert.equal(meta.body.localCapabilities.available, false);

  for (const pathname of [
    "/api/device-workspaces",
    "/api/projects/alpha/development-contexts",
  ]) {
    const result = await cloud.request(pathname, { actorName: alice });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error.code, "LOCAL_COMPANION_REQUIRED");
  }
});

test("task lifecycle keeps optimistic versions and never persists a worktree path", async () => {
  await createProject("task-lifecycle");
  const created = await createTask("task-lifecycle", "Lifecycle", alice, {
    developmentContext: { type: "worktree", branch: "feature/shared" },
  });
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.body.task.developmentContext, {
    type: "worktree",
    path: null,
    branch: "feature/shared",
  });

  const moved = await cloud.request(`/api/tasks/${created.body.task.id}/move`, {
    method: "POST",
    actorName: alice,
    json: {
      version: created.body.task.version,
      status: "in_progress",
    },
  });
  assert.equal(moved.response.status, 200);
  assert.equal(moved.body.task.status, "in_progress");

  const archived = await cloud.request(`/api/tasks/${created.body.task.id}/archive`, {
    method: "POST",
    actorName: alice,
    json: { version: moved.body.task.version },
  });
  assert.equal(archived.response.status, 200);
  assert.ok(archived.body.task.archivedAt);

  const restored = await cloud.request(`/api/tasks/${created.body.task.id}/restore`, {
    method: "POST",
    actorName: alice,
    json: { version: archived.body.task.version },
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.task.archivedAt, null);
});

test("relation direction, deletion, and parent-cycle checks match the local contract", async () => {
  await createProject("relation-parity");
  const blocker = await createTask("relation-parity", "Blocker");
  const blocked = await createTask("relation-parity", "Blocked");
  const blockedBy = await cloud.request(
    `/api/tasks/${blocked.body.task.id}/relations/blocked_by/${blocker.body.task.id}`,
    {
      method: "POST",
      actorName: alice,
      json: { version: blocked.body.task.version },
    },
  );
  assert.equal(blockedBy.response.status, 200);
  assert.equal(blockedBy.body.task.relations.blockedBy[0].id, blocker.body.task.id);
  assert.equal(blockedBy.body.relatedTask.relations.blocks[0].id, blocked.body.task.id);

  const removed = await cloud.request(
    `/api/tasks/${blocked.body.task.id}/relations/blocked_by/${blocker.body.task.id}`,
    {
      method: "DELETE",
      actorName: alice,
      json: { version: blockedBy.body.task.version },
    },
  );
  assert.equal(removed.response.status, 200);
  assert.deepEqual(removed.body.task.relations.blockedBy, []);

  const child = await createTask("relation-parity", "Child");
  const parent = await cloud.request(
    `/api/tasks/${child.body.task.id}/relations/parent/${blocker.body.task.id}`,
    {
      method: "POST",
      actorName: alice,
      json: { version: child.body.task.version },
    },
  );
  assert.equal(parent.response.status, 200);
  const cycle = await cloud.request(
    `/api/tasks/${blocker.body.task.id}/relations/parent/${child.body.task.id}`,
    {
      method: "POST",
      actorName: alice,
      json: { version: blocker.body.task.version },
    },
  );
  assert.equal(cycle.response.status, 409);
  assert.equal(cycle.body.error.code, "RELATION_CYCLE");
});

test("tree queries keep direct and nested ancestor/descendant traversal in cloud parity", async () => {
  const projectId = "tree-cloud-parity";
  await createProject(projectId);
  const root = await createTask(projectId, "Tree root");
  const child = await createTask(projectId, "Tree child");
  const sibling = await createTask(projectId, "Tree sibling");
  const grandchild = await createTask(projectId, "Tree grandchild");
  const addParent = async (childTask, parentTask) => cloud.request(
    `/api/tasks/${childTask.id}/relations/parent/${parentTask.id}`,
    { method: "POST", actorName: alice, json: { version: childTask.version } },
  );
  for (const [childTask, parentTask] of [
    [child.body.task, root.body.task],
    [sibling.body.task, root.body.task],
    [grandchild.body.task, child.body.task],
  ]) {
    assert.equal((await addParent(childTask, parentTask)).response.status, 200);
  }

  const direct = await cloud.request(
    `/api/tasks/${root.body.task.id}/tree?direction=descendants&depth=1`,
    { actorName: alice },
  );
  assert.equal(direct.response.status, 200);
  assert.deepEqual(direct.body.tree.nodes.map((node) => [node.id, node.parentId, node.depth]), [
    [root.body.task.id, null, 0],
    [child.body.task.id, root.body.task.id, 1],
    [sibling.body.task.id, root.body.task.id, 1],
  ]);

  const descendants = await cloud.request(
    `/api/tasks/${root.body.task.id}/tree?direction=descendants&depth=2`,
    { actorName: alice },
  );
  assert.equal(descendants.body.tree.nodeCount, 4);
  assert.deepEqual(descendants.body.tree.nodes.at(-1).path, [
    root.body.task.id,
    child.body.task.id,
    grandchild.body.task.id,
  ]);

  const ancestors = await cloud.request(
    `/api/tasks/${grandchild.body.task.id}/tree?direction=ancestors&depth=2`,
    { actorName: alice },
  );
  assert.equal(ancestors.response.status, 200);
  assert.deepEqual(ancestors.body.tree.nodes.map((node) => [node.id, node.parentId, node.depth]), [
    [grandchild.body.task.id, null, 0],
    [child.body.task.id, grandchild.body.task.id, 1],
    [root.body.task.id, child.body.task.id, 2],
  ]);

  const invalid = await cloud.request(
    `/api/tasks/${root.body.task.id}/tree?direction=descendants&depth=0`,
    { actorName: alice },
  );
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, "INVALID_TREE_QUERY");
});

test("cloud tree handles a 101-node frontier at depth 2", async () => {
  const projectId = "tree-cloud-frontier";
  await createProject(projectId);
  const root = await createTask(projectId, "Tree frontier root");
  const timestamp = new Date().toISOString();

  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 101
    )
    INSERT INTO tasks (
      id, identifier, project_id, title, description, status, priority, labels, sort_order,
      creator_type, creator_id, creator_name,
      assignee_type, assignee_id, assignee_name,
      version, created_at, updated_at
    )
    SELECT
      'tree-frontier-child-' || value,
      'TREEFRONTIER-' || value,
      ?,
      'Tree frontier child',
      '',
      'backlog',
      'none',
      '[]',
      value,
      'user',
      'tree-frontier-fixture',
      'Tree frontier fixture',
      'user',
      'tree-frontier-fixture',
      'Tree frontier fixture',
      1,
      ?,
      ?
    FROM sequence
  `).bind(projectId, timestamp, timestamp).run();
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 101
    )
    INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at)
    SELECT 'parent', ?, 'tree-frontier-child-' || value, ?
    FROM sequence
  `).bind(root.body.task.id, timestamp).run();

  const result = await cloud.request(
    `/api/tasks/${root.body.task.id}/tree?direction=descendants&depth=2`,
    { actorName: alice },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.tree.nodeCount, 102);
});

test("cloud tree rejects a breadth that exceeds the 1,000-node cap", async () => {
  const projectId = "tree-cloud-cap";
  await createProject(projectId);
  const root = await createTask(projectId, "Tree cap root");
  const timestamp = new Date().toISOString();

  // A recursive CTE keeps this cap fixture to two D1 writes instead of 1,000 API mutations.
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 1000
    )
    INSERT INTO tasks (
      id, identifier, project_id, title, description, status, priority, labels, sort_order,
      creator_type, creator_id, creator_name,
      assignee_type, assignee_id, assignee_name,
      version, created_at, updated_at
    )
    SELECT
      'tree-cap-child-' || value,
      'TREECAP-' || value,
      ?,
      'Tree cap child',
      '',
      'backlog',
      'none',
      '[]',
      value,
      'user',
      'tree-cap-fixture',
      'Tree cap fixture',
      'user',
      'tree-cap-fixture',
      'Tree cap fixture',
      1,
      ?,
      ?
    FROM sequence
  `).bind(projectId, timestamp, timestamp).run();
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 1000
    )
    INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at)
    SELECT 'parent', ?, 'tree-cap-child-' || value, ?
    FROM sequence
  `).bind(root.body.task.id, timestamp).run();

  const result = await cloud.request(
    `/api/tasks/${root.body.task.id}/tree?direction=descendants&depth=1`,
    { actorName: alice },
  );
  assert.equal(result.response.status, 413);
  assert.equal(result.body.error.code, "TREE_TOO_LARGE");
});

test("GET /api/tasks rejects a project with more than 1,000 tasks", async () => {
  const projectId = "task-list-cap";
  await createProject(projectId);
  const timestamp = new Date().toISOString();

  // A recursive CTE keeps this cap fixture to a single D1 write instead of 1,001 API mutations.
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 1001
    )
    INSERT INTO tasks (
      id, identifier, project_id, title, description, status, priority, labels, sort_order,
      creator_type, creator_id, creator_name,
      assignee_type, assignee_id, assignee_name,
      version, created_at, updated_at
    )
    SELECT
      'task-list-cap-' || value,
      'TASKLISTCAP-' || value,
      ?,
      'Task list cap fixture',
      '',
      'backlog',
      'none',
      '[]',
      value,
      'user',
      'task-list-cap-fixture',
      'Task list cap fixture',
      'user',
      'task-list-cap-fixture',
      'Task list cap fixture',
      1,
      ?,
      ?
    FROM sequence
  `).bind(projectId, timestamp, timestamp).run();

  const result = await cloud.request(`/api/tasks?projectId=${projectId}`, { actorName: alice });
  assert.equal(result.response.status, 413);
  assert.equal(result.body.error.code, "TASK_LIST_TOO_LARGE");
});

test("GET /api/tasks still returns tasks at exactly the 1,000-task cap", async () => {
  const projectId = "task-list-cap-boundary";
  await createProject(projectId);
  const timestamp = new Date().toISOString();

  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < 1000
    )
    INSERT INTO tasks (
      id, identifier, project_id, title, description, status, priority, labels, sort_order,
      creator_type, creator_id, creator_name,
      assignee_type, assignee_id, assignee_name,
      version, created_at, updated_at
    )
    SELECT
      'task-list-cap-boundary-' || value,
      'TASKLISTCAPB-' || value,
      ?,
      'Task list cap boundary fixture',
      '',
      'backlog',
      'none',
      '[]',
      value,
      'user',
      'task-list-cap-boundary-fixture',
      'Task list cap boundary fixture',
      'user',
      'task-list-cap-boundary-fixture',
      'Task list cap boundary fixture',
      1,
      ?,
      ?
    FROM sequence
  `).bind(projectId, timestamp, timestamp).run();

  const result = await cloud.request(`/api/tasks?projectId=${projectId}`, { actorName: alice });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.tasks.length, 1000);
});

test("GET /api/projects truncates to the 500-project cap on its unfiltered listing", async () => {
  const timestamp = new Date().toISOString();
  const baseline = (
    await cloud.db.prepare(`SELECT COUNT(*) AS count FROM projects`).all()
  ).results[0].count;
  const toBoundary = 500 - baseline;
  assert.ok(
    toBoundary > 0,
    `test fixture assumption violated: ${baseline} projects already exist before this test`,
  );

  // GET /api/projects has no query params (requireNoQuery), so unlike /api/tasks this
  // can't be scoped to one project's rows — it counts every project in the database.
  // The insert count is therefore computed relative to whatever earlier tests in this
  // file have already created, rather than hardcoded. A recursive CTE keeps this to a
  // single D1 write instead of hundreds of API mutations.
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
    SELECT
      'project-list-cap-' || value,
      'Project list cap fixture ' || value,
      NULL,
      1,
      ?,
      ?
    FROM sequence
  `).bind(toBoundary, timestamp, timestamp).run();

  const atCap = await cloud.request("/api/projects", { actorName: alice });
  assert.equal(atCap.response.status, 200);
  assert.equal(atCap.body.projects.length, 500);
  assert.equal(atCap.body.truncated, false);

  await cloud.db.prepare(`
    INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
    VALUES ('project-list-cap-over', 'Project list cap overflow fixture', NULL, 1, ?, ?)
  `).bind(timestamp, timestamp).run();

  // Over the cap: the endpoint no longer errors (a 413 here would be a permanent
  // lockout — GET /api/projects has no query params to narrow the result, and
  // deleteProject() rejects non-"temp-" ids, so there'd be no way to recover).
  // It returns the first 500 rows (by the existing created_at/id ordering) with
  // a truncation flag instead.
  const overCap = await cloud.request("/api/projects", { actorName: alice });
  assert.equal(overCap.response.status, 200);
  assert.equal(overCap.body.projects.length, 500);
  assert.equal(overCap.body.truncated, true);
});

test("concurrent inverse parent writes cannot create a cycle", async () => {
  await createProject("concurrent-parent-cycle");
  const first = await createTask("concurrent-parent-cycle", "First");
  const second = await createTask("concurrent-parent-cycle", "Second");

  const [firstResult, secondResult] = await Promise.all([
    cloud.request(
      `/api/tasks/${first.body.task.id}/relations/parent/${second.body.task.id}`,
      {
        method: "POST",
        actorName: alice,
        json: { version: first.body.task.version },
      },
    ),
    cloud.request(
      `/api/tasks/${second.body.task.id}/relations/parent/${first.body.task.id}`,
      {
        method: "POST",
        actorName: bob,
        json: { version: second.body.task.version },
      },
    ),
  ]);

  assert.deepEqual(
    [firstResult.response.status, secondResult.response.status].sort(),
    [200, 409],
  );
  const conflict = firstResult.response.status === 409 ? firstResult : secondResult;
  assert.equal(conflict.body.error.code, "RELATION_CYCLE");

  const rows = await cloud.db.prepare(`
    SELECT source_task_id, target_task_id
    FROM task_relations
    WHERE relation_type = 'parent'
      AND source_task_id IN (?, ?)
      AND target_task_id IN (?, ?)
  `).bind(
    first.body.task.id,
    second.body.task.id,
    first.body.task.id,
    second.body.task.id,
  ).all();
  assert.equal(rows.results.length, 1);

  const third = await createTask("concurrent-parent-cycle", "Third");
  const fourth = await createTask("concurrent-parent-cycle", "Fourth");
  const inserted = await Promise.allSettled([
    cloud.db.prepare(`
      INSERT INTO task_relations (
        relation_type, source_task_id, target_task_id, created_at
      ) VALUES ('parent', ?, ?, ?)
    `).bind(fourth.body.task.id, third.body.task.id, new Date().toISOString()).run(),
    cloud.db.prepare(`
      INSERT INTO task_relations (
        relation_type, source_task_id, target_task_id, created_at
      ) VALUES ('parent', ?, ?, ?)
    `).bind(third.body.task.id, fourth.body.task.id, new Date().toISOString()).run(),
  ]);
  assert.equal(inserted.filter((result) => result.status === "fulfilled").length, 1);
});

test("comment attachment cleanup preserves shared-state boundaries", async () => {
  await createProject("shared-boundaries");
  const task = await createTask("shared-boundaries", "Comment owner");
  const created = await cloud.request(`/api/tasks/${task.body.task.id}/comments`, {
    method: "POST",
    actorName: bob,
    json: { body: "Initial" },
  });
  const attachment = await cloud.request(
    `/api/comments/${created.body.comment.id}/attachments`,
    {
      method: "POST",
      actorName: bob,
      headers: {
        "content-type": "text/plain",
        "x-taskboard-filename": encodeURIComponent("comment.txt"),
        "x-taskboard-attachment-kind": "attachment",
      },
      body: "comment attachment",
    },
  );
  assert.equal(attachment.response.status, 201);

  const updated = await cloud.request(`/api/comments/${created.body.comment.id}`, {
    method: "PATCH",
    actorName: bob,
    json: { version: created.body.comment.version, body: "Updated" },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.comment.attachments.length, 1);

  const deleted = await cloud.request(`/api/comments/${created.body.comment.id}`, {
    method: "DELETE",
    actorName: bob,
    json: { version: updated.body.comment.version },
  });
  assert.equal(deleted.response.status, 204);
  assert.deepEqual(await cloud.listAttachmentKeys(), []);
});

async function uploadCommentAttachment(commentId, filename, actorName = alice) {
  const response = await cloud.request(`/api/comments/${commentId}/attachments`, {
    method: "POST",
    actorName,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent(filename),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: `content of ${filename}`,
  });
  assert.equal(response.response.status, 201);
  return response.body.attachment;
}

function byId(comments) {
  return new Map(comments.map((comment) => [comment.id, comment]));
}

function sortedById(attachments) {
  return [...attachments].sort((a, b) => a.id.localeCompare(b.id));
}

test("listing task comments batches attachment hydration instead of querying per comment (CWE-400)", async () => {
  await createProject("comment-batch-query");
  const task = await createTask("comment-batch-query", "Comment attachment batching");
  const taskId = task.body.task.id;

  const noAttachments = await cloud.request(`/api/tasks/${taskId}/comments`, {
    method: "POST",
    actorName: bob,
    json: { body: "No attachments here" },
  });
  assert.equal(noAttachments.response.status, 201);

  const twoAttachments = await cloud.request(`/api/tasks/${taskId}/comments`, {
    method: "POST",
    actorName: alice,
    json: { body: "Two attachments here" },
  });
  assert.equal(twoAttachments.response.status, 201);
  const twoAttachmentsFirst = await uploadCommentAttachment(
    twoAttachments.body.comment.id,
    "two-a.txt",
  );
  const twoAttachmentsSecond = await uploadCommentAttachment(
    twoAttachments.body.comment.id,
    "two-b.txt",
  );

  const oneAttachment = await cloud.request(`/api/tasks/${taskId}/comments`, {
    method: "POST",
    actorName: bob,
    json: { body: "One attachment here" },
  });
  assert.equal(oneAttachment.response.status, 201);
  const oneAttachmentFile = await uploadCommentAttachment(
    oneAttachment.body.comment.id,
    "one.txt",
  );

  // A task-level attachment (comment_id IS NULL) must never leak into any comment's list.
  const taskLevelAttachment = await cloud.request(`/api/tasks/${taskId}/attachments`, {
    method: "POST",
    actorName: alice,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": "task-level.txt",
      "x-taskboard-attachment-kind": "attachment",
    },
    body: "task-level content",
  });
  assert.equal(taskLevelAttachment.response.status, 201);

  // GET /api/tasks/:id/comments (listComments) — no cursor.
  const listed = await cloud.request(`/api/tasks/${taskId}/comments`, { actorName: alice });
  assert.equal(listed.response.status, 200);
  const listedById = byId(listed.body.comments);

  // Comment with zero attachments must get [] (not undefined, not another comment's attachments).
  assert.deepEqual(listedById.get(noAttachments.body.comment.id).attachments, []);
  // Comment with two attachments gets both, matching the upload responses exactly.
  assert.deepEqual(
    sortedById(listedById.get(twoAttachments.body.comment.id).attachments),
    sortedById([twoAttachmentsFirst, twoAttachmentsSecond]),
  );
  // Comment with one attachment doesn't pick up its sibling comments' or the task-level attachment.
  assert.deepEqual(
    listedById.get(oneAttachment.body.comment.id).attachments,
    [oneAttachmentFile],
  );

  // GET /api/tasks/:id/comments?after=0 (listCommentsAfter) must show identical batching behavior.
  const listedAfter = await cloud.request(
    `/api/tasks/${taskId}/comments?after=0`,
    { actorName: alice },
  );
  assert.equal(listedAfter.response.status, 200);
  const listedAfterById = byId(listedAfter.body.comments);
  assert.deepEqual(listedAfterById.get(noAttachments.body.comment.id).attachments, []);
  assert.deepEqual(
    sortedById(listedAfterById.get(twoAttachments.body.comment.id).attachments),
    sortedById([twoAttachmentsFirst, twoAttachmentsSecond]),
  );
  assert.deepEqual(
    listedAfterById.get(oneAttachment.body.comment.id).attachments,
    [oneAttachmentFile],
  );

  // Sanity: the task-level attachment (comment_id IS NULL) doesn't surface on any comment.
  const taskLevelAttachmentId = taskLevelAttachment.body.attachment.id;
  for (const comment of listed.body.comments) {
    assert.ok(!comment.attachments.some((a) => a.id === taskLevelAttachmentId));
  }
  for (const comment of listedAfter.body.comments) {
    assert.ok(!comment.attachments.some((a) => a.id === taskLevelAttachmentId));
  }
});

async function insertCommentFixtures(taskId, count, prefix) {
  const timestamp = new Date().toISOString();
  // A recursive CTE keeps this cap fixture to a single D1 write instead of `count` API mutations.
  // change_revision is set to the sequence value (always > 0) so an `?after=0` cursor read sees
  // every fixture row too — the same shape a real GET /api/tasks/:id/comments?after=0 call would.
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO comments (
      id, task_id, body, thread_id, author_type, author_id, author_name, author_avatar_url,
      version, created_at, updated_at, change_revision
    )
    SELECT
      ? || '-' || value,
      ?,
      'Comment cap fixture ' || value,
      NULL,
      'user',
      'comment-cap-fixture',
      'Comment cap fixture',
      NULL,
      1,
      ?,
      ?,
      value
    FROM sequence
  `).bind(count, prefix, taskId, timestamp, timestamp).run();
}

test("GET /api/tasks/:id/comments rejects a task with more than 1,000 comments (CWE-400)", async () => {
  await createProject("comment-list-cap");
  const task = await createTask("comment-list-cap", "Comment list cap fixture");
  const taskId = task.body.task.id;
  await insertCommentFixtures(taskId, 1001, "comment-list-cap");

  const result = await cloud.request(`/api/tasks/${taskId}/comments`, { actorName: alice });
  assert.equal(result.response.status, 413);
  assert.equal(result.body.error.code, "COMMENT_LIST_TOO_LARGE");
});

test("GET /api/tasks/:id/comments?after=0 rejects a task with more than 1,000 comments, blocking the cap bypass (CWE-400)", async () => {
  await createProject("comment-list-cap-after-bypass");
  const task = await createTask("comment-list-cap-after-bypass", "Comment list cap after-cursor fixture");
  const taskId = task.body.task.id;
  await insertCommentFixtures(taskId, 1001, "comment-list-cap-after-bypass");

  // Without its own cap, listCommentsAfter would let `?after=0` read every comment unbounded,
  // defeating the cap enforced on the no-cursor listComments() path above.
  const result = await cloud.request(`/api/tasks/${taskId}/comments?after=0`, { actorName: alice });
  assert.equal(result.response.status, 413);
  assert.equal(result.body.error.code, "COMMENT_LIST_TOO_LARGE");
});

test("GET /api/tasks/:id/comments still returns comments at exactly the 1,000-comment cap", async () => {
  await createProject("comment-list-cap-boundary");
  const task = await createTask("comment-list-cap-boundary", "Comment list cap boundary fixture");
  const taskId = task.body.task.id;
  await insertCommentFixtures(taskId, 1000, "comment-list-cap-boundary");

  const result = await cloud.request(`/api/tasks/${taskId}/comments`, { actorName: alice });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.comments.length, 1000);

  const afterResult = await cloud.request(`/api/tasks/${taskId}/comments?after=0`, { actorName: alice });
  assert.equal(afterResult.response.status, 200);
  assert.equal(afterResult.body.comments.length, 1000);
});

async function createRelation(taskId, type, otherTaskId, version, actorName = alice) {
  const response = await cloud.request(
    `/api/tasks/${taskId}/relations/${type}/${otherTaskId}`,
    { method: "POST", actorName, json: { version } },
  );
  assert.equal(response.response.status, 200);
  return response.body;
}

async function fetchTask(taskId) {
  const response = await cloud.request(`/api/tasks/${taskId}`, { actorName: alice });
  assert.equal(response.response.status, 200);
  return response.body.task;
}

test("GET /api/tasks batches task_relations without changing per-task output (CWE-400)", async () => {
  const projectId = "relations-batch-parity";
  await createProject(projectId);
  const parentTask = await createTask(projectId, "Parent");
  const childTask = await createTask(projectId, "Child");
  const blockerTask = await createTask(projectId, "Blocker");
  const blockedTask = await createTask(projectId, "Blocked");
  const relatedA = await createTask(projectId, "Related A");
  const relatedB = await createTask(projectId, "Related B");
  const lonelyTask = await createTask(projectId, "No relations");

  await createRelation(
    childTask.body.task.id,
    "parent",
    parentTask.body.task.id,
    childTask.body.task.version,
  );
  await createRelation(
    blockedTask.body.task.id,
    "blocked_by",
    blockerTask.body.task.id,
    blockedTask.body.task.version,
  );
  await createRelation(
    relatedA.body.task.id,
    "related",
    relatedB.body.task.id,
    relatedA.body.task.version,
  );

  const listed = await cloud.request(
    `/api/tasks?projectId=${projectId}&archived=false`,
    { actorName: alice },
  );
  assert.equal(listed.response.status, 200);
  const listedById = byId(listed.body.tasks);

  // Explicit shape checks for each of the five relation kinds.
  assert.equal(listedById.get(childTask.body.task.id).relations.parent.id, parentTask.body.task.id);
  assert.deepEqual(
    listedById.get(parentTask.body.task.id).relations.subIssues.map((t) => t.id),
    [childTask.body.task.id],
  );
  assert.deepEqual(
    listedById.get(blockedTask.body.task.id).relations.blockedBy.map((t) => t.id),
    [blockerTask.body.task.id],
  );
  assert.deepEqual(
    listedById.get(blockerTask.body.task.id).relations.blocks.map((t) => t.id),
    [blockedTask.body.task.id],
  );
  // 'related' is bidirectional: both ends of the same batch must see each other,
  // even though only one side issued the POST that created the relation.
  assert.deepEqual(
    listedById.get(relatedA.body.task.id).relations.related.map((t) => t.id),
    [relatedB.body.task.id],
  );
  assert.deepEqual(
    listedById.get(relatedB.body.task.id).relations.related.map((t) => t.id),
    [relatedA.body.task.id],
  );
  // A task with no task_relations rows gets null/[] for every field, not undefined or a crash,
  // and every *Truncated flag is false.
  assert.deepEqual(listedById.get(lonelyTask.body.task.id).relations, {
    parent: null,
    subIssues: [],
    subIssuesTruncated: false,
    blockedBy: [],
    blockedByTruncated: false,
    blocks: [],
    blocksTruncated: false,
    related: [],
    relatedTruncated: false,
  });

  // The batched list path (listTasks -> hydrateTask with relationsOverride) must produce
  // byte-for-byte the same `.relations` as the unbatched single-task path (getTask ->
  // hydrateTask with no override), for every task in the page.
  for (const created of [
    parentTask, childTask, blockerTask, blockedTask, relatedA, relatedB, lonelyTask,
  ]) {
    const single = await fetchTask(created.body.task.id);
    assert.deepEqual(
      listedById.get(created.body.task.id).relations,
      single.relations,
      `relations mismatch for task ${created.body.task.id}`,
    );
  }
});

async function insertTaskFixtures(projectId, count, prefix) {
  const timestamp = new Date().toISOString();
  // A recursive CTE keeps this fixture to a single D1 write instead of `count` API mutations,
  // mirroring insertCommentFixtures/the tree-cap fixtures above. sort_order = value drives
  // GET /api/tasks' ordering deterministically so batch-chunk boundaries land on known rows.
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO tasks (
      id, identifier, project_id, title, description, status, priority, labels, sort_order,
      creator_type, creator_id, creator_name,
      assignee_type, assignee_id, assignee_name,
      version, created_at, updated_at
    )
    SELECT
      ? || '-' || value,
      upper(?) || '-' || value,
      ?,
      'Relation batch fixture',
      '',
      'backlog',
      'none',
      '[]',
      value,
      'user',
      'relation-batch-fixture',
      'Relation batch fixture',
      'user',
      'relation-batch-fixture',
      'Relation batch fixture',
      1,
      ?,
      ?
    FROM sequence
  `).bind(count, prefix, prefix, projectId, timestamp, timestamp).run();
}

test("GET /api/tasks keeps task_relations correct across batch-chunk boundaries (CWE-400)", async () => {
  const projectId = "relations-batch-boundary";
  const prefix = "relbatch";
  const idFor = (value) => `${prefix}-${value}`;
  await createProject(projectId);
  // 90 tasks: bigger than both the 'related' chunk size (40) and the parent/blocks chunk
  // size (80), so relations placed across those boundaries prove chunking doesn't drop or
  // duplicate rows.
  await insertTaskFixtures(projectId, 90, prefix);
  const timestamp = new Date().toISOString();

  // 'related' crossings: one spanning chunk 0 (1-40) and chunk 1 (41-80), one sitting
  // exactly on the chunk 0/1 boundary edge.
  const relatedPairs = [[1, 45], [40, 41]];
  // 'parent'/'blocks' crossings: spanning chunk 0 (1-80) and chunk 1 (81-90).
  const parentPair = [3, 88]; // [parent, child]
  const blocksPair = [5, 86]; // [blocker, blocked]

  for (const [a, b] of relatedPairs) {
    await cloud.db.prepare(`
      INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at)
      VALUES ('related', ?, ?, ?)
    `).bind(idFor(a), idFor(b), timestamp).run();
  }
  await cloud.db.prepare(`
    INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at)
    VALUES ('parent', ?, ?, ?)
  `).bind(idFor(parentPair[0]), idFor(parentPair[1]), timestamp).run();
  await cloud.db.prepare(`
    INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at)
    VALUES ('blocks', ?, ?, ?)
  `).bind(idFor(blocksPair[0]), idFor(blocksPair[1]), timestamp).run();

  const listed = await cloud.request(
    `/api/tasks?projectId=${projectId}&archived=false`,
    { actorName: alice },
  );
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.tasks.length, 90);
  const listedById = byId(listed.body.tasks);

  for (const [a, b] of relatedPairs) {
    assert.deepEqual(
      listedById.get(idFor(a)).relations.related.map((t) => t.id),
      [idFor(b)],
      `task ${idFor(a)} should see ${idFor(b)} as related`,
    );
    assert.deepEqual(
      listedById.get(idFor(b)).relations.related.map((t) => t.id),
      [idFor(a)],
      `task ${idFor(b)} should see ${idFor(a)} as related`,
    );
  }
  assert.equal(listedById.get(idFor(parentPair[1])).relations.parent.id, idFor(parentPair[0]));
  assert.deepEqual(
    listedById.get(idFor(parentPair[0])).relations.subIssues.map((t) => t.id),
    [idFor(parentPair[1])],
  );
  assert.deepEqual(
    listedById.get(idFor(blocksPair[1])).relations.blockedBy.map((t) => t.id),
    [idFor(blocksPair[0])],
  );
  assert.deepEqual(
    listedById.get(idFor(blocksPair[0])).relations.blocks.map((t) => t.id),
    [idFor(blocksPair[1])],
  );

  // Cross-check the boundary-straddling tasks against the unbatched single-task path too.
  const touchedIds = [
    ...relatedPairs.flat(), parentPair[0], parentPair[1], blocksPair[0], blocksPair[1],
  ].map(idFor);
  for (const taskId of touchedIds) {
    const single = await fetchTask(taskId);
    assert.deepEqual(
      listedById.get(taskId).relations,
      single.relations,
      `relations mismatch for task ${taskId}`,
    );
  }
});

// ---------------------------------------------------------------------------
// task-hydration-row-caps: relation/comment/activity/comment-attachment caps
// ---------------------------------------------------------------------------
//
// Coverage note: subIssues and blockedBy exercise the two distinct JOIN shapes shared by all
// four relation kinds (blocks uses the same shape as subIssues; the singular `parent` lookup has
// no cap since a task has at most one parent). `related`'s batch query is structurally different
// (UNION ALL wrapped in an extra window-function subquery layer) rather than just a swapped JOIN
// direction, so — unlike the other three kinds — it needs two separate tests: the single-row-path
// test right after this note (CASE-WHEN JOIN, via GET /api/tasks/:id) and a dedicated batch-path
// test below (the UNION ALL query, via GET /api/tasks?projectId=..., alongside the blockedBy
// batch-isolation test).

async function insertSubIssueFixtures(parentId, childPrefix, count, startValue = 1) {
  const endValue = startValue + count - 1;
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT CAST(? AS INTEGER)
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at)
    SELECT 'parent', ?, ? || '-' || value, '2099-01-01T00:00:' || printf('%05d', value)
    FROM sequence
  `).bind(startValue, endValue, parentId, childPrefix).run();
}

async function insertBlockedByFixtures(blockedId, blockerPrefix, count, startValue = 1) {
  const endValue = startValue + count - 1;
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT CAST(? AS INTEGER)
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at)
    SELECT 'blocks', ? || '-' || value, ?, '2099-01-01T00:00:' || printf('%05d', value)
    FROM sequence
  `).bind(startValue, endValue, blockerPrefix, blockedId).run();
}

async function insertRelatedFixtures(ownerId, otherPrefix, count, startValue = 1) {
  // ownerId must sort lexicographically before every `${otherPrefix}-${value}` id: task_relations
  // has CHECK (relation_type <> 'related' OR source_task_id < target_task_id).
  const endValue = startValue + count - 1;
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT CAST(? AS INTEGER)
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO task_relations (relation_type, source_task_id, target_task_id, created_at)
    SELECT 'related', ?, ? || '-' || value, '2099-01-01T00:00:' || printf('%05d', value)
    FROM sequence
  `).bind(startValue, endValue, ownerId, otherPrefix).run();
}

test("GET /api/tasks/:id caps subIssues at TASK_RELATION_MAX_RESULTS and keeps the newest rows", async () => {
  const projectId = "relation-cap-subissues";
  await createProject(projectId);
  const owner = await createTask(projectId, "Parent with many sub-issues");
  const ownerId = owner.body.task.id;
  await insertTaskFixtures(projectId, 1001, "relcap-subissue-child");

  await insertSubIssueFixtures(ownerId, "relcap-subissue-child", 1000, 1);
  const atBoundary = await fetchTask(ownerId);
  assert.equal(atBoundary.relations.subIssues.length, 1000);
  assert.equal(atBoundary.relations.subIssuesTruncated, false);

  await insertSubIssueFixtures(ownerId, "relcap-subissue-child", 1, 1001);
  const overBoundary = await fetchTask(ownerId);
  assert.equal(overBoundary.relations.subIssues.length, 1000);
  assert.equal(overBoundary.relations.subIssuesTruncated, true);
  assert.ok(
    overBoundary.relations.subIssues.some((t) => t.id === "relcap-subissue-child-1001"),
    "the newest sub-issue must survive truncation",
  );
});

test("GET /api/tasks/:id caps related at TASK_RELATION_MAX_RESULTS via the single-row CASE-WHEN query and keeps the newest rows", async () => {
  const projectId = "relation-cap-related";
  await createProject(projectId);
  await insertTaskFixtures(projectId, 1, "relcap-related-a-owner");
  await insertTaskFixtures(projectId, 1001, "relcap-related-b-other");
  const ownerId = "relcap-related-a-owner-1";

  await insertRelatedFixtures(ownerId, "relcap-related-b-other", 1000, 1);
  const atBoundary = await fetchTask(ownerId);
  assert.equal(atBoundary.relations.related.length, 1000);
  assert.equal(atBoundary.relations.relatedTruncated, false);

  await insertRelatedFixtures(ownerId, "relcap-related-b-other", 1, 1001);
  const overBoundary = await fetchTask(ownerId);
  assert.equal(overBoundary.relations.related.length, 1000);
  assert.equal(overBoundary.relations.relatedTruncated, true);
  assert.ok(
    overBoundary.relations.related.some((t) => t.id === "relcap-related-b-other-1001"),
    "the newest related task must survive truncation",
  );
});

test("GET /api/tasks?projectId=... isolates blockedBy truncation to the one overloaded task (CWE-400)", async () => {
  const projectId = "relation-cap-blockedby-batch";
  await createProject(projectId);
  const overloaded = await createTask(projectId, "Blocked by many");
  const overloadedId = overloaded.body.task.id;
  const normal = await createTask(projectId, "Blocked by a few");
  const normalId = normal.body.task.id;
  const lonely = await createTask(projectId, "Blocked by none");

  // The blocker tasks must live in the same project (task_relations_require_same_project), but
  // must not count toward this project's own GET /api/tasks?projectId=... row cap (unrelated to
  // this change) — archiving them keeps them valid relation targets while excluding them from
  // the default archived=false listing below.
  await insertTaskFixtures(projectId, 1001, "relcap-blockedby-blocker");
  await insertBlockedByFixtures(overloadedId, "relcap-blockedby-blocker", 1001, 1);
  await insertTaskFixtures(projectId, 3, "relcap-blockedby-normal-blocker");
  await insertBlockedByFixtures(normalId, "relcap-blockedby-normal-blocker", 3, 1);
  await cloud.db.prepare(`
    UPDATE tasks SET archived_at = ?
    WHERE project_id = ?
      AND (id LIKE 'relcap-blockedby-blocker-%' OR id LIKE 'relcap-blockedby-normal-blocker-%')
  `).bind(new Date().toISOString(), projectId).run();

  const listed = await cloud.request(
    `/api/tasks?projectId=${projectId}&archived=false`,
    { actorName: alice },
  );
  assert.equal(listed.response.status, 200);
  const listedById = byId(listed.body.tasks);

  assert.equal(listedById.get(overloadedId).relations.blockedBy.length, 1000);
  assert.equal(listedById.get(overloadedId).relations.blockedByTruncated, true);

  assert.equal(listedById.get(normalId).relations.blockedBy.length, 3);
  assert.equal(listedById.get(normalId).relations.blockedByTruncated, false);

  assert.equal(listedById.get(lonely.body.task.id).relations.blockedBy.length, 0);
  assert.equal(listedById.get(lonely.body.task.id).relations.blockedByTruncated, false);
});

test("GET /api/tasks?projectId=... isolates relatedTruncated to the one overloaded task (CWE-400) via the UNION ALL batch-shaped query", async () => {
  const projectId = "relation-cap-related-batch";
  await createProject(projectId);
  // Owner prefixes use the "a-" segment and their fixture targets the "b-" segment so every
  // generated owner id sorts lexicographically before every generated target id regardless of
  // suffix, satisfying task_relations' CHECK (relation_type <> 'related' OR source_task_id <
  // target_task_id) for both owners independently (see insertRelatedFixtures above).
  await insertTaskFixtures(projectId, 1, "relcap-related-batch-a-overloaded");
  const overloadedId = "relcap-related-batch-a-overloaded-1";
  await insertTaskFixtures(projectId, 1, "relcap-related-batch-a-normal");
  const normalId = "relcap-related-batch-a-normal-1";
  const lonely = await createTask(projectId, "Related to none");

  // The related targets must live in the same project (task_relations_require_same_project), but
  // must not count toward this project's own GET /api/tasks?projectId=... row cap (unrelated to
  // this change) — archiving them keeps them valid relation targets while excluding them from
  // the default archived=false listing below.
  await insertTaskFixtures(projectId, 1001, "relcap-related-batch-b-other-overloaded");
  await insertRelatedFixtures(overloadedId, "relcap-related-batch-b-other-overloaded", 1001, 1);
  await insertTaskFixtures(projectId, 3, "relcap-related-batch-b-other-normal");
  await insertRelatedFixtures(normalId, "relcap-related-batch-b-other-normal", 3, 1);
  await cloud.db.prepare(`
    UPDATE tasks SET archived_at = ?
    WHERE project_id = ?
      AND (id LIKE 'relcap-related-batch-b-other-overloaded-%'
        OR id LIKE 'relcap-related-batch-b-other-normal-%')
  `).bind(new Date().toISOString(), projectId).run();

  const listed = await cloud.request(
    `/api/tasks?projectId=${projectId}&archived=false`,
    { actorName: alice },
  );
  assert.equal(listed.response.status, 200);
  const listedById = byId(listed.body.tasks);

  assert.equal(listedById.get(overloadedId).relations.related.length, 1000);
  assert.equal(listedById.get(overloadedId).relations.relatedTruncated, true);
  assert.ok(
    listedById.get(overloadedId).relations.related.some(
      (t) => t.id === "relcap-related-batch-b-other-overloaded-1001",
    ),
    "the newest related task must survive truncation",
  );

  assert.equal(listedById.get(normalId).relations.related.length, 3);
  assert.equal(listedById.get(normalId).relations.relatedTruncated, false);

  assert.equal(listedById.get(lonely.body.task.id).relations.related.length, 0);
  assert.equal(listedById.get(lonely.body.task.id).relations.relatedTruncated, false);
});

async function insertCommentCapFixtures(taskId, count, prefix, startValue = 1) {
  const endValue = startValue + count - 1;
  const createdAt = new Date().toISOString();
  // updated_at (unlike insertCommentFixtures above) is distinct and increasing per row, future-
  // dated so it always dominates task.updatedAt in attachTaskActivity's activityUpdatedAt max —
  // needed to observe activityUpdatedAt actually advancing once the cap is crossed.
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT CAST(? AS INTEGER)
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO comments (
      id, task_id, body, thread_id, author_type, author_id, author_name, author_avatar_url,
      version, created_at, updated_at, change_revision
    )
    SELECT
      ? || '-' || value,
      ?,
      'Comment cap fixture ' || value,
      NULL,
      'user',
      'comment-cap-fixture',
      'Comment cap fixture',
      NULL,
      1,
      ?,
      '2099-01-01T00:00:' || printf('%05d', value),
      value
    FROM sequence
  `).bind(startValue, endValue, prefix, taskId, createdAt).run();
}

test("GET /api/tasks/:id caps its own comments at COMMENT_LIST_MAX_RESULTS and keeps activityUpdatedAt advancing", async () => {
  const projectId = "comment-cap-single";
  await createProject(projectId);
  const task = await createTask(projectId, "Comment cap single-task fixture");
  const taskId = task.body.task.id;

  await insertCommentCapFixtures(taskId, 1000, "commentcap-single", 1);
  const atBoundary = await fetchTask(taskId);
  assert.equal(atBoundary.commentsTruncated, false);
  const activityUpdatedAtAtBoundary = atBoundary.activityUpdatedAt;

  await insertCommentCapFixtures(taskId, 1, "commentcap-single", 1001);
  const overBoundary = await fetchTask(taskId);
  assert.equal(overBoundary.commentsTruncated, true);
  assert.ok(
    overBoundary.activityUpdatedAt > activityUpdatedAtAtBoundary,
    "activityUpdatedAt must keep advancing instead of freezing once the task crosses the cap",
  );
});

test("GET /api/tasks?projectId=... isolates commentsTruncated to the one overloaded task (CWE-400)", async () => {
  const projectId = "comment-cap-batch";
  await createProject(projectId);
  const overloaded = await createTask(projectId, "Many comments");
  const normal = await createTask(projectId, "A few comments");

  await insertCommentCapFixtures(overloaded.body.task.id, 1001, "commentcap-batch-over", 1);
  await insertCommentCapFixtures(normal.body.task.id, 3, "commentcap-batch-normal", 1);

  const listed = await cloud.request(
    `/api/tasks?projectId=${projectId}&archived=false`,
    { actorName: alice },
  );
  assert.equal(listed.response.status, 200);
  const listedById = byId(listed.body.tasks);
  assert.equal(listedById.get(overloaded.body.task.id).commentsTruncated, true);
  assert.equal(listedById.get(normal.body.task.id).commentsTruncated, false);
});

async function insertActivityCapFixtures(taskId, count, prefix, startValue = 1) {
  const endValue = startValue + count - 1;
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT CAST(? AS INTEGER)
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO task_activities (
      id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
    )
    SELECT
      ? || '-' || value,
      ?,
      'user',
      'activity-cap-fixture',
      'Activity cap fixture',
      NULL,
      '{}',
      '2099-01-01T00:00:' || printf('%05d', value)
    FROM sequence
  `).bind(startValue, endValue, prefix, taskId).run();
}

test("GET /api/tasks/:id caps its own activities at TASK_ACTIVITY_MAX_RESULTS and keeps activityUpdatedAt advancing", async () => {
  const projectId = "activity-cap-single";
  await createProject(projectId);
  const task = await createTask(projectId, "Activity cap single-task fixture");
  const taskId = task.body.task.id;

  await insertActivityCapFixtures(taskId, 1000, "activitycap-single", 1);
  const atBoundary = await fetchTask(taskId);
  assert.equal(atBoundary.activitiesTruncated, false);
  const activityUpdatedAtAtBoundary = atBoundary.activityUpdatedAt;

  await insertActivityCapFixtures(taskId, 1, "activitycap-single", 1001);
  const overBoundary = await fetchTask(taskId);
  assert.equal(overBoundary.activitiesTruncated, true);
  assert.ok(
    overBoundary.activityUpdatedAt > activityUpdatedAtAtBoundary,
    "activityUpdatedAt must keep advancing instead of freezing once the task crosses the cap",
  );
});

test("GET /api/tasks?projectId=... isolates activitiesTruncated to the one overloaded task (CWE-400)", async () => {
  const projectId = "activity-cap-batch";
  await createProject(projectId);
  const overloaded = await createTask(projectId, "Many activities");
  const normal = await createTask(projectId, "A few activities");

  await insertActivityCapFixtures(overloaded.body.task.id, 1001, "activitycap-batch-over", 1);
  await insertActivityCapFixtures(normal.body.task.id, 3, "activitycap-batch-normal", 1);

  const listed = await cloud.request(
    `/api/tasks?projectId=${projectId}&archived=false`,
    { actorName: alice },
  );
  assert.equal(listed.response.status, 200);
  const listedById = byId(listed.body.tasks);
  assert.equal(listedById.get(overloaded.body.task.id).activitiesTruncated, true);
  assert.equal(listedById.get(normal.body.task.id).activitiesTruncated, false);
});

async function insertCommentAttachmentCapFixtures(taskId, commentId, count, prefix, startValue = 1) {
  const endValue = startValue + count - 1;
  const timestamp = new Date().toISOString();
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT CAST(? AS INTEGER)
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO attachments (
      id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
    )
    SELECT
      ? || '-' || value,
      ?,
      ?,
      'attachment',
      'file-' || value || '.txt',
      'text/plain',
      4,
      ?,
      value
    FROM sequence
  `).bind(startValue, endValue, prefix, taskId, commentId, timestamp).run();
}

test("comment attachments are capped at COMMENT_ATTACHMENT_MAX_RESULTS on every hydrate/read entry point", async () => {
  const projectId = "comment-attachment-cap";
  await createProject(projectId);
  const task = await createTask(projectId, "Comment attachment cap fixture");
  const taskId = task.body.task.id;

  // POST /api/tasks/:id/comments (createComment): a freshly created comment can never have
  // pre-existing attachments (they're uploaded afterward, against the comment's real id), so
  // this only proves the field is wired through correctly, not the truncation branch itself —
  // that's covered by the read paths below.
  const created = await cloud.request(`/api/tasks/${taskId}/comments`, {
    method: "POST",
    actorName: alice,
    json: { body: "Freshly created" },
  });
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.body.comment.attachments, []);
  assert.equal(created.body.comment.attachmentsTruncated, false);

  const boundaryComment = await cloud.request(`/api/tasks/${taskId}/comments`, {
    method: "POST",
    actorName: alice,
    json: { body: "Exactly at the cap" },
  });
  await insertCommentAttachmentCapFixtures(
    taskId, boundaryComment.body.comment.id, 1000, "commentattachcap-boundary", 1,
  );

  const overflowComment = await cloud.request(`/api/tasks/${taskId}/comments`, {
    method: "POST",
    actorName: alice,
    json: { body: "One past the cap" },
  });
  await insertCommentAttachmentCapFixtures(
    taskId, overflowComment.body.comment.id, 1001, "commentattachcap-overflow", 1,
  );

  // GET /api/tasks/:id/comments (listComments): covers both boundary and overflow.
  const listed = await cloud.request(`/api/tasks/${taskId}/comments`, { actorName: alice });
  assert.equal(listed.response.status, 200);
  const listedById = byId(listed.body.comments);
  assert.equal(listedById.get(boundaryComment.body.comment.id).attachments.length, 1000);
  assert.equal(listedById.get(boundaryComment.body.comment.id).attachmentsTruncated, false);
  assert.equal(listedById.get(overflowComment.body.comment.id).attachments.length, 1000);
  assert.equal(listedById.get(overflowComment.body.comment.id).attachmentsTruncated, true);

  // GET /api/tasks/:id/comments?after=0 (listCommentsAfter): same batching path, different cursor.
  const listedAfter = await cloud.request(
    `/api/tasks/${taskId}/comments?after=0`,
    { actorName: alice },
  );
  assert.equal(listedAfter.response.status, 200);
  const listedAfterById = byId(listedAfter.body.comments);
  assert.equal(listedAfterById.get(overflowComment.body.comment.id).attachments.length, 1000);
  assert.equal(listedAfterById.get(overflowComment.body.comment.id).attachmentsTruncated, true);

  // PATCH /api/comments/:id (updateComment): single-comment hydrate path.
  const patched = await cloud.request(`/api/comments/${overflowComment.body.comment.id}`, {
    method: "PATCH",
    actorName: alice,
    json: { version: overflowComment.body.comment.version, body: "Edited" },
  });
  assert.equal(patched.response.status, 200);
  assert.equal(patched.body.comment.attachments.length, 1000);
  assert.equal(patched.body.comment.attachmentsTruncated, true);
});

test("DELETE /api/comments/:id deletes every attachment (D1 row and R2 object) past the cap, and tolerates an individual R2 delete failure", async () => {
  const projectId = "delete-comment-cap";
  await createProject(projectId);
  const task = await createTask(projectId, "Delete comment cap fixture");
  const taskId = task.body.task.id;
  const created = await cloud.request(`/api/tasks/${taskId}/comments`, {
    method: "POST",
    actorName: alice,
    json: { body: "Has many attachments" },
  });
  const commentId = created.body.comment.id;

  const normalCount = 1001; // exceeds COMMENT_ATTACHMENT_MAX_RESULTS by one
  const normalKeys = [];
  for (let value = 1; value <= normalCount; value += 1) {
    const key = `delete-comment-cap-${value}`;
    normalKeys.push(key);
    await cloud.attachments.put(key, `content ${value}`);
  }
  await cloud.db.prepare(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO attachments (
      id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
    )
    SELECT
      'delete-comment-cap-' || value,
      ?,
      ?,
      'attachment',
      'file-' || value || '.txt',
      'text/plain',
      4,
      ?,
      value
    FROM sequence
  `).bind(normalCount, taskId, commentId, new Date().toISOString()).run();

  // One more attachment row whose id is too long for R2's key-length limit, so its individual
  // R2 delete call genuinely fails at the storage layer — proving deleteComment() tolerates a
  // real per-object failure instead of letting Promise.all reject the whole request.
  const overlongId = "z".repeat(1200);
  await cloud.db.prepare(`
    INSERT INTO attachments (
      id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
    ) VALUES (?, ?, ?, 'attachment', 'overlong.txt', 'text/plain', 4, ?, ?)
  `).bind(overlongId, taskId, commentId, new Date().toISOString(), normalCount + 1).run();

  async function taskAttachmentRevision() {
    return Number(
      await cloud.db.prepare("SELECT attachment_revision FROM tasks WHERE id = ?")
        .bind(taskId).first("attachment_revision"),
    );
  }
  const revisionBeforeDelete = await taskAttachmentRevision();

  const deleted = await cloud.request(`/api/comments/${commentId}`, {
    method: "DELETE",
    actorName: alice,
    json: { version: created.body.comment.version },
  });
  assert.equal(deleted.response.status, 204);

  const remainingD1Rows = Number(await cloud.db.prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE comment_id = ?",
  ).bind(commentId).first("count"));
  assert.equal(remainingD1Rows, 0);

  const remainingKeys = new Set(await cloud.listAttachmentKeys());
  for (const key of normalKeys) {
    assert.ok(!remainingKeys.has(key), `R2 object ${key} should have been deleted`);
  }

  // Migration 0012's AFTER DELETE trigger on `attachments` fires once per row cascade-deleted
  // (normalCount + the overlong-id row), regardless of the R2-side failure on one of them —
  // proving deleteComment()'s D1 deletion path (untouched by this change) still drives ibz's
  // attachment_revision counter correctly at a scale past the new cap.
  assert.equal(await taskAttachmentRevision(), revisionBeforeDelete + normalCount + 1);
});
