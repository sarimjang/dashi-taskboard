// Centralized policy for whether a media URL (markdown image, task cover,
// actor avatar) may be fetched automatically. Only Taskboard attachment
// URLs are trusted to auto-load; everything else requires an explicit user
// click, and destinations on loopback/link-local/private networks are
// refused outright (task content and avatar URLs are attacker-controlled —
// see server/app.mjs parseActorFromHeaders, which accepts any http(s) host).

export type MediaUrlDecision = "attachment" | "blocked" | "external";

const IPV4_PRIVATE_HOST = /^(?:127\.|10\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.)/;

export function isPrivateNetworkHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (IPV4_PRIVATE_HOST.test(host)) return true;
  const ipv4Mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped) return IPV4_PRIVATE_HOST.test(ipv4Mapped[1]);
  if (host === "::1" || host === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
  return false;
}

export function isTaskboardAttachmentUrl(rawUrl: string, base: string = document.baseURI): boolean {
  let resolved: URL;
  let origin: URL;
  try {
    resolved = new URL(rawUrl, base);
    origin = new URL(base);
  } catch {
    return false;
  }
  return resolved.origin === origin.origin
    && /^\/api\/attachments\/[^/?#]+\/content$/.test(resolved.pathname);
}

export function classifyMediaUrl(rawUrl: string, base: string = document.baseURI): MediaUrlDecision {
  if (isTaskboardAttachmentUrl(rawUrl, base)) return "attachment";
  let resolved: URL;
  try {
    resolved = new URL(rawUrl, base);
  } catch {
    return "blocked";
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return "blocked";
  if (isPrivateNetworkHostname(resolved.hostname)) return "blocked";
  return "external";
}
