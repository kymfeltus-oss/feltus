import { createFileTools } from "./file-tools.mjs";
import { createGitTools } from "./git-tools.mjs";
import { createTaskRunner } from "./task-runner.mjs";
import { buildRepoMap } from "./repo-map.mjs";
import { createCodeAgent } from "./agent.mjs";

/**
 * Framework-neutral FELTUS CODE handlers.
 *
 * FELTUS host requirements:
 * - authenticate before these handlers are called
 * - resolve repoRoot server-side from an authorized project
 * - never accept an absolute repo path from the browser
 */
export function createFeltusCodeHandlers({ repoRoot, aiGateway, approvedTasks }) {
  const files = createFileTools({ repoRoot });
  const git = createGitTools({ repoRoot });
  const tasks = createTaskRunner(
    approvedTasks ? { repoRoot, tasks: approvedTasks } : { repoRoot }
  );
  let agent = null;
  const getAgent = () => {
    if (!agent) agent = createCodeAgent({ repoRoot, aiGateway, fileTools: files });
    return agent;
  };

  return {
    listTree: async ({ path = "." }) => ({ ok: true, items: await files.list(path) }),
    readFile: async ({ path }) => ({ ok: true, path, ...(await files.inspect(path)) }),
    writeFile: async ({ path, content, expected_sha256 }) => ({ ok: true, ...(await files.write(path, content, { expectedSha256: expected_sha256 })) }),
    createFile: async ({ path, content }) => ({ ok: true, ...(await files.createFile(path, content)) }),
    createDirectory: async ({ path }) => ({ ok: true, ...(await files.createDirectory(path)) }),
    rename: async ({ from, to }) => ({ ok: true, ...(await files.rename(from, to)) }),
    remove: async ({ path, confirm }) => ({ ok: true, ...(await files.remove(path, { confirm })) }),
    search: async ({ q, limit }) => ({ ok: true, results: await files.search(q, { limit }) }),
    repoMap: async () => ({ ok: true, map: await buildRepoMap(repoRoot) }),
    gitStatus: async () => ({ ok: true, ...(await git.status()) }),
    gitInitialize: async () => ({ ok: true, ...(await git.initialize()) }),
    gitDiff: async ({ staged = false }) => ({ ok: true, ...(await git.diff({ staged })) }),
    gitLog: async ({ limit = 20 }) => ({ ok: true, ...(await git.log(limit)) }),
    gitStage: async ({ paths }) => ({ ok: true, ...(await git.stage(paths)) }),
    checkpoint: async ({ message, confirm }) => ({ ok: true, ...(await git.checkpoint({ message, confirm })) }),
    listTasks: async () => ({ ok: true, tasks: tasks.list(), unavailable: tasks.unavailable(), default_task: tasks.defaultTask() }),
    runTask: async ({ task }, { signal } = {}) => ({ ok: true, result: await tasks.run(task, { signal }) }),
    validateTask: async ({ task, files }, { signal } = {}) => ({ ok: true, result: await tasks.runAgainstProposed(task, files, { signal }) }),
    aiPlan: async ({ prompt, paths, model }, { signal, onToken } = {}) => ({
      ok: true,
      result: await getAgent().plan({ prompt, paths, model, signal, onToken })
    }),
    aiEdit: async ({ prompt, paths, model }, { signal } = {}) => ({
      ok: true,
      result: await getAgent().proposeEdit({ prompt, paths, model, signal })
    }),
    applyEdit: async ({ files: proposedFiles, allowedPaths }, { signal } = {}) => {
      if (!Array.isArray(proposedFiles) || proposedFiles.length < 1 || proposedFiles.length > 12) {
        throw Object.assign(new Error("Accept between 1 and 12 proposed files."), { code: "INVALID_EDIT_PROPOSAL" });
      }
      const allowed = new Set(Array.isArray(allowedPaths) ? allowedPaths : []);
      const pending = [];
      const seen = new Set();
      for (const file of proposedFiles) {
        if (signal?.aborted) throw Object.assign(new Error("Edit request was cancelled."), { code: "REQUEST_CANCELLED" });
        if (!allowed.has(file?.path) || typeof file?.content !== "string" || seen.has(file.path)) {
          throw Object.assign(new Error("Edit proposal contains an unselected path."), { code: "INVALID_EDIT_PROPOSAL" });
        }
        const currentFile = await files.inspect(file.path, { forAI: true });
        if (currentFile.sha256 !== file.before_sha256) {
          throw Object.assign(new Error(`File changed since the proposal was generated: ${file.path}`), { code: "EDIT_CONFLICT" });
        }
        seen.add(file.path);
        if (currentFile.content !== file.content) pending.push(file);
      }
      const applied = [];
      for (const file of pending) applied.push(await files.write(file.path, file.content, { expectedSha256: file.before_sha256 }));
      return { ok: true, files: applied };
    }
  };
}
