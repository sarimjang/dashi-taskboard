import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../server/database.mjs";
import { createJiraIntegration } from "../server/jira-integration.mjs";

const EXPECTED_JIRA_CAPABILITIES = {
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

const ISSUE_PROVIDER_METHODS = [
  "configure",
  "status",
  "listIssues",
  "getIssue",
  "createIssue",
  "updateIssue",
  "listStatuses",
  "listLabels",
  "listComments",
  "reconcileIssue",
  "reconcileSince",
];

const PRE_EXISTING_METHODS = ["status", "configure", "sync", "reconcile", "updateTask", "moveTask"];

const NOT_YET_SPECIFIED_METHODS = [
  "listIssues",
  "getIssue",
  "createIssue",
  "updateIssue",
  "listStatuses",
  "listLabels",
  "listComments",
  "reconcileIssue",
  "reconcileSince",
];

test("createJiraIntegration(...).capabilities reflects Jira's actual (non-)support for each field", () => {
  const jira = createJiraIntegration({});
  assert.deepEqual(jira.capabilities, EXPECTED_JIRA_CAPABILITIES);
});

test("createJiraIntegration(...).capabilities has exactly the twelve ProviderCapabilities fields", () => {
  const jira = createJiraIntegration({});
  assert.deepEqual(Object.keys(jira.capabilities).sort(), Object.keys(EXPECTED_JIRA_CAPABILITIES).sort());
});

test("createJiraIntegration(...) exposes every architect.md IssueProvider method name as a function", () => {
  const jira = createJiraIntegration({});
  for (const method of ISSUE_PROVIDER_METHODS) {
    assert.equal(typeof jira[method], "function", `expected jira.${method} to be a function`);
  }
});

test("createJiraIntegration(...) still exposes the pre-existing method names app.mjs depends on", () => {
  const jira = createJiraIntegration({});
  for (const method of PRE_EXISTING_METHODS) {
    assert.equal(typeof jira[method], "function", `expected jira.${method} to still be a function`);
  }
});

test("net-new IssueProvider methods with no architect.md payload shape throw a labeled, undisguised error instead of fabricating a response", async () => {
  const jira = createJiraIntegration({});
  for (const method of NOT_YET_SPECIFIED_METHODS) {
    await assert.rejects(
      () => jira[method](),
      (error) => error instanceof ApiError && error.code === "JIRA_PROVIDER_METHOD_UNSPECIFIED",
      `expected jira.${method}() to reject with JIRA_PROVIDER_METHOD_UNSPECIFIED`,
    );
  }
});
