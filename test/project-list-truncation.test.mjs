import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const typesSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("listProjects() surfaces the server's truncated flag instead of discarding it", () => {
  assert.match(typesSource, /export interface ProjectListResponse \{\s*projects: Project\[\];\s*truncated: boolean;\s*\}/);
  assert.match(apiSource, /export async function listProjects\(signal\?: AbortSignal\): Promise<ProjectListResponse> \{\s*return request<ProjectListResponse>\("\/api\/projects", \{ signal \}\);\s*\}/);
});

test("the two primary project-list loads store the truncated flag and show the user a notice", () => {
  assert.match(appSource, /const \[projectListTruncated, setProjectListTruncated\] = useState\(false\);/);
  assert.match(appSource, /const \[projectsResult, metadata, workspaces\] = await Promise\.all\(\[\s*listProjects\(signal\),/);
  assert.match(appSource, /const \[projectsResult, nextTemporaryTasks\] = await Promise\.all\(\[\s*listProjects\(\),/);
  const setterCalls = appSource.match(/setProjectListTruncated\(projectsResult\.truncated\);/g) ?? [];
  assert.equal(setterCalls.length, 2, "loadProjectList and refreshProjectList must both persist projectsResult.truncated");
  assert.match(appSource, /\{projectListTruncated && \(\s*<div className="notice-banner" role="status">/);
});

test("the two secondary refetches (project-create conflict, Jira save) still unwrap the projects array", () => {
  const secondaryCalls = appSource.match(/const \{ projects: nextProjects \} = await listProjects\(\);/g) ?? [];
  assert.equal(secondaryCalls.length, 2, "the create-conflict and Jira-save refetches should destructure .projects without touching truncated");
});

test("the notice banner has its own non-error styling", () => {
  assert.match(styles, /\.notice-banner \{[\s\S]*?background: var\(--accent-soft\);\s*\}/);
});
