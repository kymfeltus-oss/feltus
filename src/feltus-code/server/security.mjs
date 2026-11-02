import path from "node:path";
import fs from "node:fs/promises";

const SENSITIVE_FILE_NAME = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|known_hosts|authorized_keys)(?:$)/i;
const SENSITIVE_EXTENSION = /\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/i;
const SENSITIVE_CONFIG_NAME = /(?:^|[-_.])(?:credentials?|secrets?|private|api[_-]?keys?|tokens?)(?:[-_.]|$)/i;

export function normalizeRelativePath(requested = ".") {
  const value = String(requested || ".").replaceAll("\\", "/");
  if (
    value.includes("\0") ||
    value.includes(":") ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value) ||
    value.split("/").some(part => part === "..")
  ) {
    const err = new Error("Only repository-relative paths are allowed.");
    err.code = "INVALID_REPO_PATH";
    throw err;
  }
  return value;
}

export function isSensitivePath(relativePath = "") {
  const parts = normalizeRelativePath(relativePath).split("/").filter(Boolean);
  return parts.some(part =>
    part.toLowerCase() === ".git" ||
    SENSITIVE_FILE_NAME.test(part) ||
    SENSITIVE_EXTENSION.test(part) ||
    SENSITIVE_CONFIG_NAME.test(part) ||
    /^(?:\.ssh|\.aws|\.gnupg|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.dockerconfigjson|secrets?|credentials?)$/i.test(part)
  );
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function resolveInside(root, requested = ".") {
  if (!root) throw new Error("Repository root is required.");
  const rootPath = path.resolve(root);
  const relativePath = normalizeRelativePath(requested);
  const target = path.resolve(rootPath, relativePath);
  if (target !== rootPath && !target.startsWith(rootPath + path.sep)) {
    const err = new Error("Path escapes repository root.");
    err.code = "PATH_OUTSIDE_REPO";
    throw err;
  }
  return target;
}

export async function assertNoSymlinkTraversal(root, requested = ".") {
  const rootPath = path.resolve(root);
  const target = resolveInside(rootPath, requested);
  try {
    const rootStat = await fs.lstat(rootPath);
    if (rootStat.isSymbolicLink()) {
      const err = new Error("Repository root cannot be a symlink.");
      err.code = "SYMLINK_NOT_ALLOWED";
      throw err;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const relative = path.relative(rootPath, target);
  if (!relative) {
    const realRoot = await fs.realpath(rootPath);
    if (comparablePath(realRoot) !== comparablePath(rootPath)) {
      const err = new Error("Configured repository root must be canonical and cannot traverse a symlink.");
      err.code = "SYMLINK_NOT_ALLOWED";
      throw err;
    }
    return target;
  }

  let cursor = rootPath;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) {
        const err = new Error("Symlink traversal is not allowed.");
        err.code = "SYMLINK_NOT_ALLOWED";
        throw err;
      }
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  try {
    const realRoot = await fs.realpath(rootPath);
    const realTarget = await fs.realpath(target);
    const comparableRoot = comparablePath(realRoot);
    const comparableTarget = comparablePath(realTarget);
    const separator = path.sep;
    if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(comparableRoot + separator)) {
      const err = new Error("Resolved path escapes repository root.");
      err.code = "PATH_OUTSIDE_REPO";
      throw err;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return target;
}

export function redactSecrets(text = "") {
  return String(text)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED JWT]")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:["']?(?:[a-z0-9.-]+[_-])*?(?:api[_-]?key|key|secret|password|token|private[_-]?key|credentials?)["']?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"'`},]+)/gi, "$1[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+(@)/gi, "$1[REDACTED]$2");
}
