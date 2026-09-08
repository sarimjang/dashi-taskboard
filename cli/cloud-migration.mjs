// Reads a shared cloud board directly over HTTP (Basic auth against the
// remote origin recorded in cloud-companion.json) and tracks migration
// progress in a local state file, so `taskctl cloud migrate` can import
// shared-board data into a local project without going through
// server/cloud-proxy.mjs's forwarding path (see design.md "刪除而非修復
// 雲端寫入路徑" — that module is scheduled for deletion in this change's
// section 3, so this migration path must not depend on it or on
// server/cloud-config.mjs).
//
// The local-write side also cannot go through the local server's HTTP API:
// when cloud mode is configured (the exact situation this tool exists to
// migrate *out of*), server/app.mjs forwards every /api/* request that
// isn't on the isLocalCompanionRoute allowlist to the cloud Worker (see its
// `if (currentCloudConfig.remoteUrl) { ... cloudProxy.forward(...) }` gate).
// POSTing tasks/comments/attachments through that API would silently
// round-trip them back to the cloud instead of landing in the local
// database. So writes go straight through server/database.mjs's
// TaskboardDatabase, the same module the server itself uses.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TaskboardDatabase } from "../server/database.mjs";

export const CLOUD_MIGRATION_STATE_VERSION = 1;

export class CloudMigrationError extends Error {
  constructor(message, { code = "CLOUD_MIGRATION_ERROR", details } = {}) {
    super(message);
    this.name = "CloudMigrationError";
    this.code = code;
    this.details = details;
  }
}

function projectRootDirectory() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultDataDirectory(env) {
  return env.CODEX_TASKBOARD_DATA_DIR
    ? path.resolve(env.CODEX_TASKBOARD_DATA_DIR)
    : path.join(projectRootDirectory(), ".data");
}

export function defaultCloudConfigPath(env = process.env) {
  return path.join(defaultDataDirectory(env), "cloud-companion.json");
}

export function defaultMigrationStatePath(env = process.env) {
  return path.join(defaultDataDirectory(env), "cloud-migration-state.json");
}

// Mirrors resolveServerOptions()'s databasePath/attachmentsDirectory
// defaults in server/app.mjs so migrated data lands in the same SQLite
// file and attachment store the local server reads from.
export function defaultDatabasePath(env = process.env) {
  return path.join(defaultDataDirectory(env), "taskboard.sqlite");
}

export function defaultAttachmentsDirectory(env = process.env) {
  return path.join(defaultDataDirectory(env), "attachments");
}

export function openLocalWriter({
  databasePath,
  attachmentsDirectory,
  openDatabase = (filename) => new TaskboardDatabase(filename),
}) {
  const database = openDatabase(databasePath);

  async function storeAttachmentBytes(id, bytes) {
    await mkdir(attachmentsDirectory, { recursive: true });
    const storagePath = path.join(attachmentsDirectory, id);
    await writeFile(storagePath, bytes, { flag: "wx" });
    return storagePath;
  }

  return {
    getProject(projectId) {
      return database.getProject(projectId);
    },
    createTask(input) {
      return database.createTask(input);
    },
    archiveTask(id, version, actor) {
      return database.archiveTask(id, version, undefined, undefined, actor);
    },
    createComment(taskId, input) {
      return database.createComment(taskId, input);
    },
    async createTaskAttachment(taskId, { filename, contentType, kind, bytes }) {
      const id = randomUUID();
      const storagePath = await storeAttachmentBytes(id, bytes);
      try {
        return database.createAttachment(taskId, { id, filename, contentType, kind, size: bytes.length });
      } catch (error) {
        await unlink(storagePath);
        throw error;
      }
    },
    async createCommentAttachment(commentId, { filename, contentType, kind, bytes }) {
      const id = randomUUID();
      const storagePath = await storeAttachmentBytes(id, bytes);
      try {
        return database.createCommentAttachment(commentId, { id, filename, contentType, kind, size: bytes.length });
      } catch (error) {
        await unlink(storagePath);
        throw error;
      }
    },
    close() {
      database.close();
    },
  };
}

// Deliberately reimplements the same origin shape cloud-config.mjs's
// normalizeCloudUrl validates, instead of importing it: cloud-config.mjs is
// deleted whole in this change's section 3, and this migration tool must
// keep working (it is the thing that has to run *before* that deletion, and
// stays a standalone tool afterward).
function isPlausibleCloudOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const isLoopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  return (url.protocol === "https:" || (url.protocol === "http:" && isLoopback))
    && !url.username
    && !url.password
    && url.pathname === "/"
    && !url.search
    && !url.hash;
}

export async function readCloudCompanionConfig(configPath, overrides = {}) {
  const read = overrides.readFile ?? readFile;
  let raw;
  try {
    raw = await read(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CloudMigrationError(
        `Cloud companion configuration not found at '${configPath}'. Run 'taskctl cloud login' first, or pass --cloud-config.`,
        { code: "CLOUD_CONFIG_NOT_FOUND" },
      );
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CloudMigrationError(
      `Cloud companion configuration at '${configPath}' is not valid JSON`,
      { code: "INVALID_CLOUD_CONFIG" },
    );
  }
  const remoteUrl = parsed?.remoteUrl;
  const actorName = parsed?.actorName;
  const sharedKey = parsed?.sharedKey;
  if (
    typeof remoteUrl !== "string" || !isPlausibleCloudOrigin(remoteUrl)
    || typeof actorName !== "string" || !actorName
    || typeof sharedKey !== "string" || !sharedKey
  ) {
    throw new CloudMigrationError(
      `Cloud companion configuration at '${configPath}' is missing remoteUrl/actorName/sharedKey. Run 'taskctl cloud login' first.`,
      { code: "INVALID_CLOUD_CONFIG" },
    );
  }
  return { remoteUrl: new URL(remoteUrl).origin, actorName, sharedKey };
}

function basicAuthorizationHeader(actorName, sharedKey) {
  return `Basic ${Buffer.from(`${actorName}:${sharedKey}`, "utf8").toString("base64")}`;
}

export function migrationSourceKey({ remoteUrl }) {
  return remoteUrl;
}

// Talks to the deployed Cloudflare Worker's own REST surface directly (same
// route shapes as server/app.mjs, since createCloudProxy().forward() used to
// relay these exact paths byte-for-byte) instead of routing through the
// local server's cloud-proxy hop.
export function createCloudReader({
  remoteUrl,
  actorName,
  sharedKey,
  fetch: fetchImplementation = globalThis.fetch,
}) {
  const authorization = basicAuthorizationHeader(actorName, sharedKey);

  async function getJson(pathname) {
    const url = new URL(pathname, `${remoteUrl}/`);
    let response;
    try {
      response = await fetchImplementation(url, {
        headers: { accept: "application/json", authorization },
      });
    } catch (error) {
      throw new CloudMigrationError(`Cannot reach cloud taskboard at ${remoteUrl}`, {
        code: "CLOUD_UNREACHABLE",
        details: error instanceof Error ? error.message : String(error),
      });
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      throw new CloudMigrationError(
        payload?.error?.message ?? `Cloud taskboard request to '${pathname}' failed with HTTP ${response.status}`,
        { code: payload?.error?.code ?? `HTTP_${response.status}` },
      );
    }
    if (!payload || typeof payload !== "object") {
      throw new CloudMigrationError(
        `Cloud taskboard returned an invalid JSON response for '${pathname}'`,
        { code: "INVALID_CLOUD_RESPONSE" },
      );
    }
    return payload;
  }

  return {
    async listProjects() {
      const { projects } = await getJson("/api/projects");
      return Array.isArray(projects) ? projects : [];
    },
    // archived=all: the default local/cloud filter excludes archived tasks,
    // which would silently drop them from migration otherwise. Omitting
    // projectId returns tasks across every cloud project in one call.
    async listAllTasks() {
      const { tasks } = await getJson("/api/tasks?archived=all");
      return Array.isArray(tasks) ? tasks : [];
    },
    // listComments has no real pagination semantics here: GET without
    // `after` always returns the full set for the task (the nextCursor it
    // returns is a change-revision checkpoint for incremental sync, not a
    // "there are more pages" marker) — see server/app.mjs nextCursor().
    async listComments(taskId) {
      const { comments } = await getJson(`/api/tasks/${encodeURIComponent(taskId)}/comments`);
      return Array.isArray(comments) ? comments : [];
    },
    async listTaskAttachments(taskId) {
      const { attachments } = await getJson(`/api/tasks/${encodeURIComponent(taskId)}/attachments`);
      return Array.isArray(attachments) ? attachments : [];
    },
    async downloadAttachment(attachmentId) {
      const url = new URL(`/api/attachments/${encodeURIComponent(attachmentId)}/content`, `${remoteUrl}/`);
      let response;
      try {
        response = await fetchImplementation(url, {
          headers: { accept: "*/*", authorization },
        });
      } catch (error) {
        throw new CloudMigrationError(`Cannot reach cloud taskboard at ${remoteUrl}`, {
          code: "CLOUD_UNREACHABLE",
          details: error instanceof Error ? error.message : String(error),
        });
      }
      if (!response.ok) {
        throw new CloudMigrationError(
          `Attachment '${attachmentId}' download failed with HTTP ${response.status}`,
          { code: `HTTP_${response.status}` },
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { bytes, contentType: response.headers.get("content-type") };
    },
  };
}

// Comment attachments are already embedded on each comment (see
// server/database.mjs #commentWithAttachments) — no separate fetch needed.
export async function collectCloudSnapshot(cloudReader) {
  const projects = await cloudReader.listProjects();
  const tasks = await cloudReader.listAllTasks();
  const comments = [];
  const attachments = [];
  for (const task of tasks) {
    const taskComments = await cloudReader.listComments(task.id);
    for (const comment of taskComments) {
      const { attachments: commentAttachments, ...commentFields } = comment;
      comments.push(commentFields);
      for (const attachment of commentAttachments ?? []) {
        attachments.push({ ...attachment, taskId: task.id, commentId: comment.id });
      }
    }
    const taskAttachments = await cloudReader.listTaskAttachments(task.id);
    for (const attachment of taskAttachments) {
      attachments.push({ ...attachment, taskId: task.id, commentId: null });
    }
  }
  return {
    projects,
    tasks,
    comments,
    attachments,
    counts: {
      projects: projects.length,
      tasks: tasks.length,
      comments: comments.length,
      attachments: attachments.length,
    },
  };
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Content-fidelity digest used by 2.2/2.5 verification: only fields this
// tool actually copies verbatim participate, so a matching digest on the
// local side is a direct claim of "equivalent content", not an approximation.
export function taskContentDigest(task) {
  return sha256Hex(Buffer.from(JSON.stringify({
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    startDate: task.startDate ?? null,
    dueDate: task.dueDate ?? null,
    recurrence: task.recurrence ?? null,
  }), "utf8"));
}

export function commentContentDigest(comment) {
  return sha256Hex(Buffer.from(JSON.stringify({ body: comment.body }), "utf8"));
}

function emptyState() {
  return { version: CLOUD_MIGRATION_STATE_VERSION, sources: {} };
}

export async function readMigrationState(stateFilePath, overrides = {}) {
  const read = overrides.readFile ?? readFile;
  let raw;
  try {
    raw = await read(stateFilePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CloudMigrationError(
      `Cloud migration state file at '${stateFilePath}' is not valid JSON`,
      { code: "INVALID_MIGRATION_STATE" },
    );
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || parsed.version !== CLOUD_MIGRATION_STATE_VERSION
    || !parsed.sources
    || typeof parsed.sources !== "object"
  ) {
    throw new CloudMigrationError(
      `Cloud migration state file at '${stateFilePath}' has an unsupported shape`,
      { code: "INVALID_MIGRATION_STATE" },
    );
  }
  return parsed;
}

export function sourceBucket(state, sourceKey) {
  if (!state.sources[sourceKey]) {
    state.sources[sourceKey] = { tasks: {}, comments: {}, attachments: {} };
  }
  return state.sources[sourceKey];
}

export async function writeMigrationState(stateFilePath, state, overrides = {}) {
  const write = overrides.writeFile ?? writeFile;
  const mkdirImpl = overrides.mkdir ?? mkdir;
  const renameImpl = overrides.rename ?? rename;
  await mkdirImpl(path.dirname(stateFilePath), { recursive: true });
  const temporaryPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
  await write(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await renameImpl(temporaryPath, stateFilePath);
}
