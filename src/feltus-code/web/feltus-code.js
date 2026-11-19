const $ = id => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const projectId = new URLSearchParams(location.search).get("app_id");
if (new URLSearchParams(location.search).get("embedded") === "1") document.body.classList.add("embedded-studio");
if (projectId) {
  const appPath = `/apps/${encodeURIComponent(projectId)}`;
  $("connections-link").href = `${appPath}/relationships`;
  $("my-app-link").href = appPath;
}
let previewHeartbeatTimer = null;
let previewHeartbeatBusy = false;

const state = {
  activePane: "chat",
  activePath: null,
  files: new Map(),
  expanded: new Set(),
  capabilities: {},
  role: "viewer",
  isAppOwner: false,
  tasks: [],
  unavailableTasks: [],
  aiMode: "Plan",
  plan: null,
  appName: "Your application",
  appDescription: "",
  applicationCreated: false,
  appliedSummary: "",
  changeSet: null,
  selectedChangeIds: new Set(),
  aiRequest: null,
  taskRequest: null,
  context: null,
  preview: { status: "stopped", errors: [] },
  undo: null,
  approvedCheckpoints: [],
  lastAppliedPaths: [],
  gitStatus: "",
  version: null,
  environments: [],
  schemaBusy: false,
  versionBusy: false,
  productionization: null,
  productionizationRunId: null,
  productionizationBusy: false,
  productionizationPlanning: false,
  releaseReadiness: null,
  releaseReadinessBusy: false,
  lastAppliedProductionizationRunId: null,
  deploymentBusy: false,
  idempotencyKey: null,
  design: null,
  designLoaded: false,
  designLoading: false,
  designViewport: "desktop",
  designPageId: "",
  designComponentId: "",
  designProposal: null,
  designReview: null,
  designBusy: false
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json().catch(() => ({})) : await response.text();
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error || `Request failed (${response.status}).`);
    error.code = data?.code;
    error.requestId = data?.request_id || response.headers.get("x-request-id");
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

function setAssistantError(error = null) {
  const node = $("assistant-error");
  if (!node) return;
  renderFriendlyError(node, error);
}

function renderFriendlyError(node, error) {
  node.replaceChildren();
  node.hidden = !error;
  if (!error) return;
  const message = document.createElement("p");
  message.textContent = "FELTUS couldn’t complete that request. Please try again. If it continues, open technical details.";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Technical details";
  const technical = document.createElement("pre");
  technical.textContent = errorMessage(error);
  details.append(summary, technical);
  node.append(message, details);
}

function updateAssistantAction() {
  const button = $("send-ai");
  if (!button) return;
  const label = state.aiMode === "Plan"
    ? "Create my app"
    : state.aiMode === "Build"
      ? state.plan ? "Continue" : "Create my app"
      : `Send ${state.aiMode.toLowerCase()}`;
  const icon = document.createElement("span");
  icon.textContent = "↑";
  icon.setAttribute("aria-hidden", "true");
  button.replaceChildren(document.createTextNode(label), icon);
}

function errorMessage(error) {
  return `${error.code || "REQUEST_FAILED"}: ${error.message}${error.requestId ? ` · request ${error.requestId}` : ""}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function switchPane(name) {
  if (!$("pane-" + name)) return;
  state.activePane = name;
  $$('[data-workspace-tab]').forEach(button => {
    const active = button.dataset.workspaceTab === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $$('[data-pane]').forEach(pane => {
    const active = pane.dataset.pane === name;
    pane.hidden = !active;
    pane.classList.toggle("active", active);
  });
  if (name === "data") renderSchema();
  if (name === "preview") renderPreview();
  if (name === "design") loadDesign().catch(showError);
}

function setChatProgress(message) {
  let progress = $("chat-progress");
  if (!progress) {
    progress = document.createElement("article");
    progress.id = "chat-progress";
    progress.className = "chat-message assistant chat-progress";
    progress.setAttribute("role", "status");
    const label = document.createElement("small");
    label.textContent = "FELTUS";
    const body = document.createElement("div");
    progress.append(label, body);
  }
  progress.lastElementChild.textContent = message;
  $("conversation").append(progress);
  progress.scrollIntoView({ block: "nearest" });
}

function renderChatPreviewCard() {
  const card = $("chat-preview-card");
  if (!card) return;
  const conversation = $("conversation");
  const running = state.preview.status === "running";
  const hasMessages = Boolean(conversation.querySelector(".chat-message:not(#chat-progress)"));
  card.hidden = !running && !hasMessages;
  if (card.hidden) return;
  const frame = $("chat-preview-frame");
  const status = $("chat-preview-status");
  const start = $("chat-start-preview");
  status.textContent = running ? "Your app is running in a safe preview." : "See your app as it comes together.";
  frame.hidden = !running;
  start.hidden = running;
  start.disabled = !state.capabilities.canUseTerminal || state.preview.available === false;
  if (running && (!frame.src || !frame.src.includes("/api/code/preview/frame"))) {
    frame.src = projectQuery("/api/code/preview/frame");
  } else if (!running && frame.hasAttribute("src")) {
    frame.removeAttribute("src");
  }
  conversation.append(card);
}

function renderApplicationResult() {
  const card = $("application-result-card");
  card.hidden = !state.applicationCreated;
  if (card.hidden) return;
  $("application-result-name").textContent = state.appName;
  $("application-result-summary").textContent = state.appliedSummary || state.appDescription || "Your approved app changes are ready.";
  $("application-result-status").textContent = state.preview.status === "running" ? "Preview is running" : "Changes applied";
  $("conversation").append(card);
}

function setAgentState(agent = null) {
  $$('[data-agent]').forEach(item => item.classList.toggle("active", item.dataset.agent === agent));
}

function prepareAppChange() {
  state.aiMode = state.plan ? "Build" : "Plan";
  $$("[data-ai-mode]").forEach(item => item.classList.toggle("active", item.dataset.aiMode === state.aiMode));
  updateAssistantAction();
  switchPane("chat");
  $("prompt").value = `Update ${state.appName}: `;
  $("prompt").focus();
}

function appendMessage(kind, label, content) {
  const conversation = $("conversation");
  $("chat-welcome").hidden = true;
  conversation.querySelector(".empty-card")?.remove();
  $("chat-progress")?.remove();
  const message = document.createElement("article");
  message.className = `chat-message ${kind}`;
  const small = document.createElement("small");
  small.textContent = label;
  const body = document.createElement("div");
  body.textContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  message.append(small, body);
  if (kind === "assistant") {
    const actions = document.createElement("div");
    actions.className = "chat-message-actions";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.textContent = "Open Preview";
    preview.onclick = () => switchPane("preview");
    actions.append(preview);
    if (state.changeSet?.operations?.length) {
      const review = document.createElement("button");
      review.type = "button";
      review.textContent = "Review changes";
      review.onclick = () => switchPane("changes");
      actions.append(review);
    }
    const requestChange = document.createElement("button");
    requestChange.type = "button";
    requestChange.textContent = "Request a change";
    requestChange.onclick = prepareAppChange;
    actions.append(requestChange);
    message.append(actions);
  }
  conversation.append(message);
  renderApplicationResult();
  renderChatPreviewCard();
  message.scrollIntoView({ block: "nearest" });
}

function applyPermissions() {
  const can = state.capabilities;
  $("role-badge").textContent = state.role.charAt(0).toUpperCase() + state.role.slice(1);
  for (const id of ["new-file", "new-folder", "rename-file", "delete-file", "save"]) {
    const element = $(id);
    if (element) element.dataset.permissionDisabled = can.canEditCode ? "false" : "true";
  }
  $("new-file").disabled = !can.canEditCode;
  $("new-folder").disabled = !can.canEditCode;
  $("rename-file").disabled = !can.canEditCode || !state.activePath;
  $("delete-file").disabled = !can.canEditCode || !state.activePath;
  $("replace-code").disabled = !can.canEditCode || !state.activePath || state.files.get(state.activePath)?.editable === false;
  $("send-ai").disabled = !can.canRunAgent;
  $("run-agent").disabled = !can.canRunAgent;
  $("run-task").disabled = !can.canUseTerminal || !state.tasks.length;
  $("start-preview").disabled = !can.canUseTerminal || state.preview.available === false;
  $("chat-start-preview").disabled = !can.canUseTerminal || state.preview.available === false;
  $("apply-all").disabled = !can.canApplyAIChanges;
  $("apply-selected").disabled = !can.canApplyAIChanges;
  $("create-checkpoint").disabled = !can.canEditCode;
  $("design-initialize").disabled = !can.canEditCode || state.designBusy;
  $("design-reconcile").disabled = !can.canEditCode || state.designBusy;
  $("design-undo").disabled = !can.canApplyAIChanges || state.designBusy;
  $("design-ai-propose").disabled = !can.canRunAgent || state.designBusy;
  $("design-apply-property").disabled = !can.canEditCode || state.designBusy || selectedDesignComponent()?.ownership_state !== "FELTUS_MANAGED";
  $("design-select-recipe").disabled = !can.canEditCode || state.designBusy;
  $("design-save-guardrails").disabled = !can.canEditCode || state.designBusy;
  $("prepare-version").disabled = !can.canPrepareVersion || state.versionBusy;
  $("send-testing").disabled = !can.canDeployTesting || state.deploymentBusy || !availableTestingArtifact();
  $("apply-schema").disabled = !can.canManageSchema || state.schemaBusy;
  $("run-release-checks").disabled = !can.canRunAgent || state.productionizationBusy;
  $("propose-normalization").disabled = !can.canRunAgent || state.aiRequest !== null || state.productionizationPlanning || state.productionizationBusy;
  $("evaluate-release-readiness").disabled = !can.canRunAgent || state.releaseReadinessBusy;
  renderEditor();
}

function renderTabs() {
  const tabs = $("file-tabs");
  tabs.replaceChildren();
  for (const [filePath, file] of state.files) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `file-tab${state.activePath === filePath ? " active" : ""}`;
    button.textContent = `${file.dirty ? "● " : ""}${filePath}`;
    button.title = filePath;
    button.onclick = () => openFile(filePath);
    tabs.append(button);
  }
}

function highlightCode(source, filePath = "") {
  let value = escapeHtml(source);
  if (/\.(?:html|xml|svg)$/i.test(filePath)) {
    return value.replace(/(&lt;\/?[A-Za-z][^&]*?&gt;)/g, '<span class="tag">$1</span>');
  }
  value = value
    .replace(/(&quot;[^&\n]*?&quot;|&#39;[^&\n]*?&#39;|`[^`\n]*?`)/g, '<span class="str">$1</span>')
    .replace(/(^|\s)(\/\/[^\n]*|#[^\n]*)/gm, '$1<span class="com">$2</span>')
    .replace(/\b(const|let|var|function|return|async|await|if|else|for|while|class|new|import|export|from|try|catch|throw|true|false|null|undefined|interface|type|extends)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="num">$1</span>');
  return value + (source.endsWith("\n") ? " " : "");
}

function renderLineNumbers() {
  const count = Math.max(1, $("code").value.split("\n").length);
  $("line-numbers").textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
  $("line-numbers").scrollTop = $("code").scrollTop;
  $("code-highlight").scrollTop = $("code").scrollTop;
  $("code-highlight").scrollLeft = $("code").scrollLeft;
}

function renderEditor() {
  const file = state.files.get(state.activePath);
  if (!file) {
    $("active-file").textContent = "No file selected";
    $("code").value = "";
    $("code").disabled = true;
    $("save").disabled = true;
    $("code-highlight").querySelector("code").innerHTML = "";
    $("line-numbers").textContent = "1";
    $("rename-file").disabled = true;
    $("delete-file").disabled = true;
    $("replace-code").disabled = true;
    return;
  }
  $("active-file").textContent = `${state.activePath}${file.dirty ? " · Modified" : ""}${file.redacted ? " · Protected view" : ""}`;
  if ($("code").value !== file.content) $("code").value = file.content;
  const editable = state.capabilities.canEditCode && file.editable;
  $("code").disabled = !editable;
  $("save").disabled = !editable || !file.dirty;
  $("rename-file").disabled = !state.capabilities.canEditCode;
  $("delete-file").disabled = !state.capabilities.canEditCode;
  $("replace-code").disabled = !state.capabilities.canEditCode || !file.editable;
  $("code-highlight").querySelector("code").innerHTML = highlightCode(file.content, state.activePath);
  renderLineNumbers();
}

function updateDirtyState() {
  const file = state.files.get(state.activePath);
  if (!file) return;
  file.content = $("code").value;
  file.dirty = file.content !== file.original;
  $("code-highlight").querySelector("code").innerHTML = highlightCode(file.content, state.activePath);
  renderTabs();
  renderEditor();
}

async function saveFile() {
  const file = state.files.get(state.activePath);
  if (!file || !file.editable || !file.dirty || !state.capabilities.canEditCode) return;
  const result = await api(projectQuery("/api/code/file"), {
    method: "PUT",
    body: JSON.stringify({ app_id: projectId, path: state.activePath, content: file.content, expected_sha256: file.sha256 })
  });
  file.original = file.content;
  file.sha256 = result.sha256;
  file.dirty = false;
  renderTabs();
  renderEditor();
  await refreshGitStatus();
  setStatus(`Saved ${state.activePath}`);
}

async function openFile(filePath) {
  if (state.files.has(filePath)) {
    state.activePath = filePath;
    renderTabs();
    renderEditor();
    switchPane("code");
    updateContextChips();
    return;
  }
  const result = await api(projectQuery(`/api/code/file?path=${encodeURIComponent(filePath)}`));
  state.files.set(filePath, {
    content: result.content || "",
    original: result.content || "",
    sha256: result.sha256,
    redacted: result.redacted === true,
    editable: result.editable !== false,
    dirty: false
  });
  state.activePath = filePath;
  renderTabs();
  renderEditor();
  switchPane("code");
  updateContextChips();
  setStatus(`Opened ${filePath}${result.redacted ? " in protected read-only view" : ""}`);
}

function makeTreeRow(item, depth) {
  const wrapper = document.createElement("div");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-item";
  button.style.paddingLeft = `${7 + depth * 13}px`;
  button.textContent = `${item.type === "directory" ? (state.expanded.has(item.path) ? "▾" : "▸") : "·"} ${item.name}`;
  if (state.gitStatus.includes(item.path)) button.classList.add("changed");
  wrapper.append(button);
  if (item.type === "directory") {
    const children = document.createElement("div");
    button.onclick = async () => {
      if (state.expanded.has(item.path)) {
        state.expanded.delete(item.path);
        children.replaceChildren();
        button.textContent = `▸ ${item.name}`;
      } else {
        state.expanded.add(item.path);
        button.textContent = `▾ ${item.name}`;
        await fillTree(children, item.path, depth + 1);
      }
    };
    wrapper.append(children);
  } else button.onclick = () => openFile(item.path).catch(showError);
  return wrapper;
}

async function fillTree(container, directory = ".", depth = 0) {
  const result = await api(projectQuery(`/api/code/tree?path=${encodeURIComponent(directory)}`));
  container.replaceChildren();
  const items = result.items || [];
  for (const item of items) container.append(makeTreeRow(item, depth));
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "tree-empty";
    empty.textContent = directory === "."
      ? "No files yet. Tell FELTUS AI what you want to build."
      : "This folder is empty.";
    empty.setAttribute("role", "status");
    container.append(empty);
  }
}

async function loadTree() {
  $("tree-path").textContent = ".";
  await fillTree($("tree"), ".", 0);
}

async function refreshGitStatus() {
  try {
    const result = await api(projectQuery("/api/code/git/status"));
    state.gitStatus = result.stdout || "";
    const branchLine = state.gitStatus.split(/\r?\n/)[0] || "";
    const branchName = branchLine.match(/^## No commits yet on (.+)$/)?.[1] || branchLine.match(/^## (.+?)(?:\.\.\..*)?$/)?.[1];
    $("branch").textContent = `Branch: ${branchName || "main"}`;
    $("git-status").textContent = state.gitStatus || "Working tree clean";
  } catch (error) {
    $("branch").textContent = "Git unavailable";
    $("git-status").textContent = error.message;
  }
}

function updateContextChips() {
  const chips = $("context-chips");
  chips.replaceChildren();
  const values = ["Project map", "Git state", "Data model"];
  if (state.activePath) values.unshift(state.activePath);
  if (selectedText()) values.unshift("Selected code");
  if (state.preview.errors?.length) values.push(`${state.preview.errors.length} preview error(s)`);
  for (const value of values) {
    const chip = document.createElement("span");
    chip.textContent = value;
    chips.append(chip);
  }
}

function selectedText() {
  if (!state.activePath) return "";
  return $("code").value.slice($("code").selectionStart, $("code").selectionEnd);
}

function selectedPaths() {
  return state.activePath ? [state.activePath] : [];
}

function openPaths() {
  return [...state.files.keys()].slice(0, 12);
}

async function loadModels() {
  const [modelsResult, healthResult] = await Promise.allSettled([
    api("/api/ai/models"),
    api("/api/ai/runtime/health")
  ]);
  if (modelsResult.status === "rejected") throw modelsResult.reason;
  const health = healthResult.status === "fulfilled" ? healthResult.value : { status: "unavailable" };
  $("ai-runtime-status").className = `state-dot large ${health.status === "healthy" ? "running" : "failed"}`;
  $("ai-runtime-status").title = health.status === "healthy" ? `${health.provider} · ${health.model_count} models · ${health.latency_ms} ms` : "AI runtime unavailable";
  $("model").replaceChildren();
  for (const model of modelsResult.value.models || []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = `${model.name} · ${model.provider || "FELTUS"}`;
    if (model.default) option.selected = true;
    $("model").append(option);
  }
}

function renderTasks(catalog) {
  state.tasks = catalog.tasks || [];
  state.unavailableTasks = catalog.unavailable || [];
  $("agent-task").replaceChildren();
  for (const task of state.tasks) {
    const option = document.createElement("option");
    option.value = task;
    option.textContent = task;
    $("agent-task").append(option);
  }
  for (const unavailable of state.unavailableTasks) {
    const option = document.createElement("option");
    option.value = unavailable.task;
    option.textContent = `${unavailable.task} — ${unavailable.reason}`;
    option.disabled = true;
    $("agent-task").append(option);
  }
  if (state.tasks.includes(catalog.default_task)) $("agent-task").value = catalog.default_task;
  $$('[data-task]').forEach(button => {
    const unavailable = state.unavailableTasks.find(item => item.task === button.dataset.task);
    button.disabled = !state.capabilities.canUseTerminal || Boolean(unavailable) || !state.tasks.includes(button.dataset.task);
    if (unavailable) button.title = unavailable.reason;
  });
}

function renderConversationFromActivity() {
  const actions = state.context?.recent_activity || [];
  if (!actions.length) return;
  const conversation = $("conversation");
  const resultCard = $("application-result-card");
  const previewCard = $("chat-preview-card");
  conversation.replaceChildren();
  if (resultCard) conversation.append(resultCard);
  if (previewCard) conversation.append(previewCard);
  for (const action of [...actions].reverse().slice(-12)) {
    if (!action.summary) continue;
    appendMessage(action.action_type?.startsWith("ai.") ? "assistant" : "system", action.action_type || "Activity", action.summary);
  }
}

function renderPlan(plan) {
  state.plan = plan;
  $("plan-card").hidden = !plan;
  $("plan-steps").replaceChildren();
  $("plan-files").replaceChildren();
  updateAssistantAction();
  if (!plan) {
    renderSchemaProposal();
    return;
  }
  $("plan-title").textContent = plan.title || "Implementation plan";
  $("plan-summary").textContent = plan.summary || "Review the steps before FELTUS changes files.";
  for (const step of plan.steps || []) {
    const item = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = step.title;
    const small = document.createElement("small");
    small.textContent = `${String(step.agent || "code-agent").replaceAll("-", " ")} · ${step.details || "Planned"}`;
    item.append(strong, small);
    $("plan-steps").append(item);
  }
  for (const file of plan.files || []) {
    const path = typeof file === "string" ? file : file?.path || file?.name;
    if (!path) continue;
    const item = document.createElement("span");
    item.textContent = path;
    $("plan-files").append(item);
  }
  renderSchemaProposal();
}

function renderSchemaProposal() {
  const models = Array.isArray(state.plan?.data_models) ? state.plan.data_models.filter(item => item && typeof item === "object") : [];
  const relationships = Array.isArray(state.plan?.relationships) ? state.plan.relationships.filter(item => item && typeof item === "object") : [];
  $("schema-proposal").hidden = !models.length && !relationships.length;
  $("schema-proposal-content").replaceChildren();
  for (const model of models) {
    const article = document.createElement("article");
    article.className = "schema-card";
    article.innerHTML = `<h3>${escapeHtml(model.name || model.logical_name || "New information category")}</h3><p>${escapeHtml(model.description || "Proposed by App Architect")}</p>`;
    $("schema-proposal-content").append(article);
  }
  for (const relationship of relationships) {
    const article = document.createElement("article");
    article.className = "schema-card";
    article.innerHTML = `<h3>${escapeHtml(relationship.source || relationship.source_model || "Source")} → ${escapeHtml(relationship.target || relationship.target_model || "Target")}</h3><p>${escapeHtml(relationship.description || "Proposed relationship")}</p>`;
    $("schema-proposal-content").append(article);
  }
  applyPermissions();
}

function changePath(operation) {
  return operation.type === "rename" ? `${operation.from} → ${operation.to}` : operation.path;
}

function renderChangeSet(changeSet) {
  state.changeSet = changeSet;
  state.selectedChangeIds = new Set((changeSet?.operations || []).map(operation => operation.id));
  const count = changeSet?.operations?.length || 0;
  $("change-count").hidden = !count;
  $("change-count").textContent = count;
  $("changes-empty").hidden = Boolean(count);
  $("changes-review").hidden = !count;
  $("change-files").replaceChildren();
  if (!count) return;
  const protectedChanges = changeSet.contract_review?.blocked_operations || changeSet.productionization?.contract_review?.blocked_operations || [];
  const protectedPaths = [...new Set(protectedChanges.map(item => item.path))];
  const reviewRequired = changeSet.contract_review?.review_required_operations || changeSet.productionization?.contract_review?.review_required_operations || [];
  $("changes-summary").textContent = `FELTUS proposed ${count} file change${count === 1 ? "" : "s"} · ${changeSet.summary || "Review before applying"}${reviewRequired.length ? ` · ${reviewRequired.length} medium-risk change(s) require explicit review` : ""}${protectedPaths.length ? ` · Protected paths excluded: ${protectedPaths.join(", ")}` : ""}`;
  for (const operation of changeSet.operations) {
    const details = document.createElement("details");
    details.className = "change-card";
    const summary = document.createElement("summary");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.setAttribute("aria-label", `Select ${changePath(operation)}`);
    checkbox.onclick = event => event.stopPropagation();
    checkbox.onchange = () => checkbox.checked ? state.selectedChangeIds.add(operation.id) : state.selectedChangeIds.delete(operation.id);
    const type = document.createElement("span");
    type.className = `operation-type ${operation.type}`;
    type.textContent = ({ create: "+", update: "~", rename: "→", delete: "−" })[operation.type];
    const name = document.createElement("strong");
    name.textContent = changePath(operation);
    const agent = document.createElement("small");
    agent.textContent = `${String(operation.agent || "code-agent").replaceAll("-", " ")} · ${operation.reason || "Project change"}`;
    summary.append(checkbox, type, name, agent);
    const diff = document.createElement("pre");
    const before = operation.before_content ?? state.files.get(operation.path || operation.from)?.original ?? "";
    diff.textContent = operation.type === "create"
      ? `+++ ${operation.path}\n${operation.content}`
      : operation.type === "delete"
        ? `--- ${operation.path}\n${before}`
        : operation.type === "rename"
          ? `rename ${operation.from}\n   to ${operation.to}`
          : `--- current/${operation.path}\n${before}\n\n+++ proposed/${operation.path}\n${operation.content}`;
    details.append(summary, diff);
    $("change-files").append(details);
  }
  applyPermissions();
  switchPane("changes");
}

function requestBody(prompt) {
  return {
    app_id: projectId,
    prompt,
    model: $("model").value,
    paths: selectedPaths(),
    open_paths: openPaths(),
    selected_text: selectedText(),
    task_state: state.taskResult || null
  };
}

function beginAI(agent) {
  if (state.aiRequest) return null;
  const controller = new AbortController();
  state.aiRequest = controller;
  $("cancel-ai").hidden = false;
  $("send-ai").disabled = true;
  $("run-agent").disabled = true;
  setAssistantError();
  setAgentState(agent);
  return controller;
}

function finishAI(controller) {
  if (state.aiRequest === controller) state.aiRequest = null;
  $("chat-progress")?.remove();
  $("cancel-ai").hidden = true;
  setAgentState(null);
  applyPermissions();
}

async function requestArchitectPlan(prompt) {
  const controller = beginAI("app-architect");
  if (!controller) return;
  appendMessage("user", "You", prompt);
  setChatProgress("Understanding your idea and organizing the first steps…");
  setStatus("FELTUS is organizing your idea…");
  try {
    const result = await api(projectQuery("/api/code/ai/architect"), {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify(requestBody(prompt))
    });
    renderPlan(result.result);
    appendMessage("assistant", "App Architect", result.result.summary || result.result.title);
    setStatus("Plan ready for review.");
    switchPane("chat");
  } finally {
    finishAI(controller);
  }
}

async function streamFileAction(mode, prompt) {
  if (!state.activePath) throw new Error(`Open a file before using ${mode}.`);
  const controller = beginAI("code-agent");
  if (!controller) return;
  appendMessage("user", "You", `${mode}: ${prompt}`);
  setChatProgress(`Reading the relevant app details to ${mode.toLowerCase()}…`);
  try {
    const response = await fetch(projectQuery("/api/code/ai/plan/stream"), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" },
      body: JSON.stringify({ ...requestBody(`${mode}: ${prompt}`), mode: mode.toLowerCase() })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || `Request failed (${response.status}).`), { code: data.code });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.error) throw Object.assign(new Error(event.error.message), { code: event.error.code });
        if (event.delta) content += event.delta;
      }
      if (done) break;
    }
    appendMessage("assistant", `Code Agent · ${mode}`, content || "No response content was returned.");
    setStatus(`${mode} complete.`);
    switchPane("chat");
  } finally {
    finishAI(controller);
  }
}

async function requestChangeSet(prompt, mode = "build") {
  const controller = beginAI(mode === "fix" ? "code-agent" : "project-agent");
  if (!controller) return;
  appendMessage("user", "You", prompt);
  setChatProgress("Preparing app changes for your review…");
  setStatus("Preparing app changes for your review…");
  try {
    const result = await api(projectQuery("/api/code/ai/change-set"), {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ ...requestBody(prompt), plan: state.plan, mode })
    });
    const reviewed = await api(projectQuery("/api/code/change-set/review"), {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ app_id: projectId, change_set: result.result })
    });
    renderChangeSet(reviewed.result);
    appendMessage("assistant", mode === "fix" ? "Code Agent" : "Project Agent", `${result.result.summary}\n${result.result.operations.length} file change(s) ready for review.`);
    setStatus("Change set ready. Review it before applying.");
    await refreshStudioActivity();
  } finally {
    finishAI(controller);
  }
}

async function runStudioAgent(promptOverride = null) {
  const prompt = String(promptOverride ?? $("prompt").value).trim();
  if (!prompt) throw new Error("Describe what you want FELTUS to build.");
  if (!window.confirm("Run the four-agent workflow and validate its proposed changes? No files will be applied until you review them.")) return;
  const controller = beginAI("app-architect");
  if (!controller) return;
  appendMessage("user", "You", prompt);
  setChatProgress("Building your app and checking the proposed changes…");
  setStatus("Building your app and checking the proposed changes…");
  try {
    const result = await api(projectQuery("/api/code/ai/studio-agent"), {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ ...requestBody(prompt), plan: state.plan, task: $("agent-task").value, repair_limit: 2 })
    });
    renderPlan(result.result.plan);
    const reviewed = await api(projectQuery("/api/code/change-set/review"), {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ app_id: projectId, change_set: result.result.changeSet })
    });
    renderChangeSet(reviewed.result);
    const validation = result.result.validation;
    state.taskResult = validation;
    showTaskOutput(validation, validation?.skipped ? "Unavailable" : validation?.code === 0 ? "Passed" : "Failed");
    appendMessage("assistant", "Studio agents", result.result.blocker || `${result.result.changeSet.summary}\nValidation ${validation?.code === 0 ? "passed" : validation?.skipped ? "was unavailable" : "failed"}. Review the proposed files.`);
    setStatus(result.result.blocker || "Agent work is ready for review.", Boolean(result.result.blocker));
    await refreshStudioActivity();
  } finally {
    finishAI(controller);
  }
}

async function handleAI() {
  const prompt = $("prompt").value.trim();
  if (!prompt) throw new Error("Describe what you want FELTUS to do.");
  if (state.aiMode === "Plan" || (state.aiMode === "Build" && !state.plan)) return requestArchitectPlan(prompt);
  if (["Explain", "Review"].includes(state.aiMode)) return streamFileAction(state.aiMode, prompt);
  if (state.aiMode === "Test") {
    switchPane("terminal");
    return runTask($("agent-task").value);
  }
  return requestChangeSet(prompt, state.aiMode === "Fix" ? "fix" : state.aiMode.toLowerCase());
}

async function applyChanges(selectedOnly) {
  if (!state.changeSet) return;
  if (state.lastAppliedProductionizationRunId && !state.changeSet.productionization) {
    throw new Error("Checkpoint or undo the validated productionization before applying another change set.");
  }
  const selectedIds = selectedOnly ? [...state.selectedChangeIds] : state.changeSet.operations.map(operation => operation.id);
  if (!selectedIds.length) throw new Error("Select at least one file change.");
  const selectedOperations = state.changeSet.operations.filter(operation => selectedIds.includes(operation.id));
  const destructive = selectedOperations.some(operation => operation.type === "delete");
  const contractChanges = (state.changeSet.contract_review?.blocked_operations || state.changeSet.productionization?.contract_review?.blocked_operations || [])
    .filter(item => selectedIds.includes(item.operation_id));
  const contractPaths = [...new Set(contractChanges.map(item => item.path))].sort();
  if (contractChanges.length && state.changeSet.productionization) throw new Error("Automatic productionization is blocked from changing protected contracts. Use a separately authorized, versioned migration or compatibility workflow.");
  if (contractChanges.length && !state.isAppOwner) throw new Error("Only the application owner can approve changes to protected contracts.");
  const impact = contractChanges.map(item => `${item.path}: ${item.affected_contracts?.map(contract => `${contract.kind} ${contract.value}`).join(", ") || item.reason}`).join("\n");
  const productionization = state.changeSet.productionization || null;
  const productionizationRunId = productionization?.run_id || null;
  if (productionization) {
    const validation = productionization.release_readiness;
    if (!validation || validation.status !== "VALIDATED_FOR_REVIEW" || validation.checks?.some(check => check.blocking)) {
      throw new Error("Productionization changes can be applied only after isolated validation passes.");
    }
    if (selectedIds.length !== state.changeSet.operations.length) {
      throw new Error("Apply the complete validated productionization plan together, or prepare and validate a new plan for the selected files.");
    }
  }
  const mediumReview = state.changeSet.contract_review?.review_required_operations || productionization?.contract_review?.review_required_operations || [];
  const mediumPaths = [...new Set(mediumReview.filter(item => selectedIds.includes(item.operation_id)).map(item => item.path))].sort();
  const wording = contractChanges.length
    ? `Owner approval required for protected contract changes. Review the exact diff and potential compatibility, migration, and rollback impact before continuing.\n\n${impact}\n\nApprove these exact paths?`
    : productionization && mediumPaths.length
      ? `Review the complete diff and approve these medium-risk files before applying:\n\n${mediumPaths.join("\n")}\n\nApply the validated productionization plan?`
      : destructive ? "This selection deletes a file. Apply the selected changes?" : `Apply ${selectedOperations.length} reviewed file change(s)?`;
  if (!window.confirm(wording)) return;
  const result = await api(projectQuery("/api/code/change-set/apply"), {
    method: "POST",
    body: JSON.stringify({
      app_id: projectId,
      change_set: state.changeSet,
      selected_ids: selectedIds,
      confirm_destructive: destructive,
      ...(productionization && mediumPaths.length ? { confirm_review_required: true, reviewed_medium_paths: mediumPaths } : {}),
      ...(contractChanges.length ? { approve_contract_changes: true, contract_approval_paths: contractPaths } : {})
    })
  });
  if (productionizationRunId) {
    state.productionizationRunId = productionizationRunId;
    state.lastAppliedProductionizationRunId = productionizationRunId;
  } else {
    state.lastAppliedProductionizationRunId = null;
  }
  state.undo = { token: result.result.undo_token, summary: result.result.summary };
  state.applicationCreated = true;
  state.appliedSummary = result.result.summary || state.changeSet.summary || "";
  state.lastAppliedPaths = result.result.applied.flatMap(operation => operation.type === "rename" ? [operation.from, operation.to] : [operation.path]);
  $("undo-section").hidden = false;
  $("undo-description").textContent = result.result.summary;
  for (const operation of selectedOperations) {
    state.files.delete(operation.path || operation.from);
    if (operation.to) state.files.delete(operation.to);
  }
  state.activePath = null;
  state.changeSet = null;
  renderChangeSet(null);
  renderTabs();
  renderEditor();
  const taskCatalogPromise = api(projectQuery("/api/code/tasks"));
  await Promise.all([loadTree(), refreshGitStatus(), loadCheckpoints(), refreshStudioActivity(), loadProductionization(), loadReleaseReadiness(), loadPreviewStatus()]);
  renderTasks(await taskCatalogPromise);
  const firstAppliedPath = state.lastAppliedPaths.find(path => !selectedOperations.some(operation => operation.type === "delete" && operation.path === path));
  if (firstAppliedPath) await openFile(firstAppliedPath).catch(() => {});
  if (state.preview.status === "running") await restartPreview();
  renderApplicationResult();
  setStatus(`${result.result.applied.length} reviewed change(s) applied. Undo remains available until those files change again.`);
  switchPane("chat");
  appendMessage("assistant", "FELTUS", `${result.result.summary} was applied by you.`);
  if (productionizationRunId) {
    const checkpointed = await createCheckpoint({ messageOverride: `Productionization: ${result.result.summary}` });
    if (!checkpointed) setStatus("Productionization is applied and validated. Create its CODE checkpoint to complete the handoff.", true);
  }
}

async function rejectChanges() {
  if (!state.changeSet || !window.confirm("Reject this proposed change set? No project files will change.")) return;
  await api(projectQuery("/api/code/change-set/reject"), {
    method: "POST",
    body: JSON.stringify({ app_id: projectId, change_set_id: state.changeSet.id, summary: state.changeSet.summary })
  });
  state.changeSet = null;
  renderChangeSet(null);
  switchPane("chat");
  setStatus("Proposed changes rejected. Project files were not changed.");
  appendMessage("assistant", "FELTUS", "Those proposed changes were rejected. Your app files were not changed.");
  await refreshStudioActivity();
}

async function undoChanges() {
  if (!state.undo || !window.confirm("Undo the last applied change set? FELTUS will stop if any affected file changed afterward.")) return;
  const result = await api(projectQuery("/api/code/change-set/undo"), {
    method: "POST",
    body: JSON.stringify({ app_id: projectId, undo_token: state.undo.token, confirm: true })
  });
  state.undo = null;
  state.lastAppliedProductionizationRunId = null;
  state.files.clear();
  state.activePath = null;
  $("undo-section").hidden = true;
  renderTabs();
  renderEditor();
  await Promise.all([loadTree(), refreshGitStatus(), refreshStudioActivity()]);
  if (state.preview.status === "running") await restartPreview();
  setStatus(`Undid ${result.result.summary}.`);
}

function showTaskOutput(result, label) {
  $("output-title").textContent = result?.task || "Project task";
  $("task-result").textContent = label;
  $("task-result").style.color = label === "Passed" ? "var(--green)" : label === "Failed" ? "var(--danger)" : "";
  $("output").textContent = result?.skipped
    ? result.reason
    : [`$ ${result?.task || "task"}`, result?.stdout || "", result?.stderr || "", `Exit code: ${result?.code ?? "not available"}`].filter(Boolean).join("\n");
}

async function runTask(taskName) {
  if (state.taskRequest) return;
  if (!state.tasks.includes(taskName)) {
    const unavailable = state.unavailableTasks.find(item => item.task === taskName);
    throw new Error(unavailable?.reason || "This task is unavailable for the current project.");
  }
  const controller = new AbortController();
  state.taskRequest = controller;
  $("cancel-task").hidden = false;
  $("run-task").disabled = true;
  switchPane("terminal");
  $("output-title").textContent = taskName;
  $("task-result").textContent = "Running";
  $("output").textContent = `$ ${taskName}\nRunning…`;
  setStatus(`Running ${taskName}…`);
  try {
    const result = await api(projectQuery("/api/code/task"), {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ app_id: projectId, task: taskName })
    });
    state.taskResult = result.result;
    showTaskOutput(result.result, result.result.code === 0 ? "Passed" : "Failed");
    setStatus(`${taskName} ${result.result.code === 0 ? "passed" : "failed"}.`, result.result.code !== 0);
    await refreshStudioActivity();
  } finally {
    if (state.taskRequest === controller) state.taskRequest = null;
    $("cancel-task").hidden = true;
    applyPermissions();
  }
}

function renderPreview() {
  const running = state.preview.status === "running";
  const available = state.preview.available !== false;
  $("preview-dot").className = `state-dot ${running ? "running" : state.preview.status === "failed" ? "failed" : ""}`;
  $("preview-status").textContent = running ? `Running · npm run ${state.preview.script}` : state.preview.status === "failed" ? "Startup failed" : !available ? "Preview unavailable" : "Not running";
  $("preview-empty").hidden = running;
  $("preview-frame").hidden = !running;
  const frame = $("preview-frame");
  const wasRunning = frame.dataset.previewRunning === "true";
  if (running && (!wasRunning || !frame.src || !frame.src.includes("/api/code/preview/frame"))) {
    frame.src = `${projectQuery("/api/code/preview/frame")}&refresh=${Date.now()}`;
  } else if (!running && wasRunning) {
    frame.removeAttribute("src");
  }
  frame.dataset.previewRunning = String(running);
  $("start-preview").hidden = running;
  $("start-preview").disabled = !available || !state.capabilities.canUseTerminal;
  const previewMessage = $("preview-empty").querySelector("p");
  if (previewMessage) previewMessage.textContent = state.preview.reason || "Start Preview to run this project’s isolated development script.";
  $("reload-preview").disabled = !running || !state.capabilities.canUseTerminal;
  $("refresh-preview").disabled = !running;
  $("open-preview").disabled = !running;
  $("stop-preview").disabled = !running || !state.capabilities.canUseTerminal;
  const errors = state.preview.errors || [];
  $("preview-errors").replaceChildren();
  if (!errors.length) {
    const empty = document.createElement("p");
    empty.textContent = "No preview errors recorded.";
    $("preview-errors").append(empty);
  } else {
    for (const error of [...errors].reverse()) {
      const item = document.createElement("div");
      item.className = "error-item";
      item.textContent = `${error.type}: ${error.message}${error.source ? `\n${error.source}` : ""}`;
      $("preview-errors").append(item);
    }
  }
  $("fix-preview-errors").disabled = !errors.length || !state.capabilities.canRunAgent;
  updateContextChips();
  renderDesignPreview();
  renderApplicationResult();
  renderChatPreviewCard();
}

const DESIGN_PROPERTY_VALUES = {
  alignment: ["start", "center", "end", "stretch"],
  layout: ["stack", "row", "grid", "split", "overlay"],
  width: ["full", "wide", "medium", "narrow", "auto"],
  padding: ["0px", "8px", "12px", "16px", "20px", "24px", "32px", "40px", "48px", "64px"],
  gap: ["0px", "8px", "12px", "16px", "20px", "24px", "32px", "40px", "48px"],
  radius: ["small", "medium", "large", "pill"],
  shadow: ["none", "small", "medium", "large"],
  font_size: ["12px", "14px", "16px", "20px", "24px", "32px", "40px", "48px", "64px"],
  visible: ["true", "false"]
};
const DESIGN_COMPONENT_VARIANTS = {
  page: ["default", "wide", "reading"], section: ["default", "compact", "spacious"], hero: ["split", "centered", "stacked", "compact"],
  header: ["default", "compact", "centered"], navigation: ["horizontal", "centered", "compact", "sidebar"], sidebar: ["default", "compact", "rail"],
  card: ["elevated", "outlined", "flat", "compact"], form: ["stacked", "inline", "compact"], table: ["comfortable", "compact", "striped"],
  button: ["primary", "secondary", "outline", "quiet"], media: ["wide", "contained", "cover"], "dashboard-region": ["grid", "wide", "compact"],
  modal: ["default", "compact", "wide"], footer: ["default", "compact", "columns"]
};

function designState() { return state.design?.design_state || null; }
function selectedDesignComponent() { return designState()?.components?.find(item => item.id === state.designComponentId) || null; }

async function loadDesign() {
  if (!projectId || state.designLoading) return;
  state.designLoading = true;
  try {
    let result = await api(projectQuery("/api/code/design"));
    const decisions = result.reconciliation || [];
    const automaticallyReconciled = result.initialized && decisions.length > 0 && decisions.every(item => ["AUTOMATIC_RECONCILIATION", "DEVELOPER_VERSION_PRESERVED"].includes(item.outcome));
    if (automaticallyReconciled) {
      const saved = await api(projectQuery("/api/code/design/reconcile"), { method: "POST", body: JSON.stringify({ app_id: projectId }) });
      result = { ...result, ...saved, initialized: true, recipes: result.recipes, recommendations: result.recommendations, reconciliation: saved.reconciliation || decisions };
    }
    state.design = result;
    state.designLoaded = true;
    if (!state.designComponentId || !result.design_state?.components?.some(item => item.id === state.designComponentId)) {
      state.designComponentId = result.design_state?.components?.[0]?.id || "";
    }
    state.designPageId = result.design_state?.components?.find(item => item.id === state.designComponentId)?.page_id || result.design_state?.pages?.[0]?.id || "";
    renderDesign();
  } finally {
    state.designLoading = false;
  }
}

function renderDesign() {
  const result = state.design;
  const initialized = Boolean(result?.initialized);
  $("design-empty").hidden = initialized;
  $("design-content").hidden = !initialized;
  $("design-initialize").disabled = !state.capabilities.canEditCode || state.designBusy;
  if (!initialized) return;
  const value = designState();
  if (!value) return;
  const counts = result.sync_summary || { synchronized: 0, developer_managed: 0, reconciliation_required: 0, reconciliation_available: 0 };
  $("design-profile-name").textContent = value.profile?.name || "Custom Design Profile";
  const top = result.recommendations?.[0];
  const topRecipe = result.recipes?.find(recipe => recipe.id === top?.recipe_id);
  $("design-recommendation-note").textContent = topRecipe
    ? `${top.recommendation} starting point: ${topRecipe.name}${top.confidence === "low" ? " · low confidence, suggestion only" : ""}`
    : "Browse the full Design Recipe catalog. Recommendations do not alter application classification.";
  $("design-sync-summary").replaceChildren();
  for (const [number, label] of [
    [counts.synchronized || 0, "synchronized"],
    [counts.developer_managed || 0, "developer managed"],
    [(counts.reconciliation_required || 0) + (counts.stylesheet_reconciliation_required || 0), "needs review"],
    [counts.reconciliation_available || 0, "reconnect available"]
  ]) {
    const card = document.createElement("div");
    card.className = "design-metric";
    const strong = document.createElement("strong"); strong.textContent = String(number);
    const small = document.createElement("small"); small.textContent = label;
    card.append(strong, small); $("design-sync-summary").append(card);
  }
  const identity = result.source_identity || value.sync || {};
  $("design-source-status").textContent = result.source_clean === false
    ? "Source has uncheckpointed edits. Preserve and checkpoint them in FELTUS CODE before proposing a visual change."
    : `Bound to ${identity.branch || value.sync?.source_branch || "branch unavailable"} · ${String(identity.checkpoint || value.sync?.source_checkpoint || "no checkpoint").slice(0, 12)} · ${identity.classifier_version || value.sync?.classifier_version || "classifier unavailable"}.`;
  $("design-recipe-count").textContent = `${result.recipes?.length || 0} recipes`;
  const recipe = $("design-recipe");
  if (!recipe.options.length || recipe.dataset.designHash !== result.design_state_hash) {
    recipe.replaceChildren();
    const recommendById = new Map((result.recommendations || []).map(item => [item.recipe_id, item]));
    for (const item of result.recipes || []) {
      const option = document.createElement("option"); option.value = item.id;
      const rec = recommendById.get(item.id);
      option.textContent = `${item.name} · ${item.family}${rec?.recommendation === "Recommended" ? " · Recommended" : ""}`;
      recipe.append(option);
    }
    recipe.dataset.designHash = result.design_state_hash || "";
  }
  recipe.value = value.active_recipe_id;
  $("design-recommendations").replaceChildren();
  for (const recommendation of (result.recommendations || []).slice(0, 4)) {
    const item = result.recipes?.find(recipeItem => recipeItem.id === recommendation.recipe_id);
    if (!item) continue;
    const button = document.createElement("button"); button.type = "button"; button.className = "design-recommendation";
    const label = document.createElement("span"); label.textContent = item.name;
    const note = document.createElement("small"); note.textContent = `${recommendation.recommendation} · ${recommendation.confidence} confidence`;
    button.append(label, note); button.onclick = () => { recipe.value = item.id; selectDesignRecipe().catch(showError); };
    $("design-recommendations").append(button);
  }
  const pages = $("design-page"); pages.replaceChildren();
  for (const page of value.pages || []) {
    const option = document.createElement("option"); option.value = page.id; option.textContent = `${page.title || page.id} · ${page.path || "/"}`; pages.append(option);
  }
  if (!value.pages?.some(page => page.id === state.designPageId)) state.designPageId = value.pages?.[0]?.id || "";
  pages.value = state.designPageId;
  const components = $("design-component");
  components.replaceChildren();
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose a component"; components.append(placeholder);
  for (const component of (value.components || []).filter(item => !state.designPageId || item.page_id === state.designPageId)) {
    const option = document.createElement("option"); option.value = component.id;
    option.textContent = `${component.name} · ${component.type} · ${component.ownership_state === "FELTUS_MANAGED" ? "FELTUS Managed" : "Developer Managed"}`;
    components.append(option);
  }
  components.value = state.designComponentId;
  $("design-sync-details").replaceChildren();
  for (const component of value.components || []) {
    const card = document.createElement("div"); card.className = "design-component-sync";
    const title = document.createElement("strong"); title.textContent = `${component.name} · ${component.type}`;
    const details = document.createElement("small"); details.textContent = `${component.ownership_state.replaceAll("_", " ")} · ${component.reconciliation_state.replaceAll("_", " ")} · ${component.sync_state.replaceAll("_", " ")}`;
    card.append(title, details); $("design-sync-details").append(card);
  }
  $("design-reconciliation-evidence").replaceChildren();
  for (const item of result.reconciliation || []) {
    const evidence = document.createElement("div"); evidence.className = "design-evidence";
    evidence.textContent = `${item.component_id || "Application stylesheet"}: ${item.outcome}${item.transition ? ` · ${item.transition}` : ""} · ${item.reason}`;
    $("design-reconciliation-evidence").append(evidence);
  }
  $("design-reconcile").disabled = !state.capabilities.canEditCode || state.designBusy || !result.source_identity;
  $("design-undo-card").hidden = !result.undo_available;
  const guardrails = value.brand_guardrails || {};
  $("design-allowed-colors").value = (guardrails.allowed_colors || []).join(", ");
  $("design-prohibited-colors").value = (guardrails.prohibited_colors || []).join(", ");
  $("design-logo-assets").value = (guardrails.allowed_logos || []).join(", ");
  renderDesignSelection();
  renderDesignPreview();
  renderDesignProposal();
}

function renderDesignSelection() {
  const component = selectedDesignComponent();
  const managed = component?.ownership_state === "FELTUS_MANAGED";
  $("design-owner-state").textContent = component ? `${component.ownership_state.replaceAll("_", " ")} · ${component.sync_state.replaceAll("_", " ")}` : "No component selected";
  $("design-toggle-ownership").textContent = managed ? "Detach from Design Studio" : "Reconnect visual editing";
  $("design-toggle-ownership").disabled = !component || !state.capabilities.canEditCode || state.designBusy;
  $("design-apply-property").disabled = !managed || !state.capabilities.canEditCode || state.designBusy;
  $("design-ai-propose").disabled = !state.capabilities.canRunAgent || state.designBusy || Boolean(component && !managed);
  $("design-ai-scope").textContent = component && !managed
    ? `${component.name} is Developer Managed. Reconnect visual editing before applying an AI design proposal.`
    : component
    ? `AI will target ${component.name} (${component.id}) on ${state.designViewport} unless you explicitly ask for broader changes.`
    : "AI will use the selected page or the application design context. Select a component to narrow the scope.";
  const property = $("design-property").value;
  const datalist = $("design-value-options"); datalist.replaceChildren();
  let values = DESIGN_PROPERTY_VALUES[property] || [];
  if (["background", "color"].includes(property)) values = ["surface", "background", "primary", "secondary", "accent", "text", "muted", "transparent", ...Object.values(designState()?.tokens?.colors || {})];
  if (property === "variant" && component) values = DESIGN_COMPONENT_VARIANTS[component.type] || [];
  if (property === "content") $("design-value").value = component?.content || "";
  else if (component && property in (component.responsive?.[state.designViewport] || {})) $("design-value").value = String(component.responsive[state.designViewport][property]);
  else if (component && property in (component.properties || {})) $("design-value").value = String(component.properties[property]);
  else if (property === "variant") $("design-value").value = component?.variant || "";
  else if (["background", "color"].includes(property)) $("design-value").value = component?.properties?.[property] || (property === "background" ? "surface" : "text");
  else if (values.length) $("design-value").value = values[0];
  for (const value of values) { const option = document.createElement("option"); option.value = value; datalist.append(option); }
  $("design-value").disabled = !managed || !component || property === "content" && component.content === null;
  $("design-apply-property").disabled = !managed || !component || !state.capabilities.canEditCode || state.designBusy || property === "content" && component.content === null;
  $("design-toggle-ownership").disabled = !component || !state.capabilities.canEditCode || state.designBusy;
}

function renderDesignPreview() {
  if (!$("design-preview-frame")) return;
  const frame = $("design-preview-frame");
  const running = state.preview.status === "running";
  frame.hidden = !running;
  $("design-preview-empty").hidden = running;
  $("design-start-preview").disabled = !state.capabilities.canUseTerminal || state.preview.available === false || state.designBusy;
  $("design-refresh-preview").disabled = !running;
  const widths = { desktop: "100%", tablet: "768px", mobile: "390px" };
  frame.style.width = widths[state.designViewport] || "100%";
  const wasDesignRunning = frame.dataset.previewRunning === "true";

  if (running && (!wasDesignRunning || !frame.src || !frame.src.includes("/api/code/preview/frame"))) {

    frame.src = `${projectQuery("/api/code/preview/frame")}&refresh=${Date.now()}`;

  } else if (!running && wasDesignRunning) {

    frame.removeAttribute("src");

  }

  frame.dataset.previewRunning = String(running);
}

function wireDesignPreviewFrame() {
  const frame = $("design-preview-frame");
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    let overlay = doc.getElementById("feltus-design-selection-style");
    if (!overlay) { overlay = doc.createElement("style"); overlay.id = "feltus-design-selection-style"; doc.head?.append(overlay); }
    overlay.textContent = "[data-feltus-id]:hover { outline: 2px dashed #7467dd !important; outline-offset: 2px !important; cursor: pointer; }";
    if (!doc.documentElement.dataset.feltusDesignCanvasBound) {
      doc.documentElement.dataset.feltusDesignCanvasBound = "true";
      doc.addEventListener("click", event => {
        const node = event.target?.closest?.("[data-feltus-id]");
        if (!node) return;
        const id = node.getAttribute("data-feltus-id");
        if (designState()?.components?.some(item => item.id === id)) {
          state.designComponentId = id; state.designPageId = node.getAttribute("data-feltus-page") || designState()?.components?.find(item => item.id === id)?.page_id || state.designPageId; $("design-page").value = state.designPageId; $("design-component").value = id; renderDesignSelection();
          $("design-canvas-help").textContent = `Selected ${id}. Component properties are scoped to this identity.`;
        } else $("design-canvas-help").textContent = `Component ${id} is not registered in this Design State. Registering new structure is not available through this visual contract.`;
      }, true);
    }
    if (state.designProposal?.proposal?.preview_css) {
      let draft = doc.getElementById("feltus-design-draft");
      if (!draft) { draft = doc.createElement("style"); draft.id = "feltus-design-draft"; doc.head?.append(draft); }
      draft.textContent = state.designProposal.proposal.preview_css;
      state.designDraftVisible = true;
      for (const component of state.designProposal.proposal.after_state?.components || []) {
        const node = doc.querySelector(`[data-feltus-id="${component.id}"]`);
        if (!node) continue;
        node.setAttribute("data-feltus-variant", component.variant);
        if (component.content !== null && component.content !== undefined && !node.children.length) node.textContent = component.content;
      }
    } else {
      doc.getElementById("feltus-design-draft")?.remove();
      if (state.designDraftVisible) { state.designDraftVisible = false; refreshDesignPreview(); }
    }
  } catch {
    $("design-canvas-help").textContent = "This app's Preview does not allow Canvas selection. Use the managed component list; visual changes still apply through FELTUS CODE.";
  }
}

function renderDesignProposal() {
  const proposal = state.designProposal?.proposal;
  const card = $("design-proposal-card");
  card.hidden = !proposal;
  if (!proposal) { wireDesignPreviewFrame(); return; }
  $("design-proposal-summary").textContent = proposal.summary;
  $("design-proposal-paths").replaceChildren();
  for (const operation of proposal.operations || []) {
    const chip = document.createElement("span"); chip.className = "design-path-chip"; chip.textContent = `${operation.type} · ${operation.path}`;
    $("design-proposal-paths").append(chip);
  }
  $("design-contract-review").replaceChildren();
  if (state.designReview?.contract_review) {
    const review = state.designReview.contract_review;
    const status = document.createElement("p");
    status.textContent = `${review.safe_operations?.length || 0} safe · ${review.review_required_operations?.length || 0} medium risk requiring your review · ${review.blocked_operations?.length || 0} blocked.`;
    $("design-contract-review").append(status);
    for (const item of review.review_required_operations || []) {
      const evidence = document.createElement("div"); evidence.className = "design-review-item";
      evidence.textContent = `${item.path}: ${item.impact || item.reason}`;
      $("design-contract-review").append(evidence);
    }
  }
  const diff = $("design-source-diff-content"); diff.replaceChildren();
  for (const operation of state.designReview?.changes?.operations || []) {
    const details = document.createElement("details"); details.className = "design-source-file";
    const summary = document.createElement("summary"); summary.textContent = `${operation.type} · ${operation.path}`; details.append(summary);
    const before = document.createElement("pre"); before.textContent = `Before\n${operation.before_content ?? "(new file)"}`;
    const after = document.createElement("pre"); after.textContent = `After\n${operation.content ?? "(deleted)"}`;
    details.append(before, after); diff.append(details);
  }
  $("design-review-proposal").hidden = Boolean(state.designReview);
  $("design-apply-proposal").hidden = !state.designReview;
  $("design-review-proposal").disabled = state.designBusy || !state.capabilities.canApplyAIChanges;
  $("design-apply-proposal").disabled = state.designBusy || !state.capabilities.canApplyAIChanges;
  $("design-cancel-proposal").disabled = state.designBusy;
  wireDesignPreviewFrame();
}

function refreshDesignPreview() {
  const frame = $("design-preview-frame");
  if (state.preview.status !== "running" || !frame) return;
  frame.src = `${projectQuery("/api/code/preview/frame")}&refresh=${Date.now()}`;
}

async function submitDesignActions(actions, summary) {
  const current = designState();
  if (!current || !state.design?.design_state_hash) throw new Error("Initialize Design Studio before proposing changes.");
  state.designBusy = true; applyPermissions();
  try {
    const result = await api(projectQuery("/api/code/design/proposal"), { method: "POST", body: JSON.stringify({ app_id: projectId, base_state_hash: state.design.design_state_hash, actions, summary }) });
    state.designProposal = result; state.designReview = null; renderDesign(); setStatus("Design proposal created. Preview it, then review the exact CODE diff.");
  } finally { state.designBusy = false; applyPermissions(); }
}

async function selectDesignRecipe() {
  await submitDesignActions([{ type: "select_recipe", recipe_id: $("design-recipe").value }], `Use the ${$("design-recipe").selectedOptions[0]?.textContent || "selected"} recipe`);
}

async function proposeDesignProperty() {
  const component = selectedDesignComponent();
  if (!component || component.ownership_state !== "FELTUS_MANAGED") throw new Error("Choose a FELTUS Managed component before editing its visual properties.");
  const property = $("design-property").value;
  let value = $("design-value").value;
  if (property === "visible") value = value === "true";
  const change = { target: "component", component_id: component.id, property, value, responsive_target: state.designViewport };
  await submitDesignActions([{ type: "edit", changes: [change] }], `Update ${component.name} ${property} on ${state.designViewport}`);
}

async function changeDesignOwnership() {
  const component = selectedDesignComponent(); if (!component) return;
  const ownership_state = component.ownership_state === "FELTUS_MANAGED" ? "DEVELOPER_MANAGED" : "FELTUS_MANAGED";
  await submitDesignActions([{ type: "ownership", component_id: component.id, ownership_state }], `${ownership_state === "DEVELOPER_MANAGED" ? "Detach" : "Reconnect"} ${component.name}`);
}

async function proposeDesignGuardrails() {
  const current = designState(); if (!current) return;
  const parseList = value => value.split(",").map(item => item.trim()).filter(Boolean);
  const guardrails = structuredClone(current.brand_guardrails || {});
  guardrails.allowed_colors = parseList($("design-allowed-colors").value);
  guardrails.prohibited_colors = parseList($("design-prohibited-colors").value);
  guardrails.allowed_logos = parseList($("design-logo-assets").value);
  const lockPath = $("design-lock-path").value;
  const lockValue = $("design-lock-value").value.trim();
  guardrails.locked_values ||= {};
  if (lockValue) guardrails.locked_values[lockPath] = lockValue;
  else delete guardrails.locked_values[lockPath];
  await submitDesignActions([{ type: "guardrails", value: guardrails }], "Update Brand Guardrails");
}

async function proposeDesignAI() {
  const prompt = $("design-ai-prompt").value.trim(); if (!prompt) throw new Error("Describe a design change first.");
  state.designBusy = true; applyPermissions();
  try {
    const result = await api(projectQuery("/api/code/design/ai-proposal"), { method: "POST", body: JSON.stringify({ app_id: projectId, prompt, base_state_hash: state.design.design_state_hash, selected_page_id: state.designPageId || null, selected_component_id: state.designComponentId || null, responsive_target: state.designViewport }) });
    if (result.blocked) { setStatus(result.message, true); return; }
    state.designProposal = result; state.designReview = null; renderDesign(); setStatus("AI proposed bounded visual changes. Review the preview before applying.");
  } finally { state.designBusy = false; applyPermissions(); }
}

async function reviewDesignProposal() {
  if (!state.designProposal?.proposal) return;
  state.designBusy = true; applyPermissions();
  try {
    state.designReview = await api(projectQuery("/api/code/design/review"), { method: "POST", body: JSON.stringify({ app_id: projectId, proposal_id: state.designProposal.proposal.id }) });
    renderDesign(); setStatus("Exact source diff and protected-contract review are ready. Read them before applying.");
  } finally { state.designBusy = false; applyPermissions(); }
}

async function applyDesignProposal() {
  if (!state.designReview || !state.designProposal?.proposal) return;
  if (!window.confirm("Apply this reviewed Design Studio change through FELTUS CODE, run isolated validation, stage only its files, and create a checkpoint?")) return;
  state.designBusy = true; applyPermissions();
  try {
    const result = await api(projectQuery("/api/code/design/apply"), { method: "POST", body: JSON.stringify({ app_id: projectId, proposal_id: state.designProposal.proposal.id, confirm_review: true }) });
    state.designProposal = null; state.designReview = null;
    if (state.preview.status === "running") await restartPreview();
    await loadDesign();
    await Promise.all([refreshGitStatus(), loadCheckpoints()]);
    setStatus(`Design changes validated and checkpointed at ${String(result.checkpoint).slice(0, 12)}.`);
  } finally { state.designBusy = false; applyPermissions(); }
}

async function reconcileDesign() {
  state.designBusy = true; applyPermissions();
  try {
    const result = await api(projectQuery("/api/code/design/reconcile"), { method: "POST", body: JSON.stringify({ app_id: projectId }) });
    state.design = { ...state.design, ...result, initialized: true, undo_available: state.design.undo_available };
    renderDesign(); setStatus("Component-scoped source reconciliation saved with evidence.");
  } finally { state.designBusy = false; applyPermissions(); }
}

async function undoDesign() {
  if (!window.confirm("Undo the last Design Studio change and create a new checkpoint?")) return;
  state.designBusy = true; applyPermissions();
  try {
    const result = await api(projectQuery("/api/code/design/undo"), { method: "POST", body: JSON.stringify({ app_id: projectId }) });
    state.designProposal = null; state.designReview = null;
    if (state.preview.status === "running") await restartPreview();
    await loadDesign(); await refreshGitStatus();
    setStatus(`Design change undone in checkpoint ${String(result.checkpoint).slice(0, 12)}.`);
  } finally { state.designBusy = false; applyPermissions(); }
}

async function initializeDesign() {
  state.designBusy = true; applyPermissions();
  try { await api(projectQuery("/api/code/design/initialize"), { method: "POST", body: JSON.stringify({ app_id: projectId }) }); await loadDesign(); setStatus("Design State initialized for this application."); }
  finally { state.designBusy = false; applyPermissions(); }
}

async function loadPreviewStatus() {
  const result = await api(projectQuery("/api/code/preview/status"));
  state.preview = result.preview;
  renderPreview();
  syncPreviewHeartbeat();
}

function syncPreviewHeartbeat() {
  if (previewHeartbeatTimer) clearInterval(previewHeartbeatTimer);
  previewHeartbeatTimer = null;
  if (state.preview.status !== "running") return;
  previewHeartbeatTimer = setInterval(async () => {
    if (previewHeartbeatBusy) return;
    previewHeartbeatBusy = true;
    try {
      const result = await api(projectQuery("/api/code/preview/heartbeat"));
      state.preview = result.preview;
      renderPreview();
    } catch {
      // The server's idle lease still cleans up if the browser loses its connection.
    } finally {
      previewHeartbeatBusy = false;
    }
  }, 5000);
}

async function startPreview() {
  $("start-preview").disabled = true;
  $("preview-status").textContent = "Starting the project…";
  setStatus("Starting the controlled project preview…");
  try {
    const result = await api(projectQuery("/api/code/preview/start"), { method: "POST", body: JSON.stringify({ app_id: projectId }) });
    state.preview = result.preview;
    $("preview-frame").src = `${result.frame_url}&refresh=${Date.now()}`;
    renderPreview();
    syncPreviewHeartbeat();
    setStatus("Preview is running.");
  } finally {
    applyPermissions();
  }
}

async function restartPreview() {
  $("preview-status").textContent = "Restarting…";
  const result = await api(projectQuery("/api/code/preview/reload"), { method: "POST", body: JSON.stringify({ app_id: projectId }) });
  state.preview = result.preview;
  $("preview-frame").src = `${result.frame_url}&refresh=${Date.now()}`;
  renderPreview();
  syncPreviewHeartbeat();
  setStatus("Preview restarted with current project files.");
}

async function stopPreview() {
  const result = await api(projectQuery("/api/code/preview/stop"), { method: "POST", body: JSON.stringify({ app_id: projectId }) });
  state.preview = result.preview;
  syncPreviewHeartbeat();
  $("preview-frame").removeAttribute("src");
  renderPreview();
  setStatus("Preview stopped.");
}

function renderSchema() {
  const schema = state.context?.data || { models: [], relationships: [] };
  $("schema-content").replaceChildren();
  if (!schema.models?.length) {
    const empty = document.createElement("div");
    empty.className = "empty-card";
    empty.innerHTML = '<strong>No information categories yet</strong><p>Ask FELTUS to add customers, invoices, bookings, or another category.</p>';
    $("schema-content").append(empty);
  }
  for (const model of schema.models || []) {
    const card = document.createElement("article");
    card.className = "schema-card";
    const fields = model.fields || [];
    card.innerHTML = `<h3>${escapeHtml(model.logical_name || model.name)}</h3><p>${model.rls_enabled ? "Row privacy is on" : "Row privacy is off"}</p><div class="schema-fields">${fields.map(field => `<span>${escapeHtml(field.column_name)} · ${escapeHtml(field.data_type)}</span>`).join("")}</div>`;
    $("schema-content").append(card);
  }
  renderSchemaProposal();
}

function normalizeModelProposal(model) {
  const name = String(model.name || model.logical_name || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new Error(`The proposed category name is invalid: ${name || "unnamed"}`);
  const fields = Array.isArray(model.fields) ? model.fields : Array.isArray(model.columns) ? model.columns : [];
  const columns = fields.map(field => ({
    name: String(field.name || field.column_name || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
    type: String(field.type || field.data_type || "text").toLowerCase(),
    nullable: field.nullable !== false && field.required !== true
  })).filter(field => /^[a-z][a-z0-9_]{0,39}$/.test(field.name));
  if (!columns.length) throw new Error(`${name} needs at least one valid field.`);
  return { name, columns };
}

async function applySchemaProposal() {
  if (state.schemaBusy || !state.capabilities.canManageSchema) return;
  const proposedModels = (state.plan?.data_models || []).filter(item => item && typeof item === "object").map(normalizeModelProposal);
  const proposedRelationships = (state.plan?.relationships || []).filter(item => item && typeof item === "object");
  if (!proposedModels.length && !proposedRelationships.length) throw new Error("The current plan has no structured data changes to apply.");
  if (!window.confirm(`Apply ${proposedModels.length} new information categor${proposedModels.length === 1 ? "y" : "ies"} and ${proposedRelationships.length} relationship proposal(s)? Existing data will not be removed.`)) return;
  state.schemaBusy = true;
  applyPermissions();
  try {
    const existing = new Set((state.context?.data?.models || []).map(model => model.logical_name));
    for (const model of proposedModels) {
      if (existing.has(model.name)) continue;
      await api("/api/models", {
        method: "POST",
        body: JSON.stringify({ app_id: projectId, table_name: model.name, columns: model.columns, enable_rls: true })
      });
    }
    await refreshContext();
    const models = state.context?.data?.models || [];
    for (const relationship of proposedRelationships) {
      const sourceName = String(relationship.source || relationship.source_model || "").toLowerCase();
      const targetName = String(relationship.target || relationship.target_model || "").toLowerCase();
      const source = models.find(model => model.logical_name === sourceName);
      const target = models.find(model => model.logical_name === targetName);
      if (!source || !target) throw new Error(`Relationship models are unavailable: ${sourceName} → ${targetName}`);
      await api("/api/relationships", {
        method: "POST",
        body: JSON.stringify({
          app_id: projectId,
          source_model_id: source.id,
          source_column: relationship.source_column,
          target_model_id: target.id,
          target_column: relationship.target_column || "id",
          on_delete: relationship.on_delete || "RESTRICT"
        })
      });
    }
    await refreshContext();
    setStatus("Approved data changes applied through the FELTUS data APIs.");
  } finally {
    state.schemaBusy = false;
    applyPermissions();
  }
}

function renderCheckpoints(checkpoints = state.checkpoints || []) {
  state.checkpoints = checkpoints;
  const exportSelect = $("export-checkpoint");
  const exportValue = exportSelect.value;
  exportSelect.replaceChildren(new Option("Latest approved checkpoint", ""));
  for (const checkpoint of state.approvedCheckpoints) {
    const option = new Option(`${checkpoint.label || "Checkpoint"} · ${checkpoint.git_commit}`, checkpoint.git_commit);
    exportSelect.append(option);
  }
  if ([...exportSelect.options].some(option => option.value === exportValue)) exportSelect.value = exportValue;
  $("export-application").disabled = !state.capabilities.canViewCode || !state.approvedCheckpoints.length;
  $("checkpoint-list").replaceChildren();
  if (!checkpoints.length) {
    const empty = document.createElement("p");
    empty.textContent = "No checkpoints yet.";
    $("checkpoint-list").append(empty);
    return;
  }
  for (const checkpoint of checkpoints) {
    const item = document.createElement("article");
    item.className = "checkpoint-item";
    const details = document.createElement("div");
    details.innerHTML = `<strong>${escapeHtml(checkpoint.label || "Checkpoint")}</strong><small>${escapeHtml(checkpoint.git_commit)} · ${new Date(checkpoint.created_at).toLocaleString()} · by ${escapeHtml(String(checkpoint.actor_id || "unknown").slice(0, 8))}</small>`;
    const actions = document.createElement("div");
    const compare = document.createElement("button");
    compare.type = "button";
    compare.textContent = "Compare";
    compare.onclick = () => compareCheckpoint(checkpoint.git_commit).catch(showError);
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "Restore";
    restore.disabled = !state.capabilities.canEditCode;
    restore.onclick = () => restoreCheckpoint(checkpoint.git_commit).catch(showError);
    actions.append(compare, restore);
    item.append(details, actions);
    $("checkpoint-list").append(item);
  }
}

function renderStudioActivity(actions = state.context?.recent_activity || []) {
  const container = $("studio-activity");
  if (!container) return;
  container.replaceChildren();
  if (!actions.length) {
    const empty = document.createElement("p");
    empty.textContent = "No project activity yet.";
    container.append(empty);
    return;
  }
  for (const action of actions.slice(0, 12)) {
    const item = document.createElement("article");
    item.className = "checkpoint-item";
    const details = document.createElement("div");
    const summary = document.createElement("strong");
    summary.textContent = action.summary || String(action.action_type || "Project update").replaceAll(".", " ");
    const meta = document.createElement("small");
    const actor = String(action.actor_id || "unknown user");
    const date = action.created_at ? new Date(action.created_at).toLocaleString() : "Time unavailable";
    meta.textContent = `by ${actor === "unknown user" ? actor : actor.slice(0, 8)} · ${date}${action.result_status === "failed" ? " · failed" : ""}`;
    details.append(summary, meta);
    item.append(details);
    container.append(item);
  }
}

function localGitCheckpoints(logText, savedCheckpoints = []) {
  const saved = Array.isArray(savedCheckpoints) ? savedCheckpoints : [];
  return String(logText || "").split(/\r?\n/).filter(Boolean).map(line => {
    const [commit, date, ...subjectParts] = line.split("\t");
    if (!/^[0-9a-f]{7,64}$/i.test(commit || "") || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return null;
    const existing = saved.find(item => {
      const savedCommit = String(item.git_commit || "").toLowerCase();
      const localCommit = commit.toLowerCase();
      return savedCommit && (savedCommit === localCommit || savedCommit.startsWith(localCommit) || localCommit.startsWith(savedCommit));
    });
    return {
      ...(existing || {}),
      id: existing?.id || `local-git-${commit}`,
      git_commit: commit,
      label: existing?.label || subjectParts.join("\t") || "Git commit",
      created_at: existing?.created_at || `${date}T00:00:00.000Z`,
      actor_id: existing?.actor_id || "local Git"
    };
  }).filter(Boolean);
}

async function loadCheckpoints(savedCheckpoints = null) {
  const [history, saved] = await Promise.all([
    api(projectQuery("/api/code/git/log?limit=100")),
    savedCheckpoints === null
      ? api(projectQuery("/api/code/checkpoints")).then(result => result.checkpoints || [])
      : Promise.resolve(savedCheckpoints)
  ]);
  state.approvedCheckpoints = saved;
  renderCheckpoints(localGitCheckpoints(history.stdout, saved));
}

async function compareCheckpoint(commit) {
  const result = await api(projectQuery(`/api/code/checkpoint/compare?commit=${encodeURIComponent(commit)}`));
  showTaskOutput({ task: `Compare ${commit}`, code: result.code, stdout: result.stdout || "No differences.", stderr: result.stderr }, "Ready");
  switchPane("terminal");
}

async function restoreCheckpoint(commit) {
  if (!window.confirm("Restore tracked project files to this checkpoint? Git history will remain intact and the restore will appear as working changes.")) return;
  const result = await api(projectQuery("/api/code/checkpoint/restore"), { method: "POST", body: JSON.stringify({ app_id: projectId, commit, confirm: true }) });
  state.files.clear();
  state.activePath = null;
  renderTabs();
  renderEditor();
  await Promise.all([loadTree(), refreshGitStatus()]);
  if (state.preview.status === "running") await restartPreview();
  setStatus(`Restored ${result.paths?.length || 0} file(s) from checkpoint ${commit}.`);
}

function changedPathsFromStatus() {
  if (state.lastAppliedPaths.length) return [...new Set(state.lastAppliedPaths)];
  return state.gitStatus.split(/\r?\n/).slice(1).map(line => line.slice(3).trim()).filter(Boolean).flatMap(value => value.includes(" -> ") ? value.split(" -> ") : [value]);
}

async function createCheckpoint({ messageOverride = null } = {}) {
  const paths = changedPathsFromStatus();
  if (!paths.length) throw new Error("There are no project changes to checkpoint.");
  const message = messageOverride || window.prompt("Checkpoint name:", state.changeSet?.summary || "Build Studio checkpoint");
  if (!message || !window.confirm(`Stage ${paths.length} changed file(s) and create this checkpoint?`)) return false;
  const productionizationRunId = state.lastAppliedProductionizationRunId;
  const latestRun = state.productionization?.latest_run || null;
  const productionizationFields = productionizationRunId ? {
    productionization_run_id: productionizationRunId,
    source_checkpoint_before: latestRun?.source_commit || null,
    source_snapshot_sha256: latestRun?.after_source_snapshot_sha256 || null,
    change_set_sha256: latestRun?.change_set_sha256 || null
  } : {};
  await api(projectQuery("/api/code/git/stage"), { method: "POST", body: JSON.stringify({ app_id: projectId, paths, ...productionizationFields }) });
  const result = await api(projectQuery("/api/code/git/checkpoint"), { method: "POST", body: JSON.stringify({
    app_id: projectId,
    message,
    confirm: true,
    ...productionizationFields
  }) });
  state.lastAppliedPaths = [];
  state.lastAppliedProductionizationRunId = null;
  await Promise.all([refreshGitStatus(), loadCheckpoints(), loadVersion(), refreshStudioActivity(), loadProductionization(), loadReleaseReadiness()]);
  setStatus(`Checkpoint ${result.commit} created.`);
  return true;
}

function availableTestingArtifact() {
  const staging = state.environments.find(environment => environment.kind === "staging");
  const artifact = staging?.available_artifact || null;
  const blueprintId = state.version?.latest_blueprint?.id;
  return artifact && blueprintId && artifact.blueprint_id === blueprintId ? artifact : null;
}

function renderVersion() {
  const container = $("version-state");
  container.replaceChildren();
  const current = state.version;
  if (!current) {
    container.innerHTML = "<p>Version state is unavailable.</p>";
    applyPermissions();
    return;
  }
  const blueprint = current.latest_blueprint;
  const build = current.builds?.[0];
  const artifact = availableTestingArtifact();
  container.innerHTML = `<p><strong>${blueprint ? `Version ${escapeHtml(blueprint.version)}` : "No prepared version"}</strong><br>${blueprint ? `State ${escapeHtml(String(blueprint.state_hash || "").slice(0, 12))}` : "Prepare a version after a clean checkpoint."}</p><p>Build: ${escapeHtml(build?.status || "not started")}<br>Testing artifact: ${artifact ? "verified" : "not ready"}</p>`;
  const changedDeltas = (current.delta || []).filter(item => item.status === "changed");
  const controls = $("reconciliation-controls");
  controls.hidden = changedDeltas.length === 0;
  $("reconciliation-summary").textContent = changedDeltas.length
    ? `${changedDeltas.length} observed change${changedDeltas.length === 1 ? "" : "s"} need review.`
    : "No observed deployment differences are waiting for review.";
  const canAccept = state.isAppOwner && changedDeltas.some(item => item.key === "desired_state.unpersisted") && Boolean(current.state?.observed_state?.id);
  $("accept-observed-change").hidden = !canAccept;
  const targetSelect = $("restore-target");
  const selectedBlueprint = targetSelect.value;
  targetSelect.replaceChildren();
  for (const item of current.blueprints || []) {
    targetSelect.append(new Option(`Version ${item.version} · ${String(item.state_hash || "").slice(0, 12)}`, item.id));
  }
  if ([...targetSelect.options].some(option => option.value === selectedBlueprint)) targetSelect.value = selectedBlueprint;
  else if (blueprint?.id && [...targetSelect.options].some(option => option.value === blueprint.id)) targetSelect.value = blueprint.id;
  const environmentSelect = $("restore-environment");
  const selectedEnvironment = environmentSelect.value;
  environmentSelect.replaceChildren();
  for (const item of state.environments) {
    if (item.deployment?.id) environmentSelect.append(new Option(item.kind, item.kind));
  }
  if ([...environmentSelect.options].some(option => option.value === selectedEnvironment)) environmentSelect.value = selectedEnvironment;
  const hasRestoreTarget = (current.blueprints || []).length > 1 && state.environments.some(item => item.deployment?.id);
  controls.hidden = changedDeltas.length === 0 && !hasRestoreTarget;
  const restoreAllowed = environmentSelect.value === "production" ? state.capabilities.canPublishProduction : state.capabilities.canDeployTesting;
  $("restore-desired-state").disabled = !hasRestoreTarget || !environmentSelect.value || !restoreAllowed;
  applyPermissions();
}

function renderProductionization(value) {
  state.productionization = value;
  const detail = $("productionization-detail-content");
  const latest = value?.latest_run || state.productionization?.run || null;
  const matchesSource = !latest?.source_snapshot_sha256 || latest.source_snapshot_sha256 === value?.source_snapshot_sha256 || latest.after_source_snapshot_sha256 === value?.source_snapshot_sha256;
  const status = latest && matchesSource ? latest.status : "NOT_RUN";
  const labels = {
    READY_FOR_RELEASE: "Ready to publish",
    BLOCKED: "Finalization needs attention",
    CHECKPOINT_REQUIRED: "Create a source checkpoint",
    VALIDATED_FOR_REVIEW: "Review required",
    READY_FOR_REVIEW: "Productionization plan ready for review",
    NOT_RUN: "Run required checks before release"
  };
  $("productionization-state").textContent = labels[status] || "Finalization in progress";
  detail.replaceChildren();
  const standards = value?.engineering_standard?.standards || [];
  const latestPlan = value?.latest_plan || null;
  const behavioralBaseline = latestPlan?.baseline || latest?.behavioral_baseline || null;
  if (behavioralBaseline) {
    const baselineSummary = document.createElement("p");
    baselineSummary.textContent = behavioralBaseline.evidence_status === "NO_CONFIGURED_CHECKS"
      ? "Behavioral baseline: no repository test or build check was configured; only deterministic transformation checks can establish safety."
      : `Behavioral baseline: ${behavioralBaseline.checks?.filter(check => check.required).length || 0} existing check(s) recorded.`;
    detail.append(baselineSummary);
  }
  if (latestPlan) {
    const planSummary = document.createElement("p");
    planSummary.textContent = `${latestPlan.automatic_safe?.length || 0} safe changes · ${latestPlan.review_required?.length || 0} standards need review · ${latestPlan.protected_skipped?.length || 0} protected files excluded`;
    detail.append(planSummary);
    for (const reason of latestPlan.unresolved || []) {
      const item = document.createElement("p");
      item.textContent = `Blocked: ${reason}`;
      detail.append(item);
    }
    for (const recommendation of latestPlan.review_required || []) {
      const item = document.createElement("p");
      item.textContent = `${recommendation.ecosystem} ${recommendation.name}: ${recommendation.status} · review ${recommendation.recommendation.join(", ") || "repository tooling"}`;
      detail.append(item);
    }
  }
  const standardSummary = value?.engineering_standard?.summary;
  if (standardSummary) {
    const attention = standardSummary.partial + standardSummary.missing + standardSummary.unknown;
    $("productionization-state").textContent += " · Engineering readiness: " +
      standardSummary.satisfied + " ready, " + attention + " need attention";
  }
  const stack = document.createElement("p");
  const languages = value?.classification?.languages?.map(item => item.name) || [];
  const frameworks = value?.classification?.frameworks || [];
  stack.textContent = `Detected stack: ${[...languages, ...frameworks].join(", ") || "not detected"}`;
  detail.append(stack);
  const classification = value?.classification || {};
  const packageManagers = classification.package_manager_status === "CONFLICT"
    ? "conflict detected"
    : (classification.package_managers || []).map(item => item.name).join(", ") || "not detected";
  const technicalSummary = [
    ["Runtime", (classification.runtimes || []).map(item => item.name + (item.version ? " " + item.version : "")).join(", ") || "not detected"],
    ["Package manager", packageManagers],
    ["Formatter", (classification.formatters || []).map(item => item.name).join(", ") || "not configured"],
    ["Linter", (classification.linters || []).map(item => item.name).join(", ") || "not configured"],
    ["Type checker", (classification.type_checkers || []).map(item => item.name).join(", ") || "not configured"],
    ["Test runner", (classification.test_runners || []).map(item => item.name).join(", ") || "not detected"],
    ["Database", (classification.databases || []).join(", ") || "not detected"],
    ["Migration tooling", (classification.migration_tools || []).map(item => item.name).join(", ") || "not detected"],
    ["Provider evidence", (classification.provider_evidence || []).map(item => item.name).join(", ") || "not detected"]
  ];
  for (const [label, result] of technicalSummary) {
    const item = document.createElement("p");
    item.textContent = label + ": " + result;
    detail.append(item);
  }
  if (standards.length) {
    const heading = document.createElement("p");
    heading.textContent = "Engineering standards";
    detail.append(heading);
    const list = document.createElement("ul");
    for (const standard of standards) {
      const item = document.createElement("li");
      const tools = standard.configured_tools?.length
        ? standard.configured_tools.join(", ")
        : "recommended: " + (standard.recommended_tools || []).join(", ");
      item.textContent = standard.name + ": " + standard.status + " · " + tools;
      list.append(item);
    }
    detail.append(list);
  }
  if (classification.classification_message) {
    const message = document.createElement("p");
    message.textContent = classification.classification_message;
    detail.append(message);
  }
  const checks = latest?.checks || value?.required_checks || [];
  for (const check of checks) {
    const item = document.createElement("p");
    item.textContent = `${check.status || (check.available ? "REQUIRED" : "UNAVAILABLE")} · ${check.tool}${check.output_summary ? ` — ${check.output_summary.slice(0, 500)}` : check.reason ? ` — ${check.reason}` : ""}`;
    detail.append(item);
  }
  for (const reason of latest?.release_readiness?.blocking_reasons || []) {
    const item = document.createElement("p");
    item.textContent = `Action required: ${reason}`;
    detail.append(item);
  }
  if (value?.classification?.source_commit || latest?.source_commit) {
    const source = document.createElement("p");
    source.textContent = `Source checkpoint: ${value.classification?.source_commit || latest.source_commit}`;
    detail.append(source);
  }
  if (latest?.run_id) state.productionizationRunId = latest.run_id;
  applyPermissions();
}

async function loadProductionization() {
  const value = await api(projectQuery("/api/code/productionization"));
  renderProductionization(value.result || value);
}

function releaseReadinessHeadline(readiness) {
  const headline = readiness?.progressive_disclosure?.executive?.headline || readiness?.summary?.executive_state;
  if (headline) return headline;
  if (readiness?.state === "READY") return "Ready to Release";
  if (readiness?.state === "REVIEW_REQUIRED") return "Review required before release";
  if (readiness?.state === "STALE") return "Release readiness is stale — reevaluate before building";
  if (readiness?.state === "VALIDATING") return "Release readiness is validating";
  return "Release readiness needs attention";
}

function renderReleaseReadiness(value) {
  const readiness = value?.readiness || value || null;
  state.releaseReadiness = readiness;
  const executive = $("release-readiness-executive");
  const categories = $("release-readiness-categories");
  const detail = $("release-readiness-detail-content");
  executive.replaceChildren();
  categories.replaceChildren();
  detail.replaceChildren();
  if (!readiness) {
    executive.textContent = "Evaluate this source to see whether it is ready to release.";
    categories.textContent = "Category summary appears after evaluation.";
    detail.textContent = "Technical evidence stays here until you need it.";
    return;
  }
  const headline = document.createElement("p");
  const summary = readiness.summary || {};
  headline.textContent = releaseReadinessHeadline(readiness);
  executive.append(headline);
  const count = document.createElement("p");
  const blocking = Number(summary.blocking_count || 0);
  const review = Number(summary.review_required_count || 0);
  count.textContent = readiness.state === "READY"
    ? "All applicable release checks passed. Build remains an explicit lifecycle action."
    : readiness.state === "STALE"
      ? "This result is no longer authoritative for the current source."
      : `${blocking} blocking · ${review} review required`;
  executive.append(count);
  if (readiness.source_identity?.checkpoint) {
    const source = document.createElement("small");
    source.textContent = `Source checkpoint: ${String(readiness.source_identity.checkpoint).slice(0, 16)}`;
    executive.append(source);
  }
  const categoryRows = readiness.progressive_disclosure?.categories || [];
  if (!categoryRows.length) {
    const message = document.createElement("p");
    message.textContent = readiness.reason || "Category summary will be available after evaluation.";
    categories.append(message);
  }
  for (const category of categoryRows) {
    const row = document.createElement("p");
    const counts = [
      category.blocking_count ? `${category.blocking_count} blocking` : null,
      category.review_required_count ? `${category.review_required_count} review` : null,
      category.warning_count ? `${category.warning_count} warning` : null,
      category.not_applicable_count === category.check_count && category.check_count ? "not applicable" : null
    ].filter(Boolean).join(" · ");
    row.textContent = `${category.category}: ${category.state}${counts ? ` — ${counts}` : ""}`;
    categories.append(row);
  }
  const checks = readiness.progressive_disclosure?.detailed_evidence || readiness.checks || [];
  for (const check of checks) {
    const item = document.createElement("section");
    const title = document.createElement("p");
    title.textContent = `${check.name} · ${check.result} · ${check.gate}`;
    item.append(title);
    const evidence = document.createElement("p");
    evidence.textContent = `Evidence: ${check.evidence?.summary || "No additional evidence recorded."}`;
    item.append(evidence);
    const expectation = document.createElement("p");
    expectation.textContent = `Expected: ${check.expected_state || "not specified"} · Observed: ${check.observed_state || "not specified"}`;
    item.append(expectation);
    if (check.remediation) {
      const remediation = document.createElement("p");
      remediation.textContent = `Next step: ${check.remediation}`;
      item.append(remediation);
    }
    const provenance = document.createElement("small");
    provenance.textContent = `Source: ${String(check.source_identity?.checkpoint || "unknown").slice(0, 16)} · ${check.evaluated_at || readiness.evaluated_at || "time unavailable"}`;
    item.append(provenance);
    detail.append(item);
  }
  for (const reason of readiness.stale_reasons || []) {
    const item = document.createElement("p");
    item.textContent = `Stale binding: ${reason.field}`;
    detail.append(item);
  }
  const eligibility = document.createElement("p");
  eligibility.textContent = readiness.build_eligibility?.eligible
    ? "This evaluation permits the existing explicit build action; no build has started."
    : readiness.build_eligibility?.reason || "Build eligibility is not established.";
  detail.append(eligibility);
  applyPermissions();
}

async function loadReleaseReadiness() {
  const value = await api(projectQuery("/api/code/release-readiness"));
  renderReleaseReadiness(value);
}

async function evaluateReleaseReadiness() {
  if (state.releaseReadinessBusy || !state.capabilities.canRunAgent) return;
  state.releaseReadinessBusy = true;
  applyPermissions();
  $("release-readiness-executive").textContent = "Evaluating this exact source…";
  try {
    const value = await api(projectQuery("/api/code/release-readiness/evaluations"), {
      method: "POST",
      body: JSON.stringify({ app_id: projectId })
    });
    renderReleaseReadiness(value);
    await refreshStudioActivity();
    const readiness = value.readiness || value;
    setStatus(readiness.state === "READY"
      ? "Release readiness is established. Build remains an explicit next action."
      : releaseReadinessHeadline(readiness), readiness.state !== "READY");
  } finally {
    state.releaseReadinessBusy = false;
    applyPermissions();
  }
}

async function runReleaseChecks(changeSet = null) {
  if (state.productionizationBusy || !state.capabilities.canRunAgent) return;
  state.productionizationBusy = true;
  applyPermissions();
  $("productionization-state").textContent = "Finalizing application…";
  try {
    const result = await api(projectQuery("/api/code/productionization/validate"), {
      method: "POST",
      body: JSON.stringify({ app_id: projectId, ...(changeSet ? {
        change_set: changeSet,
        source_checkpoint_id: changeSet.productionization?.source_checkpoint,
        source_snapshot_sha256: changeSet.productionization?.source_snapshot_sha256,
        classifier_version: changeSet.productionization?.classifier_version
      } : {}) })
    });
    const data = result.result;
    state.productionizationRunId = data.run.run_id;
    renderProductionization({
      ...(state.productionization || {}),
      source_snapshot_sha256: data.run.source_snapshot_sha256,
      classification: data.classification,
      engineering_standard: data.engineering_standard,
      latest_run: data.run
    });
    return data;
  } finally {
    state.productionizationBusy = false;
    applyPermissions();
  }
}

async function proposeNormalization() {
  if (!state.capabilities.canRunAgent) throw new Error("You do not have permission to prepare repository productionization.");
  if (state.productionizationPlanning || state.productionizationBusy) return;
  state.productionizationPlanning = true;
  applyPermissions();
  $("productionization-state").textContent = "Checking the source checkpoint and preparing the plan…";
  setStatus("Establishing the behavioral baseline and preparing deterministic improvements…");
  try {
    const response = await api(projectQuery("/api/code/productionization/plan"), {
      method: "POST",
      body: JSON.stringify({ app_id: projectId })
    });
    const plan = response.result;
    state.productionizationRunId = plan.run_id;
    renderProductionization({ ...(state.productionization || {}), latest_run: plan.run, latest_plan: plan });
    if (!plan.change_set) {
      setStatus(plan.status === "BLOCKED" ? "Productionization is blocked by the repository classification or source state." : "No safe automatic source changes were found. Review the engineering-standard recommendations.", plan.status === "BLOCKED");
      await refreshStudioActivity();
      return;
    }
    const reviewed = await api(projectQuery("/api/code/change-set/review"), {
      method: "POST",
      body: JSON.stringify({ app_id: projectId, change_set: plan.change_set })
    });
    const changeSet = {
      ...reviewed.result,
      productionization: { ...plan.change_set.productionization, plan_id: plan.id }
    };
    renderChangeSet(changeSet);
    state.productionizationPlanning = false;
    applyPermissions();
    const validation = await runReleaseChecks(changeSet);
    changeSet.productionization.release_readiness = validation.release_readiness;
    changeSet.productionization.run = validation.run;
    changeSet.productionization.contract_review = reviewed.result.contract_review;
    renderChangeSet(changeSet);
    const checksPassed = validation.release_readiness.checks.every(check => !check.blocking);
    appendMessage("assistant", "FELTUS", `${changeSet.summary}\n${checksPassed ? "Isolated validation passed. Review the diff, then apply and checkpoint the plan." : "Validation needs attention. The proposal remains reviewable and the source is unchanged."}`);
    setStatus(checksPassed ? "Isolated validation passed. Review the changes before applying." : "The proposal remains available for review; validation must pass before application.", !checksPassed);
    await refreshStudioActivity();
  } finally {
    state.productionizationPlanning = false;
    applyPermissions();
  }
}

async function loadVersion() {
  const [stateResult, environmentsResult, buildsResult, blueprintsResult] = await Promise.all([
    api(`/api/apps/${encodeURIComponent(projectId)}/state`),
    api(`/api/apps/${encodeURIComponent(projectId)}/environments`),
    api(`/api/apps/${encodeURIComponent(projectId)}/builds`),
    api(`/api/apps/${encodeURIComponent(projectId)}/blueprints`)
  ]);
  state.version = { ...stateResult, builds: buildsResult.builds || [], blueprints: blueprintsResult.blueprints || [] };
  state.environments = environmentsResult.environments || [];
  renderVersion();
}

async function acceptObservedChange() {
  const current = state.version;
  const delta = current?.delta?.find(item => item.key === "desired_state.unpersisted" && item.status === "changed");
  const observationId = current?.state?.observed_state?.id;
  if (!state.isAppOwner || !delta || !observationId) throw new Error("An application owner and a current unpersisted desired-state change are required.");
  const sourceCommit = current.state.observed_state.commit_sha;
  const previousVersion = current.latest_blueprint?.version || 0;
  const nextVersion = previousVersion + 1;
  const previousHash = delta.observed?.state_hash || "none";
  const nextHash = current.state_hash || "unavailable";
  if (!window.confirm(`After required checks pass, create immutable Blueprint version ${nextVersion} from source commit ${sourceCommit || "(unknown)"}? Desired-state hash changes from ${previousHash} to ${nextHash}.`)) return;
  const result = await api(`/api/apps/${encodeURIComponent(projectId)}/state/reconciliation/accept`, {
    method: "POST",
    body: JSON.stringify({ app_id: projectId, observation_id: observationId, delta_key: delta.key, confirm: true })
  });
  await Promise.all([loadVersion(), refreshStudioActivity()]);
  setStatus(`Observed change accepted as Blueprint version ${result.blueprint?.version}.`);
}

async function restoreDesiredState() {
  const target = $("restore-target").selectedOptions[0];
  const environment = $("restore-environment").value;
  const reason = $("restore-reason").value.trim();
  if (!target?.value || !environment || !reason) throw new Error("Choose a desired version and environment, then enter a reason.");
  const permitted = environment === "production" ? state.capabilities.canPublishProduction : state.capabilities.canDeployTesting;
  if (!permitted) throw new Error("You do not have permission to restore this environment.");
  if (!window.confirm(`Queue restoration of ${environment} to ${target.textContent}? The existing deployment worker will perform the rollback.`)) return;
  const result = await api(`/api/apps/${encodeURIComponent(projectId)}/state/reconciliation/restore`, {
    method: "POST",
    body: JSON.stringify({
      app_id: projectId,
      target_blueprint_id: target.value,
      environment,
      reason,
      confirm: true
    })
  });
  await Promise.all([loadVersion(), refreshStudioActivity()]);
  setStatus(`Restoration to Blueprint version ${result.target_blueprint?.version} was queued.`);
}

async function prepareVersion() {
  if (state.versionBusy || !state.capabilities.canPrepareVersion) return;
  if (state.gitStatus.split(/\r?\n/).slice(1).some(Boolean)) throw new Error("Create a checkpoint or clear working changes before preparing a version.");
  if (!window.confirm("Prepare a FELTUS version from the current authoritative app state?")) return;
  state.versionBusy = true;
  applyPermissions();
  try {
    const result = await api(`/api/apps/${encodeURIComponent(projectId)}/blueprints`, {
      method: "POST",
      body: JSON.stringify({ confirm: true })
    });
    state.version = { ...(state.version || {}), latest_blueprint: result.blueprint, state_hash: result.state_hash, persisted: true };
    renderVersion();
    setStatus(`Version ${result.blueprint.version} prepared.`);
    appendMessage("assistant", "DevOps Agent", `Version ${result.blueprint.version} is prepared from state ${String(result.blueprint.state_hash).slice(0, 12)}.`);
  } finally {
    state.versionBusy = false;
    applyPermissions();
  }
}

async function sendToTesting() {
  const artifact = availableTestingArtifact();
  if (!artifact || state.deploymentBusy || !state.capabilities.canDeployTesting) return;
  if (!window.confirm("Send this verified version to Staging for testing? This uses the existing FELTUS deployment records and worker.")) return;
  state.deploymentBusy = true;
  state.idempotencyKey ||= crypto.randomUUID();
  applyPermissions();
  try {
    const result = await api(`/api/apps/${encodeURIComponent(projectId)}/deployments`, {
      method: "POST",
      body: JSON.stringify({ environment: "staging", artifact_id: artifact.id, idempotency_key: state.idempotencyKey })
    });
    setStatus(`Testing deployment ${String(result.deployment.id).slice(0, 8)} queued.`);
    appendMessage("assistant", "DevOps Agent", "The verified version was sent to Staging through the FELTUS deployment flow.");
    state.idempotencyKey = null;
    await loadVersion();
  } finally {
    state.deploymentBusy = false;
    applyPermissions();
  }
}

async function refreshContext() {
  const result = await api(projectQuery("/api/code/context"));
  state.context = result.context;
  await loadCheckpoints(result.checkpoints || []);
  renderStudioActivity();
  renderSchema();
  updateContextChips();
}

async function refreshStudioActivity() {
  try {
    const result = await api(projectQuery("/api/code/activity?limit=12"));
    if (state.context) state.context.recent_activity = result.actions || [];
    renderStudioActivity(result.actions || []);
  } catch {
    const container = $("studio-activity");
    if (container) container.textContent = "Recent activity is unavailable.";
  }
}

async function refreshStudio() {
  setStatus("Refreshing project state…");
  await Promise.all([loadTree(), refreshGitStatus(), refreshContext(), loadPreviewStatus(), loadVersion(), loadProductionization(), loadReleaseReadiness()]);
  setStatus("Build Studio is up to date.");
}

async function initializeWorkspace() {
  if (!state.capabilities.canEditCode) throw new Error("Ask an app editor to prepare this workspace.");
  const button = $("initialize-workspace");
  const errorNode = $("workspace-initialize-error");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Preparing your app…";
  errorNode.textContent = "";
  try {
    const result = await api(projectQuery("/api/code/workspace"), { method: "POST", body: JSON.stringify({ app_id: projectId, action: "initialize" }) });
    if (result.workspace?.initialized !== true) throw new Error("FELTUS could not confirm the new workspace. Try again.");
    await loadWorkspace();
  } catch (error) {
    renderFriendlyError(errorNode, error);
    setStatus("FELTUS couldn’t prepare this app. Please try again.", true);
  } finally {
    if (button.isConnected) {
      button.disabled = !state.capabilities.canEditCode;
      button.textContent = "Get started";
    }
  }
}

async function loadWorkspace() {
  const workspace = await api(projectQuery("/api/code/workspace"));
  if (!workspace.initialized) {
    const access = await api(projectQuery("/api/code/capabilities"));
    state.capabilities = access.capabilities || {};
    state.role = access.role || "viewer";
    state.isAppOwner = access.is_app_owner === true;
    document.body.classList.add("workspace-not-initialized");
    $("workspace-setup").hidden = false;
    $("workspace-app").hidden = true;
    $("primary-nav").hidden = true;
    $("initialize-workspace").disabled = !state.capabilities.canEditCode;
    setStatus(state.capabilities.canEditCode ? "Your application is ready to set up." : "Ask an app editor to prepare this workspace.");
    return;
  }
  document.body.classList.remove("workspace-not-initialized");
  $("workspace-setup").hidden = true;
  $("primary-nav").hidden = false;
  $("workspace-app").hidden = false;
  const [sessionResult, access, taskCatalog, contextResult, appResult] = await Promise.all([
    api(projectQuery("/api/code/session")),
    api(projectQuery("/api/code/capabilities")),
    api(projectQuery("/api/code/tasks")),
    api(projectQuery("/api/code/context")),
    api(`/api/apps/${encodeURIComponent(projectId)}`),
    loadModels(),
    loadTree(),
    refreshGitStatus(),
    loadPreviewStatus(),
    loadVersion(),
    loadProductionization(),
    loadReleaseReadiness()
  ]);
  state.capabilities = access.capabilities || {};
  state.role = access.role || "viewer";
  state.isAppOwner = access.is_app_owner === true;
  state.context = contextResult.context;
  state.appName = appResult.app?.app_name || sessionResult.session?.title || "Your application";
  state.appDescription = appResult.app?.description || "";
  $("session-title").textContent = state.appName;
  $("activity-owner").textContent = `${access.current_actor?.label || "Signed-in user"} · ${state.role}`;
  renderTasks(taskCatalog);
  await loadCheckpoints(contextResult.checkpoints || []);
  renderStudioActivity();
  renderConversationFromActivity();
  renderApplicationResult();
  renderSchema();
  applyPermissions();
  const requestedPane = new URLSearchParams(location.search).get("pane");
  switchPane(["preview", "design", "data", "launch"].includes(requestedPane) ? requestedPane : "chat");
  setStatus("Your app workspace is ready.");
}

function showError(error) {
  if (error?.name === "AbortError") return;
  setStatus("FELTUS couldn’t complete that request. Please try again.", true);
  setAssistantError(error);
  if (state.activePane === "terminal") showTaskOutput({ task: "Stopped", code: null, stderr: error.message }, "Failed");
}

async function createProjectFile(kind) {
  const label = kind === "folder" ? "folder" : "file";
  const name = window.prompt(`New ${label} path, relative to this project:`);
  if (!name) return;
  if (kind === "folder") {
    await api(projectQuery("/api/code/directory"), { method: "POST", body: JSON.stringify({ app_id: projectId, path: name }) });
  } else {
    await api(projectQuery("/api/code/file/create"), { method: "POST", body: JSON.stringify({ app_id: projectId, path: name, content: "" }) });
  }
  await Promise.all([loadTree(), refreshGitStatus()]);
  if (kind === "file") await openFile(name);
}

async function searchProject(query = $("search").value.trim()) {
  if (!query) return;
  const result = await api(projectQuery(`/api/code/search?q=${encodeURIComponent(query)}`));
  $("search-results").replaceChildren();
  for (const item of result.results || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    button.textContent = `${item.path}:${item.line}  ${item.preview}`;
    button.onclick = async () => { await openFile(item.path); goToLine(item.line); };
    $("search-results").append(button);
  }
  setStatus(`${result.results?.length || 0} search result(s).`);
}

function goToLine(value) {
  const line = Number(value || window.prompt("Go to line:"));
  if (!Number.isInteger(line) || line < 1) return;
  const positions = $("code").value.split("\n");
  const offset = positions.slice(0, line - 1).reduce((total, part) => total + part.length + 1, 0);
  $("code").focus();
  $("code").setSelectionRange(offset, offset);
  $("code").scrollTop = Math.max(0, (line - 3) * 19.2);
  renderLineNumbers();
}

function findInFile() {
  const query = window.prompt("Find in this file:", selectedText());
  if (!query) return;
  const start = $("code").value.indexOf(query, $("code").selectionEnd);
  const index = start >= 0 ? start : $("code").value.indexOf(query);
  if (index < 0) return setStatus(`“${query}” was not found.`, true);
  $("code").focus();
  $("code").setSelectionRange(index, index + query.length);
  updateSelectionState();
}

function replaceInFile() {
  const file = state.files.get(state.activePath);
  if (!file?.editable || !state.capabilities.canEditCode) throw new Error("Open an editable project file before replacing text.");
  const currentSelection = selectedText();
  const query = window.prompt("Find text to replace:", currentSelection);
  if (!query) return;
  const value = $("code").value;
  const selectionMatches = value.slice($("code").selectionStart, $("code").selectionEnd) === query;
  const startAt = selectionMatches ? $("code").selectionStart : Math.max(0, $("code").selectionEnd);
  const foundAt = value.indexOf(query, startAt);
  const index = foundAt >= 0 ? foundAt : value.indexOf(query);
  if (index < 0) return setStatus(`“${query}” was not found.`, true);
  const replacement = window.prompt("Replace it with:", query);
  if (replacement === null) return;
  $("code").focus();
  $("code").setRangeText(replacement, index, index + query.length, "select");
  updateDirtyState();
  updateSelectionState();
  setStatus("Text replaced. Save the file to keep this change.");
}

function updateSelectionState() {
  const text = selectedText();
  $("selection-state").textContent = text ? `${text.split("\n").length} selected line(s) will be included.` : "Select code to ask FELTUS about it.";
  updateContextChips();
}

function bindEvents() {
  $$('[data-workspace-tab]').forEach(button => button.addEventListener("click", () => switchPane(button.dataset.workspaceTab)));
  $$('[data-ai-mode]').forEach(button => button.addEventListener("click", () => {
    state.aiMode = button.dataset.aiMode;
    $$('[data-ai-mode]').forEach(item => item.classList.toggle("active", item === button));
    updateAssistantAction();
  }));
  $$('[data-selection-action]').forEach(button => button.addEventListener("click", () => {
    state.aiMode = button.dataset.selectionAction;
    $$('[data-ai-mode]').forEach(item => item.classList.toggle("active", item.dataset.aiMode === state.aiMode));
    $("prompt").value ||= `${state.aiMode} the selected code in ${state.activePath}.`;
    $("prompt").focus();
  }));
  $$('[data-task]').forEach(button => button.addEventListener("click", () => runTask(button.dataset.task).catch(showError)));

  $("code").addEventListener("input", updateDirtyState);
  $("code").addEventListener("scroll", renderLineNumbers);
  $("code").addEventListener("select", updateSelectionState);
  $("save").onclick = () => saveFile().catch(showError);
  $("initialize-workspace").onclick = () => initializeWorkspace().catch(showError);
  $("refresh-tree").onclick = () => loadTree().catch(showError);
  $("tree-up").onclick = () => { state.expanded.clear(); loadTree().catch(showError); };
  $("new-file").onclick = () => createProjectFile("file").catch(showError);
  $("new-folder").onclick = () => createProjectFile("folder").catch(showError);
  $("go-to-file").onclick = () => { const name = window.prompt("Open project file:"); if (name) openFile(name).catch(showError); };
  $("search").addEventListener("keydown", event => { if (event.key === "Enter") searchProject().catch(showError); });
  $("rename-file").onclick = async () => {
    if (!state.activePath) return;
    const previous = state.activePath;
    const next = window.prompt("Move or rename this project file:", previous);
    if (!next || next === previous) return;
    try {
      await api(projectQuery("/api/code/rename"), { method: "POST", body: JSON.stringify({ app_id: projectId, from: previous, to: next }) });
      state.files.delete(previous); state.activePath = null; renderTabs(); renderEditor(); await Promise.all([loadTree(), refreshGitStatus()]);
    } catch (error) { showError(error); }
  };
  $("delete-file").onclick = async () => {
    if (!state.activePath || !window.confirm(`Delete ${state.activePath}? This direct file action cannot be undone through the AI change-set control.`)) return;
    try {
      await api(projectQuery(`/api/code/file?path=${encodeURIComponent(state.activePath)}&confirm=true`), { method: "DELETE" });
      state.files.delete(state.activePath); state.activePath = null; renderTabs(); renderEditor(); await Promise.all([loadTree(), refreshGitStatus()]);
    } catch (error) { showError(error); }
  };
  $("find-code").onclick = findInFile;
  $("replace-code").onclick = () => replaceInFile();
  $("goto-line").onclick = () => goToLine();
  $("send-ai").onclick = () => handleAI().catch(showError);
  $$("[data-chat-prompt]").forEach(button => button.addEventListener("click", () => {
    $("prompt").value = button.dataset.chatPrompt;
    handleAI().catch(showError);
  }));
  $("request-app-change").onclick = prepareAppChange;
  $("prompt").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      handleAI().catch(showError);
    }
  });
  $("chat-start-preview").onclick = () => startPreview().catch(showError);
  $("run-agent").onclick = () => runStudioAgent().catch(showError);
  $("cancel-ai").onclick = () => state.aiRequest?.abort();
  $("start-build").onclick = () => requestChangeSet($("prompt").value.trim() || state.plan?.summary || "Implement the approved plan.", "build").catch(showError);
  $("dismiss-plan").onclick = () => renderPlan(null);
  $("apply-all").onclick = () => applyChanges(false).catch(showError);
  $("apply-selected").onclick = () => applyChanges(true).catch(showError);
  $("reject-changes").onclick = () => rejectChanges().catch(showError);
  $("undo-changes").onclick = () => undoChanges().catch(showError);
  $("run-task").onclick = () => runTask($("agent-task").value).catch(showError);
  $("cancel-task").onclick = () => state.taskRequest?.abort();
  $("quick-run").onclick = () => runTask(state.tasks.includes("npm-check") ? "npm-check" : state.tasks[0]).catch(showError);
  $("working-diff").onclick = () => compareDiff(false).catch(showError);
  $("staged-diff").onclick = () => compareDiff(true).catch(showError);
  $("git-log").onclick = () => { switchPane("changes"); loadCheckpoints().catch(showError); };
  $("create-checkpoint").onclick = () => createCheckpoint().catch(showError);
  $("start-preview").onclick = () => startPreview().catch(showError);
  $("reload-preview").onclick = () => restartPreview().catch(showError);
  $("refresh-preview").onclick = () => { $("preview-frame").src = `${projectQuery("/api/code/preview/frame")}&refresh=${Date.now()}`; };
  $("open-preview").onclick = () => window.open(projectQuery("/api/code/preview/frame"), "_blank", "noopener,noreferrer");
  $("stop-preview").onclick = () => stopPreview().catch(showError);
  $("design-refresh").onclick = () => loadDesign().catch(showError);
  $("design-initialize").onclick = () => initializeDesign().catch(showError);
  $("design-select-recipe").onclick = () => selectDesignRecipe().catch(showError);
  $("design-apply-property").onclick = () => proposeDesignProperty().catch(showError);
  $("design-toggle-ownership").onclick = () => changeDesignOwnership().catch(showError);
  $("design-save-guardrails").onclick = () => proposeDesignGuardrails().catch(showError);
  $("design-ai-propose").onclick = () => proposeDesignAI().catch(showError);
  $("design-review-proposal").onclick = () => reviewDesignProposal().catch(showError);
  $("design-apply-proposal").onclick = () => applyDesignProposal().catch(showError);
  $("design-cancel-proposal").onclick = () => { state.designProposal = null; state.designReview = null; renderDesignProposal(); setStatus("Design proposal discarded; application source is unchanged."); };
  $("design-reconcile").onclick = () => reconcileDesign().catch(showError);
  $("design-undo").onclick = () => undoDesign().catch(showError);
  $("design-component").onchange = () => { state.designComponentId = $("design-component").value; state.designPageId = selectedDesignComponent()?.page_id || state.designPageId; $("design-page").value = state.designPageId; renderDesignSelection(); };
  $("design-page").onchange = () => { state.designPageId = $("design-page").value; state.designComponentId = designState()?.components?.find(item => item.page_id === state.designPageId && item.ownership_state === "FELTUS_MANAGED")?.id || ""; renderDesign(); };
  $("design-property").onchange = renderDesignSelection;
  $$('[data-design-viewport]').forEach(button => button.addEventListener("click", () => {
    state.designViewport = button.dataset.designViewport;
    $$('[data-design-viewport]').forEach(item => item.classList.toggle("active", item === button));
    renderDesignSelection(); renderDesignPreview();
  }));
  $$('[data-design-variation]').forEach(button => button.addEventListener("click", () => submitDesignActions([{ type: "variation", variation: button.dataset.designVariation }], `Preview the ${button.dataset.designVariation} variation`).catch(showError)));
  $("design-start-preview").onclick = async () => { try { await startPreview(); renderDesignPreview(); } catch (error) { showError(error); } };
  $("design-refresh-preview").onclick = refreshDesignPreview;
  $("design-preview-frame").addEventListener("load", wireDesignPreviewFrame);
  $("fix-preview-errors").onclick = () => {
    const errors = state.preview.errors.map(error => `${error.type}: ${error.message}${error.source ? ` (${error.source})` : ""}`).join("\n");
    const prompt = `Fix the current Preview errors below. Keep the repair focused, validate the proposed change, and preserve the rest of the project.\n\n${errors}`;
    state.aiMode = "Fix";
    $("prompt").value = prompt;
    runStudioAgent(prompt).catch(showError);
  };
  $("refresh-data").onclick = () => refreshContext().catch(showError);
  $("apply-schema").onclick = () => applySchemaProposal().catch(showError);
  $("refresh-version").onclick = () => loadVersion().catch(showError);
  $("run-release-checks").onclick = () => runReleaseChecks().catch(showError);
  $("evaluate-release-readiness").onclick = () => evaluateReleaseReadiness().catch(showError);
  $("propose-normalization").onclick = () => proposeNormalization().catch(showError);
  $("export-application").onclick = () => exportApplication().catch(showError);
  $("prepare-version").onclick = () => prepareVersion().catch(showError);
  $("send-testing").onclick = () => sendToTesting().catch(showError);
  $("accept-observed-change").onclick = () => acceptObservedChange().catch(showError);
  $("restore-desired-state").onclick = () => restoreDesiredState().catch(showError);
  $("restore-environment").onchange = () => {
    const allowed = $("restore-environment").value === "production" ? state.capabilities.canPublishProduction : state.capabilities.canDeployTesting;
    $("restore-desired-state").disabled = !allowed || !state.version?.blueprints?.length;
  };
  $("refresh-studio").onclick = () => refreshStudio().catch(showError);
  window.addEventListener("message", event => {
    if (event.origin === location.origin && event.data?.type === "feltus-preview-ready") setStatus("Preview loaded successfully.");
  });
  window.addEventListener("pagehide", () => {
    if (!["running", "starting"].includes(state.preview.status)) return;
    if (previewHeartbeatTimer) clearInterval(previewHeartbeatTimer);
    previewHeartbeatTimer = null;
    fetch(projectQuery("/api/code/preview/stop"), {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: projectId })
    }).catch(() => {});
  });
  document.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === "s") { event.preventDefault(); saveFile().catch(showError); }
    if (event.key.toLowerCase() === "p") { event.preventDefault(); $("go-to-file").click(); }
    if (event.key.toLowerCase() === "g") { event.preventDefault(); goToLine(); }
    if (event.key.toLowerCase() === "f" && state.activePane === "code") { event.preventDefault(); findInFile(); }
    if (event.key.toLowerCase() === "h" && state.activePane === "code" && state.capabilities.canEditCode) { event.preventDefault(); replaceInFile(); }
  });
}

async function compareDiff(staged) {
  const result = await api(projectQuery(`/api/code/git/diff?staged=${staged}`));
  showTaskOutput({ task: staged ? "Staged diff" : "Working diff", code: 0, stdout: result.stdout || "No changes.", stderr: result.stderr }, "Ready");
  switchPane("terminal");
}

async function exportApplication() {
  const commit = $("export-checkpoint").value;
  const query = commit ? `?commit=${encodeURIComponent(commit)}` : "";
  setStatus("Preparing a portable application export…");
  const response = await fetch(projectQuery(`/api/code/export${query}`), {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/x-tar" }
  });
  if (!response.ok) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    throw new Error(payload.error || `Export failed (${response.status}).`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "feltus-application.tar";
  link.click();
  URL.revokeObjectURL(objectUrl);
  setStatus("Portable application export ready.");
}

async function boot() {
  bindEvents();
  if (!projectId) {
    setStatus("No authorized FELTUS app was selected.", true);
    $("initialize-workspace").disabled = true;
    return;
  }
  try {
    await loadWorkspace();
  } catch (error) {
    showError(error);
  }
}

boot();
