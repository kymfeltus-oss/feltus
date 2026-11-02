import { spawn } from "node:child_process";
import { redactSecrets } from "./security.mjs";
import { assertExactGitRoot, isolatedGitEnvironment } from "./git-tools.mjs";

export const DEFAULT_TASKS = Object.freeze({
  "git-status": { command: "git", args: ["status", "--short", "--branch"] },
  "git-diff": { command: "git", args: ["diff", "--no-ext-diff"] },
  "npm-check": { command: "npm", args: ["run", "check"] },
  "npm-test-core": { command: "npm", args: ["run", "test:core"] },
  "npm-regression": { command: "npm", args: ["run", "regression"] },
  "compose-config": { command: "docker", args: ["compose", "--env-file", ".env.example", "--file", "compose.production.yaml", "config", "--quiet"] }
});

export function createTaskRunner({ repoRoot, tasks = DEFAULT_TASKS, timeoutMs = 120000 }) {
  async function run(taskName, { signal } = {}) {
    const task = tasks[taskName];
    if (!task) {
      const err = new Error("Task is not allowlisted.");
      err.code = "TASK_NOT_ALLOWED";
      throw err;
    }

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
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", error => {
        clearTimeout(timer);
        if (error?.name === "AbortError") error.code = "REQUEST_CANCELLED";
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          task: taskName,
          code,
          signal,
          stdout: redactSecrets(stdout).slice(-200000),
          stderr: redactSecrets(stderr).slice(-200000)
        });
      });
    });
  }

  return { run, list: () => Object.keys(tasks) };
}
