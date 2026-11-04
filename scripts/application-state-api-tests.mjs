import assert from "node:assert/strict";
import { createApplicationStateHandler } from "../src/lib/feltus-application-state-api.js";
import {
  APPLICATION_STATE_CONTRACT,
  applicationStateHash,
  applicationStateIdentity,
  canonicalJson
} from "../src/lib/feltus-application-state.js";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MODEL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FIELD_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FIELD_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const app = {
  id: APP_ID,
  owner_id: USER_ID,
  app_name: "Northwind",
  app_type: "custom",
  environment: "development",
  setup_status: "configuring",
  setup_current_step: "ai",
  setup_completed_steps: ["basics", "data"],
  setup_data: {
    ai: {
      model: "local-small",
      assistant_purpose: "Help support agents find customer information.",
      runtime: "ollama",
      instructions: "Answer about this app.",
      context_budget: 12000,
      max_tokens: 1200,
      context_permissions: {
        documents: false,
        app_data: false,
        model_ids: [],
        document_ids: [],
        conversation_history: false
      }
    }
  },
  created_at: "2026-11-04T10:00:00.000Z"
};

const data = {
  feltus_applications: [app],
  feltus_models: [{ id: MODEL_ID, logical_name: "Customers", physical_table_name: "app_customers", rls_enabled: true, created_at: "2026-11-04T10:01:00.000Z" }],
  feltus_model_columns: [
    { id: FIELD_B, model_id: MODEL_ID, column_name: "email", data_type: "text", is_nullable: false, ordinal_position: 2 },
    { id: FIELD_A, model_id: MODEL_ID, column_name: "name", data_type: "text", is_nullable: false, ordinal_position: 1 }
  ],
  feltus_model_relationships: [],
  feltus_documents: [{ id: FIELD_B, original_name: "guide.pdf", processing_status: "ready", metadata: { version: 2, content: "private document text" }, created_at: "2026-11-04T10:02:00.000Z" }],
  feltus_environments: ["development", "preview", "staging", "production"].map((kind, index) => ({
    id: `0000000${index}-0000-4000-8000-000000000000`, name: kind, kind, status: "active"
  })),
  feltus_deployment_targets: [],
  feltus_project_repositories: [],
  feltus_repositories: [],
  feltus_application_blueprints: [],
  feltus_builds: [],
  feltus_build_steps: [],
  feltus_artifacts: [],
  feltus_deployments: [],
  feltus_observed_application_states: [],
  feltus_application_state_deltas: [],
  feltus_worker_heartbeats: [],
  feltus_audit_events: [{
    id: 77, actor_user_id: USER_ID, actor_kind: "user", request_id: "request-1",
    blueprint_id: null, commit_sha: null, build_id: null, artifact_id: null,
    deployment_id: null, environment_id: null, event_category: "application",
    event_severity: "info", action_key: "application.draft.saved",
    summary: "Application draft saved", after_data: { step: "basics" }, created_at: "2026-11-04T10:04:00.000Z"
  }]
};

function getTableFromQuery(table, query) {
  if (table === "feltus_applications") return data.feltus_applications;
  return data[table] || [];
}

let lastRpc = null;
let serviceCalls = 0;
let lastServiceRequest = null;
const tableRequest = async (table, method, options = {}) => {
  if (table === "rpc/feltus_create_application_blueprint") {
    lastRpc = options.body;
    return { status: 200, data: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", app_id: APP_ID, version: 1,
      parent_blueprint_id: null, parent_version: null, state_hash: options.body.p_state_hash,
      state: options.body.p_state, status: "ready", created_by: USER_ID, created_at: "2026-11-04T10:03:00.000Z" } };
  }
  const rows = getTableFromQuery(table, options.query || "");
  if (table === "feltus_applications" && !(options.query || "").includes(`id=eq.${APP_ID}`)) return { status: 200, data: [] };
  if (table === "feltus_applications" && !(options.query || "").includes(`owner_id=eq.${USER_ID}`)) return { status: 200, data: [] };
  if (table === "feltus_applications") return { status: 200, data: rows };
  return { status: 200, data: rows };
};
const serviceRequest = async (path, options = {}) => {
  serviceCalls += 1;
  lastServiceRequest = { path, body: options.body };
  return { status: 200, data: { id: "99999999-9999-4999-8999-999999999999", environment: "production", status: "QUEUED" } };
};
const handler = createApplicationStateHandler({
  tableRequest,
  serviceRequest,
  readBody: async request => request.body || {},
  getUser: () => ({ id: USER_ID })
});

function invoke(pathname, method = "GET", body = {}) {
  const result = { status: null, headers: {}, text: "" };
  const res = {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(text) { result.text = String(text || ""); }
  };
  const req = { method, headers: {}, body };
  return handler(req, res, new URL(`http://feltus.test${pathname}`)).then(handled => ({
    handled,
    ...result,
    body: result.headers["Content-Type"]?.startsWith("application/json") ? JSON.parse(result.text) : result.text
  }));
}

const stateResult = await invoke(`/api/apps/${APP_ID}/state`);
assert.equal(stateResult.handled, true);
assert.equal(stateResult.status, 200);
assert.equal(stateResult.body.contract, APPLICATION_STATE_CONTRACT);
assert.equal(stateResult.body.persisted, false);
assert.equal(stateResult.body.features.deployment_provider, false);
assert.equal(stateResult.body.state.desired_state.data.models[0].fields[0].name, "name");
assert.equal(stateResult.body.state.desired_state.ai.context_permissions.documents, false);
assert.equal(stateResult.body.state.desired_state.ai.assistant_purpose, "Help support agents find customer information.");
assert.equal(stateResult.body.state.desired_state.knowledge.documents[0].name, "guide.pdf");
assert.equal(JSON.stringify(stateResult.body).includes("private document text"), false);
assert.equal(stateResult.body.state_hash, applicationStateHash(stateResult.body.state));
assert.match(stateResult.body.yaml_preview, /^---\ncontract: "feltus\.application-state\/v1"/);
assert.deepEqual(stateResult.body.recorded_deltas, []);
console.log("PASS state API reconstructs a canonical draft from saved FELTUS records without document contents");

data.feltus_observed_application_states.push({
  id: "78787878-7878-4787-8787-787878787878",
  deployment_id: "79797979-7979-4797-8797-797979797979",
  environment: "staging",
  provider: "coolify",
  provider_deployment_id: "coolify-42",
  blueprint_id: "80808080-8080-4808-8808-808080808080",
  blueprint_version: 1,
  commit_sha: "a".repeat(40),
  artifact_digest: `sha256:${"a".repeat(64)}`,
  health: "healthy",
  state_hash: "b".repeat(64),
  observed_state: { deployment_state: "healthy" },
  observed_at: "2026-11-04T10:05:00.000Z"
});
data.feltus_application_state_deltas.push({
  id: "81818181-8181-4818-8818-818181818181",
  observed_state_id: "78787878-7878-4787-8787-787878787878",
  blueprint_id: "80808080-8080-4808-8808-808080808080",
  delta_key: "blueprint.version",
  path: "blueprint.version",
  status: "changed",
  desired_value: { version: 2 },
  observed_value: { version: 1 },
  created_at: "2026-11-04T10:05:00.000Z"
});
const persistedDeltas = await invoke(`/api/apps/${APP_ID}/state`);
assert.equal(persistedDeltas.status, 200);
assert.equal(persistedDeltas.body.recorded_deltas[0].delta_key, "blueprint.version");
assert.deepEqual(persistedDeltas.body.recorded_deltas[0].desired_value, { version: 2 });
console.log("PASS state API returns immutable delta records linked to the latest observation");

const blueprintResult = await invoke(`/api/apps/${APP_ID}/blueprints`, "POST");
assert.equal(blueprintResult.status, 201);
assert.equal(lastRpc.p_state_hash, blueprintResult.body.state_hash);
assert.equal(lastRpc.p_identity_json, canonicalJson(applicationStateIdentity(lastRpc.p_state)));
assert.equal(lastRpc.p_source_wizard_state.setup_status, "configuring");
console.log("PASS blueprint API submits canonical identity and a safe wizard progress snapshot");

const buildEnvKeys = ["FELTUS_BUILD_RUNNER_ENABLED"];
const previousBuildEnv = Object.fromEntries(buildEnvKeys.map(key => [key, process.env[key]]));
process.env.FELTUS_BUILD_RUNNER_ENABLED = "true";
const runnerFlaggedState = await invoke(`/api/apps/${APP_ID}/state`);
assert.equal(runnerFlaggedState.body.features.build_runner, false);
const disabledBuild = await invoke(`/api/apps/${APP_ID}/builds`, "POST");
assert.equal(disabledBuild.status, 503);
assert.equal(serviceCalls, 0);
for (const key of buildEnvKeys) {
  if (previousBuildEnv[key] === undefined) delete process.env[key];
  else process.env[key] = previousBuildEnv[key];
}
console.log("PASS build stays disabled without a fresh isolated build-worker heartbeat");

const BUILD_ID = "99999999-9999-4999-8999-999999999999";
data.feltus_builds.push({
  id: BUILD_ID, app_id: APP_ID, repository_id: "88888888-8888-4888-8888-888888888888",
  blueprint_id: "77777777-7777-4777-8777-777777777777", source_branch: "main",
  commit_sha: "c".repeat(40), status: "failed", attempt_count: 1, exit_code: 1,
  failure_code: "BUILD_COMMAND_FAILED", created_at: "2026-11-04T10:06:00.000Z"
});
data.feltus_build_steps.push({
  id: "66666666-6666-4666-8666-666666666666", build_id: BUILD_ID, step_key: "build",
  attempt: 1, status: "failed", exit_code: 1, error_code: "BUILD_COMMAND_FAILED",
  log_text: "build output redacted", started_at: "2026-11-04T10:06:01.000Z",
  completed_at: "2026-11-04T10:06:03.000Z", created_at: "2026-11-04T10:06:01.000Z"
});
const buildHistory = await invoke("/api/apps/" + APP_ID + "/builds");
assert.equal(buildHistory.status, 200);
assert.equal(buildHistory.body.builds[0].exit_code, 1);
assert.equal(buildHistory.body.builds[0].steps[0].log_text, "build output redacted");
console.log("PASS build history returns persisted exit codes and redacted step logs");
data.feltus_builds.length = 0;
data.feltus_build_steps.length = 0;

data.feltus_worker_heartbeats.push({
  worker_id: "core-worker-test", worker_type: "core", status: "online",
  last_seen_at: new Date().toISOString(),
  metadata: { infrastructure_outbox: "enabled", infrastructure_environments: ["staging"] }
});
const environmentAvailability = await invoke("/api/apps/" + APP_ID + "/environments");
const stagingEnvironment = environmentAvailability.body.environments.find(item => item.kind === "staging");
assert.equal(stagingEnvironment.can_configure_target, true);
assert.equal(stagingEnvironment.can_deploy, false);
const stagingTarget = await invoke("/api/apps/" + APP_ID + "/environments/target", "POST", {
  environment: "staging", resource_reference: "staging-resource"
});
assert.equal(stagingTarget.status, 201);
assert.match(lastServiceRequest.path, /feltus_set_environment_target/);
assert.equal(Object.hasOwn(lastServiceRequest.body, "p_coolify_token"), false);
console.log("PASS Staging target configuration depends on the live private worker without exposing Coolify credentials to the app API");
data.feltus_worker_heartbeats.length = 0;

const previousEnvironment = { ...process.env };
Object.assign(process.env, {
  FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED: "true",
  FELTUS_COOLIFY_PRODUCTION_ENABLED: "true",
  FELTUS_COOLIFY_URL: "https://coolify.example.test",
  FELTUS_COOLIFY_API_TOKEN: "test-token",
  FELTUS_COOLIFY_ALLOWED_ENVIRONMENTS: "staging,production"
});
const stagingDeploymentId = "88888888-8888-4888-8888-888888888888";
const promotion = await invoke(`/api/apps/${APP_ID}/deployments/promote`, "POST", { staging_deployment_id: stagingDeploymentId, idempotency_key: "promotion-test-1" });
assert.equal(promotion.status, 202);
assert.equal(lastServiceRequest.path, "/rest/v1/rpc/feltus_request_artifact_promotion");
assert.equal(lastServiceRequest.body.p_staging_deployment_id, stagingDeploymentId);
assert.equal(lastServiceRequest.body.p_production_enabled, true);
const rollback = await invoke(`/api/apps/${APP_ID}/deployments/${stagingDeploymentId}/rollback`, "POST", {
  known_good_deployment_id: "77777777-7777-4777-8777-777777777777",
  reason: "The current release failed a smoke check.",
  idempotency_key: "rollback-test-1"
});
assert.equal(rollback.status, 202);
assert.equal(lastServiceRequest.path, `/rest/v1/rpc/feltus_request_deployment_rollback`);
assert.equal(lastServiceRequest.body.p_reason, "The current release failed a smoke check.");
assert.equal(lastServiceRequest.body.p_production_enabled, true);
for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
Object.assign(process.env, previousEnvironment);
console.log("PASS promotion and rollback routes preserve idempotency, reason, and production gating inputs");

const missingAppHandler = createApplicationStateHandler({
  tableRequest: async () => ({ status: 200, data: [] }),
  serviceRequest,
  readBody: async () => ({}),
  getUser: () => ({ id: USER_ID })
});
const missing = { status: null, body: "" };
await missingAppHandler({ method: "GET" }, {
  writeHead(status) { missing.status = status; },
  end(body) { missing.body = body; }
}, new URL(`http://feltus.test/api/apps/${APP_ID}/state`));
assert.equal(missing.status, 404);
console.log("PASS state routes do not expose application data to a non-owner");

const eventsResult = await invoke(`/api/apps/${APP_ID}/events`);
assert.equal(eventsResult.status, 200);
assert.equal(eventsResult.body.events[0].event_key, "application.draft.saved");
assert.equal(eventsResult.body.events[0].category, "application");
assert.deepEqual(eventsResult.body.events[0].metadata, { step: "basics" });
console.log("PASS app activity reuses the immutable audit stream and returns friendly structured event fields");
