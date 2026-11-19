const ROLE_ALIASES = Object.freeze({
  owner: "owner",
  org_owner: "owner",
  admin: "admin",
  org_admin: "admin",
  developer: "member",
  operator: "member",
  member: "member",
  org_member: "member",
  viewer: "viewer",
  org_viewer: "viewer"
});

function permissionSet(value) {
  if (Array.isArray(value)) return new Set(value.map(String));
  if (value && typeof value === "object") {
    return new Set(Object.entries(value).filter(([, enabled]) => enabled === true).map(([key]) => key));
  }
  return new Set();
}

function projectRolePermissions(role) {
  const roleKey = String(role || "").toLowerCase();
  if (["owner", "admin"].includes(roleKey)) {
    return new Set(["read", "write", "admin", "builds.trigger", "deployments.create", "deployments.production"]);
  }
  if (roleKey === "developer") return new Set(["read", "write", "builds.trigger"]);
  if (roleKey === "operator") return new Set(["read", "write", "deployments.create"]);
  if (roleKey === "viewer") return new Set(["read"]);
  return new Set();
}

export function normalizeStudioRole(role) {
  return ROLE_ALIASES[String(role || "").toLowerCase()] || "viewer";
}

export function studioCapabilities({ role, projectRole, permissions, active = true } = {}) {
  const normalizedRole = normalizeStudioRole(projectRole || role);
  const explicit = permissionSet(permissions);
  for (const permission of projectRolePermissions(projectRole)) explicit.add(permission);
  const enabled = active !== false;
  const manager = enabled && ["owner", "admin"].includes(normalizedRole);
  const member = enabled && normalizedRole === "member";
  const viewer = enabled && normalizedRole === "viewer";
  const has = permission => manager || explicit.has(permission);
  const canEdit = enabled && (manager || has("write"));
  const canRun = canEdit && (manager || has("builds.trigger"));
  const canDeployTesting = enabled && (manager || has("deployments.create"));

  return Object.freeze({
    role: normalizedRole,
    canViewCode: enabled && (manager || member || viewer || has("read")),
    canEditCode: canEdit,
    canRunAgent: canRun,
    canUseTerminal: canRun,
    canApplyAIChanges: canEdit,
    canManageSchema: enabled && (manager || has("write")),
    canPrepareVersion: enabled && (manager || has("builds.trigger")),
    canDeployTesting,
    canPublishProduction: enabled && (manager || has("deployments.production")),
    canViewTechnicalDetails: enabled && (manager || member || has("read"))
  });
}

export function requireStudioCapability(capabilities, capability) {
  if (!capabilities?.[capability]) {
    throw Object.assign(new Error("You do not have permission to use this Build Studio action."), {
      status: 403,
      code: "STUDIO_PERMISSION_DENIED",
      capability
    });
  }
}
