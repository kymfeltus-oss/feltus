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
assert.equal(SETUP_STEPS.length, 9);
assert.equal(WORKSPACE_PAGES.length, 12);
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
assert.equal(resumeSetupPath({ id: ids[0], setup_current_step: "data" }), `/apps/${ids[0]}/setup/data`);
assert.equal(escapeCapabilityHtml(`<script title="x">'&</script>`), "&lt;script title=&quot;x&quot;&gt;&#39;&amp;&lt;/script&gt;");

assert.throws(() => validateAppBasics({ app_name: " " }), error => error.field === "app_name");
assert.throws(() => validateAppBasics({ app_name: "Good", app_type: "unknown" }), error => error.field === "app_type");
assert.throws(() => validateAppBasics({ app_name: "Good", accent_color: "red" }), error => error.field === "accent_color");
assert.throws(() => validateSetupData({ github_token: "never store" }), /Secrets must be stored/);
assert.deepEqual(validateAppBasics({ app_name: "  Scout  ", app_type: "web_application" }), {
  app_name: "Scout", description: "", app_type: "web_application", app_icon: "✦", accent_color: "#62D6C9"
});

const invalid = await dispatch("POST", "/api/apps", { app_name: "", app_type: "web_application" });
assert.equal(invalid.status, 400, "invalid basics should not create an app");
assert.equal(records.length, 0, "validation failure should leave no draft");

const draftResponse = await dispatch("POST", "/api/apps", {
  app_name: "Northstar",
  description: "Support operations",
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
assert.deepEqual(afterReload.json().app.setup_data, { data: { wants_database: true, tables: ["customers"] } });

const rejectedSecret = await dispatch("PATCH", `/api/apps/${draft.id}/setup`, { setup_data: { ai: { api_key: "secret" } } });
assert.equal(rejectedSecret.status, 400);
assert.deepEqual(records[0].setup_data, { data: { wants_database: true, tables: ["customers"] } });

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

const immediateContinue = await dispatch("POST", "/api/apps", { app_name: "Orbit", app_type: "ai_application", continue_setup: true });
assert.equal(immediateContinue.status, 201);
assert.equal(immediateContinue.json().app.setup_status, "configuring");
assert.equal(immediateContinue.json().app.setup_current_step, "data");
assert.deepEqual(immediateContinue.json().app.setup_completed_steps, ["basics"]);

const completedDataStep = await dispatch("PATCH", `/api/apps/${immediateContinue.json().app.id}/setup`, {
  setup_current_step: "relationships",
  setup_completed_steps: ["basics", "data"],
  setup_status: "configuring"
});
assert.equal(completedDataStep.status, 200, "existing capability steps can be saved as reviewed");
assert.deepEqual(completedDataStep.json().app.setup_completed_steps, ["basics", "data"]);
const cannotCompleteBuild = await dispatch("PATCH", `/api/apps/${immediateContinue.json().app.id}/setup`, {
  setup_completed_steps: ["basics", "data", "build"]
});
assert.equal(cannotCompleteBuild.status, 400, "build orchestration remains deferred");

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
  setup_data: { ai: { model: "local-model", instructions: "Use app data." } }
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
  ["/api/relationships?", []],
  ["/api/documents?", [{ id: ids[1], original_name: "guide.pdf", mime_type: "application/pdf", size_bytes: 42, processing_status: "processed", metadata: { extraction_artifact: { storage_key: "private/evidence.json" } }, created_at: "2026-01-01T00:00:00Z" }]],
  ["/api/ai/models", { models: [{ id: "local-model", name: "Local model", provider: "ollama", default: true }] }],
  ["/api/ai/runtime/health", { status: "healthy" }],
  ["/api/code/workspace?", { initialized: true }],
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
  assert.match(dataPanel, /Create a model/);
  assert.match(dataPanel, /customers/);
  assert.match(dataPanel, /name · text · required/);
  assert.equal((dataPanel.match(/id · uuid · primary key/g) || []).length, 2, "each model should list its primary key once");
  assert.match(dataPanel, /schema editing, deletion, duplication, and row preview are not exposed/);

  const relationshipsPanel = await renderCapabilityPanel(capabilityApp, "relationships", "workspace");
  assert.match(relationshipsPanel, /Relationship map/);
  assert.match(relationshipsPanel, /Add a relationship/);
  assert.match(relationshipsPanel, /many-to-one foreign keys/);

  const documentsPanel = await renderCapabilityPanel(capabilityApp, "documents", "setup");
  assert.match(documentsPanel, /Upload a document/);
  assert.match(documentsPanel, /Download extraction evidence/);
  assert.match(documentsPanel, /Maximum size: 20 MB/);

  const aiPanel = await renderCapabilityPanel(capabilityApp, "ai", "workspace");
  assert.match(aiPanel, /Save assistant settings/);
  assert.match(aiPanel, /Send test prompt/);
  assert.match(aiPanel, /local-model/);

  const codePanel = await renderCapabilityPanel(capabilityApp, "code", "setup");
  assert.match(codePanel, /\/api\/code\/ui\?app_id=/);
  const logsPanel = await renderCapabilityPanel(capabilityApp, "logs", "workspace");
  assert.match(logsPanel, /Created customers/);
  const infrastructurePanel = await renderCapabilityPanel(capabilityApp, "infrastructure", "workspace");
  assert.match(infrastructurePanel, /Platform health/);
  const reviewPanel = await renderCapabilityPanel(capabilityApp, "review", "setup");
  assert.match(reviewPanel, /Private workspace initialized/);
  assert.match(reviewPanel, /Build, deployment, promotion, and rollback are not part of this phase/);
  assert.ok(capabilityRequests.length >= 12, "capability panels load app-scoped existing APIs");
} finally {
  globalThis.fetch = originalFetch;
}

process.stdout.write("PASS app wizard routes, draft persistence, ownership, capability panel API mapping, schema rendering, action availability, and phase boundary\n");
