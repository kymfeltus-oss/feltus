import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { redactSecrets, isSensitivePath, normalizeRelativePath, assertNoSymlinkTraversal } from "./security.mjs";
import { assertExactGitRoot, isolatedGitEnvironment } from "./git-tools.mjs";

export const DEFAULT_TASKS = Object.freeze({
  "git-status": { command: "git", args: ["status", "--short", "--branch"] },
  "git-diff": { command: "git", args: ["diff", "--no-ext-diff"] },
  "npm-check": { command: "npm", args: ["run", "check"] },
  "npm-test-core": { command: "npm", args: ["run", "test:core"] },
  "npm-regression": { command: "npm", args: ["run", "regression"] },
  "compose-config": { command: "docker", args: ["compose", "--env-file", ".env.example", "--file", "compose.production.yaml", "config", "--quiet"] }
});

const IGNORED_VALIDATION_PATHS = new Set([
  ".git", "node_modules", ".feltus-code-backups", ".next", "dist", "build", "coverage", ".cache"
]);
const NPM_SCRIPTS = Object.freeze({
  "npm-check": "check",
  "npm-test-core": "test:core",
  "npm-regression": "regression"
});

function gitSetup(repoRoot, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      env: isolatedGitEnvironment({ CI: "1" })
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve();
      reject(Object.assign(new Error(redactSecrets(stderr).trim() || `Temporary Git initialization failed (${code}).`), { code: "VALIDATION_WORKSPACE_FAILED" }));
    });
  });
}

async function initializeValidationGit(repoRoot) {
  await gitSetup(repoRoot, ["init", "--initial-branch=main"]);
  await gitSetup(repoRoot, ["config", "user.name", "FELTUS CODE Validation"]);
  await gitSetup(repoRoot, ["config", "user.email", "feltus-code-validation@localhost"]);
  await gitSetup(repoRoot, ["add", "--all", "--force"]);
  const noHooks = path.join(repoRoot, ".git", "feltus-code-no-hooks");
  await fs.mkdir(noHooks);
  await gitSetup(repoRoot, ["-c", `core.hooksPath=${noHooks}`, "commit", "--quiet", "--allow-empty", "-m", "Temporary validation baseline"]);
}

async function createValidationWorkspace(repoRoot) {
  const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feltus-code-validation-"));
  try {
    const canonicalRoot = path.resolve(repoRoot);
    await fs.cp(canonicalRoot, snapshotRoot, {
      recursive: true,
      dereference: false,
      filter: async source => {
        const relative = path.relative(canonicalRoot, source);
        if (!relative) return true;
        const segments = relative.split(path.sep);
        if (segments.some(segment => IGNORED_VALIDATION_PATHS.has(segment))) return false;
        const isComposeExample = relative.replaceAll(path.sep, "/") === ".env.example";
        if (!isComposeExample && isSensitivePath(relative.replaceAll(path.sep, "/"))) return false;
        const stat = await fs.lstat(source);
        return !stat.isSymbolicLink();
      }
    });
    await initializeValidationGit(snapshotRoot);
    return snapshotRoot;
  } catch (error) {
    await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function createTaskRunner({ repoRoot, tasks = DEFAULT_TASKS, timeoutMs = 120000 }) {
  function taskUnavailableReason(taskName, task) {
    if (taskName === "git-status" || taskName === "git-diff") {
      try {
        const gitEntry = requireStat(path.join(repoRoot, ".git"));
        if (!gitEntry || gitEntry.isSymbolicLink() || (!gitEntry.isDirectory() && !gitEntry.isFile())) {
          return "Initialize the project Git workspace before running Git validation tasks.";
        }
        return null;
      } catch {
        return "Initialize the project Git workspace before running Git validation tasks.";
      }
    }
    const npmScript = task?.command === "npm"
      ? task.args?.[0] === "run" ? task.args?.[1] : task.args?.[0] === "test" ? "test" : null
      : NPM_SCRIPTS[taskName];
    if (npmScript) {
      let packageJson;
      try {
        const packageStat = requireStat(path.join(repoRoot, "package.json"));
        if (!packageStat?.isFile() || packageStat.isSymbolicLink()) {
          return "package.json is missing; npm validation tasks are unavailable for this repository.";
        }
        packageJson = JSON.parse(requireText(path.join(repoRoot, "package.json")));
      } catch {
        return "package.json is missing or invalid; npm validation tasks are unavailable for this repository.";
      }
      const scriptName = npmScript;
      if (typeof packageJson?.scripts?.[scriptName] !== "string" || !packageJson.scripts[scriptName].trim()) {
        return `package.json does not define scripts.${scriptName}; this npm validation task is unavailable.`;
      }
      return null;
    }
    if (taskName === "compose-config") {
      for (const fileName of [".env.example", "compose.production.yaml"]) {
        try {
          const stat = requireStat(path.join(repoRoot, fileName));
          if (!stat?.isFile() || stat.isSymbolicLink()) return `${fileName} is missing; Compose validation is unavailable.`;
        } catch {
          return `${fileName} is missing; Compose validation is unavailable.`;
        }
      }
      return null;
    }
    return task?.available === false ? String(task.reason || "This validation task is unavailable.") : null;
  }

  function unavailable() {
    return Object.keys(tasks)
      .map(taskName => ({ task: taskName, reason: taskUnavailableReason(taskName, tasks[taskName]) }))
      .filter(item => item.reason);
  }

  function list() {
    const unavailableTasks = new Set(unavailable().map(item => item.task));
    return Object.keys(tasks).filter(taskName => !unavailableTasks.has(taskName));
  }

  function defaultTask() {
    const available = new Set(list());
    return ["npm-check", "npm-test-core", "npm-regression", "compose-config", "git-diff", "git-status"].find(name => available.has(name)) || null;
  }

  async function run(taskName, { signal } = {}) {
    const task = tasks[taskName];
    if (!task) {
      throw Object.assign(new Error("Task is not allowlisted."), { code: "TASK_NOT_ALLOWED" });
    }
    const reason = taskUnavailableReason(taskName, task);
    if (reason) throw Object.assign(new Error(reason), { code: "TASK_UNAVAILABLE", task: taskName, reason });

    if (task.command === "git") await assertExactGitRoot(repoRoot);
    if (signal?.aborted) throw Object.assign(new Error("Task request was cancelled."), { code: "REQUEST_CANCELLED" });

    return new Promise((resolve, reject) => {
      const child = spawn(task.command, task.args, {
        cwd: repoRoot,
        shell: false,
        windowsHide: true,
        ...(signal ? { signal } : {}),
        env: isolatedGitEnvironment({ CI: "1" })
      });

      let stdout = "";
      let stderr = "";
      let childError = null;
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

      child.stdout.on("data", d => { stdout += d; });
      child.stderr.on("data", d => { stderr += d; });
      child.on("error", error => {
        if (error?.name === "AbortError") {
          childError = Object.assign(error, { code: "REQUEST_CANCELLED" });
          return;
        }
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signalName) => {
        clearTimeout(timer);
        if (childError) return reject(childError);
        resolve({
          task: taskName,
          code,
          signal: signalName,
          stdout: redactSecrets(stdout).slice(-200000),
          stderr: redactSecrets(stderr).slice(-200000)
        });
      });
    });
  }

  async function runAgainstProposed(taskName, proposedFiles, { signal } = {}) {
    if (!Array.isArray(proposedFiles) || proposedFiles.length < 1 || proposedFiles.length > 12) {
      throw Object.assign(new Error("Validation requires between 1 and 12 proposed project files."), { code: "INVALID_EDIT_PROPOSAL" });
    }
    const reason = taskUnavailableReason(taskName, tasks[taskName]);
    if (reason) throw Object.assign(new Error(reason), { code: "TASK_UNAVAILABLE", task: taskName, reason });
    if (signal?.aborted) throw Object.assign(new Error("Validation was cancelled."), { code: "REQUEST_CANCELLED" });

    const normalizedFiles = [];
    const seen = new Set();
    for (const file of proposedFiles) {
      const relativePath = normalizeRelativePath(file?.path);
      if (!relativePath || relativePath === "." || isSensitivePath(relativePath) || seen.has(relativePath)) {
        throw Object.assign(new Error("Validation proposal contains an invalid or duplicate file path."), { code: "INVALID_EDIT_PROPOSAL" });
      }
      if (typeof file?.content !== "string" || typeof file?.before_sha256 !== "string") {
        throw Object.assign(new Error("Validation proposal is missing file contents or its source version."), { code: "INVALID_EDIT_PROPOSAL" });
      }
      const sourcePath = await assertNoSymlinkTraversal(repoRoot, relativePath);
      const sourceStat = await fs.lstat(sourcePath);
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw Object.assign(new Error("Only regular project files can be validated."), { code: "INVALID_REPO_TARGET" });
      }
      const sourceContent = await fs.readFile(sourcePath, "utf8");
      const sourceHash = crypto.createHash("sha256").update(sourceContent).digest("hex");
      if (sourceHash !== file.before_sha256) {
        throw Object.assign(new Error(`File changed before validation started: ${relativePath}`), { code: "EDIT_CONFLICT" });
      }
      seen.add(relativePath);
      normalizedFiles.push({ ...file, path: relativePath });
    }

    const snapshotRoot = await createValidationWorkspace(repoRoot);
    try {
      for (const file of normalizedFiles) {
        const snapshotPath = await assertNoSymlinkTraversal(snapshotRoot, file.path);
        const snapshotStat = await fs.lstat(snapshotPath).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
        if (!snapshotStat?.isFile() || snapshotStat.isSymbolicLink()) {
          throw Object.assign(new Error(`Selected file is unavailable in the validation snapshot: ${file.path}`), { code: "EDIT_CONFLICT" });
        }
        const snapshotContent = await fs.readFile(snapshotPath, "utf8");
        const snapshotHash = crypto.createHash("sha256").update(snapshotContent).digest("hex");
        if (snapshotHash !== file.before_sha256) {
          throw Object.assign(new Error(`File changed while the validation snapshot was created: ${file.path}`), { code: "EDIT_CONFLICT" });
        }
        await fs.writeFile(snapshotPath, file.content, "utf8");
      }
      const snapshotRunner = createTaskRunner({ repoRoot: snapshotRoot, tasks, timeoutMs });
      return await snapshotRunner.run(taskName, { signal });
    } finally {
      await fs.rm(snapshotRoot, { recursive: true, force: true });
    }
  }

  return { run, runAgainstProposed, list, unavailable, defaultTask };
}

// Synchronous metadata reads keep the existing task-listing endpoint fast.
function requireStat(filePath) {
  try { return fsSync.lstatSync(filePath); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function requireText(filePath) {
  return fsSync.readFileSync(filePath, "utf8");
}
