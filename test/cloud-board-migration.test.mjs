import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { main } from "../cli/taskctl.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

const ACTOR = "Alice";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function capture() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    text() { return value; },
    json() { return JSON.parse(value); },
  };
}

async function runCli(argv, dataDirectory, cloudFetch, extraOverrides = {}) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: new PassThrough(),
    env: { CODEX_TASKBOARD_DATA_DIR: dataDirectory },
    cloudFetch,
    ...extraOverrides,
  });
  return {
    exitCode,
    stdout: exitCode === 0 ? stdout.json() : null,
    stderr: exitCode === 0 ? null : stderr.json(),
  };
}

async function withMigrationFixture(testFunction) {
  const cloud = await createCloudWorkerHarness();
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "taskboard-cli-migration-"));
  try {
    await writeFile(
      path.join(dataDirectory, "cloud-companion.json"),
      JSON.stringify({
        version: 1,
        remoteUrl: "https://taskboard.example.test",
        actorName: "migrator",
        sharedKey: cloud.sharedSecret,
        projectMappings: {},
      }),
    );
    const cloudFetch = (url, init) => cloud.miniflare.dispatchFetch(url, init);

    async function createCloudTask(title, extra = {}) {
      const result = await cloud.request("/api/tasks", {
        method: "POST",
        actorName: ACTOR,
        json: {
          projectId: "local",
          title,
          description: `Description for ${title}`,
          status: "backlog",
          priority: "none",
          labels: ["from-cloud"],
          ...extra,
        },
      });
      assert.equal(result.response.status, 201, `create task '${title}' failed`);
      return result.body.task;
    }

    async function archiveCloudTask(task) {
      const result = await cloud.request(`/api/tasks/${task.id}/archive`, {
        method: "POST",
        actorName: ACTOR,
        json: { version: task.version },
      });
      assert.equal(result.response.status, 200);
      return result.body.task;
    }

    async function createCloudComment(taskId, body) {
      const result = await cloud.request(`/api/tasks/${taskId}/comments`, {
        method: "POST",
        actorName: ACTOR,
        json: { body },
      });
      assert.equal(result.response.status, 201, "create comment failed");
      return result.body.comment;
    }

    async function uploadCloudTaskAttachment(taskId, filename, content) {
      const result = await cloud.request(`/api/tasks/${taskId}/attachments`, {
        method: "POST",
        actorName: ACTOR,
        headers: {
          "content-type": "text/plain",
          "x-taskboard-filename": encodeURIComponent(filename),
          "x-taskboard-attachment-kind": "attachment",
        },
        body: content,
      });
      assert.equal(result.response.status, 201, "upload task attachment failed");
      return result.body.attachment;
    }

    async function uploadCloudCommentAttachment(commentId, filename, content) {
      const result = await cloud.request(`/api/comments/${commentId}/attachments`, {
        method: "POST",
        actorName: ACTOR,
        headers: {
          "content-type": "text/plain",
          "x-taskboard-filename": encodeURIComponent(filename),
          "x-taskboard-attachment-kind": "attachment",
        },
        body: content,
      });
      assert.equal(result.response.status, 201, "upload comment attachment failed");
      return result.body.attachment;
    }

    function openLocalDatabase() {
      return new TaskboardDatabase(path.join(dataDirectory, "taskboard.sqlite"));
    }

    async function migrate(extraArgs = []) {
      return runCli(["cloud", "migrate", "--project", "local", ...extraArgs], dataDirectory, cloudFetch);
    }

    await testFunction({
      cloud,
      dataDirectory,
      migrate,
      createCloudTask,
      archiveCloudTask,
      createCloudComment,
      uploadCloudTaskAttachment,
      uploadCloudCommentAttachment,
      openLocalDatabase,
    });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
    await cloud.dispose();
  }
}

test("2.1 dry-run lists the cloud board without writing to the local project", async () => {
  await withMigrationFixture(async ({
    cloud,
    migrate,
    createCloudTask,
    createCloudComment,
    uploadCloudTaskAttachment,
    openLocalDatabase,
  }) => {
    const task = await createCloudTask("Dry run task");
    await createCloudComment(task.id, "A comment");
    await uploadCloudTaskAttachment(task.id, "note.txt", "note contents");

    const directTasks = (await cloud.db.prepare("SELECT COUNT(*) AS n FROM tasks").all()).results[0].n;
    const directComments = (await cloud.db.prepare("SELECT COUNT(*) AS n FROM comments").all()).results[0].n;
    const directAttachments = (await cloud.db.prepare("SELECT COUNT(*) AS n FROM attachments").all()).results[0].n;

    const result = await migrate(["--dry-run"]);
    assert.equal(result.exitCode, 0, JSON.stringify(result.stderr));
    assert.equal(result.stdout.dryRun, true);
    assert.equal(result.stdout.counts.tasks, directTasks);
    assert.equal(result.stdout.counts.comments, directComments);
    assert.equal(result.stdout.counts.attachments, directAttachments);
    assert.equal(result.stdout.tasks.length, directTasks);
    assert.equal(result.stdout.comments.length, directComments);
    assert.equal(result.stdout.attachments.length, directAttachments);

    const localDb = openLocalDatabase();
    try {
      const localTaskCount = localDb.database.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'local'",
      ).get().n;
      assert.equal(localTaskCount, 0, "dry-run must not write any tasks locally");
    } finally {
      localDb.close();
    }
  });
});

test("2.2 full migration reproduces cloud tasks/comments/attachments locally with matching content", async () => {
  await withMigrationFixture(async ({
    migrate,
    createCloudTask,
    createCloudComment,
    uploadCloudTaskAttachment,
    uploadCloudCommentAttachment,
    openLocalDatabase,
    dataDirectory,
  }) => {
    const taskA = await createCloudTask("Alpha task", { priority: "high", labels: ["a", "b"] });
    const commentA = await createCloudComment(taskA.id, "First comment on alpha");
    const taskAttachment = await uploadCloudTaskAttachment(taskA.id, "alpha.txt", "alpha attachment bytes");
    const commentAttachment = await uploadCloudCommentAttachment(commentA.id, "alpha-comment.txt", "comment attachment bytes");
    const taskB = await createCloudTask("Beta task", { status: "in_progress" });

    const result = await migrate();
    assert.equal(result.exitCode, 0, JSON.stringify(result.stderr));
    assert.equal(result.stdout.counts.tasks.migrated, 2);
    assert.equal(result.stdout.counts.comments.migrated, 1);
    assert.equal(result.stdout.counts.attachments.migrated, 2);
    assert.equal(result.stdout.counts.tasks.failed, 0);
    assert.equal(result.stdout.counts.comments.failed, 0);
    assert.equal(result.stdout.counts.attachments.failed, 0);
    assert.deepEqual(result.stdout.failures, []);

    const localDb = openLocalDatabase();
    try {
      const localTasks = localDb.database.prepare(
        "SELECT * FROM tasks WHERE project_id = 'local' ORDER BY title",
      ).all();
      assert.equal(localTasks.length, 2);
      const localAlpha = localTasks.find((row) => row.title === "Alpha task");
      const localBeta = localTasks.find((row) => row.title === "Beta task");
      assert.ok(localAlpha);
      assert.ok(localBeta);
      assert.equal(localAlpha.description, taskA.description);
      assert.equal(localAlpha.status, taskA.status);
      assert.equal(localAlpha.priority, "high");
      assert.deepEqual(JSON.parse(localAlpha.labels), ["a", "b"]);
      assert.equal(localAlpha.creator_name, ACTOR);
      assert.equal(localBeta.status, "in_progress");

      const localComments = localDb.database.prepare(
        "SELECT * FROM comments WHERE task_id = ?",
      ).all(localAlpha.id);
      assert.equal(localComments.length, 1);
      assert.equal(localComments[0].body, "First comment on alpha");
      assert.equal(localComments[0].author_name, ACTOR);

      const localTaskAttachments = localDb.database.prepare(
        "SELECT * FROM attachments WHERE task_id = ? AND comment_id IS NULL",
      ).all(localAlpha.id);
      assert.equal(localTaskAttachments.length, 1);
      assert.equal(localTaskAttachments[0].filename, "alpha.txt");
      assert.equal(localTaskAttachments[0].size, taskAttachment.size);
      const localTaskAttachmentBytes = await readFile(
        path.join(dataDirectory, "attachments", localTaskAttachments[0].id),
      );
      assert.equal(localTaskAttachmentBytes.toString("utf8"), "alpha attachment bytes");

      const localCommentAttachments = localDb.database.prepare(
        "SELECT * FROM attachments WHERE comment_id = ?",
      ).all(localComments[0].id);
      assert.equal(localCommentAttachments.length, 1);
      assert.equal(localCommentAttachments[0].filename, "alpha-comment.txt");
      assert.equal(commentAttachment.filename, "alpha-comment.txt");
      const localCommentAttachmentBytes = await readFile(
        path.join(dataDirectory, "attachments", localCommentAttachments[0].id),
      );
      assert.equal(localCommentAttachmentBytes.toString("utf8"), "comment attachment bytes");
    } finally {
      localDb.close();
    }
  });
});

test("2.2 migrated attachment bytes match the cloud source by content hash", async () => {
  await withMigrationFixture(async ({
    migrate,
    createCloudTask,
    uploadCloudTaskAttachment,
    openLocalDatabase,
    dataDirectory,
  }) => {
    const task = await createCloudTask("Hash check task");
    const content = "the quick brown fox jumps over the lazy dog";
    await uploadCloudTaskAttachment(task.id, "fox.txt", content);

    const result = await migrate();
    assert.equal(result.exitCode, 0, JSON.stringify(result.stderr));
    assert.equal(result.stdout.counts.attachments.migrated, 1);

    const localDb = openLocalDatabase();
    let attachmentId;
    try {
      const row = localDb.database.prepare("SELECT * FROM attachments LIMIT 1").get();
      attachmentId = row.id;
    } finally {
      localDb.close();
    }
    const bytes = await readFile(path.join(dataDirectory, "attachments", attachmentId));
    assert.equal(sha256(bytes), sha256(Buffer.from(content, "utf8")));
  });
});

test("2.3 re-running migration is idempotent: no duplicates are created", async () => {
  await withMigrationFixture(async ({
    migrate,
    createCloudTask,
    createCloudComment,
    uploadCloudTaskAttachment,
    openLocalDatabase,
  }) => {
    const task = await createCloudTask("Idempotent task");
    await createCloudComment(task.id, "Only comment");
    await uploadCloudTaskAttachment(task.id, "once.txt", "should only exist once");

    const first = await migrate();
    assert.equal(first.exitCode, 0, JSON.stringify(first.stderr));
    assert.equal(first.stdout.counts.tasks.migrated, 1);
    assert.equal(first.stdout.counts.comments.migrated, 1);
    assert.equal(first.stdout.counts.attachments.migrated, 1);

    const countsAfterFirst = (() => {
      const localDb = openLocalDatabase();
      try {
        return {
          tasks: localDb.database.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'local'").get().n,
          comments: localDb.database.prepare("SELECT COUNT(*) AS n FROM comments").get().n,
          attachments: localDb.database.prepare("SELECT COUNT(*) AS n FROM attachments").get().n,
        };
      } finally {
        localDb.close();
      }
    })();

    const second = await migrate();
    assert.equal(second.exitCode, 0, JSON.stringify(second.stderr));
    assert.equal(second.stdout.counts.tasks.migrated, 0);
    assert.equal(second.stdout.counts.tasks.skipped, 1);
    assert.equal(second.stdout.counts.comments.migrated, 0);
    assert.equal(second.stdout.counts.comments.skipped, 1);
    assert.equal(second.stdout.counts.attachments.migrated, 0);
    assert.equal(second.stdout.counts.attachments.skipped, 1);

    const localDb = openLocalDatabase();
    try {
      assert.equal(
        localDb.database.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'local'").get().n,
        countsAfterFirst.tasks,
      );
      assert.equal(
        localDb.database.prepare("SELECT COUNT(*) AS n FROM comments").get().n,
        countsAfterFirst.comments,
      );
      assert.equal(
        localDb.database.prepare("SELECT COUNT(*) AS n FROM attachments").get().n,
        countsAfterFirst.attachments,
      );
    } finally {
      localDb.close();
    }
  });
});

test("2.4 an attachment download failure does not block the rest of the migration", async () => {
  await withMigrationFixture(async ({
    cloud,
    migrate,
    createCloudTask,
    uploadCloudTaskAttachment,
    openLocalDatabase,
  }) => {
    const task = await createCloudTask("Task with one bad attachment");
    const good = await uploadCloudTaskAttachment(task.id, "good.txt", "this one survives");
    const bad = await uploadCloudTaskAttachment(task.id, "missing.txt", "this object will vanish from R2");

    // D1 metadata for `bad` still lists it, but its R2 object is gone, so
    // downloading its content during migration fails with a 404 — this
    // simulates the "attachment fails to download" scenario without
    // touching the migration tool's own code paths.
    await cloud.attachments.delete(bad.id);

    const result = await migrate();
    assert.equal(result.exitCode, 0, JSON.stringify(result.stderr));
    assert.equal(result.stdout.counts.tasks.migrated, 1);
    assert.equal(result.stdout.counts.attachments.migrated, 1);
    assert.equal(result.stdout.counts.attachments.failed, 1);
    assert.equal(result.stdout.failures.length, 1);
    assert.equal(result.stdout.failures[0].type, "attachment");
    assert.equal(result.stdout.failures[0].cloudId, bad.id);
    assert.equal(result.stdout.failures[0].filename, "missing.txt");
    assert.match(result.stdout.failures[0].reason, /404|not found/i);

    const localDb = openLocalDatabase();
    try {
      const localAttachments = localDb.database.prepare("SELECT filename FROM attachments").all();
      assert.equal(localAttachments.length, 1);
      assert.equal(localAttachments[0].filename, "good.txt");
    } finally {
      localDb.close();
    }

    // Re-running after fixing nothing must still only skip the successful
    // one and keep reporting the same permanent failure, not duplicate it.
    const rerun = await migrate();
    assert.equal(rerun.exitCode, 0, JSON.stringify(rerun.stderr));
    assert.equal(rerun.stdout.counts.attachments.skipped, 1);
    assert.equal(rerun.stdout.counts.attachments.failed, 1);
    assert.equal(rerun.stdout.counts.attachments.migrated, 0);
  });
});

test("cloud migrate rejects a local project that does not exist", async () => {
  await withMigrationFixture(async ({ dataDirectory, cloud }) => {
    const cloudFetch = (url, init) => cloud.miniflare.dispatchFetch(url, init);
    const result = await runCli(
      ["cloud", "migrate", "--project", "does-not-exist"],
      dataDirectory,
      cloudFetch,
    );
    assert.equal(result.exitCode, 4);
    assert.equal(result.stderr.error.code, "PROJECT_NOT_FOUND");
  });
});
