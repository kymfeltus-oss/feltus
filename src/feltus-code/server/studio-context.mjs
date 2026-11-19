import { buildRepoMap } from "./repo-map.mjs";
import { createFileTools } from "./file-tools.mjs";
import { createGitTools } from "./git-tools.mjs";
import { redactSecrets } from "./security.mjs";

const CONTEXT_LIMITS = Object.freeze({
  selectedFiles: 12,
  relatedFiles: 8,
  selectedBytes: 160000,
  repoMapBytes: 40000,
  errors: 30,
  taskOutputBytes: 30000
});

function uniqueStrings(values, max) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter(value => typeof value === "string" && value.trim())
    .map(value => value.trim()))].slice(0, max);
}

function searchTerms(prompt) {
  return [...new Set(String(prompt || "").toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [])]
    .filter(term => !new Set(["build", "create", "change", "please", "this", "that", "with", "from", "have", "make", "into", "your", "app"]).has(term))
    .slice(0, 6);
}

async function selectedContext(files, paths) {
  const context = [];
  let used = 0;
  for (const relativePath of uniqueStrings(paths, CONTEXT_LIMITS.selectedFiles)) {
    const file = await files.inspect(relativePath, { forAI: true });
    if (used + Buffer.byteLength(file.content) > CONTEXT_LIMITS.selectedBytes) break;
    used += Buffer.byteLength(file.content);
    context.push({ path: relativePath, content: file.content, sha256: file.sha256 });
  }
  return context;
}

async function relatedContext(files, prompt, selectedPaths) {
  const selected = new Set(selectedPaths);
  const matches = [];
  for (const term of searchTerms(prompt)) {
    for (const result of await files.search(term, { limit: 12 })) {
      if (!selected.has(result.path) && !matches.some(match => match.path === result.path)) matches.push(result);
      if (matches.length >= CONTEXT_LIMITS.relatedFiles) break;
    }
    if (matches.length >= CONTEXT_LIMITS.relatedFiles) break;
  }
  const related = [];
  for (const match of matches) {
    try {
      const file = await files.inspect(match.path, { forAI: true });
      related.push({ path: match.path, sha256: file.sha256, content: file.content, matched_line: match.line });
    } catch {}
  }
  return related;
}

function safeArray(value, max = 100) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

export async function buildStudioContext({
  repoRoot,
  app,
  capabilities,
  prompt = "",
  selectedPaths = [],
  openPaths = [],
  selectedText = "",
  schema = {},
  preview = {},
  taskState = {},
  recentActions = [],
  currentVersion = null
}) {
  const files = createFileTools({ repoRoot });
  const git = createGitTools({ repoRoot });
  const requestedPaths = uniqueStrings([...selectedPaths, ...openPaths], CONTEXT_LIMITS.selectedFiles);
  const selectedFiles = await selectedContext(files, requestedPaths);
  const relatedFiles = await relatedContext(files, prompt, selectedFiles.map(file => file.path));
  const [repoMap, gitStatus, gitDiff] = await Promise.all([
    buildRepoMap(repoRoot).then(value => value.slice(0, CONTEXT_LIMITS.repoMapBytes)),
    git.status().then(result => result.stdout).catch(error => `Git status unavailable: ${error.message}`),
    git.diff().then(result => result.stdout.slice(0, 50000)).catch(error => `Git diff unavailable: ${error.message}`)
  ]);
  const errors = safeArray(preview.errors, CONTEXT_LIMITS.errors).map(error => ({
    type: String(error.type || "runtime"),
    message: redactSecrets(String(error.message || "")).slice(0, 2000),
    source: redactSecrets(String(error.source || "")).slice(0, 1000),
    at: error.at || null
  }));

  return {
    app: app ? { id: app.id, name: app.app_name, type: app.app_type || null } : null,
    workspace: { project_id: app?.id || null, isolated: true },
    capabilities: capabilities || {},
    repo: {
      summary: repoMap,
      git_status: redactSecrets(gitStatus),
      diff: redactSecrets(gitDiff)
    },
    editor: {
      current_file: selectedFiles[0]?.path || null,
      open_files: selectedFiles.map(file => file.path),
      selected_text: redactSecrets(String(selectedText || "")).slice(0, 12000),
      selected_files: selectedFiles,
      related_files: relatedFiles
    },
    data: {
      models: safeArray(schema.models, 100),
      relationships: safeArray(schema.relationships, 200)
    },
    runtime: {
      preview: {
        status: preview.status || "stopped",
        script: preview.script || null,
        errors
      },
      task: taskState?.task ? {
        task: taskState.task,
        code: taskState.code,
        stdout: redactSecrets(String(taskState.stdout || "")).slice(-CONTEXT_LIMITS.taskOutputBytes),
        stderr: redactSecrets(String(taskState.stderr || "")).slice(-CONTEXT_LIMITS.taskOutputBytes)
      } : null
    },
    current_version: currentVersion,
    recent_activity: safeArray(recentActions, 20).map(action => ({
      action_type: action.action_type,
      summary: String(action.summary || "").slice(0, 1000),
      result_status: action.result_status,
      actor_id: action.actor_id,
      created_at: action.created_at
    }))
  };
}

export function serializeStudioContext(context, maxBytes = 180000) {
  const serialized = JSON.stringify(context);
  if (Buffer.byteLength(serialized) <= maxBytes) return serialized;
  const compact = {
    ...context,
    repo: { ...context.repo, diff: String(context.repo?.diff || "").slice(0, 10000) },
    editor: {
      ...context.editor,
      selected_files: context.editor?.selected_files?.map(file => ({ ...file, content: file.content.slice(0, 12000) })),
      related_files: context.editor?.related_files?.map(file => ({ ...file, content: file.content.slice(0, 6000) }))
    }
  };
  return JSON.stringify(compact).slice(0, maxBytes);
}
