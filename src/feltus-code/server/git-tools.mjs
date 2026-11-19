import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { assertNoSymlinkTraversal, isSensitivePath, normalizeRelativePath, redactSecrets, resolveInside, safeProjectEnvironment } from "./security.mjs";

export async function assertExactGitRoot(repoRoot) {
  const configuredRoot = path.resolve(repoRoot);

  // Require a .git entry directly in the configured repository root.
  // This prevents Git from silently walking up to an unrelated parent repository.
  let gitEntry;
  try {
    gitEntry = await fs.lstat(path.join(configuredRoot, ".git"));
  } catch (cause) {
    if (cause?.code !== "ENOENT") throw cause;
    const err = new Error(
      "Git unavailable: the selected FELTUS CODE folder is not itself a Git repository root."
    );
    err.code = "NOT_GIT_ROOT";
    throw err;
  }
  if (gitEntry.isSymbolicLink()) {
    throw Object.assign(new Error("Git metadata cannot be a symlink."), { code: "SYMLINK_NOT_ALLOWED" });
  }

  const canonicalRoot = await fs.realpath(configuredRoot);
  const rootsEqual = process.platform === "win32"
    ? canonicalRoot.toLowerCase() === configuredRoot.toLowerCase()
    : canonicalRoot === configuredRoot;
  if (!rootsEqual) {
    throw Object.assign(new Error("Configured Git root cannot resolve through a symlink."), { code: "SYMLINK_NOT_ALLOWED" });
  }

  const result = await runGitRaw(configuredRoot, ["rev-parse", "--show-toplevel"]);
  const actualRoot = path.resolve(result.stdout.trim());

  const rootsMatch = process.platform === "win32"
    ? actualRoot.toLowerCase() === configuredRoot.toLowerCase()
    : actualRoot === configuredRoot;
  if (!rootsMatch) {
    const err = new Error(
      "Git blocked: selected folder does not match the repository root."
    );
    err.code = "GIT_ROOT_MISMATCH";
    throw err;
  }
}

export function isolatedGitEnvironment(extra = {}, baseEnvironment = safeProjectEnvironment()) {
  const env = { ...baseEnvironment };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    ...extra
  });
  return env;
}

function runGitRaw(repoRoot, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      env: isolatedGitEnvironment()
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        code,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr)
      };

      if (code === 0) return resolve(result);

      const err = new Error(result.stderr || `git exited with ${code}`);
      err.result = result;
      reject(err);
    });
  });
}

async function runGit(repoRoot, args, options = {}) {
  await assertExactGitRoot(repoRoot);
  return runGitRaw(repoRoot, args, options);
}

export function createGitTools({ repoRoot }) {
  function safeCommit(value) {
    const commit = String(value || "");
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) {
      throw Object.assign(new Error("Choose a valid checkpoint commit."), { code: "INVALID_GIT_COMMIT" });
    }
    return commit;
  }

  return {
    async initialize() {
      const configuredRoot = path.resolve(repoRoot);
      try {
        await fs.lstat(path.join(configuredRoot, ".git"));
        await assertExactGitRoot(configuredRoot);
        return { initialized: false, branch: "main" };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await runGitRaw(configuredRoot, ["init", "--initial-branch=main"]);
      await assertExactGitRoot(configuredRoot);
      await runGit(configuredRoot, ["config", "user.name", "FELTUS CODE"]);
      await runGit(configuredRoot, ["config", "user.email", "feltus-code@localhost"]);
      return { initialized: true, branch: "main" };
    },

    async available() {
      try {
        await assertExactGitRoot(repoRoot);
        return { available: true, repoRoot: path.resolve(repoRoot) };
      } catch (error) {
        return {
          available: false,
          repoRoot: path.resolve(repoRoot),
          reason: error.message
        };
      }
    },

    status: () => runGit(repoRoot, ["status", "--short", "--branch"]),

    diff: ({ staged = false } = {}) =>
      runGit(
        repoRoot,
        staged
          ? ["diff", "--cached", "--no-ext-diff"]
          : ["diff", "--no-ext-diff"]
      ),

    log: async (limit = 20) => {
      try {
        return await runGit(repoRoot, [
        "log",
        `-${Math.min(Math.max(Number(limit) || 20, 1), 100)}`,
        "--pretty=format:%h%x09%ad%x09%s",
        "--date=short"
        ]);
      } catch (error) {
        if (error?.result?.code === 128 && /does not have any commits|bad default revision/i.test(error.message)) {
          return { code: 0, stdout: "", stderr: "" };
        }
        throw error;
      }
    },

    head: () => runGit(repoRoot, ["rev-parse", "HEAD"]),

    stagedPaths: async () => {
      const result = await runGit(repoRoot, ["diff", "--cached", "--name-only", "-z"]);
      return result.stdout.split("\0").filter(Boolean).sort();
    },

    statusPaths: async () => {
      const result = await runGit(repoRoot, ["status", "--porcelain=v1", "-z"]);
      const entries = result.stdout.split("\0").filter(Boolean);
      const paths = [];
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const status = entry.slice(0, 2);
        const filePath = entry.slice(3);
        if (filePath) paths.push(filePath);
        if (status.includes("R") || status.includes("C")) {
          const originalPath = entries[index + 1];
          if (originalPath) paths.push(originalPath);
          index += 1;
        }
      }
      return [...new Set(paths)].sort();
    },

    unstage: async (paths = []) => {
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 15000) {
        throw Object.assign(new Error("Choose valid paths to remove from the staging area."), { code: "INVALID_GIT_PATHS" });
      }
      const safePaths = paths.map(value => normalizeRelativePath(value));
      if (safePaths.some(isSensitivePath)) {
        throw Object.assign(new Error("Sensitive paths cannot be changed in the staging area."), { code: "SENSITIVE_FILE_BLOCKED" });
      }
      return runGit(repoRoot, ["rm", "--cached", "--ignore-unmatch", "--", ...safePaths.map(item => `:(literal)${item}`)]);
    },

    async compare(commit) {
      const source = safeCommit(commit);
      await runGit(repoRoot, ["cat-file", "-e", `${source}^{commit}`]);
      return runGit(repoRoot, ["diff", "--no-ext-diff", source, "--"]);
    },

    async restore({ commit, paths = [], confirm = false } = {}) {
      if (!confirm) throw Object.assign(new Error("Explicit confirmation is required before restoring files."), { code: "CONFIRMATION_REQUIRED" });
      const source = safeCommit(commit);
      await runGit(repoRoot, ["cat-file", "-e", `${source}^{commit}`]);
      let safePaths = Array.isArray(paths) ? paths.map(normalizeRelativePath) : [];
      if (!safePaths.length) {
        const changed = await runGit(repoRoot, ["diff", "--name-only", "-z", source, "--"]);
        safePaths = changed.stdout.split("\0").filter(Boolean).slice(0, 100);
      }
      if (!safePaths.length) return { code: 0, stdout: "No tracked files differ from this checkpoint.", stderr: "", paths: [] };
      if (safePaths.length > 100 || safePaths.some(isSensitivePath)) {
        throw Object.assign(new Error("Checkpoint restore contains an invalid or sensitive path."), { code: "INVALID_GIT_PATHS" });
      }
      for (const item of safePaths) await assertNoSymlinkTraversal(repoRoot, item);
      const result = await runGit(repoRoot, ["restore", "--source", source, "--worktree", "--staged", "--", ...safePaths.map(item => `:(literal)${item}`)]);
      return { ...result, paths: safePaths };
    },

    async stage(paths = []) {
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100) {
        throw Object.assign(new Error("Select between 1 and 100 changed repository paths."), { code: "INVALID_GIT_PATHS" });
      }
      const requestedPaths = paths.map(value => normalizeRelativePath(value));
      if (requestedPaths.some(isSensitivePath)) {
        throw Object.assign(new Error("Sensitive paths cannot be staged through FELTUS CODE."), { code: "SENSITIVE_FILE_BLOCKED" });
      }

      // Git reports an untracked folder as one path (for example, "src/").
      // Expand only the user-selected folder into explicit regular files so the
      // normal path, symlink, and sensitive-file checks still apply. This is
      // intentionally not a recursive Git add of an arbitrary directory.
      const safePaths = [];
      for (const item of requestedPaths) {
        const target = resolveInside(repoRoot, item);
        await assertNoSymlinkTraversal(repoRoot, item);
        const stat = await fs.lstat(target).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
        if (!stat || stat.isFile()) {
          safePaths.push(item);
          continue;
        }
        if (!stat.isDirectory()) {
          throw Object.assign(new Error("Stage only regular files from the selected source path."), { code: "INVALID_GIT_PATHS" });
        }
        const expanded = [];
        const collect = async directory => {
          const entries = await fs.readdir(directory, { withFileTypes: true });
          for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            const candidate = path.join(directory, entry.name);
            const relative = normalizeRelativePath(path.relative(repoRoot, candidate).replaceAll(path.sep, "/"));
            if (entry.isSymbolicLink()) {
              throw Object.assign(new Error("Symlinked files cannot be staged through FELTUS CODE."), { code: "SYMLINK_NOT_ALLOWED" });
            }
            if (entry.isDirectory()) {
              await assertNoSymlinkTraversal(repoRoot, relative);
              await collect(candidate);
              continue;
            }
            if (!entry.isFile()) {
              throw Object.assign(new Error("Only regular files can be staged through FELTUS CODE."), { code: "INVALID_GIT_PATHS" });
            }
            if (isSensitivePath(relative)) {
              throw Object.assign(new Error("Sensitive paths cannot be staged through FELTUS CODE."), { code: "SENSITIVE_FILE_BLOCKED" });
            }
            await assertNoSymlinkTraversal(repoRoot, relative);
            expanded.push(relative);
            if (expanded.length + safePaths.length > 100) {
              throw Object.assign(new Error("A checkpoint can include at most 100 explicit source files."), { code: "INVALID_GIT_PATHS" });
            }
          }
        };
        await collect(target);
        if (!expanded.length) {
          throw Object.assign(new Error("The selected source folder does not contain a stageable regular file."), { code: "INVALID_GIT_PATHS" });
        }
        safePaths.push(...expanded);
      }
      const explicitPaths = [...new Set(safePaths)].sort();
      const result = await runGit(repoRoot, ["add", "--", ...explicitPaths.map(item => `:(literal)${item}`)]);
      return { ...result, paths: explicitPaths };
    },

    async checkpoint({ message = "FELTUS CODE checkpoint", confirm = false } = {}) {
      if (!confirm) throw Object.assign(new Error("Explicit confirmation is required before committing."), { code: "CONFIRMATION_REQUIRED" });
      await assertExactGitRoot(repoRoot);
      const staged = await runGitRaw(repoRoot, ["diff", "--cached", "--quiet"])
        .then(() => false)
        .catch(error => error?.result?.code === 1 ? true : Promise.reject(error));
      if (!staged) throw Object.assign(new Error("Stage the intended paths before creating a checkpoint."), { code: "NOTHING_STAGED" });
      const names = await runGitRaw(repoRoot, ["diff", "--cached", "--name-only", "-z"]);
      if (names.stdout.split("\0").filter(Boolean).some(isSensitivePath)) {
        throw Object.assign(new Error("Staged changes include a sensitive path; checkpoint blocked."), { code: "SENSITIVE_FILE_BLOCKED" });
      }
      return runGitRaw(repoRoot, [
        "commit",
        "-m",
        String(message).slice(0, 200)
      ]);
    }
  };
}
