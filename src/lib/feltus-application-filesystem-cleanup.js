import fs from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function removeApplicationDirectory(root, appId) {
  if (!UUID.test(String(appId || ""))) {
    throw Object.assign(new Error("Invalid application identifier."), { code: "APP_CLEANUP_INVALID_ID" });
  }
  if (typeof root !== "string" || !root.trim()) {
    throw Object.assign(new Error("Application storage root is unavailable."), { code: "APP_CLEANUP_ROOT_UNAVAILABLE" });
  }

  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot)) return { removed: false, missing: true };
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw Object.assign(new Error("Application storage root is unsafe."), { code: "APP_CLEANUP_ROOT_UNSAFE" });
  }
  const realRoot = fs.realpathSync(absoluteRoot);
  if (process.platform === "win32"
    ? realRoot.toLowerCase() !== absoluteRoot.toLowerCase()
    : realRoot !== absoluteRoot) {
    throw Object.assign(new Error("Application storage root resolves through a link."), { code: "APP_CLEANUP_ROOT_UNSAFE" });
  }

  const target = path.resolve(realRoot, appId);
  if (path.dirname(target) !== realRoot || !inside(realRoot, target)) {
    throw Object.assign(new Error("Application storage path is outside its approved root."), { code: "APP_CLEANUP_PATH_UNSAFE" });
  }
  let targetStat;
  try {
    targetStat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: false, missing: true };
    throw error;
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw Object.assign(new Error("Application storage path is not a regular directory."), { code: "APP_CLEANUP_PATH_UNSAFE" });
  }
  const realTarget = fs.realpathSync(target);
  if (!inside(realRoot, realTarget) || (process.platform === "win32"
    ? realTarget.toLowerCase() !== target.toLowerCase()
    : realTarget !== target)) {
    throw Object.assign(new Error("Application storage path resolves outside its approved directory."), { code: "APP_CLEANUP_PATH_UNSAFE" });
  }

  fs.rmSync(realTarget, { recursive: true, force: false });
  return { removed: true, missing: false };
}

export function removeApplicationLocalFiles({ appId, documentStorageRoot, codeWorkspaceRoot, backupStorageRoot = null }) {
  const documents = removeApplicationDirectory(documentStorageRoot, appId);
  const codeWorkspace = removeApplicationDirectory(codeWorkspaceRoot, appId);
  const backups = backupStorageRoot ? removeApplicationDirectory(backupStorageRoot, appId) : null;
  return {
    documents,
    code_workspace: codeWorkspace,
    ...(backupStorageRoot ? { backups } : {})
  };
}
