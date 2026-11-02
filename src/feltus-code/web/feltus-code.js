const $ = id => document.getElementById(id);
const projectId = new URLSearchParams(location.search).get("app_id");
const state = {
  directory: ".",
  activePath: null,
  files: new Map(),
  proposal: null,
  request: null,
  tasks: []
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.code = data.code;
    error.requestId = data.request_id || response.headers.get("x-request-id");
    throw error;
  }
  return data;
}

function projectQuery(path) {
  const url = new URL(path, location.origin);
  url.searchParams.set("app_id", projectId || "");
  return url.pathname + url.search;
}

function setStatus(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.error = error ? "true" : "false";
}

function showOutput(title, value) {
  $("output-title").textContent = title;
  $("output").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function renderTabs() {
  const tabs = $("tabs");
  tabs.replaceChildren();
  for (const [filePath, file] of state.files) {
    const button = document.createElement("button");
    button.className = `file-tab${state.activePath === filePath ? " active" : ""}`;
    button.textContent = `${file.dirty ? "● " : ""}${filePath}`;
    button.title = filePath;
    button.onclick = () => openFile(filePath);
    tabs.append(button);
  }
}

function renderEditor() {
  const file = state.files.get(state.activePath);
  if (!file) {
    $("active-file").textContent = "No file selected";
    $("code").value = "";
    $("code").disabled = true;
    $("save").disabled = true;
    $("line-numbers").textContent = "1";
    return;
  }
  $("active-file").textContent = `${state.activePath}${file.dirty ? "  • Modified" : ""}${file.redacted ? "  • Redacted view, read only" : ""}`;
  $("code").value = file.content;
  $("code").disabled = !file.editable;
  $("save").disabled = !file.editable || !file.dirty;
  renderLineNumbers();
}

function renderLineNumbers() {
  const count = Math.max(1, $("code").value.split("\n").length);
  $("line-numbers").textContent = Array.from({ length: count }, (_, i) => i + 1).join("\n");
  $("line-numbers").scrollTop = $("code").scrollTop;
}

async function loadTree(pathname = ".") {
  state.directory = pathname;
  const data = await api(projectQuery(`/api/code/tree?path=${encodeURIComponent(pathname)}`));
  $("tree").replaceChildren();
  $("tree-path").textContent = pathname;
  for (const item of data.items || []) {
    const row = document.createElement("div");
    row.className = "tree-row";
    const button = document.createElement("button");
    button.className = "tree-item";
    button.textContent = `${item.type === "directory" ? "▸" : "·"} ${item.name}`;
    button.onclick = () => item.type === "directory" ? loadTree(item.path) : openFile(item.path);
    row.append(button);
    $("tree").append(row);
  }
}

async function openFile(pathname) {
  if (state.files.has(pathname)) {
    state.activePath = pathname;
    renderTabs();
    renderEditor();
    return;
  }
  const result = await api(projectQuery(`/api/code/file?path=${encodeURIComponent(pathname)}`));
  state.files.set(pathname, {
    content: result.content || "",
    original: result.content || "",
    sha256: result.sha256,
    redacted: result.redacted === true,
    editable: result.editable !== false,
    dirty: false
  });
  state.activePath = pathname;
  renderTabs();
  renderEditor();
  setStatus(`Opened ${pathname}${result.redacted ? " (secret-like values redacted)" : ""}`);
}

function updateDirtyState() {
  const file = state.files.get(state.activePath);
  if (!file) return;
  file.content = $("code").value;
  file.dirty = file.content !== file.original;
  renderTabs();
  $("active-file").textContent = `${state.activePath}${file.dirty ? "  • Modified" : ""}${file.redacted ? "  • Redacted view, read only" : ""}`;
  $("save").disabled = !file.editable || !file.dirty;
  renderLineNumbers();
}

async function saveFile() {
  const file = state.files.get(state.activePath);
  if (!file || !file.editable) return;
  await api(projectQuery("/api/code/file"), {
    method: "PUT",
    body: JSON.stringify({ app_id: projectId, path: state.activePath, content: file.content, expected_sha256: file.sha256 })
  });
  const saved = await api(projectQuery(`/api/code/file?path=${encodeURIComponent(state.activePath)}`));
  file.content = saved.content;
  file.original = saved.content;
  file.sha256 = saved.sha256;
  file.dirty = false;
  renderTabs();
  renderEditor();
  await refreshGitStatus();
  setStatus(`Saved ${state.activePath}`);
}

async function refreshGitStatus() {
  try {
    const result = await api(projectQuery("/api/code/git/status"));
    $("branch").textContent = result.stdout?.split(/\r?\n/)[0] || "Git connected";
    $("git-status").textContent = result.stdout || "Working tree clean";
  } catch (error) {
    $("branch").textContent = "Git unavailable";
    $("git-status").textContent = error.message;
  }
}

async function showDiff(staged = false) {
  const result = await api(projectQuery(`/api/code/git/diff?staged=${staged}`));
  showOutput(staged ? "Staged diff" : "Working diff", result.stdout || "No changes.");
}

async function loadModels() {
  const [modelsResult, healthResult] = await Promise.allSettled([
    api(projectQuery("/api/ai/models")),
    api(projectQuery("/api/ai/runtime/health"))
  ]);
  if (modelsResult.status === "rejected") throw modelsResult.reason;
  const result = modelsResult.value;
  const health = healthResult.status === "fulfilled" ? healthResult.value : { status: "unavailable" };
  $("ai-runtime-status").textContent = health.status === "healthy"
    ? `${health.provider} · ${health.model_count} model(s) · ${health.latency_ms} ms`
    : "FELTUS AI runtime unavailable";
  $("ai-runtime-status").dataset.error = health.status === "healthy" ? "false" : "true";
  $("model").replaceChildren();
  for (const model of result.models || []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.name} · ${model.provider || "FELTUS runtime"}`;
    if (model.default) option.selected = true;
    $("model").append(option);
  }
}

async function streamPlanAI({ mode, prompt, paths, controller }) {
  const response = await fetch(projectQuery("/api/code/ai/plan/stream"), {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({ app_id: projectId, prompt: `${mode}: ${prompt}`, model: $("model").value, paths })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.code = data.code;
    error.requestId = data.request_id || response.headers.get("x-request-id");
    throw error;
  }
  if (!response.body) throw new Error("FELTUS AI returned no plan stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let final = null;
  const outputTitle = `${mode} · ${$("model").value}`;
  showOutput(outputTitle, "");
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.error) {
        const error = new Error(event.error.message || "FELTUS CODE plan stream failed.");
        error.code = event.error.code;
        error.requestId = event.request_id;
        throw error;
      }
      if (event.delta) {
        content += event.delta;
        showOutput(outputTitle, content);
      }
      if (event.done) final = event;
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const event = JSON.parse(buffer.trim());
    if (event.error) throw Object.assign(new Error(event.error.message || "FELTUS CODE plan stream failed."), { code: event.error.code, requestId: event.request_id });
    if (event.done) final = event;
  }
  return final || { result: { content }, model: $("model").value, request_id: response.headers.get("x-request-id") };
}

function cancelAI() {
  if (state.request && !state.request.signal.aborted) state.request.abort();
  state.request = null;
  $("cancel-ai").hidden = true;
  setStatus("AI request cancelled");
}

async function requestAI(mode) {
  if (state.request) return;
  const prompt = $("prompt").value.trim();
  if (!prompt) return setStatus("Enter a task for FELTUS AI.", true);
  const controller = new AbortController();
  state.request = controller;
  $("cancel-ai").hidden = false;
  const requestPaths = state.activePath ? [state.activePath] : [];
  try {
    setStatus(`${mode} through FELTUS AI Gateway…`);
    const route = mode === "Plan" || mode === "Explain" || mode === "Review" ? "plan" : "edit";
    const data = route === "plan"
      ? await streamPlanAI({ mode, prompt, paths: requestPaths, controller })
      : await api(projectQuery(`/api/code/ai/${route}`), {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({ app_id: projectId, prompt: `${mode}: ${prompt}`, model: $("model").value, paths: requestPaths })
        });
    if (route === "edit") {
      state.proposal = data.result;
      renderProposal(data.result);
      showOutput("Edit proposal · review before applying", `${data.result.summary}\n\nRequest ID: ${data.request_id || "not provided"}`);
    } else {
      showOutput(`${mode} · ${data.model || $("model").value}`, data.result?.content || data.result);
      $("proposal").replaceChildren();
      state.proposal = null;
    }
    setStatus(`${mode} complete · request ${data.request_id || "recorded"}`);
  } catch (error) {
    if (error.name === "AbortError") return;
    setStatus(`${error.message}${error.requestId ? ` · request ${error.requestId}` : ""}`, true);
    showOutput("FELTUS CODE error", `${error.code || "REQUEST_FAILED"}: ${error.message}`);
  } finally {
    if (state.request === controller) {
      state.request = null;
      $("cancel-ai").hidden = true;
    }
  }
}

function renderProposal(proposal) {
  const container = $("proposal");
  container.replaceChildren();
  for (const item of proposal.files || []) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = item.path;
    const before = state.files.get(item.path)?.content || "";
    const diff = document.createElement("pre");
    diff.className = "proposal-diff";
    diff.textContent = `--- current\n${before}\n\n+++ proposed\n${item.content}`;
    details.append(summary, diff);
    container.append(details);
  }
  $("apply-edit").hidden = !proposal.files?.length;
}

async function runAgent() {
  if (state.request) return;
  const prompt = $("prompt").value.trim();
  if (!prompt || !state.activePath) return setStatus("Open a file and enter an agent task.", true);
  if (!window.confirm("Allow FELTUS CODE Agent to edit the selected file and run the selected allowlisted validation task?")) return;
  const controller = new AbortController();
  state.request = controller;
  $("cancel-ai").hidden = false;
  try {
    setStatus("FELTUS CODE Agent is planning, editing, and validating…");
    const data = await api(projectQuery("/api/code/ai/agent"), {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        app_id: projectId,
        prompt,
        paths: [state.activePath],
        model: $("model").value,
        task: $("agent-task").value,
        allow_apply: true
      })
    });
    showOutput("Agent plan and validation", data.result);
    const refreshed = await api(projectQuery(`/api/code/file?path=${encodeURIComponent(state.activePath)}`));
    state.files.set(state.activePath, { content: refreshed.content, original: refreshed.content, sha256: refreshed.sha256, editable: refreshed.editable, redacted: refreshed.redacted, dirty: false });
    renderTabs(); renderEditor(); await refreshGitStatus();
    setStatus("Agent stopped after the allowlisted validation run.");
  } catch (error) {
    setStatus(`${error.code || "AGENT_FAILED"}: ${error.message}`, true);
    showOutput("Agent stopped", error.message);
  } finally {
    if (state.request === controller) {
      state.request = null;
      $("cancel-ai").hidden = true;
    }
  }
}

async function initializeWorkspace() {
  if (!window.confirm("Create a new private Git workspace for this FELTUS project? It will start empty and stay inside the persistent FELTUS workspace volume.")) return;
  const result = await api(projectQuery("/api/code/workspace"), {
    method: "POST",
    body: JSON.stringify({ app_id: projectId, action: "initialize" })
  });
  $("workspace-setup").hidden = true;
  $("workspace-app").hidden = false;
  await loadWorkspace();
  setStatus(result.result?.initialized ? "Private project Git workspace initialized." : "Project workspace ready.");
}

async function loadWorkspace() {
  const workspace = await api(projectQuery("/api/code/workspace"));
  if (!workspace.initialized) {
    $("workspace-setup").hidden = false;
    $("workspace-app").hidden = true;
    setStatus("This FELTUS project has no code workspace yet.");
    return;
  }
  $("workspace-setup").hidden = true;
  $("workspace-app").hidden = false;
  const session = await api(projectQuery("/api/code/session"));
  $("session-title").textContent = session.session?.title || "Project code session";
  const [tasks] = await Promise.all([
    api(projectQuery("/api/code/tasks")).then(result => result.tasks || []),
    loadModels()
  ]);
  state.tasks = tasks;
  $("agent-task").replaceChildren();
  for (const task of tasks) {
    const option = document.createElement("option"); option.value = task; option.textContent = task; $("agent-task").append(option);
  }
  if (tasks.includes("npm-check")) $("agent-task").value = "npm-check";
  await Promise.all([loadTree("."), refreshGitStatus()]);
}

async function boot() {
  if (!projectId) {
    setStatus("No authorized FELTUS project was selected.", true);
    $("initialize-workspace").disabled = true;
    return;
  }
  try {
    await loadWorkspace();
  } catch (error) {
    setStatus(`${error.code || "STARTUP_FAILED"}: ${error.message}`, true);
  }
}

$("code").addEventListener("input", updateDirtyState);
$("code").addEventListener("scroll", renderLineNumbers);
$("save").onclick = () => saveFile().catch(error => setStatus(`${error.code || "SAVE_FAILED"}: ${error.message}`, true));
$("initialize-workspace").onclick = () => initializeWorkspace().catch(error => setStatus(error.message, true));
$("refresh-tree").onclick = () => loadTree(state.directory).catch(error => setStatus(error.message, true));
$("tree-up").onclick = () => loadTree(state.directory === "." ? "." : state.directory.split("/").slice(0, -1).join("/") || ".");
$("new-file").onclick = async () => {
  const name = window.prompt("New file path, relative to the project repository:");
  if (!name) return;
  try {
    const result = await api(projectQuery("/api/code/file/create"), { method: "POST", body: JSON.stringify({ app_id: projectId, path: name, content: "" }) });
    await loadTree(state.directory); await openFile(result.path); await refreshGitStatus();
  } catch (error) { setStatus(`${error.code || "CREATE_FAILED"}: ${error.message}`, true); }
};
$("rename-file").onclick = async () => {
  if (!state.activePath) return;
  const next = window.prompt("Move or rename to a project-relative path:", state.activePath);
  if (!next || next === state.activePath) return;
  try {
    await api(projectQuery("/api/code/rename"), { method: "POST", body: JSON.stringify({ app_id: projectId, from: state.activePath, to: next }) });
    state.files.delete(state.activePath); state.activePath = null; renderTabs(); renderEditor(); await loadTree(state.directory); await refreshGitStatus();
  } catch (error) { setStatus(`${error.code || "RENAME_FAILED"}: ${error.message}`, true); }
};
$("delete-file").onclick = async () => {
  if (!state.activePath || !window.confirm(`Delete ${state.activePath}? This cannot be undone here.`)) return;
  try {
    await api(projectQuery(`/api/code/file?path=${encodeURIComponent(state.activePath)}&confirm=true`), { method: "DELETE" });
    state.files.delete(state.activePath); state.activePath = null; renderTabs(); renderEditor(); await loadTree(state.directory); await refreshGitStatus();
  } catch (error) { setStatus(`${error.code || "DELETE_FAILED"}: ${error.message}`, true); }
};
$("search").addEventListener("keydown", async event => {
  if (event.key !== "Enter" || !event.currentTarget.value.trim()) return;
  try {
    const result = await api(projectQuery(`/api/code/search?q=${encodeURIComponent(event.currentTarget.value.trim())}`));
    $("search-results").replaceChildren();
    for (const item of result.results || []) {
      const button = document.createElement("button"); button.className = "search-result";
      button.textContent = `${item.path}:${item.line}  ${item.preview}`; button.onclick = () => openFile(item.path); $("search-results").append(button);
    }
    setStatus(`${result.results?.length || 0} search match(es)`);
  } catch (error) { setStatus(`${error.code || "SEARCH_FAILED"}: ${error.message}`, true); }
});
$("run-task").onclick = async () => {
  try { setStatus(`Running ${$("agent-task").value}…`); const result = await api(projectQuery("/api/code/task"), { method: "POST", body: JSON.stringify({ app_id: projectId, task: $("agent-task").value }) }); showOutput(result.result.task, result.result); setStatus(`${result.result.task}: exit ${result.result.code}`); }
  catch (error) { setStatus(`${error.code || "TASK_FAILED"}: ${error.message}`, true); }
};
$("git-diff").onclick = () => showDiff(false).catch(error => setStatus(error.message, true));
$("git-staged-diff").onclick = () => showDiff(true).catch(error => setStatus(error.message, true));
$("git-log").onclick = async () => { try { const result = await api(projectQuery("/api/code/git/log")); showOutput("Recent commits", result.stdout || "No commits yet."); } catch (error) { setStatus(error.message, true); } };
$("git-stage-current").onclick = async () => {
  if (!state.activePath || !window.confirm(`Stage ${state.activePath}?`)) return;
  try { await api(projectQuery("/api/code/git/stage"), { method: "POST", body: JSON.stringify({ app_id: projectId, paths: [state.activePath] }) }); await refreshGitStatus(); setStatus(`Staged ${state.activePath}`); }
  catch (error) { setStatus(`${error.code || "STAGE_FAILED"}: ${error.message}`, true); }
};
$("git-checkpoint").onclick = async () => {
  const message = window.prompt("Checkpoint message:", "FELTUS CODE checkpoint");
  if (!message || !window.confirm("Commit only the currently staged changes?")) return;
  try { const result = await api(projectQuery("/api/code/git/checkpoint"), { method: "POST", body: JSON.stringify({ app_id: projectId, message, confirm: true }) }); showOutput("Git checkpoint", result); await refreshGitStatus(); setStatus(`Checkpoint ${result.commit} created`); }
  catch (error) { setStatus(`${error.code || "CHECKPOINT_FAILED"}: ${error.message}`, true); }
};
$("plan").onclick = () => requestAI("Plan");
$("edit").onclick = () => requestAI("Edit");
$("fix").onclick = () => requestAI("Fix");
$("explain").onclick = () => requestAI("Explain");
$("review").onclick = () => requestAI("Review");
$("agent").onclick = runAgent;
$("cancel-ai").onclick = cancelAI;
$("apply-edit").onclick = async () => {
  if (!state.proposal || !window.confirm(`Apply the proposed changes to ${state.proposal.files.map(item => item.path).join(", ")}?`)) return;
  try {
    await api(projectQuery("/api/code/ai/apply"), { method: "POST", body: JSON.stringify({ app_id: projectId, files: state.proposal.files, allowed_paths: state.proposal.allowedPaths }) });
    for (const item of state.proposal.files) { state.files.delete(item.path); }
    const first = state.proposal.files[0]?.path; state.proposal = null; $("apply-edit").hidden = true;
    if (first) await openFile(first); await loadTree(state.directory); await refreshGitStatus(); setStatus("Accepted edit applied.");
  } catch (error) { setStatus(`${error.code || "APPLY_FAILED"}: ${error.message}`, true); }
};

boot();
