import assert from "node:assert/strict";
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
import { escapeCapabilityHtml, renderCapabilityPanel } from "../src/app-wizard/capabilities.js";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002"
];
let user = { id: "10000000-0000-4000-8000-000000000001" };
const records = [];
let nextId = 0;

function parseFilter(query, key) {
  const match = new RegExp(`[?&]${key}=eq\.([^&]+)`).exec(query || "");
  return match ? decodeURIComponent(match[1]) : null;
}

async function tableRequest(table, method, { query = "", body = null } = {}) {
  assert.equal(table, "feltus_applications");
  if (method === "GET") {
    const owner = parseFilter(query, "owner_id");
    const id = parseFilter(query, "id");
    return { status: 200, data: records.filter(row => (!owner || row.owner_id === owner) && (!id || row.id === id)).map(row => structuredClone(row)) };
  }
  if (method === "POST") {
    if (records.some(row => row.app_name === body.app_name)) {
      return { status: 409, data: { code: "23505" } };
    }
    nextId += 1;
    const id = ids[nextId - 1] || `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
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
      setup_current_step: body.setup_current_step,
      setup_completed_steps: body.setup_completed_steps,
      setup_data: body.setup_data,
      created_at: "2026-11-03T12:00:00.000Z",
      setup_updated_at: "2026-11-03T12:00:00.000Z"
    };
    records.push(row);
    return { status: 201, data: [structuredClone(row)] };
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

const handler = createAppWizardHandler({ tableRequest, readBody, getUser: () => user });

async function dispatch(method, pathname, body = {}) {
  const res = response();
  const handled = await handler({ method, body }, res, new URL(`http://feltus.test${pathname}`));
  assert.equal(handled, true, `${method} ${pathname} should be handled`);
  return res;
}

assert.deepEqual(APP_TYPES, ["web_application", "internal_tool", "api_backend", "ai_application", "data_application", "other"]);
assert.deepEqual(SETUP_STEPS, ["basics", "data", "knowledge", "ai", "code", "environment", "review"]);
assert.equal(WORKSPACE_PAGES.length, 15);
assert.equal(resolveAppRoute("/").kind, "home");
assert.equal(resolveAppRoute("/apps").kind, "apps");
assert.equal(resolveAppRoute("/apps/new").kind, "new-app");
assert.equal(resolveAppRoute("/apps/new/basics").kind, "new-basics");
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
assert.equal(draft.setup_status, "draft");
assert.equal(draft.setup_current_step, "basics");
assert.deepEqual(draft.setup_completed_steps, []);
assert.equal(draft.owner_id, user.id);
assert.equal(draft.setup_data.intent_details, "Used by a five person support team.");

const duplicate = await dispatch("POST", "/api/apps", { app_name: "Northstar", app_type: "other" });
assert.equal(duplicate.status, 409);
assert.equal(duplicate.json().field, "app_name");
assert.equal(records.length, 1, "duplicate name should not create another app");

const savedStep = await dispatch("PATCH", `/api/apps/${draft.id}/setup`, {
  setup_current_step: "data",
  setup_completed_steps: ["basics"],
  setup_status: "configuring",
  setup_data: { data: { wants_database: true, tables: ["customers"] } }
});
assert.equal(savedStep.status, 200);
assert.equal(savedStep.json().app.setup_status, "configuring");
assert.equal(savedStep.json().app.setup_current_step, "data");
assert.deepEqual(savedStep.json().app.setup_completed_steps, ["basics"]);
assert.equal(resumeSetupPath(savedStep.json().app), `/apps/${draft.id}/setup/data`);

const afterReload = await dispatch("GET", `/api/apps/${draft.id}`);
assert.equal(afterReload.status, 200);
assert.deepEqual(afterReload.json().app.setup_data, {
  intent_details: "Used by a five person support team.",
  data: { wants_database: true, tables: ["customers"] }
});

const rejectedSecret = await dispatch("PATCH", `/api/apps/${draft.id}/setup`, { setup_data: { ai: { api_key: "secret" } } });
assert.equal(rejectedSecret.status, 400);
assert.deepEqual(records[0].setup_data, {
  intent_details: "Used by a five person support team.",
  data: { wants_database: true, tables: ["customers"] }
});

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
const capabilityFixtures = [
  ["/api/models?", [
    { id: ids[1], logical_name: "customers", physical_table_name: "fm_customers", rls_enabled: true },
    { id: "30000000-0000-4000-8000-000000000001", logical_name: "orders", physical_table_name: "fm_orders", rls_enabled: true }
  ]],
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
  [`/api/apps/${ids[0]}/state`, { state_hash: "current-hash", latest_blueprint: null, state: { desired_state: { data: { models: [] } } } }],
  [`/api/apps/${ids[0]}/environments`, { environments: [
    { kind: "development", status: "not_configured", health: "unknown" },
    { kind: "staging", status: "active", health: "unknown", can_deploy: true, provider: "coolify", resource_reference: "staging-app" },
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
  assert.match(dataPanel, /Add or edit a category manually/);
  assert.match(dataPanel, /customers/);
  assert.match(dataPanel, /name · Text · required/);
  assert.equal((dataPanel.match(/id · uuid · primary key/g) || []).length, 2, "each model should list its primary key once");
  assert.match(dataPanel, /Changing or removing existing fields is not available/);
  const fieldRow = dataPanel.match(/<div class="cap-column-row">([\s\S]*?)<\/div>/)?.[1] || "";
  assert.match(fieldRow, /<span>Field name<\/span><input[^>]*name="column_name"/);
  assert.match(fieldRow, /<span>Field type<\/span><select[^>]*name="column_type"/);
  assert.match(fieldRow, /<input name="column_nullable" type="checkbox"/);
  assert.match(fieldRow, /data-remove-column[^>]*>Remove<\/button>/);
  for (const supportedType of ["text", "integer", "bigint", "numeric", "boolean", "date", "timestamptz", "uuid", "jsonb"]) {
    assert.match(fieldRow, new RegExp(`<option value="${supportedType}"`));
  }
  assert.doesNotMatch(fieldRow, /<option value="(?:serial|float|varchar|timestamp)"/);
  assert.doesNotMatch(dataPanel, /Continue to Relationships/);

  const relationshipsPanel = await renderCapabilityPanel(capabilityApp, "relationships", "workspace");
  assert.match(relationshipsPanel, /Relationship map/);
  assert.match(relationshipsPanel, /Add a relationship/);
  assert.match(relationshipsPanel, /many-to-one foreign keys/);
  assert.match(relationshipsPanel, /<span>Target column<\/span><select[^>]*name="target_column"/);
  assert.match(relationshipsPanel, /On delete: SET NULL/, "relationship cards should render the persisted API on_delete_action field");

  const documentsPanel = await renderCapabilityPanel(capabilityApp, "documents", "setup");
  assert.match(documentsPanel, /Step 3 · Knowledge/);
  assert.match(documentsPanel, /Add a knowledge file/);
  assert.match(documentsPanel, /Download extraction evidence/);
  assert.match(documentsPanel, /Maximum size: 20 MB/);
  assert.match(documentsPanel, /AI context ready/);
  const environmentPanel = await renderCapabilityPanel(capabilityApp, "environment", "setup");
  assert.match(environmentPanel, /Step 6 · Environment/);
  assert.match(environmentPanel, /Not Configured/);

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
  assert.match(codeWorkspacePanel, /\/api\/code\/ui\?app_id=/);
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
  const activityPanel = await renderCapabilityPanel(capabilityApp, "activity", "workspace");
  assert.match(activityPanel, /Blueprint saved/);
  assert.match(activityPanel, /Technical trace/);
  assert.ok(capabilityRequests.length >= 12, "capability panels load app-scoped existing APIs");
} finally {
  globalThis.fetch = originalFetch;
}

process.stdout.write("PASS app wizard routes, draft persistence, ownership, capability panel API mapping, schema rendering, action availability, and phase boundary\n");
