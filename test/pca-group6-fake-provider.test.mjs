import assert from "node:assert/strict";
import { test } from "node:test";

// Importing jira-integration.mjs triggers its module-load-time `registerProvider("jira", ...)`
// call (design.md §2 correction), so JIRA_CAPABILITIES below can be compared against the same
// values the real registry hands back for "jira".
import { JIRA_CAPABILITIES } from "../server/jira-integration.mjs";
import { getProviderCapabilities, registerProvider } from "../server/provider-registry.mjs";

// tasks.md §6.1: register a test-only fake provider with a capabilities combination that
// matches neither Jira nor the local defaults, and prove the UI reflects it with zero
// component-conditional changes. The registry-mechanics half lives here (server-only, since
// web/src cannot import server modules — design.md §5 correction); the UI-consuming half
// lives in web/src/components/OtherTasksPanel.test.tsx and TaskContextMenu.test.tsx, which
// build the identical literal objects asserted below and feed them straight into
// ArchivedTasksColumn / TaskContextMenu.

const MANUAL_DELETE_ONLY_CAPABILITIES = { ...JIRA_CAPABILITIES, manualDelete: true };
const CREATE_ISSUE_ONLY_CAPABILITIES = { ...JIRA_CAPABILITIES, createIssue: true };

registerProvider("pca-group6-fake-provider", { capabilities: MANUAL_DELETE_ONLY_CAPABILITIES });
registerProvider("pca-group6-fake-createissue-provider", { capabilities: CREATE_ISSUE_ONLY_CAPABILITIES });

test("a fake provider registered with manualDelete: true (Jira otherwise) is retrievable and differs from Jira only on manualDelete", () => {
  const capabilities = getProviderCapabilities("pca-group6-fake-provider");
  assert.deepEqual(capabilities, MANUAL_DELETE_ONLY_CAPABILITIES);
  assert.equal(capabilities.manualDelete, true);
  assert.equal(capabilities.manualArchive, false);
  assert.notDeepEqual(capabilities, JIRA_CAPABILITIES);
});

test("a fake provider registered with createIssue: true (Jira otherwise) is retrievable and differs from Jira only on createIssue", () => {
  const capabilities = getProviderCapabilities("pca-group6-fake-createissue-provider");
  assert.deepEqual(capabilities, CREATE_ISSUE_ONLY_CAPABILITIES);
  assert.equal(capabilities.createIssue, true);
  assert.equal(capabilities.manualArchive, false);
  assert.notDeepEqual(capabilities, JIRA_CAPABILITIES);
});
