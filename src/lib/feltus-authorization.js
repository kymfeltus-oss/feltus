const WORKSPACE_ROLE_ALIASES = Object.freeze({
  owner: "owner",
  org_owner: "owner",
  admin: "admin",
  org_admin: "admin",
  member: "member",
  org_member: "member",
  viewer: "viewer",
  org_viewer: "viewer"
});

const PROJECT_ROLE_PERMISSIONS = Object.freeze({
  owner: ["read", "write", "admin", "builds.trigger", "deployments.create", "deployments.production"],
  admin: ["read", "write", "admin", "builds.trigger", "deployments.create", "deployments.production"],
  developer: ["read", "write", "builds.trigger"],
  operator: ["read", "write", "deployments.create"],
  viewer: ["read"]
});

function accessRole(access = {}) {
  return WORKSPACE_ROLE_ALIASES[String(access.workspaceRole || access.role || "").toLowerCase()] || null;
}

function permissionSet(access = {}) {
  const permissions = new Set(Array.isArray(access.permissions) ? access.permissions.map(String) : []);
  const projectRole = String(access.projectRole || "").toLowerCase();
  for (const permission of PROJECT_ROLE_PERMISSIONS[projectRole] || []) permissions.add(permission);
  return permissions;
}

function isActive(access = {}) {
  return (access.status || "active") === "active";
}

function isWorkspaceManager(access = {}) {
  return isActive(access) && ["owner", "admin"].includes(accessRole(access));
}

function hasProjectPermission(access, permission) {
  if (!isActive(access)) return false;
  if (isWorkspaceManager(access)) return true;
  return permissionSet(access).has(permission);
}

export function normalizeWorkspaceRole(role) {
  return WORKSPACE_ROLE_ALIASES[String(role || "").toLowerCase()] || null;
}

export function canManageWorkspace(access) {
  return isWorkspaceManager(access);
}

export function canManagePeople(access) {
  return isWorkspaceManager(access);
}

export function canManageBilling(access) {
  return isActive(access) && accessRole(access) === "owner";
}

export function canTransferOwnership(access) {
  return isActive(access) && accessRole(access) === "owner";
}

export function canDeleteWorkspace(access) {
  return isActive(access) && accessRole(access) === "owner";
}

export function canCreateApp(access) {
  return hasProjectPermission(access, "projects.write");
}

export function canEditApp(access) {
  return hasProjectPermission(access, "write");
}

export function canDeployStaging(access) {
  return hasProjectPermission(access, "deployments.create");
}

export function canDeployProduction(access) {
  return hasProjectPermission(access, "deployments.production");
}

export function canViewResource(access) {
  return hasProjectPermission(access, "read");
}

export function canEditResource(access) {
  return hasProjectPermission(access, "write");
}

export function workspaceCapabilities(access = {}) {
  return Object.freeze({
    manageWorkspace: canManageWorkspace(access),
    managePeople: canManagePeople(access),
    manageBilling: canManageBilling(access),
    transferOwnership: canTransferOwnership(access),
    deleteWorkspace: canDeleteWorkspace(access),
    createApp: canCreateApp(access),
    editApp: canEditApp(access),
    deployStaging: canDeployStaging(access),
    deployProduction: canDeployProduction(access),
    viewResource: canViewResource(access),
    editResource: canEditResource(access)
  });
}
