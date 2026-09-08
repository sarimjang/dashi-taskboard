import { describe, expect, it } from "vitest";
import { classifyMediaUrl, isPrivateNetworkHostname } from "./mediaAccessPolicy";

const BASE = "http://127.0.0.1:47823/";

describe("classifyMediaUrl", () => {
  it("allows same-origin Taskboard attachment URLs to auto-load", () => {
    expect(classifyMediaUrl("api/attachments/abc-123/content", BASE)).toBe("attachment");
    expect(classifyMediaUrl("/api/attachments/abc-123/content", BASE)).toBe("attachment");
    expect(classifyMediaUrl("http://127.0.0.1:47823/api/attachments/abc-123/content", BASE)).toBe("attachment");
  });

  it("requires a click for ordinary external hosts", () => {
    expect(classifyMediaUrl("https://example.com/pixel.png", BASE)).toBe("external");
    expect(classifyMediaUrl("https://cdn.example.com/avatar.jpg", BASE)).toBe("external");
  });

  it("does not trust an attachment-shaped path on a different origin", () => {
    expect(classifyMediaUrl("https://attacker.invalid/api/attachments/abc/content", BASE)).toBe("external");
  });

  it("blocks loopback, link-local, and private network destinations outright", () => {
    expect(classifyMediaUrl("http://127.0.0.1/probe.png", BASE)).toBe("blocked");
    expect(classifyMediaUrl("http://localhost/probe.png", BASE)).toBe("blocked");
    expect(classifyMediaUrl("http://[::1]/probe.png", BASE)).toBe("blocked");
    expect(classifyMediaUrl("http://169.254.169.254/latest/meta-data/", BASE)).toBe("blocked");
    expect(classifyMediaUrl("http://10.0.0.5/probe.png", BASE)).toBe("blocked");
    expect(classifyMediaUrl("http://172.16.0.5/probe.png", BASE)).toBe("blocked");
    expect(classifyMediaUrl("http://192.168.1.1/probe.png", BASE)).toBe("blocked");
    expect(classifyMediaUrl("http://router.local/probe.png", BASE)).toBe("blocked");
  });

  it("does not misclassify public addresses that merely start with a private-looking octet", () => {
    expect(classifyMediaUrl("https://172.32.0.1/pixel.png", BASE)).toBe("external");
    expect(classifyMediaUrl("https://1.2.3.4/pixel.png", BASE)).toBe("external");
  });

  it("blocks non-http(s) schemes and unparsable URLs", () => {
    expect(classifyMediaUrl("javascript:alert(1)", BASE)).toBe("blocked");
    expect(classifyMediaUrl("data:image/png;base64,AAA", BASE)).toBe("blocked");
    expect(classifyMediaUrl("http://[invalid", BASE)).toBe("blocked");
  });
});

describe("isPrivateNetworkHostname", () => {
  it("classifies IPv4-mapped IPv6 loopback as private", () => {
    expect(isPrivateNetworkHostname("::ffff:127.0.0.1")).toBe(true);
  });

  it("classifies IPv6 unique-local and link-local ranges as private", () => {
    expect(isPrivateNetworkHostname("fc00::1")).toBe(true);
    expect(isPrivateNetworkHostname("fe80::1")).toBe(true);
  });

  it("classifies ordinary public hostnames as not private", () => {
    expect(isPrivateNetworkHostname("example.com")).toBe(false);
  });
});
