import { afterEach, describe, expect, it, vi } from "vitest";
import { listProjects } from "./api";

function stubFetchJson(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listProjects", () => {
  it("surfaces truncated: true from the server so callers can warn that the list was capped", async () => {
    stubFetchJson({ projects: [{ id: "p1" }, { id: "p2" }], truncated: true });

    const result = await listProjects();

    expect(result.truncated).toBe(true);
    expect(result.projects).toHaveLength(2);
  });

  it("surfaces truncated: false when the full project list fit within the server cap", async () => {
    stubFetchJson({ projects: [{ id: "p1" }], truncated: false });

    const result = await listProjects();

    expect(result.truncated).toBe(false);
    expect(result.projects).toHaveLength(1);
  });
});
