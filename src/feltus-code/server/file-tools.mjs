import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { assertNoSymlinkTraversal, isSensitivePath, normalizeRelativePath, resolveInside, redactSecrets } from "./security.mjs";

const IGNORES = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage",
  ".feltus-code-backups", ".cache"
]);

export function createFileTools({ repoRoot, maxReadBytes = 1024 * 1024 }) {
  async function list(relativePath = ".") {
    relativePath = normalizeRelativePath(relativePath);
    const target = await assertNoSymlinkTraversal(repoRoot, relativePath);
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => !IGNORES.has(entry.name))
      .filter((entry) => !isSensitivePath(path.posix.join(relativePath.replaceAll("\\", "/"), entry.name)))
      .filter((entry) => !entry.isSymbolicLink())
      .map((entry) => ({
        name: entry.name,
        path: path.posix.join(relativePath.replaceAll("\\", "/"), entry.name).replace(/^\.\//, ""),
        type: entry.isDirectory() ? "directory" : "file"
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }

  async function read(relativePath) {
    relativePath = normalizeRelativePath(relativePath);
    if (isSensitivePath(relativePath)) {
      const err = new Error("Sensitive files are excluded from FELTUS CODE reads.");
      err.code = "SENSITIVE_FILE_BLOCKED";
      throw err;
    }
    const target = await assertNoSymlinkTraversal(repoRoot, relativePath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("Requested path is not a file.");
    if (stat.size > maxReadBytes) {
      const err = new Error(`File exceeds read limit of ${maxReadBytes} bytes.`);
      err.code = "FILE_TOO_LARGE";
      throw err;
    }
    return redactSecrets(await fs.readFile(target, "utf8"));
  }

  async function inspect(relativePath, { forAI = false } = {}) {
    relativePath = normalizeRelativePath(relativePath);
    if (isSensitivePath(relativePath)) {
      throw Object.assign(new Error("Sensitive files are excluded from FELTUS CODE reads."), { code: "SENSITIVE_FILE_BLOCKED" });
    }
    const target = await assertNoSymlinkTraversal(repoRoot, relativePath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw Object.assign(new Error("Requested path is not a file."), { code: "INVALID_REPO_TARGET" });
    if (stat.size > maxReadBytes) throw Object.assign(new Error(`File exceeds read limit of ${maxReadBytes} bytes.`), { code: "FILE_TOO_LARGE" });
    const raw = await fs.readFile(target, "utf8");
    const sanitized = redactSecrets(raw);
    const redacted = sanitized !== raw;
    if (forAI && redacted) {
      throw Object.assign(new Error("This file contains secret-like values and is excluded from AI editing."), { code: "SECRET_REDACTION_REVIEW" });
    }
    return {
      content: sanitized,
      redacted,
      editable: !redacted,
      sha256: crypto.createHash("sha256").update(raw).digest("hex")
    };
  }

  async function writeFile(relativePath, content, { expectedSha256 } = {}) {
    relativePath = normalizeRelativePath(relativePath);
    if (isSensitivePath(relativePath)) {
      const err = new Error("Sensitive files cannot be edited through FELTUS CODE.");
      err.code = "SENSITIVE_FILE_BLOCKED";
      throw err;
    }
    const target = resolveInside(repoRoot, relativePath);
    await assertNoSymlinkTraversal(repoRoot, path.dirname(relativePath));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await assertNoSymlinkTraversal(repoRoot, path.dirname(relativePath));
    const existing = await fs.lstat(target).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      const err = new Error("Target must be a regular file inside the repository.");
      err.code = "INVALID_REPO_TARGET";
      throw err;
    }
    if (existing) {
      if (!expectedSha256) throw Object.assign(new Error("Expected file version is required for writes."), { code: "FILE_VERSION_REQUIRED" });
      const current = await fs.readFile(target);
      const currentSha256 = crypto.createHash("sha256").update(current).digest("hex");
      if (currentSha256 !== expectedSha256) throw Object.assign(new Error("File changed since it was opened."), { code: "FILE_WRITE_CONFLICT" });
    } else if (expectedSha256 !== null) {
      throw Object.assign(new Error("New files require an explicit empty-file version."), { code: "FILE_VERSION_REQUIRED" });
    }
    const temporary = `${target}.feltus-${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, String(content), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    return { path: relativePath, bytes: Buffer.byteLength(String(content)) };
  }

  async function createDirectory(relativePath) {
    relativePath = normalizeRelativePath(relativePath);
    if (isSensitivePath(relativePath)) throw Object.assign(new Error("Sensitive paths are blocked."), { code: "SENSITIVE_FILE_BLOCKED" });
    const target = await assertNoSymlinkTraversal(repoRoot, relativePath);
    await fs.mkdir(target, { recursive: false });
    return { path: relativePath, created: true };
  }

  async function createFile(relativePath, content = "") {
    relativePath = normalizeRelativePath(relativePath);
    if (isSensitivePath(relativePath)) throw Object.assign(new Error("Sensitive files cannot be created through FELTUS CODE."), { code: "SENSITIVE_FILE_BLOCKED" });
    const target = resolveInside(repoRoot, relativePath);
    await assertNoSymlinkTraversal(repoRoot, path.dirname(relativePath));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await assertNoSymlinkTraversal(repoRoot, path.dirname(relativePath));
    const handle = await fs.open(target, "wx", 0o600);
    try {
      await handle.writeFile(String(content), "utf8");
    } catch (error) {
      await handle.close();
      await fs.rm(target, { force: true });
      throw error;
    }
    await handle.close();
    return { path: relativePath, bytes: Buffer.byteLength(String(content)), created: true };
  }

  async function rename(fromPath, toPath) {
    fromPath = normalizeRelativePath(fromPath);
    toPath = normalizeRelativePath(toPath);
    if (isSensitivePath(fromPath) || isSensitivePath(toPath)) throw Object.assign(new Error("Sensitive paths are blocked."), { code: "SENSITIVE_FILE_BLOCKED" });
    const source = await assertNoSymlinkTraversal(repoRoot, fromPath);
    const target = resolveInside(repoRoot, toPath);
    await assertNoSymlinkTraversal(repoRoot, path.dirname(toPath));
    const sourceStat = await fs.lstat(source);
    if (sourceStat.isSymbolicLink()) throw Object.assign(new Error("Symlink traversal is not allowed."), { code: "SYMLINK_NOT_ALLOWED" });
    if (await fs.lstat(target).then(() => true).catch(error => error?.code === "ENOENT" ? false : Promise.reject(error))) {
      throw Object.assign(new Error("Destination already exists."), { code: "DESTINATION_EXISTS" });
    }
    await fs.rename(source, target);
    return { from: fromPath, to: toPath };
  }

  async function remove(relativePath, { confirm = false } = {}) {
    relativePath = normalizeRelativePath(relativePath);
    if (!confirm) throw Object.assign(new Error("Explicit confirmation is required."), { code: "CONFIRMATION_REQUIRED" });
    if (!relativePath || relativePath === "." || isSensitivePath(relativePath)) throw Object.assign(new Error("This path cannot be deleted."), { code: "INVALID_REPO_TARGET" });
    const target = await assertNoSymlinkTraversal(repoRoot, relativePath);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error("Only regular files may be deleted."), { code: "INVALID_REPO_TARGET" });
    await fs.unlink(target);
    return { path: relativePath, deleted: true };
  }

  async function search(query, { limit = 50 } = {}) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return [];
    const results = [];

    async function walk(abs, rel) {
      if (results.length >= limit) return;
      const entries = await fs.readdir(abs, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= limit) break;
        const childRel = path.join(rel, entry.name);
        if (IGNORES.has(entry.name) || entry.isSymbolicLink() || isSensitivePath(childRel)) continue;

        const childAbs = path.join(abs, entry.name);

        if (entry.isDirectory()) {
          await walk(childAbs, childRel);
          continue;
        }
        if (!entry.isFile()) continue;

        try {
          const stat = await fs.stat(childAbs);
          if (stat.size > maxReadBytes) continue;
          const text = redactSecrets(await fs.readFile(childAbs, "utf8"));
          const lines = text.split(/\r?\n/);
          lines.forEach((line, index) => {
            if (results.length < limit && line.toLowerCase().includes(needle)) {
              results.push({
                path: childRel.replaceAll("\\", "/"),
                line: index + 1,
                preview: line.trim().slice(0, 300)
              });
            }
          });
        } catch {}
      }
    }

    await walk(path.resolve(repoRoot), "");
    return results;
  }

  return {
    list,
    read,
    inspect,
    hash: async relativePath => (await inspect(relativePath)).sha256,
    readForAI: async relativePath => (await inspect(relativePath, { forAI: true })).content,
    write: writeFile,
    createFile,
    createDirectory,
    rename,
    remove,
    search
  };
}
