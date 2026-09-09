import { afterEach, describe, expect, it, vi } from "vitest";

// A tiny mocked MAX_ATTACHMENT_SIZE keeps the "oversized payload" fixture a few
// bytes long instead of needing a real ~33MB base64 string to cross the actual
// 25MB production limit — the comparison logic under test is the same either way.
const MOCKED_MAX_ATTACHMENT_SIZE = 12;

vi.mock("./PendingAttachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./PendingAttachments")>();
  return { ...actual, MAX_ATTACHMENT_SIZE: MOCKED_MAX_ATTACHMENT_SIZE };
});

const { createInlineMediaSegments } = await import("./InlineMediaComposer");

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pendingImagePseudoUrl(dataKey: string, mimeType = "image/png"): string {
  const typeKey = base64UrlEncode(new TextEncoder().encode(mimeType));
  return `taskboard://composer-reference/v1/pending-image/${typeKey}.${dataKey}`;
}

describe("pendingImageComposerReference size limit (CWE-400 regression, bd: dashi-taskboard-kh0)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decodes a pending-image pseudo-URL within the size limit into a pending-image segment", () => {
    const bytes = new TextEncoder().encode("ok"); // 2 bytes, well under the mocked 12-byte limit
    const url = pendingImagePseudoUrl(base64UrlEncode(bytes));
    const segments = createInlineMediaSegments(`![cat.png](${url})`);

    const image = segments.find((segment) => segment.type === "pending-image");
    expect(image).toBeTruthy();
    if (image?.type !== "pending-image") throw new Error("expected a pending-image segment");
    expect(image.file.type).toBe("image/png");
    expect(image.dataUrl).toContain("data:image/png;base64,");
    expect(segments.some((segment) => segment.type === "persisted-image")).toBe(false);
  });

  it("falls back instead of decoding a pending-image payload larger than MAX_ATTACHMENT_SIZE", () => {
    // dataKey length chosen so the approximate decoded size (length * 3 / 4) clearly
    // exceeds the mocked limit without needing a real, decodable base64 payload.
    const oversizedDataKey = "A".repeat(100);
    const url = pendingImagePseudoUrl(oversizedDataKey);
    const atobSpy = vi.spyOn(globalThis, "atob");

    const segments = createInlineMediaSegments(`![huge.png](${url})`);

    expect(segments.some((segment) => segment.type === "pending-image")).toBe(false);
    const fallback = segments.find((segment) => segment.type === "persisted-image");
    expect(fallback).toBeTruthy();
    if (fallback?.type !== "persisted-image") throw new Error("expected a persisted-image fallback segment");
    expect(fallback.url).toBe(url);
    // The size guard must reject before ever calling atob on the oversized payload
    // itself; only the (tiny, fixed-size) mime-type key may still be decoded.
    for (const call of atobSpy.mock.calls) {
      expect(call[0].length).toBeLessThan(oversizedDataKey.length);
    }
  });

  it("reuses the cached decode result instead of re-decoding the same pseudo-URL", () => {
    const bytes = new TextEncoder().encode("cache-me"); // 8 bytes, under the mocked 12-byte limit
    const url = pendingImagePseudoUrl(base64UrlEncode(bytes));
    const markdown = `![cached.png](${url})`;
    const atobSpy = vi.spyOn(globalThis, "atob");

    const first = createInlineMediaSegments(markdown);
    expect(first.some((segment) => segment.type === "pending-image")).toBe(true);
    const callsAfterFirstDecode = atobSpy.mock.calls.length;
    expect(callsAfterFirstDecode).toBeGreaterThan(0);

    const second = createInlineMediaSegments(markdown);
    expect(second.some((segment) => segment.type === "pending-image")).toBe(true);
    expect(atobSpy.mock.calls.length).toBe(callsAfterFirstDecode);
  });
});
