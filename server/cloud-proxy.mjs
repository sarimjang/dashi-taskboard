const LOCAL_COMPANION_ROUTES = new Set([
  "/health",
  "/api/meta",
  "/api/device-workspaces",
  "/api/local/cloud-session",
]);

export function isLocalCompanionRoute(pathname) {
  return LOCAL_COMPANION_ROUTES.has(pathname)
    || pathname.startsWith("/api/local/")
    || /^\/api\/projects\/[^/]+\/development-contexts$/.test(pathname);
}
