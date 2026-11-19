import {
  APP_TYPES,
  FELTUS_FULL_PLATFORM_SERVICE_IDS,
  FELTUS_PLATFORM_SERVICE_IDS,
  FELTUS_SUPPORTED_PLATFORM_SERVICE_IDS,
  SETUP_STEPS,
  resolveAppRoute,
  resumeSetupPath,
  nextSetupRoute,
  previousSetupRoute
} from "/app-wizard-lib.js";

let capabilityUiPromise;

function loadCapabilityUI() {
  if (!capabilityUiPromise) {
    capabilityUiPromise = import("/app-wizard-capabilities.js").catch(error => {
      capabilityUiPromise = null;
      throw error;
    });
  }
  return capabilityUiPromise;
}

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
const stepLabels = { basics: "Basics", data: "Data", knowledge: "Knowledge", ai: "AI", code: "Code", environment: "Environment", review: "Review" };
const platformServices = [
  { id: "hosting", name: "Hosting", description: "Keep your app or system online with FELTUS.", status: "Available for supported apps", details: "Uses the existing FELTUS hosting, health checks, and supported recovery controls. Availability is checked for your app before changes." },
  { id: "data_sign_in", name: "Data & Sign-In", description: "Add data models and secure user accounts for your app.", status: "Available for selected apps", details: "Generated-app users sign in separately from FELTUS workspace users. Access is limited to this app and its row-level-secured data models." },
  { id: "publish", name: "Publish", description: "Build, preview, update, and release your app.", status: "Available for supported apps", details: "Uses existing build, release-readiness, artifact, deployment, promotion, and recovery records. A build or release is never started by selecting this service." },
  { id: "domains", name: "Domains", description: "Connect the web address people use to reach your app.", status: "Not available yet", details: "FELTUS does not currently have a supported domain-connection workflow. No domain is purchased or connected here.", unavailable: true },
  { id: "storage_backup", name: "Storage & Backup", description: "Save app data and private uploaded files in a backup you can restore.", status: "Available", details: "Create app-only backups and restore an available backup. FELTUS creates a safety backup before restoring. Source checkpoints and deployment rollback are separate." },
  { id: "my_services", name: "My Services", description: "Keep track of services your app already uses.", status: "Available from an app", details: "Add metadata-only records from an app’s My Services page. FELTUS does not sign in to or change those services.", workspaceOnly: true },
  { id: "my_environment", name: "My Environment", description: "Record where your app already runs.", status: "Available from an app", details: "Record and check one public endpoint from an app’s My Environment page. FELTUS does not log in, deploy, manage containers, or change the environment.", workspaceOnly: true },
  { id: "developer_tools", name: "Developer Tools", description: "Work directly with your app's source when you want deeper technical control.", status: "Available from a project", details: "Opens the existing FELTUS CODE product for a selected project. CODE is not part of the ordinary Build experience." }
];
const pageGroups = [
  { label: "OVERVIEW", pages: [["overview", "Overview", "⌂"]] },
  { label: "BUILD", pages: [["code", "Studio", "⌘"], ["source", "Code source", "⑂"], ["builds", "Versions", "⚒"], ["data", "Data", "▤"], ["relationships", "Relationships", "⌁"], ["documents", "Knowledge", "▧"], ["storage-backup", "Storage & Backup", "▣"], ["ai", "Assistant", "✧"]] },
  { label: "OPERATE", pages: [["deployments", "Deployments", "↗"], ["environments", "Environments", "◉"], ["activity", "Activity", "≋"]] },
  { label: "MANAGE", pages: [["my-services", "My Services", "↔"], ["my-environment", "My Environment", "◉"], ["team", "People", "♧"], ["settings", "Settings", "⚙"]] }
];
const state = { apps: [], deletions: [], filter: "active", app: null, route: null, formBusy: false, loaded: false, activity: [], activityLoading: false, activityError: false, health: null, features: { teams: false }, selectedServiceIds: [] };
let toastTimer;
let saveTimer;
let formValues = null;
let homeMetadataGeneration = 0;
let lifecyclePollTimer;

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
    error.code = payload.error_code || payload.code;
    throw error;
  }
  return payload;
}

function settle(promise) {
  return promise.then(value => ({ value }), error => ({ error }));
}

async function checkSession() {
  const session = await api("/api/auth/session");
  if (session.mode === "local-development" || session.authenticated) return session;
  return new Promise(resolve => renderLogin(resolve));
}

function renderLogin(resolve) {
  document.body.classList.add("login-view");
  view.innerHTML = `<div class="main-wrap"><div class="entry-card card login-card" style="max-width:520px;margin:4vh auto"><img class="login-logo" src="/brand/feltus-logo-stacked.png" alt="FELTUS LABS"><p class="eyebrow">Private workspace</p><h1 class="page-title" style="font-size:38px">Welcome back.</h1><p class="page-lede">Sign in to open your FELTUS applications.</p><form id="login-form"><div class="field"><label for="login-email">Email</label><input class="input" id="login-email" type="email" autocomplete="username" required maxlength="320"></div><div class="field"><label for="login-password">Password</label><input class="input" id="login-password" type="password" autocomplete="current-password" required maxlength="1024"></div><div id="login-error" class="field-error" role="alert"></div><div class="action-row"><button id="login-submit" class="button button-primary" type="submit">Sign in</button></div></form></div></div>`;
  $("#login-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("#login-submit");
    button.disabled = true;
    button.textContent = "Signing in…";
    $("#login-error").textContent = "";
    try {
      const session = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: $("#login-email").value, password: $("#login-password").value }) });
      resolve(session);
    } catch (error) {
      $("#login-error").textContent = error.message;
      button.disabled = false;
      button.textContent = "Sign in";
    }
  });
}

async function loadApps() {
  const [apps, deletions] = await Promise.all([
    api("/api/apps"),
    api("/api/apps/deletions")
  ]);
  state.apps = Array.isArray(apps) ? apps : [];
  state.deletions = Array.isArray(deletions) ? deletions : [];
  clearTimeout(lifecyclePollTimer);
  if (state.deletions.some(app => ["requested", "validated", "tombstoned", "cleanup_pending", "cleanup_in_progress"].includes(app.lifecycle_status))) {
    lifecyclePollTimer = setTimeout(async () => {
      try {
        await loadApps();
        if (state.route?.kind === "home") await renderHome();
        else if (state.route?.kind === "apps") renderApps();
      } catch {}
    }, 4000);
  }
}

async function loadApp(appId) {
  const result = await api(`/api/apps/${encodeURIComponent(appId)}`);
  state.app = result.app;
  return state.app;
}

function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", path);
  else if (location.pathname + location.search !== path) history.pushState({}, "", path);
  const moreMenu = $(".mobile-more");
  if (moreMenu) moreMenu.open = false;
  renderRoute();
}

function appCard(app) {
  const lifecycle = app.lifecycle_status || (app.setup_status === "archived" ? "archived" : "active");
  const status = lifecycle === "archived" ? "archived" : (app.setup_status || "active");
  const draft = lifecycle === "active" && ["draft", "configuring"].includes(status);
  const primaryHref = draft ? resumeSetupPath(app) : `/apps/${encodeURIComponent(app.id)}`;
  const primaryText = draft ? "Resume Setup" : "Open App";
  const description = app.description || `${typeLabels[app.app_type] || "Application"} · ${String(app.environment || "development").replaceAll("_", " ")}`;
  const completion = Array.isArray(app.setup_completed_steps) ? app.setup_completed_steps.filter(step => SETUP_STEPS.includes(step)).length : 0;
  const lifecycleAction = lifecycle === "archived"
    ? `<button class="button button-quiet" type="button" data-restore="${esc(app.id)}">Restore Application</button>`
    : `<button class="button button-quiet" type="button" data-archive="${esc(app.id)}">Archive Application</button>`;
  return `<article class="app-card card"><div class="app-card-top"><span class="app-icon" style="color:${esc(app.accent_color || "var(--accent)")};background:${esc(app.accent_color || "#62D6C9")}18;border-color:${esc(app.accent_color || "#62D6C9")}35">${esc(app.app_icon || typeIcons[app.app_type] || "✦")}</span><span class="status-pill ${esc(status)}"><i class="status-dot"></i>${esc(status.replaceAll("_", " "))}</span></div><h3>${esc(app.app_name)}</h3><p>${esc(description)}</p><p class="app-card-meta">${esc(typeLabels[app.app_type] || "Application")} · ${esc((app.environment || "development").replaceAll("_", " "))}</p><div class="card-footer"><span class="subtle">${draft ? `${completion} of ${SETUP_STEPS.length} steps saved` : `Updated ${dateLabel(app.setup_updated_at || app.created_at)}`}</span></div><div class="action-row" style="margin-top:13px"><a class="button ${draft ? "button-primary" : ""}" href="${primaryHref}" data-nav>${primaryText}</a><a class="button button-quiet" href="/apps/${encodeURIComponent(app.id)}" data-nav>View Details</a><a class="button button-quiet" href="/apps/${encodeURIComponent(app.id)}/settings" data-nav>Settings</a>${lifecycleAction}</div></article>`;
}

function customerAppStatus(app) {
  const lifecycle = app.lifecycle_status || (app.setup_status === "archived" ? "archived" : "active");
  if (lifecycle === "archived") return { label: "Archived", className: "archived" };
  if (["draft", "configuring"].includes(app.setup_status)) return { label: "Setting up", className: "configuring" };
  if (["cleanup_failed", "cleanup_blocked"].includes(lifecycle)) return { label: "Needs attention", className: "attention" };
  return { label: "Active", className: "active" };
}

function projectRow(app, { actions = false } = {}) {
  const status = customerAppStatus(app);
  const isDraft = ["draft", "configuring"].includes(app.setup_status);
  const appPath = `/apps/${encodeURIComponent(app.id)}`;
  const updated = app.setup_updated_at || app.created_at;
  const actionMarkup = actions
    ? `<a class="button button-quiet" href="${appPath}/settings" data-nav>Settings</a>${app.lifecycle_status === "archived" || app.setup_status === "archived"
      ? `<button class="button button-quiet" type="button" data-restore="${esc(app.id)}">Restore</button>`
      : `<button class="button button-quiet" type="button" data-archive="${esc(app.id)}">Archive</button>`}`
    : "";
  return `<article class="project-row"><div class="project-row-main"><div class="project-row-title"><h2>${esc(app.app_name)}</h2><span class="status-pill ${status.className}"><i class="status-dot"></i>${status.label}</span></div>${app.description ? `<p>${esc(app.description)}</p>` : ""}<span class="project-row-updated">Updated ${esc(dateLabel(updated))}</span></div><div class="project-row-actions"><a class="button ${isDraft ? "button-primary" : ""}" href="${isDraft ? resumeSetupPath(app) : appPath}" data-nav>${isDraft ? "Continue setup" : "Manage"}</a>${actionMarkup}</div></article>`;
}

function customerActivityLabel(eventType) {
  return ({
    "app.created": "App added",
    "app.updated": "App updated",
    "blueprint.created": "App setup saved",
    "build.succeeded": "New version prepared",
    "deployment.succeeded": "Release completed",
    "domain.connected": "Domain connected",
    "service.connected": "Service connected",
    "recovery.completed": "App recovery completed",
    "model.created": "App data updated",
    "document.created": "App file added",
    "document.processed": "App file prepared"
  })[eventType] || "App activity";
}

function customerActivityMessage(item) {
  const fallback = item.severity === "error" ? "Action needs attention" : customerActivityLabel(item.event_type);
  const message = String(item.message || "").trim();
  if (!message) return fallback;
  return /\b(?:postgrest|sql|http|api|repository|branch|commit|artifact|runtime|provider|deployment|infrastructure|environment|webhook|chunk(?:ed|ing)?|database operation|schema|migration)\b/i.test(message)
    ? fallback
    : message;
}

function deletionQueueSection() {
  if (!state.deletions.length) return "";
  return `<section class="home-section lifecycle-queue"><div class="section-head"><div><h2 class="section-title">Application deletion</h2><p class="section-subtitle">Deletion runs in the background. FELTUS keeps external provider resources untouched.</p></div></div><div class="lifecycle-queue-list">${state.deletions.map(app => {
    const failed = ["cleanup_failed", "cleanup_blocked"].includes(app.lifecycle_status);
    const progress = app.lifecycle_cleanup_progress || {};
    return `<article class="lifecycle-queue-item card"><div><strong>${esc(app.app_name)}</strong><p>${esc(deletionStatusLabel(app.lifecycle_status))}</p>${failed ? `<p class="subtle">Cleanup paused before completion. You can retry it safely.</p>` : progress.files_removed === true ? `<p class="subtle">Private workspace files removed. Finalizing app data cleanup.</p>` : ""}</div>${failed ? `<a class="button button-danger" href="/apps/${encodeURIComponent(app.id)}/deletion" data-nav>Review and retry</a>` : `<span class="status-pill">In progress</span>`}</article>`;
  }).join("")}</div></section>`;
}

function healthSummary() {
  const services = state.health?.services || {};
  const items = [["Runtime", services.runtime?.status], ["Database", services.database?.status], ["AI", services.ai?.status]];
  return `<section class="health-strip card"><div><h2 class="section-title">Platform status</h2><p class="section-subtitle">A quick view of the services that power your apps.</p></div><div id="home-health-items" class="health-items">${items.map(([name, status]) => `<span class="health-chip"><i class="status-dot ${status === "online" ? "online" : status === "offline" ? "offline" : ""}"></i>${esc(name)} · ${esc(status || "checking")}</span>`).join("")}</div></section>`;
}

function activityContent() {
  if (state.activityLoading) return `<div class="activity-loading-list" role="status" aria-label="Loading recent activity">${Array.from({ length: 5 }, () => `<div class="activity-loading-row"></div>`).join("")}</div>`;
  if (state.activityError) return `<div class="empty-state"><strong>Recent activity is unavailable</strong>Try again in a little while.</div>`;
  if (!state.activity.length) return `<div class="empty-state"><strong>Nothing here yet.</strong>Updates will appear here as you set up and run your projects.</div>`;
  return `<div class="activity-list">${state.activity.slice(0, 5).map(item => `<div class="activity-item"><i class="status-dot ${item.severity === "error" ? "offline" : "online"}"></i><div><strong>${esc(customerActivityMessage(item))}</strong><small>${esc(dateLabel(item.created_at))}${item.app_id ? ` · ${esc(state.apps.find(app => app.id === item.app_id)?.app_name || "App")}` : ""}</small></div></div>`).join("")}</div>`;
}

function activitySection() {
  return `<section class="home-section"><div class="section-head"><div><h2 class="section-title">Recent activity</h2><p class="section-subtitle">A short history of what’s been happening.</p></div></div><div id="home-activity-body" class="home-activity-body">${activityContent()}</div></section>`;
}

async function renderHome() {
  topCreate.hidden = true;
  const activeApps = state.apps.filter(app => (app.lifecycle_status || (app.setup_status === "archived" ? "archived" : "active")) === "active");
  state.activity = [];
  state.activityError = false;
  state.activityLoading = true;
  if (!state.apps.length) {
    view.innerHTML = `<div class="main-wrap customer-home"><div class="page-heading"><p class="eyebrow">FELTUS LABS</p><h1 class="page-title">What do you want to do?</h1><p class="page-lede">Start something new or bring what you already have to FELTUS.</p></div><section class="product-choice-grid" aria-label="Choose how to use FELTUS"><article class="product-choice-card"><span class="product-choice-mark" aria-hidden="true">✦</span><h2>Build with FELTUS</h2><p>Create an app with FELTUS. Describe what you want to build and FELTUS handles the technical setup behind the scenes.</p><a class="button button-primary" href="/apps/new" data-nav>Start building</a></article><article class="product-choice-card"><span class="product-choice-mark" aria-hidden="true">↗</span><h2>Use FELTUS Services</h2><p>Use FELTUS with something you already have. Run, connect, publish, or manage existing software with the services you need.</p><a class="button" href="/services" data-nav>Explore services</a></article></section></div>`;
    return;
  }
  view.innerHTML = `<div class="main-wrap customer-home"><div class="page-heading returning-home-heading"><div><p class="eyebrow">Your workspace</p><h1 class="page-title">Pick up where you left off.</h1></div><div class="home-primary-actions"><a class="button button-primary" href="/apps/new" data-nav>Build with FELTUS</a><a class="button" href="/apps/import" data-nav>Bring an app</a></div></div><section class="home-section home-projects"><div class="section-head"><div><h2 class="section-title">Recent projects</h2><p class="section-subtitle">Your apps and their current status.</p></div><a class="button button-quiet" href="/apps" data-nav>All projects</a></div><div class="project-list">${activeApps.length ? activeApps.slice(0, 5).map(app => projectRow(app)).join("") : `<div class="empty-state"><strong>No active projects.</strong>Archived projects are available in Projects.<a class="button button-quiet" href="/apps" data-nav>Open projects</a></div>`}</div></section><section class="home-section home-activity"><div class="section-head"><div><h2 class="section-title">Recent activity</h2><p class="section-subtitle">What FELTUS has been doing.</p></div><a class="button button-quiet" href="/activity" data-nav>View activity</a></div><div id="home-activity-body" class="home-activity-body">${activityContent()}</div></section><div class="home-service-shortcut"><div><h2 class="section-title">Services for your apps</h2><p class="section-subtitle">Choose what you need, or connect services you already use.</p></div><a class="button" href="/services" data-nav>Explore services</a></div></div>`;
  state.activityLoading = true;
  scheduleHomeMetadata();
  bindArchiveActions();
}

function selectedServicesFromLocation() {
  const requested = new URLSearchParams(location.search).get("services") || "";
  return [...new Set(requested.split(",").filter(id => FELTUS_PLATFORM_SERVICE_IDS.includes(id)))];
}

function saveSelectedServices(ids) {
  state.selectedServiceIds = [...new Set(ids.filter(id => FELTUS_PLATFORM_SERVICE_IDS.includes(id)))];
  const url = new URL(location.href);
  if (state.selectedServiceIds.length) url.searchParams.set("services", state.selectedServiceIds.join(","));
  else url.searchParams.delete("services");
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function serviceQuery(ids) {
  return ids.length ? `?services=${encodeURIComponent(ids.join(","))}` : "";
}

async function renderServices() {
  topCreate.hidden = true;
  const requested = selectedServicesFromLocation();
  const selected = requested;
  state.selectedServiceIds = selected;
  const cards = platformServices.map(service => {
    const active = selected.includes(service.id);
    const workspaceOnly = service.workspaceOnly === true;
    const supported = FELTUS_SUPPORTED_PLATFORM_SERVICE_IDS.includes(service.id) && !service.unavailable && !workspaceOnly;
    return `<article class="service-card card ${active ? "selected" : ""}"><div class="service-card-top"><div><h2>${esc(service.name)}</h2><p>${esc(service.description)}</p></div><span class="service-status ${supported || workspaceOnly ? "available" : "unavailable"}">${esc(service.status)}</span></div><details><summary>Learn more</summary><p>${esc(service.details)}</p></details><div class="service-card-actions">${workspaceOnly
      ? `<a class="button button-quiet" href="/apps" data-nav>Choose an app</a>`
      : supported
      ? `<button class="button ${active ? "button-selected" : ""}" type="button" data-service-toggle="${esc(service.id)}" aria-pressed="${active}">${active ? "Selected" : service.id === "developer_tools" ? "Add to services" : "Select service"}</button>`
      : `<button class="button" type="button" disabled>${esc(service.status)}</button>`}</div></article>`;
  }).join("");
  const count = selected.length;
  const fullSelected = FELTUS_FULL_PLATFORM_SERVICE_IDS.every(id => selected.includes(id));
  view.innerHTML = `<div class="main-wrap"><div class="page-heading"><p class="eyebrow">FELTUS Services</p><h1 class="page-title">FELTUS Services</h1><p class="page-lede">Use one service, combine a few, or let FELTUS manage the complete platform.</p></div><div class="services-toolbar"><div><h2 class="section-title">Use the full FELTUS platform</h2><p class="section-subtitle">Let FELTUS configure all supported services your project needs.</p></div><button class="button button-quiet" type="button" data-full-platform>${fullSelected ? "Full platform selected" : "Select supported services"}</button><span class="subtle">${count} selected</span></div><section class="service-grid" aria-label="FELTUS services">${cards}</section><div class="services-footer"><a class="button button-quiet" href="/apps/import${serviceQuery(selected)}" data-nav>Bring an app I already have</a>${count ? `<a class="button button-primary" href="/services/use${serviceQuery(selected)}" data-nav>Continue with ${count} service${count === 1 ? "" : "s"}</a>` : `<button class="button button-primary" type="button" disabled>Select a service to continue</button>`}</div></div>`;
}

async function renderServicesUse() {
  topCreate.hidden = true;
  const selected = selectedServicesFromLocation();
  state.selectedServiceIds = selected;
  const apps = state.apps.filter(app =>
    (app.lifecycle_status || "active") === "active"
  );
  const options = apps.map(app =>
    `<option value="${esc(app.id)}">${esc(app.app_name)}</option>`
  ).join("");
  view.innerHTML = `<div class="main-wrap"><div class="page-heading"><p class="eyebrow">FELTUS Services</p><h1 class="page-title">Choose a project.</h1><p class="page-lede">Choose an app to use these services with. Services you already use will stay as they are.</p></div><section class="service-use-card card"><h2 class="section-title">Use ${selected.length} selected service${selected.length === 1 ? "" : "s"}</h2><p class="section-subtitle">${selected.map(id => platformServices.find(item => item.id === id)?.name).filter(Boolean).map(esc).join(" · ") || "No services selected"}</p>${apps.length ? `<form id="service-use-form"><div class="field"><label for="service-project">Project</label><select class="select" id="service-project" required><option value="">Choose a project</option>${options}</select></div><p id="service-use-error" class="field-error" role="alert"></p><div class="action-row"><button class="button button-primary" type="submit" ${selected.length ? "" : "disabled"}>Use selected services</button><a class="button button-quiet" href="/services" data-nav>Back to services</a></div></form>` : `<div class="empty-state"><strong>No projects yet.</strong>Build something with FELTUS or bring an app you already have.<div class="action-row" style="justify-content:center"><a class="button button-primary" href="/apps/new" data-nav>Build with FELTUS</a><a class="button" href="/apps/import${serviceQuery(selected)}" data-nav>Bring an app</a></div></div>`}<p class="service-use-note">FELTUS will not replace services you already manage or start a build or release from this selection.</p></section></div>`;
  $("#service-use-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    const errorNode = $("#service-use-error");
    button.disabled = true;
    button.textContent = "Saving services…";
    if (errorNode) errorNode.textContent = "";
    try {
      const appId = $("#service-project").value;
      const result = await api(`/api/apps/${encodeURIComponent(appId)}/services`, {
        method: "PUT",
        body: JSON.stringify({ service_ids: selected.filter(id => id !== "my_services") })
      });
      if (result.blocked_components?.length) {
        showToast(`Saved. Existing service ownership was preserved for ${result.blocked_components.map(name => name.replaceAll("_", " ")).join(", ")}.`, "error");
      } else {
        showToast("Your service choices are saved to this project.");
      }
      if (selected.includes("my_services")) {
        navigate(`/apps/${encodeURIComponent(appId)}/my-services`);
        showToast("Your app is ready. Add service details from My Services.");
      } else {
        navigate(`/apps/${encodeURIComponent(appId)}`);
      }
    } catch (error) {
      if (errorNode) errorNode.textContent = friendlyServiceError(error);
      button.disabled = false;
      button.textContent = "Use selected services";
    }
  });
}

function friendlyServiceError(error) {
  if (error.code === "INFRASTRUCTURE_OWNER_MISMATCH") return "This service cannot change a customer-managed component. Its current owner has been kept.";
  if (error.code === "INFRASTRUCTURE_CONFIGURATION_INVALID") return "This project’s service settings need review before changes can be saved.";
  if (error.status === 403) return "Only the project owner can change service selections.";
  if (error.status === 409) return "This project changed while you were selecting services. Refresh and try again.";
  return "FELTUS could not save these service choices. Try again shortly.";
}

async function renderExistingAppImport() {
  topCreate.hidden = true;
  const selected = selectedServicesFromLocation();
  state.selectedServiceIds = selected;
  const githubAvailability = await api("/api/github/status")
    .catch(() => ({ configured: false }));
  if (githubAvailability.configured !== true) {
    view.innerHTML = `<div class="main-wrap"><div class="page-heading"><p class="eyebrow">Use FELTUS Services</p><h1 class="page-title">Bring an app I already have.</h1><p class="page-lede">Connect app files and use FELTUS services alongside what already works for you.</p></div><section class="service-use-card"><h2 class="section-title">GitHub connection is unavailable right now.</h2><p class="section-subtitle">We could not confirm a supported way to connect your app files. Try again later.</p><div class="action-row"><button class="button button-primary" type="button" data-retry-github-availability>Try again</button><a class="button button-quiet" href="/services${serviceQuery(selected)}" data-nav>Back to services</a></div></section></div>`;
    view.querySelector("[data-retry-github-availability]")?.addEventListener("click", renderRoute);
    return;
  }
  view.innerHTML = `<div class="main-wrap"><div class="page-heading"><p class="eyebrow">Use FELTUS Services</p><h1 class="page-title">Bring an app I already have.</h1><p class="page-lede">Connect app files and use FELTUS services alongside what already works for you.</p></div><section class="service-use-card"><h2 class="section-title">Connect my app files</h2><p class="section-subtitle">You can connect app files from a GitHub account. Uploading files is not available yet.</p><form id="existing-app-form"><div class="field"><label for="existing-app-name">Project name</label><input class="input" id="existing-app-name" name="app_name" maxlength="200" required placeholder="Name your project"></div><div class="field"><label for="existing-app-description">What is this app?</label><textarea class="textarea" id="existing-app-description" name="description" maxlength="2000" placeholder="A short description (optional)"></textarea></div><p id="existing-app-error" class="field-error" role="alert"></p><div class="action-row"><button class="button button-primary" type="submit">Continue to connect app files</button><a class="button button-quiet" href="/services${serviceQuery(selected)}" data-nav>Back to services</a></div></form><div class="import-next-steps"><h3>Other ways to use FELTUS</h3><a href="/services?services=hosting,publish" data-nav>Use FELTUS Hosting and Publish</a><a href="/services?services=my_services" data-nav>Keep some of my current services</a></div></section></div>`;
  $("#existing-app-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    const errorNode = $("#existing-app-error");
    button.disabled = true;
    button.textContent = "Creating project…";
    if (errorNode) errorNode.textContent = "";
    try {
      const result = await api("/api/apps", {
        method: "POST",
        body: JSON.stringify({
          app_name: $("#existing-app-name").value,
          description: $("#existing-app-description").value,
          app_type: "other",
          app_icon: "◧",
          accent_color: "#9788FF",
          creation_path: "existing_application",
          service_ids: selected,
          continue_setup: false
        })
      });
      await loadApps();
      navigate(`/apps/${encodeURIComponent(result.app.id)}/source`);
      showToast("Project created. Connect the GitHub account that contains your app files.");
    } catch (error) {
      if (errorNode) errorNode.textContent = error.field === "app_name" ? error.message : friendlyServiceError(error);
      button.disabled = false;
      button.textContent = "Continue to connect app files";
    }
  });
}

function renderDomains() {
  topCreate.hidden = true;
  view.innerHTML = `<div class="main-wrap"><div class="page-heading"><p class="eyebrow">FELTUS Services</p><h1 class="page-title">Domains</h1><p class="page-lede">Add a web address when you are ready.</p></div><section class="empty-state"><strong>No domains connected.</strong>Domain connections are not available yet. No domain is purchased or changed here.<div class="action-row" style="justify-content:center"><button class="button" type="button" disabled>Connect a domain</button><a class="button button-quiet" href="/services" data-nav>Explore services</a></div></section></div>`;
}

function renderUsage() {
  topCreate.hidden = true;
  view.innerHTML = `<div class="main-wrap"><div class="page-heading"><p class="eyebrow">Workspace</p><h1 class="page-title">Usage</h1><p class="page-lede">A clear view of how your FELTUS services are being used.</p></div><section class="empty-state"><strong>Usage details are not available yet.</strong>There are no verified usage or billing details to show here.</section></div>`;
}

function renderSettings() {
  topCreate.hidden = true;
  view.innerHTML = `<div class="main-wrap"><div class="page-heading"><p class="eyebrow">Workspace</p><h1 class="page-title">Settings</h1><p class="page-lede">Manage your services and find app controls when you need them.</p></div><section class="settings-list"><article class="settings-row"><div><h2>Connected services</h2><p>Choose FELTUS services or connect supported services you already use.</p></div><a class="button" href="/services" data-nav>Manage services</a></article><article class="settings-row"><div><h2>Ownership and app files</h2><p>Manage app files and available project controls from each app workspace.</p></div><a class="button" href="/apps" data-nav>Open projects</a></article><article class="settings-row"><div><h2>Developer Tools</h2><p>Open a project to access deeper technical controls when you need them.</p></div><a class="button" href="/apps" data-nav>Choose a project</a></article><article class="settings-row settings-row-unavailable"><div><h2>Account and preferences</h2><p>Workspace preferences are not available here yet.</p></div><span class="subtle">Not available</span></article></section></div>`;
}

async function renderActivityPage() {
  topCreate.hidden = true;
  state.activityLoading = true;
  state.activityError = false;
  view.innerHTML = `<div class="main-wrap"><div class="page-heading"><p class="eyebrow">Workspace</p><h1 class="page-title">Activity</h1><p class="page-lede">What FELTUS has been doing for your projects.</p></div><section class="home-section">${activitySection()}</section></div>`;
  try {
    const activity = await api("/api/activity?limit=100");
    state.activity = Array.isArray(activity) ? activity : [];
  } catch {
    state.activity = [];
    state.activityError = true;
  }
  state.activityLoading = false;
  const body = $("#home-activity-body");
  if (body) body.innerHTML = activityContent();
}

async function loadHomeMetadata(generation) {
  const activity = await api("/api/activity?limit=5").catch(() => null);
  if (generation !== homeMetadataGeneration || resolveAppRoute(location.pathname).kind !== "home") return;
  state.activity = Array.isArray(activity) ? activity : [];
  state.activityError = !Array.isArray(activity);
  state.activityLoading = false;
  const activityRoot = $("#home-activity-body");
  if (activityRoot) activityRoot.innerHTML = activityContent();
}

function scheduleHomeMetadata() {
  const generation = ++homeMetadataGeneration;
  requestAnimationFrame(() => setTimeout(() => { void loadHomeMetadata(generation); }, 0));
}

function renderApps() {
  topCreate.hidden = true;
  const filters = ["active", "draft", "archived", "all"];
  const apps = state.apps.filter(app => {
    const lifecycle = app.lifecycle_status || (app.setup_status === "archived" ? "archived" : "active");
    return state.filter === "all" || (state.filter === "archived" ? lifecycle === "archived" : state.filter === "active" ? lifecycle === "active" && !["draft", "configuring"].includes(app.setup_status) : lifecycle === "active" && ["draft", "configuring"].includes(app.setup_status));
  });
  const noProjects = state.apps.length === 0;
  view.innerHTML = `<div class="main-wrap"><div class="page-heading"><p class="eyebrow">Workspace</p><h1 class="page-title">Projects</h1><p class="page-lede">Apps you build or bring to FELTUS.</p></div>${noProjects ? `<div class="empty-state"><strong>No projects yet.</strong>Build something with FELTUS or bring an app you already have.<div class="action-row" style="justify-content:center"><a class="button button-primary" href="/apps/new" data-nav>Build with FELTUS</a><a class="button" href="/apps/import" data-nav>Bring an app</a></div></div>` : `<div><div class="filter-row" role="group" aria-label="Filter projects">${filters.map(filter => `<button class="filter-button ${state.filter === filter ? "active" : ""}" type="button" data-filter="${filter}" aria-pressed="${state.filter === filter}">${filter === "all" ? "All projects" : filter === "draft" ? "Drafts" : filter[0].toUpperCase() + filter.slice(1)}</button>`).join("")}</div><section class="project-list home-section">${apps.length ? apps.map(app => projectRow(app, { actions: true })).join("") : `<div class="empty-state"><strong>No ${state.filter === "draft" ? "draft" : esc(state.filter)} projects</strong>Projects in this category will appear here.</div>`}</section>${deletionQueueSection()}</div>`}</div>`;
  view.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => { state.filter = button.dataset.filter; renderApps(); }));
  bindArchiveActions();
}

function renderEntry() {
  topCreate.hidden = true;
  const flow = ["Describe your app", "Shape the experience", "Preview and launch"];
  view.innerHTML = `<div class="main-wrap"><div class="entry-card card"><p class="eyebrow">Build with FELTUS</p><h1 class="page-title">What should your app do?</h1><p class="page-lede">Describe the app you want to make. FELTUS will guide the build and handle supported technical setup behind the scenes.</p><div class="flow-preview">${flow.map((label, index) => `<div class="flow-item"><span class="flow-number">${String(index + 1).padStart(2, "0")}</span><b>${label}</b></div>`).join("")}</div><div class="entry-actions"><a class="button button-quiet" href="/" data-nav>Cancel</a><a class="button button-primary" href="/apps/new/basics" data-nav>Start building <span aria-hidden="true">→</span></a></div></div></div>`;
}

function setupShell(app, currentStep, content) {
  const currentIndex = Math.max(0, SETUP_STEPS.indexOf(currentStep));
  const completed = new Set(Array.isArray(app.setup_completed_steps) ? app.setup_completed_steps : []);
  const stepLinks = SETUP_STEPS.map((step, index) => {
    const isCurrent = step === currentStep;
    const done = completed.has(step);
    const unavailable = false;
    const href = unavailable ? "" : app.id ? `/apps/${encodeURIComponent(app.id)}/setup/${step}` : (step === "basics" ? "/apps/new/basics" : "");
    const item = `<span class="step-index">${done ? "✓" : index + 1}</span>${stepLabels[step]}`;
    if (!href) return `<span class="step-link" aria-disabled="true" title="${unavailable ? "Build orchestration is part of a later phase." : "Finish App Details to save this step."}">${item}${unavailable ? `<small class="step-unavailable">Later phase</small>` : ""}</span>`;
    return `<a class="step-link ${isCurrent ? "current" : ""} ${done ? "done" : ""}" href="${href}" data-nav aria-current="${isCurrent ? "step" : "false"}">${item}</a>`;
  }).join("");
  const backPath = app.id ? previousSetupRoute(app.id, currentStep) : "/apps/new";
  const continuePath = currentStep === "review" ? null : (app.id ? nextSetupRoute(app.id, currentStep) : "/apps/new/basics");
  const nextLabel = stepLabels[SETUP_STEPS[currentIndex + 1]];
  const label = currentStep === "basics" ? "Continue to Data" : currentStep === "review" ? "Create App" : `Continue to ${nextLabel || "next step"}`;
  const mobileProgress = Math.round(((currentIndex + 1) / SETUP_STEPS.length) * 100);
  const navAction = `<button class="button button-primary" type="button" data-action="continue">${label} →</button>`;
  const saveLabel = currentStep === "data" ? "Save for later" : "Save Draft";
  const saveTitle = currentStep === "data"
    ? 'title="Saves these fields for later. To create the category now, choose Add Category."'
    : currentStep === "basics" ? "" : 'title="Saves the app draft and current wizard fields. File uploads must be submitted separately."';
  const actions = `<button type="button" class="button button-quiet" data-action="save" ${saveTitle}>${saveLabel}</button><button type="button" class="button button-quiet" data-action="exit">Exit Setup</button>`;
  return `<div class="wizard-layout"><aside class="wizard-rail card"><a class="rail-app" href="/apps" data-nav><span class="app-icon" style="color:${esc(app.accent_color || "var(--accent)")}">${esc(app.app_icon || "✦")}</span><span><strong>${esc(app.app_name || "New application")}</strong><span>Application setup</span></span></a><p class="progress-count">Step ${currentIndex + 1} of ${SETUP_STEPS.length}</p><nav class="step-list" aria-label="Setup progress">${stepLinks}</nav><div class="mobile-stepper"><span>Step ${currentIndex + 1} of ${SETUP_STEPS.length}</span><span class="mobile-progress"><span style="width:${mobileProgress}%"></span></span><b>${stepLabels[currentStep]}</b></div></aside><section class="wizard-main"><div class="wizard-actions">${actions}</div><div class="wizard-content card">${content}</div><div class="wizard-nav"><a class="button button-quiet" href="${backPath}" data-nav>← Back</a><div class="wizard-nav-right">${navAction}</div></div></section></div>`;
}

function basicsContent(app, isNew) {
  const form = formValues || {
    app_name: app?.app_name || "", description: app?.description || "", intent_details: app?.setup_data?.intent_details || "", app_type: app?.app_type || "web_application",
    app_icon: app?.app_icon || typeIcons[app?.app_type] || "✦", accent_color: app?.accent_color || "#62D6C9"
  };
  const title = isNew ? "Tell us about your app." : "App details";
  const types = APP_TYPES.map(type => `<button type="button" class="type-card ${form.app_type === type ? "selected" : ""}" data-type="${type}" aria-pressed="${form.app_type === type}"><span class="type-icon">${typeIcons[type]}</span><span><b>${typeLabels[type]}</b><small>${type === "web_application" ? "A site or web product" : type === "internal_tool" ? "A tool for your team" : type === "api_backend" ? "Services and integrations" : type === "ai_application" ? "AI-powered experiences" : type === "data_application" ? "Data-focused workflows" : "Something different"}</small></span></button>`).join("");
  return `<p class="eyebrow">Step 1 · Basics</p><h1 class="page-title">${title}</h1><p class="page-lede">Describe what you want this app to help people do. FELTUS will use that context to suggest its starting structure.</p><form id="basics-form" novalidate><div class="field"><label for="app-name">App name <span aria-hidden="true">*</span></label><input class="input" id="app-name" name="app_name" type="text" maxlength="200" required autocomplete="off" placeholder="e.g. Northstar Support" value="${esc(form.app_name)}"><span id="app-name-error" class="field-error" aria-live="polite"></span></div><div class="field"><label for="app-description">What should this app help people do?</label><textarea class="textarea" id="app-description" name="description" maxlength="2000" placeholder="For example: Help our team manage customers, orders, and support requests.">${esc(form.description)}</textarea><span class="field-help">A sentence or two helps FELTUS suggest useful information categories.</span></div><details class="cap-advanced"><summary>Add more details</summary><div class="field"><label for="intent-details">Anything else FELTUS should know?</label><textarea class="textarea" id="intent-details" name="intent_details" maxlength="4000" placeholder="Who will use it? What should it make easier? Any important requirements?">${esc(form.intent_details || "")}</textarea><span class="field-help">Optional context used when suggesting your app’s starting structure.</span></div></details><div class="field"><label>App type</label><div class="type-grid" role="group" aria-label="App type">${types}</div><span id="app-type-error" class="field-error" aria-live="polite"></span></div><div class="field"><label>Visual identity <span class="muted-line">· optional</span></label><div class="identity-row"><div><span class="field-help">Choose an icon</span><div class="icon-picker" style="margin-top:9px">${["✦", "◉", "⌘", "▤", "✧", "◈", "⬡", "◒"].map(icon => `<button class="icon-option ${form.app_icon === icon ? "selected" : ""}" type="button" data-icon="${icon}" aria-label="Use ${icon} app icon" aria-pressed="${form.app_icon === icon}">${icon}</button>`).join("")}</div></div><div><label for="accent-color" class="field-help">Accent color</label><div class="color-picker" style="margin-top:6px"><input id="accent-color" type="color" value="${esc(form.accent_color)}" aria-label="App accent color"><span class="muted-line" id="accent-value">${esc(form.accent_color.toUpperCase())}</span></div></div></div></div><div class="preview-strip"><span class="app-icon" id="preview-icon" style="color:${esc(form.accent_color)};background:${esc(form.accent_color)}18;border-color:${esc(form.accent_color)}35">${esc(form.app_icon)}</span><span><strong id="preview-name">${esc(form.app_name || "Your app name")}</strong><small>${typeLabels[form.app_type] || "Application"}</small></span></div><div id="basics-error" class="field-error" role="alert"></div></form>`;
}

async function renderSetup(app, step, capability = "") {
  topCreate.hidden = true;
  state.app = app;
  const content = step === "basics" ? basicsContent(app, !app.id) : capability;
  view.innerHTML = setupShell(app, step, content);
  if (step === "basics") bindBasicsForm(app);
  else if (["data", "knowledge", "ai", "code", "environment", "review"].includes(step)) {
    const { mountCapabilityPanel } = await loadCapabilityUI();
    const panel = $(".wizard-content", view);
    mountCapabilityPanel(panel, app, step, "setup", () => renderRoute());
  }
  bindWizardShell(app, step);
}

function getFormValues() {
  const form = $("#basics-form");
  if (!form) return formValues;
  return {
    app_name: $("#app-name").value,
    description: $("#app-description").value,
    intent_details: $("#intent-details")?.value || "",
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
    const capabilityPanel = $(".wizard-content", view);
    if (capabilityPanel?.dataset.capabilityDirty === "true") {
      if (!window.confirm("This section has unsaved form values. Exit and discard them?")) return;
      delete capabilityPanel.dataset.capabilityDirty;
    }
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
  view.querySelectorAll('[data-action="skip"]').forEach(button => button.addEventListener("click", () => continueSetup(app, step, button)));
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
        values.intent_details !== (app?.setup_data?.intent_details || "") ||
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
    if (!app || !window.confirm(`Archive application “${app.app_name}”? It will be hidden from active apps, but its data, configuration, and history will remain available. You can restore it from the Archived filter.`)) return;
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
  view.querySelectorAll("[data-restore]").forEach(button => button.addEventListener("click", async () => {
    const appId = button.dataset.restore;
    button.disabled = true;
    button.textContent = "Restoring…";
    try {
      await api(`/api/apps/${encodeURIComponent(appId)}/restore`, { method: "POST", body: "{}" });
      await loadApps();
      showToast("App restored.");
      await renderRoute();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Restore";
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
      const result = await api("/api/apps", { method: "POST", body: JSON.stringify({ app_name: values.app_name, description: values.description, app_type: values.app_type, app_icon: values.app_icon, accent_color: values.accent_color, setup_data: { intent_details: values.intent_details }, creation_path: "build_with_feltus", continue_setup: false }) });
      savedApp = result.app;
      history.replaceState({}, "", `/apps/${encodeURIComponent(savedApp.id)}/setup/basics`);
    } else {
      const capabilityDraft = step === "basics" ? null : (await loadCapabilityUI()).collectCapabilityDraft($(".wizard-content", view), savedApp, step);
      const payload = step === "basics" ? { app_name: values.app_name, description: values.description, app_type: values.app_type, app_icon: values.app_icon, accent_color: values.accent_color, setup_current_step: step, setup_data: { intent_details: values.intent_details }, ...(["draft", "configuring"].includes(savedApp.setup_status) ? { setup_status: "draft" } : {}) } : { setup_current_step: step, ...(capabilityDraft ? { setup_data: capabilityDraft } : {}) };
      const result = await api(`/api/apps/${encodeURIComponent(savedApp.id)}/setup`, { method: "PATCH", body: JSON.stringify(payload) });
      savedApp = result.app;
    }
    state.app = savedApp;
    if (["data", "relationships", "ai"].includes(step)) delete $(".wizard-content", view)?.dataset.capabilityDirty;
    await loadApps();
    formValues = { app_name: savedApp.app_name, description: savedApp.description || "", intent_details: savedApp.setup_data?.intent_details || "", app_type: savedApp.app_type, app_icon: savedApp.app_icon, accent_color: savedApp.accent_color };
    setSaved("Draft saved");
    if (!quiet) showToast("Your app draft is saved and ready to resume.");
    if (step === "basics" && !quiet) await renderSetup(savedApp, step);
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
  if (state.formBusy) return;
  if (step === "build") return;
  const capabilityPanel = $(".wizard-content", view);
  if (capabilityPanel?.dataset.capabilityDirty === "true") {
    if (!window.confirm("This section has unsaved form values. Continue and discard them? Submit or save them first to keep these changes.")) return;
    delete capabilityPanel.dataset.capabilityDirty;
  }
  const values = step === "basics" ? readBasics() : null;
  if (step === "basics" && !values) return;
  state.formBusy = true;
  button.disabled = true;
  view.querySelectorAll('.wizard-actions button, .wizard-nav a, [data-action="skip"]').forEach(control => { control.dataset.wasDisabled = String(control.disabled || false); control.disabled = true; });
  const original = button.innerHTML;
  button.textContent = "Saving app…";
  setSaved("Saving…");
  try {
    let saved;
    if (!app?.id) {
      saved = (await api("/api/apps", { method: "POST", body: JSON.stringify({ app_name: values.app_name, description: values.description, app_type: values.app_type, app_icon: values.app_icon, accent_color: values.accent_color, setup_data: { intent_details: values.intent_details }, creation_path: "build_with_feltus", continue_setup: true }) })).app;
    } else if (step === "review") {
      const requiredSteps = SETUP_STEPS.slice(0, -1);
      if (!requiredSteps.every(requiredStep => (app.setup_completed_steps || []).includes(requiredStep))) {
        throw new Error("Continue through each step before creating the app. Your saved answers are still here.");
      }
      await api(`/api/apps/${encodeURIComponent(app.id)}/blueprints`, { method: "POST", body: JSON.stringify({ confirm: true }) });
      saved = (await api(`/api/apps/${encodeURIComponent(app.id)}/setup`, {
        method: "PATCH",
        body: JSON.stringify({ setup_current_step: "review", setup_completed_steps: [...new Set([...(app.setup_completed_steps || []), "review"])], setup_status: "active" })
      })).app;
    } else {
      const nextStep = SETUP_STEPS[SETUP_STEPS.indexOf(step) + 1];
      const progressPatch = {
        setup_current_step: nextStep,
        setup_completed_steps: [...new Set([...(app.setup_completed_steps || []), step])],
        setup_status: "configuring",
        ...(step === "basics" ? { app_name: values.app_name, description: values.description, app_type: values.app_type, app_icon: values.app_icon, accent_color: values.accent_color, setup_data: { intent_details: values.intent_details } } : {})
      };
      saved = (await api(`/api/apps/${encodeURIComponent(app.id)}/setup`, {
        method: "PATCH",
        body: JSON.stringify(progressPatch)
      })).app;
    }
    state.app = saved;
    formValues = null;
    await loadApps();
    setSaved("Progress saved");
    navigate(step === "review" ? `/apps/${encodeURIComponent(saved.id)}` : `/apps/${encodeURIComponent(saved.id)}/setup/${SETUP_STEPS[SETUP_STEPS.indexOf(step) + 1]}`, { replace: !app?.id });
  } catch (error) {
    setSaved("Couldn’t save", true);
    if (error.field === "app_name") {
      $("#app-name").setAttribute("aria-invalid", "true");
      $("#app-name-error").textContent = error.message;
    } else {
      const errorNode = $("#basics-error") || $(".wizard-content [data-form-error]");
      if (errorNode) errorNode.textContent = error.message;
      else showToast(error.message, "error");
    }
  } finally {
    state.formBusy = false;
    if (button.isConnected) { button.disabled = false; button.innerHTML = original; }
    view.querySelectorAll('.wizard-actions button, .wizard-nav a, [data-action="skip"]').forEach(control => { if (control.dataset.wasDisabled !== "true") control.disabled = false; delete control.dataset.wasDisabled; });
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
    await renderSetup({ app_name: "", app_type: "web_application", app_icon: "◧", accent_color: "#62D6C9", setup_completed_steps: [] }, "basics");
  } else {
    if (route.step === "basics") formValues = { app_name: app.app_name, description: app.description || "", intent_details: app.setup_data?.intent_details || "", app_type: app.app_type, app_icon: app.app_icon, accent_color: app.accent_color };
    const capabilityUi = ["data", "knowledge", "ai", "code", "environment", "review"].includes(route.step)
      ? await loadCapabilityUI()
      : null;
    const capability = capabilityUi
      ? await capabilityUi.renderCapabilityPanel(app, route.step, "setup")
      : "";
    await renderSetup(app, route.step, capability);
  }
}

async function renderOverview(app) {
  topCreate.hidden = false;
  const draft = ["draft", "configuring"].includes(app.setup_status);
  const status = app.setup_status || "active";
  const progress = Array.isArray(app.setup_completed_steps) ? app.setup_completed_steps.filter(step => SETUP_STEPS.includes(step)).length : 0;
  const [stateResult, environmentResult, aiHealth] = await Promise.all([
    api(`/api/apps/${encodeURIComponent(app.id)}/state`).catch(() => null),
    api(`/api/apps/${encodeURIComponent(app.id)}/environments`).catch(() => null),
    api("/api/ai/runtime/health").catch(() => ({ status: "unknown" }))
  ]);
  const environments = Array.isArray(environmentResult?.environments) ? environmentResult.environments : [];
  const deployed = environments.filter(environment => environment.deployment)
    .sort((a, b) => ["production", "staging", "preview", "development"].indexOf(a.kind) - ["production", "staging", "preview", "development"].indexOf(b.kind))[0] || null;
  const blueprint = stateResult?.latest_blueprint || null;
  const desired = stateResult?.state?.desired_state;
  const modelCount = desired?.data?.models?.length;
  const repositoryStatus = desired?.code?.status === "connected" ? "Connected" : desired ? "Not connected" : "Not verified";
  const healthLabel = deployed ? String(deployed.health || deployed.deployment?.status || "Unknown") : stateResult ? "Not deployed" : "Not verified";
  const healthGood = String(healthLabel).toLowerCase() === "healthy";
  const nextAction = draft
    ? `<a class="button button-primary" href="${resumeSetupPath(app)}" data-nav>Continue Setup</a><p class="section-subtitle">Your draft is saved at Step ${Math.min(progress + 1, SETUP_STEPS.length)} of ${SETUP_STEPS.length}.</p>`
    : !blueprint
      ? `<a class="button button-primary" href="/apps/${encodeURIComponent(app.id)}/setup/review" data-nav>Review and save Blueprint</a>`
      : stateResult?.features?.build_runner !== true
        ? `<a class="button button-primary" href="/apps/${encodeURIComponent(app.id)}/builds" data-nav>View build setup</a><p class="section-subtitle">Builds are unavailable until a runner and artifact registry are configured.</p>`
        : !healthGood
          ? `<a class="button button-primary" href="/apps/${encodeURIComponent(app.id)}/environments" data-nav>Review environments</a>`
          : `<a class="button button-primary" href="/apps/${encodeURIComponent(app.id)}/environments" data-nav>Manage environments</a>`;
  const page = `<div class="overview-grid"><section class="overview-card card"><div class="overview-identity"><span class="app-icon" style="color:${esc(app.accent_color || "var(--accent)")};background:${esc(app.accent_color || "#62D6C9")}18;border-color:${esc(app.accent_color || "#62D6C9")}35">${esc(app.app_icon || "✦")}</span><div><h1>${esc(app.app_name)}</h1><p>${esc(typeLabels[app.app_type] || "Application")}</p></div></div><div class="meta-list"><div class="meta-row"><span>App status</span><strong><i class="status-dot ${healthGood ? "online" : ""}"></i> ${esc(draft ? "Setup in progress" : healthLabel)}</strong></div><div class="meta-row"><span>Running in</span><strong>${esc(deployed ? ({ development: "Development", preview: "Preview", staging: "Staging", production: "Production" }[deployed.kind] || deployed.kind) : "No deployed environment")}</strong></div><div class="meta-row"><span>Created</span><strong>${esc(dateLabel(app.created_at))}</strong></div><div class="meta-row"><span>Last updated</span><strong>${esc(dateLabel(app.setup_updated_at || app.created_at))}</strong></div></div><div class="action-row">${draft ? `<a class="button button-primary" href="${resumeSetupPath(app)}" data-nav>Continue Setup</a>` : `<span class="button" aria-disabled="true" title="This app has no verified preview URL yet">Open App · no preview</span>`}<a class="button" href="/apps/${encodeURIComponent(app.id)}/setup/basics" data-nav>Edit Setup</a></div></section><section class="overview-card card"><h2 class="section-title">What should I do next?</h2><p class="section-subtitle">${draft ? "Finish reviewing your app setup." : healthGood ? "Your latest environment reports healthy." : deployed ? "The latest environment is not reporting healthy." : "No deployment has been recorded for this app."}</p><div class="action-row">${nextAction}</div><div class="detail-grid" style="grid-template-columns:1fr 1fr;margin-top:20px"><div class="detail-tile"><span>Setup progress</span><strong>${draft ? `${progress} of ${SETUP_STEPS.length} steps` : "Complete"}</strong></div><div class="detail-tile"><span>Blueprint</span><strong>${blueprint ? `v${blueprint.version}` : stateResult ? "Not saved" : "State unavailable"}</strong></div><div class="detail-tile"><span>Repository</span><strong>${esc(repositoryStatus)}</strong></div><div class="detail-tile"><span>Information categories</span><strong>${Number.isInteger(modelCount) ? modelCount : "Not verified"}</strong></div><div class="detail-tile"><span>AI runtime</span><strong>${esc(aiHealth.status || "Unknown")}</strong></div><div class="detail-tile"><span>Environment health</span><strong>${esc(healthLabel)}</strong></div></div></section></div><section class="overview-card card" style="margin-top:16px"><div class="section-head"><div><h2 class="section-title">Recent activity</h2><p class="section-subtitle">Updates for this application.</p></div>${state.activity.length ? `<a class="button button-quiet" href="/apps/${encodeURIComponent(app.id)}/activity" data-nav>View activity</a>` : ""}</div>${activitySection()}</section>`;
  renderWorkspaceShell(app, "overview", page);
}

function renderWorkspaceShell(app, page, content) {
  const appPath = `/apps/${encodeURIComponent(app.id)}`;
  const requestedPane = new URLSearchParams(location.search).get("pane");
  const primaryPages = [
    { key: "home", label: "Home", href: "/apps", active: false },
    { key: "create", label: "Create", href: `${appPath}/code`, active: page === "code" && !["preview", "design", "data", "launch"].includes(requestedPane) },
    { key: "preview", label: "Preview", href: `${appPath}/code?pane=preview`, active: page === "code" && requestedPane === "preview" },
    { key: "design", label: "Design", href: `${appPath}/code?pane=design`, active: page === "code" && requestedPane === "design" },
    { key: "connections", label: "Connections", href: `${appPath}/relationships`, active: page === "relationships" },
    { key: "launch", label: "Launch", href: `${appPath}/code?pane=launch`, active: page === "code" && requestedPane === "launch" },
    { key: "my-app", label: "My App", href: appPath, active: page === "overview" }
  ];
  const primaryNav = primaryPages.map(item => `<a class="primary-app-link ${item.active ? "active" : ""}" href="${item.href}" data-nav ${item.active ? 'aria-current="page"' : ""}>${item.label}</a>`).join("");
  const groups = pageGroups.map(group => ({
    ...group,
    pages: group.pages.filter(([key]) => key !== "team" || state.features.teams === true)
  })).filter(group => group.pages.length).map(group => `<div class="workspace-nav-label">${group.label}</div><nav>${group.pages.map(([key, label, icon]) => `<a class="workspace-link ${page === key ? "active" : ""}" href="${key === "overview" ? appPath : `${appPath}/${key}`}" data-nav ${page === key ? 'aria-current="page"' : ""}><span class="workspace-link-icon">${icon}</span>${label}</a>`).join("")}</nav>`).join("");
  view.innerHTML = `<div class="workspace-layout"><header class="workspace-topbar"><a class="workspace-heading" href="${appPath}" data-nav><span class="app-icon" style="color:${esc(app.accent_color || "var(--accent)")}">${esc(app.app_icon || "✦")}</span><span><strong>${esc(app.app_name)}</strong><small>Application workspace</small></span></a><nav class="primary-app-nav" aria-label="Application">${primaryNav}</nav><details class="workspace-advanced"><summary>Advanced</summary><div class="workspace-advanced-menu">${groups}<a class="muted-line" href="/apps" data-nav>All apps</a></div></details></header><section class="workspace-content">${content}</section></div>`;
}

function replaceWorkspaceContent(content) {
  const current = $(".workspace-content", view);
  if (!current?.isConnected) return null;
  const next = document.createElement("section");
  next.className = current.className;
  next.innerHTML = content;
  current.replaceWith(next);
  return next;
}

function environmentRefreshError(root, error) {
  const feedback = $("[data-environment-feedback]", root);
  if (feedback) feedback.innerHTML = `<p class="error-banner" role="alert">${esc(error.message || "Environment status could not be refreshed.")}</p>`;
  const refresh = $("[data-refresh]", root);
  if (refresh) disabled(refresh, false);
  root.setAttribute("aria-busy", "false");
}

function disabled(control, value) {
  if (control) control.disabled = value;
}

async function refreshEnvironmentWorkspace(app, prefetchedResult = null) {
  const current = $(".workspace-content", view);
  if (!current?.isConnected) return false;
  const capabilityUi = await loadCapabilityUI();
  current.setAttribute("aria-busy", "true");
  if (!prefetchedResult) {
    disabled($("[data-refresh]", current), true);
    const feedback = $("[data-environment-feedback]", current);
    if (feedback) feedback.innerHTML = `<p class="cap-note" role="status">Checking the latest environment status…</p>`;
  }

  const result = prefetchedResult ? await prefetchedResult : await settle(loadEnvironments(app.id));
  if (!current.isConnected) return false;
  if (result.error) {
    if (current.querySelector("[data-environment-loading]")) {
      const errorRoot = replaceWorkspaceContent(capabilityUi.renderEnvironmentLoadingPanel(app, "workspace", { error: result.error.message }));
      if (errorRoot) {
        errorRoot.setAttribute("aria-busy", "false");
        await capabilityUi.mountCapabilityPanel(errorRoot, app, "environments", "workspace", () => refreshEnvironmentWorkspace(app));
      }
    } else environmentRefreshError(current, result.error);
    return false;
  }

  const content = await capabilityUi.renderCapabilityPanel(app, "environments", "workspace", { environmentPayload: result.value });
  if (!current.isConnected) return false;
  const next = replaceWorkspaceContent(content);
  if (!next) return false;
  next.setAttribute("aria-busy", "false");
  await capabilityUi.mountCapabilityPanel(next, app, "environments", "workspace", () => refreshEnvironmentWorkspace(app));
  return true;
}

function renderWorkspacePlaceholder(app, page) {
  const labels = Object.fromEntries(pageGroups.flatMap(group => group.pages.map(([key, label]) => [key, label])));
  const label = labels[page] || "Workspace";
  if (page === "settings") {
    renderApplicationSettings(app);
    return;
  }
  if (page === "code") {
    const pane = new URLSearchParams(location.search).get("pane");
    const paneQuery = ["preview", "design", "data", "launch"].includes(pane) ? `&pane=${encodeURIComponent(pane)}` : "";
    const content = `<div class="placeholder-card code-workspace-card card"><iframe title="FELTUS AI app workspace" src="/api/code/ui?app_id=${encodeURIComponent(app.id)}${paneQuery}&embedded=1" loading="lazy" referrerpolicy="no-referrer"></iframe></div>`;
    renderWorkspaceShell(app, page, content);
    return;
  }
  if (page === "logs") {
    const activities = state.activity.filter(item => item.app_id === app.id);
    const content = `<p class="eyebrow">Operate · Logs</p><h1 class="page-title">App activity</h1><p class="page-lede">Recent events recorded for ${esc(app.app_name)}.</p><section class="placeholder-card card" style="max-width:none">${activities.length ? `<div class="activity-list">${activities.map(item => `<div class="activity-item"><i class="status-dot ${item.severity === "error" ? "offline" : "online"}"></i><div><strong>${esc(item.message || item.event_type || "App activity")}</strong><small>${esc(item.event_type || "Event")} · ${esc(dateLabel(item.created_at))}</small></div></div>`).join("")}</div>` : `<div class="empty-state"><strong>No activity recorded yet</strong>Events will appear here as this app is configured.</div>`}</section>`;
    renderWorkspaceShell(app, page, content);
    return;
  }
  const capability = ({ deployments: "Deployment Control Plane", environments: "Environment Setup", team: "People", settings: "App Settings" })[page] || label;
  const reason = page === "team" ? "People management stays hidden until invitations and member controls are ready for everyday use." : page === "deployments" ? "Build and deployment orchestration are part of a later phase." : page === "settings" ? "App settings are edited through App Details and the current app APIs." : "Environment provisioning is not available in this phase.";
  const content = `<p class="eyebrow">${esc(pageGroups.find(group => group.pages.some(item => item[0] === page))?.label || "BUILD")} · ${esc(label)}</p><h1 class="page-title">${esc(label)}</h1><p class="page-lede">${esc(capability)} for ${esc(app.app_name)}.</p><div class="placeholder-card card"><span class="placeholder-badge">Available in a later phase</span><h2>${esc(capability)}</h2><p>${esc(reason)}</p><a class="button button-quiet" href="/apps/${encodeURIComponent(app.id)}" data-nav>Back to Overview</a></div>`;
  renderWorkspaceShell(app, page, content);
}

function lifecycleImpactMarkup(impact) {
  const deleted = impact.will_be_deleted || {};
  const preserved = impact.will_be_preserved || {};
  const detached = impact.will_be_detached || {};
  const external = impact.external_not_touched || {};
  const blockers = Array.isArray(impact.blockers) ? impact.blockers : [];
  const externalCount = ["repositories", "deployment_targets", "domains"].reduce((total, key) =>
    total + (Array.isArray(external[key]) ? external[key].length : 0), 0);
  const externalLines = [
    ...(Array.isArray(external.repositories) ? external.repositories.map(item =>
      `${item.provider || "Git"} repository ${item.repository || "linked"}${item.external_repository_id ? ` (${item.external_repository_id})` : ""}`) : []),
    ...(Array.isArray(external.deployment_targets) ? external.deployment_targets.map(item =>
      `${item.provider || "Hosting"} target ${item.resource_reference || "linked"}`) : []),
    ...(Array.isArray(external.domains) ? external.domains.map(item =>
      `${item.provider || "DNS"} domain ${item.domain || "linked"}`) : [])
  ];
  const modelLines = Array.isArray(deleted.models) ? deleted.models.map(model =>
    `${model.name || "Data model"}: ${Number(model.record_count || 0)} saved records`) : [];
  const blockerMarkup = blockers.length
    ? '<div class="error-banner" role="alert"><strong>Wait before deleting</strong><ul>' +
      blockers.map(item => "<li>" + esc(item.message || "An app task is still running.") + "</li>").join("") +
      "</ul></div>"
    : "";
  return `<section class="placeholder-card card" aria-label="Deletion summary">
    <h2>What happens to this app?</h2>
    <div class="lifecycle-impact-grid">
      <div><h3>Removed from FELTUS</h3><ul><li>${Number(deleted.models?.length || 0)} data categories and ${Number(deleted.model_rows || 0)} saved records${modelLines.length ? `<ul>${modelLines.map(line => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}</li><li>${Number(deleted.relationships || 0)} data links</li><li>${Number(deleted.documents || 0)} documents, ${Number(deleted.assets || 0)} app files, and the private code workspace</li><li>${Number(deleted.knowledge_bases || 0)} knowledge bases and ${Number(deleted.knowledge_chunks || 0)} knowledge records</li><li>${Number(deleted.secret_records || 0)} app secret records</li><li>${Number(deleted.conversations || 0)} conversations and ${Number(deleted.messages || 0)} messages</li><li>${Number(deleted.jobs || 0)} app tasks, ${Number(deleted.usage_records || 0)} usage records, and ${Number(deleted.tool_executions || 0)} tool records</li><li>App memberships</li></ul></div>
      <div><h3>Kept as history</h3><ul><li>${Number(preserved.blueprints || 0)} saved Blueprints</li><li>${Number(preserved.builds || 0)} builds and ${Number(preserved.artifacts || 0)} saved build files</li><li>${Number(preserved.deployments || 0)} deployment records</li><li>${Number(preserved.observations || 0)} state records and ${Number(preserved.audit_events || 0)} audit events</li><li>${Number(preserved.environments || 0)} environment records</li><li>The app’s history record</li></ul></div>
      <div><h3>Paused or unlinked in FELTUS</h3><ul><li>${Number(detached.repository_links || 0)} repository links</li><li>${Number(detached.deployment_targets_disabled || 0)} provider targets turned off</li><li>${Number(detached.environments_suspended || 0)} environments paused</li></ul></div>
      <div><h3>Outside FELTUS</h3><p>${externalCount ? externalCount + " connected service reference(s) will stay as they are." : "No connected service references were found."} GitHub, hosting, registry, domains, and other provider resources are never removed by this action.</p>${externalLines.length ? `<ul>${externalLines.map(line => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}<p>${Number(detached.repository_links || 0)} repository link(s) will be detached inside FELTUS. ${Number(detached.deployment_targets_disabled || 0)} deployment targets will be disabled and ${Number(detached.environments_suspended || 0)} app environments suspended. These changes do not contact those providers.</p></div>
    </div>
    ${blockerMarkup}
  </section>`;
}

async function renderApplicationSettings(app) {
  topCreate.hidden = true;
  const archived = (app.lifecycle_status || (app.setup_status === "archived" ? "archived" : "active")) === "archived";
  renderWorkspaceShell(app, "settings", "");
  const workspace = $(".workspace-content", view);
  workspace.innerHTML = `<p class="eyebrow">Manage · Settings</p><h1 class="page-title">App settings</h1><p class="page-lede">Choose what happens to ${esc(app.app_name)}.</p>
    <section class="placeholder-card card"><h2>${archived ? "Restore this app" : "Archive this app"}</h2><p>${archived ? "Bring this app back to your active workspace. Its data and history are still here." : "Hide this app from your active workspace. Its data, code, and history stay available."}</p><button class="button button-quiet" type="button" data-lifecycle-archive>${archived ? "Restore Application" : "Archive Application"}</button></section>
    <section class="placeholder-card card lifecycle-delete"><h2>Permanently delete this app</h2><p>This permanently removes FELTUS-managed app data and cannot be undone after cleanup finishes.</p><p><strong>External services and provider resources are not automatically deleted.</strong></p>
      <div data-lifecycle-impact role="status" aria-busy="true"><strong>Loading the deletion summary…</strong><p>We’re checking what belongs to this app.</p></div>
      <button class="button button-danger" type="button" data-lifecycle-show-delete disabled>Reviewing app data…</button>
      <form data-lifecycle-delete-form hidden><label for="lifecycle-confirm">Type <strong>${esc(app.app_name)}</strong> to continue</label><input class="input" id="lifecycle-confirm" name="confirmation" autocomplete="off" required><button class="button button-danger" type="submit" disabled>Permanently Delete Application</button><p data-lifecycle-error role="alert"></p></form>
    </section>
    <a class="button button-quiet" href="/apps/${encodeURIComponent(app.id)}" data-nav>Back to Overview</a>`;
  const impactRoot = workspace.querySelector("[data-lifecycle-impact]");
  const showDelete = workspace.querySelector("[data-lifecycle-show-delete]");
  const form = workspace.querySelector("[data-lifecycle-delete-form]");
  const input = workspace.querySelector("#lifecycle-confirm");
  const submit = form.querySelector('[type="submit"]');
  const errorRoot = form.querySelector("[data-lifecycle-error]");

  workspace.querySelector("[data-lifecycle-archive]").addEventListener("click", async event => {
    const button = event.currentTarget;
    const restoring = archived;
    if (!restoring && !window.confirm("Archive “" + app.app_name + "”? You can restore it later.")) return;
    button.disabled = true;
    button.textContent = restoring ? "Restoring…" : "Archiving…";
    try {
      await api("/api/apps/" + encodeURIComponent(app.id) + "/" + (restoring ? "restore" : "archive"), { method: "POST", body: "{}" });
      showToast(restoring ? "App restored." : "App archived.");
      navigate("/apps/" + encodeURIComponent(app.id) + "/settings");
    } catch (error) {
      button.disabled = false;
      button.textContent = restoring ? "Restore Application" : "Archive Application";
      showToast(error.message, "error");
    }
  });

  showDelete.addEventListener("click", () => {
    form.hidden = false;
    input.focus();
    showDelete.hidden = true;
  });
  input.addEventListener("input", () => { submit.disabled = input.value !== app.app_name; });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (submit.disabled || input.value !== app.app_name) return;
    submit.disabled = true;
    submit.textContent = "Requesting deletion…";
    errorRoot.textContent = "";
    try {
      await api("/api/apps/" + encodeURIComponent(app.id) + "/delete", {
        method: "POST", body: JSON.stringify({ confirmation: input.value })
      });
      navigate("/apps/" + encodeURIComponent(app.id) + "/deletion");
    } catch (error) {
      errorRoot.textContent = error.message;
      submit.textContent = "Permanently Delete Application";
      submit.disabled = input.value !== app.app_name;
    }
  });

  try {
    const impact = await api("/api/apps/" + encodeURIComponent(app.id) + "/deletion-impact");
    if (!workspace.isConnected) return;
    impactRoot.innerHTML = lifecycleImpactMarkup(impact);
    impactRoot.setAttribute("aria-busy", "false");
    showDelete.disabled = impact.can_delete !== true;
    showDelete.textContent = impact.can_delete === true ? "Review permanent deletion" : "Deletion is blocked";
  } catch (error) {
    if (!workspace.isConnected) return;
    impactRoot.setAttribute("aria-busy", "false");
    impactRoot.innerHTML = '<div class="error-banner" role="alert">' + esc(error.message) + ' <button class="button button-quiet" type="button" data-impact-retry>Try again</button></div>';
    impactRoot.querySelector("[data-impact-retry]").addEventListener("click", () => renderApplicationSettings(app));
    showDelete.hidden = true;
  }
}

function deletionStatusLabel(status) {
  return ({
    requested: "Deletion requested", validated: "Preparing deletion", tombstoned: "Preparing deletion",
    cleanup_pending: "Preparing deletion", cleanup_in_progress: "Deleting app data",
    cleanup_failed: "Deletion needs attention", cleanup_blocked: "Deletion needs attention",
    cleanup_complete: "Deletion complete"
  })[status] || "Checking deletion status";
}

async function renderApplicationDeletionStatus(appId) {
  topCreate.hidden = true;
  view.innerHTML = `<div class="main-wrap"><p class="eyebrow">Manage · App removal</p><h1 class="page-title">Removing this app</h1><section class="placeholder-card card" data-deletion-status role="status" aria-live="polite"><h2>Checking deletion status…</h2><p>This can take a little while. You can leave this page and come back later.</p></section></div>`;
  const statusRoot = view.querySelector("[data-deletion-status]");
  const poll = async () => {
    if (!statusRoot.isConnected || resolveAppRoute(location.pathname).kind !== "deletion-status") return;
    try {
      const status = await api("/api/apps/" + encodeURIComponent(appId) + "/deletion");
      const stateName = String(status.status || "");
      const terminal = ["cleanup_complete", "cleanup_failed", "cleanup_blocked"].includes(stateName);
      const errorNotice = status.last_error_code && stateName !== "cleanup_complete"
        ? '<p role="alert">We couldn’t finish cleanup. You can try again here.</p>'
        : "";
      const retryForm = terminal && stateName !== "cleanup_complete"
        ? '<form data-lifecycle-retry-form><label for="lifecycle-retry-confirm">Type <strong>' + esc(status.application_name || "") + '</strong> to retry</label><input class="input" id="lifecycle-retry-confirm" autocomplete="off" required><button class="button button-danger" type="submit" disabled>Retry cleanup</button><p data-lifecycle-retry-error role="alert"></p></form>'
        : "";
      const doneLink = stateName === "cleanup_complete" ? '<a class="button button-primary" href="/apps" data-nav>Back to Apps</a>' : "";
      statusRoot.innerHTML = "<h2>" + esc(deletionStatusLabel(stateName)) + "</h2><p>" +
        (stateName === "cleanup_complete" ? "FELTUS has finished removing the managed app data." : "Cleanup runs in the background. Your saved history stays protected.") +
        "</p>" + errorNotice + retryForm + doneLink;
      if (terminal && stateName !== "cleanup_complete") {
        const form = statusRoot.querySelector("[data-lifecycle-retry-form]");
        const input = form.querySelector("input");
        const button = form.querySelector("button[type=submit]");
        const error = form.querySelector("[data-lifecycle-retry-error]");
        input.addEventListener("input", () => { button.disabled = input.value !== status.application_name; });
        form.addEventListener("submit", async event => {
          event.preventDefault();
          if (button.disabled || input.value !== status.application_name) return;
          button.disabled = true;
          button.textContent = "Retrying…";
          try {
            await api("/api/apps/" + encodeURIComponent(appId) + "/delete", { method: "POST", body: JSON.stringify({ confirmation: input.value }) });
            await poll();
          } catch (failure) {
            error.textContent = failure.message;
            button.disabled = input.value !== status.application_name;
            button.textContent = "Retry cleanup";
          }
        });
      } else if (!terminal) {
        setTimeout(poll, 1800);
      }
    } catch (error) {
      statusRoot.innerHTML = '<h2>Deletion status is unavailable</h2><p>' + esc(error.message) + '</p><button class="button button-quiet" type="button" data-status-retry>Check again</button>';
      statusRoot.querySelector("[data-status-retry]").addEventListener("click", poll);
    }
  };
  await poll();
}

async function renderAppRoute(route) {
  if (route.kind === "deletion-status") {
    await renderApplicationDeletionStatus(route.appId);
    return;
  }
  if (route.kind === "workspace-page" && route.page === "team" && state.features.teams !== true) {
    renderNotFound();
    return;
  }
  const environmentLoad = route.kind === "workspace-page" && route.page === "environments"
    ? settle(loadCapabilityUI().then(capabilityUi => capabilityUi.loadEnvironments(route.appId)))
    : null;
  const app = await loadApp(route.appId);
  if (route.kind === "app-overview") {
    const activityPath = `/api/activity?app_id=${encodeURIComponent(app.id)}&limit=20`;
    state.activity = await api(activityPath).catch(() => []);
    await renderOverview(app);
    return;
  }
  if (["code", "source", "data", "relationships", "documents", "storage-backup", "ai", "builds", "deployments", "environments", "my-services", "my-environment", "activity", "logs", "infrastructure"].includes(route.page)) {
    if (environmentLoad) {
      const capabilityUi = await loadCapabilityUI();
      renderWorkspaceShell(app, route.page, capabilityUi.renderEnvironmentLoadingPanel(app, "workspace"));
      const root = $(".workspace-content", view);
      root?.setAttribute("aria-busy", "true");
      await refreshEnvironmentWorkspace(app, environmentLoad);
      return;
    }
    const capabilityUi = await loadCapabilityUI();
    const pane = route.page === "code" ? new URLSearchParams(location.search).get("pane") : null;
    const content = await capabilityUi.renderCapabilityPanel(app, route.page, "workspace", { pane });
    renderWorkspaceShell(app, route.page, content);
    capabilityUi.mountCapabilityPanel($(".workspace-content", view), app, route.page, "workspace", () => renderRoute());
    return;
  }
  renderWorkspacePlaceholder(app, route.page);
}

function renderNotFound() {
  topCreate.hidden = false;
  view.innerHTML = `<div class="main-wrap"><div class="empty-state"><strong>We couldn’t find that page</strong>The link may be outdated, or the app may no longer be available.<div class="action-row" style="justify-content:center"><a class="button button-primary" href="/apps" data-nav>Back to Apps</a></div></div></div>`;
}

async function renderRoute() {
  const route = resolveAppRoute(location.pathname);
  state.route = route;
  document.body.classList.toggle("code-workspace-route", route.kind === "workspace-page" && route.page === "code");
  document.body.classList.toggle("app-workspace-route", ["new-basics", "setup-step", "app-overview", "workspace-page", "deletion-status"].includes(route.kind));
  const navSection = route.kind === "home" ? "home"
    : ["services", "services-use"].includes(route.kind) ? "services"
      : route.kind === "domains" ? "domains"
        : route.kind === "activity" ? "activity"
          : route.kind === "usage" ? "usage"
            : route.kind === "settings" ? "settings"
          : ["apps", "existing-app-import", "new-app", "new-basics", "setup-step", "app-overview", "workspace-page", "deletion-status"].includes(route.kind) ? "projects"
            : "";
  document.querySelectorAll("[data-nav-section]").forEach(link => {
    const active = link.dataset.navSection === navSection;
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (route.kind !== "home") homeMetadataGeneration += 1;
  view.setAttribute("aria-busy", "true");
  try {
    if (["home", "apps", "services-use", "domains", "activity"].includes(route.kind)) {
      await loadApps();
      if (route.kind === "home") {
        await renderHome();
      } else if (route.kind === "apps") renderApps();
      else if (route.kind === "services-use") await renderServicesUse();
      else if (route.kind === "domains") renderDomains();
      else await renderActivityPage();
    } else if (route.kind === "usage") {
      renderUsage();
    } else if (route.kind === "settings") {
      renderSettings();
    } else if (route.kind === "services") {
      await renderServices();
    } else if (route.kind === "existing-app-import") {
      await renderExistingAppImport();
    } else if (route.kind === "new-app") renderEntry();
    else if (route.kind === "new-basics" || route.kind === "setup-step") await renderSetupRoute(route);
    else if (route.kind === "app-overview" || route.kind === "workspace-page" || route.kind === "deletion-status") await renderAppRoute(route);
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
  const serviceToggle = event.target.closest("[data-service-toggle]");
  if (serviceToggle) {
    const id = serviceToggle.dataset.serviceToggle;
    const selected = selectedServicesFromLocation();
    saveSelectedServices(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]);
    renderServices();
    return;
  }
  const fullPlatform = event.target.closest("[data-full-platform]");
  if (fullPlatform) {
    const current = selectedServicesFromLocation();
    const fullSelected = FELTUS_FULL_PLATFORM_SERVICE_IDS.every(id => current.includes(id));
    saveSelectedServices(fullSelected ? [] : [...FELTUS_FULL_PLATFORM_SERVICE_IDS]);
    renderServices();
    return;
  }
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
    document.body.classList.remove("login-view");
    state.features = { teams: session?.features?.teams === true };
    state.loaded = true;
    await renderRoute();
  } catch (error) {
    view.innerHTML = `<div class="main-wrap"><div class="error-banner" role="alert">FELTUS could not verify your session. ${esc(error.message)} <button class="button button-quiet" type="button" onclick="location.reload()">Try again</button></div></div>`;
  }
}

requestAnimationFrame(() => requestAnimationFrame(() => { void start(); }));
