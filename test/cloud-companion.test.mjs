import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../cli/taskctl.mjs";
import { createTaskboardServer } from "../server/index.mjs";

const temporaryDirectories = [];

test.afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function capture() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    text() { return value; },
    json() { return JSON.parse(value); },
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runCli(argv, overrides = {}) {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {},
    ...overrides,
  });
  return { exitCode, stdout, stderr };
}

async function importCloudProxy() {
  return import("../server/cloud-proxy.mjs");
}

test("retired shared-cloud-board endpoints return a standard 404", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-retired-cloud-"));
  temporaryDirectories.push(directory);
  const app = createTaskboardServer({ dataDirectory: directory });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const [pathname, method] of [
      ["/api/local/cloud-session", "GET"],
      ["/api/local/cloud-session", "PUT"],
      ["/api/local/cloud-session", "DELETE"],
      ["/api/local/project-mappings/portfolio", "GET"],
      ["/api/local/project-mappings/portfolio", "PUT"],
    ]) {
      const response = await fetch(`${baseUrl}${pathname}`, { method });
      assert.equal(response.status, 404, `${method} ${pathname}`);
      assert.deepEqual(await response.json(), {
        error: { code: "NOT_FOUND", message: "API route not found" },
      }, `${method} ${pathname}`);
    }
  } finally {
    await app.close();
  }
});

test("cloud routing keeps machine-specific capability endpoints in the local companion", async () => {
  const { isLocalCompanionRoute } = await importCloudProxy();

  for (const pathname of [
    "/health",
    "/api/meta",
    "/api/device-workspaces",
    "/api/projects/portfolio/development-contexts",
    "/api/local/cloud-session",
    "/api/local/project-mappings/portfolio",
  ]) {
    assert.equal(isLocalCompanionRoute(pathname), true, pathname);
  }

  for (const pathname of [
    "/api/projects",
    "/api/tasks",
    "/api/tasks/PORTFOLIO-1",
    "/api/comments/comment-1",
    "/api/attachments/attachment-1",
    "/api/events",
  ]) {
    assert.equal(isLocalCompanionRoute(pathname), false, pathname);
  }
});

test("taskctl uses an explicit companion URL for ordinary commands before the legacy URL", async () => {
  let requestedUrl;
  const result = await runCli(["project", "list"], {
    env: {
      CODEX_TASKBOARD_COMPANION_URL: "http://127.0.0.1:49200",
      CODEX_TASKBOARD_URL: "https://legacy.example.test",
    },
    fetch: async (url) => {
      requestedUrl = url.toString();
      return jsonResponse({ projects: [] });
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(requestedUrl, "http://127.0.0.1:49200/api/projects");
});

test("without cloud configuration taskctl keeps using the local companion", async () => {
  let requestedUrl;
  let execCalled = false;
  const result = await runCli(["project", "list"], {
    env: { CODEX_THREAD_ID: "thread-local" },
    execFile: async () => {
      execCalled = true;
      assert.fail("cloud helper should not run for local commands");
    },
    fetch: async (url) => {
      requestedUrl = url.toString();
      return jsonResponse({ projects: [{ id: "local", name: "Local" }] });
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(requestedUrl, "http://127.0.0.1:47823/api/projects");
  assert.equal(execCalled, false);
  assert.deepEqual(result.stdout.json(), {
    projects: [{ id: "local", name: "Local" }],
    schemaVersion: 2,
  });
});
