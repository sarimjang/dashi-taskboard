import { DurableObject } from "cloudflare:workers";

import { DEFAULT_LABEL_NAMES } from "../../shared/domain.mjs";

const JSON_BODY_LIMIT = 1024 * 1024;
const PROJECT_README_BODY_LIMIT = 3 * 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = 25 * 1024 * 1024;
const DEFAULT_PROJECT_LABELS_JSON = JSON.stringify(DEFAULT_LABEL_NAMES);
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
];
const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"];
const INLINE_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);
const REALTIME_HUB_NAME = "global";
const SESSION_COOKIE_NAME = "__Host-taskboard_session";
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
const TASK_TREE_MAX_NODES = 1_000;
const TASK_LIST_MAX_RESULTS = 1_000;
const COMMENT_LIST_MAX_RESULTS = 1_000;
const TASK_RELATION_MAX_RESULTS = 1_000;
// Also reserved for dashi-taskboard-1jm (listTaskActivities()) and dashi-taskboard-kgg
// (listTaskAttachments()/listCommentAttachments()) to reuse verbatim once those land.
const TASK_ACTIVITY_MAX_RESULTS = 1_000;
const COMMENT_ATTACHMENT_MAX_RESULTS = 1_000;
// Projects are created one at a time via `taskctl project create` (one per tracked
// repo/workspace), never bulk-generated like tasks or comments. This repo's own
// multi-project workspace (app_develop/repo-study/*) tops out around 170 sibling
// directories, so 500 stays ~3x above any legitimate scale observed in practice
// while remaining far tighter than TASK_LIST_MAX_RESULTS, since GET /api/projects
// has no query params (requireNoQuery) to narrow an oversized result.
const PROJECT_LIST_MAX_RESULTS = 500;
// Neither project_readme_attachments nor attachments has an upload-time count cap today
// (only per-file size limits exist: ATTACHMENT_BODY_LIMIT, PROJECT_README_BODY_LIMIT), so a
// single project/task's attachment count is unbounded in principle. This constant bounds each
// individual page fetch in the pre-delete pagination loops below (fixes the CWE-400 finding:
// an unbounded SELECT inside env.DB.batch()) without bounding the *total* number of ids
// collected — the loop keeps paging until exhausted, so completeness (no orphaned R2 objects
// after the cascading DELETE) is never traded away for the per-page cap. 200 keeps each row
// payload (a single id string) trivially small while staying well above any attachment count
// seen in practice, and keeps multi-page regression-test fixtures reasonably fast to set up.
const ATTACHMENT_DELETE_PAGE_SIZE = 200;

export class RealtimeHub extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json(426, {
          error: { code: "WEBSOCKET_REQUIRED", message: "A WebSocket upgrade is required" },
        }, { upgrade: "websocket" });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const payload = await request.json();
      if (!Number.isSafeInteger(payload?.revision) || payload.revision < 0) {
        return json(400, {
          error: { code: "INVALID_REVISION", message: "revision must be non-negative" },
        });
      }
      const message = JSON.stringify({ type: "revision", revision: payload.revision });
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(message);
        } catch {
          // The runtime will deliver the close/error event for stale sockets.
        }
      }
      return empty(204);
    }

    return json(404, { error: { code: "NOT_FOUND", message: "Resource not found" } });
  }

  webSocketMessage(socket) {
    socket.close(1008, "Client messages are not supported");
  }
}

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function empty(status, headers = {}) {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function methodNotAllowed(allowed) {
  throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", {
    allowed,
  });
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      "UNKNOWN_FIELD",
      `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

function stringField(value, name, {
  required = false,
  nullable = false,
  maxLength,
} = {}) {
  if (value === undefined) {
    if (required) {
      throw new ApiError(400, "INVALID_FIELD", `'${name}' is required`);
    }
    return undefined;
  }
  if (nullable && value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `'${name}' must be a string${nullable ? " or null" : ""}`,
    );
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized.length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function parseVersion(value, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `'version' must be a ${allowZero ? "non-negative" : "positive"} integer`,
    );
  }
  return value;
}

function parseStatus(value, fallback) {
  const status = value ?? fallback;
  if (!TASK_STATUSES.includes(status)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `'status' must be one of: ${TASK_STATUSES.join(", ")}`,
    );
  }
  return status;
}

function parsePriority(value, fallback) {
  const priority = value ?? fallback;
  if (!TASK_PRIORITIES.includes(priority)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'priority' must be none, urgent, high, medium, or low",
    );
  }
  return priority;
}

function parseLabels(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'labels' must be an array with at most 20 entries");
  }
  const labels = value.map((label) => {
    if (typeof label !== "string") {
      throw new ApiError(400, "INVALID_FIELD", "Every label must be a string");
    }
    const normalized = label.trim();
    if (normalized.length === 0 || normalized.length > 64) {
      throw new ApiError(400, "INVALID_FIELD", "Labels must contain 1 to 64 characters");
    }
    return normalized;
  });
  if (new Set(labels).size !== labels.length) {
    throw new ApiError(400, "INVALID_FIELD", "Labels must be unique");
  }
  return labels;
}

function parseSortOrder(value) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Math.abs(value) > 1_000_000_000_000
  ) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'sortOrder' must be a finite number between -1000000000000 and 1000000000000",
    );
  }
  return value;
}

function parseDueDate(value, name = "dueDate") {
  const date = stringField(value, name, { nullable: true, maxLength: 10 });
  if (date !== null && date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must use YYYY-MM-DD`);
  }
  return date;
}

function parseRecurrence(value) {
  if (value === null) return null;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["interval", "unit"]));
  if (!Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 365) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'recurrence.interval' must be an integer from 1 to 365",
    );
  }
  if (!["day", "week", "month", "year"].includes(value.unit)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'recurrence.unit' must be day, week, month, or year",
    );
  }
  return { interval: value.interval, unit: value.unit };
}

function parseDevelopmentContext(value) {
  if (value === null) return null;
  assertPlainObject(value);
  if (value.type === "branch") {
    assertAllowedKeys(value, new Set(["type", "branch"]));
    return {
      type: "branch",
      branch: stringField(value.branch, "developmentContext.branch", {
        required: true,
        maxLength: 512,
      }),
    };
  }
  if (value.type === "worktree") {
    assertAllowedKeys(value, new Set(["type", "path", "branch"]));
    const worktreePath = stringField(value.path, "developmentContext.path", {
      maxLength: 4096,
    });
    if (worktreePath?.includes("\0")) {
      throw new ApiError(
        400,
        "INVALID_FIELD",
        "'developmentContext.path' cannot contain null bytes",
      );
    }
    return {
      type: "worktree",
      path: null,
      branch: stringField(value.branch ?? null, "developmentContext.branch", {
        nullable: true,
        maxLength: 512,
      }),
    };
  }
  throw new ApiError(
    400,
    "INVALID_FIELD",
    "'developmentContext.type' must be branch or worktree",
  );
}

function parseThreadId(value) {
  if (value === undefined) return undefined;
  return stringField(value, "threadId", { required: true, maxLength: 256 });
}

function parseThreadBinding(value) {
  if (value === undefined || value === null) return value;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "threadId",
    "codexProjectId",
    "codexProjectKind",
    "codexHostId",
    "workspacePath",
  ]));
  const threadId = stringField(value.threadId, "threadBinding.threadId", {
    required: true,
    maxLength: 256,
  });
  const identityFields = [
    value.codexProjectId,
    value.codexProjectKind,
    value.codexHostId,
    value.workspacePath,
  ];
  if (identityFields.every((field) => field === undefined)) return { threadId };
  if (identityFields.some((field) => field === undefined)) {
    throw new ApiError(400, "INVALID_FIELD", "Thread identity must include project, kind, host, and workspace");
  }
  const codexProjectId = stringField(value.codexProjectId, "threadBinding.codexProjectId", {
    required: true,
    maxLength: 256,
  });
  const codexProjectKind = value.codexProjectKind;
  const codexHostId = stringField(value.codexHostId, "threadBinding.codexHostId", {
    required: true,
    maxLength: 256,
  });
  const workspacePath = stringField(value.workspacePath, "threadBinding.workspacePath", {
    required: true,
    maxLength: 4096,
  });
  if (
    (codexProjectKind !== "local" && codexProjectKind !== "remote")
    || (codexProjectKind === "local" && codexHostId !== "local")
    || (codexProjectKind === "remote" && codexHostId === "local")
    || workspacePath.includes("\0")
  ) {
    throw new ApiError(400, "INVALID_FIELD", "Thread project identity is invalid");
  }
  return { threadId, codexProjectId, codexProjectKind, codexHostId, workspacePath };
}

function parseAssigneeTarget(value) {
  if (value === undefined) return undefined;
  if (!["current-user", "codex-agent"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'assigneeTarget' must be current-user or codex-agent",
    );
  }
  return value;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function validateProjectId(value) {
  const id = stringField(value, "id", { required: true, maxLength: 64 });
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'id' must be a lowercase slug containing letters, numbers, or hyphens",
    );
  }
  return id;
}

function projectPrefix(project) {
  const idPrefix = project.id.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "TASK";
  const existingPrefix = project.first_identifier?.replace(/-\d+$/, "");
  if (existingPrefix && /^[A-Z0-9]+$/i.test(existingPrefix) && existingPrefix !== idPrefix) return existingPrefix;
  if (idPrefix.length <= 5) return idPrefix;
  const namePrefix = project.name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 3);
  return namePrefix || idPrefix.slice(0, 3);
}

function now() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

function decodeBasicCredentials(header) {
  if (!header?.startsWith("Basic ")) return null;
  let bytes;
  try {
    const binary = atob(header.slice(6).trim());
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const separator = value.indexOf(":");
  if (separator < 1) return null;
  return {
    username: value.slice(0, separator),
    password: value.slice(separator + 1),
  };
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sessionSigningKey(sharedSecret, usage) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sharedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

async function createSessionCookie(username, sharedSecret) {
  const payload = new TextEncoder().encode(JSON.stringify({
    username,
    expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1_000,
  }));
  const encodedPayload = encodeBase64Url(payload);
  const key = await sessionSigningKey(sharedSecret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encodedPayload),
  );
  const token = `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

async function decodeSessionUsername(request, sharedSecret) {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await sessionSigningKey(sharedSecret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(parts[1]),
      new TextEncoder().encode(parts[0]),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64Url(parts[0]),
    ));
    if (!Number.isSafeInteger(payload?.expiresAt) || payload.expiresAt <= Date.now()) return null;
    return stringField(payload.username, "session username", { required: true, maxLength: 120 });
  } catch {
    return null;
  }
}

function unauthorized() {
  return json(
    401,
    { error: { code: "UNAUTHORIZED", message: "Valid Basic credentials are required" } },
    { "www-authenticate": 'Basic realm="Codex Taskboard", charset="UTF-8"' },
  );
}

async function authenticate(request, env) {
  if (typeof env.TASKBOARD_SHARED_SECRET !== "string" || env.TASKBOARD_SHARED_SECRET === "") {
    throw new ApiError(
      500,
      "SERVER_MISCONFIGURED",
      "TASKBOARD_SHARED_SECRET is not configured",
    );
  }
  const credentials = decodeBasicCredentials(request.headers.get("authorization"));
  let username;
  let sessionCookie = null;
  if (credentials) {
    const encoder = new TextEncoder();
    const [providedSecret, configuredSecret] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(credentials.password)),
      crypto.subtle.digest("SHA-256", encoder.encode(env.TASKBOARD_SHARED_SECRET)),
    ]);
    if (!crypto.subtle.timingSafeEqual(providedSecret, configuredSecret)) return null;
    username = stringField(credentials.username, "Basic username", {
      required: true,
      maxLength: 120,
    });
    sessionCookie = await createSessionCookie(username, env.TASKBOARD_SHARED_SECRET);
  } else {
    username = await decodeSessionUsername(request, env.TASKBOARD_SHARED_SECRET);
    if (!username) return null;
  }
  const userId = `basic:${encodeURIComponent(username.toLowerCase())}`;
  if (request.headers.get("x-taskboard-client") === "taskctl") {
    return {
      actor: {
        type: "agent",
        id: `${userId}:codex-agent`,
        name: `Codex Agent (${username})`,
        avatarUrl: null,
        username,
      },
      sessionCookie,
    };
  }
  return {
    actor: {
      type: "user",
      id: userId,
      name: username,
      avatarUrl: null,
      username,
    },
    sessionCookie,
  };
}

function resolveAssignee(target, actor) {
  if (target === undefined || target === "current-user") return actor;
  const userId = `basic:${encodeURIComponent(actor.username.toLowerCase())}`;
  return {
    type: "agent",
    id: `${userId}:codex-agent`,
    name: `Codex Agent (${actor.username})`,
    avatarUrl: null,
  };
}

async function readJson(
  request,
  limit = JSON_BODY_LIMIT,
  tooLargeMessage = "JSON body cannot exceed 1 MiB",
) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json",
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

async function readAttachment(request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > ATTACHMENT_BODY_LIMIT) {
    throw new ApiError(413, "BODY_TOO_LARGE", "Attachment cannot exceed 25 MiB");
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > ATTACHMENT_BODY_LIMIT) {
    throw new ApiError(413, "BODY_TOO_LARGE", "Attachment cannot exceed 25 MiB");
  }
  return body;
}

function parseAttachmentHeaders(request) {
  const encodedFilename = request.headers.get("x-taskboard-filename");
  if (encodedFilename === null) {
    throw new ApiError(400, "INVALID_FILENAME", "X-Taskboard-Filename is required");
  }
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename).trim();
  } catch {
    throw new ApiError(
      400,
      "INVALID_FILENAME",
      "Attachment filename contains invalid encoding",
    );
  }
  if (
    filename.length === 0
    || filename.length > 240
    || filename === "."
    || filename === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(filename)
  ) {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename is invalid");
  }
  const rawContentType = request.headers.get("content-type");
  const contentType = rawContentType
    ? rawContentType.split(";", 1)[0].trim().toLowerCase()
    : "application/octet-stream";
  if (
    contentType.length === 0
    || contentType.length > 200
    || !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(contentType)
  ) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Attachment Content-Type is invalid",
    );
  }
  const kind = request.headers.get("x-taskboard-attachment-kind");
  if (kind !== "inline" && kind !== "attachment") {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT_KIND",
      "X-Taskboard-Attachment-Kind must be inline or attachment",
    );
  }
  return { filename, contentType, kind };
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    workspacePath: null,
    labels: JSON.parse(row.labels),
    issueCount: Number(row.issue_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function developmentContextFromRow(row) {
  if (row.development_context_type === "worktree") {
    return {
      type: "worktree",
      path: null,
      branch: row.development_branch,
    };
  }
  if (row.development_context_type === "branch") {
    return { type: "branch", branch: row.development_branch };
  }
  return null;
}

function commentConversationTitle(body) {
  const firstLine = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "评论";
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

function threadBindingFromRow(row) {
  if (
    !row.thread_id
    || !row.thread_codex_project_id
    || !row.thread_codex_project_kind
    || !row.thread_codex_host_id
    || !row.thread_workspace_path
  ) return null;
  return {
    threadId: row.thread_id,
    codexProjectId: row.thread_codex_project_id,
    codexProjectKind: row.thread_codex_project_kind,
    codexHostId: row.thread_codex_host_id,
    workspacePath: row.thread_workspace_path,
  };
}

// CWE-200: for a "local" binding, workspacePath is the creator's own absolute
// filesystem path (leaks directory structure / OS username) and codexHostId is
// always the constant "local" (no identifying value). Neither is ever read by
// any client matching logic for local bindings (only threadId is used to open
// the codex:// deep link), so redact workspacePath before it reaches the API
// response for every viewer, not just non-creators. "remote" bindings are left
// untouched: codexHostId/workspacePath there identify a shared SSH host/path
// (not an individual's own machine) and the web client relies on the real
// values, for any project collaborator, to detect whether a remote thread can
// be reopened from their own device (see openThread() in web/src/App.tsx).
function redactThreadBindingForResponse(binding) {
  if (!binding || binding.codexProjectKind !== "local") return binding;
  return { ...binding, workspacePath: null };
}

function legacyLocalThreadIdFromRow(row) {
  if (!row.thread_id) return null;
  return [
    row.thread_codex_project_id,
    row.thread_codex_project_kind,
    row.thread_codex_host_id,
    row.thread_workspace_path,
  ].every((value) => value == null)
    ? row.thread_id
    : null;
}

function storedThreadBinding(threadBinding, threadId) {
  if (threadBinding === undefined && (threadId === undefined || threadId === null)) return undefined;
  const binding = threadBinding === undefined ? { threadId } : threadBinding;
  return [
    binding?.threadId ?? null,
    binding?.codexProjectId ?? null,
    binding?.codexProjectKind ?? null,
    binding?.codexHostId ?? null,
    binding?.workspacePath ?? null,
  ];
}

function storedThreadBindingForExisting(current, threadBinding, threadId) {
  const currentBinding = threadBindingFromRow(current);
  if (
    threadBinding === undefined
    && currentBinding
    && currentBinding.threadId === threadId
  ) {
    return storedThreadBinding(currentBinding, threadId);
  }
  return storedThreadBinding(threadBinding, threadId);
}

function attachTaskActivity(task, comments, activities, previewImage = null) {
  const orderedComments = [...comments].sort((left, right) => left.id.localeCompare(right.id));
  const orderedActivities = [...activities].sort((left, right) => left.id.localeCompare(right.id));
  const participants = [];
  const participantIds = new Set();
  const addParticipant = (actor) => {
    const key = `${actor.type}:${actor.id}`;
    if (participantIds.has(key)) return;
    participantIds.add(key);
    participants.push(actor);
  };
  addParticipant({
    type: task.creatorType,
    id: task.creatorId,
    name: task.creatorName,
    avatarUrl: task.creatorAvatarUrl,
  });
  addParticipant(task.assignee);
  for (const comment of orderedComments) {
    addParticipant({
      type: comment.author_type,
      id: comment.author_id,
      name: comment.author_name,
      avatarUrl: comment.author_avatar_url,
    });
  }
  for (const activity of orderedActivities) {
    addParticipant({
      type: activity.actor_type,
      id: activity.actor_id,
      name: activity.actor_name,
      avatarUrl: activity.actor_avatar_url,
    });
  }
  task.threadBinding = redactThreadBindingForResponse(task.threadBinding);
  const conversationRefs = [];
  if (task.threadBinding) {
    conversationRefs.push({
      ...task.threadBinding,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  } else if (task.legacyLocalThreadId) {
    conversationRefs.push({
      threadId: task.legacyLocalThreadId,
      legacyLocal: true,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  }
  for (const comment of orderedComments) {
    const threadBinding = redactThreadBindingForResponse(threadBindingFromRow(comment));
    const legacyLocalThreadId = legacyLocalThreadIdFromRow(comment);
    if (threadBinding || legacyLocalThreadId) {
      conversationRefs.push({
        ...(threadBinding ?? { threadId: legacyLocalThreadId, legacyLocal: true }),
        source: "comment",
        sourceId: comment.id,
        title: commentConversationTitle(comment.body),
        updatedAt: comment.updated_at,
      });
    }
  }
  task.conversationRefs = conversationRefs;
  task.participants = participants;
  task.previewImage = previewImage;
  task.activityKey = JSON.stringify({
    version: 1,
    task: [task.id, task.version, task.updatedAt],
    comments: orderedComments.map((comment) => [comment.id, comment.version, comment.updated_at]),
    changes: orderedActivities.map((activity) => [activity.id, activity.created_at]),
  });
  task.activityUpdatedAt = [...orderedComments, ...orderedActivities].reduce(
    (latest, activity) => {
      const updatedAt = activity.updated_at ?? activity.created_at;
      return updatedAt > latest ? updatedAt : latest;
    },
    task.updatedAt,
  );
  return task;
}

function taskActivityFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorAvatarUrl: row.actor_avatar_url,
    changes: JSON.parse(row.changes),
    createdAt: row.created_at,
  };
}

function taskFieldChanges(task, changes) {
  return Object.entries(changes).flatMap(([field, after]) => {
    const before = task[field];
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ field, before, after }];
  });
}

function relationActivityValue(type, task) {
  return {
    type,
    identifier: task.identifier,
    title: task.title,
  };
}

function taskFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    developmentContext: developmentContextFromRow(row),
    startDate: row.start_date,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskRelationSummaryFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    archivedAt: row.archived_at,
  };
}

function taskTreeNode(row, parentId, depth, path) {
  return {
    id: row.id,
    parentId,
    depth,
    path,
    summary: {
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      priority: row.priority,
      archivedAt: row.archived_at,
    },
  };
}

function commentFromRow(row, attachments = []) {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attachmentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    kind: row.kind,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function projectReadmeAttachmentFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: "inline",
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

async function all(statement) {
  return (await statement.all()).results;
}

function changed(result) {
  if (typeof result?.meta?.changes !== "number") {
    throw new Error("D1 mutation did not return change metadata");
  }
  return result.meta.changes > 0;
}

// Truncation helper for single-owner queries (e.g. one task's relations/comments/activities).
// `rows` must come from a query already bound to `max + 1` (via LIMIT) so D1 never actually
// reads more than one row past the cap — see design.md "批次路徑的截斷必須發生在 SQL 層".
function capOwnRows(rows, max) {
  if (rows.length <= max) return { rows, truncated: false };
  return { rows: rows.slice(0, max), truncated: true };
}

// Truncation helper for batch queries covering many owners at once. `rows` must come from a
// query that computed `ROW_NUMBER() OVER (PARTITION BY <owner column AS owner_id> ORDER BY
// <recency> DESC) AS rn` and filtered `rn <= max + 1`, so each owner contributes at most
// `max + 1` rows to `rows` regardless of how many it actually has. `ownerIds` is the full set
// of owners this batch covers, so owners with zero matching rows still get a `{ rows: [],
// truncated: false }` entry instead of being silently absent from the returned Map.
function capRowsByOwnerId(rows, ownerIds, max) {
  const byOwnerId = new Map(ownerIds.map((ownerId) => [ownerId, { rows: [], truncated: false }]));
  for (const row of rows) {
    const entry = byOwnerId.get(row.owner_id);
    if (!entry) continue;
    if (row.rn <= max) {
      entry.rows.push(row);
    } else {
      entry.truncated = true;
    }
  }
  return byOwnerId;
}

// Re-sorts a capped relation batch's rows back into display order (tasks.sort_order,
// tasks.created_at, tasks.id) after the cap-selection query ordered them by relation recency
// instead — see design.md "截斷時的排序偏好".
function compareTaskDisplayOrder(a, b) {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function taskActivityStatement(env, taskId, actor, changes, timestamp, version) {
  return env.DB.prepare(`
    INSERT INTO task_activities (
      id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM tasks WHERE id = ? AND version = ? AND updated_at = ?
    )
  `).bind(
    uuid(),
    taskId,
    actor.type,
    actor.id,
    actor.name,
    actor.avatarUrl,
    JSON.stringify(changes),
    timestamp,
    taskId,
    version,
    timestamp,
  );
}

async function requireProject(env, id) {
  const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  if (!row) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
  }
  return row;
}

async function taskRow(env, id) {
  return env.DB.prepare(
    "SELECT * FROM tasks WHERE id = ? OR identifier = ?",
  ).bind(id, id).first();
}

async function requireTaskRow(env, id) {
  const row = await taskRow(env, id);
  if (!row) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
  return row;
}

function assertTaskVersion(row, expectedVersion) {
  if (row.version !== expectedVersion) {
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion, actualVersion: row.version },
    );
  }
}

// `capped` is required (no default) so every call site states its intent explicitly — see
// design.md's "遺漏呼叫點意外套用錯誤預設值" risk. `capped: true` truncates to
// COMMENT_ATTACHMENT_MAX_RESULTS (newest by change_revision) for hydrate/read paths;
// `capped: false` reads every attachment row, required by deleteComment() so no attachment is
// left un-cleaned in R2 once its D1 row is cascade-deleted.
async function attachmentsForComment(env, commentId, { capped }) {
  if (capped) {
    const rows = await all(
      env.DB.prepare(
        "SELECT * FROM attachments WHERE comment_id = ? ORDER BY change_revision DESC LIMIT ?",
      ).bind(commentId, COMMENT_ATTACHMENT_MAX_RESULTS + 1),
    );
    const { rows: cappedRows, truncated } = capOwnRows(rows, COMMENT_ATTACHMENT_MAX_RESULTS);
    return { attachments: cappedRows.map(attachmentFromRow), truncated };
  }
  const rows = await all(
    env.DB.prepare(
      "SELECT * FROM attachments WHERE comment_id = ? ORDER BY created_at, id",
    ).bind(commentId),
  );
  return { attachments: rows.map(attachmentFromRow), truncated: false };
}

async function attachmentsByCommentIdForTask(env, taskId, { capped }) {
  if (capped) {
    const rows = await all(env.DB.prepare(`
      SELECT * FROM (
        SELECT attachments.*, comment_id AS owner_id,
          ROW_NUMBER() OVER (PARTITION BY comment_id ORDER BY change_revision DESC) AS rn
        FROM attachments
        WHERE task_id = ? AND comment_id IS NOT NULL
      )
      WHERE rn <= ?
    `).bind(taskId, COMMENT_ATTACHMENT_MAX_RESULTS + 1));
    const ownerIds = [...new Set(rows.map((row) => row.owner_id))];
    const byOwnerId = capRowsByOwnerId(rows, ownerIds, COMMENT_ATTACHMENT_MAX_RESULTS);
    const byCommentId = new Map();
    for (const [commentId, entry] of byOwnerId) {
      byCommentId.set(commentId, {
        attachments: entry.rows.map(attachmentFromRow),
        truncated: entry.truncated,
      });
    }
    return byCommentId;
  }
  const rows = await all(
    env.DB.prepare(
      "SELECT * FROM attachments WHERE task_id = ? AND comment_id IS NOT NULL ORDER BY created_at, id",
    ).bind(taskId),
  );
  const byCommentId = new Map();
  for (const row of rows) {
    const attachment = attachmentFromRow(row);
    const entry = byCommentId.get(row.comment_id);
    if (entry) {
      entry.attachments.push(attachment);
    } else {
      byCommentId.set(row.comment_id, { attachments: [attachment], truncated: false });
    }
  }
  return byCommentId;
}

async function hydrateComment(env, row, attachmentsOverride) {
  const { attachments, truncated } = attachmentsOverride
    ?? (await attachmentsForComment(env, row.id, { capped: true }));
  const comment = commentFromRow(row, attachments);
  comment.attachmentsTruncated = truncated;
  comment.threadBinding = redactThreadBindingForResponse(comment.threadBinding);
  return comment;
}

// subIssues/blockedBy/blocks/related each fetch TASK_RELATION_MAX_RESULTS + 1 rows ordered by
// relation recency (newest first) so D1 never reads more than one row past the cap, then get
// capped and re-sorted back into display order (tasks.sort_order, tasks.created_at, tasks.id) —
// see design.md "批次路徑的截斷必須發生在 SQL 層" and "截斷時的排序偏好". `parent` has no cap:
// a task has at most one parent by construction (relation_type = 'parent' is 1:1 per target).
async function taskRelationsForRow(env, taskId) {
  const [parent, subIssuesRows, blockedByRows, blocksRows, relatedRows] = await Promise.all([
    env.DB.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `).bind(taskId).first(),
    all(env.DB.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY task_relations.created_at DESC
      LIMIT ?
    `).bind(taskId, TASK_RELATION_MAX_RESULTS + 1)),
    all(env.DB.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY task_relations.created_at DESC
      LIMIT ?
    `).bind(taskId, TASK_RELATION_MAX_RESULTS + 1)),
    all(env.DB.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY task_relations.created_at DESC
      LIMIT ?
    `).bind(taskId, TASK_RELATION_MAX_RESULTS + 1)),
    all(env.DB.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY task_relations.created_at DESC
      LIMIT ?
    `).bind(taskId, taskId, taskId, TASK_RELATION_MAX_RESULTS + 1)),
  ]);
  const subIssues = capOwnRows(subIssuesRows, TASK_RELATION_MAX_RESULTS);
  const blockedBy = capOwnRows(blockedByRows, TASK_RELATION_MAX_RESULTS);
  const blocks = capOwnRows(blocksRows, TASK_RELATION_MAX_RESULTS);
  const related = capOwnRows(relatedRows, TASK_RELATION_MAX_RESULTS);
  subIssues.rows.sort(compareTaskDisplayOrder);
  blockedBy.rows.sort(compareTaskDisplayOrder);
  blocks.rows.sort(compareTaskDisplayOrder);
  related.rows.sort(compareTaskDisplayOrder);
  return { parent, subIssues, blockedBy, blocks, related };
}

// Batch versions of taskRelationsForRow's five queries, keyed by owner task id,
// for listTasks() to fetch once per page instead of once per row (CWE-400 N+1).
async function relationParentsByTaskId(env, taskIds) {
  const parentByTaskId = new Map();
  const batches = [];
  for (let offset = 0; offset < taskIds.length; offset += 80) {
    const chunk = taskIds.slice(offset, offset + 80);
    const placeholders = chunk.map(() => "?").join(", ");
    batches.push(all(env.DB.prepare(`
      SELECT tasks.*, task_relations.target_task_id AS relation_owner_id
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id IN (${placeholders})
    `).bind(...chunk)));
  }
  for (const rows of await Promise.all(batches)) {
    for (const row of rows) {
      if (!parentByTaskId.has(row.relation_owner_id)) {
        parentByTaskId.set(row.relation_owner_id, row);
      }
    }
  }
  return parentByTaskId;
}

// Each owner's rows are capped in the SQL layer via ROW_NUMBER() OVER (PARTITION BY <owner
// column> ORDER BY task_relations.created_at DESC), filtered to rn <= TASK_RELATION_MAX_RESULTS
// + 1 so D1 never reads more than one row past the cap per owner — see design.md "批次路徑的截
// 斷必須發生在 SQL 層". capRowsByOwnerId() then does the final max-vs-(max+1) truncation, and
// each owner's surviving rows are re-sorted back into display order afterward.
async function relationSubIssuesByTaskId(env, taskIds) {
  const batches = [];
  for (let offset = 0; offset < taskIds.length; offset += 80) {
    const chunk = taskIds.slice(offset, offset + 80);
    const placeholders = chunk.map(() => "?").join(", ");
    batches.push(all(env.DB.prepare(`
      SELECT * FROM (
        SELECT tasks.*, task_relations.source_task_id AS owner_id,
          ROW_NUMBER() OVER (
            PARTITION BY task_relations.source_task_id
            ORDER BY task_relations.created_at DESC
          ) AS rn
        FROM task_relations
        JOIN tasks ON tasks.id = task_relations.target_task_id
        WHERE task_relations.relation_type = 'parent'
          AND task_relations.source_task_id IN (${placeholders})
      )
      WHERE rn <= ?
    `).bind(...chunk, TASK_RELATION_MAX_RESULTS + 1)));
  }
  const rows = (await Promise.all(batches)).flat();
  const subIssuesByTaskId = capRowsByOwnerId(rows, taskIds, TASK_RELATION_MAX_RESULTS);
  for (const entry of subIssuesByTaskId.values()) entry.rows.sort(compareTaskDisplayOrder);
  return subIssuesByTaskId;
}

async function relationBlockedByByTaskId(env, taskIds) {
  const batches = [];
  for (let offset = 0; offset < taskIds.length; offset += 80) {
    const chunk = taskIds.slice(offset, offset + 80);
    const placeholders = chunk.map(() => "?").join(", ");
    batches.push(all(env.DB.prepare(`
      SELECT * FROM (
        SELECT tasks.*, task_relations.target_task_id AS owner_id,
          ROW_NUMBER() OVER (
            PARTITION BY task_relations.target_task_id
            ORDER BY task_relations.created_at DESC
          ) AS rn
        FROM task_relations
        JOIN tasks ON tasks.id = task_relations.source_task_id
        WHERE task_relations.relation_type = 'blocks'
          AND task_relations.target_task_id IN (${placeholders})
      )
      WHERE rn <= ?
    `).bind(...chunk, TASK_RELATION_MAX_RESULTS + 1)));
  }
  const rows = (await Promise.all(batches)).flat();
  const blockedByByTaskId = capRowsByOwnerId(rows, taskIds, TASK_RELATION_MAX_RESULTS);
  for (const entry of blockedByByTaskId.values()) entry.rows.sort(compareTaskDisplayOrder);
  return blockedByByTaskId;
}

async function relationBlocksByTaskId(env, taskIds) {
  const batches = [];
  for (let offset = 0; offset < taskIds.length; offset += 80) {
    const chunk = taskIds.slice(offset, offset + 80);
    const placeholders = chunk.map(() => "?").join(", ");
    batches.push(all(env.DB.prepare(`
      SELECT * FROM (
        SELECT tasks.*, task_relations.source_task_id AS owner_id,
          ROW_NUMBER() OVER (
            PARTITION BY task_relations.source_task_id
            ORDER BY task_relations.created_at DESC
          ) AS rn
        FROM task_relations
        JOIN tasks ON tasks.id = task_relations.target_task_id
        WHERE task_relations.relation_type = 'blocks'
          AND task_relations.source_task_id IN (${placeholders})
      )
      WHERE rn <= ?
    `).bind(...chunk, TASK_RELATION_MAX_RESULTS + 1)));
  }
  const rows = (await Promise.all(batches)).flat();
  const blocksByTaskId = capRowsByOwnerId(rows, taskIds, TASK_RELATION_MAX_RESULTS);
  for (const entry of blocksByTaskId.values()) entry.rows.sort(compareTaskDisplayOrder);
  return blocksByTaskId;
}

// 'related' is undirected: a relation between two tasks belongs on both sides'
// lists. Each chunk binds taskIds twice (once as source, once as target), so
// it uses a smaller chunk size than the single-IN-clause queries above to keep
// total bound parameters per statement in the same ballpark (~80) as the rest
// of this file's batching (see relationParentsByTaskId etc., and
// taskActivityComments/taskActivitiesForTasks).
const RELATED_BATCH_CHUNK_SIZE = 40;

async function relationRelatedByTaskId(env, taskIds) {
  const batches = [];
  for (let offset = 0; offset < taskIds.length; offset += RELATED_BATCH_CHUNK_SIZE) {
    const chunk = taskIds.slice(offset, offset + RELATED_BATCH_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    // The window function needs a subquery layered on top of the UNION ALL (a window function
    // can't itself span the two UNION ALL branches), and `relation_created_at` is aliased apart
    // from `tasks.*`'s own `created_at` to avoid the two colliding.
    batches.push(all(env.DB.prepare(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY owner_id ORDER BY relation_created_at DESC
        ) AS rn
        FROM (
          SELECT tasks.*, task_relations.source_task_id AS owner_id,
            task_relations.created_at AS relation_created_at
          FROM task_relations
          JOIN tasks ON tasks.id = task_relations.target_task_id
          WHERE task_relations.relation_type = 'related'
            AND task_relations.source_task_id IN (${placeholders})
          UNION ALL
          SELECT tasks.*, task_relations.target_task_id AS owner_id,
            task_relations.created_at AS relation_created_at
          FROM task_relations
          JOIN tasks ON tasks.id = task_relations.source_task_id
          WHERE task_relations.relation_type = 'related'
            AND task_relations.target_task_id IN (${placeholders})
        )
      )
      WHERE rn <= ?
    `).bind(...chunk, ...chunk, TASK_RELATION_MAX_RESULTS + 1)));
  }
  const rows = (await Promise.all(batches)).flat();
  const relatedByTaskId = capRowsByOwnerId(rows, taskIds, TASK_RELATION_MAX_RESULTS);
  for (const entry of relatedByTaskId.values()) entry.rows.sort(compareTaskDisplayOrder);
  return relatedByTaskId;
}

async function taskRelationsByTaskId(env, taskIds) {
  const [parentByTaskId, subIssuesByTaskId, blockedByByTaskId, blocksByTaskId, relatedByTaskId] =
    await Promise.all([
      relationParentsByTaskId(env, taskIds),
      relationSubIssuesByTaskId(env, taskIds),
      relationBlockedByByTaskId(env, taskIds),
      relationBlocksByTaskId(env, taskIds),
      relationRelatedByTaskId(env, taskIds),
    ]);
  const emptyRelations = { rows: [], truncated: false };
  return new Map(taskIds.map((taskId) => [taskId, {
    parent: parentByTaskId.get(taskId) ?? null,
    subIssues: subIssuesByTaskId.get(taskId) ?? emptyRelations,
    blockedBy: blockedByByTaskId.get(taskId) ?? emptyRelations,
    blocks: blocksByTaskId.get(taskId) ?? emptyRelations,
    related: relatedByTaskId.get(taskId) ?? emptyRelations,
  }]));
}

async function hydrateTask(env, row, activityComments = null, activityChanges = null, relationsOverride = null) {
  const task = taskFromRow(row);
  const [relations, previewImageRow] = await Promise.all([
    relationsOverride ?? taskRelationsForRow(env, task.id),
    env.DB.prepare(`
      SELECT attachments.*
      FROM attachments
      JOIN tasks ON tasks.id = attachments.task_id
      WHERE attachments.task_id = ?
        AND attachments.comment_id IS NULL
        AND attachments.content_type LIKE 'image/%'
        AND instr(tasks.description, 'api/attachments/' || attachments.id || '/content') > 0
      ORDER BY attachments.created_at, attachments.id
      LIMIT 1
    `).bind(task.id).first(),
  ]);
  task.relations = {
    parent: relations.parent ? taskRelationSummaryFromRow(relations.parent) : null,
    subIssues: relations.subIssues.rows.map(taskRelationSummaryFromRow),
    subIssuesTruncated: relations.subIssues.truncated,
    blockedBy: relations.blockedBy.rows.map(taskRelationSummaryFromRow),
    blockedByTruncated: relations.blockedBy.truncated,
    blocks: relations.blocks.rows.map(taskRelationSummaryFromRow),
    blocksTruncated: relations.blocks.truncated,
    related: relations.related.rows.map(taskRelationSummaryFromRow),
    relatedTruncated: relations.related.truncated,
  };
  // ORDER BY change_revision/created_at DESC (newest first) rather than the old ORDER BY
  // id/created_at, id — so a truncated set keeps the newest rows and activityKey/
  // activityUpdatedAt (computed below by attachTaskActivity) keep advancing as new
  // comments/activities arrive, instead of freezing once a task crosses the cap — see
  // design.md "截斷時的排序偏好". attachTaskActivity re-sorts by id before use, so this only
  // affects which rows survive the cap, not display order.
  const commentsResult = activityComments ?? capOwnRows(
    await all(env.DB.prepare(`
      SELECT
        id, task_id,
        CASE WHEN thread_id IS NULL THEN NULL ELSE substr(body, 1, 512) END AS body,
        thread_id, thread_codex_project_id, thread_codex_project_kind,
        thread_codex_host_id, thread_workspace_path,
        author_type, author_id, author_name,
        author_avatar_url, version, updated_at
      FROM comments
      WHERE task_id = ?
      ORDER BY change_revision DESC
      LIMIT ?
    `).bind(task.id, COMMENT_LIST_MAX_RESULTS + 1)),
    COMMENT_LIST_MAX_RESULTS,
  );
  const activitiesResult = activityChanges ?? capOwnRows(
    await all(env.DB.prepare(`
      SELECT
        id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at
      FROM task_activities
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).bind(task.id, TASK_ACTIVITY_MAX_RESULTS + 1)),
    TASK_ACTIVITY_MAX_RESULTS,
  );
  task.commentsTruncated = commentsResult.truncated;
  task.activitiesTruncated = activitiesResult.truncated;
  return attachTaskActivity(
    task,
    commentsResult.rows,
    activitiesResult.rows,
    previewImageRow ? attachmentFromRow(previewImageRow) : null,
  );
}

async function getTask(env, id) {
  const row = await taskRow(env, id);
  return row ? hydrateTask(env, row) : null;
}

async function getTaskTree(env, id, direction, depth) {
  const root = await requireTaskRow(env, id);
  const nodes = [taskTreeNode(root, null, 0, [root.id])];
  const seen = new Set([root.id]);
  let frontier = [nodes[0]];
  const relationJoin = direction === "descendants"
    ? `
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id IN (%PLACEHOLDERS%)
    `
    : `
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id IN (%PLACEHOLDERS%)
    `;
  const parentColumn = direction === "descendants"
    ? "task_relations.source_task_id"
    : "task_relations.target_task_id";

  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const batches = [];
    for (let offset = 0; offset < frontier.length; offset += 80) {
      const chunk = frontier.slice(offset, offset + 80);
      const placeholders = chunk.map(() => "?").join(", ");
      batches.push(all(env.DB.prepare(`
        SELECT tasks.*, ${parentColumn} AS tree_parent_id
        ${relationJoin.replace("%PLACEHOLDERS%", placeholders)}
        ORDER BY tasks.sort_order, tasks.created_at, tasks.id
      `).bind(...chunk.map((node) => node.id))));
    }
    const rowsByParent = new Map();
    for (const rows of await Promise.all(batches)) {
      for (const row of rows) {
        const siblings = rowsByParent.get(row.tree_parent_id) ?? [];
        siblings.push(row);
        rowsByParent.set(row.tree_parent_id, siblings);
      }
    }
    const next = [];
    for (const parent of frontier) {
      for (const row of rowsByParent.get(parent.id) ?? []) {
        if (seen.has(row.id)) continue;
        if (nodes.length >= TASK_TREE_MAX_NODES) {
          throw new ApiError(413, "TREE_TOO_LARGE", `Task tree cannot exceed ${TASK_TREE_MAX_NODES} nodes`);
        }
        const node = taskTreeNode(row, parent.id, level, [...parent.path, row.id]);
        nodes.push(node);
        next.push(node);
        seen.add(row.id);
      }
    }
    frontier = next;
  }

  return {
    rootId: root.id,
    direction,
    depth,
    nodeCount: nodes.length,
    nodes,
  };
}

async function taskActivityComments(env, taskIds) {
  const batches = [];
  for (let offset = 0; offset < taskIds.length; offset += 80) {
    const chunk = taskIds.slice(offset, offset + 80);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    batches.push(all(env.DB.prepare(`
      SELECT * FROM (
        SELECT
          id, task_id, task_id AS owner_id,
          CASE WHEN thread_id IS NULL THEN NULL ELSE substr(body, 1, 512) END AS body,
          thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name,
          author_avatar_url, version, updated_at,
          ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY change_revision DESC) AS rn
        FROM comments
        WHERE task_id IN (${placeholders})
      )
      WHERE rn <= ?
    `).bind(...chunk, COMMENT_LIST_MAX_RESULTS + 1)));
  }
  const rows = (await Promise.all(batches)).flat();
  return capRowsByOwnerId(rows, taskIds, COMMENT_LIST_MAX_RESULTS);
}

async function taskActivitiesForTasks(env, taskIds) {
  const batches = [];
  for (let offset = 0; offset < taskIds.length; offset += 80) {
    const chunk = taskIds.slice(offset, offset + 80);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    batches.push(all(env.DB.prepare(`
      SELECT * FROM (
        SELECT *, task_id AS owner_id,
          ROW_NUMBER() OVER (
            PARTITION BY task_id ORDER BY created_at DESC, id DESC
          ) AS rn
        FROM (
          SELECT
            id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at
          FROM task_activities
          WHERE task_id IN (${placeholders})
        )
      )
      WHERE rn <= ?
    `).bind(...chunk, TASK_ACTIVITY_MAX_RESULTS + 1)));
  }
  const rows = (await Promise.all(batches)).flat();
  return capRowsByOwnerId(rows, taskIds, TASK_ACTIVITY_MAX_RESULTS);
}

function parseProjectCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["id", "name", "workspacePath"]));
  const name = stringField(body.name, "name", { required: true, maxLength: 120 });
  const id = validateProjectId(body.id ?? slugify(name));
  if (body.workspacePath !== undefined && body.workspacePath !== null) {
    const workspacePath = stringField(body.workspacePath, "workspacePath", {
      required: true,
      maxLength: 4096,
    });
    if (workspacePath.includes("\0")) {
      throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
    }
  }
  return { id, name };
}

function parseProjectLabel(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["label"]));
  return stringField(body.label, "label", { required: true, maxLength: 64 });
}

function parseTaskCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId",
    "title",
    "description",
    "status",
    "priority",
    "labels",
    "sortOrder",
    "threadId",
    "threadBinding",
    "assigneeTarget",
    "developmentContext",
    "startDate",
    "dueDate",
    "recurrence",
  ]));
  const input = {
    projectId: validateProjectId(body.projectId ?? "local"),
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    description: stringField(body.description ?? "", "description", { maxLength: 100_000 }),
    status: parseStatus(body.status, "backlog"),
    priority: parsePriority(body.priority, "none"),
    labels: body.labels === undefined ? [] : parseLabels(body.labels),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    assigneeTarget: parseAssigneeTarget(body.assigneeTarget),
    developmentContext: parseDevelopmentContext(body.developmentContext ?? null),
    startDate: parseDueDate(body.startDate ?? null, "startDate"),
    dueDate: parseDueDate(body.dueDate ?? null),
    recurrence: parseRecurrence(body.recurrence ?? null),
  };
  if (input.recurrence && !input.dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  return input;
}

function parseTaskPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version",
    "projectId",
    "title",
    "description",
    "status",
    "priority",
    "labels",
    "threadId",
    "threadBinding",
    "assigneeTarget",
    "developmentContext",
    "startDate",
    "dueDate",
    "recurrence",
  ]));
  const changes = {};
  if (body.projectId !== undefined) changes.projectId = validateProjectId(body.projectId);
  if (body.title !== undefined) {
    changes.title = stringField(body.title, "title", { required: true, maxLength: 240 });
  }
  if (body.description !== undefined) {
    changes.description = stringField(body.description, "description", { maxLength: 100_000 });
  }
  if (body.status !== undefined) changes.status = parseStatus(body.status);
  if (body.priority !== undefined) changes.priority = parsePriority(body.priority);
  if (body.labels !== undefined) changes.labels = parseLabels(body.labels);
  if (body.developmentContext !== undefined) {
    changes.developmentContext = parseDevelopmentContext(body.developmentContext);
  }
  if (body.startDate !== undefined) changes.startDate = parseDueDate(body.startDate, "startDate");
  if (body.dueDate !== undefined) changes.dueDate = parseDueDate(body.dueDate);
  if (body.recurrence !== undefined) changes.recurrence = parseRecurrence(body.recurrence);
  const assigneeTarget = parseAssigneeTarget(body.assigneeTarget);
  if (Object.keys(changes).length === 0 && assigneeTarget === undefined) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one task field");
  }
  return {
    version: parseVersion(body.version),
    changes,
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    assigneeTarget,
  };
}

function parseMove(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "status", "sortOrder", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    status: parseStatus(body.status),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseVersionMutation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseRelationOrigin(value) {
  if (value === undefined) return undefined;
  if (value !== "manual" && value !== "mention") {
    throw new ApiError(400, "INVALID_FIELD", "'origin' must be manual or mention");
  }
  return value;
}

function parseRelationMutation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding", "origin"]));
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    origin: parseRelationOrigin(body.origin),
  };
}

function parseCommentCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["body", "threadId", "threadBinding"]));
  return {
    body: stringField(body.body ?? "", "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseCommentPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "body", "threadId", "threadBinding"]));
  if (body.body === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "'body' is required");
  }
  return {
    version: parseVersion(body.version),
    body: stringField(body.body, "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseTaskFilters(searchParams) {
  const allowed = new Set(["projectId", "status", "archived"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${key}`);
    }
    if (searchParams.getAll(key).length > 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `'${key}' cannot be repeated`);
    }
  }
  const projectId = searchParams.get("projectId");
  const status = searchParams.get("status");
  const archived = searchParams.get("archived") ?? "false";
  if (projectId !== null) validateProjectId(projectId);
  if (status !== null) parseStatus(status);
  if (!["false", "true", "all"].includes(archived)) {
    throw new ApiError(
      400,
      "INVALID_QUERY_PARAMETER",
      "'archived' must be false, true, or all",
    );
  }
  return { projectId, status, archived };
}

function parseTaskTreeQuery(searchParams) {
  const allowed = new Set(["direction", "depth"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${key}`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_TREE_QUERY", `'${key}' cannot be repeated`);
    }
  }
  const direction = searchParams.get("direction");
  if (direction !== "descendants" && direction !== "ancestors") {
    throw new ApiError(400, "INVALID_TREE_QUERY", "'direction' must be descendants or ancestors");
  }
  const rawDepth = searchParams.get("depth");
  const depth = Number(rawDepth);
  if (!/^\d+$/.test(rawDepth ?? "") || !Number.isSafeInteger(depth) || depth < 1 || depth > 25) {
    throw new ApiError(400, "INVALID_TREE_QUERY", "'depth' must be an integer from 1 to 25");
  }
  return { direction, depth };
}

function parseAfterCursor(searchParams) {
  for (const key of searchParams.keys()) {
    if (key !== "after") {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${key}`);
    }
  }
  const values = searchParams.getAll("after");
  if (values.length === 0) return null;
  if (values.length !== 1) {
    throw new ApiError(400, "INVALID_CURSOR", "'after' must be provided once");
  }
  const value = values[0];
  const revision = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(revision)) {
    throw new ApiError(400, "INVALID_CURSOR", "'after' must be a non-negative decimal integer");
  }
  return { value, revision };
}

function nextCursor(rows, after) {
  if (rows.length === 0) return after?.value ?? "0";
  let revision = rows[0].change_revision;
  for (const row of rows.slice(1)) {
    if (row.change_revision > revision) revision = row.change_revision;
  }
  return String(revision);
}

async function listProjects(env) {
  const rows = await all(env.DB.prepare(`
    SELECT
      projects.id,
      projects.name,
      projects.workspace_path,
      projects.labels,
      projects.created_at,
      projects.updated_at,
      COUNT(tasks.id) AS issue_count
    FROM projects
    LEFT JOIN tasks
      ON tasks.project_id = projects.id
      AND tasks.archived_at IS NULL
    GROUP BY
      projects.id,
      projects.name,
      projects.workspace_path,
      projects.labels,
      projects.created_at,
      projects.updated_at
    ORDER BY projects.created_at, projects.id
  `));
  const truncated = rows.length > PROJECT_LIST_MAX_RESULTS;
  const page = truncated ? rows.slice(0, PROJECT_LIST_MAX_RESULTS) : rows;
  return { projects: page.map(projectFromRow), truncated };
}

async function getProject(env, id) {
  const row = await env.DB.prepare(`
    SELECT
      projects.id,
      projects.name,
      projects.workspace_path,
      projects.labels,
      projects.created_at,
      projects.updated_at,
      COUNT(tasks.id) AS issue_count
    FROM projects
    LEFT JOIN tasks
      ON tasks.project_id = projects.id
      AND tasks.archived_at IS NULL
    WHERE projects.id = ?
    GROUP BY
      projects.id,
      projects.name,
      projects.workspace_path,
      projects.labels,
      projects.created_at,
      projects.updated_at
  `).bind(id).first();
  return row ? projectFromRow(row) : null;
}

async function createProject(env, input) {
  const timestamp = now();
  try {
    await env.DB.prepare(`
      INSERT INTO projects (
        id, name, workspace_path, labels, next_task_number, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 1, ?, ?)
    `).bind(input.id, input.name, DEFAULT_PROJECT_LABELS_JSON, timestamp, timestamp).run();
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) {
      throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
    }
    throw error;
  }
  return getProject(env, input.id);
}

async function addProjectLabel(env, projectId, label) {
  await requireProject(env, projectId);
  await env.DB.prepare(`
    UPDATE projects
    SET labels = json_insert(labels, '$[#]', ?), updated_at = ?
    WHERE id = ?
      AND NOT EXISTS (
        SELECT 1 FROM json_each(projects.labels) WHERE value = ?
      )
  `).bind(label, now(), projectId, label).run();
  return getProject(env, projectId);
}

async function deleteProjectLabel(env, projectId, label) {
  await requireProject(env, projectId);
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE projects
      SET
        labels = (
          SELECT COALESCE(json_group_array(value), '[]')
          FROM json_each(projects.labels)
          WHERE value != ?
        ),
        updated_at = ?
      WHERE id = ?
        AND EXISTS (
          SELECT 1 FROM json_each(projects.labels) WHERE value = ?
        )
    `).bind(label, timestamp, projectId, label),
    env.DB.prepare(`
      UPDATE tasks
      SET
        labels = (
          SELECT COALESCE(json_group_array(value), '[]')
          FROM json_each(tasks.labels)
          WHERE value != ?
        ),
        version = version + 1,
        updated_at = ?
      WHERE project_id = ?
        AND EXISTS (
          SELECT 1 FROM json_each(tasks.labels) WHERE value = ?
        )
    `).bind(label, timestamp, projectId, label),
  ]);
  return getProject(env, projectId);
}

async function collectProjectReadmeAttachmentIds(env, projectId) {
  const ids = [];
  let cursor = "";
  for (;;) {
    const page = await all(env.DB.prepare(`
      SELECT id FROM project_readme_attachments
      WHERE project_id = ? AND id > ?
      ORDER BY id
      LIMIT ?
    `).bind(projectId, cursor, ATTACHMENT_DELETE_PAGE_SIZE));
    if (page.length === 0) return ids;
    for (const row of page) ids.push(row.id);
    cursor = page[page.length - 1].id;
    if (page.length < ATTACHMENT_DELETE_PAGE_SIZE) return ids;
  }
}

async function deleteProject(env, id) {
  const project = await getProject(env, id);
  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
  }
  if (!id.startsWith("temp-")) {
    throw new ApiError(403, "PROJECT_DELETE_FORBIDDEN", "Only manually created projects can be deleted");
  }
  // Read before pagination begins so the DELETE's guard subquery below can detect *any*
  // attachment-set change (insert, delete, or a net-zero mix of both) between id collection and
  // delete time, not just a count mismatch — see design.md's attachment_revision guard decision.
  // getProject() above returns a public-field subset, so this needs its own small query rather
  // than reusing that call's row.
  const revisionAtStart = await env.DB.prepare(
    "SELECT attachment_revision FROM projects WHERE id = ?",
  ).bind(id).first("attachment_revision");
  // Collected before the DELETE so every attachment id is known ahead of the CASCADE that
  // will wipe project_readme_attachments rows; the revision guard below re-checks the counter
  // atomically inside the DELETE's WHERE clause, so the delete only proceeds if the attachment
  // set collected here is still exactly what exists (no attachment mutated concurrently after
  // we finished paging) — otherwise it safely no-ops and the caller gets a retryable error
  // instead of an R2 object being orphaned by an untracked id.
  const attachmentIds = await collectProjectReadmeAttachmentIds(env, id);
  if (env.RACE_TEST_HOOK) {
    await env.RACE_TEST_HOOK.fetch("http://race-test-hook/after-collect");
  }
  const result = await env.DB.prepare(`
    DELETE FROM projects
    WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = ?)
      AND (SELECT attachment_revision FROM projects WHERE id = ?) = ?
  `).bind(id, id, id, revisionAtStart).run();
  if (!changed(result)) {
    const issueCount = Number(await env.DB.prepare(`
      SELECT COUNT(*) AS issue_count FROM tasks WHERE project_id = ?
    `).bind(id).first("issue_count"));
    if (issueCount > 0) {
      throw new ApiError(409, "PROJECT_NOT_EMPTY", "Project still contains issues", { issueCount });
    }
    throw new ApiError(
      409,
      "PROJECT_ATTACHMENTS_CHANGED",
      "Project's README attachments changed while deleting; retry the request",
    );
  }
  await Promise.all(attachmentIds.map((attachmentId) => env.ATTACHMENTS.delete(attachmentId)));
  return project;
}

async function listTasks(env, filters) {
  const where = [];
  const values = [];
  if (filters.projectId) {
    where.push("project_id = ?");
    values.push(filters.projectId);
  }
  if (filters.status) {
    where.push("status = ?");
    values.push(filters.status);
  }
  if (filters.archived === "false") {
    where.push("archived_at IS NULL");
  } else if (filters.archived === "true") {
    where.push("archived_at IS NOT NULL");
  }
  const rows = await all(
    env.DB.prepare(`
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'backlog' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'in_progress' THEN 3
          WHEN 'in_review' THEN 4
          WHEN 'blocked' THEN 5
          WHEN 'done' THEN 6
          WHEN 'canceled' THEN 7
        END,
        sort_order,
        created_at,
        id
    `).bind(...values),
  );
  if (rows.length > TASK_LIST_MAX_RESULTS) {
    throw new ApiError(
      413,
      "TASK_LIST_TOO_LARGE",
      `Task list cannot exceed ${TASK_LIST_MAX_RESULTS} results; narrow the query with projectId or status`,
    );
  }
  const taskIds = rows.map((row) => row.id);
  const [commentsByTask, activitiesByTask, relationsByTaskId] = await Promise.all([
    taskActivityComments(env, taskIds),
    taskActivitiesForTasks(env, taskIds),
    taskRelationsByTaskId(env, taskIds),
  ]);
  const emptyHydrationResult = { rows: [], truncated: false };
  return Promise.all(rows.map((row) => hydrateTask(
    env,
    row,
    commentsByTask.get(row.id) ?? emptyHydrationResult,
    activitiesByTask.get(row.id) ?? emptyHydrationResult,
    relationsByTaskId.get(row.id),
  )));
}

async function createTask(env, input, actor) {
  const project = await env.DB.prepare(`
    SELECT
      projects.id,
      projects.name,
      (
        SELECT tasks.identifier
        FROM tasks
        WHERE tasks.project_id = projects.id
        ORDER BY tasks.created_at, tasks.id
        LIMIT 1
      ) AS first_identifier
    FROM projects
    WHERE projects.id = ?
  `).bind(input.projectId).first();
  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
  }
  const prefix = projectPrefix(project);
  const suffixStart = prefix.length + 2;
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const row = await env.DB.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) AS maximum
      FROM tasks
      WHERE project_id = ? AND status = ? AND archived_at IS NULL
    `).bind(input.projectId, input.status).first();
    sortOrder = row.maximum + 1000;
  }
  const id = uuid();
  const timestamp = now();
  const assignee = resolveAssignee(input.assigneeTarget, actor);
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO tasks (
        id, identifier, project_id, title, description, status, priority, labels,
        sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
        thread_codex_host_id, thread_workspace_path,
        creator_type, creator_id, creator_name, creator_avatar_url,
        assignee_type, assignee_id, assignee_name, assignee_avatar_url,
        development_context_type, development_branch,
        start_date, due_date, recurrence_interval, recurrence_unit,
        archived_at, version, created_at, updated_at
      )
      SELECT
        ?,
        ? || '-' || CAST(MAX(
          projects.next_task_number,
          COALESCE((
            SELECT MAX(CAST(substr(tasks.identifier, ?) AS INTEGER)) + 1
            FROM tasks
            WHERE tasks.identifier GLOB ?
          ), 1)
        ) AS TEXT),
        projects.id,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        NULL, 1, ?, ?
      FROM projects
      WHERE projects.id = ?
    `).bind(
      id,
      prefix,
      suffixStart,
      `${prefix}-[0-9]*`,
      input.title,
      input.description,
      input.status,
      input.priority,
      JSON.stringify(input.labels),
      sortOrder,
      ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
      actor.type,
      actor.id,
      actor.name,
      actor.avatarUrl,
      assignee.type,
      assignee.id,
      assignee.name,
      assignee.avatarUrl,
      input.developmentContext?.type ?? null,
      input.developmentContext?.branch ?? null,
      input.startDate,
      input.dueDate,
      input.recurrence?.interval ?? null,
      input.recurrence?.unit ?? null,
      timestamp,
      timestamp,
      input.projectId,
    ),
    env.DB.prepare(`
      UPDATE projects
      SET
        next_task_number = (
          SELECT CAST(substr(identifier, ?) AS INTEGER) + 1
          FROM tasks
          WHERE id = ?
        ),
        labels = (
          SELECT json_group_array(value)
          FROM (
            SELECT value
            FROM (
              SELECT
                value,
                source_order,
                label_order,
                ROW_NUMBER() OVER (
                  PARTITION BY value
                  ORDER BY source_order, label_order
                ) AS occurrence_rank
              FROM (
                SELECT value, 0 AS source_order, key AS label_order
                FROM json_each(projects.labels)
                UNION ALL
                SELECT value, 1 AS source_order, key AS label_order
                FROM json_each(?)
              )
            )
            WHERE occurrence_rank = 1
            ORDER BY source_order, label_order
          )
        ),
        updated_at = ?
      WHERE id = ?
    `).bind(
      suffixStart,
      id,
      JSON.stringify(input.labels),
      timestamp,
      input.projectId,
    ),
  ]);
  if (!changed(results[0]) || !changed(results[1])) {
    throw new ApiError(
      404,
      "PROJECT_NOT_FOUND",
      `Project '${input.projectId}' does not exist`,
    );
  }
  return getTask(env, id);
}

async function updateTask(env, id, input, actor) {
  const current = await requireTaskRow(env, id);
  assertTaskVersion(current, input.version);
  const currentTask = taskFromRow(current);
  const targetProject = Object.hasOwn(input.changes, "projectId")
    ? await requireProject(env, input.changes.projectId)
    : null;
  const projectChanged = Boolean(targetProject && targetProject.id !== currentTask.projectId);
  const destinationProjectId = targetProject?.id ?? currentTask.projectId;
  const taskLabels = Object.hasOwn(input.changes, "labels")
    ? input.changes.labels
    : currentTask.labels;
  if (projectChanged) {
    const relation = await env.DB.prepare(`
      SELECT 1
      FROM task_relations
      WHERE source_task_id = ? OR target_task_id = ?
      LIMIT 1
    `).bind(current.id, current.id).first();
    if (relation) {
      throw new ApiError(
        409,
        "CROSS_PROJECT_RELATION",
        "Remove issue relations before moving the issue to another project",
      );
    }
  }
  const activityValues = { ...input.changes };
  const dueDate = Object.hasOwn(input.changes, "dueDate")
    ? input.changes.dueDate
    : currentTask.dueDate;
  const recurrence = Object.hasOwn(input.changes, "recurrence")
    ? input.changes.recurrence
    : currentTask.recurrence;
  if (recurrence && !dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
  }

  const assignments = [];
  const values = [];
  const columns = {
    projectId: "project_id",
    title: "title",
    description: "description",
    status: "status",
    priority: "priority",
    labels: "labels",
    startDate: "start_date",
    dueDate: "due_date",
  };
  for (const [key, value] of Object.entries(input.changes)) {
    if (key === "developmentContext") {
      assignments.push("development_context_type = ?", "development_branch = ?");
      values.push(value?.type ?? null, value?.branch ?? null);
    } else if (key === "recurrence") {
      assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
      values.push(value?.interval ?? null, value?.unit ?? null);
    } else {
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "labels" ? JSON.stringify(value) : value);
    }
  }
  const statusChanged = Object.hasOwn(input.changes, "status")
    && input.changes.status !== currentTask.status;
  if (statusChanged) {
    const placementProjectId = projectChanged ? targetProject.id : currentTask.projectId;
    const row = await env.DB.prepare(`
      SELECT MIN(sort_order) AS minimum
      FROM tasks
      WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
    `).bind(placementProjectId, input.changes.status, current.id).first();
    assignments.push("sort_order = ?");
    values.push(row?.minimum == null ? 1000 : row.minimum - 1000);
  }
  if (input.assigneeTarget !== undefined) {
    const assignee = resolveAssignee(input.assigneeTarget, actor);
    activityValues.assignee = assignee;
    assignments.push(
      "assignee_type = ?",
      "assignee_id = ?",
      "assignee_name = ?",
      "assignee_avatar_url = ?",
    );
    values.push(assignee.type, assignee.id, assignee.name, assignee.avatarUrl);
  }
  const storedBinding = storedThreadBindingForExisting(current, input.threadBinding, input.threadId);
  if (storedBinding && !Object.hasOwn(input.changes, "projectId")) {
    assignments.push(
      "thread_id = ?",
      "thread_codex_project_id = ?",
      "thread_codex_project_kind = ?",
      "thread_codex_host_id = ?",
      "thread_workspace_path = ?",
    );
    values.push(...storedBinding);
  }
  assignments.push("version = version + 1", "updated_at = ?");
  const timestamp = now();
  values.push(timestamp, current.id, input.version);
  if (projectChanged) values.push(current.id, current.id);
  const relationGuard = projectChanged
    ? " AND NOT EXISTS (SELECT 1 FROM task_relations WHERE source_task_id = ? OR target_task_id = ?)"
    : "";
  const statements = [env.DB.prepare(`
    UPDATE tasks
    SET ${assignments.join(", ")}
    WHERE id = ? AND version = ?${relationGuard}
  `).bind(...values)];
  const activityChanges = taskFieldChanges(currentTask, activityValues);
  if (activityChanges.length > 0) {
    statements.push(taskActivityStatement(
      env,
      current.id,
      actor,
      activityChanges,
      timestamp,
      input.version + 1,
    ));
  }
  if (projectChanged) {
    statements.push(env.DB.prepare(`
      UPDATE projects
      SET updated_at = ?
      WHERE id IN (?, ?)
        AND EXISTS (
          SELECT 1 FROM tasks WHERE id = ? AND version = ? AND updated_at = ?
        )
    `).bind(
      timestamp,
      currentTask.projectId,
      targetProject.id,
      current.id,
      input.version + 1,
      timestamp,
    ));
  }
  if (taskLabels.length > 0) {
    statements.push(env.DB.prepare(`
      UPDATE projects
      SET
        labels = (
          SELECT json_group_array(value)
          FROM (
            SELECT value
            FROM (
              SELECT
                value,
                source_order,
                label_order,
                ROW_NUMBER() OVER (
                  PARTITION BY value
                  ORDER BY source_order, label_order
                ) AS occurrence_rank
              FROM (
                SELECT value, 0 AS source_order, key AS label_order
                FROM json_each(projects.labels)
                UNION ALL
                SELECT value, 1 AS source_order, key AS label_order
                FROM json_each(?)
              )
            )
            WHERE occurrence_rank = 1
            ORDER BY source_order, label_order
          )
        ),
        updated_at = ?
      WHERE id = ?
        AND EXISTS (
          SELECT 1 FROM tasks WHERE id = ? AND version = ? AND updated_at = ?
        )
        AND EXISTS (
          SELECT 1
          FROM json_each(?) AS task_labels
          WHERE NOT EXISTS (
            SELECT 1
            FROM json_each(projects.labels) AS project_labels
            WHERE project_labels.value = task_labels.value
          )
        )
    `).bind(
      JSON.stringify(taskLabels),
      timestamp,
      destinationProjectId,
      current.id,
      input.version + 1,
      timestamp,
      JSON.stringify(taskLabels),
    ));
  }
  const results = await env.DB.batch(statements);
  if (!changed(results[0])) {
    if (projectChanged) {
      const relation = await env.DB.prepare(`
        SELECT 1
        FROM task_relations
        WHERE source_task_id = ? OR target_task_id = ?
        LIMIT 1
      `).bind(current.id, current.id).first();
      if (relation) {
        throw new ApiError(
          409,
          "CROSS_PROJECT_RELATION",
          "Remove issue relations before moving the issue to another project",
        );
      }
    }
    const latest = await requireTaskRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return getTask(env, current.id);
}

async function moveTask(env, id, input, actor) {
  const current = await requireTaskRow(env, id);
  assertTaskVersion(current, input.version);
  if (current.archived_at !== null) {
    throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
  }
  let sortOrder = input.sortOrder;
  if (input.status !== current.status && sortOrder === undefined) {
    const row = await env.DB.prepare(`
      SELECT MIN(sort_order) AS minimum
      FROM tasks
      WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
    `).bind(current.project_id, input.status, current.id).first();
    sortOrder = row?.minimum == null ? 1000 : row.minimum - 1000;
  } else if (sortOrder === undefined) {
    const row = await env.DB.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) AS maximum
      FROM tasks
      WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
    `).bind(current.project_id, input.status, current.id).first();
    sortOrder = row.maximum + 1000;
  }
  const timestamp = now();
  const storedBinding = storedThreadBindingForExisting(current, input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  const statements = [env.DB.prepare(`
    UPDATE tasks
    SET
      status = ?,
      sort_order = ?,
      ${threadAssignment}
      version = version + 1,
      updated_at = ?
    WHERE id = ? AND version = ?
  `).bind(
    input.status,
    sortOrder,
    ...(storedBinding ?? []),
    timestamp,
    current.id,
    input.version,
  )];
  const activityChanges = taskFieldChanges(taskFromRow(current), { status: input.status });
  if (activityChanges.length > 0) {
    statements.push(taskActivityStatement(
      env,
      current.id,
      actor,
      activityChanges,
      timestamp,
      input.version + 1,
    ));
  }
  const results = await env.DB.batch(statements);
  if (!changed(results[0])) {
    const latest = await requireTaskRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return getTask(env, current.id);
}

async function archiveTask(env, id, input, actor) {
  const current = await requireTaskRow(env, id);
  assertTaskVersion(current, input.version);
  const timestamp = now();
  const storedBinding = storedThreadBindingForExisting(current, input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  const results = await env.DB.batch([env.DB.prepare(`
    UPDATE tasks
    SET
      archived_at = ?,
      ${threadAssignment}
      version = version + 1,
      updated_at = ?
    WHERE id = ? AND version = ?
  `).bind(timestamp, ...(storedBinding ?? []), timestamp, current.id, input.version),
  taskActivityStatement(
    env,
    current.id,
    actor,
    [{ field: "archivedAt", before: current.archived_at, after: timestamp }],
    timestamp,
    input.version + 1,
  )]);
  if (!changed(results[0])) {
    const latest = await requireTaskRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return getTask(env, current.id);
}

async function restoreTask(env, id, input, actor) {
  const current = await requireTaskRow(env, id);
  assertTaskVersion(current, input.version);
  if (current.archived_at === null) {
    throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
  }
  const timestamp = now();
  const storedBinding = storedThreadBindingForExisting(current, input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  const results = await env.DB.batch([env.DB.prepare(`
    UPDATE tasks
    SET
      archived_at = NULL,
      ${threadAssignment}
      version = version + 1,
      updated_at = ?
    WHERE id = ? AND version = ?
  `).bind(...(storedBinding ?? []), timestamp, current.id, input.version),
  taskActivityStatement(
    env,
    current.id,
    actor,
    [{ field: "archivedAt", before: current.archived_at, after: null }],
    timestamp,
    input.version + 1,
  )]);
  if (!changed(results[0])) {
    const latest = await requireTaskRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return getTask(env, current.id);
}

async function collectTaskAttachmentIds(env, taskId) {
  const ids = [];
  let cursor = "";
  for (;;) {
    const page = await all(env.DB.prepare(`
      SELECT id FROM attachments
      WHERE task_id = ? AND id > ?
      ORDER BY id
      LIMIT ?
    `).bind(taskId, cursor, ATTACHMENT_DELETE_PAGE_SIZE));
    if (page.length === 0) return ids;
    for (const row of page) ids.push(row.id);
    cursor = page[page.length - 1].id;
    if (page.length < ATTACHMENT_DELETE_PAGE_SIZE) return ids;
  }
}

async function deleteArchivedTask(env, id, expectedVersion) {
  const current = await requireTaskRow(env, id);
  assertTaskVersion(current, expectedVersion);
  if (current.archived_at === null) {
    throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be deleted");
  }
  // requireTaskRow() is a `SELECT *`, so current.attachment_revision is already available here
  // without a dedicated query — unlike deleteProject(), which needs one because getProject()
  // returns a public-field subset. If requireTaskRow() is ever narrowed to a column subset,
  // this needs to gain attachment_revision back explicitly.
  const revisionAtStart = current.attachment_revision;
  // See collectProjectReadmeAttachmentIds()'s sibling comment in deleteProject(): the revision
  // guard in the DELETE's WHERE clause re-checks the counter atomically at delete time, so a
  // concurrently-mutated attachment set aborts the delete (retryable) instead of being silently
  // orphaned in R2 once the CASCADE removes rows from `attachments`.
  const attachmentIds = await collectTaskAttachmentIds(env, current.id);
  if (env.RACE_TEST_HOOK) {
    await env.RACE_TEST_HOOK.fetch("http://race-test-hook/after-collect");
  }
  const result = await env.DB.prepare(`
    DELETE FROM tasks
    WHERE id = ? AND version = ? AND archived_at IS NOT NULL
      AND (SELECT attachment_revision FROM tasks WHERE id = ?) = ?
  `).bind(current.id, expectedVersion, current.id, revisionAtStart).run();
  if (!changed(result)) {
    const latest = await requireTaskRow(env, current.id);
    assertTaskVersion(latest, expectedVersion);
    if (latest.archived_at === null) {
      throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be deleted");
    }
    throw new ApiError(
      409,
      "TASK_ATTACHMENTS_CHANGED",
      "Task's attachments changed while deleting; retry the request",
    );
  }
  await Promise.all(attachmentIds.map((attachmentId) => env.ATTACHMENTS.delete(attachmentId)));
}

function relationEndpoints(type, taskId, relatedTaskId) {
  if (type === "parent") {
    return {
      relationType: "parent",
      sourceTaskId: relatedTaskId,
      targetTaskId: taskId,
    };
  }
  if (type === "blocks") {
    return {
      relationType: "blocks",
      sourceTaskId: taskId,
      targetTaskId: relatedTaskId,
    };
  }
  if (type === "blocked_by") {
    return {
      relationType: "blocks",
      sourceTaskId: relatedTaskId,
      targetTaskId: taskId,
    };
  }
  if (type === "related") {
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }
  throw new ApiError(
    400,
    "INVALID_FIELD",
    "'relation type' must be parent, blocks, blocked_by, or related",
  );
}

async function assertRelationTasks(env, taskId, relatedTaskId, expectedVersion) {
  const task = await requireTaskRow(env, taskId);
  const relatedTask = await requireTaskRow(env, relatedTaskId);
  assertTaskVersion(task, expectedVersion);
  if (task.id === relatedTask.id) {
    throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
  }
  if (task.project_id !== relatedTask.project_id) {
    throw new ApiError(
      400,
      "CROSS_PROJECT_RELATION",
      "Issue relations must stay within one project",
    );
  }
  return { task, relatedTask };
}

async function addRelation(env, taskId, type, relatedTaskId, input, actor) {
  const { task, relatedTask } = await assertRelationTasks(
    env,
    taskId,
    relatedTaskId,
    input.version,
  );
  const endpoints = relationEndpoints(type, task.id, relatedTask.id);
  const timestamp = now();
  const storedBinding = storedThreadBindingForExisting(task, input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  let previousRelation = null;
  const statements = [];
  if (endpoints.relationType === "parent") {
    const cycle = await env.DB.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 AS found FROM ancestors WHERE id = ?
    `).bind(relatedTask.id, task.id).first();
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
    const existing = await env.DB.prepare(`
      SELECT source_task_id
      FROM task_relations
      WHERE relation_type = 'parent' AND target_task_id = ?
    `).bind(task.id).first();
    if (existing?.source_task_id === relatedTask.id) {
      throw new ApiError(409, "RELATION_EXISTS", "This parent relation already exists");
    }
    if (existing) {
      const previousParent = await requireTaskRow(env, existing.source_task_id);
      previousRelation = relationActivityValue(type, taskFromRow(previousParent));
      statements.push(
        env.DB.prepare(`
          DELETE FROM task_relations
          WHERE relation_type = 'parent'
            AND target_task_id = ?
            AND EXISTS (
              SELECT 1 FROM tasks WHERE id = ? AND version = ?
            )
        `).bind(task.id, task.id, input.version),
      );
    }
  } else {
    const existing = await env.DB.prepare(`
      SELECT 1 AS found
      FROM task_relations
      WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
    `).bind(
      endpoints.relationType,
      endpoints.sourceTaskId,
      endpoints.targetTaskId,
    ).first();
    if (existing) {
      throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
    }
  }
  statements.push(
    env.DB.prepare(`
      INSERT INTO task_relations (
        relation_type, source_task_id, target_task_id, origin, created_at
      )
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM tasks WHERE id = ? AND version = ?
      )
    `).bind(
      endpoints.relationType,
      endpoints.sourceTaskId,
      endpoints.targetTaskId,
      input.origin ?? "manual",
      timestamp,
      task.id,
      input.version,
    ),
    env.DB.prepare(`
      UPDATE tasks
      SET
        ${threadAssignment}
        version = version + 1,
        updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(...(storedBinding ?? []), timestamp, task.id, input.version),
  );
  const taskUpdateIndex = statements.length - 1;
  statements.push(taskActivityStatement(
    env,
    task.id,
    actor,
    [{
      field: "relation",
      before: previousRelation,
      after: relationActivityValue(type, taskFromRow(relatedTask)),
    }],
    timestamp,
    input.version + 1,
  ));
  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    const message = String(error.message);
    if (message.includes("CROSS_PROJECT_RELATION")) {
      throw new ApiError(
        400,
        "CROSS_PROJECT_RELATION",
        "Issue relations must stay within one project",
      );
    }
    if (message.includes("RELATION_CYCLE")) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
    if (
      message.includes("UNIQUE constraint failed")
      && message.includes("task_relations")
    ) {
      throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
    }
    throw error;
  }
  if (!changed(results[taskUpdateIndex])) {
    const latest = await requireTaskRow(env, task.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return {
    task: await getTask(env, task.id),
    relatedTask: await getTask(env, relatedTask.id),
  };
}

async function removeRelation(env, taskId, type, relatedTaskId, input, actor) {
  const { task, relatedTask } = await assertRelationTasks(
    env,
    taskId,
    relatedTaskId,
    input.version,
  );
  const endpoints = relationEndpoints(type, task.id, relatedTask.id);
  const relation = await env.DB.prepare(`
    SELECT origin
    FROM task_relations
    WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
  `).bind(
    endpoints.relationType,
    endpoints.sourceTaskId,
    endpoints.targetTaskId,
  ).first();
  if (!relation) {
    throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
  }
  if (input.origin && relation.origin !== input.origin) {
    return {
      task: await getTask(env, task.id),
      relatedTask: await getTask(env, relatedTask.id),
    };
  }
  const timestamp = now();
  const storedBinding = storedThreadBindingForExisting(task, input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  const mentionRemoval = input.origin === "mention"
    && endpoints.relationType === "related";
  const taskReference = `](?${new URLSearchParams({
    project: task.project_id,
    issue: relatedTask.identifier,
  })})`;
  const relatedTaskReference = `](?${new URLSearchParams({
    project: task.project_id,
    issue: task.identifier,
  })})`;
  const deleteStatement = mentionRemoval
    ? env.DB.prepare(`
      DELETE FROM task_relations
      WHERE relation_type = ?
        AND source_task_id = ?
        AND target_task_id = ?
        AND origin = 'mention'
        AND EXISTS (
          SELECT 1 FROM tasks WHERE id = ? AND version = ?
        )
        AND NOT EXISTS (
          SELECT 1
          FROM tasks
          WHERE (id = ? AND instr(description, ?) > 0)
            OR (id = ? AND instr(description, ?) > 0)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM comments
          WHERE (task_id = ? AND instr(body, ?) > 0)
            OR (task_id = ? AND instr(body, ?) > 0)
        )
    `).bind(
      endpoints.relationType,
      endpoints.sourceTaskId,
      endpoints.targetTaskId,
      task.id,
      input.version,
      task.id,
      taskReference,
      relatedTask.id,
      relatedTaskReference,
      task.id,
      taskReference,
      relatedTask.id,
      relatedTaskReference,
    )
    : env.DB.prepare(`
      DELETE FROM task_relations
      WHERE relation_type = ?
        AND source_task_id = ?
        AND target_task_id = ?
        AND EXISTS (
          SELECT 1 FROM tasks WHERE id = ? AND version = ?
        )
    `).bind(
      endpoints.relationType,
      endpoints.sourceTaskId,
      endpoints.targetTaskId,
      task.id,
      input.version,
    );
  const results = await env.DB.batch([
    deleteStatement,
    env.DB.prepare(`
      UPDATE tasks
      SET
        ${threadAssignment}
        version = version + 1,
        updated_at = ?
      WHERE id = ? AND version = ?${mentionRemoval ? " AND changes() = 1" : ""}
    `).bind(...(storedBinding ?? []), timestamp, task.id, input.version),
    taskActivityStatement(
      env,
      task.id,
      actor,
      [{
        field: "relation",
        before: relationActivityValue(type, taskFromRow(relatedTask)),
        after: null,
      }],
      timestamp,
      input.version + 1,
    ),
  ]);
  if (!changed(results[1])) {
    const latest = await requireTaskRow(env, task.id);
    if (mentionRemoval && latest.version === input.version) {
      return {
        task: await getTask(env, task.id),
        relatedTask: await getTask(env, relatedTask.id),
      };
    }
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return {
    task: await getTask(env, task.id),
    relatedTask: await getTask(env, relatedTask.id),
  };
}

async function getProjectReadme(env, projectId) {
  const project = await getProject(env, projectId);
  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
  }
  const row = await env.DB.prepare(`
    SELECT project_id, content, version, created_at, updated_at
    FROM project_readmes
    WHERE project_id = ?
  `).bind(projectId).first();
  return row
    ? {
      projectId: row.project_id,
      content: row.content,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    : { projectId, content: "", version: 0, createdAt: null, updatedAt: null };
}

async function saveProjectReadme(env, projectId, content, expectedVersion) {
  const project = await getProject(env, projectId);
  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
  }
  const timestamp = now();
  if (expectedVersion === undefined) {
    await env.DB.prepare(`
      INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        content = excluded.content,
        version = project_readmes.version + 1,
        updated_at = excluded.updated_at
    `).bind(projectId, content, timestamp, timestamp).run();
    return getProjectReadme(env, projectId);
  }
  const current = await env.DB.prepare(`
    SELECT version FROM project_readmes WHERE project_id = ?
  `).bind(projectId).first();
  if (expectedVersion !== undefined) {
    const actualVersion = current?.version ?? 0;
    if (actualVersion !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Project README changed since it was last read", {
        expectedVersion,
        actualVersion,
      });
    }
  }
  if (current) {
    const versionCondition = expectedVersion !== undefined ? " AND version = ?" : "";
    const params = expectedVersion !== undefined
      ? [content, timestamp, projectId, expectedVersion]
      : [content, timestamp, projectId];
    const result = await env.DB.prepare(`
      UPDATE project_readmes
      SET content = ?, version = version + 1, updated_at = ?
      WHERE project_id = ?${versionCondition}
    `).bind(...params).run();
    if (!changed(result)) {
      const latest = await env.DB.prepare(`
        SELECT version FROM project_readmes WHERE project_id = ?
      `).bind(projectId).first();
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "Project README changed since it was last read",
        { expectedVersion, actualVersion: latest?.version ?? 0 },
      );
    }
  } else {
    try {
      await env.DB.prepare(`
        INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `).bind(projectId, content, timestamp, timestamp).run();
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        const latest = await env.DB.prepare(`
          SELECT version FROM project_readmes WHERE project_id = ?
        `).bind(projectId).first();
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "Project README changed since it was last read",
          { expectedVersion, actualVersion: latest?.version ?? 0 },
        );
      }
      throw error;
    }
  }
  return getProjectReadme(env, projectId);
}

async function listTaskActivities(env, taskId) {
  const task = await requireTaskRow(env, taskId);
  const rows = await all(env.DB.prepare(`
    SELECT * FROM task_activities
    WHERE task_id = ?
    ORDER BY created_at, id
  `).bind(task.id));
  return rows.map(taskActivityFromRow);
}

async function listComments(env, taskId) {
  const task = await requireTaskRow(env, taskId);
  const rows = await all(env.DB.prepare(`
    SELECT * FROM comments
    WHERE task_id = ?
    ORDER BY created_at, id
  `).bind(task.id));
  if (rows.length > COMMENT_LIST_MAX_RESULTS) {
    throw new ApiError(
      413,
      "COMMENT_LIST_TOO_LARGE",
      `Comment list cannot exceed ${COMMENT_LIST_MAX_RESULTS} results; use the ?after= cursor to page incrementally`,
    );
  }
  const attachmentsByCommentId = await attachmentsByCommentIdForTask(env, task.id, { capped: true });
  const emptyAttachments = { attachments: [], truncated: false };
  return {
    comments: await Promise.all(
      rows.map((row) => hydrateComment(env, row, attachmentsByCommentId.get(row.id) ?? emptyAttachments)),
    ),
    nextCursor: nextCursor(rows, null),
  };
}

async function listCommentsAfter(env, taskId, after) {
  const task = await requireTaskRow(env, taskId);
  const rows = await all(env.DB.prepare(`
    SELECT * FROM comments
    WHERE task_id = ?
      AND change_revision > ?
    ORDER BY change_revision
  `).bind(task.id, after.revision));
  if (rows.length > COMMENT_LIST_MAX_RESULTS) {
    throw new ApiError(
      413,
      "COMMENT_LIST_TOO_LARGE",
      `Comment list cannot exceed ${COMMENT_LIST_MAX_RESULTS} results since the given cursor; the task has too many changes to page from this position`,
    );
  }
  const attachmentsByCommentId = await attachmentsByCommentIdForTask(env, task.id, { capped: true });
  const emptyAttachments = { attachments: [], truncated: false };
  return {
    comments: await Promise.all(
      rows.map((row) => hydrateComment(env, row, attachmentsByCommentId.get(row.id) ?? emptyAttachments)),
    ),
    nextCursor: nextCursor(rows, after),
  };
}

async function createComment(env, taskId, input, actor) {
  const task = await requireTaskRow(env, taskId);
  const id = uuid();
  const timestamp = now();
  await env.DB.prepare(`
    INSERT INTO comments (
      id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
      thread_codex_host_id, thread_workspace_path, author_type, author_id, author_name,
      author_avatar_url, version, created_at, updated_at, change_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?,
      (SELECT revision + 1 FROM global_revision WHERE singleton = 1))
  `).bind(
    id,
    task.id,
    input.body,
    ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
    actor.type,
    actor.id,
    actor.name,
    actor.avatarUrl,
    timestamp,
    timestamp,
  ).run();
  const row = await env.DB.prepare("SELECT * FROM comments WHERE id = ?").bind(id).first();
  return hydrateComment(env, row);
}

async function requireCommentRow(env, id) {
  const row = await env.DB.prepare("SELECT * FROM comments WHERE id = ?").bind(id).first();
  if (!row) {
    throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
  }
  return row;
}

function assertCommentVersion(row, expectedVersion) {
  if (row.version !== expectedVersion) {
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Comment was changed by another client",
      { expectedVersion, actualVersion: row.version },
    );
  }
}

async function updateComment(env, id, input) {
  const current = await requireCommentRow(env, id);
  assertCommentVersion(current, input.version);
  const storedBinding = storedThreadBinding(input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  const result = await env.DB.prepare(`
    UPDATE comments
    SET
      body = ?,
      ${threadAssignment}
      version = version + 1,
      updated_at = ?,
      change_revision = (SELECT revision + 1 FROM global_revision WHERE singleton = 1)
    WHERE id = ? AND version = ?
  `).bind(
    input.body,
    ...(storedBinding ?? []),
    now(),
    current.id,
    input.version,
  ).run();
  if (!changed(result)) {
    const latest = await requireCommentRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Comment was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  const row = await requireCommentRow(env, current.id);
  return hydrateComment(env, row);
}

// deleteComment()'s R2 cleanup runs after the comment's D1 row (and, via ON DELETE CASCADE, its
// attachment rows) are already gone, so it's best-effort housekeeping: a failed individual R2
// delete must not fail the whole DELETE /api/comments/:id request — see design.md
// "deleteComment() 的附件清理讀取獨立於截斷機制之外". Batches run sequentially, but deletes
// within a batch run concurrently, keeping the number of in-flight R2 calls bounded regardless
// of how many attachments the comment had.
const COMMENT_ATTACHMENT_DELETE_BATCH_SIZE = 20;

async function deleteAttachmentObjectsBestEffort(env, attachmentIds) {
  for (
    let offset = 0;
    offset < attachmentIds.length;
    offset += COMMENT_ATTACHMENT_DELETE_BATCH_SIZE
  ) {
    const batch = attachmentIds.slice(offset, offset + COMMENT_ATTACHMENT_DELETE_BATCH_SIZE);
    await Promise.all(batch.map(async (attachmentId) => {
      try {
        await env.ATTACHMENTS.delete(attachmentId);
      } catch (error) {
        console.error(error);
      }
    }));
  }
}

async function deleteComment(env, id, expectedVersion) {
  const current = await requireCommentRow(env, id);
  assertCommentVersion(current, expectedVersion);
  // capped: false — this read must stay complete regardless of COMMENT_ATTACHMENT_MAX_RESULTS,
  // since the comment row (and its attachments, via ON DELETE CASCADE) is about to be deleted;
  // truncating this read would orphan the R2 objects for any attachment past the cap.
  const { attachments } = await attachmentsForComment(env, current.id, { capped: false });
  const result = await env.DB.prepare(`
    DELETE FROM comments WHERE id = ? AND version = ?
  `).bind(current.id, expectedVersion).run();
  if (!changed(result)) {
    const latest = await requireCommentRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Comment was changed by another client",
      { expectedVersion, actualVersion: latest.version },
    );
  }
  await deleteAttachmentObjectsBestEffort(env, attachments.map((attachment) => attachment.id));
}

async function listTaskAttachments(env, taskId, after) {
  const task = await requireTaskRow(env, taskId);
  const rows = after
    ? await all(env.DB.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
        AND change_revision > ?
      ORDER BY change_revision
    `).bind(task.id, after.revision))
    : await all(env.DB.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).bind(task.id));
  return {
    attachments: rows.map(attachmentFromRow),
    nextCursor: nextCursor(rows, after),
  };
}

async function listCommentAttachments(env, commentId, after) {
  await requireCommentRow(env, commentId);
  const rows = after
    ? await all(env.DB.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
        AND change_revision > ?
      ORDER BY change_revision
    `).bind(commentId, after.revision))
    : await all(env.DB.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).bind(commentId));
  return {
    attachments: rows.map(attachmentFromRow),
    nextCursor: nextCursor(rows, after),
  };
}

async function uploadAttachment(env, ownerType, ownerId, request) {
  let taskId;
  let commentId = null;
  if (ownerType === "task") {
    taskId = (await requireTaskRow(env, ownerId)).id;
  } else {
    const comment = await requireCommentRow(env, ownerId);
    taskId = comment.task_id;
    commentId = comment.id;
  }
  const metadata = parseAttachmentHeaders(request);
  const body = await readAttachment(request);
  const id = uuid();
  await env.ATTACHMENTS.put(id, body, {
    httpMetadata: { contentType: metadata.contentType },
  });
  try {
    await env.DB.prepare(`
      INSERT INTO attachments (
        id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT revision + 1 FROM global_revision WHERE singleton = 1))
    `).bind(
      id,
      taskId,
      commentId,
      metadata.kind,
      metadata.filename,
      metadata.contentType,
      body.byteLength,
      now(),
    ).run();
  } catch (error) {
    await env.ATTACHMENTS.delete(id);
    throw error;
  }
  const row = await env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
  return attachmentFromRow(row);
}

async function uploadProjectReadmeAttachment(env, projectId, request) {
  await requireProject(env, projectId);
  const metadata = parseAttachmentHeaders(request);
  if (metadata.kind !== "inline") {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT_KIND",
      "Project README attachments must be inline",
    );
  }
  const body = await readAttachment(request);
  const id = uuid();
  await env.ATTACHMENTS.put(id, body, {
    httpMetadata: { contentType: metadata.contentType },
  });
  try {
    await env.DB.prepare(`
      INSERT INTO project_readme_attachments (
        id, project_id, filename, content_type, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      projectId,
      metadata.filename,
      metadata.contentType,
      body.byteLength,
      now(),
    ).run();
  } catch (error) {
    await env.ATTACHMENTS.delete(id);
    throw error;
  }
  const row = await env.DB.prepare(
    "SELECT * FROM project_readme_attachments WHERE id = ?",
  ).bind(id).first();
  return projectReadmeAttachmentFromRow(row);
}

async function requireAttachment(env, id) {
  const row = await env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
  if (row) return attachmentFromRow(row);
  const projectReadmeRow = await env.DB.prepare(
    "SELECT * FROM project_readme_attachments WHERE id = ?",
  ).bind(id).first();
  if (projectReadmeRow) return projectReadmeAttachmentFromRow(projectReadmeRow);
  throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
}

async function deleteAttachment(env, id) {
  const attachment = await requireAttachment(env, id);
  if (attachment.projectId) {
    await env.DB.prepare(
      "DELETE FROM project_readme_attachments WHERE id = ?",
    ).bind(attachment.id).run();
  } else {
    await env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(attachment.id).run();
  }
  await env.ATTACHMENTS.delete(attachment.id);
  return attachment;
}

function requireNoQuery(url, routeName) {
  if ([...url.searchParams.keys()].length > 0) {
    throw new ApiError(
      400,
      "UNKNOWN_QUERY_PARAMETER",
      `${routeName} does not accept query parameters`,
    );
  }
}

function decodePathPart(value, label) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH", `${label} contains invalid encoding`);
  }
  if (decoded.length === 0 || decoded.length > 128) {
    throw new ApiError(400, "INVALID_PATH", `${label} is invalid`);
  }
  return decoded;
}

async function readGlobalRevision(env) {
  return env.DB.prepare(`
    SELECT revision FROM global_revision WHERE singleton = 1
  `).first("revision");
}

function realtimeHub(env) {
  return env.REALTIME_HUB.get(env.REALTIME_HUB.idFromName(REALTIME_HUB_NAME));
}

async function broadcastRevision(env, revision) {
  const response = await realtimeHub(env).fetch("https://realtime.internal/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision }),
  });
  if (!response.ok) throw new Error(`Realtime broadcast failed (${response.status})`);
}

async function attachmentContent(env, id, request, download = false) {
  const attachment = await requireAttachment(env, id);
  const object = await env.ATTACHMENTS.get(attachment.id);
  if (!object) {
    throw new ApiError(
      404,
      "ATTACHMENT_NOT_FOUND",
      `Attachment '${id}' does not exist`,
    );
  }
  const encodedFilename = encodeURIComponent(attachment.filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const canOpenInline = !download && INLINE_ATTACHMENT_TYPES.has(attachment.contentType);
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `${
        canOpenInline ? "inline" : "attachment"
      }; filename*=UTF-8''${encodedFilename}`,
      "content-length": String(attachment.size),
      "content-security-policy": "sandbox; default-src 'none'",
      "content-type": canOpenInline
        ? attachment.contentType
        : "application/octet-stream",
    },
  });
}

async function routeApi(request, env, actor, url) {
  const { pathname } = url;

  if (pathname === "/api/meta") {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    requireNoQuery(url, "GET /api/meta");
    return json(200, {
      mode: "cloud",
      manageTaskboardSkillPath: null,
      realtime: {
        transport: "websocket",
        endpoint: "/api/events",
      },
      localCapabilities: { available: false },
    });
  }

  if (pathname === "/api/revisions") {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    const unknown = [...url.searchParams.keys()].filter((key) => key !== "since");
    if (unknown.length > 0) {
      throw new ApiError(
        400,
        "UNKNOWN_QUERY_PARAMETER",
        `Unknown query parameter: ${unknown[0]}`,
      );
    }
    if (url.searchParams.getAll("since").length !== 1) {
      throw new ApiError(
        400,
        "INVALID_QUERY_PARAMETER",
        "'since' must be provided once",
      );
    }
    const rawSince = url.searchParams.get("since");
    if (!/^\d+$/.test(rawSince ?? "")) {
      throw new ApiError(
        400,
        "INVALID_QUERY_PARAMETER",
        "'since' must be a non-negative integer",
      );
    }
    const since = Number(rawSince);
    if (!Number.isSafeInteger(since)) {
      throw new ApiError(
        400,
        "INVALID_QUERY_PARAMETER",
        "'since' must be a non-negative integer",
      );
    }
    const revision = await readGlobalRevision(env);
    return json(200, { changed: revision > since, revision });
  }

  if (
    pathname === "/api/device-workspaces"
    || /^\/api\/projects\/[^/]+\/development-contexts$/.test(pathname)
  ) {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    throw new ApiError(
      409,
      "LOCAL_COMPANION_REQUIRED",
      "This capability requires the local Codex companion",
    );
  }

  if (pathname === "/api/events") {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    requireNoQuery(url, "GET /api/events");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "WEBSOCKET_REQUIRED", "A WebSocket upgrade is required");
    }
    return realtimeHub(env).fetch(new Request("https://realtime.internal/connect", request));
  }

  if (pathname === "/api/projects") {
    if (request.method === "GET") {
      requireNoQuery(url, "GET /api/projects");
      const { projects, truncated } = await listProjects(env);
      return json(200, { projects, truncated });
    }
    if (request.method === "POST") {
      return json(201, {
        project: await createProject(env, parseProjectCreate(await readJson(request))),
      });
    }
    methodNotAllowed(["GET", "POST"]);
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    requireNoQuery(url, "Project routes");
    const projectId = validateProjectId(decodePathPart(projectMatch[1], "Project id"));
    if (request.method !== "DELETE") methodNotAllowed(["DELETE"]);
    await deleteProject(env, projectId);
    return empty(204);
  }

  const projectLabelsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/labels$/);
  if (projectLabelsMatch) {
    requireNoQuery(url, "Project label routes");
    const projectId = validateProjectId(
      decodePathPart(projectLabelsMatch[1], "Project id"),
    );
    if (request.method !== "POST" && request.method !== "DELETE") {
      methodNotAllowed(["POST", "DELETE"]);
    }
    const label = parseProjectLabel(await readJson(request));
    const project = request.method === "POST"
      ? await addProjectLabel(env, projectId, label)
      : await deleteProjectLabel(env, projectId, label);
    return json(200, { project });
  }

  const projectReadmeAttachmentsMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/readme\/attachments$/,
  );
  if (projectReadmeAttachmentsMatch) {
    requireNoQuery(url, "Project README attachment routes");
    const projectId = validateProjectId(
      decodePathPart(projectReadmeAttachmentsMatch[1], "Project id"),
    );
    if (request.method !== "POST") methodNotAllowed(["POST"]);
    return json(201, {
      attachment: await uploadProjectReadmeAttachment(env, projectId, request),
    });
  }

  const projectReadmeMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/readme$/,
  );
  if (projectReadmeMatch) {
    requireNoQuery(url, "Project README routes");
    const projectId = validateProjectId(
      decodePathPart(projectReadmeMatch[1], "Project id"),
    );
    if (request.method === "GET") {
      return json(200, { readme: await getProjectReadme(env, projectId) });
    }
    if (request.method === "PUT") {
      const body = await readJson(
        request,
        PROJECT_README_BODY_LIMIT,
        "Project README request cannot exceed 3 MiB",
      );
      assertPlainObject(body);
      assertAllowedKeys(body, new Set(["version", "content"]));
      const version = body.version === undefined
        ? undefined
        : parseVersion(body.version, { allowZero: true });
      const content = body.content ?? "";
      if (typeof content !== "string") {
        throw new ApiError(400, "INVALID_FIELD", "'content' must be a string");
      }
      if (content.length > 500_000) {
        throw new ApiError(400, "INVALID_FIELD", "'content' cannot exceed 500000 characters");
      }
      return json(200, {
        readme: await saveProjectReadme(env, projectId, content, version),
      });
    }
    methodNotAllowed(["GET", "PUT"]);
  }

  if (pathname === "/api/tasks") {
    if (request.method === "GET") {
      return json(200, {
        tasks: await listTasks(env, parseTaskFilters(url.searchParams)),
      });
    }
    if (request.method === "POST") {
      return json(201, {
        task: await createTask(env, parseTaskCreate(await readJson(request)), actor),
      });
    }
    methodNotAllowed(["GET", "POST"]);
  }

  const taskTreeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/tree$/);
  if (taskTreeMatch) {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    const taskId = decodePathPart(taskTreeMatch[1], "Task id");
    const { direction, depth } = parseTaskTreeQuery(url.searchParams);
    return json(200, { tree: await getTaskTree(env, taskId, direction, depth) });
  }

  const relationMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/relations\/([^/]+)\/([^/]+)$/,
  );
  if (relationMatch) {
    requireNoQuery(url, "Issue relation routes");
    const taskId = decodePathPart(relationMatch[1], "Task id");
    const type = decodePathPart(relationMatch[2], "Relation type");
    const relatedTaskId = decodePathPart(relationMatch[3], "Related task id");
    const input = parseRelationMutation(await readJson(request));
    if (request.method === "POST") {
      return json(200, await addRelation(env, taskId, type, relatedTaskId, input, actor));
    }
    if (request.method === "DELETE") {
      return json(200, await removeRelation(env, taskId, type, relatedTaskId, input, actor));
    }
    methodNotAllowed(["POST", "DELETE"]);
  }

  const taskActivitiesMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/activities$/);
  if (taskActivitiesMatch) {
    requireNoQuery(url, "Activity routes");
    const taskId = decodePathPart(taskActivitiesMatch[1], "Task id");
    if (request.method === "GET") {
      return json(200, { activities: await listTaskActivities(env, taskId) });
    }
    methodNotAllowed(["GET"]);
  }

  const taskCommentsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
  if (taskCommentsMatch) {
    const taskId = decodePathPart(taskCommentsMatch[1], "Task id");
    if (request.method === "GET") {
      const after = parseAfterCursor(url.searchParams);
      return json(200, after
        ? await listCommentsAfter(env, taskId, after)
        : await listComments(env, taskId));
    }
    requireNoQuery(url, "Comment routes");
    if (request.method === "POST") {
      return json(201, {
        comment: await createComment(
          env,
          taskId,
          parseCommentCreate(await readJson(request)),
          actor,
        ),
      });
    }
    methodNotAllowed(["GET", "POST"]);
  }

  const commentAttachmentsMatch = pathname.match(
    /^\/api\/comments\/([^/]+)\/attachments$/,
  );
  if (commentAttachmentsMatch) {
    const commentId = decodePathPart(commentAttachmentsMatch[1], "Comment id");
    if (request.method === "GET") {
      return json(
        200,
        await listCommentAttachments(env, commentId, parseAfterCursor(url.searchParams)),
      );
    }
    requireNoQuery(url, "Attachment routes");
    if (request.method === "POST") {
      return json(201, {
        attachment: await uploadAttachment(env, "comment", commentId, request),
      });
    }
    methodNotAllowed(["GET", "POST"]);
  }

  const commentMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
  if (commentMatch) {
    requireNoQuery(url, "Comment routes");
    const commentId = decodePathPart(commentMatch[1], "Comment id");
    if (request.method === "PATCH") {
      return json(200, {
        comment: await updateComment(
          env,
          commentId,
          parseCommentPatch(await readJson(request)),
        ),
      });
    }
    if (request.method === "DELETE") {
      const { version } = parseVersionMutation(await readJson(request));
      await deleteComment(env, commentId, version);
      return empty(204);
    }
    methodNotAllowed(["PATCH", "DELETE"]);
  }

  const taskAttachmentsMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/attachments$/,
  );
  if (taskAttachmentsMatch) {
    const taskId = decodePathPart(taskAttachmentsMatch[1], "Task id");
    if (request.method === "GET") {
      return json(200, await listTaskAttachments(env, taskId, parseAfterCursor(url.searchParams)));
    }
    requireNoQuery(url, "Attachment routes");
    if (request.method === "POST") {
      return json(201, {
        attachment: await uploadAttachment(env, "task", taskId, request),
      });
    }
    methodNotAllowed(["GET", "POST"]);
  }

  const attachmentContentMatch = pathname.match(
    /^\/api\/attachments\/([^/]+)\/(content|download)$/,
  );
  if (attachmentContentMatch) {
    requireNoQuery(url, "Attachment routes");
    if (!["GET", "HEAD"].includes(request.method)) methodNotAllowed(["GET", "HEAD"]);
    return attachmentContent(
      env,
      decodePathPart(attachmentContentMatch[1], "Attachment id"),
      request,
      attachmentContentMatch[2] === "download",
    );
  }

  const attachmentMatch = pathname.match(/^\/api\/attachments\/([^/]+)$/);
  if (attachmentMatch) {
    requireNoQuery(url, "Attachment routes");
    if (request.method !== "DELETE") methodNotAllowed(["DELETE"]);
    await deleteAttachment(
      env,
      decodePathPart(attachmentMatch[1], "Attachment id"),
    );
    return empty(204);
  }

  const taskMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)(?:\/(archive|restore|move))?$/,
  );
  if (taskMatch) {
    const taskId = decodePathPart(taskMatch[1], "Task id");
    const action = taskMatch[2];
    requireNoQuery(url, "Task routes");
    if (!action && request.method === "GET") {
      const task = await getTask(env, taskId);
      if (!task) {
        throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
      }
      return json(200, { task });
    }
    if (!action && request.method === "PATCH") {
      return json(200, {
        task: await updateTask(
          env,
          taskId,
          parseTaskPatch(await readJson(request)),
          actor,
        ),
      });
    }
    if (!action && request.method === "DELETE") {
      const { version } = parseVersionMutation(await readJson(request));
      await deleteArchivedTask(env, taskId, version);
      return empty(204);
    }
    if (action === "move" && request.method === "POST") {
      return json(200, {
        task: await moveTask(env, taskId, parseMove(await readJson(request)), actor),
      });
    }
    if (action === "archive" && request.method === "POST") {
      return json(200, {
        task: await archiveTask(
          env,
          taskId,
          parseVersionMutation(await readJson(request)),
          actor,
        ),
      });
    }
    if (action === "restore" && request.method === "POST") {
      return json(200, {
        task: await restoreTask(
          env,
          taskId,
          parseVersionMutation(await readJson(request)),
          actor,
        ),
      });
    }
    methodNotAllowed(action ? ["POST"] : ["GET", "PATCH", "DELETE"]);
  }

  throw new ApiError(404, "NOT_FOUND", "API route not found");
}

function withSecurityHeaders(response) {
  if (response.status === 101) return response;
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "no-referrer");
  return secured;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        if (request.method !== "GET") methodNotAllowed(["GET"]);
        return withSecurityHeaders(json(200, { status: "ok" }));
      }

      const authentication = await authenticate(request, env);
      if (!authentication) return withSecurityHeaders(unauthorized());

      let response = url.pathname.startsWith("/api/")
        ? await routeApi(request, env, authentication.actor, url)
        : env.ASSETS
          ? await env.ASSETS.fetch(request)
          : json(404, { error: { code: "NOT_FOUND", message: "Resource not found" } });
      if (authentication.sessionCookie && response.status !== 101) {
        response = new Response(response.body, response);
        response.headers.append("set-cookie", authentication.sessionCookie);
      }
      if (
        response.ok
        && env.REALTIME_HUB
        && url.pathname.startsWith("/api/")
        && !["GET", "HEAD", "OPTIONS"].includes(request.method)
      ) {
        const revision = await readGlobalRevision(env);
        ctx.waitUntil(broadcastRevision(env, revision).catch((error) => console.error(error)));
      }
      return withSecurityHeaders(response);
    } catch (error) {
      if (error instanceof ApiError) {
        const payload = {
          error: { code: error.code, message: error.message },
        };
        if (error.details !== undefined) payload.error.details = error.details;
        const headers = error.status === 405 && error.details?.allowed
          ? { allow: error.details.allowed.join(", ") }
          : {};
        return withSecurityHeaders(json(error.status, payload, headers));
      }
      console.error(error);
      return withSecurityHeaders(json(500, {
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      }));
    }
  },
};
