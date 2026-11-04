import { APP_TYPES, SETUP_STEPS, resolveAppRoute, resumeSetupPath, nextSetupRoute, previousSetupRoute } from "/app-wizard-lib.js";

const $ = (selector, root = document) => root.querySelector(selector);
const view = $("#view");
const toast = $("#toast");
const savedIndicator = $("#saved-indicator");
const topCreate = $("#top-create");
const typeLabels = {
  web_application: "Web Application", internal_tool: "Internal Tool", api_backend: "API / Backend",
  ai_application: "AI Application", data_application: "Data Application", other: "Other"
};
const typeIcons = { web_application: "◧", internal_tool: "▦", api_backend: "⌘", ai_application: "✧", data_application: "▤", other: "✦" };
const stepLabels = { basics: "App Details", data: "Data", relationships: "Relationships", documents: "Documents", ai: "AI", code: "Code", environment: "Environment", review: "Review", build: "Build" };
const pageGroups = [
  { label: "OVERVIEW", pages: [["overview", "Overview", "⌂"]] },
  { label: "BUILD", pages: [["code", "Code", "⌘"], ["data", "Data", "▤"], ["relationships", "Relationships", "⌁"], ["documents", "Documents", "▧"], ["ai", "AI", "✧"]] },
  { label: "OPERATE", pages: [["deployments", "Deployments", "↗"], ["environments", "Environments", "◉"], ["infrastructure", "Infrastructure", "◈"], ["logs", "Logs", "≋"]] },
  { label: "MANAGE", pages: [["team", "Team", "♧"], ["settings", "Settings", "⚙"]] }
];
const state = { apps: [], filter: "all", app: null, route: null, formBusy: false, loaded: false, activity: [], health: null };
let toastTimer;
let saveTimer;
let formValues = null;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function dateLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Just now";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function showToast(message, kind = "success") {
  toast.textContent = message;
  toast.className = `toast${kind === "error" ? " error" : ""}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

function setSaved(message, error = false) {
  savedIndicator.textContent = message;
  savedIndicator.style.color = error ? "var(--danger)" : "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.field = payload.field;
    throw error;
  }
  return payload;
}

async function checkSession() {
  const session = await api("/api/auth/session");
  if (session.mode === "local-development" || session.authenticated) return session;
  return new Promise(resolve => renderLogin(resolve));
}

function renderLogin(resolve) {
  view.innerHTML = `<div class="main-wrap"><div class="entry-card card" style="max-width:520px;margin:4vh auto"><p class="eyebrow">Private workspace</p><h1 class="page-title" style="font-size:38px">Welcome back.</h1><p class="page-lede">Sign in to open your FELTUS applications.</p><form id="login-form"><div class="field"><label for="login-email">Owner email</label><input class="input" id="login-email" type="email" autocomplete="username" required maxlength="320"></div><div class="field"><label for="login-password">Password</label><input class="input" id="login-password" type="password" autocomplete="current-password" required maxlength="1024"></div><div id="login-error" class="field-error" role="alert"></div><div class="action-row"><button id="login-submit" class="button button-primary" type="submit">Sign in</button></div></form></div></div>`;
  $("#login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("#login-submit");
    button.disabled = true;
    button.textContent = "Signing in…";
    $("#login-error").textContent = "";
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: $("#login-email").value, password: $("#login-password").value }) });
      resolve({ authenticated: true });
    } catch (error) {
      $("#login-error").textContent = error.message;
      button.disabled = false;
      button.textContent = "Sign in";
    }
  });
}

async function loadApps() {
  const apps = await api("/api/apps");
  state.apps = Array.isArray(apps) ? apps : [];
}

async function loadApp(appId) {
  const result = await api(`/api/apps/${encodeURIComponent(appId)}`);
  state.app = result.app;
  return state.app;
}

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", path);
  else if (location.pathname + location.search !== path) history.pushState({}, "", path);
  renderRoute();
}

function appCard(app) {
  const status = app.setup_status || (app.deployment_state === "deployed" ? "active" : "active");
  const draft = ["draft", "configuring"].includes(status);
  const primaryHref = draft ? resumeSetupPath(app) : `/apps/${encodeURIComponent(app.id)}`;
  const primaryText = draft ? "Resume Setup" : "Open App";
  const description = app.description || `${typeLabels[app.app_type] || "Application"} · ${String(app.environment || "development").replaceAll("_", " ")}`;
  const completion = Array.isArray(app.setup_completed_steps) ? app.setup_completed_steps.length : 0;
  return `<article class="app-card card"><div class="app-card-top"><span class="app-icon" style="color:${esc(app.accent_color || "var(--accent)")};background:${esc(app.accent_color || "#62D6C9")}18;border-color:${esc(app.accent_color || "#62D6C9")}35">${esc(app.app_icon || typeIcons[app.app_type] || "✦")}</span><span class="status-pill ${esc(status)}"><i class="status-dot"></i>${esc(status.replaceAll("_", " "))}</span></div><h3>${esc(app.app_name)}</h3><p>${esc(description)}</p><p class="app-card-meta">${esc(typeLabels[app.app_type] || "Application")} · ${esc((app.environment || "development").replaceAll("_", " "))}</p><div class="card-footer"><span class="subtle">${draft ? `${completion} of 9 steps saved` : `Updated ${dateLabel(app.setup_updated_at || app.created_at)}`}</span></div><div class="action-row" style="margin-top:13px"><a class="button ${draft ? "button-primary" : ""}" href="${primaryHref}" data-nav>${primaryText}</a><a class="button button-quiet" href="/apps/${encodeURIComponent(app.id)}" data-nav>View Details</a>${status !== "archived" ? `<button class="button button-quiet" type="button" data-archive="${esc(app.id)}">Archive</button>` : ""}</div></article>`;
}

function healthSummary() {
  const services = state.health?.services || {};
  const items = [["Runtime", services.runtime?.status], ["Database", services.database?.status], ["AI", services.ai?.status]];
  return `<section class="health-strip card"><div><h2 class="section-title">Platform status</h2><p class="section-subtitle">A quick view of the services that power your apps.</p></div><div class="health-items">${items.map(([name, status]) => `<span class="health-chip"><i class="status-dot ${status === "online" ? "online" : status === "offline" ? "offline" : ""}"></i>${esc(name)} · ${esc(status || "checking")}</span>`).join("")}</div></section>`;
}

function activitySection() {
  if (!state.activity.length) return `<div class="empty-state"><strong>No recent activity</strong>Activity will appear here as you work on your apps.</div>`;
  return `<div class="activity-list">${state.activity.slice(0, 5).map(item => `<div class="activity-item"><i class="status-dot ${item.severity === "error" ? "offline" : "online"}"></i><div><strong>${esc(item.message || item.event_type || "App activity")}</strong><small>${esc(item.event_source || "FELTUS")} · ${esc(dateLabel(item.created_at))}${item.app_id ? ` · ${esc(state.apps.find(app => app.id === item.app_id)?.app_name || "App")}` : ""}</small></div></div>`).join("")}</div>`;
}

async function renderHome() {
  topCreate.hidden = false;
  view.innerHTML = `<div class="main-wrap"><div class="hero-row"><div><p class="eyebrow">Your app workspace</p><h1 class="page-title">What will you build?</h1><p class="page-lede">Create, configure, and grow your applications in one guided workspace.</p></div><a class="button button-primary" href="/apps/new" data-nav>＋ Create New App</a></div><section class="home-section"><div class="section-head"><div><h2 class="section-title">Your applications</h2><p class="section-subtitle">Open a finished app or pick up where you left off.</p></div><a class="button button-quiet" href="/apps" data-nav>View all apps</a></div>${state.apps.length ? `<div class="app-grid">${state.apps.slice(0, 6).map(appCard).join("")}</div>` : `<div class="empty-state"><strong>Your next idea starts here</strong>Create an app and FELTUS will guide you through setup, one clear step at a time.<div class="action-row" style="justify-content:center"><a class="button button-primary" href="/apps/new" data-nav>Create your first app</a></div></div>`}</section><section class="home-section"><div class="section-head"><div><h2 class="section-title">Recent activity</h2><p class="section-subtitle">A short history of what’s been happening.</p></div></div>${activitySection()}</section>${healthSummary()}</div>`;
  bindArchiveActions();
}

function renderApps() {
  topCreate.hidden = false;
  const filters = ["all", "draft", "active", "archived"];
  const apps = state.apps.filter(app => state.filter === "all" || (app.setup_status || "active") === state.filter || (state.filter === "draft" && app.setup_status === "configuring"));
  view.innerHTML = `<div class="main-wrap"><div class="hero-row"><div><p class="eyebrow">App launcher</p><h1 class="page-title">Applications</h1><p class="page-lede">Manage your apps and continue setup at any time.</p></div><a class="button button-primary" href="/apps/new" data-nav>＋ Create New App</a></div><div class="filter-row" role="group" aria-label="Filter applications">${filters.map(filter => `<button class="filter-button ${state.filter === filter ? "active" : ""}" type="button" data-filter="${filter}" aria-pressed="${state.filter === filter}">${filter === "all" ? "All apps" : filter[0].toUpperCase() + filter.slice(1)}</button>`).join("")}</div><section class="home-section">${apps.length ? `<div class="app-grid">${apps.map(appCard).join("")}</div>` : `<div class="empty-state"><strong>${state.filter === "all" ? "No applications yet" : `No ${esc(state.filter)} apps`}</strong>${state.filter === "all" ? `Start with an idea and create your first app.` : `Apps in this category will appear here.`}${state.filter === "all" ? `<div class="action-row" style="justify-content:center"><a class="button button-primary" href="/apps/new" data-nav>Create New App</a></div>` : ""}</div>`}</section></div>`;
  view.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => { state.filter = button.dataset.filter; renderApps(); }));
  bindArchiveActions();
}

function renderEntry() {
  topCreate.hidden = true;
  const flow = ["App Details", "Data", "Relationships", "Documents", "AI", "Code", "Environment", "Review", "Build"];
  view.innerHTML = `<div class="main-wrap"><div class="entry-card card"><p class="eyebrow">Create App · Guided setup</p><h1 class="page-title">Create a new application</h1><p class="page-lede">FELTUS will guide you through setting up your application, data, AI, code, and environments. Your choices stay attached to your app as you go.</p><div class="flow-preview">${flow.map((label, index) => `<div class="flow-item"><span class="flow-number">${String(index + 1).padStart(2, "0")}</span><b>${label}</b></div>`).join("")}</div><div class="entry-actions"><a class="button button-quiet" href="/apps" data-nav>Cancel</a><a class="button button-primary" href="/apps/new/basics" data-nav>Start Setup <span aria-hidden="true">→</span></a></div></div></div>`;
}

function setupShell(app, currentStep, content) {
  const currentIndex = Math.max(0, SETUP_STEPS.indexOf(currentStep));
  const completed = new Set(Array.isArray(app.setup_completed_steps) ? app.setup_completed_steps : []);
  const stepLinks = SETUP_STEPS.map((step, index) => {
    const isCurrent = step === currentStep;
    const done = completed.has(step);
    const href = app.id ? `/apps/${encodeURIComponent(app.id)}/setup/${step}` : (step === "basics" ? "/apps/new/basics" : "");
    const item = `<span class="step-index">${done ? "✓" : index + 1}</span>${stepLabels[step]}`;
    if (!href) return `<span class="step-link" aria-disabled="true" title="Finish App Details to save this step">${item}</span>`;
    return `<a class="step-link ${isCurrent ? "current" : ""} ${done ? "done" : ""}" href="${href}" data-nav aria-current="${isCurrent ? "step" : "false"}">${item}</a>`;
  }).join("");
  const backPath = app.id ? previousSetupRoute(app.id, currentStep) : "/apps/new";
  const continuePath = currentStep === "basics" ? (app.id ? nextSetupRoute(app.id, currentStep) : "/apps/new/basics") : null;
  const label = currentStep === "basics" ? "Continue to Data" : currentStep === "review" ? "Review App" : `Continue to ${stepLabels[SETUP_STEPS[currentIndex + 1]] || "next step"}`;
  const mobileProgress = Math.round(((currentIndex + 1) / SETUP_STEPS.length) * 100);
  return `<div class="wizard-layout"><aside class="wizard-rail card"><a class="rail-app" href="/apps" data-nav><span class="app-icon" style="color:${esc(app.accent_color || "var(--accent)")}">${esc(app.app_icon || "✦")}</span><span><strong>${esc(app.app_name || "New application")}</strong><span>Application setup</span></span></a><p class="progress-count">Step ${currentIndex + 1} of ${SETUP_STEPS.length}</p><nav class="step-list" aria-label="Setup progress">${stepLinks}</nav><div class="mobile-stepper"><span>Step ${currentIndex + 1} of ${SETUP_STEPS.length}</span><span class="mobile-progress"><span style="width:${mobileProgress}%"></span></span><b>${stepLabels[currentStep]}</b></div></aside><section class="wizard-main"><div class="wizard-actions"><button type="button" class="button button-quiet" data-action="save">Save Draft</button><button type="button" class="button button-quiet" data-action="exit">Exit Setup</button></div><div class="wizard-content card">${content}</div><div class="wizard-nav"><a class="button button-quiet" href="${backPath}" data-nav>← Back</a><div class="wizard-nav-right">${continuePath ? `<button class="button button-primary" type="button" data-action="continue">${label} →</button>` : `<button class="button" type="button" disabled title="The remaining setup steps arrive in the next phase.">Continue unavailable</button>`}</div></div></section></div>`;
}

function basicsContent(app, isNew) {
  const form = formValues || {
    app_name: app?.app_name || "", description: app?.description || "", app_type: app?.app_type || "web_application",
    app_icon: app?.app_icon || typeIcons[app?.app_type] || "✦", accent_color: app?.accent_color || "#62D6C9"
  };
  const title = isNew ? "Tell us about your app." : "App details";
  const types = APP_TYPES.map(type => `<button type="button" class="type-card ${form.app_type === type ? "selected" : ""}" data-type="${type}" aria-pressed="${form.app_type === type}"><span class="type-icon">${typeIcons[type]}</span><span><b>${typeLabels[type]}</b><small>${type === "web_application" ? "A site or web product" : type === "internal_tool" ? "A tool for your team" : type === "api_backend" ? "Services and integrations" : type === "ai_application" ? "AI-powered experiences" : type === "data_application" ? "Data-focused workflows" : "Something different"}</small></span></button>`).join("");
  return `<p class="eyebrow">Step 1 · App details</p><h1 class="page-title">${title}</h1><p class="page-lede">Start with the essentials. You can change these details later.</p><form id="basics-form" novalidate><div class="field"><label for="app-name">App name <span aria-hidden="true">*</span></label><input class="input" id="app-name" name="app_name" type="text" maxlength="200" required autocomplete="off" placeholder="e.g. Northstar Support" value="${esc(form.app_name)}"><span id="app-name-error" class="field-error" aria-live="polite"></span></div><div class="field"><label for="app-description">Description <span class="muted-line">· optional</span></label><textarea class="textarea" id="app-description" name="description" maxlength="2000" placeholder="What will this application help people do?">${esc(form.description)}</textarea><span class="field-help">A short sentence is enough. This helps keep your app easy to recognize.</span></div><div class="field"><label>App type</label><div class="type-grid" role="group" aria-label="App type">${types}</div><span id="app-type-error" class="field-error" aria-live="polite"></span></div><div class="field"><label>Visual identity <span class="muted-line">· optional</span></label><div class="identity-row"><div><span class="field-help">Choose an icon</span><div class="icon-picker" style="margin-top:9px">${["✦", "◉", "⌘", "▤", "✧", "◈", "⬡", "◒"].map(icon => `<button class="icon-option ${form.app_icon === icon ? "selected" : ""}" type="button" data-icon="${icon}" aria-label="Use ${icon} app icon" aria-pressed="${form.app_icon === icon}">${icon}</button>`).join("")}</div></div><div><label for="accent-color" class="field-help">Accent color</label><div class="color-picker" style="margin-top:6px"><input id="accent-color" type="color" value="${esc(form.accent_color)}" aria-label="App accent color"><span class="muted-line" id="accent-value">${esc(form.accent_color.toUpperCase())}</span></div></div></div></div><div class="preview-strip"><span class="app-icon" id="preview-icon" style="color:${esc(form.accent_color)};background:${esc(form.accent_color)}18;border-color:${esc(form.accent_color)}35">${esc(form.app_icon)}</span><span><strong id="preview-name">${esc(form.app_name || "Your app name")}</strong><small>${typeLabels[form.app_type] || "Application"}</small></span></div><div id="basics-error" class="field-error" role="alert"></div></form>`;
}

function renderSetup(app, step) {
  topCreate.hidden = true;
  state.app = app;
  const content = step === "basics" ? basicsContent(app, !app.id) : `<p class="eyebrow">Step ${SETUP_STEPS.indexOf(step) + 1} · ${esc(stepLabels[step])}</p><h1 class="page-title">${esc(stepLabels[step])} is coming next.</h1><p class="page-lede">Your app and setup progress are saved. This setup area will connect to the existing FELTUS ${esc(stepLabels[step].toLowerCase())} tools in the next phase.</p><div class="placeholder-card card"><span class="placeholder-badge">Saved setup</span><h2>${esc(app.app_name)}</h2><p>You can go back to App Details, leave setup, or return here when this step becomes available.</p></div>`;
  view.innerHTML = setupShell(app, step, content);
  if (step === "basics") bindBasicsForm(app);
  bindWizardShell(app, step);
}

function getFormValues() {
  const form = $("#basics-form");
  if (!form) return formValues;
  return {
    app_name: $("#app-name").value,
    description: $("#app-description").value,
    app_type: form.dataset.appType || "web_application",
    app_icon: form.dataset.appIcon || "✦",
    accent_color: $("#accent-color").value
  };
}

function renderBasicsPreview() {
  const values = getFormValues();
  if (!values) return;
  const icon = $("#preview-icon");
  const title = $("#preview-name");
  const color = $("#accent-color");
  if (icon) {
    icon.textContent = values.app_icon;
    icon.style.color = values.accent_color;
    icon.style.background = `${values.accent_color}18`;
    icon.style.borderColor = `${values.accent_color}35`;
  }
  if (title) title.textContent = values.app_name.trim() || "Your app name";
  const type = $(".preview-strip small");
  if (type) type.textContent = typeLabels[values.app_type] || "Application";
  const accentValue = $("#accent-value");
  if (accentValue && color) accentValue.textContent = color.value.toUpperCase();
  view.querySelectorAll("[data-type]").forEach(button => {
    const selected = button.dataset.type === values.app_type;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  view.querySelectorAll("[data-icon]").forEach(button => {
    const selected = button.dataset.icon === values.app_icon;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function bindBasicsForm(app) {
  const form = $("#basics-form");
  form.dataset.appType = formValues?.app_type || app?.app_type || "web_application";
  form.dataset.appIcon = formValues?.app_icon || app?.app_icon || typeIcons[app?.app_type] || "✦";
  form.addEventListener("input", event => {
    formValues = getFormValues();
    if (event.target.name === "app_name") {
      const invalid = !event.target.value.trim();
      event.target.setAttribute("aria-invalid", String(invalid));
      $("#app-name-error").textContent = invalid ? "Enter an app name to continue." : "";
      $("#basics-error").textContent = "";
    }
    renderBasicsPreview();
  });
  form.addEventListener("change", () => { formValues = getFormValues(); renderBasicsPreview(); });
  view.querySelectorAll("[data-type]").forEach(button => button.addEventListener("click", () => {
    form.dataset.appType = button.dataset.type;
    formValues = getFormValues();
    renderBasicsPreview();
  }));
  view.querySelectorAll("[data-icon]").forEach(button => button.addEventListener("click", () => {
    form.dataset.appIcon = button.dataset.icon;
    formValues = getFormValues();
    renderBasicsPreview();
  }));
  $("#app-name").focus({ preventScroll: true });
  $("#basics-form").addEventListener("submit", event => {
    event.preventDefault();
    const button = view.querySelector('[data-action="continue"]');
    if (button) continueSetup(app, "basics", button);
  });
}

function bindWizardShell(app, step) {
  view.querySelectorAll('[data-action="save"]').forEach(button => button.addEventListener("click", () => saveDraft(app, step)));
  view.querySelectorAll('[data-action="exit"]').forEach(button => button.addEventListener("click", async () => {
    const saved = await saveDraft(app, step, { quiet: true });
    if (!saved) {
      const message = app?.id
        ? "Some changes could not be saved. Exit and keep the last saved version?"
        : "No app draft has been created yet. Exit without saving this form?";
      if (window.confirm(message)) navigate("/apps");
      return;
    }
    const leave = window.confirm("Your progress has been saved. Exit to Apps?");
    if (leave) navigate("/apps");
  }));
  view.querySelectorAll('[data-action="continue"]').forEach(button => button.addEventListener("click", () => continueSetup(app, step, button)));
  if (step === "basics") {
    view.querySelectorAll("a[data-nav]").forEach(link => link.addEventListener("click", async event => {
      const target = link.getAttribute("href");
      if (!target || target === location.pathname) return;
      if (state.formBusy) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const values = getFormValues();
      const changed = values.app_name !== (app?.app_name || "") ||
        values.description !== (app?.description || "") ||
        values.app_type !== (app?.app_type || "web_application") ||
        values.app_icon !== (app?.app_icon || "◧") ||
        values.accent_color.toUpperCase() !== (app?.accent_color || "#62D6C9").toUpperCase();
      if (!changed) return;
      event.preventDefault();
      event.stopPropagation();
      if (!app?.id) {
        if (window.confirm("Leave this form without saving? No app draft has been created.")) navigate(target);
        return;
      }
      const saved = await saveDraft(app, step, { quiet: true });
      if (saved) {
        showToast("Your changes are saved.");
        navigate(target);
      } else if (window.confirm("Some changes could not be saved. Leave and keep the last saved version?")) {
        navigate(target);
      }
    }));
  }
}

function bindArchiveActions() {
  view.querySelectorAll("[data-archive]").forEach(button => button.addEventListener("click", async () => {
    const appId = button.dataset.archive;
    const app = state.apps.find(item => item.id === appId);
    if (!app || !window.confirm(`Archive “${app.app_name}”? You can still view it from the Archived filter.`)) return;
    button.disabled = true;
    button.textContent = "Archiving…";
    try {
      await api(`/api/apps/${encodeURIComponent(appId)}/archive`, { method: "POST", body: "{}" });
      await loadApps();
      showToast("App archived.");
      await renderRoute();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Archive";
      showToast(error.message, "error");
    }
  }));
}

function readBasics() {
  const values = getFormValues();
  if (!values) return null;
  values.app_name = values.app_name.trim();
  values.description = values.description.trim();
  $("#app-name").setAttribute("aria-invalid", String(!values.app_name));
  $("#app-name-error").textContent = values.app_name ? "" : "Enter an app name to continue.";
  if (!values.app_name) {
    $("#app-name").focus();
    return null;
  }
  return values;
}

async function saveDraft(app, step, { quiet = false } = {}) {
  if (state.formBusy) return false;
  let values = null;
  if (step === "basics") {
    values = readBasics();
    if (!values) return false;
  }
  state.formBusy = true;
  setSaved("Saving…");
  const button = view.querySelector('[data-action="save"]');
  const exitButton = view.querySelector('[data-action="exit"]');
  if (button) button.disabled = true;
  if (exitButton) exitButton.disabled = true;
  try {
    let savedApp = app;
    if (!savedApp?.id) {
      const result = await api("/api/apps", { method: "POST", body: JSON.stringify({ ...values, continue_setup: false }) });
      savedApp = result.app;
      history.replaceState({}, "", `/apps/${encodeURIComponent(savedApp.id)}/setup/basics`);
    } else {
      const payload = step === "basics" ? { ...values, setup_current_step: step, ...(["draft", "configuring"].includes(savedApp.setup_status) ? { setup_status: "draft" } : {}) } : { setup_current_step: step };
      const result = await api(`/api/apps/${encodeURIComponent(savedApp.id)}/setup`, { method: "PATCH", body: JSON.stringify(payload) });
      savedApp = result.app;
    }
    state.app = savedApp;
    await loadApps();
    formValues = { app_name: savedApp.app_name, description: savedApp.description || "", app_type: savedApp.app_type, app_icon: savedApp.app_icon, accent_color: savedApp.accent_color };
    setSaved("Draft saved");
    if (!quiet) showToast("Your draft is saved and ready to resume.");
    if (step === "basics" && !quiet) renderSetup(savedApp, step);
    return true;
  } catch (error) {
    setSaved("Couldn’t save", true);
    if (error.field === "app_name") {
      $("#app-name").setAttribute("aria-invalid", "true");
      $("#app-name-error").textContent = error.message;
    } else {
      $("#basics-error") && ($("#basics-error").textContent = error.message);
      showToast(error.message, "error");
    }
    return false;
  } finally {
    state.formBusy = false;
    if (button?.isConnected) button.disabled = false;
    if (exitButton?.isConnected) exitButton.disabled = false;
  }
}

async function continueSetup(app, step, button) {
  if (step !== "basics") return;
  if (state.formBusy) return;
  const values = readBasics();
  if (!values) return;
  state.formBusy = true;
  button.disabled = true;
  view.querySelectorAll('.wizard-actions button, .wizard-nav a').forEach(control => { control.dataset.wasDisabled = String(control.disabled || false); control.disabled = true; });
  const original = button.innerHTML;
  button.textContent = "Saving app…";
  setSaved("Saving…");
  try {
    let saved;
    if (!app?.id) {
      saved = (await api("/api/apps", { method: "POST", body: JSON.stringify({ ...values, continue_setup: true }) })).app;
    } else {
      saved = (await api(`/api/apps/${encodeURIComponent(app.id)}/setup`, {
        method: "PATCH",
        body: JSON.stringify({ ...values, setup_current_step: "data", setup_completed_steps: [...new Set([...(app.setup_completed_steps || []), "basics"])], setup_status: "configuring" })
      })).app;
    }
    state.app = saved;
    formValues = null;
    await loadApps();
    setSaved("Progress saved");
    navigate(`/apps/${encodeURIComponent(saved.id)}/setup/data`, { replace: !app?.id });
  } catch (error) {
    setSaved("Couldn’t save", true);
    if (error.field === "app_name") {
      $("#app-name").setAttribute("aria-invalid", "true");
      $("#app-name-error").textContent = error.message;
    } else {
      $("#basics-error").textContent = error.message;
    }
  } finally {
    state.formBusy = false;
    if (button.isConnected) { button.disabled = false; button.innerHTML = original; }
    view.querySelectorAll('.wizard-actions button, .wizard-nav a').forEach(control => { if (control.dataset.wasDisabled !== "true") control.disabled = false; delete control.dataset.wasDisabled; });
  }
}

async function renderSetupRoute(route) {
  const app = route.appId ? await loadApp(route.appId) : null;
  if (app?.setup_status === "archived") {
    navigate(`/apps/${encodeURIComponent(app.id)}` , { replace: true });
    return;
  }
  if (route.kind === "new-basics") {
    formValues = null;
    renderSetup({ app_name: "", app_type: "web_application", app_icon: "◧", accent_color: "#62D6C9", setup_completed_steps: [] }, "basics");
  } else {
    if (route.step === "basics") formValues = { app_name: app.app_name, description: app.description || "", app_type: app.app_type, app_icon: app.app_icon, accent_color: app.accent_color };
    renderSetup(app, route.step);
  }
}

function renderOverview(app) {
  topCreate.hidden = false;
  const draft = ["draft", "configuring"].includes(app.setup_status);
  const status = app.setup_status || "active";
  const progress = Array.isArray(app.setup_completed_steps) ? app.setup_completed_steps.length : 0;
  const page = `<div class="overview-grid"><section class="overview-card card"><div class="overview-identity"><span class="app-icon" style="color:${esc(app.accent_color || "var(--accent)")};background:${esc(app.accent_color || "#62D6C9")}18;border-color:${esc(app.accent_color || "#62D6C9")}35">${esc(app.app_icon || "✦")}</span><div><h1>${esc(app.app_name)}</h1><p>${esc(typeLabels[app.app_type] || "Application")}</p></div></div><div class="meta-list"><div class="meta-row"><span>Status</span><strong><i class="status-dot ${status === "active" ? "online" : ""}"></i> ${esc(status.replaceAll("_", " "))}</strong></div><div class="meta-row"><span>Environment</span><strong>${esc((app.environment || "development").replaceAll("_", " "))}</strong></div><div class="meta-row"><span>Created</span><strong>${esc(dateLabel(app.created_at))}</strong></div><div class="meta-row"><span>Last updated</span><strong>${esc(dateLabel(app.setup_updated_at || app.created_at))}</strong></div></div><div class="action-row">${draft ? `<a class="button button-primary" href="${resumeSetupPath(app)}" data-nav>Continue Setup</a>` : `<span class="button" aria-disabled="true" title="App preview is not available in this phase">Open App · unavailable</span>`}<a class="button" href="/apps/${encodeURIComponent(app.id)}/setup/basics" data-nav>Edit Setup</a></div></section><section class="overview-card card"><h2 class="section-title">Build status</h2><p class="section-subtitle">${draft ? "Your app is saved. Continue setup when you’re ready." : "This app’s workspace is ready to explore."}</p><div class="detail-grid" style="grid-template-columns:1fr 1fr"><div class="detail-tile"><span>Setup progress</span><strong>${draft ? `${progress} of 9 steps` : "Setup complete"}</strong></div><div class="detail-tile"><span>Health</span><strong>Not checked</strong></div><div class="detail-tile"><span>Current version</span><strong>Not available</strong></div><div class="detail-tile"><span>Repository</span><strong>Not checked</strong></div><div class="detail-tile"><span>Database</span><strong>Not checked</strong></div><div class="detail-tile"><span>AI</span><strong>Not checked</strong></div></div></section></div><section class="overview-card card" style="margin-top:16px"><div class="section-head"><div><h2 class="section-title">Recent activity</h2><p class="section-subtitle">Updates for this application.</p></div>${state.activity.length ? `<a class="button button-quiet" href="/apps/${encodeURIComponent(app.id)}/logs" data-nav>View Logs</a>` : ""}</div>${activitySection()}</section>`;
  renderWorkspaceShell(app, "overview", page);
}

function renderWorkspaceShell(app, page, content) {
  const groups = pageGroups.map(group => `<div class="workspace-nav-label">${group.label}</div><nav>${group.pages.map(([key, label, icon]) => `<a class="workspace-link ${page === key ? "active" : ""}" href="${key === "overview" ? `/apps/${encodeURIComponent(app.id)}` : `/apps/${encodeURIComponent(app.id)}/${key}`}" data-nav ${page === key ? 'aria-current="page"' : ""}><span class="workspace-link-icon">${icon}</span>${label}</a>`).join("")}</nav>`).join("");
  view.innerHTML = `<div class="workspace-layout"><aside class="workspace-sidebar"><a class="workspace-heading" href="/apps/${encodeURIComponent(app.id)}" data-nav><span class="app-icon" style="color:${esc(app.accent_color || "var(--accent)")}">${esc(app.app_icon || "✦")}</span><span><strong>${esc(app.app_name)}</strong><small>Application workspace</small></span></a>${groups}<div style="padding:18px 9px"><a href="/apps" data-nav class="muted-line">← All apps</a></div></aside><section class="workspace-content">${content}</section></div>`;
}

function renderWorkspacePlaceholder(app, page) {
  const labels = Object.fromEntries(pageGroups.flatMap(group => group.pages.map(([key, label]) => [key, label])));
  const label = labels[page] || "Workspace";
  if (page === "code") {
    const content = `<p class="eyebrow">Build · ${esc(label)}</p><h1 class="page-title">Project code</h1><p class="page-lede">A private repository and FELTUS CODE assistant for this app.</p><div class="placeholder-card card" style="max-width:none;height:calc(100vh - 300px);min-height:520px;padding:0;overflow:hidden"><iframe title="FELTUS CODE project workspace" src="/api/code/ui?app_id=${encodeURIComponent(app.id)}" style="width:100%;height:100%;border:0;background:#101820" loading="lazy" referrerpolicy="no-referrer"></iframe></div>`;
    renderWorkspaceShell(app, page, content);
    return;
  }
  if (page === "logs") {
    const activities = state.activity.filter(item => item.app_id === app.id);
    const content = `<p class="eyebrow">Operate · Logs</p><h1 class="page-title">App activity</h1><p class="page-lede">Recent events recorded for ${esc(app.app_name)}.</p><section class="placeholder-card card" style="max-width:none">${activities.length ? `<div class="activity-list">${activities.map(item => `<div class="activity-item"><i class="status-dot ${item.severity === "error" ? "offline" : "online"}"></i><div><strong>${esc(item.message || item.event_type || "App activity")}</strong><small>${esc(item.event_type || "Event")} · ${esc(dateLabel(item.created_at))}</small></div></div>`).join("")}</div>` : `<div class="empty-state"><strong>No activity recorded yet</strong>Events will appear here as this app is configured.</div>`}</section>`;
    renderWorkspaceShell(app, page, content);
    return;
  }
  const capability = ({ data: "Relational Modeler", relationships: "Relationship Builder", documents: "Private Documents", ai: "Private AI Hub", deployments: "Deployment Control Plane", environments: "Environment Setup", infrastructure: "Infrastructure", team: "Team Management", settings: "App Settings" })[page] || label;
  const reason = page === "team" ? "Team access is not available in the current owner-only sign-in experience." : page === "deployments" ? "Deployment setup will be connected after the build and artifact workflow is ready." : "This screen will connect to the existing FELTUS capability in the next setup phase.";
  const content = `<p class="eyebrow">${esc(pageGroups.find(group => group.pages.some(item => item[0] === page))?.label || "BUILD")} · ${esc(label)}</p><h1 class="page-title">${esc(label)}</h1><p class="page-lede">${esc(capability)} for ${esc(app.app_name)}.</p><div class="placeholder-card card"><span class="placeholder-badge">Available in a later phase</span><h2>${esc(capability)}</h2><p>${esc(reason)}</p><a class="button button-quiet" href="/apps/${encodeURIComponent(app.id)}" data-nav>Back to Overview</a></div>`;
  renderWorkspaceShell(app, page, content);
}

async function renderAppRoute(route) {
  const app = await loadApp(route.appId);
  const activityPath = `/api/activity?app_id=${encodeURIComponent(app.id)}&limit=20`;
  state.activity = await api(activityPath).catch(() => []);
  if (route.kind === "app-overview") renderOverview(app);
  else renderWorkspacePlaceholder(app, route.page);
}

function renderNotFound() {
  topCreate.hidden = false;
  view.innerHTML = `<div class="main-wrap"><div class="empty-state"><strong>We couldn’t find that page</strong>The link may be outdated, or the app may no longer be available.<div class="action-row" style="justify-content:center"><a class="button button-primary" href="/apps" data-nav>Back to Apps</a></div></div></div>`;
}

async function renderRoute() {
  const route = resolveAppRoute(location.pathname);
  state.route = route;
  view.setAttribute("aria-busy", "true");
  try {
    if (route.kind === "home" || route.kind === "apps") {
      await loadApps();
      if (route.kind === "home") {
        const [activity, health] = await Promise.all([
          api("/api/activity?limit=5").catch(() => []),
          api("/api/system-health").catch(() => null)
        ]);
        state.activity = Array.isArray(activity) ? activity : [];
        state.health = health;
        await renderHome();
      } else renderApps();
    } else if (route.kind === "new-app") renderEntry();
    else if (route.kind === "new-basics" || route.kind === "setup-step") await renderSetupRoute(route);
    else if (route.kind === "app-overview" || route.kind === "workspace-page") await renderAppRoute(route);
    else renderNotFound();
  } catch (error) {
    topCreate.hidden = false;
    view.innerHTML = `<div class="main-wrap"><div class="error-banner" role="alert">${esc(error.message)} <button class="button button-quiet" type="button" data-action="retry">Try again</button></div></div>`;
    view.querySelector('[data-action="retry"]').addEventListener("click", renderRoute);
  } finally {
    view.setAttribute("aria-busy", "false");
  }
}

document.addEventListener("click", event => {
  const link = event.target.closest("a[data-nav]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(link.getAttribute("href"));
});

topCreate.addEventListener("click", () => navigate("/apps/new"));
window.addEventListener("popstate", () => { formValues = null; renderRoute(); });

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !toast.hidden) toast.hidden = true;
});

async function start() {
  try {
    const session = await checkSession();
    if (session?.authenticated === false) return;
    state.loaded = true;
    await renderRoute();
  } catch (error) {
    view.innerHTML = `<div class="main-wrap"><div class="error-banner" role="alert">FELTUS could not verify your session. ${esc(error.message)} <button class="button button-quiet" type="button" onclick="location.reload()">Try again</button></div></div>`;
  }
}

start();
