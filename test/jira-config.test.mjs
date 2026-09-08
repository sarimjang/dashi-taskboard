import assert from "node:assert/strict";
import { test } from "node:test";

import { JiraConfigError, normalizeJiraUrl } from "../server/jira-config.mjs";

test("normalizeJiraUrl accepts https remote URLs by default", () => {
  assert.equal(normalizeJiraUrl("https://issues.example.com/jira/"), "https://issues.example.com/jira");
});

test("normalizeJiraUrl rejects a plain http remote URL and explains why", () => {
  assert.throws(
    () => normalizeJiraUrl("http://issues.example.com/"),
    (error) => error instanceof JiraConfigError
      && error.code === "JIRA_URL_REQUIRES_HTTPS"
      && /HTTPS/.test(error.message)
      && /CODEX_TASKBOARD_JIRA_ALLOW_INSECURE_LOOPBACK/.test(error.message),
  );
});

test("normalizeJiraUrl rejects http on loopback when the dev flag is not set", () => {
  assert.throws(
    () => normalizeJiraUrl("http://127.0.0.1:8080"),
    (error) => error instanceof JiraConfigError && error.code === "JIRA_URL_REQUIRES_HTTPS",
  );
  assert.throws(
    () => normalizeJiraUrl("http://127.0.0.1:8080", false),
    (error) => error instanceof JiraConfigError && error.code === "JIRA_URL_REQUIRES_HTTPS",
  );
});

test("normalizeJiraUrl rejects http on a non-loopback host even when the dev flag is set", () => {
  assert.throws(
    () => normalizeJiraUrl("http://issues.example.com/", true),
    (error) => error instanceof JiraConfigError && error.code === "JIRA_URL_REQUIRES_HTTPS",
  );
});

test("normalizeJiraUrl allows http on loopback only with the explicit dev flag", () => {
  assert.equal(normalizeJiraUrl("http://127.0.0.1:8080/jira", true), "http://127.0.0.1:8080/jira");
  assert.equal(normalizeJiraUrl("http://localhost:8080/jira", true), "http://localhost:8080/jira");
  assert.equal(normalizeJiraUrl("http://[::1]:8080/jira", true), "http://[::1]:8080/jira");
});

test("normalizeJiraUrl rejects a hostname that merely starts with a loopback prefix", () => {
  assert.throws(
    () => normalizeJiraUrl("http://127.0.0.1.evil.com/jira", true),
    (error) => error instanceof JiraConfigError && error.code === "JIRA_URL_REQUIRES_HTTPS",
  );
});

test("normalizeJiraUrl reads the env var opt-in when no explicit flag is passed", () => {
  const originalValue = process.env.CODEX_TASKBOARD_JIRA_ALLOW_INSECURE_LOOPBACK;
  try {
    delete process.env.CODEX_TASKBOARD_JIRA_ALLOW_INSECURE_LOOPBACK;
    assert.throws(
      () => normalizeJiraUrl("http://127.0.0.1:8080"),
      (error) => error instanceof JiraConfigError && error.code === "JIRA_URL_REQUIRES_HTTPS",
    );

    process.env.CODEX_TASKBOARD_JIRA_ALLOW_INSECURE_LOOPBACK = "1";
    assert.equal(normalizeJiraUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");

    process.env.CODEX_TASKBOARD_JIRA_ALLOW_INSECURE_LOOPBACK = "true";
    assert.throws(
      () => normalizeJiraUrl("http://127.0.0.1:8080"),
      (error) => error instanceof JiraConfigError && error.code === "JIRA_URL_REQUIRES_HTTPS",
    );
  } finally {
    if (originalValue === undefined) delete process.env.CODEX_TASKBOARD_JIRA_ALLOW_INSECURE_LOOPBACK;
    else process.env.CODEX_TASKBOARD_JIRA_ALLOW_INSECURE_LOOPBACK = originalValue;
  }
});
