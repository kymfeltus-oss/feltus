import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildRepoMap } from "../server/repo-map.mjs";
import { createFileTools } from "../server/file-tools.mjs";
import { createCodeAgent } from "../server/agent.mjs";
import { createGitTools, assertExactGitRoot } from "../server/git-tools.mjs";
import { createTaskRunner, DEFAULT_TASKS } from "../server/task-runner.mjs";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feltus-code-test-"));
const parent = path.join(tempRoot, "parent-repository");
const root = path.join(parent, "project-workspace");
const outside = path.join(tempRoot, "outside");
await fs.mkdir(root, { recursive: true });
await fs.mkdir(outside, { recursive: true });
const otherProject = path.join(parent, "other-project");
await fs.mkdir(otherProject, { recursive: true });

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
}

try {
  const stagingFileContent = "FELTUS CODE STAGING TEST\n";
  await fs.writeFile(path.join(root, "hello.txt"), stagingFileContent, "utf8");
  await fs.writeFile(path.join(otherProject, "hello.txt"), "SECOND PROJECT PRIVATE\n", "utf8");
  await fs.writeFile(path.join(root, "config.yml"), 'password: "must-not-leak-this-value"\n', "utf8");
  await fs.writeFile(path.join(root, "runtime-config.json"), '{"SERVICE_ROLE_KEY":"must-not-leak-this-key","endpoint":"http://local"}\n', "utf8");
  await fs.writeFile(path.join(root, "values-secret.yml"), "credential: private-value\n", "utf8");
  await fs.writeFile(path.join(root, ".env.local"), "SECRET=value\n", "utf8");
  await fs.writeFile(path.join(root, "module.mjs"), "export function safeFunction() {}\n", "utf8");

  const files = createFileTools({ repoRoot: root });
  assert.equal(await files.read("hello.txt"), stagingFileContent);
  assert.match(await files.read("config.yml"), /password: \[REDACTED\]/);
  assert.doesNotMatch(await files.read("config.yml"), /must-not-leak-this-value/);
  assert.doesNotMatch(await files.read("runtime-config.json"), /must-not-leak-this-key/);
  await assert.rejects(() => files.read(".env.local"), error => error.code === "SENSITIVE_FILE_BLOCKED");
  await assert.rejects(() => files.read("values-secret.yml"), error => error.code === "SENSITIVE_FILE_BLOCKED");
  await assert.rejects(() => files.read(".git/config"), error => error.code === "SENSITIVE_FILE_BLOCKED");
  await assert.rejects(() => files.createFile(".git/hooks/pre-commit", "unexpected hook"), error => error.code === "SENSITIVE_FILE_BLOCKED");
  await assert.rejects(() => files.readForAI("config.yml"), error => error.code === "SECRET_REDACTION_REVIEW");
  assert.equal((await files.list(".")).some(item => item.name === ".env.local" || item.name === "values-secret.yml"), false);
  await assert.rejects(() => files.read("../outside.txt"), error => error.code === "INVALID_REPO_PATH");
  await assert.rejects(() => files.read(path.join(tempRoot, "outside.txt")), error => error.code === "INVALID_REPO_PATH");

  const search = await files.search("must-not-leak");
  assert.equal(search.length, 0);
  const safeSearch = await files.search("password");
  assert.equal(safeSearch.length, 1);
  assert.doesNotMatch(safeSearch[0].preview, /must-not-leak-this-value/);
  assert.match(await buildRepoMap(root), /module\.mjs symbols: safeFunction/);
  assert.doesNotMatch(await buildRepoMap(root), /values-secret|\.env\.local/);

  const planChunks = [];
  let planCalls = 0;
  const agent = createCodeAgent({
    repoRoot: root,
    fileTools: files,
    aiGateway: {
      async complete() { throw new Error("The streaming planning path should be used."); },
      async *completeStream({ messages, model }) {
        planCalls += 1;
        assert.match(messages[1].content, /module\.mjs/);
        assert.doesNotMatch(messages[1].content, /values-secret|must-not-leak-this-value/);
        assert.match(messages[0].content, /Never invent, assume, or claim file contents/);
        const contextMatch = messages[1].content.match(/Server-read selected file context \(authoritative JSON; an empty array means no file is selected\):\n([\s\S]*?)\n\nTask:/);
        assert.ok(contextMatch, "planning request includes a distinct selected-file context block");
        const selected = JSON.parse(contextMatch[1]);
        assert.equal(selected.length, 1);
        assert.equal(selected[0].path, "hello.txt");
        assert.equal(selected[0].content, stagingFileContent);
        assert.match(messages[1].content, /FELTUS CODE STAGING TEST/);
        assert.equal(model, "local-coder");
        yield { delta: "hello.txt contains FELTUS CODE STAGING TEST. ", done: false, model };
        yield { delta: "Safe improvement: add a final newline.", done: false, model };
        yield { done: true, model, usage: { input_tokens: 8, output_tokens: 3 } };
      }
    }
  });
  const plan = await agent.plan({
    prompt: "Explain what hello.txt contains and suggest one safe improvement. Do not edit the file.",
    paths: ["hello.txt"],
    model: "local-coder",
    onToken: token => planChunks.push(token)
  });
  assert.equal(plan.content, "hello.txt contains FELTUS CODE STAGING TEST. Safe improvement: add a final newline.");
  assert.doesNotMatch(plan.content, /Hello, World!/);
  assert.deepEqual(planChunks, ["hello.txt contains FELTUS CODE STAGING TEST. ", "Safe improvement: add a final newline."]);
  assert.deepEqual(plan.usage, { input_tokens: 8, output_tokens: 3 });

  await assert.rejects(
    () => agent.plan({ prompt: "Explain the other project's hello.txt", paths: ["../other-project/hello.txt"] }),
    error => error.code === "INVALID_REPO_PATH"
  );
  await assert.rejects(
    () => files.inspect("../other-project/hello.txt", { forAI: true }),
    error => error.code === "INVALID_REPO_PATH"
  );
  assert.equal(planCalls, 1, "cross-project file attempts must be rejected before reaching the model");
  await assert.rejects(
    () => agent.plan({ prompt: "Explain an unspecified file", paths: [] }),
    error => error.code === "FILE_CONTEXT_REQUIRED"
  );

  let editMessages;
  const editAgent = createCodeAgent({
    repoRoot: root,
    fileTools: files,
    aiGateway: {
      async complete({ messages }) {
        editMessages = messages;
        return {
          content: JSON.stringify({ summary: "Keep the staging marker", files: [{ path: "hello.txt", content: stagingFileContent }] }),
          model: "local-coder",
          usage: { input_tokens: 4, output_tokens: 2 }
        };
      }
    }
  });
  const editProposal = await editAgent.proposeEdit({ prompt: "Make a safe improvement", paths: ["hello.txt"], model: "local-coder" });
  assert.match(editMessages[0].content, /Never use absolute paths/);
  assert.match(editMessages[1].content, /FELTUS CODE STAGING TEST/);
  assert.match(editMessages[1].content, /"path":"hello.txt"/);
  assert.equal(editProposal.files[0].before_sha256, await files.hash("hello.txt"));

  await files.createDirectory("nested");
  await files.createFile("nested/new.txt", "new content");
  assert.equal(await files.read("nested/new.txt"), "new content");
  const originalHash = await files.hash("nested/new.txt");
  await files.write("nested/new.txt", "updated", { expectedSha256: originalHash });
  assert.equal(await files.read("nested/new.txt"), "updated");
  await assert.rejects(
    () => files.write("nested/new.txt", "stale update", { expectedSha256: originalHash }),
    error => error.code === "FILE_WRITE_CONFLICT"
  );
  await assert.rejects(() => files.write("fresh.txt", "no version"), error => error.code === "FILE_VERSION_REQUIRED");
  await files.rename("nested/new.txt", "nested/moved.txt");
  assert.equal(await files.read("nested/moved.txt"), "updated");
  await assert.rejects(() => files.remove("nested/moved.txt"), error => error.code === "CONFIRMATION_REQUIRED");
  await files.remove("nested/moved.txt", { confirm: true });
  await assert.rejects(() => files.read("nested/moved.txt"), { code: "ENOENT" });

  await fs.writeFile(path.join(outside, "external.txt"), "outside project", "utf8");
  const link = path.join(root, "linked-outside");
  let symlinkTested = true;
  try {
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      () => files.read("linked-outside/external.txt"),
      error => error.code === "SYMLINK_NOT_ALLOWED"
    );
    await assert.rejects(
      () => agent.plan({ prompt: "Explain the linked file", paths: ["linked-outside/external.txt"] }),
      error => error.code === "SYMLINK_NOT_ALLOWED"
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error?.code)) {
      symlinkTested = false;
    } else {
      throw error;
    }
  }

  // A child folder must not inherit Git operations from its unrelated parent.
  git(["init", "--initial-branch=main"], parent);
  const gitTools = createGitTools({ repoRoot: root });
  const gitMetadataLink = path.join(root, ".git");
  await fs.symlink(path.join(parent, ".git"), gitMetadataLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => gitTools.initialize(), error => error.code === "SYMLINK_NOT_ALLOWED");
  await fs.rm(gitMetadataLink, { recursive: true, force: true });
  assert.equal((await gitTools.available()).available, false);
  await assert.rejects(() => gitTools.diff(), error => error.code === "NOT_GIT_ROOT");

  // Explicit initialization makes this folder its own Git root; all later
  // operations verify that exact root before invoking Git.
  const initialized = await gitTools.initialize();
  assert.equal(initialized.initialized, true);
  await assertExactGitRoot(root);
  assert.equal((await gitTools.available()).available, true);
  const previousGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(parent, ".git");
  try {
    assert.equal((await gitTools.available()).available, true, "ambient GIT_DIR must not redirect repository access");
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
  }
  assert.match((await gitTools.status()).stdout, /## No commits yet on main/);
  assert.equal((await gitTools.log()).stdout, "");
  await assert.rejects(() => gitTools.stage(["../outside.txt"]), error => error.code === "INVALID_REPO_PATH");
  await assert.rejects(() => gitTools.stage(["values-secret.yml"]), error => error.code === "SENSITIVE_FILE_BLOCKED");
  await assert.rejects(() => gitTools.stage(["nested"]), error => error.code === "INVALID_GIT_PATHS");
  await assert.rejects(
    () => gitTools.checkpoint({ message: "missing confirmation" }),
    error => error.code === "CONFIRMATION_REQUIRED"
  );
  await gitTools.stage(["hello.txt"]);
  assert.match((await gitTools.diff({ staged: true })).stdout, /FELTUS CODE STAGING TEST/);

  const tasks = createTaskRunner({ repoRoot: root });
  assert.ok(tasks.list().includes("npm-check"));
  assert.ok(tasks.list().includes("npm-regression"));
  assert.ok(tasks.list().includes("npm-test-core"));
  assert.ok(tasks.list().includes("compose-config"));
  assert.deepEqual(Object.keys(DEFAULT_TASKS), tasks.list());
  assert.ok(Object.values(DEFAULT_TASKS).every(task => typeof task.command === "string" && !task.shell));
  const statusTask = await tasks.run("git-status");
  assert.equal(statusTask.code, 0);
  const savedGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(parent, ".git");
  try {
    const isolatedStatusTask = await tasks.run("git-status");
    assert.equal(isolatedStatusTask.code, 0);
    assert.match(isolatedStatusTask.stdout, /No commits yet on main/);
  } finally {
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
  }
  await assert.rejects(() => tasks.run("arbitrary-shell"), error => error.code === "TASK_NOT_ALLOWED");
  const abortController = new AbortController();
  const cancellableTask = createTaskRunner({
    repoRoot: root,
    tasks: { "slow-task": { command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"] } }
  });
  const taskPromise = cancellableTask.run("slow-task", { signal: abortController.signal });
  setTimeout(() => abortController.abort(), 50);
  await assert.rejects(taskPromise, error => error.code === "REQUEST_CANCELLED");

  process.stdout.write("PASS FELTUS CODE selected-file AI grounding, staging marker, cross-project isolation, and edit hash tests\n");
  process.stdout.write("PASS FELTUS CODE file, redaction, search, repo map, write-conflict, rename, and delete tests\n");
  process.stdout.write(`PASS FELTUS CODE symlink traversal test${symlinkTested ? "" : " (platform capability unavailable; skipped)"}\n`);
  process.stdout.write("PASS FELTUS CODE exact Git-root isolation, status, stage, and checkpoint-confirmation tests\n");
  process.stdout.write("PASS FELTUS CODE server task allowlist and arbitrary-command rejection tests\n");
  process.stdout.write("PASS FELTUS CODE stale task cancellation test\n");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
