import { afterEach, describe, expect, it, vi } from "vitest";
import { stableComposerReferenceId, stableComposerReferenceKey } from "./AiChat";

describe("stableComposerReferenceId size limit (CWE-400 regression, bd: dashi-taskboard-56t)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips a normal-length skill id through the key encoding", () => {
    const key = stableComposerReferenceKey("code-review", "skill");
    expect(stableComposerReferenceId(key, "skill")).toBe("code-review");
  });

  it("round-trips a normal-length agent id through the key encoding", () => {
    const key = stableComposerReferenceKey("dashi-taskboard-pm", "agent");
    expect(stableComposerReferenceId(key, "agent")).toBe("dashi-taskboard-pm");
  });

  it("round-trips a long but realistic namespaced skill id (well under the size guard)", () => {
    const longButRealisticId = `plugin_oh-my-claudecode_t:${"x".repeat(150)}`;
    const key = stableComposerReferenceKey(longButRealisticId, "skill");
    expect(stableComposerReferenceId(key, "skill")).toBe(longButRealisticId);
  });

  it("falls back to null instead of decoding a referenceKey far longer than any real skill/agent id, without ever calling atob", () => {
    // Valid base64url charset and length % 4 !== 1, so this exercises the new size
    // guard specifically rather than the pre-existing charset/padding checks.
    const oversizedKey = "A".repeat(2000);
    const atobSpy = vi.spyOn(globalThis, "atob");

    expect(stableComposerReferenceId(oversizedKey, "skill")).toBeNull();
    expect(atobSpy).not.toHaveBeenCalled();
  });

  it("still rejects malformed (non-base64url) keys the same way as before the size guard was added", () => {
    expect(stableComposerReferenceId("not valid base64url!", "skill")).toBeNull();
  });
});
