import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createGitTools } from "./git-tools.mjs";
import { isSensitivePath, normalizeRelativePath } from "./security.mjs";

const APP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEED_MARKER = ".feltus-local-seed.json";
const MAX_SOURCE_FILES = 15000;
const MAX_SOURCE_BYTES = 250 * 1024 * 1024;
const EXCLUDED_PARTS = new Set([
  ".git", ".hg", ".svn", ".feltus-storage", ".preview-sandboxes",
  "node_modules", "bower_components", "vendor", "dist", "build", "out",
  ".next", ".nuxt", ".output", ".svelte-kit", ".angular", ".cache",
  ".turbo", ".vite", ".parcel-cache", ".npm", ".pnpm-store", ".yarn",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".tox", "coverage", "playwright-report", "test-results", "tmp", "temp", "logs",
  ".ssh", ".aws", ".gnupg", ".supabase", ".vercel", ".netlify", ".idea", ".vscode"
]);
const EXCLUDED_FILE = /^(?:\.ds_store|thumbs\.db|npm-debug\.log.*|yarn-debug\.log.*|pnpm-debug\.log.*)$/i;
const EXCLUDED_RUNTIME_EXTENSION = /\.(?:log|tmp|temp|pid|sock|core|bak|swp|tsbuildinfo|pyc|class|o|obj)$/i;
const FELTUS_PRIVATE_NAME = /^\.feltus(?:[-_.].*)?(?:credential|secret|token|key|auth|identity|session)(?:[-_.].*)?$/i;

function seedError(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isSamePath(left, right) {
  return comparable(left) === comparable(right);
}

function excludeProjectPath(relativePath) {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const leaf = parts.at(-1) || "";
  if (parts.some(part => EXCLUDED_PARTS.has(part.toLowerCase()) || FELTUS_PRIVATE_NAME.test(part))) return true;
  if (isSensitivePath(relativePath)) return true;
  return EXCLUDED_FILE.test(leaf) || EXCLUDED_RUNTIME_EXTENSION.test(leaf);
}

function sourceDirectoryName(value) {
  let normalized;
  try {
    normalized = normalizeRelativePath(value);
  } catch {
    throw seedError("Choose a source folder under the approved local development source root.", "LOCAL_SOURCE_PATH_INVALID", 400);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(normalized) || normalized === "." || normalized === "..") {
    throw seedError("Choose one named source folder under the approved local development source root.", "LOCAL_SOURCE_PATH_INVALID", 400);
  }
  return normalized;
}

async function canonicalDirectory(directory, code, message) {
  const absolute = path.resolve(directory || "");
  const entry = await fs.lstat(absolute).catch(error => {
    if (error?.code === "ENOENT") throw seedError(message, code, 404);
    throw error;
  });
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw seedError(message, code, 409);
  const real = await fs.realpath(absolute);
  if (!isSamePath(real, absolute)) throw seedError(message, code, 409);
  return real;
}

async function fileDigest(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function collectApprovedFiles(sourceDirectory) {
  const files = [];
  let byteCount = 0;

  async function collectDirectory(directory, relative = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const itemRelative = relative ? `${relative}/${entry.name}` : entry.name;
      let normalized;
      try {
        normalized = normalizeRelativePath(itemRelative);
      } catch {
        throw seedError("The approved source contains an unsafe file path.", "LOCAL_SOURCE_PATH_INVALID", 409);
      }
      const sourceItem = path.join(directory, entry.name);
      const stat = await fs.lstat(sourceItem);
      if (stat.isSymbolicLink()) {
        throw seedError("Local source folders cannot contain symbolic links or directory junctions.", "LOCAL_SOURCE_SYMLINK_UNSAFE", 409);
      }
      if (excludeProjectPath(normalized)) continue;
      const realItem = await fs.realpath(sourceItem);
      if (!isInside(sourceDirectory, realItem) || !isSamePath(realItem, sourceItem)) {
        throw seedError("A local source entry resolves outside its approved folder.", "LOCAL_SOURCE_SYMLINK_UNSAFE", 409);
      }
      if (stat.isDirectory()) {
        await collectDirectory(sourceItem, normalized);
        continue;
      }
      if (!stat.isFile()) {
        throw seedError("Local source folders may contain regular files and folders only.", "LOCAL_SOURCE_FILE_UNSUPPORTED", 409);
      }
      files.push({ relativePath: normalized, sourcePath: sourceItem, size: stat.size });
      byteCount += stat.size;
      if (files.length > MAX_SOURCE_FILES || byteCount > MAX_SOURCE_BYTES) {
        throw seedError("The approved local source is too large to seed safely.", "LOCAL_SOURCE_TOO_LARGE", 413);
      }
    }
  }

  await collectDirectory(sourceDirectory);
  if (!files.length) throw seedError("The approved local source has no files that can be seeded.", "LOCAL_SOURCE_EMPTY", 409);
  return files;
}

async function stageAndCommitBaseline(git, filePaths) {
  for (let offset = 0; offset < filePaths.length; offset += 100) {
    await git.stage(filePaths.slice(offset, offset + 100));
  }
  const stagedPaths = await git.stagedPaths();
  const expected = [...filePaths].sort();
  if (JSON.stringify(stagedPaths) !== JSON.stringify(expected)) {
    throw seedError("The initial workspace files could not be staged exactly; the workspace was left unchanged.", "LOCAL_SEED_STAGE_MISMATCH", 409);
  }
  await git.checkpoint({ message: "Initialize FELTUS CODE workspace", confirm: true });
  return (await git.head()).stdout.trim();
}

async function renameSeedDirectory(staging, target) {
  const delays = [100, 200, 300, 500, 750, 1000, 1500];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(staging, target);
      return;
    } catch (error) {
      if (!(["EBUSY", "EPERM", "EACCES"].includes(error?.code)) || attempt >= delays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function safelyAddMissingBaseline({ target, sourceDirectory, marker, git }) {
  const sourceFiles = await collectApprovedFiles(sourceDirectory);
  if (sourceFiles.length !== marker.seeded_file_count) return null;
  const status = await git.status();
  const statusLines = status.stdout.split(/\r?\n/).slice(1).filter(Boolean);
  if (statusLines.some(line => line.slice(0, 2) !== "??")) return null;
  const workspaceFiles = await collectApprovedFiles(target);
  const expectedPaths = sourceFiles.map(file => file.relativePath).sort();
  if (JSON.stringify(workspaceFiles.map(file => file.relativePath).sort()) !== JSON.stringify(expectedPaths)) return null;

  for (const file of sourceFiles) {
    const targetFile = path.join(target, ...file.relativePath.split("/"));
    const targetStat = await fs.lstat(targetFile).catch(() => null);
    if (!targetStat?.isFile() || targetStat.isSymbolicLink()) return null;
    const [sourceDigest, targetDigest] = await Promise.all([
      fileDigest(file.sourcePath),
      fileDigest(targetFile)
    ]);
    if (sourceDigest !== targetDigest) return null;
  }

  try {
    const baselineCommit = await stageAndCommitBaseline(git, expectedPaths);
    marker.baseline_commit = baselineCommit;
    await fs.writeFile(path.join(target, ".git", SEED_MARKER), JSON.stringify(marker), { mode: 0o600 });
    return baselineCommit;
  } catch {
    const history = await git.log(1).catch(() => ({ stdout: "" }));
    if (!history.stdout.trim()) await git.unstage(expectedPaths).catch(() => {});
    throw seedError("The existing workspace was not changed because its initial baseline could not be created safely.", "LOCAL_SEED_BASELINE_UNSAFE", 409);
  }
}

async function existingSeed(target, sourcePath, sourceDirectory) {
  const targetEntry = await fs.lstat(target).catch(error => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!targetEntry) return null;
  if (targetEntry.isSymbolicLink() || !targetEntry.isDirectory()) {
    throw seedError("This project's private workspace already contains an unsafe path.", "CODE_WORKSPACE_UNSAFE", 409);
  }
  const gitPath = path.join(target, ".git");
  const gitEntry = await fs.lstat(gitPath).catch(error => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!gitEntry || gitEntry.isSymbolicLink() || !gitEntry.isDirectory()) {
    throw seedError("This project's private workspace already has content and will not be replaced.", "CODE_WORKSPACE_ALREADY_EXISTS", 409);
  }
  const markerPath = path.join(gitPath, SEED_MARKER);
  const markerEntry = await fs.lstat(markerPath).catch(error => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!markerEntry || markerEntry.isSymbolicLink() || !markerEntry.isFile()) {
    throw seedError("This project's private workspace is already initialized and will not be replaced.", "CODE_WORKSPACE_ALREADY_EXISTS", 409);
  }
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    throw seedError("The existing local seed record is invalid; the workspace was left unchanged.", "LOCAL_SEED_RECORD_INVALID", 409);
  }
  if (marker?.version !== 1 || marker?.source_path !== sourcePath || !Number.isInteger(marker?.seeded_file_count)) {
    throw seedError("This workspace was seeded from a different source and will not be replaced.", "CODE_WORKSPACE_ALREADY_EXISTS", 409);
  }
  const git = createGitTools({ repoRoot: target });
  await git.status();
  let baselineCommit = typeof marker.baseline_commit === "string" && /^[0-9a-f]{40}$/i.test(marker.baseline_commit)
    ? marker.baseline_commit
    : null;
  if (!baselineCommit) {
    const history = await git.log(1);
    if (!history.stdout.trim()) {
      baselineCommit = await safelyAddMissingBaseline({ target, sourceDirectory, marker, git });
      if (!baselineCommit) {
        throw seedError("This workspace has changes, so FELTUS could not add a baseline without including or replacing them.", "LOCAL_SEED_BASELINE_UNSAFE", 409);
      }
    }
  }
  return {
    initialized: false,
    already_seeded: true,
    seeded_file_count: marker.seeded_file_count,
    ...(baselineCommit ? { baseline_commit: baselineCommit } : {})
  };
}

async function copyApprovedProject(sourceDirectory, stagingDirectory) {
  const files = await collectApprovedFiles(sourceDirectory);
  for (const file of files) {
    const sourceEntry = await fs.lstat(file.sourcePath);
    const realSource = await fs.realpath(file.sourcePath);
    if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink() || !isInside(sourceDirectory, realSource) || !isSamePath(realSource, file.sourcePath)) {
      throw seedError("A local source entry changed while it was being copied.", "LOCAL_SOURCE_SYMLINK_UNSAFE", 409);
    }
    const target = path.join(stagingDirectory, ...file.relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(file.sourcePath, target);
  }
  return files;
}

export function isLocalSourceSeedingEnabled({ environment, localDevMode, sourceRoot } = {}) {
  return String(environment || "").trim().toLowerCase() === "development" &&
    localDevMode === true && typeof sourceRoot === "string" && sourceRoot.trim().length > 0;
}

export async function seedLocalCodeWorkspace({
  appId,
  sourceRoot,
  sourcePath,
  workspaceRoot,
  development = false
} = {}) {
  if (development !== true) {
    throw seedError("Local source seeding is available only in development mode.", "LOCAL_SEED_DEVELOPMENT_ONLY", 404);
  }
  if (!APP_ID_PATTERN.test(String(appId || ""))) {
    throw seedError("A valid FELTUS app is required to seed its private workspace.", "INVALID_PROJECT_ID", 400);
  }
  const relativeSource = sourceDirectoryName(sourcePath);
  if (!sourceRoot || !workspaceRoot) {
    throw seedError("Local source seeding is not configured for this development server.", "LOCAL_SOURCE_SEED_UNAVAILABLE", 404);
  }

  const approvedRoot = await canonicalDirectory(
    sourceRoot,
    "LOCAL_SOURCE_ROOT_UNAVAILABLE",
    "The approved local development source root is unavailable."
  );
  const privateRoot = await canonicalDirectory(
    workspaceRoot,
    "CODE_WORKSPACE_ROOT_UNAVAILABLE",
    "The private FELTUS CODE workspace root is unavailable."
  );
  if (isInside(approvedRoot, privateRoot) || isInside(privateRoot, approvedRoot)) {
    throw seedError("The approved source root and private workspace root must be separate.", "LOCAL_SOURCE_ROOT_UNSAFE", 409);
  }

  const sourceDirectory = path.join(approvedRoot, relativeSource);
  const sourceEntry = await fs.lstat(sourceDirectory).catch(error => {
    if (error?.code === "ENOENT") throw seedError("The selected folder was not found under the approved local source root.", "LOCAL_SOURCE_NOT_FOUND", 404);
    throw error;
  });
  if (sourceEntry.isSymbolicLink() || !sourceEntry.isDirectory()) {
    throw seedError("Choose a regular project folder under the approved local source root.", "LOCAL_SOURCE_NOT_DIRECTORY", 409);
  }
  const realSourceDirectory = await fs.realpath(sourceDirectory);
  if (!isInside(approvedRoot, realSourceDirectory) || !isSamePath(realSourceDirectory, sourceDirectory)) {
    throw seedError("The selected source folder resolves outside the approved local source root.", "LOCAL_SOURCE_SYMLINK_UNSAFE", 409);
  }

  const target = path.join(privateRoot, appId);
  const priorSeed = await existingSeed(target, relativeSource, realSourceDirectory);
  if (priorSeed) return { ...priorSeed, source_path: relativeSource };

  const staging = path.join(privateRoot, `.fseed-${randomUUID().replaceAll("-", "")}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    const copiedFiles = await copyApprovedProject(realSourceDirectory, staging);
    const seededFileCount = copiedFiles.length;
    const git = createGitTools({ repoRoot: staging });
    const initialized = await git.initialize();
    const baselineCommit = await stageAndCommitBaseline(git, copiedFiles.map(file => file.relativePath));
    const marker = {
      version: 1,
      source_path: relativeSource,
      seeded_file_count: seededFileCount,
      baseline_commit: baselineCommit
    };
    await fs.writeFile(path.join(staging, ".git", SEED_MARKER), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
    try {
      await renameSeedDirectory(staging, target);
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(error?.code)) {
        const concurrentSeed = await existingSeed(target, relativeSource, realSourceDirectory);
        if (concurrentSeed) return { ...concurrentSeed, source_path: relativeSource };
      }
      throw error;
    }
    await createGitTools({ repoRoot: target }).status();
    return {
      initialized: initialized.initialized === true,
      already_seeded: false,
      seeded_file_count: seededFileCount,
      source_path: relativeSource,
      baseline_commit: baselineCommit
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
  }
}
