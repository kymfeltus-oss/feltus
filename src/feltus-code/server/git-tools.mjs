import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { assertNoSymlinkTraversal, isSensitivePath, normalizeRelativePath, redactSecrets, resolveInside } from "./security.mjs";

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

export function isolatedGitEnvironment(extra = {}) {
  const env = { ...process.env };
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

    async stage(paths = []) {
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100) {
        throw Object.assign(new Error("Select between 1 and 100 changed repository paths."), { code: "INVALID_GIT_PATHS" });
      }
      const safePaths = paths.map(value => normalizeRelativePath(value));
      if (safePaths.some(isSensitivePath)) {
        throw Object.assign(new Error("Sensitive paths cannot be staged through FELTUS CODE."), { code: "SENSITIVE_FILE_BLOCKED" });
      }
      for (const item of safePaths) {
        const target = resolveInside(repoRoot, item);
        await assertNoSymlinkTraversal(repoRoot, item);
        const stat = await fs.lstat(target).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
        if (stat && !stat.isFile()) {
          throw Object.assign(new Error("Stage individual regular files; directory staging could include excluded content."), { code: "INVALID_GIT_PATHS" });
        }
      }
      return runGit(repoRoot, ["add", "--", ...safePaths.map(item => `:(literal)${item}`)]);
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
