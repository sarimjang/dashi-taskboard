import assert from "node:assert/strict";
import { test } from "node:test";

import { createJiraIntegration } from "../server/jira-integration.mjs";
import { getProvider, getProviderCapabilities, registerProvider } from "../server/provider-registry.mjs";

const LOCAL_DEFAULT_CAPABILITIES = {
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

test("getProviderCapabilities returns local defaults with every mutation field true for a null source", () => {
  assert.deepEqual(getProviderCapabilities(null), LOCAL_DEFAULT_CAPABILITIES);
});

test("getProvider returns null for a null source", () => {
  assert.equal(getProvider(null), null);
});

test("getProviderCapabilities returns local defaults for an unregistered source string", () => {
  assert.deepEqual(getProviderCapabilities("unregistered-test-source"), LOCAL_DEFAULT_CAPABILITIES);
});

test("getProvider returns null for an unregistered source string", () => {
  assert.equal(getProvider("unregistered-test-source"), null);
});

test("getProviderCapabilities(\"jira\") matches createJiraIntegration(...).capabilities (pca-group2, §2.2)", () => {
  const jira = createJiraIntegration({});
  assert.deepEqual(getProviderCapabilities("jira"), jira.capabilities);
  assert.notDeepEqual(getProviderCapabilities("jira"), LOCAL_DEFAULT_CAPABILITIES);
});

test("getProvider(\"jira\") returns the registered provider (not null, not the live createJiraIntegration instance)", () => {
  const registered = getProvider("jira");
  assert.notEqual(registered, null);
  assert.deepEqual(Object.keys(registered), ["capabilities"]);
});

test("getProviderCapabilities and getProvider return the registered provider's own values for a registered source", () => {
  const fakeCapabilities = {
    createIssue: true,
    updateAssignee: false,
    comments: "read",
    attachments: "none",
    relations: "read",
    webhook: false,
    incrementalSync: true,
    manualArchive: false,
    manualDelete: true,
    manualMove: false,
    assigneeEdit: false,
    projectReassign: false,
  };
  const fakeProvider = { capabilities: fakeCapabilities };

  registerProvider("test-fake-provider", fakeProvider);

  assert.equal(getProvider("test-fake-provider"), fakeProvider);
  assert.deepEqual(getProviderCapabilities("test-fake-provider"), fakeCapabilities);
});

test("local default capabilities object has exactly the twelve ProviderCapabilities fields", () => {
  assert.deepEqual(
    Object.keys(getProviderCapabilities(null)).sort(),
    Object.keys(LOCAL_DEFAULT_CAPABILITIES).sort(),
  );
});
