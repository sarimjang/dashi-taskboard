#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  collectCloudSnapshot,
  commentContentDigest,
  createCloudReader,
  defaultAttachmentsDirectory,
  defaultCloudConfigPath,
  defaultDatabasePath,
  defaultMigrationStatePath,
  migrationSourceKey,
  openLocalWriter,
  readCloudCompanionConfig,
  readMigrationState,
  sha256Hex,
  sourceBucket,
  taskContentDigest,
  writeMigrationState,
} from "./cloud-migration.mjs";
import { normalizeCloudUrl } from "../server/cloud-config.mjs";
import {
  DEFAULT_PROJECT_ID,
  TASK_STATUSES,
  isTaskPriority,
  isTaskStatus,
} from "../shared/domain.mjs";

export const SCHEMA_VERSION = 2;
export const DEFAULT_API_URL = "http://127.0.0.1:47823";

const execFileAsync = promisify(execFile);

const sourceRuntimeFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".data",
  "launcher-runtime.json",
);
const BOOLEAN_OPTIONS = new Set(["json", "clear-binding-thread", "help", "dry-run"]);
const GLOBAL_OPTIONS = new Set(["runtime-file"]);

const COMMAND_OPTIONS = new Map([
  ["project list", new Set(["json"])],
  ["project create", new Set(["id", "name", "workspace-path", "json"])],
  ["project map", new Set(["workspace-path", "json"])],
  ["project readme", new Set(["content", "file", "if-version", "json"])],
  ["cloud login", new Set(["url", "actor-name", "json"])],
  ["cloud status", new Set(["json"])],
  ["cloud logout", new Set(["json"])],
  ["cloud migrate", new Set(["project", "dry-run", "cloud-config", "state-file", "json"])],
  ["issue list", new Set(["project", "status", "archived", "json"])],
  ["issue get", new Set(["json"])],
  [
    "issue create",
    new Set([
      "project",
      "title",
      "description",
      "description-file",
      "status",
      "priority",
      "labels",
      "thread-id",
      "git-branch",
      "worktree-path",
      "worktree-branch",
      "start-date",
      "due-date",
      "recurrence-interval",
      "recurrence-unit",
      "json",
    ]),
  ],
  [
    "issue update",
    new Set([
      "project",
      "title",
      "description",
      "description-file",
      "status",
      "priority",
      "labels",
      "thread-id",
      "git-branch",
      "worktree-path",
      "worktree-branch",
      "start-date",
      "due-date",
      "recurrence-interval",
      "recurrence-unit",
      "if-version",
      "json",
    ]),
  ],
  ["issue move", new Set([
    "status",
    "thread-id",
    "binding-thread-id",
    "binding-codex-project-id",
    "binding-codex-project-kind",
    "binding-codex-host-id",
    "binding-workspace-path",
    "clear-binding-thread",
    "if-version",
    "json",
  ])],
  ["issue archive", new Set(["thread-id", "if-version", "json"])],
  ["issue restore", new Set(["thread-id", "if-version", "json"])],
  ["issue tree", new Set(["direction", "depth", "json"])],
  ["issue relation", new Set(["type", "issue", "thread-id", "if-version", "json"])],
  ["comment list", new Set(["after", "json"])],
  ["comment add", new Set([
    "body",
    "body-file",
    "thread-id",
    "binding-thread-id",
    "binding-codex-project-id",
    "binding-codex-project-kind",
    "binding-codex-host-id",
    "binding-workspace-path",
    "clear-binding-thread",
    "json",
  ])],
  ["comment update", new Set(["body", "thread-id", "if-version", "json"])],
  ["comment delete", new Set(["thread-id", "if-version", "json"])],
  ["attachment list", new Set(["task", "comment", "after", "json"])],
  ["attachment download", new Set(["output", "json"])],
  ["attachment upload", new Set(["file", "task", "comment", "content-type", "kind", "json"])],
  ["context current", new Set(["cwd", "json"])],
]);

const HELP_TEXT = new Map([
  ["", `Usage: taskctl RESOURCE ACTION [options]

Commands:
  context current [--cwd PATH] [--json]
  project list
  project create --name NAME [--id ID] [--workspace-path PATH]
  project map PROJECT_ID --workspace-path PATH
  project readme get [PROJECT_ID]
  project readme set [PROJECT_ID] (--content TEXT | --file FILE) [--if-version N]
  cloud login --url URL --actor-name NAME
  cloud status|logout
  cloud migrate --project PROJECT_ID [--dry-run] [--cloud-config FILE] [--state-file FILE]
  issue list|get|create|update|move|archive|restore|tree|relation
  comment list ISSUE_ID [--after CURSOR]
  comment add ISSUE_ID (--body TEXT | --body-file FILE) [--thread-id ID]
  comment update COMMENT_ID --body TEXT --if-version N [--thread-id ID]
  comment delete COMMENT_ID --if-version N [--thread-id ID]
  attachment list (--task ISSUE_ID | --comment COMMENT_ID) [--after CURSOR]
  attachment download ATTACHMENT_ID --output PATH
  attachment upload --file PATH (--task ISSUE_ID | --comment COMMENT_ID)

Global options:
  --runtime-file FILE  Use an explicit launcher runtime descriptor
  --json               Make the JSON output contract explicit
  --help               Show help for a supported command level

Examples:
  taskctl issue get LOCAL-275 --json
  taskctl comment list LOCAL-275 --json

Run taskctl issue --help for all issue arguments.`],
  ["issue", `Usage: taskctl issue ACTION [arguments] [options]

Actions:
  list [--project PROJECT_ID] [--status STATUS] [--archived true|false|all] [--json]
  get ISSUE_ID [--json]
  create --project PROJECT_ID --title TITLE
    [--description TEXT | --description-file FILE]
    [--status STATUS] [--priority PRIORITY] [--labels a,b]
    [--thread-id ID]
    [--git-branch BRANCH | --worktree-path PATH [--worktree-branch BRANCH]]
    [--start-date YYYY-MM-DD] [--due-date YYYY-MM-DD]
    [--recurrence-interval N --recurrence-unit day|week|month|year] [--json]
  update ISSUE_ID
    [--project PROJECT_ID] [--title TITLE]
    [--description TEXT | --description-file FILE]
    [--status STATUS] [--priority PRIORITY] [--labels a,b]
    [--thread-id ID]
    [--git-branch BRANCH | --worktree-path PATH [--worktree-branch BRANCH]]
    [--start-date YYYY-MM-DD] [--due-date YYYY-MM-DD]
    [--recurrence-interval N --recurrence-unit day|week|month|year]
    [--if-version N] [--json]
  move ISSUE_ID --status STATUS [--thread-id ID]
    [--binding-thread-id ID
      [--binding-codex-project-id ID --binding-codex-project-kind local|remote
       --binding-codex-host-id ID --binding-workspace-path PATH]
     | --clear-binding-thread]
    [--if-version N] [--json]
  archive ISSUE_ID [--thread-id ID] [--if-version N] [--json]
  restore ISSUE_ID [--thread-id ID] [--if-version N] [--json]
  tree ISSUE_ID --direction descendants|ancestors --depth N [--json]
  relation add|remove ISSUE_ID --type parent|blocks|blocked_by|related
    --issue RELATED_ISSUE_ID [--thread-id ID] [--if-version N] [--json]

Statuses: backlog, todo, in_progress, in_review, blocked, done, canceled
Priorities: none, urgent, high, medium, low

Example:
  taskctl issue get LOCAL-275 --json`],
  ["comment list", `Usage: taskctl comment list ISSUE_ID [--after CURSOR] [--json]

Options:
  --after CURSOR  Return comments created or modified after a prior nextCursor
  --json          Make the JSON output contract explicit
  --help          Show this help

The response always includes nextCursor. Omit --after for the full list.

Example:
  taskctl comment list LOCAL-275 --after CURSOR --json`],
]);

class TaskctlError extends Error {
  constructor(message, { code = "TASKCTL_ERROR", exitCode = 2, details } = {}) {
    super(message);
    this.name = "TaskctlError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError("argv must be an array");
  }

  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const name = token.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!name) {
      throw usageError("Invalid empty option");
    }

    if (Object.hasOwn(options, name)) {
      throw usageError(`Option --${name} may only be specified once`);
    }

    if (BOOLEAN_OPTIONS.has(name)) {
      if (equalsIndex !== -1) {
        throw usageError(`Option --${name} does not accept a value`);
      }
      options[name] = true;
      continue;
    }

    if (equalsIndex !== -1) {
      options[name] = token.slice(equalsIndex + 1);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`Option --${name} requires a value`);
    }
    options[name] = value;
    index += 1;
  }

  return {
    resource: positionals[0],
    action: positionals[1],
    operands: positionals.slice(2),
    options,
  };
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  const stdout = overrides.stdout ?? process.stdout;
  const stderr = overrides.stderr ?? process.stderr;

  try {
    const parsed = parseArgs(argv);
    if (parsed.options.help) {
      const scope = `${parsed.resource ?? ""} ${parsed.action ?? ""}`.trim();
      const help = HELP_TEXT.get(scope);
      if (!help || parsed.operands.length > 0 || Object.keys(parsed.options).length !== 1) {
        throw usageError("Help is available for taskctl, taskctl issue, and taskctl comment list");
      }
      stdout.write(`${help}\n`);
      return 0;
    }
    const result = await execute(parsed, overrides);
    writeJson(stdout, { ...result, schemaVersion: SCHEMA_VERSION });
    return 0;
  } catch (error) {
    const normalized = normalizeError(error);
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      error: {
        code: normalized.code,
        message: normalized.message,
      },
    };
    if (normalized.details !== undefined) {
      payload.error.details = normalized.details;
    }
    writeJson(stderr, payload);
    return normalized.exitCode;
  }
}

async function execute(parsed, overrides) {
  const command = `${parsed.resource ?? ""} ${parsed.action ?? ""}`.trim();
  const allowedOptions = COMMAND_OPTIONS.get(command);
  if (!allowedOptions) {
    throw usageError(
      "Expected one of: project list/create/map/readme, cloud login/status/logout, issue list/get/create/update/move/archive/restore/tree/relation, comment list/add/update/delete, attachment list/download/upload, context current",
    );
  }
  validateOptions(parsed.options, allowedOptions);

  const processEnv = overrides.env ?? process.env;
  const env = parsed.options["runtime-file"] === undefined
    ? processEnv
    : { ...processEnv, CODEX_TASKBOARD_RUNTIME_FILE: parsed.options["runtime-file"] };
  const usesCompanionControl = command.startsWith("cloud ") || command === "project map";
  const target = usesCompanionControl || env.CODEX_TASKBOARD_COMPANION_URL !== undefined
      ? await resolveCompanionUrl(env, overrides)
      : await resolveTaskboardBaseUrl(env, overrides);
  const api = createApiClient(overrides, target);
  switch (command) {
    case "project list":
      expectOperandCount(parsed, 0);
      return api.request("GET", "/api/projects");
    case "project create":
      expectOperandCount(parsed, 0);
      return api.request("POST", "/api/projects", {
        ...optionalField("id", parsed.options.id),
        name: requiredOption(parsed.options, "name"),
        ...optionalField(
          "workspacePath",
          parsed.options["workspace-path"] === undefined
            ? undefined
            : resolveInputPath(parsed.options["workspace-path"], overrides),
        ),
      });
    case "project map":
      expectOperandCount(parsed, 1);
      return api.request(
        "PUT",
        `/api/local/project-mappings/${encodeURIComponent(parsed.operands[0])}`,
        {
          workspacePath: resolveInputPath(
            requiredOption(parsed.options, "workspace-path"),
            overrides,
          ),
        },
      );
    case "project readme":
      return executeProjectReadme(api, parsed, overrides);
    case "cloud login":
      expectOperandCount(parsed, 0);
      return cloudLogin(
        api,
        requiredOption(parsed.options, "url"),
        requiredOption(parsed.options, "actor-name"),
        overrides,
      );
    case "cloud status":
      expectOperandCount(parsed, 0);
      return api.request("GET", "/api/local/cloud-session");
    case "cloud logout":
      expectOperandCount(parsed, 0);
      return api.request("DELETE", "/api/local/cloud-session");
    case "cloud migrate":
      expectOperandCount(parsed, 0);
      return migrateCloudBoard(parsed.options, overrides);
    case "issue list":
      expectOperandCount(parsed, 0);
      return listIssues(api, parsed.options);
    case "issue get":
      expectOperandCount(parsed, 1);
      return api.request("GET", taskPath(parsed.operands[0]));
    case "issue create":
      expectOperandCount(parsed, 0);
      return createIssue(api, parsed.options, overrides);
    case "issue update":
      expectOperandCount(parsed, 1);
      return updateIssue(api, parsed.operands[0], parsed.options, overrides);
    case "issue move":
      expectOperandCount(parsed, 1);
      return moveIssue(api, parsed.operands[0], parsed.options, overrides);
    case "issue archive":
      expectOperandCount(parsed, 1);
      return archiveIssue(api, parsed.operands[0], parsed.options, overrides, "archive");
    case "issue restore":
      expectOperandCount(parsed, 1);
      return archiveIssue(api, parsed.operands[0], parsed.options, overrides, "restore");
    case "issue tree":
      expectOperandCount(parsed, 1);
      return getIssueTree(api, parsed.operands[0], parsed.options);
    case "issue relation":
      expectOperandCount(parsed, 2);
      return mutateIssueRelation(
        api,
        parsed.operands[0],
        parsed.operands[1],
        parsed.options,
        overrides,
      );
    case "comment list": {
      expectOperandCount(parsed, 1);
      const search = new URLSearchParams();
      if (parsed.options.after !== undefined) search.set("after", parsed.options.after);
      const query = search.size > 0 ? `?${search}` : "";
      return api.request("GET", `${taskPath(parsed.operands[0])}/comments${query}`);
    }
    case "comment add": {
      expectOperandCount(parsed, 1);
      if (parsed.options.body !== undefined && parsed.options["body-file"] !== undefined) {
        throw usageError("Use either --body or --body-file, not both");
      }
      let body;
      if (parsed.options["body-file"] === undefined) {
        body = requiredOption(parsed.options, "body");
      } else {
        const read = overrides.readFile ?? readFile;
        try {
          body = await read(parsed.options["body-file"], "utf8");
        } catch (error) {
          throw new TaskctlError(`Cannot read comment body file: ${parsed.options["body-file"]}`, {
            code: "FILE_READ_FAILED",
            exitCode: 2,
            details: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return api.request("POST", `${taskPath(parsed.operands[0])}/comments`, {
        body,
        threadId: resolveThreadId(parsed.options, overrides),
        ...optionalField("threadBinding", threadBindingFromOptions(parsed.options)),
      });
    }
    case "comment update":
      expectOperandCount(parsed, 1);
      return api.request("PATCH", commentPath(parsed.operands[0]), {
        body: requiredOption(parsed.options, "body"),
        threadId: resolveThreadId(parsed.options, overrides),
        version: explicitVersion(parsed.options["if-version"]),
      });
    case "comment delete":
      expectOperandCount(parsed, 1);
      return api.request("DELETE", commentPath(parsed.operands[0]), {
        threadId: resolveThreadId(parsed.options, overrides),
        version: explicitVersion(parsed.options["if-version"]),
      });
    case "attachment list": {
      expectOperandCount(parsed, 0);
      const taskId = parsed.options.task;
      const commentId = parsed.options.comment;
      if (Boolean(taskId) === Boolean(commentId)) {
        throw usageError("attachment list requires exactly one of --task or --comment");
      }
      const search = new URLSearchParams();
      if (parsed.options.after !== undefined) search.set("after", parsed.options.after);
      const query = search.size > 0 ? `?${search}` : "";
      const pathname = taskId
        ? `${taskPath(taskId)}/attachments`
        : `${commentPath(commentId)}/attachments`;
      return api.request("GET", `${pathname}${query}`);
    }
    case "attachment download":
      expectOperandCount(parsed, 1);
      return downloadAttachment(api, parsed.operands[0], parsed.options, overrides);
    case "attachment upload":
      expectOperandCount(parsed, 0);
      return uploadAttachment(api, parsed.options, overrides);
    case "context current":
      expectOperandCount(parsed, 0);
      return currentContext(api, parsed.options, overrides);
    default:
      throw usageError(`Unsupported command: ${command}`);
  }
}

function createApiClient(overrides, {
  url: explicitBaseUrl,
  windowsTransport = false,
} = {}) {
  const fetchImplementation = overrides.fetch
    ?? (windowsTransport
      ? (url, init) => fetchThroughWindows(url, init, overrides)
      : globalThis.fetch);
  if (typeof fetchImplementation !== "function") {
    throw new TaskctlError("fetch is not available", {
      code: "CLIENT_UNAVAILABLE",
      exitCode: 3,
    });
  }

  const env = overrides.env ?? process.env;
  const baseUrl = normalizeBaseUrl(explicitBaseUrl ?? DEFAULT_API_URL);

  return {
    async request(method, pathname, body) {
      let response;
      try {
        response = await fetchImplementation(resolveApiUrl(baseUrl, pathname), {
          method,
          headers: {
            accept: "application/json",
            "x-taskboard-client": "taskctl",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw new TaskctlError(`Cannot reach taskboard service at ${baseUrl}`, {
          code: "SERVICE_UNAVAILABLE",
          exitCode: 3,
          details: error instanceof Error ? error.message : String(error),
        });
      }

      const payload = await readResponse(response);
      if (!response.ok) {
        const apiError = extractApiError(payload, response.status);
        throw new TaskctlError(apiError.message, {
          code: apiError.code,
          exitCode: response.status === 409 ? 5 : 4,
          details: apiError.details,
        });
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TaskctlError("Taskboard service returned an invalid JSON response", {
          code: "INVALID_RESPONSE",
          exitCode: 4,
        });
      }
      return payload;
    },
    async download(pathname) {
      let response;
      try {
        response = await fetchImplementation(resolveApiUrl(baseUrl, pathname), {
          headers: {
            accept: "*/*",
            "x-taskboard-client": "taskctl",
          },
        });
      } catch (error) {
        throw new TaskctlError(`Cannot reach taskboard service at ${baseUrl}`, {
          code: "SERVICE_UNAVAILABLE",
          exitCode: 3,
          details: error instanceof Error ? error.message : String(error),
        });
      }

      if (!response.ok) {
        const payload = await readResponse(response);
        const apiError = extractApiError(payload, response.status);
        throw new TaskctlError(apiError.message, {
          code: apiError.code,
          exitCode: response.status === 409 ? 5 : 4,
          details: apiError.details,
        });
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        bytes,
        contentType: response.headers.get("content-type"),
        size: Number(response.headers.get("content-length")) || bytes.byteLength,
      };
    },
    async upload(pathname, { body, contentType, filename, kind }) {
      let response;
      try {
        response = await fetchImplementation(resolveApiUrl(baseUrl, pathname), {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": contentType,
            "x-taskboard-client": "taskctl",
            "x-taskboard-filename": encodeURIComponent(filename),
            "x-taskboard-attachment-kind": kind,
          },
          body,
        });
      } catch (error) {
        throw new TaskctlError(`Cannot reach taskboard service at ${baseUrl}`, {
          code: "SERVICE_UNAVAILABLE",
          exitCode: 3,
          details: error instanceof Error ? error.message : String(error),
        });
      }

      const payload = await readResponse(response);
      if (!response.ok) {
        const apiError = extractApiError(payload, response.status);
        throw new TaskctlError(apiError.message, {
          code: apiError.code,
          exitCode: response.status === 409 ? 5 : 4,
          details: apiError.details,
        });
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TaskctlError("Taskboard service returned an invalid JSON response", {
          code: "INVALID_RESPONSE",
          exitCode: 4,
        });
      }
      return payload;
    },
  };
}

async function downloadAttachment(api, attachmentId, options, overrides) {
  const output = resolveInputPath(requiredOption(options, "output"), overrides);
  const downloaded = await api.download(attachmentContentPath(attachmentId));
  const write = overrides.writeFile ?? writeFile;
  try {
    await write(output, downloaded.bytes);
  } catch (error) {
    throw new TaskctlError(`Cannot write attachment file: ${output}`, {
      code: "FILE_WRITE_FAILED",
      exitCode: 2,
      details: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    attachmentId,
    output,
    contentType: downloaded.contentType,
    size: downloaded.size,
  };
}

async function uploadAttachment(api, options, overrides) {
  const taskId = options.task;
  const commentId = options.comment;
  if (Boolean(taskId) === Boolean(commentId)) {
    throw usageError("attachment upload requires exactly one of --task or --comment");
  }

  const filePath = resolveInputPath(requiredOption(options, "file"), overrides);
  const read = overrides.readFile ?? readFile;
  let bytes;
  try {
    bytes = await read(filePath);
  } catch (error) {
    throw new TaskctlError(`Cannot read attachment file: ${filePath}`, {
      code: "FILE_READ_FAILED",
      exitCode: 2,
      details: error instanceof Error ? error.message : String(error),
    });
  }

  const filename = path.basename(filePath);
  if (!filename || filename === "." || filename === "..") {
    throw usageError("Attachment --file must include a valid filename");
  }

  const contentType = options["content-type"]
    ? String(options["content-type"]).trim().toLowerCase()
    : guessContentType(filename);
  if (!contentType) {
    throw usageError("--content-type cannot be empty");
  }
  const kind = options.kind ?? (contentType.startsWith("image/") ? "inline" : "attachment");
  if (kind !== "inline" && kind !== "attachment") {
    throw usageError("--kind must be inline or attachment");
  }

  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const pathname = taskId
    ? `${taskPath(taskId)}/attachments`
    : `${commentPath(commentId)}/attachments`;
  const payload = await api.upload(pathname, {
    body,
    contentType,
    filename,
    kind,
  });

  return {
    attachment: payload.attachment ?? null,
    file: filePath,
    kind,
    target: taskId
      ? { type: "task", id: taskId }
      : { type: "comment", id: commentId },
  };
}

function guessContentType(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".html":
    case ".htm":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}

async function executeProjectReadme(api, parsed, overrides) {
  const operands = parsed.operands;
  const firstOperand = operands[0];
  const isExplicitSet = firstOperand === "set";
  const isExplicitGet = firstOperand === "get";
  const isOptionSet = parsed.options.content !== undefined || parsed.options.file !== undefined;
  const isSet = isExplicitSet || (!isExplicitGet && isOptionSet);

  let rawProjectId;
  if (isExplicitSet || isExplicitGet) {
    if (operands.length > 2) {
      throw usageError(`project readme ${firstOperand} accepts at most 1 positional argument (project id)`);
    }
    rawProjectId = operands[1];
  } else {
    if (operands.length > 1) {
      throw usageError("project readme accepts at most 1 positional argument (project id)");
    }
    rawProjectId = operands[0];
  }

  let projectId = rawProjectId;
  if (!projectId) {
    const context = await currentContext(api, {}, overrides);
    projectId = context.project?.id ?? DEFAULT_PROJECT_ID;
  }

  if (isSet) {
    let content = parsed.options.content;
    if (content !== undefined && parsed.options.file !== undefined) {
      throw usageError("Use either --content or --file, not both");
    }
    if (parsed.options.file !== undefined) {
      const read = overrides.readFile ?? readFile;
      try {
        content = await read(parsed.options.file, "utf8");
      } catch (error) {
        throw new TaskctlError(`Cannot read file: ${parsed.options.file}`, {
          code: "FILE_READ_FAILED",
          exitCode: 2,
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (content === undefined) {
      throw usageError("project readme set requires --content or --file");
    }
    const ifVersion = parsed.options["if-version"] !== undefined
      ? explicitVersion(parsed.options["if-version"], { allowZero: true })
      : undefined;
    return api.request("PUT", `/api/projects/${encodeURIComponent(projectId)}/readme`, {
      content,
      ...(ifVersion !== undefined ? { version: ifVersion } : {}),
    });
  }

  if (parsed.options.content !== undefined || parsed.options.file !== undefined || parsed.options["if-version"] !== undefined) {
    throw usageError("project readme get does not accept --content, --file, or --if-version");
  }

  return api.request("GET", `/api/projects/${encodeURIComponent(projectId)}/readme`);
}

async function cloudLogin(api, rawUrl, actorName, overrides) {
  let remoteUrl;
  try {
    remoteUrl = normalizeCloudUrl(rawUrl);
  } catch (error) {
    throw new TaskctlError(error instanceof Error ? error.message : String(error), {
      code: error?.code ?? "INVALID_CLOUD_URL",
      exitCode: 2,
    });
  }
  const sharedKey = overrides.readSecret
    ? await overrides.readSecret()
    : await readSecretFromInput(
      overrides.stdin ?? process.stdin,
      overrides.stderr ?? process.stderr,
    );
  if (typeof sharedKey !== "string" || !sharedKey) {
    throw usageError("Cloud shared key cannot be empty");
  }
  return api.request("PUT", "/api/local/cloud-session", {
    remoteUrl,
    actorName,
    sharedKey,
  });
}

// Migrates a shared cloud board (identified by cloud-companion.json) into a
// local project. Reads the remote board directly over HTTP (see
// cloud-migration.mjs) and writes straight into the local SQLite database
// via TaskboardDatabase — NOT through the local HTTP API and NOT through
// server/cloud-proxy.mjs's forwarding path. Both matter: cloud-proxy.mjs is
// scheduled for deletion later in this change (design.md "遷移路徑從零建立，
// 不重用既有 CLI 匯出/匯入機制"), and — more importantly — while cloud mode
// is still configured (the exact situation this tool exists for),
// server/app.mjs forwards every /api/* request outside the local-companion
// allowlist to the cloud. POSTing through the local HTTP API here would
// silently round-trip migrated data back to the cloud instead of landing in
// the local project.
//
// threadId/threadBinding/developmentContext are deliberately NOT copied from
// the cloud record: per architect.md's plane separation, those are
// local-only "execution overlay" fields tied to a specific device/Codex
// thread and must not be replayed into a different local environment.
// startDate/dueDate/recurrence ARE copied: those are shared work-content
// fields, not execution state. Creator/assignee/author identity IS copied
// verbatim from the cloud record, so migrated content keeps its original
// attribution instead of appearing as authored by the migration tool.
async function migrateCloudBoard(options, overrides) {
  const projectId = requiredOption(options, "project");
  const dryRun = Boolean(options["dry-run"]);
  const env = overrides.env ?? process.env;
  const cloudConfigPath = options["cloud-config"] !== undefined
    ? resolveInputPath(options["cloud-config"], overrides)
    : defaultCloudConfigPath(env);
  const stateFilePath = options["state-file"] !== undefined
    ? resolveInputPath(options["state-file"], overrides)
    : defaultMigrationStatePath(env);
  const databasePath = defaultDatabasePath(env);
  const attachmentsDirectory = defaultAttachmentsDirectory(env);

  const credentials = await readCloudCompanionConfig(cloudConfigPath, overrides);
  const cloudReader = createCloudReader({ ...credentials, fetch: overrides.cloudFetch });

  const writer = openLocalWriter({
    databasePath,
    attachmentsDirectory,
    ...(overrides.openDatabase ? { openDatabase: overrides.openDatabase } : {}),
  });
  try {
    const project = writer.getProject(projectId);
    if (!project) {
      throw new TaskctlError(`Local project '${projectId}' does not exist`, {
        code: "PROJECT_NOT_FOUND",
        exitCode: 4,
      });
    }

    const snapshot = await collectCloudSnapshot(cloudReader);
    const state = await readMigrationState(stateFilePath, overrides);
    const bucket = sourceBucket(state, migrationSourceKey(credentials));

    if (dryRun) {
      return {
        dryRun: true,
        source: { remoteUrl: credentials.remoteUrl, actorName: credentials.actorName },
        target: { projectId },
        counts: snapshot.counts,
        alreadyMigrated: {
          tasks: snapshot.tasks.filter((task) => bucket.tasks[task.id]).length,
          comments: snapshot.comments.filter((comment) => bucket.comments[comment.id]).length,
          attachments: snapshot.attachments.filter((attachment) => bucket.attachments[attachment.id]).length,
        },
        tasks: snapshot.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          archived: Boolean(task.archivedAt),
        })),
        comments: snapshot.comments.map((comment) => ({ id: comment.id, taskId: comment.taskId })),
        attachments: snapshot.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          taskId: attachment.taskId,
          commentId: attachment.commentId,
        })),
      };
    }

    const counts = {
      tasks: { migrated: 0, skipped: 0, failed: 0 },
      comments: { migrated: 0, skipped: 0, failed: 0 },
      attachments: { migrated: 0, skipped: 0, failed: 0 },
    };
    const failures = [];
    const localTaskIdByCloudId = new Map();

    for (const cloudTask of snapshot.tasks) {
      const existing = bucket.tasks[cloudTask.id];
      if (existing) {
        counts.tasks.skipped += 1;
        localTaskIdByCloudId.set(cloudTask.id, existing.localTaskId);
        continue;
      }
      try {
        const actor = {
          type: cloudTask.creatorType,
          id: cloudTask.creatorId,
          name: cloudTask.creatorName,
          avatarUrl: cloudTask.creatorAvatarUrl,
        };
        const localTask = writer.createTask({
          projectId,
          title: cloudTask.title,
          description: cloudTask.description,
          status: cloudTask.status,
          priority: cloudTask.priority,
          labels: cloudTask.labels,
          sortOrder: cloudTask.sortOrder,
          threadId: undefined,
          threadBinding: undefined,
          actor,
          assignee: cloudTask.assignee,
          developmentContext: null,
          startDate: cloudTask.startDate ?? null,
          dueDate: cloudTask.dueDate ?? null,
          recurrence: cloudTask.recurrence ?? null,
        });
        if (cloudTask.archivedAt) {
          writer.archiveTask(localTask.id, localTask.version, actor);
        }
        bucket.tasks[cloudTask.id] = {
          localTaskId: localTask.id,
          contentDigest: taskContentDigest(cloudTask),
          migratedAt: new Date().toISOString(),
        };
        localTaskIdByCloudId.set(cloudTask.id, localTask.id);
        counts.tasks.migrated += 1;
      } catch (error) {
        counts.tasks.failed += 1;
        failures.push({
          type: "task",
          cloudId: cloudTask.id,
          title: cloudTask.title,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const cloudComment of snapshot.comments) {
      const existing = bucket.comments[cloudComment.id];
      if (existing) {
        counts.comments.skipped += 1;
        continue;
      }
      const localTaskId = localTaskIdByCloudId.get(cloudComment.taskId);
      if (!localTaskId) {
        counts.comments.failed += 1;
        failures.push({
          type: "comment",
          cloudId: cloudComment.id,
          reason: `Parent task '${cloudComment.taskId}' was not migrated`,
        });
        continue;
      }
      try {
        const localComment = writer.createComment(localTaskId, {
          body: cloudComment.body,
          threadId: undefined,
          threadBinding: undefined,
          actor: {
            type: cloudComment.authorType,
            id: cloudComment.authorId,
            name: cloudComment.authorName,
            avatarUrl: cloudComment.authorAvatarUrl,
          },
        });
        bucket.comments[cloudComment.id] = {
          localCommentId: localComment.id,
          localTaskId,
          contentDigest: commentContentDigest(cloudComment),
          migratedAt: new Date().toISOString(),
        };
        counts.comments.migrated += 1;
      } catch (error) {
        counts.comments.failed += 1;
        failures.push({
          type: "comment",
          cloudId: cloudComment.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const cloudAttachment of snapshot.attachments) {
      const existing = bucket.attachments[cloudAttachment.id];
      if (existing) {
        counts.attachments.skipped += 1;
        continue;
      }
      const localCommentId = cloudAttachment.commentId
        ? bucket.comments[cloudAttachment.commentId]?.localCommentId
        : null;
      const localTaskId = cloudAttachment.commentId
        ? null
        : localTaskIdByCloudId.get(cloudAttachment.taskId);
      if (cloudAttachment.commentId ? !localCommentId : !localTaskId) {
        counts.attachments.failed += 1;
        failures.push({
          type: "attachment",
          cloudId: cloudAttachment.id,
          filename: cloudAttachment.filename,
          reason: cloudAttachment.commentId
            ? `Parent comment '${cloudAttachment.commentId}' was not migrated`
            : `Parent task '${cloudAttachment.taskId}' was not migrated`,
        });
        continue;
      }
      try {
        const downloaded = await cloudReader.downloadAttachment(cloudAttachment.id);
        const attachmentInput = {
          filename: cloudAttachment.filename,
          contentType: cloudAttachment.contentType,
          kind: cloudAttachment.kind === "inline" ? "inline" : "attachment",
          bytes: downloaded.bytes,
        };
        const localAttachment = localCommentId
          ? await writer.createCommentAttachment(localCommentId, attachmentInput)
          : await writer.createTaskAttachment(localTaskId, attachmentInput);
        bucket.attachments[cloudAttachment.id] = {
          localAttachmentId: localAttachment.id,
          sha256: sha256Hex(downloaded.bytes),
          migratedAt: new Date().toISOString(),
        };
        counts.attachments.migrated += 1;
      } catch (error) {
        counts.attachments.failed += 1;
        failures.push({
          type: "attachment",
          cloudId: cloudAttachment.id,
          filename: cloudAttachment.filename,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await writeMigrationState(stateFilePath, state, overrides);

    return {
      target: { projectId },
      source: { remoteUrl: credentials.remoteUrl, actorName: credentials.actorName },
      counts,
      failures,
      stateFile: stateFilePath,
    };
  } finally {
    writer.close();
  }
}

async function readSecretFromInput(input, output) {
  if (!input.isTTY) {
    let value = "";
    for await (const chunk of input) value += chunk;
    return value.replace(/\r?\n$/, "");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;
    const wasPaused = input.isPaused();
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") {
          return finish(new TaskctlError("Cloud login canceled", {
            code: "CANCELED",
            exitCode: 2,
          }));
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    output.write("Shared key: ");
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
  });
}

async function listIssues(api, options) {
  if (options.status !== undefined) {
    assertStatus(options.status);
  }
  if (options.archived !== undefined && !["true", "false", "all"].includes(options.archived)) {
    throw usageError("--archived must be true, false, or all");
  }
  const search = new URLSearchParams();
  if (options.project !== undefined) search.set("projectId", options.project);
  if (options.status !== undefined) search.set("status", options.status);
  if (options.archived !== undefined) search.set("archived", options.archived);
  const query = search.size > 0 ? `?${search}` : "";
  return api.request("GET", `/api/tasks${query}`);
}

async function createIssue(api, options, overrides) {
  const status = options.status ?? "backlog";
  const priority = options.priority ?? "none";
  assertStatus(status);
  assertPriority(priority);

  const developmentContext = developmentContextFromOptions(options, overrides);
  const recurrence = recurrenceFromOptions(options);
  const threadId = resolveThreadId(options, overrides);
  return api.request("POST", "/api/tasks", {
    projectId: requiredOption(options, "project"),
    title: requiredOption(options, "title"),
    description: await resolveDescription(options, overrides),
    status,
    priority,
    labels: parseLabels(options.labels),
    threadId,
    ...optionalField("developmentContext", developmentContext),
    ...optionalField("startDate", options["start-date"]),
    ...optionalField("dueDate", options["due-date"]),
    ...optionalField("recurrence", recurrence),
  });
}

async function updateIssue(api, taskId, options, overrides) {
  if (options.status !== undefined) assertStatus(options.status);
  if (options.priority !== undefined) assertPriority(options.priority);

  const developmentContext = developmentContextFromOptions(options, overrides);
  const recurrence = recurrenceFromOptions(options);
  const threadId = resolveThreadId(options, overrides);
  const patch = {
    ...optionalField("projectId", options.project),
    ...optionalField("title", options.title),
    ...optionalField("status", options.status),
    ...optionalField("priority", options.priority),
    ...optionalField("labels", options.labels === undefined ? undefined : parseLabels(options.labels)),
    ...optionalField("developmentContext", developmentContext),
    ...optionalField("startDate", options["start-date"]),
    ...optionalField("dueDate", options["due-date"]),
    ...optionalField("recurrence", recurrence),
  };
  if (options.description !== undefined || options["description-file"] !== undefined) {
    patch.description = await resolveDescription(options, overrides);
  }

  if (Object.keys(patch).length === 0) {
    throw usageError("issue update requires at least one field to update");
  }
  patch.threadId = threadId;
  patch.version = await resolveVersion(api, taskId, options["if-version"]);
  return api.request("PATCH", taskPath(taskId), patch);
}

async function moveIssue(api, taskId, options, overrides) {
  const status = requiredOption(options, "status");
  assertStatus(status);
  const threadId = resolveThreadId(options, overrides);
  const threadBinding = threadBindingFromOptions(options);
  return api.request("POST", `${taskPath(taskId)}/move`, {
    status,
    threadId,
    ...optionalField("threadBinding", threadBinding),
    version: await resolveVersion(api, taskId, options["if-version"]),
  });
}

function threadBindingFromOptions(options) {
  const fields = [
    options["binding-thread-id"],
    options["binding-codex-project-id"],
    options["binding-codex-project-kind"],
    options["binding-codex-host-id"],
    options["binding-workspace-path"],
  ];
  if (options["clear-binding-thread"]) {
    if (fields.some((field) => field !== undefined)) {
      throw usageError("--clear-binding-thread cannot be combined with binding identity options");
    }
    return null;
  }
  if (fields.every((field) => field === undefined)) return undefined;
  const threadId = requiredOption(options, "binding-thread-id").trim();
  if (!threadId || threadId.length > 256) {
    throw usageError("--binding-thread-id must contain 1 to 256 characters");
  }
  const identityFields = fields.slice(1);
  if (identityFields.every((field) => field === undefined)) return { threadId };
  if (identityFields.some((field) => field === undefined)) {
    throw usageError("Binding identity requires project id, kind, host id, and workspace path");
  }
  const codexProjectId = options["binding-codex-project-id"].trim();
  const codexProjectKind = options["binding-codex-project-kind"];
  const codexHostId = options["binding-codex-host-id"].trim();
  const workspacePath = options["binding-workspace-path"];
  if (!codexProjectId || codexProjectId.length > 256) {
    throw usageError("--binding-codex-project-id must contain 1 to 256 characters");
  }
  if (codexProjectKind !== "local" && codexProjectKind !== "remote") {
    throw usageError("--binding-codex-project-kind must be local or remote");
  }
  if (
    !codexHostId
    || codexHostId.length > 256
    || (codexProjectKind === "local" && codexHostId !== "local")
    || (codexProjectKind === "remote" && codexHostId === "local")
  ) {
    throw usageError("--binding-codex-host-id does not match the project kind");
  }
  if (!path.posix.isAbsolute(workspacePath) && !path.win32.isAbsolute(workspacePath)) {
    throw usageError("--binding-workspace-path must be absolute");
  }
  return { threadId, codexProjectId, codexProjectKind, codexHostId, workspacePath };
}

async function archiveIssue(api, taskId, options, overrides, action) {
  const threadId = resolveThreadId(options, overrides);
  return api.request("POST", `${taskPath(taskId)}/${action}`, {
    threadId,
    version: await resolveVersion(api, taskId, options["if-version"]),
  });
}

async function getIssueTree(api, taskId, options) {
  const direction = requiredOption(options, "direction");
  if (direction !== "descendants" && direction !== "ancestors") {
    throw usageError("--direction must be descendants or ancestors");
  }
  const rawDepth = requiredOption(options, "depth");
  const depth = Number(rawDepth);
  if (!/^\d+$/.test(rawDepth) || !Number.isSafeInteger(depth) || depth < 1 || depth > 25) {
    throw usageError("--depth must be an integer from 1 to 25");
  }
  const query = new URLSearchParams({ direction, depth: String(depth) });
  return api.request("GET", `${taskPath(taskId)}/tree?${query}`);
}

async function mutateIssueRelation(api, action, taskId, options, overrides) {
  if (action !== "add" && action !== "remove") {
    throw usageError("issue relation action must be add or remove");
  }
  const type = requiredOption(options, "type");
  if (!["parent", "blocks", "blocked_by", "related"].includes(type)) {
    throw usageError("--type must be parent, blocks, blocked_by, or related");
  }
  const relatedTaskId = requiredOption(options, "issue");
  const threadId = resolveThreadId(options, overrides);
  const version = await resolveVersion(api, taskId, options["if-version"]);
  return api.request(
    action === "add" ? "POST" : "DELETE",
    `${taskPath(taskId)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    { threadId, version },
  );
}

async function currentContext(api, options, overrides) {
  const cwd = path.resolve(options.cwd ?? overrides.cwd ?? process.cwd());
  const response = await api.request("GET", "/api/projects");
  const projects = Array.isArray(response.projects) ? response.projects : [];
  const matchingProjects = projects
    .filter((candidate) => workspaceContains(candidate?.workspacePath, cwd))
    .sort((left, right) => right.workspacePath.length - left.workspacePath.length);
  const project = matchingProjects[0]
    ?? projects.find((candidate) => candidate?.id === DEFAULT_PROJECT_ID)
    ?? projects[0]
    ?? null;
  return { cwd, project };
}

function workspaceContains(workspacePath, cwd) {
  if (typeof workspacePath !== "string" || workspacePath.length === 0) return false;
  const relative = path.relative(path.resolve(workspacePath), cwd);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveInputPath(value, overrides) {
  return path.resolve(overrides.cwd ?? process.cwd(), value);
}

async function resolveVersion(api, taskId, rawVersion) {
  if (rawVersion !== undefined) {
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw usageError("--if-version must be a positive integer");
    }
    return version;
  }

  const response = await api.request("GET", taskPath(taskId));
  const version = response.task?.version;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TaskctlError("Taskboard service returned a task without a valid version", {
      code: "INVALID_RESPONSE",
      exitCode: 4,
    });
  }
  return version;
}

async function resolveDescription(options, overrides) {
  if (options.description !== undefined && options["description-file"] !== undefined) {
    throw usageError("Use either --description or --description-file, not both");
  }
  if (options["description-file"] === undefined) {
    return options.description ?? "";
  }

  const read = overrides.readFile ?? readFile;
  try {
    return await read(options["description-file"], "utf8");
  } catch (error) {
    throw new TaskctlError(`Cannot read description file: ${options["description-file"]}`, {
      code: "FILE_READ_FAILED",
      exitCode: 2,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseLabels(rawLabels) {
  if (rawLabels === undefined || rawLabels === "") return [];
  return [...new Set(rawLabels.split(",").map((label) => label.trim()).filter(Boolean))];
}

function developmentContextFromOptions(options, overrides) {
  const branch = options["git-branch"];
  const worktreePath = options["worktree-path"];
  const worktreeBranch = options["worktree-branch"];
  if (branch !== undefined && (worktreePath !== undefined || worktreeBranch !== undefined)) {
    throw usageError("Use either --git-branch or --worktree-path/--worktree-branch, not both");
  }
  if (worktreeBranch !== undefined && worktreePath === undefined) {
    throw usageError("--worktree-branch requires --worktree-path");
  }
  if (branch !== undefined) return { type: "branch", branch };
  if (worktreePath !== undefined) {
    return {
      type: "worktree",
      path: resolveInputPath(worktreePath, overrides),
      branch: worktreeBranch ?? null,
    };
  }
  return undefined;
}

function recurrenceFromOptions(options) {
  const rawInterval = options["recurrence-interval"];
  const unit = options["recurrence-unit"];
  if (rawInterval === undefined && unit === undefined) return undefined;
  if (rawInterval === undefined || unit === undefined) {
    throw usageError("Use --recurrence-interval and --recurrence-unit together");
  }
  const interval = Number(rawInterval);
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 365) {
    throw usageError("--recurrence-interval must be an integer from 1 to 365");
  }
  if (!["day", "week", "month", "year"].includes(unit)) {
    throw usageError("--recurrence-unit must be day, week, month, or year");
  }
  return { interval, unit };
}

function resolveThreadId(options, overrides) {
  const env = overrides.env ?? process.env;
  const value = options["thread-id"] ?? env.CODEX_THREAD_ID;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw usageError("Codex conversation attribution requires --thread-id or CODEX_THREAD_ID");
  }
  const threadId = value.trim();
  if (threadId.length > 256) {
    throw usageError("--thread-id and CODEX_THREAD_ID cannot exceed 256 characters");
  }
  return threadId;
}

function requiredOption(options, name) {
  const value = options[name];
  if (value === undefined || value === "") {
    throw usageError(`Missing required option --${name}`);
  }
  return value;
}

function optionalField(name, value) {
  return value === undefined ? {} : { [name]: value };
}

function validateOptions(options, allowedOptions) {
  for (const name of Object.keys(options)) {
    if (!allowedOptions.has(name) && !GLOBAL_OPTIONS.has(name)) {
      throw usageError(`Unknown option --${name}`);
    }
  }
}

function expectOperandCount(parsed, expected) {
  if (parsed.operands.length !== expected) {
    throw usageError(
      expected === 0
        ? `${parsed.resource} ${parsed.action} does not accept positional arguments`
        : `${parsed.resource} ${parsed.action} requires exactly ${expected} positional ${
            expected === 1 ? "argument" : "arguments"
          }`,
    );
  }
}

function assertStatus(status) {
  if (!isTaskStatus(status)) {
    throw usageError(`Invalid status: ${status}. Expected one of: ${TASK_STATUSES.join(", ")}`);
  }
}

function assertPriority(priority) {
  if (!isTaskPriority(priority)) {
    throw usageError(`Invalid priority: ${priority}`);
  }
}

function taskPath(taskId) {
  if (!taskId) throw usageError("Missing issue id");
  return `/api/tasks/${encodeURIComponent(taskId)}`;
}

function commentPath(commentId) {
  if (!commentId) throw usageError("Missing comment id");
  return `/api/comments/${encodeURIComponent(commentId)}`;
}

function attachmentContentPath(attachmentId) {
  if (!attachmentId) throw usageError("Missing attachment id");
  return `/api/attachments/${encodeURIComponent(attachmentId)}/content`;
}

function explicitVersion(rawVersion, { allowZero = false } = {}) {
  if (rawVersion === undefined) throw usageError("Missing required option --if-version");
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < (allowZero ? 0 : 1)) {
    throw usageError(`--if-version must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return version;
}

function normalizeBaseUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw usageError("CODEX_TASKBOARD_URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw usageError("CODEX_TASKBOARD_URL must use http or https");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function resolveApiUrl(baseUrl, pathname) {
  return new URL(pathname.replace(/^\//, ""), `${baseUrl}/`);
}

async function resolveTaskboardBaseUrl(env, overrides) {
  if (env.CODEX_TASKBOARD_URL !== undefined) {
    return { url: env.CODEX_TASKBOARD_URL, windowsTransport: false };
  }
  const configuredDescriptorPath = env.CODEX_TASKBOARD_RUNTIME_FILE;
  const isWsl = isWslEnvironment(env);
  const wslRuntimeFile = env.CODEX_TASKBOARD_WSL_RUNTIME_FILE;
  const descriptorCandidates = configuredDescriptorPath !== undefined
    ? [{
      path: configuredDescriptorPath,
      read: overrides.readFile ?? readFile,
      required: true,
      windowsTransport: false,
    }]
    : isWsl && wslRuntimeFile !== undefined
      ? [{
        path: wslRuntimeFile,
        read: overrides.readFile ?? readFile,
        required: true,
        windowsTransport: true,
      }]
      : [
        ...([isWsl ? await resolveWslRuntimeFile(overrides) : undefined]
          .filter(Boolean)
          .map((descriptorPath) => ({
            path: descriptorPath,
            read: overrides.readFile ?? readFile,
            required: false,
            windowsTransport: true,
          }))),
        {
          path: sourceRuntimeFile,
          read: readFile,
          required: false,
          windowsTransport: false,
        },
      ];

  for (const {
    path: descriptorPath,
    read,
    required,
    windowsTransport,
  } of descriptorCandidates) {
    try {
      const descriptor = JSON.parse(await read(descriptorPath, "utf8"));
      if (descriptor?.version !== 1 || typeof descriptor.url !== "string") {
        throw new TaskctlError("The active Taskboard launcher endpoint is invalid", {
          code: "INVALID_RESPONSE",
          exitCode: 4,
        });
      }
      return { url: descriptor.url, windowsTransport };
    } catch (error) {
      if (!required && error?.code === "ENOENT") continue;
      if (error instanceof TaskctlError) throw error;
      throw new TaskctlError("Cannot read the active Taskboard launcher endpoint", {
        code: "SERVICE_UNAVAILABLE",
        exitCode: 3,
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { url: DEFAULT_API_URL, windowsTransport: false };
}

function isWslEnvironment(env) {
  return env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined;
}

async function resolveWslRuntimeFile(overrides) {
  const run = overrides.execFile ?? execFileAsync;
  try {
    const windowsAppData = await run(
      "cmd.exe",
      ["/d", "/u", "/s", "/c", "set APPDATA"],
      { encoding: "buffer" },
    );
    const appDataLine = windowsAppData.stdout
      .toString("utf16le")
      .split(/\r?\n/)
      .find((line) => line.toUpperCase().startsWith("APPDATA="));
    const windowsAppDataPath = appDataLine?.slice("APPDATA=".length);
    if (windowsAppDataPath === undefined) return undefined;
    const appData = await run(
      "wslpath",
      ["-u", windowsAppDataPath],
      { encoding: "utf8" },
    );
    const appDataPath = appData.stdout.trim();
    return appDataPath
      ? path.join(appDataPath, "Codex Taskboard", "launcher-runtime.json")
      : undefined;
  } catch {
    return undefined;
  }
}

async function fetchThroughWindows(url, init, overrides) {
  const run = overrides.spawn ?? spawn;
  const marker = "__CODEX_TASKBOARD_CURL_RESPONSE__";
  const args = [
    "--disable",
    "--noproxy",
    "*",
    "--silent",
    "--show-error",
    "--request",
    init?.method ?? "GET",
  ];
  for (const [name, value] of new Headers(init?.headers)) {
    args.push("--header", `${name}: ${value}`);
  }
  if (init?.body !== undefined) args.push("--data-binary", "@-");
  args.push(
    "--write-out",
    `%{stderr}${marker}%{http_code}\t%{content_type}\t%{size_download}`,
    "--url",
    url.toString(),
  );

  return new Promise((resolve, reject) => {
    const child = run("curl.exe", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.on("error", reject);
    child.once("error", reject);
    child.once("close", (code) => {
      const errorText = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(errorText.trim() || `curl.exe exited with ${code}`));
        return;
      }
      const markerIndex = errorText.lastIndexOf(marker);
      if (markerIndex === -1) {
        reject(new Error("curl.exe did not return HTTP response metadata"));
        return;
      }
      const [statusText, contentType, contentLength] = errorText
        .slice(markerIndex + marker.length)
        .split("\t");
      const status = Number(statusText);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        reject(new Error("curl.exe returned invalid HTTP response metadata"));
        return;
      }
      const body = Buffer.concat(stdout);
      resolve(new Response(body.length === 0 ? null : body, {
        status,
        headers: {
          ...(contentType ? { "content-type": contentType } : {}),
          ...(contentLength ? { "content-length": contentLength } : {}),
        },
      }));
    });
    child.stdin.end(init?.body);
  });
}

async function resolveCompanionUrl(env, overrides) {
  const target = env.CODEX_TASKBOARD_COMPANION_URL !== undefined
    ? { url: env.CODEX_TASKBOARD_COMPANION_URL, windowsTransport: false }
    : await resolveTaskboardBaseUrl(env, overrides);
  let url;
  try {
    url = new URL(target.url);
  } catch {
    throw usageError("Local companion URL must be a valid URL");
  }
  const isLoopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  const instanceToken = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  const hasValidPathname = url.pathname === "/"
    || (/^[a-z0-9-]{16,128}$/i.test(instanceToken) && !instanceToken.includes("/"));
  if (
    !isLoopback
    || (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || !hasValidPathname
    || url.search
    || url.hash
  ) {
    throw usageError("Local companion URL must be a loopback HTTP or HTTPS endpoint");
  }
  return {
    url: url.toString().replace(/\/$/, ""),
    windowsTransport: target.windowsTransport,
  };
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TaskctlError("Taskboard service returned invalid JSON", {
      code: "INVALID_RESPONSE",
      exitCode: 4,
    });
  }
}

function extractApiError(payload, status) {
  if (payload?.error && typeof payload.error === "object") {
    return {
      code: payload.error.code ?? `HTTP_${status}`,
      message: payload.error.message ?? `Taskboard service returned HTTP ${status}`,
      details: payload.error.details,
    };
  }
  return {
    code: payload?.code ?? `HTTP_${status}`,
    message:
      payload?.message ??
      (typeof payload?.error === "string" ? payload.error : `Taskboard service returned HTTP ${status}`),
    details: payload?.details,
  };
}

function normalizeError(error) {
  if (error instanceof TaskctlError) return error;
  return new TaskctlError(error instanceof Error ? error.message : String(error), {
    code: "INTERNAL_ERROR",
    exitCode: 1,
  });
}

function usageError(message) {
  return new TaskctlError(message, { code: "USAGE_ERROR", exitCode: 2 });
}

function writeJson(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

const entrypoint = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entrypoint === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
