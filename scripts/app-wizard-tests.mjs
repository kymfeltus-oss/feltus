import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApplicationStateHandler } from "../src/lib/feltus-application-state-api.js";
import {
  INFRASTRUCTURE_COMPONENTS,
  INFRASTRUCTURE_CONTRACT
} from "../src/lib/feltus-infrastructure-contract.js";
import {
  APP_TYPES,
  SETUP_STEPS,
  WORKSPACE_PAGES,
  createAppWizardHandler,
  isAppShellRoute,
  nextSetupRoute,
  previousSetupRoute,
  resolveAppRoute,
  resumeSetupPath,
  validateAppBasics,
  validateSetupData
} from "../src/lib/feltus-app-wizard.js";
import {
  blueprintViewFromSave,
  collectCapabilityDraft,
  createBlueprintSaveController,
  customerInfrastructureStatus,
  escapeCapabilityHtml,
  loadEnvironments,
  mountCapabilityPanel,
  renderCapabilityPanel,
  renderEnvironmentLoadingPanel
} from "../src/app-wizard/capabilities.js";

const appWizardSource = readFileSync(new URL("../src/app-wizard/app.js", import.meta.url), "utf8");
const appWizardCss = readFileSync(new URL("../src/app-wizard/app.css", import.meta.url), "utf8");
const capabilitiesSource = readFileSync(new URL("../src/app-wizard/capabilities.js", import.meta.url), "utf8");
const applicationStateSource = readFileSync(new URL("../src/lib/feltus-application-state-api.js", import.meta.url), "utf8");
const appShellHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const productServerSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const certificationFixturePath = fileURLToPath(new URL("../scripts/certification-browser-fixture.mjs", import.meta.url));
const certificationFixtureWithoutTestFlag = spawnSync(process.execPath, [certificationFixturePath], {
  encoding: "utf8",
  timeout: 5000
});
assert.equal(certificationFixtureWithoutTestFlag.status, 1);
assert.match(certificationFixtureWithoutTestFlag.stderr, /test-only/i);
assert.doesNotMatch(productServerSource, /certification-browser-fixture|__fixture\/github-authorization/);
assert.match(appWizardSource, /api\("\/api\/github\/status"\)/);
assert.match(appWizardSource, /GitHub connection is unavailable right now/);
assert.match(appWizardSource, /await renderExistingAppImport\(\)/);
assert.match(appWizardSource, /async function renderServices\(\)/);
assert.doesNotMatch(appWizardSource, /route\.kind === "services-use" && selectedServicesFromLocation\(\)\.includes\("my_services"\)/);
assert.match(appWizardSource, /"my-services", "My Services"/);
assert.match(appWizardSource, /"my-environment", "My Environment"/);
assert.match(capabilitiesSource, /data-registration-form="services"/);
assert.match(capabilitiesSource, /data-registration-form="environments"/);
assert.match(capabilitiesSource, /A record is not a connection/);
assert.match(appWizardSource, /Available from an app/);
assert.match(appWizardSource, /Data & Sign-In[\s\S]*Available for selected apps[\s\S]*Generated-app users sign in separately from FELTUS workspace users/);
assert.match(appWizardSource, /Storage & Backup[\s\S]*Available[\s\S]*Create app-only backups and restore an available backup/i);
assert.equal(customerInfrastructureStatus({ status: "CONFIGURED", verification: { status: "VERIFIED" } }), "Ready");
assert.equal(customerInfrastructureStatus({ status: "CONFIGURED", verification: { status: "UNVERIFIED" } }), "Not checked");
assert.equal(customerInfrastructureStatus({ status: "PARTIAL" }), "Needs attention");
assert.equal(customerInfrastructureStatus({ status: "NOT_CONFIGURED" }), "Setting up");
assert.equal(customerInfrastructureStatus({ status: "UNAVAILABLE" }), "Unavailable");
assert.equal(customerInfrastructureStatus({ status: "UNKNOWN" }), "Not connected");
const customerInfrastructure = {
  contract: INFRASTRUCTURE_CONTRACT,
  mode: "CUSTOMER_MANAGED",
  components: Object.fromEntries(INFRASTRUCTURE_COMPONENTS.map(component => [component, {
    owner: "CUSTOMER",
    management: "CUSTOMER_MANAGED",
    status: "CONFIGURED",
    ...(component === "database" ? { resource_reference: "customer-db-1" } : {})
  }]))
};

assert.doesNotMatch(`${capabilitiesSource}\n${applicationStateSource}`, /RETAIL THERAPY|retail-therapy/i,
  "source initialization and canonical intelligence logic must not recognize one acceptance app");

const ids = [randomUUID(), randomUUID()];

const savedBlueprintFixture = {
  blueprint: {
    id: "12121212-1212-4212-8212-121212121212",
    version: 3,
    state_hash: "f".repeat(64),
    source_commit: "c".repeat(40),
    state: { desired_state: { data: { models: [{ name: "customers" }] }, code: { commit: "c".repeat(40) } } }
  },
  state_hash: "f".repeat(64),
  yaml: "---\ncontract: feltus.application-state/v1\n",
  export_url: `/api/apps/${ids[0]}/blueprints/12121212-1212-4212-8212-121212121212/export`
};

{
  let resolveSave;
  const saveCalls = [];
  const controller = createBlueprintSaveController(ids[0], {
    request: (path, options) => {
      saveCalls.push({ path, options });
      return new Promise(resolve => { resolveSave = resolve; });
    }
  });
  const pendingSave = controller.save();
  assert.equal(controller.pending, true);
  assert.equal(await controller.save(), null, "a second click while saving must not create another Blueprint");
  assert.equal(saveCalls.length, 1);
  assert.equal(saveCalls[0].path, `/api/apps/${ids[0]}/blueprints`);
  assert.equal(saveCalls[0].options.method, "POST");
  resolveSave(savedBlueprintFixture);
  const savedResult = await pendingSave;
  assert.equal(controller.pending, false);
  assert.equal(savedResult.blueprint.id, savedBlueprintFixture.blueprint.id);

  const savedView = blueprintViewFromSave(savedResult);
  assert.equal(savedView.blueprint.version, 3);
  assert.equal(savedView.blueprint.state_hash, "f".repeat(64));
  assert.equal(savedView.exportUrl, savedBlueprintFixture.export_url);
  assert.match(savedView.status, /Version 3/);
  assert.match(savedView.status, /Blueprint 12121212/);
  assert.match(savedView.status, /Commit cccccccc/);
  assert.match(savedView.status, new RegExp(`SHA-256 ${"f".repeat(64)}`));
  assert.match(savedView.yaml, /feltus\.application-state\/v1/);
}

{
  let attempts = 0;
  const controller = createBlueprintSaveController(ids[0], {
    request: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Save failed");
      return savedBlueprintFixture;
    }
  });
  await assert.rejects(controller.save(), /Save failed/);
  assert.equal(controller.pending, false, "a failed save must return the control to a usable state");
  assert.equal((await controller.save()).blueprint.version, 3);
  assert.equal(attempts, 2);
}

{
  const drawerSource = capabilitiesSource.match(/async function openBlueprintDrawer[\s\S]*?\nfunction showLocalNotice/)?.[0] || "";
  const initialRefresh = drawerSource.match(/const refreshBlueprint = async \(\) => \{[\s\S]*?\n  \};/)?.[0] || "";
  const saveHandler = drawerSource.match(/saveButton\.addEventListener\("click"[\s\S]*?\n  \}\);/)?.[0] || "";
  assert.match(initialRefresh, /Promise\.all\(/, "initial state and Blueprint history should load in parallel");
  assert.doesNotMatch(saveHandler, /refreshBlueprint\(/, "save must use its authoritative response instead of refetching drawer data");
  assert.match(saveHandler, /blueprintViewFromSave\(result\)/);
}

let user = { id: "10000000-0000-4000-8000-000000000001" };
const records = [];
let nextId = 0;
const insertPreferences = [];
const readQueries = [];

function parseFilter(query, key) {
  const match = new RegExp(`[?&]${key}=eq\.([^&]+)`).exec(query || "");
  return match ? decodeURIComponent(match[1]) : null;
}

async function tableRequest(table, method, { query = "", body = null, prefer = "return=representation" } = {}) {
  assert.equal(table, "feltus_applications");
  if (method === "GET") {
    readQueries.push(query);
    const owner = parseFilter(query, "owner_id");
    const id = parseFilter(query, "id");
    const lifecycleMatch = /[?&]lifecycle_status=in\.\(([^)]*)\)/.exec(query || "");
    const lifecycles = lifecycleMatch ? lifecycleMatch[1].split(",") : null;
    return { status: 200, data: records.filter(row => (!owner || row.owner_id === owner) && (!id || row.id === id) && (!lifecycles || lifecycles.includes(row.lifecycle_status))).map(row => structuredClone(row)) };
  }
  if (method === "POST") {
    insertPreferences.push(prefer);
    if (records.some(row => row.app_name === body.app_name)) {
      return { status: 409, data: { code: "23505" } };
    }
    nextId += 1;
    const id = body.id || ids[nextId - 1] || `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
    const row = {
      id,
      owner_id: body.owner_id,
      app_name: body.app_name,
      environment: body.environment,
      description: body.description,
      app_type: body.app_type,
      app_icon: body.app_icon,
      accent_color: body.accent_color,
      setup_status: body.setup_status,
      lifecycle_status: "active",
      archive_previous_setup_status: null,
      lifecycle_request_id: null,
      lifecycle_cleanup_progress: {},
      lifecycle_retry_count: 0,
      lifecycle_snapshot: {},
      setup_current_step: body.setup_current_step,
      setup_completed_steps: body.setup_completed_steps,
      setup_data: body.setup_data,
      created_at: "2026-11-03T12:00:00.000Z",
      setup_updated_at: "2026-11-03T12:00:00.000Z"
    };
    records.push(row);
    return { status: 201, data: prefer === "return=minimal" ? null : [structuredClone(row)] };
  }
  if (method === "PATCH") {
    const id = parseFilter(query, "id");
    const owner = parseFilter(query, "owner_id");
    const row = records.find(item => item.id === id && item.owner_id === owner);
    if (!row) return { status: 200, data: [] };
    Object.assign(row, structuredClone(body));
    return { status: 200, data: [structuredClone(row)] };
  }
  throw new Error(`Unexpected table method: ${method}`);
}

async function readBody(request) {
  return request.body;
}

async function rpcRequest(functionName, body) {
  const app = records.find(row => row.id === body.p_app_id && row.owner_id === user.id);
  if (!app) return { status: 404, data: { message: "Application not found." } };
  if (functionName === "feltus_set_application_archive") {
    if (!["active", "archived"].includes(app.lifecycle_status)) return { status: 409, data: { message: "Application deletion has started." } };
    if (body.p_archived) {
      if (app.lifecycle_status !== "archived") app.archive_previous_setup_status = app.setup_status;
      app.lifecycle_status = "archived";
      app.setup_status = "archived";
    } else {
      app.lifecycle_status = "active";
      app.setup_status = app.archive_previous_setup_status || "active";
      app.archive_previous_setup_status = null;
    }
    return { status: 200, data: { app_id: app.id, lifecycle_status: app.lifecycle_status, changed: true } };
  }
  if (functionName === "feltus_application_deletion_impact") {
    if (!["active", "archived"].includes(app.lifecycle_status)) return { status: 409, data: { message: "Application deletion is already in progress." } };
    return { status: 200, data: {
      application: { id: app.id, name: app.app_name, lifecycle_status: app.lifecycle_status },
      will_be_deleted: { models: [], model_rows: 0, documents: 0, assets: 0, knowledge_bases: 0, conversations: 0, messages: 0, jobs: 0, secret_records: 0 },
      will_be_preserved: { blueprints: 1, builds: 0, artifacts: 0, deployments: 0 },
      external_not_touched: { repositories: [], deployment_targets: [], domains: [], notice: "External resources remain untouched." },
      blockers: [], can_delete: true
    } };
  }
  if (functionName === "feltus_application_deletion_status") {
    return { status: 200, data: { app_id: app.id, application_name: app.app_name, status: app.lifecycle_status, request_id: app.lifecycle_request_id, progress: app.lifecycle_cleanup_progress, impact: app.lifecycle_snapshot, retry_count: app.lifecycle_retry_count, complete: app.lifecycle_status === "cleanup_complete" } };
  }
  if (functionName === "feltus_request_application_deletion") {
    if (body.p_confirmation !== app.app_name) return { status: 400, data: { message: "Enter the exact application name to confirm permanent deletion." } };
    if (app.lifecycle_status === "cleanup_pending" || app.lifecycle_status === "cleanup_in_progress") {
      return { status: 200, data: { app_id: app.id, request_id: app.lifecycle_request_id, status: app.lifecycle_status, idempotent: true } };
    }
    if (!["active", "archived", "cleanup_failed", "cleanup_blocked"].includes(app.lifecycle_status)) return { status: 409, data: { message: "Application lifecycle does not allow deletion." } };
    app.lifecycle_request_id ||= randomUUID();
    const retrying = ["cleanup_failed", "cleanup_blocked"].includes(app.lifecycle_status);
    if (retrying) app.lifecycle_retry_count += 1;
    app.lifecycle_status = "cleanup_pending";
    app.lifecycle_snapshot = {
      application: { id: app.id, name: app.app_name },
      will_be_deleted: { models: [], documents: 0, assets: 0 },
      will_be_preserved: { blueprints: 1 },
      external_not_touched: { repositories: [], deployment_targets: [], domains: [] },
      can_delete: true
    };
    app.lifecycle_cleanup_progress = { files_removed: false, database_removed: false };
    return { status: 200, data: { app_id: app.id, request_id: app.lifecycle_request_id, status: "cleanup_pending", retrying, retry_count: app.lifecycle_retry_count, impact: app.lifecycle_snapshot } };
  }
  return { status: 404, data: { message: "Lifecycle operation not found." } };
}

function response() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
    json() { return JSON.parse(this.body); }
  };
}

const handler = createAppWizardHandler({
  tableRequest,
  readBody,
  getUser: () => user,
  rpcRequest,
  env: {
    FELTUS_ENV: "development",
    FELTUS_PUBLIC_URL: "http://feltus.test",
    FELTUS_GITHUB_CLIENT_ID: "test-client-id",
    FELTUS_GITHUB_CLIENT_SECRET: "test-client-secret",
    FELTUS_SECRET_ENCRYPTION_KEY: "test-secret-encryption-key-long-enough"
  }
});

async function dispatch(method, pathname, body = {}) {
  const res = response();
  const handled = await handler({ method, body }, res, new URL(`http://feltus.test${pathname}`));
  assert.equal(handled, true, `${method} ${pathname} should be handled`);
  return res;
}

assert.deepEqual(APP_TYPES, ["web_application", "internal_tool", "api_backend", "ai_application", "data_application", "other"]);
assert.deepEqual(SETUP_STEPS, ["basics", "data", "knowledge", "ai", "code", "environment", "review"]);
assert.equal(WORKSPACE_PAGES.length, 18);
const workspacePrimaryNav = appWizardSource.match(/const primaryPages = \[([\s\S]*?)\n  \];/)?.[1] || "";
for (const destination of ["Home", "Create", "Preview", "Design", "Connections", "Launch", "My App"]) {
  assert.ok(workspacePrimaryNav.includes(`label: "${destination}"`), `workspace navigation must render ${destination}`);
}
assert.match(appWizardSource, /href: `\$\{appPath\}\/relationships`/, "Connections navigation preserves the existing app route");
assert.match(appWizardCss, /body\.code-workspace-route \.workspace-layout\{[^}]*grid-template-columns:minmax\(0,1fr\)/, "the CODE workspace uses one full-width navigation/content column");
assert.match(appWizardCss, /@media\(max-width:760px\)[\s\S]*body\.code-workspace-route \.primary-app-nav\{[^}]*position:fixed/, "mobile workspace navigation stays fixed at the bottom");
assert.equal(resolveAppRoute("/").kind, "home");
assert.equal(resolveAppRoute("/apps").kind, "apps");
assert.equal(resolveAppRoute("/apps/new").kind, "new-app");
assert.equal(resolveAppRoute("/apps/new/basics").kind, "new-basics");
assert.equal(resolveAppRoute("/services").kind, "services");
assert.equal(resolveAppRoute("/services/use").kind, "services-use");
assert.equal(resolveAppRoute("/domains").kind, "domains");
assert.equal(resolveAppRoute("/activity").kind, "activity");
assert.equal(resolveAppRoute("/usage").kind, "usage");
assert.equal(resolveAppRoute("/settings").kind, "settings");
assert.equal(resolveAppRoute("/apps/import").kind, "existing-app-import");
assert.deepEqual(resolveAppRoute(`/apps/${ids[0]}/deletion`), { kind: "deletion-status", appId: ids[0] });
for (const step of SETUP_STEPS) {
  const route = resolveAppRoute(`/apps/${ids[0]}/setup/${step}`);
  assert.deepEqual(route, { kind: "setup-step", appId: ids[0], step });
  assert.equal(isAppShellRoute(`/apps/${ids[0]}/setup/${step}`), true);
}
for (const page of WORKSPACE_PAGES) {
  const route = resolveAppRoute(page === "overview" ? `/apps/${ids[0]}` : `/apps/${ids[0]}/${page}`);
  assert.deepEqual(route, page === "overview"
    ? { kind: "app-overview", appId: ids[0] }
    : { kind: "workspace-page", appId: ids[0], page });
  assert.equal(isAppShellRoute(page === "overview" ? `/apps/${ids[0]}` : `/apps/${ids[0]}/${page}`), true);
}
assert.equal(isAppShellRoute("/apps/not-a-uuid"), false);
assert.equal(isAppShellRoute("/not-a-route"), false);
assert.equal(nextSetupRoute(ids[0], "basics"), `/apps/${ids[0]}/setup/data`);
assert.equal(previousSetupRoute(ids[0], "data"), `/apps/${ids[0]}/setup/basics`);
assert.equal(nextSetupRoute(ids[0], "ai"), `/apps/${ids[0]}/setup/code`);
assert.equal(nextSetupRoute(ids[0], "review"), null);
assert.equal(resumeSetupPath({ id: ids[0], setup_current_step: "data" }), `/apps/${ids[0]}/setup/data`);
assert.equal(resumeSetupPath({ id: ids[0], setup_current_step: "relationships" }), `/apps/${ids[0]}/setup/data`);
assert.equal(resumeSetupPath({ id: ids[0], setup_current_step: "documents" }), `/apps/${ids[0]}/setup/knowledge`);
assert.equal(resumeSetupPath({ id: ids[0], setup_current_step: "build" }), `/apps/${ids[0]}/setup/review`);
assert.deepEqual(resolveAppRoute(`/apps/${ids[0]}/setup/relationships`), { kind: "workspace-page", appId: ids[0], page: "relationships" });
assert.deepEqual(resolveAppRoute(`/apps/${ids[0]}/setup/documents`), { kind: "setup-step", appId: ids[0], step: "knowledge" });
assert.deepEqual(resolveAppRoute(`/apps/${ids[0]}/storage-backup`), { kind: "workspace-page", appId: ids[0], page: "storage-backup" });
assert.equal(escapeCapabilityHtml(`<script title="x">'&</script>`), "&lt;script title=&quot;x&quot;&gt;&#39;&amp;&lt;/script&gt;");

assert.throws(() => validateAppBasics({ app_name: " " }), error => error.field === "app_name");
assert.throws(() => validateAppBasics({ app_name: "Good", app_type: "unknown" }), error => error.field === "app_type");
assert.throws(() => validateAppBasics({ app_name: "Good", accent_color: "red" }), error => error.field === "accent_color");
assert.throws(() => validateSetupData({ github_token: "never store" }), /Secrets must be stored/);
assert.deepEqual(validateSetupData({ ai: { max_tokens: 2048 } }), { ai: { max_tokens: 2048 } });
assert.deepEqual(validateAppBasics({ app_name: "  Scout  ", app_type: "web_application" }), {
  app_name: "Scout", description: "", app_type: "web_application", app_icon: "✦", accent_color: "#62D6C9"
});

const invalid = await dispatch("POST", "/api/apps", { app_name: "", app_type: "web_application" });
assert.equal(invalid.status, 400, "invalid basics should not create an app");
assert.equal(records.length, 0, "validation failure should leave no draft");

const forgedRegistrationDraft = await dispatch("POST", "/api/apps", {
  app_name: "Forged registration",
  app_type: "other",
  setup_data: { infrastructure_registrations: { services: [], environments: [] } }
});
assert.equal(forgedRegistrationDraft.status, 400, "app creation cannot forge server-observed infrastructure registrations");
assert.equal(records.length, 0, "rejected registration data must not create an app");

const draftResponse = await dispatch("POST", "/api/apps", {
  app_name: "Northstar",
  description: "Support operations",
  setup_data: { intent_details: "Used by a five person support team." },
  app_type: "internal_tool",
  app_icon: "◉",
  accent_color: "#88AACC",
  continue_setup: false
});
assert.equal(draftResponse.status, 201);
const draft = draftResponse.json().app;
assert.equal(insertPreferences.at(-1), "return=minimal", "app creation avoids same-statement RLS row representation");
assert.ok(readQueries.some(query => query.includes(`id=eq.${draft.id}`) && query.includes(`owner_id=eq.${user.id}`)), "created app is fetched through the owner-scoped read route");
assert.equal(draft.setup_status, "draft");
assert.equal(draft.setup_current_step, "basics");
assert.deepEqual(draft.setup_completed_steps, []);
assert.equal(draft.owner_id, user.id);
assert.equal(draft.setup_data.intent_details, "Used by a five person support team.");
assert.equal(draft.setup_data.product_path, "build_with_feltus");
assert.deepEqual(draft.setup_data.platform_service_defaults, ["hosting", "publish"]);
const buildInfrastructureDefaults = draft.setup_data.infrastructure;

const duplicate = await dispatch("POST", "/api/apps", { app_name: "Northstar", app_type: "other" });
assert.equal(duplicate.status, 409);
assert.equal(duplicate.json().field, "app_name");
assert.equal(records.length, 1, "duplicate name should not create another app");

const savedStep = await dispatch("PATCH", `/api/apps/${draft.id}/setup`, {
  setup_current_step: "data",
  setup_completed_steps: ["basics"],
  setup_status: "configuring",
  setup_data: { data: { wants_database: true, tables: ["customers"] }, infrastructure: customerInfrastructure }
});
assert.equal(savedStep.status, 200);
assert.equal(savedStep.json().app.setup_status, "configuring");
assert.equal(savedStep.json().app.setup_current_step, "data");
assert.deepEqual(savedStep.json().app.setup_completed_steps, ["basics"]);
assert.equal(resumeSetupPath(savedStep.json().app), `/apps/${draft.id}/setup/data`);

records[0].setup_status = "archived";
assert.equal((await dispatch("GET", `/api/apps/${draft.id}`)).status, 200,
  "legacy setup_status must not archive an application whose canonical lifecycle is active");
const legacyArchiveEdit = await dispatch("PATCH", `/api/apps/${draft.id}/setup`, { description: "Still active" });
assert.equal(legacyArchiveEdit.status, 200,
  "legacy setup_status must not block an active application's setup updates");
records[0].lifecycle_status = "archived";
records[0].setup_status = "configuring";
const canonicalArchiveEdit = await dispatch("PATCH", `/api/apps/${draft.id}/setup`, { description: "Must remain archived" });
assert.equal(canonicalArchiveEdit.status, 409,
  "canonical archived lifecycle must block edits even when setup progress says configuring");
records[0].lifecycle_status = "active";
records[0].setup_status = "configuring";

const afterReload = await dispatch("GET", `/api/apps/${draft.id}`);
assert.equal(afterReload.status, 200);
assert.deepEqual(afterReload.json().app.setup_data, {
  intent_details: "Used by a five person support team.",
  data: { wants_database: true, tables: ["customers"] },
  infrastructure: customerInfrastructure,
  product_path: "build_with_feltus",
  platform_service_defaults: ["hosting", "publish"]
});
assert.deepEqual(buildInfrastructureDefaults.components.runtime_hosting, {
  owner: "FELTUS", management: "FELTUS_MANAGED", status: "NOT_CONFIGURED", ownership_configured: true
});

const rejectedSecret = await dispatch("PATCH", `/api/apps/${draft.id}/setup`, { setup_data: { ai: { api_key: "secret" } } });
assert.equal(rejectedSecret.status, 400);
assert.deepEqual(records[0].setup_data, {
  intent_details: "Used by a five person support team.",
  data: { wants_database: true, tables: ["customers"] },
  infrastructure: customerInfrastructure,
  product_path: "build_with_feltus",
  platform_service_defaults: ["hosting", "publish"]
});

const registrationTime = new Date().toISOString();
const serverRegistrations = {
  services: [{
    id: randomUUID(),
    type: "api_endpoint",
    component: "monitoring_health",
    name: "API",
    provider: null,
    owner: "CUSTOMER",
    management: "CUSTOMER_MANAGED",
    endpoint: "https://api.example.com",
    observation: {
      method: "HTTP_HEAD",
      status: "REACHABLE",
      checked_at: registrationTime,
      http_status: 200,
      failure_code: null
    },
    created_at: registrationTime,
    updated_at: registrationTime
  }],
  environments: []
};
records[0].setup_data.infrastructure_registrations = serverRegistrations;
const forgedRegistrationUpdate = await dispatch("PATCH", `/api/apps/${draft.id}/setup`, {
  setup_data: { infrastructure_registrations: { services: [], environments: [] } }
});
assert.equal(forgedRegistrationUpdate.status, 400, "generic setup updates cannot forge endpoint-observation state");
assert.deepEqual(records[0].setup_data.infrastructure_registrations, serverRegistrations,
  "rejected registration updates must preserve server-observed state");
delete records[0].setup_data.infrastructure_registrations;

const invalidStep = await dispatch("PATCH", `/api/apps/${draft.id}/setup`, { setup_current_step: "ship" });
assert.equal(invalidStep.status, 400);

const ownerBefore = user;
user = { id: "20000000-0000-4000-8000-000000000001" };
const isolated = await dispatch("GET", `/api/apps/${draft.id}`);
assert.equal(isolated.status, 404, "another owner cannot read the app");
user = ownerBefore;

const archive = await dispatch("POST", `/api/apps/${draft.id}/archive`);
assert.equal(archive.status, 200);
assert.equal(archive.json().app.setup_status, "archived");
const archivedList = await dispatch("GET", "/api/apps");
assert.equal(archivedList.status, 200);
assert.equal(archivedList.json()[0].setup_status, "archived");
assert.equal(archivedList.json()[0].lifecycle_status, "archived");
assert.deepEqual(archivedList.json()[0].setup_data.data, { wants_database: true, tables: ["customers"] }, "archive keeps app configuration intact");
assert.deepEqual(archivedList.json()[0].setup_data.infrastructure, customerInfrastructure,
  "archive preserves customer-owned infrastructure configuration");
user = { id: "20000000-0000-4000-8000-000000000001" };
const unauthorizedArchive = await dispatch("POST", `/api/apps/${draft.id}/archive`);
assert.equal(unauthorizedArchive.status, 404, "another owner cannot archive an app");
user = ownerBefore;
const restored = await dispatch("POST", `/api/apps/${draft.id}/restore`);
assert.equal(restored.status, 200);
assert.equal(restored.json().app.setup_status, "configuring", "restore resumes the setup status from before archive");
assert.equal(restored.json().app.lifecycle_status, "active");

user = { id: "20000000-0000-4000-8000-000000000001" };
const unauthorizedDelete = await dispatch("POST", `/api/apps/${draft.id}/delete`, { confirmation: draft.app_name });
assert.equal(unauthorizedDelete.status, 404, "another owner cannot request app deletion");
user = ownerBefore;
const wrongDeleteConfirmation = await dispatch("POST", `/api/apps/${draft.id}/delete`, { confirmation: "North Star" });
assert.equal(wrongDeleteConfirmation.status, 400, "permanent deletion requires the exact app name");
const deletionImpact = await dispatch("GET", `/api/apps/${draft.id}/deletion-impact`);
assert.equal(deletionImpact.status, 200);
assert.equal(deletionImpact.json().can_delete, true);
assert.equal(deletionImpact.json().will_be_preserved.blueprints, 1);
assert.equal(deletionImpact.json().external_not_touched.notice, "External resources remain untouched.");
assert.deepEqual(records[0].setup_data.infrastructure, customerInfrastructure,
  "deletion impact inspection does not mutate customer-owned infrastructure configuration");
const deletionRequest = await dispatch("POST", `/api/apps/${draft.id}/delete`, { confirmation: draft.app_name });
assert.equal(deletionRequest.status, 202);
assert.equal(deletionRequest.json().status, "cleanup_pending");
assert.deepEqual(records[0].setup_data.infrastructure, customerInfrastructure,
  "deletion request leaves customer-owned infrastructure configuration untouched");
const tombstonedApp = await dispatch("GET", `/api/apps/${draft.id}`);
assert.equal(tombstonedApp.status, 404, "tombstoned apps are hidden from normal app routes");
const tombstonedEdit = await dispatch("PATCH", `/api/apps/${draft.id}/setup`, { description: "late edit" });
assert.equal(tombstonedEdit.status, 404, "tombstoned apps reject setup edits and stay hidden from normal app routes");
const deletionStatus = await dispatch("GET", `/api/apps/${draft.id}/deletion`);
assert.equal(deletionStatus.status, 200);
assert.equal(deletionStatus.json().status, "cleanup_pending");
assert.equal(deletionStatus.json().application_name, draft.app_name, "deletion status retains the exact confirmation name");
const activeAppsAfterRequest = await dispatch("GET", "/api/apps");
assert.equal(activeAppsAfterRequest.json().some(app => app.id === draft.id), false, "deleting apps leave the normal app list");
const deletionQueue = await dispatch("GET", "/api/apps/deletions");
assert.equal(deletionQueue.status, 200);
assert.equal(deletionQueue.json()[0].id, draft.id, "deletion progress remains visible in its separate queue");
const duplicateDelete = await dispatch("POST", `/api/apps/${draft.id}/delete`, { confirmation: draft.app_name });
assert.equal(duplicateDelete.status, 202);
assert.equal(duplicateDelete.json().idempotent, true, "repeat deletion requests do not enqueue duplicate work");
const originalDeletionRequestId = records[0].lifecycle_request_id;
records[0].lifecycle_status = "cleanup_failed";
records[0].lifecycle_retry_count = 1;
const retriedDelete = await dispatch("POST", `/api/apps/${draft.id}/delete`, { confirmation: draft.app_name });
assert.equal(retriedDelete.status, 202);
assert.equal(retriedDelete.json().retrying, true, "failed cleanup can resume through the same lifecycle request");
assert.equal(retriedDelete.json().request_id, originalDeletionRequestId, "retry preserves the deletion request identity");
assert.equal(retriedDelete.json().retry_count, 2);
records[0].lifecycle_status = "cleanup_complete";
assert.equal((await dispatch("GET", `/api/apps/${draft.id}/deletion`)).json().complete, true,
  "completed cleanup status remains available through its tombstone");

const immediateContinue = await dispatch("POST", "/api/apps", {
  app_name: "Orbit", app_type: "ai_application", setup_data: { intent_details: "Only managers can edit accounts." }, continue_setup: true
});
assert.equal(immediateContinue.status, 201);
assert.equal(immediateContinue.json().app.setup_status, "configuring");
assert.equal(immediateContinue.json().app.setup_current_step, "data");
assert.deepEqual(immediateContinue.json().app.setup_completed_steps, ["basics"]);
assert.equal(immediateContinue.json().app.setup_data.intent_details, "Only managers can edit accounts.");

const completedDataStep = await dispatch("PATCH", `/api/apps/${immediateContinue.json().app.id}/setup`, {
  setup_current_step: "knowledge",
  setup_completed_steps: ["basics", "data"],
  setup_status: "configuring"
});
assert.equal(completedDataStep.status, 200, "existing capability steps can be saved as reviewed");
assert.deepEqual(completedDataStep.json().app.setup_completed_steps, ["basics", "data"]);
const cannotCompleteBuild = await dispatch("PATCH", `/api/apps/${immediateContinue.json().app.id}/setup`, {
  setup_completed_steps: ["basics", "data", "build"]
});
assert.equal(cannotCompleteBuild.status, 400, "build orchestration remains deferred");
const cannotFinishEarly = await dispatch("PATCH", `/api/apps/${immediateContinue.json().app.id}/setup`, {
  setup_completed_steps: ["basics"], setup_status: "active"
});
assert.equal(cannotFinishEarly.status, 409, "an app cannot be marked complete before all seven steps are reviewed");
const completeApp = await dispatch("PATCH", `/api/apps/${immediateContinue.json().app.id}/setup`, {
  setup_current_step: "review", setup_completed_steps: SETUP_STEPS, setup_status: "active"
});
assert.equal(completeApp.status, 200);
assert.equal(completeApp.json().app.setup_status, "active");

const noUser = createAppWizardHandler({ tableRequest, readBody, getUser: () => null });
const noUserResponse = response();
await noUser({ method: "GET" }, noUserResponse, new URL("http://feltus.test/api/apps"));
assert.equal(noUserResponse.status, 401);

const capabilityRequests = [];
const capabilityApp = {
  id: ids[0],
  app_name: "Northstar",
  app_type: "internal_tool",
  description: "Support operations",
  environment: "development",
  setup_data: { intent_details: "Support tickets", ai: { model: "local-model", runtime: "unverified-local", instructions: "Use app data.", test_status: "passed", tested_at: "2026-01-01T00:00:00Z" } }
};
const capabilityModels = [
  { id: ids[1], logical_name: "customers", physical_table_name: "fm_customers", rls_enabled: true },
  { id: "30000000-0000-4000-8000-000000000001", logical_name: "orders", physical_table_name: "fm_orders", rls_enabled: true }
];
const capabilityFixtures = [
  ["/api/models?", capabilityModels],
  ["/api/model-columns?", { columns: [
    { column_name: "id", data_type: "uuid", system: true },
    { column_name: "owner_id", data_type: "uuid", system: true },
    { column_name: "created_at", data_type: "timestamptz", system: true },
    { column_name: "name", data_type: "text", is_nullable: false }
  ] }],
  ["/api/relationships?", [{ id: "40000000-0000-4000-8000-000000000001", source_model_id: "30000000-0000-4000-8000-000000000001", source_column: "customer_id", target_model_id: ids[1], target_column: "id", on_delete_action: "SET NULL" }]],
  ["/api/documents?", [{ id: ids[1], original_name: "guide.pdf", mime_type: "application/pdf", size_bytes: 42, processing_status: "ready", metadata: { extraction_artifact: { storage_key: "private/evidence.json" } }, created_at: "2026-01-01T00:00:00Z" }]],
  ["/api/ai/models", { models: [{ id: "local-model", name: "Local model", provider: "ollama", default: true }] }],
  ["/api/ai/runtime/health", { status: "healthy" }],
  ["/api/code/workspace?", { initialized: true }],
  [`/api/apps/${ids[0]}/state`, { state_hash: "current-hash", latest_blueprint: null, features: { build_runner: false }, state: { desired_state: { data: { models: [] }, code: {} } } }],
  [`/api/apps/${ids[0]}/backups`, { backups: [{
    id: "60000000-0000-4000-8000-000000000001", app_id: ids[0], status: "available",
    created_at: "2026-11-11T12:00:00Z", completed_at: "2026-11-11T12:01:00Z",
    restore_eligible: true, restore_status: "succeeded"
  }] }],
  [`/api/apps/${ids[0]}/builds`, { builds: [{
    id: "55000000-0000-4000-8000-000000000001", source_branch: "main", commit_sha: "c".repeat(40),
    blueprint_id: "56000000-0000-4000-8000-000000000001", status: "failed", exit_code: 1,
    failure_code: "BUILD_COMMAND_FAILED", created_at: "2026-11-04T12:00:00Z",
    steps: [{ step_key: "build", status: "failed", exit_code: 1, error_code: "BUILD_COMMAND_FAILED", log_text: "[REDACTED] build output" }]
  }] }],
  [`/api/apps/${ids[0]}/environments`, { environments: [
    { kind: "development", status: "not_configured", health: "unknown" },
    {
      kind: "staging", status: "active", health: "unknown", can_deploy: true,
      provider: "coolify", resource_reference: "staging-app",
      deployment: { status: "FAILED" },
      available_artifact: { id: "59000000-0000-4000-8000-000000000001", digest: `sha256:${"d".repeat(64)}` }
    },
    { kind: "production", status: "active", health: "unknown", can_deploy: true, provider: "coolify", resource_reference: "production-app" }
  ] }],
  [`/api/apps/${ids[0]}/deployments`, { deployments: [
    { id: "50000000-0000-4000-8000-000000000001", environment: "staging", status: "HEALTHY", commit_sha: "a".repeat(40), artifact_digest: "sha256:" + "a".repeat(64), created_at: "2026-11-04T11:00:00Z" },
    { id: "50000000-0000-4000-8000-000000000002", environment: "staging", status: "HEALTHY", commit_sha: "b".repeat(40), artifact_digest: "sha256:" + "b".repeat(64), created_at: "2026-11-03T11:00:00Z" }
  ] }],
  [`/api/apps/${ids[0]}/events`, { events: [{ id: "77", summary: "Blueprint saved", category: "application", severity: "info", event_key: "blueprint.created", created_at: "2026-11-04T12:00:00Z", metadata: { version: 1 }, actor_kind: "user" }] }],
  ["/api/activity?", [{ event_type: "model.created", event_source: "FELTUS", message: "Created customers", severity: "success", created_at: "2026-01-01T00:00:00Z" }]],
  ["/api/system-health", { services: { runtime: { status: "online" }, database: { status: "online" }, ai: { status: "online" } } }],
  ["/api/assets?", []]
];
const originalFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const path = String(input);
  capabilityRequests.push(path);
  const fixture = capabilityFixtures.find(([prefix]) => path.startsWith(prefix));
  if (!fixture) throw new Error(`Unexpected capability request: ${path}`);
  return new Response(JSON.stringify(fixture[1]), { status: 200, headers: { "Content-Type": "application/json" } });
};
try {
  const dataPanel = await renderCapabilityPanel(capabilityApp, "data", "setup");
  assert.match(dataPanel, /Step 2 · Information/);
  assert.match(dataPanel, /Suggested information categories/);
  assert.match(dataPanel, /Suggested from your app description/);
  assert.match(dataPanel, /data-suggest-category="support_tickets"/);
  assert.match(dataPanel, /<summary>Add a category<\/summary>/);
  assert.match(dataPanel, /data-add-model-field=/, "each saved model exposes a direct Add Field action");
  assert.match(dataPanel, /data-delete-field-model=/, "each saved custom field exposes its scoped remove action");
  assert.match(dataPanel, /data-delete-model=/, "each saved category exposes its own delete action");
  assert.match(dataPanel, />Delete category<\/button>/, "model deletion stays on the existing Data page");
  assert.match(dataPanel, /aria-label="Remove name from customers"/);
  assert.doesNotMatch(dataPanel, /data-field-name="(?:id|owner_id|created_at)"/, "system fields never receive a remove control");
  assert.match(capabilitiesSource, /api\/models\/field-impact/);
  assert.match(capabilitiesSource, /api\/models\/deletion-impact/);
  assert.match(capabilitiesSource, /actionBody: \(\) => \(\{ app_id: app\.id, model_id: modelId, confirm: true \}\)/,
    "model deletion requires the explicit confirmation supplied by the review dialog");
  assert.match(capabilitiesSource, /confirmButton\.disabled = impact\.can_delete !== true/,
    "the confirmation action remains disabled while the impact preview is blocked");
  assert.match(capabilitiesSource, /This category cannot be removed until the listed links or database dependencies are cleared\./,
    "blocked model dependencies receive a clear message");
  assert.match(capabilitiesSource, /dialog\.showModal\(\)/, "destructive actions use the app-styled confirmation dialog");
  assert.match(dataPanel, /customers/);
  assert.match(dataPanel, /name · Text · required/);
  assert.equal((dataPanel.match(/id · uuid · primary key/g) || []).length, 2, "each model should list its primary key once");
  assert.match(dataPanel, /Choose <strong>Add Category<\/strong> below to save it to this app/);
  assert.match(dataPanel, /Save Draft.*only saves your setup for later/);
  assert.match(dataPanel, /data-form="model"/);
  assert.match(dataPanel, /type="submit">Add Category<\/button>/);
  assert.match(appWizardSource, /currentStep === "data" \? "Save for later" : "Save Draft"/);
  assert.match(appWizardSource, /To create the category now, choose Add Category/);
  const fieldRow = dataPanel.match(/<div class="cap-column-row">([\s\S]*?)<\/div>/)?.[1] || "";
  assert.match(fieldRow, /<span>Field name<\/span><input[^>]*name="column_name"/);
  assert.match(fieldRow, /<span>Field type<\/span><select[^>]*name="column_type"/);
  assert.match(fieldRow, /<input name="column_nullable" type="checkbox"/);
  assert.match(fieldRow, /data-remove-column[^>]*>Remove<\/button>/);
  const removedCapabilityModel = capabilityModels.shift();
  const refreshedDataPanel = await renderCapabilityPanel(capabilityApp, "data", "setup");
  assert.equal(refreshedDataPanel.includes(`data-delete-model="${removedCapabilityModel.id}"`), false,
    "the next saved-model reload removes the deleted category card");
  assert.match(refreshedDataPanel, /data-delete-model="30000000-0000-4000-8000-000000000001"/,
    "unrelated categories remain visible after the reload");
  capabilityModels.unshift(removedCapabilityModel);
  for (const supportedType of ["text", "integer", "bigint", "numeric", "boolean", "date", "timestamptz", "uuid", "jsonb"]) {
    assert.match(fieldRow, new RegExp(`<option value="${supportedType}"`));
  }
  assert.doesNotMatch(fieldRow, /<option value="(?:serial|float|varchar|timestamp)"/);
  assert.doesNotMatch(dataPanel, /Continue to Relationships/);

  const fakeField = (name, type = "text", nullable = true) => ({
    querySelector(selector) {
      if (selector === '[name="column_name"]') return { value: name };
      if (selector === '[name="column_type"]') return { value: type };
      if (selector === '[name="column_nullable"]') return { checked: nullable };
      return null;
    }
  });
  const addFieldDraftForm = {
    dataset: { modelId: ids[1], addingField: "true" },
    elements: { table_name: { value: "customers" }, enable_rls: { checked: true } },
    querySelectorAll() { return [fakeField("name", "text", false), fakeField("favorite_color", "text", true)]; }
  };
  const addFieldDraft = collectCapabilityDraft({
    querySelector(selector) { return selector === '[data-form="model"]' ? addFieldDraftForm : null; }
  }, capabilityApp, "data").wizard_drafts.data;
  assert.deepEqual(addFieldDraft, {
    operation: "add-field", model_id: ids[1], table_name: "customers",
    columns: [
      { name: "name", type: "text", nullable: false },
      { name: "favorite_color", type: "text", nullable: true }
    ],
    enable_rls: true
  }, "Save Draft records the target model and pending field operation");
  const resumedAddFieldPanel = await renderCapabilityPanel({
    ...capabilityApp,
    setup_data: { ...capabilityApp.setup_data, wizard_drafts: { data: addFieldDraft } }
  }, "data", "setup");
  assert.match(resumedAddFieldPanel, new RegExp(`<details class="cap-advanced" data-manual-data data-category-summary="Add a category" open><summary>Add a field to customers<\\/summary>`));
  assert.match(resumedAddFieldPanel, new RegExp(`data-model-id="${ids[1]}" data-adding-field="true"`));
  assert.match(resumedAddFieldPanel, /value="favorite_color"/);
  assert.match(resumedAddFieldPanel, />Save Field<\/button>/);

  const shoppersFields = [
    fakeField("name", "text", true), fakeField("email", "text", false),
    fakeField("preferred_brands", "text", true), fakeField("preferred_categories", "text", true),
    fakeField("size_preferences", "text", true), fakeField("budget_min", "numeric", true),
    fakeField("budget_max", "numeric", true)
  ];
  const editFields = [fakeField("email", "text", false)];
  let formRows = shoppersFields;
  const formError = { textContent: "" };
  const saveButton = { disabled: false, isConnected: true, textContent: "Add Category" };
  const columnList = {
    _html: "",
    insertedHtml: "",
    get children() { return formRows; },
    set innerHTML(value) { this._html = value; if (modelForm.dataset.modelId) formRows = editFields; },
    querySelectorAll() { return []; },
    insertAdjacentHTML(_position, value) {
      this.insertedHtml = value;
      formRows = [...formRows, fakeField("")];
    }
  };
  const modelForm = {
    dataset: { form: "model", modelId: "", defaultFields: "[]", defaultName: "", defaultRls: "true" },
    elements: { table_name: { value: "shoppers", readOnly: false, focus() {} }, enable_rls: { checked: true } },
    querySelector(selector) {
      if (selector === '[data-column-list]') return columnList;
      if (selector === '[data-form-error]') return formError;
      if (selector === 'button[type="submit"]') return saveButton;
      if (selector === '[data-cancel-model-edit]') return cancelEditButton;
      return null;
    },
    querySelectorAll(selector) { return selector === '[data-column-list] .cap-column-row' ? formRows : []; },
    closest(selector) { return selector === "[data-form]" ? this : null; },
    scrollIntoView() {}
  };
  const cancelEditButton = { hidden: true };
  const manualDisclosure = { open: false };
  const listeners = {};
  const capabilityRoot = {
    dataset: {},
    addEventListener(type, callback) { listeners[type] = callback; },
    querySelector(selector) {
      if (selector === '[data-form="model"]') return modelForm;
      if (selector === "[data-manual-data]") return manualDisclosure;
      return null;
    },
    querySelectorAll() { return []; }
  };
  await mountCapabilityPanel(capabilityRoot, capabilityApp, "data", "setup", async () => { refreshCalls += 1; });
  let resolveModelRequest;
  const modelRequestPending = new Promise(resolve => { resolveModelRequest = resolve; });
  const modelPostCalls = [];
  const previousCapabilityFetch = globalThis.fetch;
  let refreshCalls = 0;
  globalThis.fetch = async (input, options = {}) => {
    const path = String(input);
    if (path === "/api/models") {
      modelPostCalls.push({ method: options.method, body: JSON.parse(options.body) });
      return modelRequestPending;
    }
    if (path === `/api/apps/${ids[0]}/setup`) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    throw new Error(`Unexpected model save request: ${path}`);
  };
  try {
    const submitEvent = { target: modelForm, preventDefault() { this.defaultPrevented = true; } };
    const submitPromise = listeners.submit(submitEvent);
    assert.equal(submitEvent.defaultPrevented, true, "the Add Category submit event is handled by the mounted Data panel");
    assert.equal(saveButton.disabled, true, "the submit button is locked while the category is saving");
    assert.equal(saveButton.textContent, "Saving category…", "the button gives immediate save feedback");
    await listeners.submit({ target: modelForm, preventDefault() {} });
    assert.equal(modelPostCalls.length, 1, "one save click cannot submit the category twice");
    resolveModelRequest(new Response(JSON.stringify({ id: ids[1] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await submitPromise;
    assert.equal(refreshCalls, 1, "the Data panel refreshes after the authoritative save succeeds");
    assert.deepEqual(modelPostCalls[0], {
      method: "POST",
      body: {
        app_id: ids[0], table_name: "shoppers", enable_rls: true,
        columns: [
          { name: "name", type: "text", nullable: true }, { name: "email", type: "text", nullable: false },
          { name: "preferred_brands", type: "text", nullable: true }, { name: "preferred_categories", type: "text", nullable: true },
          { name: "size_preferences", type: "text", nullable: true }, { name: "budget_min", type: "numeric", nullable: true },
          { name: "budget_max", type: "numeric", nullable: true }
        ]
      }
    }, "the Data page sends the model and fields to the existing app-scoped model API");
    assert.equal(saveButton.disabled, false, "the save button unlocks after the response");

    let errorFetchCalls = 0;
    globalThis.fetch = async (input, options = {}) => {
      if (String(input) === "/api/models") {
        errorFetchCalls += 1;
        return new Response(JSON.stringify({ error: "A field name is already in use." }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (String(input) === `/api/apps/${ids[0]}/setup`) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`Unexpected invalid model request: ${String(input)}`);
    };
    await listeners.submit({ target: modelForm, preventDefault() {} });
    assert.equal(errorFetchCalls, 1);
    assert.equal(formError.textContent, "A field name is already in use.", "server validation errors appear in the form alert");
    assert.equal(saveButton.disabled, false, "a failed save leaves the form usable");

    const editButton = {
      dataset: {
        editModel: ids[1], modelName: "shoppers",
        modelFields: JSON.stringify([{ name: "email", type: "text", nullable: false }])
      }
    };
    globalThis.fetch = async (input, options = {}) => {
      if (String(input) === "/api/models") {
        modelPostCalls.push({ method: options.method, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ id: ids[1] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(input) === `/api/apps/${ids[0]}/setup`) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`Unexpected edit request: ${String(input)}`);
    };
    await listeners.click({ target: { closest(selector) { return selector === "[data-edit-model]" ? editButton : null; } } });
    assert.equal(manualDisclosure.open, true, "Edit fields opens the existing category form");
    assert.equal(modelForm.dataset.modelId, ids[1]);
    assert.equal(modelForm.elements.table_name.readOnly, true, "a saved category name cannot be changed during field editing");
    assert.equal(saveButton.textContent, "Save Changes");
    formRows = [fakeField("email", "text", false), fakeField("loyalty_note", "text", true)];
    const editSubmit = listeners.submit({ target: modelForm, preventDefault() {} });
    await editSubmit;
    assert.equal(modelPostCalls.at(-1).method, "PATCH", "existing category edits use the same model API");
    assert.deepEqual(modelPostCalls.at(-1).body, {
      app_id: ids[0], model_id: ids[1], columns: [
        { name: "email", type: "text", nullable: false },
        { name: "loyalty_note", type: "text", nullable: true }
      ]
    });

    const addFieldButton = {
      dataset: {
        addModelField: ids[1], modelName: "shoppers",
        modelFields: JSON.stringify([
          { name: "email", type: "text", nullable: false },
          { name: "loyalty_note", type: "text", nullable: true }
        ])
      }
    };
    await listeners.click({ target: { closest(selector) { return selector === "[data-add-model-field]" ? addFieldButton : null; } } });
    assert.equal(modelForm.dataset.modelId, ids[1], "Add Field targets the selected saved model");
    assert.equal(modelForm.dataset.addingField, "true");
    assert.equal(saveButton.textContent, "Save Field", "the add-field flow exposes a clear persistence action");
    assert.match(columnList.insertedHtml, /name="column_name" required/);

    let addFieldRequests = 0;
    globalThis.fetch = async (input, options = {}) => {
      if (String(input) === "/api/models") {
        addFieldRequests += 1;
        modelPostCalls.push({ method: options.method, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ id: ids[1] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(input) === `/api/apps/${ids[0]}/setup`) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`Unexpected add-field request: ${String(input)}`);
    };
    await listeners.submit({ target: modelForm, preventDefault() {} });
    assert.equal(addFieldRequests, 0, "a blank field is rejected locally instead of being silently omitted");
    assert.match(formError.textContent, /Name every field/);
    assert.equal(saveButton.disabled, false, "validation errors leave the field editor usable");

    formRows = [fakeField("email", "text", false), fakeField("loyalty_note", "text", true), fakeField("favorite_color", "text", true)];
    await listeners.submit({ target: modelForm, preventDefault() {} });
    assert.equal(addFieldRequests, 1, "saving a field sends one schema update");
    assert.equal(modelPostCalls.at(-1).method, "PATCH", "adding a saved field uses the app-scoped schema update endpoint");
    assert.deepEqual(modelPostCalls.at(-1).body, {
      app_id: ids[0], model_id: ids[1], columns: [
        { name: "email", type: "text", nullable: false },
        { name: "loyalty_note", type: "text", nullable: true },
        { name: "favorite_color", type: "text", nullable: true }
      ]
    }, "the saved schema update preserves existing fields and appends the new field");
    assert.equal(refreshCalls, 3, "the Data panel reloads persisted schema after add-field save");
  } finally {
    globalThis.fetch = previousCapabilityFetch;
  }

  const relationshipsPanel = await renderCapabilityPanel(capabilityApp, "relationships", "workspace");
  assert.match(relationshipsPanel, /Relationship map/);
  assert.match(relationshipsPanel, /Add a relationship/);
  assert.match(relationshipsPanel, /many-to-one foreign keys/);
  assert.match(relationshipsPanel, /<span>Target column<\/span><select[^>]*name="target_column"/);
  assert.match(relationshipsPanel, /On delete: SET NULL/, "relationship cards should render the persisted API on_delete_action field");
  assert.match(relationshipsPanel, /data-delete-relationship=/, "saved relationships expose the explicit remove flow");
  assert.match(capabilitiesSource, /api\/relationships\/deletion-impact/);

  const documentsPanel = await renderCapabilityPanel(capabilityApp, "documents", "setup");
  assert.match(documentsPanel, /Step 3 · Knowledge/);
  assert.match(documentsPanel, /Add a knowledge file/);
  assert.match(documentsPanel, /Download extraction evidence/);
  assert.match(documentsPanel, /Maximum size: 20 MB/);
  assert.match(documentsPanel, /AI context ready/);
  const backupPanel = await renderCapabilityPanel(capabilityApp, "storage-backup", "workspace");
  assert.match(backupPanel, /Create Backup/);
  assert.match(backupPanel, /Backup history/);
  assert.match(backupPanel, /data-restore-backup="60000000-0000-4000-8000-000000000001"/);
  assert.match(backupPanel, /Restore: Restored/);
  assert.match(backupPanel, /safety backup first/);
  const environmentLoadingPanel = renderEnvironmentLoadingPanel(capabilityApp, "workspace");
  assert.match(environmentLoadingPanel, /data-environment-loading="true"/);
  assert.match(environmentLoadingPanel, /Loading environments/);
  assert.equal((environmentLoadingPanel.match(/env-card-loading/g) || []).length, 4, "loading reserves one card for each environment");
  assert.equal((environmentLoadingPanel.match(/data-deploy-artifact/g) || []).length, 0, "loading state cannot submit a deployment");

  const environmentRequestsBefore = capabilityRequests.filter(path => path.endsWith(`/api/apps/${ids[0]}/environments`)).length;
  const environmentPayload = await loadEnvironments(capabilityApp.id);
  assert.equal(
    capabilityRequests.filter(path => path.endsWith(`/api/apps/${ids[0]}/environments`)).length,
    environmentRequestsBefore + 1,
    "prefetch starts exactly one environments request"
  );
  const environmentPanel = await renderCapabilityPanel(capabilityApp, "environment", "setup", { environmentPayload });
  assert.match(environmentPanel, /Step 6 · Environment/);
  assert.match(environmentPanel, /Not Configured/);
  assert.match(environmentPanel, /class="cap-status unavailable">Failed</);
  assert.match(environmentPanel, /data-deploy-artifact="59000000-0000-4000-8000-000000000001"/);
  assert.match(environmentPanel, /data-environment="staging">Deploy to Staging/);
  assert.equal(
    capabilityRequests.filter(path => path.endsWith(`/api/apps/${ids[0]}/environments`)).length,
    environmentRequestsBefore + 1,
    "rendering consumes prefetched environment data without a duplicate request"
  );
  for (const asset of ["app-wizard.js", "app-wizard-lib.js", "app-wizard-capabilities.js"]) {
    assert.match(appShellHtml, new RegExp(`<link rel="modulepreload" href="/${asset.replaceAll(".", "\\.")}">`));
  }
  const appRouteSource = appWizardSource.match(/async function renderAppRoute\(route\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(appRouteSource, /route\.page === "code"[\s\S]*renderCapabilityPanel\(app, route\.page, "workspace", \{ pane \}\)/,
    "the selected Preview, Design, or Launch pane is passed through to the existing CODE workspace");
  assert.ok(
    appRouteSource.indexOf("loadEnvironments(route.appId)") < appRouteSource.indexOf("await loadApp(route.appId)"),
    "environment loading starts before the app detail request resolves"
  );
  assert.ok(
    appRouteSource.indexOf('renderEnvironmentLoadingPanel(app, "workspace")') < appRouteSource.indexOf("await refreshEnvironmentWorkspace(app, environmentLoad)"),
    "the stable loading layout renders before environment data resolves"
  );
  const deployHandlerSource = capabilitiesSource.match(/const deployArtifact = event\.target\.closest[\s\S]*?const promoteDeployment/)?.[0] || "";
  assert.match(deployHandlerSource, /if \(deployArtifact\.disabled\) return;/);
  assert.equal((deployHandlerSource.match(/\/deployments`/g) || []).length, 1, "one click path performs one deployment submission");

  const lifecycleSettingsSource = appWizardSource.match(/async function renderApplicationSettings\(app\) \{[\s\S]*?\n\}/)?.[0] || "";
  const lifecycleStatusSource = appWizardSource.match(/async function renderApplicationDeletionStatus\(appId\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(lifecycleSettingsSource, /data-lifecycle-archive/);
  assert.match(lifecycleSettingsSource, /"\/delete"/);
  assert.match(lifecycleSettingsSource, /deletion-impact/);
  assert.match(lifecycleSettingsSource, /input\.value !== app\.app_name/,
    "permanent deletion requires the exact app name in the UI");
  assert.match(lifecycleSettingsSource, /data-lifecycle-show-delete disabled/,
    "deletion stays disabled until the impact request resolves");
  assert.match(lifecycleSettingsSource, /External services and provider resources are not automatically deleted/);
  assert.match(lifecycleStatusSource, /data-lifecycle-retry-form/);
  assert.match(lifecycleStatusSource, /setTimeout\(poll, 1800\)/);
  assert.match(lifecycleStatusSource, /cleanup_complete/);

  const aiPanel = await renderCapabilityPanel(capabilityApp, "ai", "workspace");
  assert.match(aiPanel, /Step 4 · Assistant/);
  assert.match(aiPanel, /Customize AI/);
  assert.match(aiPanel, /What it will do/);
  assert.match(aiPanel, /What it can use/);
  assert.match(aiPanel, /Verified runtime/);
  assert.match(aiPanel, /Details unavailable/);
  assert.doesNotMatch(aiPanel, /unverified-local/);
  assert.match(aiPanel, /Test Assistant/);
  assert.doesNotMatch(aiPanel, /49%|AI capacity/);
  assert.match(aiPanel, /local-model/);

  const codePanel = await renderCapabilityPanel(capabilityApp, "code", "setup");
  assert.match(codePanel, /Step 5 · Code/);
  assert.match(codePanel, /Your app workspace is ready/);
  assert.match(codePanel, /Open Code Workspace/);
  const codeWorkspacePanel = await renderCapabilityPanel(capabilityApp, "code", "workspace");
  assert.match(codeWorkspacePanel, /\/api\/code\/ui\?app_id=[^"]+&amp;embedded=1/);
  const previewWorkspacePanel = await renderCapabilityPanel(capabilityApp, "code", "workspace", { pane: "preview" });
  assert.match(previewWorkspacePanel, /\/api\/code\/ui\?app_id=[^"]+&amp;pane=preview&amp;embedded=1/,
    "the Preview destination selects the existing CODE Preview pane");
  assert.doesNotMatch(codeWorkspacePanel, /BUILD · CODE|<h1>Code<\/h1>|Open the current FELTUS CODE workspace/);
  const logsPanel = await renderCapabilityPanel(capabilityApp, "logs", "workspace");
  assert.match(logsPanel, /Created customers/);
  const infrastructurePanel = await renderCapabilityPanel(capabilityApp, "infrastructure", "workspace");
  assert.match(infrastructurePanel, /Platform health/);
  const reviewPanel = await renderCapabilityPanel(capabilityApp, "review", "setup");
  assert.match(reviewPanel, /Step 7 · Review/);
  assert.match(reviewPanel, /Information Categories/);
  assert.match(reviewPanel, /customers, orders/);
  assert.match(reviewPanel, /guide\.pdf · ready · AI context ready/);
  assert.match(reviewPanel, /Customized · local-model · test passed/);
  for (const page of ["basics", "data", "knowledge", "ai", "code", "environment"]) {
    assert.match(reviewPanel, new RegExp(`href="/apps/${ids[0]}/setup/${page}"`), `Review should link to the ${page} step`);
  }
  assert.match(reviewPanel, /Workspace ready/);
  const deploymentsPanel = await renderCapabilityPanel(capabilityApp, "deployments", "workspace");
  assert.match(deploymentsPanel, /Promote same artifact to Production/);
  assert.match(deploymentsPanel, /data-rollback-current=/);
  const buildsPanel = await renderCapabilityPanel(capabilityApp, "builds", "workspace");
  assert.match(buildsPanel, /Exit code: 1/);
  assert.match(buildsPanel, /BUILD_COMMAND_FAILED/);
  assert.match(buildsPanel, /\[REDACTED\] build output/);
  const activityPanel = await renderCapabilityPanel(capabilityApp, "activity", "workspace");
  assert.match(activityPanel, /Blueprint saved/);
  assert.match(activityPanel, /Technical trace/);

  let localWorkspaceExists = false;
  let workspacePostCount = 0;
  const sourceApp = { ...capabilityApp, id: randomUUID(), app_name: "RETAIL THERAPY" };
  globalThis.fetch = async (input, options = {}) => {
    const path = String(input);
    if (path === `/api/apps/${sourceApp.id}/github`) {
      return new Response(JSON.stringify({ configured: false, configuration_reason: "GitHub is temporarily unavailable.", repositories: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.startsWith("/api/code/workspace?")) {
      return new Response(JSON.stringify({ initialized: localWorkspaceExists }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.startsWith("/api/code/capabilities?")) {
      return new Response(JSON.stringify({ capabilities: { canEditCode: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.startsWith("/api/code/git/status?")) {
      return new Response(JSON.stringify({ stdout: "## No commits yet on main\n" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/api/code/workspace" && options.method === "POST") {
      workspacePostCount += 1;
      localWorkspaceExists = true;
      assert.deepEqual(JSON.parse(options.body), { app_id: sourceApp.id, action: "initialize" });
      return new Response(JSON.stringify({ workspace: { initialized: true }, result: { initialized: true, branch: "main" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected App Source request: ${path}`);
  };
  let sourceMarkup = await renderCapabilityPanel(sourceApp, "source", "workspace");
  assert.match(sourceMarkup, /Set up a private workspace/);
  assert.match(sourceMarkup, /Recommended for new apps/);
  assert.match(sourceMarkup, />Set up workspace<\/button>/);
  assert.match(sourceMarkup, /GitHub is temporarily unavailable/);
  assert.doesNotMatch(sourceMarkup, /data-initialize-code-workspace[^>]*disabled/, "GitHub availability does not gate private workspace initialization");

  const sourceError = { textContent: "" };
  const sourceButton = { disabled: false, textContent: "Initialize workspace", isConnected: true };
  const sourceListeners = {};
  const sourceRoot = {
    addEventListener(type, callback) { sourceListeners[type] = callback; },
    querySelector(selector) { return selector === "[data-code-workspace-error]" ? sourceError : null; }
  };
  let sourceRefreshCount = 0;
  await mountCapabilityPanel(sourceRoot, sourceApp, "source", "workspace", async () => {
    sourceRefreshCount += 1;
    sourceMarkup = await renderCapabilityPanel(sourceApp, "source", "workspace");
  });
  const sourceClick = {
    target: { closest(selector) { return selector === "[data-initialize-code-workspace]" ? sourceButton : null; } }
  };
  await sourceListeners.click(sourceClick);
  assert.equal(workspacePostCount, 1, "Initialize workspace calls the existing app-scoped workspace initialize route once");
  assert.equal(sourceRefreshCount, 1, "Studio source state refreshes after initialization");
  assert.match(sourceMarkup, /FELTUS workspace ready/);
  assert.match(sourceMarkup, /Local branch: <strong>main<\/strong>/);
  assert.match(sourceMarkup, /Open Build Studio/);
  assert.equal(sourceError.textContent, "");
  assert.equal(sourceButton.disabled, false);

  const syntheticApp = { ...capabilityApp, id: randomUUID(), app_name: "Civic Pantry" };
  let syntheticWorkspaceExists = false;
  let syntheticInitializeCalls = 0;
  globalThis.fetch = async (input, options = {}) => {
    const path = String(input);
    if (path === `/api/apps/${syntheticApp.id}/github`) {
      return new Response(JSON.stringify({ configured: false, configuration_reason: "GitHub is temporarily unavailable.", repositories: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.startsWith("/api/code/workspace?")) {
      return new Response(JSON.stringify({ initialized: syntheticWorkspaceExists }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.startsWith("/api/code/capabilities?")) {
      return new Response(JSON.stringify({ capabilities: { canEditCode: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path.startsWith("/api/code/git/status?")) {
      return new Response(JSON.stringify({ stdout: "## integration-check\n" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (path === "/api/code/workspace" && options.method === "POST") {
      syntheticInitializeCalls += 1;
      syntheticWorkspaceExists = true;
      assert.deepEqual(JSON.parse(options.body), { app_id: syntheticApp.id, action: "initialize" });
      return new Response(JSON.stringify({ workspace: { initialized: true }, result: { initialized: true, branch: "integration-check" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected synthetic-app request: ${path}`);
  };
  let syntheticSourceMarkup = await renderCapabilityPanel(syntheticApp, "source", "workspace");
  assert.match(syntheticSourceMarkup, /Set up workspace/, "an unrelated application receives the same generic workspace option");
  const syntheticError = { textContent: "" };
  const syntheticButton = { disabled: false, textContent: "Initialize workspace", isConnected: true };
  const syntheticListeners = {};
  const syntheticRoot = {
    addEventListener(type, callback) { syntheticListeners[type] = callback; },
    querySelector(selector) { return selector === "[data-code-workspace-error]" ? syntheticError : null; }
  };
  await mountCapabilityPanel(syntheticRoot, syntheticApp, "source", "workspace", async () => {
    syntheticSourceMarkup = await renderCapabilityPanel(syntheticApp, "source", "workspace");
  });
  await syntheticListeners.click({ target: { closest(selector) { return selector === "[data-initialize-code-workspace]" ? syntheticButton : null; } } });
  assert.equal(syntheticInitializeCalls, 1, "the same app-scoped initialization contract serves an unrelated synthetic app");
  assert.match(syntheticSourceMarkup, /FELTUS workspace ready/);
  assert.match(syntheticSourceMarkup, /Local branch: <strong>integration-check<\/strong>/, "the actual local branch is shown instead of a project-specific default");

  const syntheticOwnerId = randomUUID();
  const syntheticStateApp = {
    id: syntheticApp.id,
    owner_id: syntheticOwnerId,
    app_name: syntheticApp.app_name,
    app_type: "custom",
    setup_status: "configuring",
    setup_data: {
      code: { workspace: { initialized: syntheticWorkspaceExists }, branch: "integration-check" },
      intelligence: { classification: {
        label: "community resource coordination",
        business_models: ["member-supported"],
        audiences: ["community organizers"],
        workflow_patterns: ["request-review-match"]
      } }
    },
    created_at: "2026-11-07T00:00:00.000Z"
  };
  const syntheticStateHandler = createApplicationStateHandler({
    tableRequest: async table => ({
      status: 200,
      data: table === "feltus_applications" ? [syntheticStateApp] : []
    }),
    serviceRequest: async () => ({ status: 200, data: [] }),
    readBody: async request => request.body || {},
    getUser: () => ({ id: syntheticOwnerId })
  });
  const syntheticStateResult = { status: null, headers: {}, text: "" };
  await syntheticStateHandler({ method: "GET", headers: {} }, {
    writeHead(status, headers) { syntheticStateResult.status = status; syntheticStateResult.headers = headers; },
    end(text) { syntheticStateResult.text = String(text || ""); }
  }, new URL(`http://feltus.test/api/apps/${syntheticApp.id}/state`));
  const syntheticCanonicalState = JSON.parse(syntheticStateResult.text).state;
  assert.equal(syntheticStateResult.status, 200, "an unrelated app initialized through the same source flow reconstructs canonical intelligence state");
  assert.equal(syntheticCanonicalState.application.id, syntheticApp.id);
  assert.equal(syntheticCanonicalState.desired_state.intelligence.repository.source, "local");
  assert.equal(syntheticCanonicalState.desired_state.intelligence.repository.branch, "integration-check");
  assert.equal(syntheticCanonicalState.desired_state.intelligence.classification.label, "community resource coordination");
  assert.deepEqual(syntheticCanonicalState.desired_state.intelligence.classification.business_models, ["member-supported"]);

  globalThis.fetch = async (input, options = {}) => {
    if (String(input) === `/api/apps/${sourceApp.id}/github`) return new Response(JSON.stringify({ configured: false, configuration_reason: "GitHub is temporarily unavailable.", repositories: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (String(input).startsWith("/api/code/workspace?")) return new Response(JSON.stringify({ initialized: false }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (String(input).startsWith("/api/code/capabilities?")) return new Response(JSON.stringify({ capabilities: { canEditCode: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (String(input) === "/api/code/workspace" && options.method === "POST") return new Response(JSON.stringify({ code: "CODE_WORKSPACE_INIT_FAILED", error: "Workspace storage is unavailable.", request_id: "request-init-123" }), { status: 503, headers: { "Content-Type": "application/json" } });
    throw new Error(`Unexpected failed-init request: ${String(input)}`);
  };
  sourceMarkup = await renderCapabilityPanel(sourceApp, "source", "workspace");
  sourceError.textContent = "";
  await sourceListeners.click(sourceClick);
  assert.match(sourceError.textContent, /CODE_WORKSPACE_INIT_FAILED: Workspace storage is unavailable\. · request request-init-123/);
  assert.equal(sourceButton.disabled, false, "a failed initialization restores the button for retry");

  globalThis.fetch = async input => {
    if (String(input) === `/api/apps/${sourceApp.id}/github`) return new Response(JSON.stringify({ configured: true, connected: true, repositories: [{ name: "retail-therapy", default_branch: "main", branches: [{ branch_name: "main", latest_commit_sha: "a".repeat(40), is_default: true }], webhook_status: "active" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (String(input).startsWith("/api/code/workspace?")) return new Response(JSON.stringify({ initialized: false }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (String(input).startsWith("/api/code/capabilities?")) return new Response(JSON.stringify({ capabilities: { canEditCode: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
    throw new Error(`Unexpected connected-GitHub request: ${String(input)}`);
  };
  const connectedSourceMarkup = await renderCapabilityPanel(sourceApp, "source", "workspace");
  assert.match(connectedSourceMarkup, /App files connected/);
  assert.match(connectedSourceMarkup, /Change app files/);
  assert.doesNotMatch(connectedSourceMarkup, /Set up a private workspace/, "GitHub-connected app source flow remains unchanged");
  assert.ok(capabilityRequests.length >= 12, "capability panels load app-scoped existing APIs");
} finally {
  globalThis.fetch = originalFetch;
}

const existingAppResponse = await dispatch("POST", "/api/apps", {
  app_name: "Existing Support Portal",
  description: "An app that already exists",
  app_type: "other",
  creation_path: "existing_application",
  service_ids: ["my_services"],
  continue_setup: true
});
assert.equal(existingAppResponse.status, 201);
const existingApp = existingAppResponse.json().app;
assert.equal(existingApp.setup_status, "active");
assert.equal(existingApp.setup_current_step, "basics");
assert.equal(existingApp.setup_data.product_path, "existing_application");
assert.deepEqual(existingApp.setup_data.platform_services.selected_service_ids, ["my_services"]);
assert.deepEqual(existingApp.setup_data.infrastructure.components.source_repository, {
  owner: "EXTERNAL_PROVIDER", management: "CONNECTED_EXTERNAL", status: "UNKNOWN", ownership_configured: true
}, "My Services selection does not imply that a source repository is connected");
const invalidExistingServices = await dispatch("POST", "/api/apps", {
  app_name: "Unsupported Service Selection",
  creation_path: "existing_application",
  service_ids: "hosting"
});
assert.equal(invalidExistingServices.status, 400);
const unavailableExistingAppHandler = createAppWizardHandler({
  tableRequest,
  readBody,
  getUser: () => user,
  env: {}
});
const unavailableExistingAppResponse = response();
await unavailableExistingAppHandler({ method: "POST", body: { app_name: "Unavailable Import", creation_path: "existing_application" } },
  unavailableExistingAppResponse, new URL("http://feltus.test/api/apps"));
assert.equal(unavailableExistingAppResponse.status, 503);
assert.equal(unavailableExistingAppResponse.json().error_code, "GITHUB_INTEGRATION_UNAVAILABLE");

process.stdout.write("PASS app wizard routes, draft persistence, ownership, capability panel API mapping, schema rendering, action availability, and phase boundary\n");
