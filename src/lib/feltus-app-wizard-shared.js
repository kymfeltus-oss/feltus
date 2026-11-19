export const APP_TYPES = Object.freeze([
  "web_application",
  "internal_tool",
  "api_backend",
  "ai_application",
  "data_application",
  "other"
]);

export const SETUP_STEPS = Object.freeze([
  "basics",
  "data",
  "knowledge",
  "ai",
  "code",
  "environment",
  "review"
]);

export const WORKSPACE_PAGES = Object.freeze([
  "overview",
  "code",
  "source",
  "data",
  "relationships",
  "documents",
  "storage-backup",
  "ai",
  "builds",
  "deployments",
  "environments",
  "my-services",
  "my-environment",
  "activity",
  "infrastructure",
  "logs",
  "team",
  "settings"
]);

export const FELTUS_PLATFORM_SERVICE_COMPONENTS = Object.freeze({
  hosting: Object.freeze(["runtime_hosting", "monitoring_health", "backups_recovery"]),
  data_sign_in: Object.freeze(["database", "authentication", "object_storage"]),
  publish: Object.freeze(["build_execution", "deployment_execution"]),
  storage_backup: Object.freeze(["object_storage", "backups_recovery"]),
  my_services: Object.freeze([]),
  developer_tools: Object.freeze([])
});
export const FELTUS_PLATFORM_SERVICE_IDS = Object.freeze(Object.keys(FELTUS_PLATFORM_SERVICE_COMPONENTS));
export const FELTUS_SUPPORTED_PLATFORM_SERVICE_IDS = Object.freeze([
  "hosting",
  "data_sign_in",
  "publish",
  "storage_backup",
  "my_services",
  "developer_tools"
]);
export const FELTUS_FULL_PLATFORM_SERVICE_IDS = Object.freeze([
  "hosting",
  "data_sign_in",
  "publish",
  "storage_backup",
  "developer_tools"
]);

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resumeSetupPath(app) {
  const aliases = { documents: "knowledge", relationships: "data", build: "review" };
  const current = aliases[app?.setup_current_step] || app?.setup_current_step;
  const step = SETUP_STEPS.includes(current) ? current : "basics";
  return `/apps/${encodeURIComponent(app.id)}/setup/${step}`;
}

export function resolveAppRoute(pathname) {
  const path = String(pathname || "/").split("?")[0].replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/index.html") return { kind: "home" };
  if (path === "/apps") return { kind: "apps" };
  if (path === "/apps/import") return { kind: "existing-app-import" };
  if (path === "/apps/new") return { kind: "new-app" };
  if (path === "/apps/new/basics") return { kind: "new-basics" };
  if (path === "/services") return { kind: "services" };
  if (path === "/services/use") return { kind: "services-use" };
  if (path === "/domains") return { kind: "domains" };
  if (path === "/activity") return { kind: "activity" };
  if (path === "/usage") return { kind: "usage" };
  if (path === "/settings") return { kind: "settings" };

  const appRoute = /^\/apps\/([0-9a-f-]{36})(?:\/(.*))?$/i.exec(path);
  if (!appRoute || !UUID_PATTERN.test(appRoute[1])) return { kind: "not-found" };
  const appId = appRoute[1];
  const rest = appRoute[2] || "";
  if (!rest) return { kind: "app-overview", appId };
  if (rest === "deletion") return { kind: "deletion-status", appId };

  const setup = /^setup\/([a-z-]+)$/.exec(rest);
  if (setup?.[1] === "relationships") return { kind: "workspace-page", appId, page: "relationships" };
  if (setup?.[1] === "documents") return { kind: "setup-step", appId, step: "knowledge" };
  if (setup?.[1] === "build") return { kind: "setup-step", appId, step: "review" };
  if (setup && SETUP_STEPS.includes(setup[1])) return { kind: "setup-step", appId, step: setup[1] };
  if (WORKSPACE_PAGES.includes(rest)) return { kind: "workspace-page", appId, page: rest };
  return { kind: "not-found" };
}

export function isAppShellRoute(pathname) {
  return resolveAppRoute(pathname).kind !== "not-found";
}

export function nextSetupRoute(appId, step) {
  const index = SETUP_STEPS.indexOf(step);
  if (index < 0 || index >= SETUP_STEPS.length - 1) return null;
  return `/apps/${encodeURIComponent(appId)}/setup/${SETUP_STEPS[index + 1]}`;
}

export function previousSetupRoute(appId, step) {
  const index = SETUP_STEPS.indexOf(step);
  if (index <= 0) return `/apps/${encodeURIComponent(appId)}`;
  return `/apps/${encodeURIComponent(appId)}/setup/${SETUP_STEPS[index - 1]}`;
}
