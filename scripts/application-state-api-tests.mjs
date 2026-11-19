import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApplicationStateHandler } from "../src/lib/feltus-application-state-api.js";
import { serializeDesignStateForSetupData } from "../src/lib/feltus-design-state-storage.js";
import { isPublicIPv4, observePublicHttpEndpoint } from "../src/lib/feltus-safe-endpoint-observer.js";
import {
  INFRASTRUCTURE_COMPONENTS,
  INFRASTRUCTURE_CONTRACT,
  infrastructureConfigurationForServices,
  normalizeInfrastructureRegistrations,
  resolveInfrastructureContract
} from "../src/lib/feltus-infrastructure-contract.js";
import { createDesignState } from "../src/feltus-code/server/design-studio.mjs";
import {
  APPLICATION_STATE_CONTRACT,
  applicationStateHash,
  applicationStateIdentity,
  canonicalJson,
  parseApplicationBlueprint
} from "../src/lib/feltus-application-state.js";

const APP_ID = randomUUID();
const OTHER_APP_ID = randomUUID();
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MODEL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FIELD_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FIELD_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
assert.equal(isPublicIPv4("8.8.8.8"), true);
assert.equal(isPublicIPv4("127.0.0.1"), false);
assert.equal(isPublicIPv4("169.254.10.2"), false);
const loopbackEndpoint = await observePublicHttpEndpoint("http://127.0.0.1/");
assert.equal(loopbackEndpoint.status, "NOT_CHECKED");
let privateDnsRequestMade = false;
const privateResolvedEndpoint = await observePublicHttpEndpoint("https://public.example.com/", {
  lookup: async () => {
    privateDnsRequestMade = true;
    return [{ address: "10.1.2.3", family: 4 }];
  }
});
assert.equal(privateResolvedEndpoint.status, "NOT_CHECKED");
assert.equal(privateResolvedEndpoint.failure_code, "ENDPOINT_NOT_PUBLIC");
assert.equal(privateDnsRequestMade, true);
const app = {
  id: APP_ID,
  owner_id: USER_ID,
  app_name: "Synthetic Catalog",
  app_type: "custom",
  environment: "development",
  lifecycle_status: "active",
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
  feltus_repository_branches: [],
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
const hybridInfrastructure = {
  contract: INFRASTRUCTURE_CONTRACT,
  mode: "HYBRID",
  components: Object.fromEntries(INFRASTRUCTURE_COMPONENTS.map(component => [component, {
    owner: component === "runtime_hosting" ? "CUSTOMER" : "FELTUS",
    management: component === "runtime_hosting" ? "CUSTOMER_MANAGED" : "FELTUS_MANAGED",
    status: "CONFIGURED",
    ...(component === "runtime_hosting" ? { resource_reference: "customer-runtime-1" } : {})
  }]))
};
const connectedRepositoryInfrastructure = {
  contract: INFRASTRUCTURE_CONTRACT,
  mode: "HYBRID",
  components: Object.fromEntries(INFRASTRUCTURE_COMPONENTS.map(component => [component, {
    owner: component === "source_repository" ? "EXTERNAL_PROVIDER" : "FELTUS",
    management: component === "source_repository" ? "CONNECTED_EXTERNAL" : "FELTUS_MANAGED",
    status: "CONFIGURED",
    ...(component === "source_repository" ? { provider: "github", resource_reference: "feltus-test/catalog" } : {})
  }]))
};
const selectedDataStorage = infrastructureConfigurationForServices(["data_sign_in", "storage_backup"]).configuration;
const selectedDataStorageState = resolveInfrastructureContract({
  app: { ...app, setup_data: { platform_services: { selected_service_ids: ["data_sign_in", "storage_backup"] }, infrastructure: selectedDataStorage } },
  inputs: {
    models: [{ id: MODEL_ID, logical_name: "Customers" }],
    documents: [{ id: FIELD_A, processing_status: "ready" }],
    deployments: [{ id: "healthy-deployment", status: "HEALTHY" }]
  },
  backupState: {
    available: true,
    backup: { status: "available", completed_at: "2026-11-11T12:00:00Z" },
    restore: { status: "succeeded", completed_at: "2026-11-11T12:05:00Z" }
  }
});
assert.equal(selectedDataStorageState.components.database.status, "CONFIGURED");
assert.equal(selectedDataStorageState.components.authentication.status, "UNAVAILABLE");
assert.equal(selectedDataStorageState.components.object_storage.status, "PARTIAL");
assert.equal(selectedDataStorageState.components.backups_recovery.status, "CONFIGURED",
  "backup and restore state comes from app-scoped customer records, not deployment rollback");
assert.equal(selectedDataStorageState.components.backups_recovery.backup.status, "CONFIGURED");
assert.equal(selectedDataStorageState.components.backups_recovery.restore.status, "CONFIGURED");
const customerServiceRegistrations = normalizeInfrastructureRegistrations({
  services: [{
    id: randomUUID(),
    type: "database",
    component: "database",
    name: "Customer database",
    provider: null,
    owner: "CUSTOMER",
    management: "CUSTOMER_MANAGED",
    endpoint: null,
    observation: { method: "NONE", status: "NOT_CHECKED", checked_at: null, http_status: null, failure_code: null },
    created_at: "2026-11-11T12:00:00.000Z",
    updated_at: "2026-11-11T12:00:00.000Z"
  }],
  environments: []
});
const registrationInfrastructure = resolveInfrastructureContract({
  app: { ...app, setup_data: { infrastructure_registrations: customerServiceRegistrations } },
  inputs: {}
});
assert.equal(registrationInfrastructure.mode, "HYBRID");
assert.equal(registrationInfrastructure.registrations.services[0].owner, "CUSTOMER");
assert.equal(registrationInfrastructure.registrations.services[0].observation.status, "NOT_CHECKED");
const unavailableBackupState = resolveInfrastructureContract({
  app: { ...app, setup_data: { platform_services: { selected_service_ids: ["storage_backup"] }, infrastructure: infrastructureConfigurationForServices(["storage_backup"]).configuration } },
  inputs: { deployments: [{ id: "healthy-deployment", status: "HEALTHY" }] },
  backupState: { available: false }
});
assert.equal(unavailableBackupState.components.backups_recovery.backup.status, "UNAVAILABLE");
assert.equal(unavailableBackupState.components.backups_recovery.restore.status, "UNAVAILABLE");
const readyAppAuthState = resolveInfrastructureContract({
  app: { ...app, setup_data: { platform_services: { selected_service_ids: ["data_sign_in"] }, infrastructure: infrastructureConfigurationForServices(["data_sign_in"]).configuration } },
  inputs: { models: [{ id: MODEL_ID, logical_name: "Customers", rls_enabled: true }] },
  appAuthenticationReady: true
});
assert.equal(readyAppAuthState.components.authentication.status, "CONFIGURED");
assert.equal(readyAppAuthState.components.authentication.verification.status, "VERIFIED");
const deploymentOnlyRecovery = resolveInfrastructureContract({ app, inputs: { deployments: [{ id: "healthy-deployment", status: "HEALTHY" }] } });
assert.equal(deploymentOnlyRecovery.components.backups_recovery.status, "UNKNOWN",
  "deployment rollback evidence remains separate from backup/recovery state");

function getTableFromQuery(table, query) {
  if (table === "feltus_applications") return data.feltus_applications;
  return data[table] || [];
}

let lastRpc = null;
let blueprintRpcCalls = 0;
let serviceCalls = 0;
let serviceMutationCalls = 0;
let lastServiceRequest = null;
let sourceEvidence = [];
let repositoryBranchReadFailure = false;
let repositoryBranchReadCount = 0;
let codeWorkspaceSource = { available: false, clean: false, commit: null, branch: null };
let remoteVerificationResult = { status: "REMOTE_VERIFIED", remote_commit: "d".repeat(40) };
let lastRemoteVerificationRequest = null;
let apiUserId = USER_ID;
const observedEndpoints = [];
let nextEndpointObservation = null;
const tableRequest = async (table, method, options = {}) => {
  if (table === "rpc/feltus_create_application_blueprint") {
    blueprintRpcCalls += 1;
    lastRpc = options.body;
    return { status: 200, data: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", app_id: APP_ID, version: 1,
      parent_blueprint_id: null, parent_version: null, state_hash: options.body.p_state_hash,
      state: options.body.p_state, status: "ready", created_by: USER_ID, created_at: "2026-11-04T10:03:00.000Z" } };
  }
  if (table === "feltus_repository_branches") {
    repositoryBranchReadCount += 1;
    if (repositoryBranchReadFailure) return { status: 400, data: { message: "branch rows unavailable" } };
  }
  if (table === "feltus_applications" && method === "PATCH") {
    const params = new URLSearchParams((options.query || "").replace(/^\?/, ""));
    const row = data.feltus_applications.find(item =>
      item.id === params.get("id")?.replace(/^eq\./, "") &&
      item.owner_id === params.get("owner_id")?.replace(/^eq\./, "")
    );
    const timestamp = params.get("setup_updated_at");
    if (!row || (timestamp === "is.null" && row.setup_updated_at != null) ||
        (timestamp?.startsWith("eq.") && timestamp.slice(3) !== row.setup_updated_at)) {
      return { status: 200, data: [] };
    }
    Object.assign(row, structuredClone(options.body));
    return { status: 200, data: [structuredClone(row)] };
  }
  const rows = getTableFromQuery(table, options.query || "");
  if (table === "feltus_applications" && !(options.query || "").includes(`id=eq.${APP_ID}`)) return { status: 200, data: [] };
  if (table === "feltus_applications" && !(options.query || "").includes(`owner_id=eq.${USER_ID}`)) return { status: 200, data: [] };
  if (table === "feltus_applications") return { status: 200, data: rows };
  return { status: 200, data: rows };
};
const serviceRequest = async (path, options = {}) => {
  serviceCalls += 1;
  if (options.method && options.method !== "GET") serviceMutationCalls += 1;
  lastServiceRequest = { path, body: options.body };
  if (path.startsWith("/rest/v1/feltus_app_backups?")) return { status: 200, data: [] };
  if (path === "/rest/v1/rpc/feltus_request_artifact_deployment") {
    return { status: 200, data: { id: "99999999-9999-4999-8999-999999999999", environment: options.body.p_environment_kind, status: "QUEUED" } };
  }
  return { status: 200, data: { id: "99999999-9999-4999-8999-999999999999", environment: "production", status: "QUEUED" } };
};
const handler = createApplicationStateHandler({
  tableRequest,
  serviceRequest,
  readBody: async request => request.body || {},
  getUser: () => ({ id: apiUserId }),
  observeEndpoint: async endpoint => {
    observedEndpoints.push(endpoint);
    const observation = nextEndpointObservation || {
      status: "REACHABLE",
      http_status: 200,
      failure_code: null
    };
    nextEndpointObservation = null;
    return { method: "HTTP_HEAD", checked_at: new Date().toISOString(), ...observation };
  },
  loadSourceEvidence: async () => sourceEvidence,
  loadCodeWorkspaceSource: async () => codeWorkspaceSource,
  verifyRemoteSource: async request => {
    lastRemoteVerificationRequest = request;
    return remoteVerificationResult;
  }
});

function invoke(pathname, method = "GET", body = {}, apiHandler = handler) {
  const result = { status: null, headers: {}, text: "" };
  const res = {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(text) { result.text = String(text || ""); }
  };
  const req = { method, headers: {}, body };
  return apiHandler(req, res, new URL(`http://feltus.test${pathname}`)).then(handled => ({
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
const infrastructureSave = await invoke(`/api/apps/${APP_ID}/infrastructure`, "PUT", hybridInfrastructure);
assert.equal(infrastructureSave.status, 200, JSON.stringify(infrastructureSave.body));
assert.equal(infrastructureSave.body.infrastructure.mode, "HYBRID");
assert.equal(infrastructureSave.body.infrastructure.components.runtime_hosting.owner, "CUSTOMER");
assert.equal(infrastructureSave.body.infrastructure.components.runtime_hosting.verification.status, "UNVERIFIED");
const infrastructureState = await invoke(`/api/apps/${APP_ID}/state`);
assert.equal(infrastructureState.body.infrastructure.mode, "HYBRID");
assert.equal(infrastructureState.body.state_hash, stateResult.body.state_hash,
  "infrastructure ownership remains outside the application-state v1 hash");
const infrastructureGet = await invoke(`/api/apps/${APP_ID}/infrastructure`);
assert.equal(infrastructureGet.body.infrastructure.components.runtime_hosting.resource_reference, "customer-runtime-1");
const serviceSelection = await invoke(`/api/apps/${APP_ID}/services`, "PUT", {
  service_ids: ["hosting", "publish"]
});
assert.equal(serviceSelection.status, 200);
assert.deepEqual(serviceSelection.body.services.selected_service_ids, ["hosting", "publish"]);
assert.ok(serviceSelection.body.blocked_components.includes("runtime_hosting"),
  "platform service selection must report components retained under customer ownership");
assert.equal(serviceSelection.body.infrastructure.components.runtime_hosting.owner, "CUSTOMER");
assert.equal(serviceSelection.body.infrastructure.components.build_execution.owner, "FELTUS");
assert.equal(serviceSelection.body.infrastructure.components.build_execution.management, "FELTUS_MANAGED");
const malformedServiceSelection = await invoke(`/api/apps/${APP_ID}/services`, "PUT", { service_ids: "hosting" });
assert.equal(malformedServiceSelection.status, 400, "malformed selections return an explicit client error");
assert.equal(malformedServiceSelection.body.error_code, "PLATFORM_SERVICE_SELECTION_INVALID");
const unavailableServiceSelection = await invoke(`/api/apps/${APP_ID}/services`, "PUT", { service_ids: ["domains"] });
assert.equal(unavailableServiceSelection.status, 400, "unavailable catalog services cannot be configured");
assert.equal(unavailableServiceSelection.body.error, "Choose only currently supported FELTUS services.");
apiUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nonOwnerInfrastructureSave = await invoke(`/api/apps/${APP_ID}/infrastructure`, "PUT", hybridInfrastructure);
assert.equal(nonOwnerInfrastructureSave.status, 404, "non-owners cannot change infrastructure ownership");
const nonOwnerServiceSelection = await invoke(`/api/apps/${APP_ID}/services`, "PUT", { service_ids: ["hosting"] });
assert.equal(nonOwnerServiceSelection.status, 404, "non-owners cannot change platform service selections");
apiUserId = USER_ID;

data.feltus_worker_heartbeats.push({
  worker_type: "core",
  status: "online",
  last_seen_at: new Date().toISOString(),
  metadata: { infrastructure_outbox: "enabled", infrastructure_environments: ["staging"] }
});
const serviceMutationsBeforeOwnershipGuard = serviceMutationCalls;
const customerRuntimeMutation = await invoke(`/api/apps/${APP_ID}/environments/target`, "POST", {
  environment: "staging",
  resource_reference: "managed-runtime"
});
assert.equal(customerRuntimeMutation.status, 409);
assert.equal(customerRuntimeMutation.body.error_code, "INFRASTRUCTURE_OWNER_MISMATCH");
assert.equal(serviceMutationCalls, serviceMutationsBeforeOwnershipGuard,
  "backup status may be read, but FELTUS does not invoke managed infrastructure actions for customer-owned components");
data.feltus_worker_heartbeats.length = 0;
const restoredManagedInfrastructure = await invoke(
  `/api/apps/${APP_ID}/infrastructure`,
  "PUT",
  connectedRepositoryInfrastructure
);
assert.equal(restoredManagedInfrastructure.status, 200);
const addApiService = await invoke(`/api/apps/${APP_ID}/infrastructure-registrations`, "POST", {
  kind: "services",
  type: "api_endpoint",
  name: "Order API",
  provider: "Example Provider",
  owner: "CUSTOMER",
  endpoint: "https://api.example.com/"
});
assert.equal(addApiService.status, 201, JSON.stringify(addApiService.body));
assert.equal(addApiService.body.registration.component, "monitoring_health");
assert.equal(addApiService.body.registration.owner, "CUSTOMER");
assert.equal(addApiService.body.registration.management, "CUSTOMER_MANAGED");
assert.equal(addApiService.body.registration.observation.status, "REACHABLE");
assert.deepEqual(observedEndpoints, ["https://api.example.com/"]);
const apiServiceId = addApiService.body.registration.id;
const addMetadataOnlyService = await invoke(`/api/apps/${APP_ID}/infrastructure-registrations`, "POST", {
  kind: "services",
  type: "database",
  name: "Reporting database",
  provider: "Outside Provider",
  owner: "EXTERNAL_PROVIDER"
});
assert.equal(addMetadataOnlyService.status, 201);
assert.equal(addMetadataOnlyService.body.registration.observation.status, "NOT_CHECKED");
assert.equal(observedEndpoints.length, 1, "metadata-only service types must not be probed");
assert.equal(addMetadataOnlyService.body.registration.management, "CONNECTED_EXTERNAL");
const normalizedRegistrations = normalizeInfrastructureRegistrations({
  services: [addApiService.body.registration, addMetadataOnlyService.body.registration],
  environments: []
});
assert.equal(normalizedRegistrations.services.length, 2, "valid persisted service registrations normalize");
const invalidEndpointCount = observedEndpoints.length;
const invalidEndpointRegistration = await invoke(`/api/apps/${APP_ID}/infrastructure-registrations`, "POST", {
  kind: "services",
  type: "api_endpoint",
  name: "Invalid endpoint",
  owner: "CUSTOMER",
  endpoint: "https://user:pass@api.example.com/"
});
assert.equal(invalidEndpointRegistration.status, 400);
assert.equal(observedEndpoints.length, invalidEndpointCount, "invalid endpoint input must not trigger a request");
nextEndpointObservation = {
  status: "NEEDS_ATTENTION",
  http_status: 503,
  failure_code: "HTTP_RESPONSE_ERROR"
};
const checkedApiService = await invoke(`/api/apps/${APP_ID}/infrastructure-registrations/check`, "POST", {
  kind: "services",
  id: apiServiceId
});
assert.equal(checkedApiService.status, 200, JSON.stringify(checkedApiService.body));
assert.equal(checkedApiService.body.registration.observation.status, "NEEDS_ATTENTION");
assert.equal(checkedApiService.body.registration.observation.http_status, 503);
const registrationsGet = await invoke(`/api/apps/${APP_ID}/infrastructure-registrations`);
assert.equal(registrationsGet.body.registrations.services.length, 2);
const infrastructureWithRegistrations = await invoke(`/api/apps/${APP_ID}/infrastructure`);
assert.equal(infrastructureWithRegistrations.status, 200, JSON.stringify(infrastructureWithRegistrations.body));
assert.equal(infrastructureWithRegistrations.body.infrastructure.registrations.services.length, 2);
assert.equal(infrastructureWithRegistrations.body.infrastructure.registrations.services[0].owner, "CUSTOMER");
const stateWithRegistrations = await invoke(`/api/apps/${APP_ID}/state`);
assert.equal(stateWithRegistrations.body.state_hash, stateResult.body.state_hash,
  "app-scoped infrastructure registrations remain outside the application-state v1 hash");
const serviceMutationsBeforeDisconnect = serviceMutationCalls;
const disconnectedService = await invoke(
  `/api/apps/${APP_ID}/infrastructure-registrations/${addMetadataOnlyService.body.registration.id}`,
  "DELETE"
);
assert.equal(disconnectedService.status, 200);
assert.equal(disconnectedService.body.removed, true);
assert.equal(serviceMutationCalls, serviceMutationsBeforeDisconnect,
  "disconnect removes only the FELTUS record and never changes the external service");
const crossAppRegistrations = await invoke(`/api/apps/${OTHER_APP_ID}/infrastructure-registrations`);
assert.equal(crossAppRegistrations.status, 404, "an app cannot read another app’s registration records");
apiUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nonOwnerRegistrationWrite = await invoke(`/api/apps/${APP_ID}/infrastructure-registrations`, "POST", {
  kind: "services",
  type: "database",
  name: "Unauthorized database",
  owner: "CUSTOMER"
});
assert.equal(nonOwnerRegistrationWrite.status, 404, "non-owners cannot register a service for another app");
apiUserId = USER_ID;
const generatedAppSessionHandler = createApplicationStateHandler({
  tableRequest,
  serviceRequest,
  readBody: async request => request.body || {},
  getUser: () => ({ id: "99999999-9999-4999-8999-999999999999" })
});
const generatedAppRegistration = await invoke(
  `/api/apps/${APP_ID}/infrastructure-registrations`,
  "POST",
  { kind: "services", type: "database", name: "Generated user", owner: "CUSTOMER" },
  generatedAppSessionHandler
);
assert.equal(generatedAppRegistration.status, 404,
  "generated-app users cannot authorize FELTUS service registration routes");

const originalSetupStatus = app.setup_status;
app.setup_status = "archived";
const conflictingSetupLifecycle = await invoke(`/api/apps/${APP_ID}/state`);
assert.equal(conflictingSetupLifecycle.body.state.application.lifecycle_status, "active",
  "legacy setup progress cannot override canonical application lifecycle");
assert.equal(conflictingSetupLifecycle.body.state_hash, stateResult.body.state_hash,
  "setup progress is not part of the application-state hash identity");
app.lifecycle_status = "archived";
app.setup_status = "configuring";
const canonicalArchivedState = await invoke(`/api/apps/${APP_ID}/state`);
assert.equal(canonicalArchivedState.body.state.application.lifecycle_status, "archived",
  "canonical archived lifecycle is represented independently of setup progress");
app.lifecycle_status = "active";
app.setup_status = originalSetupStatus;
console.log("PASS state API reconstructs a canonical draft from saved FELTUS records without document contents");

const previousCodeSetup = app.setup_data.code;
const canonicalDesignState = createDesignState({ application: { type: "e-commerce" } });
app.setup_data.code = {
  ...(previousCodeSetup && typeof previousCodeSetup === "object" ? previousCodeSetup : {}),
  design: serializeDesignStateForSetupData(canonicalDesignState)
};
const designStateResult = await invoke(`/api/apps/${APP_ID}/state`);
assert.equal(designStateResult.status, 200);
assert.equal(designStateResult.body.state.desired_state.code.design.contract, "feltus.design-state/v1");
assert.equal(designStateResult.body.state.desired_state.code.design.tokens.colors.primary, canonicalDesignState.tokens.colors.primary);
assert.notEqual(designStateResult.body.state.desired_state.code.design.contract, "feltus.design-state-storage/v1");
assert.equal(designStateResult.body.state_hash, applicationStateHash(designStateResult.body.state));
if (previousCodeSetup === undefined) delete app.setup_data.code;
else app.setup_data.code = previousCodeSetup;
console.log("PASS application state decodes Design State storage into the canonical Blueprint contract and hash");

repositoryBranchReadFailure = true;
app.setup_data.code = { workspace: { initialized: true }, branch: "integration-check" };
const unlinkedLocalWorkspaceState = await invoke(`/api/apps/${APP_ID}/state`);
repositoryBranchReadFailure = false;
assert.equal(unlinkedLocalWorkspaceState.status, 200, "an empty/unborn local Git workspace without a hosted repo must not fail on branch rows");
assert.equal(repositoryBranchReadCount, 0, "state loading must not query hosted branches when no active hosted repository is linked");
assert.equal(unlinkedLocalWorkspaceState.body.state.desired_state.intelligence.repository.source, "local");
assert.equal(unlinkedLocalWorkspaceState.body.state.desired_state.intelligence.repository.branch, "integration-check");
assert.equal(unlinkedLocalWorkspaceState.body.state.desired_state.intelligence.capabilities.local_code_workspace, true);
delete app.setup_data.code;
console.log("PASS app state skips hosted branch reads when no repository is linked");

const linkedRepositoryId = "12121212-1212-4121-8121-121212121212";
data.feltus_project_repositories.push({ repository_id: linkedRepositoryId, created_at: "2026-11-04T10:00:00.000Z" });
data.feltus_repositories.push({ id: linkedRepositoryId, repository_name: "northwind/app", default_branch: "main", archived_at: null });
data.feltus_repository_branches.push({
  repository_id: linkedRepositoryId,
  environment_id: "00000000-0000-4000-8000-000000000000",
  branch_name: "main",
  is_default: true,
  latest_commit_sha: "a".repeat(40),
  updated_at: "2026-11-04T10:01:00.000Z"
});
const linkedRepositoryState = await invoke(`/api/apps/${APP_ID}/state`);
assert.equal(linkedRepositoryState.status, 200);
assert.equal(repositoryBranchReadCount, 1, "hosted branch reads remain enabled for a linked repository");
assert.equal(linkedRepositoryState.body.state.desired_state.code.commit, "a".repeat(40));
data.feltus_project_repositories.length = 0;
data.feltus_repositories.length = 0;
data.feltus_repository_branches.length = 0;
console.log("PASS linked hosted repositories still contribute their saved branch and commit to application state");

const lineageIds = {
  repository: "91919191-9191-4191-8191-919191919191",
  checkpoint: "92929292-9292-4292-8292-929292929292",
  blueprint: "93939393-9393-4393-8393-939393939393",
  priorBlueprint: "94949494-9494-4494-8494-949494949494",
  build: "95959595-9595-4595-8595-959595959595",
  priorBuild: "96969696-9696-4696-8696-969696969696",
  artifact: "97979797-9797-4797-8797-979797979797",
  priorArtifact: "98989898-9898-4898-8898-989898989898",
  deployment: "99999999-9999-4999-8999-999999999991",
  priorDeployment: "99999999-9999-4999-8999-999999999992",
  observation: "99999999-9999-4999-8999-999999999993"
};
const priorLineageRows = Object.fromEntries([
  "feltus_code_checkpoints", "feltus_project_repositories", "feltus_repositories",
  "feltus_repository_branches", "feltus_application_blueprints", "feltus_builds",
  "feltus_artifacts", "feltus_deployments", "feltus_observed_application_states"
].map(key => [key, data[key]]));
const lineageCommit = "d".repeat(40);
const priorCommit = "e".repeat(40);
codeWorkspaceSource = { available: true, clean: true, commit: lineageCommit, branch: "main" };
data.feltus_code_checkpoints = [{
  id: lineageIds.checkpoint,
  git_commit: lineageCommit,
  created_at: "2026-11-04T10:08:00.000Z"
}];
const noRepositoryLineage = await invoke(`/api/apps/${APP_ID}/lineage`);
assert.equal(noRepositoryLineage.status, 200);
assert.equal(noRepositoryLineage.body.lineage.source.reconciliation.status, "NOT_SYNCHRONIZED",
  "a local CODE checkpoint is not assumed to be present in a connected repository");
data.feltus_project_repositories = [{ repository_id: lineageIds.repository, created_at: "2026-11-04T10:08:00.000Z" }];
data.feltus_repositories = [{
  id: lineageIds.repository, repository_name: "sample/application", default_branch: "main", archived_at: null
}];
data.feltus_repository_branches = [{
  repository_id: lineageIds.repository,
  environment_id: "00000000-0000-4000-8000-000000000000",
  branch_name: "main",
  is_default: true,
  latest_commit_sha: lineageCommit,
  updated_at: "2026-11-04T10:08:00.000Z"
}];
const synchronizedLineage = await invoke(`/api/apps/${APP_ID}/lineage`);
assert.equal(synchronizedLineage.body.lineage.source.reconciliation.status, "SYNCHRONIZED");
assert.equal(synchronizedLineage.body.lineage.remote_verification.status, "NOT_CHECKED");
assert.equal(synchronizedLineage.body.lineage.source.workspace_commit, lineageCommit);
assert.equal(synchronizedLineage.body.lineage.source.workspace_branch, "main");
assert.equal(synchronizedLineage.body.lineage.source.checkpoint_commit, lineageCommit);
const remotelyVerifiedLineage = await invoke(`/api/apps/${APP_ID}/lineage?verify_remote=true`);
assert.equal(remotelyVerifiedLineage.body.lineage.remote_verification.status, "REMOTE_VERIFIED");
assert.equal(lastRemoteVerificationRequest.repositoryId, lineageIds.repository);
assert.equal(lastRemoteVerificationRequest.branch, "main");
assert.equal(lastRemoteVerificationRequest.expectedCommit, lineageCommit);
remoteVerificationResult = { status: "REMOTE_DIVERGED", remote_commit: priorCommit };
const remotelyDivergedLineage = await invoke(`/api/apps/${APP_ID}/lineage?verify_remote=true`);
assert.equal(remotelyDivergedLineage.body.lineage.lineage_status, "DIVERGED");
remoteVerificationResult = { status: "REMOTE_UNAVAILABLE", error_code: "REMOTE_VERIFICATION_FAILED" };
const remotelyUnavailableLineage = await invoke(`/api/apps/${APP_ID}/lineage?verify_remote=true`);
assert.equal(remotelyUnavailableLineage.body.lineage.remote_verification.status, "REMOTE_UNAVAILABLE");
remoteVerificationResult = { status: "REMOTE_VERIFIED", remote_commit: lineageCommit };
codeWorkspaceSource = { available: true, clean: false, commit: lineageCommit, branch: "main" };
const dirtyWorkspaceLineage = await invoke(`/api/apps/${APP_ID}/lineage`);
assert.equal(dirtyWorkspaceLineage.body.lineage.source.reconciliation.status, "UNRESOLVED",
  "uncommitted CODE workspace changes cannot be represented by a source commit");
assert.equal(dirtyWorkspaceLineage.body.lineage.source.workspace_clean, false);
codeWorkspaceSource = { available: true, clean: true, commit: priorCommit, branch: "main" };
const uncheckpointedWorkspaceLineage = await invoke(`/api/apps/${APP_ID}/lineage`);
assert.equal(uncheckpointedWorkspaceLineage.body.lineage.source.reconciliation.status, "DIVERGED",
  "a workspace HEAD different from the latest stored checkpoint is not treated as synchronized");
codeWorkspaceSource = { available: true, clean: true, commit: lineageCommit, branch: "feature" };
const wrongWorkspaceBranchLineage = await invoke(`/api/apps/${APP_ID}/lineage`);
assert.equal(wrongWorkspaceBranchLineage.body.lineage.source.reconciliation.status, "DIVERGED",
  "a different live CODE branch is not treated as the application source branch");
codeWorkspaceSource = { available: true, clean: true, commit: lineageCommit, branch: "main" };
data.feltus_repository_branches[0].latest_commit_sha = priorCommit;
const divergedLineage = await invoke(`/api/apps/${APP_ID}/lineage`);
assert.equal(divergedLineage.body.lineage.source.reconciliation.status, "DIVERGED",
  "different CODE and repository commits are reported as diverged");
data.feltus_repository_branches[0].latest_commit_sha = lineageCommit;
const makeLineageBlueprint = ({ id, version, commit, created_at }) => {
  const state = structuredClone(stateResult.body.state);
  state.desired_state.code = {
    ...state.desired_state.code,
    repository_id: lineageIds.repository,
    branch: "main",
    commit
  };
  state.blueprint = {
    ...state.blueprint,
    id,
    version,
    parent_id: null,
    parent_version: null,
    status: "ready",
    state_hash: null,
    source_commit: commit
  };
  const stateHash = applicationStateHash(state);
  state.blueprint.state_hash = stateHash;
  return {
    id, app_id: APP_ID, version, state_hash: stateHash, source_commit: commit,
    status: "ready", created_at, state
  };
};
data.feltus_application_blueprints = [
  makeLineageBlueprint({
    id: lineageIds.blueprint, version: 2, commit: lineageCommit, created_at: "2026-11-04T10:08:00.000Z"
  }),
  makeLineageBlueprint({
    id: lineageIds.priorBlueprint, version: 1, commit: priorCommit, created_at: "2026-11-04T10:07:00.000Z"
  })
];
data.feltus_builds = [
  { id: lineageIds.build, repository_id: lineageIds.repository, blueprint_id: lineageIds.blueprint,
    source_branch: "main", commit_sha: lineageCommit, status: "complete", created_at: "2026-11-04T10:08:00.000Z" },
  { id: lineageIds.priorBuild, repository_id: lineageIds.repository, blueprint_id: lineageIds.priorBlueprint,
    source_branch: "main", commit_sha: priorCommit, status: "complete", created_at: "2026-11-04T10:07:00.000Z" }
];
data.feltus_artifacts = [
  { id: lineageIds.artifact, build_id: lineageIds.build, blueprint_id: lineageIds.blueprint,
    artifact_digest: `sha256:${"b".repeat(64)}`, verification_status: "passed", created_at: "2026-11-04T10:08:00.000Z" },
  { id: lineageIds.priorArtifact, build_id: lineageIds.priorBuild, blueprint_id: lineageIds.priorBlueprint,
    artifact_digest: `sha256:${"c".repeat(64)}`, verification_status: "passed", created_at: "2026-11-04T10:07:00.000Z" }
];
data.feltus_deployments = [
  { id: lineageIds.deployment, environment: "staging", status: "DEPLOYING", blueprint_id: lineageIds.blueprint,
    artifact_id: lineageIds.artifact, artifact_digest: `sha256:${"b".repeat(64)}`, commit_sha: lineageCommit,
    created_at: "2026-11-04T10:08:00.000Z" },
  { id: lineageIds.priorDeployment, environment: "staging", status: "HEALTHY", blueprint_id: lineageIds.priorBlueprint,
    artifact_id: lineageIds.priorArtifact, artifact_digest: `sha256:${"c".repeat(64)}`, commit_sha: priorCommit,
    created_at: "2026-11-04T10:07:00.000Z" }
];
data.feltus_observed_application_states = [{
  id: lineageIds.observation, deployment_id: lineageIds.deployment, blueprint_id: lineageIds.blueprint,
  commit_sha: lineageCommit, artifact_digest: `sha256:${"b".repeat(64)}`, health: "healthy",
  observed_at: "2026-11-04T10:09:00.000Z"
}];
sourceEvidence = [{
  id: "99999999-9999-4999-8999-999999999994",
  action_type: "productionization.validation",
  result_status: "complete",
  created_at: "2026-11-04T10:08:30.000Z",
  details: {
    productionization_run_id: "99999999-9999-4999-8999-999999999995",
    productionization_run: {
      run_id: "99999999-9999-4999-8999-999999999995",
      application_id: APP_ID,
      source_workspace_id: APP_ID,
      source_commit: lineageCommit,
      source_checkpoint_id: lineageCommit,
      source_snapshot_sha256: "1".repeat(64),
      status: "READY_FOR_RELEASE"
    }
  }
}];
const confirmedLineage = await invoke(`/api/apps/${APP_ID}/lineage`);
assert.equal(confirmedLineage.body.lineage.lineage_status, "CONFIRMED");
assert.equal(confirmedLineage.body.lineage.release.status, "CONFIRMED");
assert.equal(confirmedLineage.body.lineage.code_source_matches_release, true);
assert.equal(confirmedLineage.body.lineage.productionization.status, "MATCHED");
assert.equal(confirmedLineage.body.lineage.rollback_target.deployment_id, lineageIds.priorDeployment);
assert.equal(confirmedLineage.body.lineage.rollback_target.lineage_status, "CONFIRMED");
console.log("PASS lineage resolves exact Blueprint/source/build/artifact/deployment/observation and recovery bindings");
for (const [key, value] of Object.entries(priorLineageRows)) {
  if (value === undefined) delete data[key];
  else data[key] = value;
}
sourceEvidence = [];

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
assert.equal(blueprintRpcCalls, 1, "one Blueprint POST creates one authoritative revision");
assert.equal(lastRpc.p_state_hash, blueprintResult.body.state_hash);
assert.equal(lastRpc.p_identity_json, canonicalJson(applicationStateIdentity(lastRpc.p_state)));
assert.equal(lastRpc.p_source_wizard_state.setup_status, "configuring");
assert.equal(blueprintResult.body.blueprint.id, "ffffffff-ffff-4fff-8fff-ffffffffffff");
assert.equal(blueprintResult.body.blueprint.version, 1);
assert.equal(blueprintResult.body.export_url, `/api/apps/${APP_ID}/blueprints/ffffffff-ffff-4fff-8fff-ffffffffffff/export`);
assert.match(blueprintResult.body.yaml, /^---\ncontract: "feltus\.application-state\/v1"/);
assert.equal(blueprintResult.body.blueprint.state.blueprint.state_hash, blueprintResult.body.state_hash);
console.log("PASS blueprint API submits canonical identity and a safe wizard progress snapshot");

const buildEnvKeys = ["FELTUS_BUILD_RUNNER_ENABLED"];
const previousBuildEnv = Object.fromEntries(buildEnvKeys.map(key => [key, process.env[key]]));
process.env.FELTUS_BUILD_RUNNER_ENABLED = "true";
const runnerFlaggedState = await invoke(`/api/apps/${APP_ID}/state`);
assert.equal(runnerFlaggedState.body.features.build_runner, false);
const disabledBuild = await invoke(`/api/apps/${APP_ID}/builds`, "POST");
assert.equal(disabledBuild.status, 503);
assert.equal(serviceMutationCalls, 0);
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

const deploymentArtifactId = "abababab-abab-4bab-8bab-abababababab";
const priorDeploymentFlags = {
  enabled: process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED,
  coolify: process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED
};
process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED = "false";
process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED = "false";
const deploymentResult = await invoke(`/api/apps/${APP_ID}/deployments`, "POST", {
  environment: "staging",
  artifact_id: deploymentArtifactId
});
assert.equal(deploymentResult.handled, true);
assert.equal(deploymentResult.status, 202);
assert.equal(lastServiceRequest.path, "/rest/v1/rpc/feltus_request_artifact_deployment");
assert.deepEqual(Object.keys(lastServiceRequest.body).sort(), [
  "p_app_id", "p_environment_kind", "p_artifact_id", "p_actor_id", "p_idempotency_key", "p_production_enabled"
].sort());
assert.deepEqual({
  p_app_id: lastServiceRequest.body.p_app_id,
  p_environment_kind: lastServiceRequest.body.p_environment_kind,
  p_artifact_id: lastServiceRequest.body.p_artifact_id,
  p_actor_id: lastServiceRequest.body.p_actor_id,
  p_production_enabled: lastServiceRequest.body.p_production_enabled
}, {
  p_app_id: APP_ID,
  p_environment_kind: "staging",
  p_artifact_id: deploymentArtifactId,
  p_actor_id: USER_ID,
  p_production_enabled: false
});
assert.match(lastServiceRequest.body.p_idempotency_key, /^[0-9a-f-]{36}$/i);
assert.equal(deploymentResult.body.deployment.environment, "staging");
console.log("PASS Staging deployment POST invokes the artifact RPC with the exact contract and a generated idempotency key");

const rpcFailureHandler = createApplicationStateHandler({
  tableRequest,
  serviceRequest: async () => ({
    status: 500,
    data: { code: "23514", message: "Constraint detail included bearer TEST_SECRET_VALUE and private row data." }
  }),
  readBody: async request => request.body || {},
  getUser: () => ({ id: USER_ID })
});
const rpcFailure = { status: null, headers: {}, text: "" };
await rpcFailureHandler({ method: "POST", headers: {}, body: { environment: "staging", artifact_id: deploymentArtifactId } }, {
  writeHead(status, headers) { rpcFailure.status = status; rpcFailure.headers = headers; },
  end(text) { rpcFailure.text = String(text || ""); }
}, new URL(`http://feltus.test/api/apps/${APP_ID}/deployments`));
const rpcFailureBody = JSON.parse(rpcFailure.text);
assert.equal(rpcFailure.status, 502);
assert.equal(rpcFailureBody.error_code, "DB_23514");
assert.equal(rpcFailureBody.error, "Deployment could not be queued (DB_23514).");
assert.equal(rpcFailure.text.includes("TEST_SECRET_VALUE"), false);
assert.equal(rpcFailure.text.includes("Constraint detail"), false);
console.log("PASS deployment RPC errors expose a sanitized diagnostic code without raw database details");
if (priorDeploymentFlags.enabled === undefined) delete process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED;
else process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED = priorDeploymentFlags.enabled;
if (priorDeploymentFlags.coolify === undefined) delete process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED;
else process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED = priorDeploymentFlags.coolify;

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

const branchAppId = randomUUID();
const branchRepoId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const branch = "codex/feltus-phase3-state-delivery-engine";
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const developmentEnvironmentId = "00000000-0000-4000-8000-000000000000";
const stagingEnvironmentId = "00000002-0000-4000-8000-000000000000";
const blueprintAId = "11111111-1111-4111-8111-111111111111";
const blueprintBId = "22222222-2222-4222-8222-222222222222";
const branchFixtures = {
  feltus_applications: [{
    id: branchAppId, owner_id: USER_ID, app_name: "Synthetic Community App", app_type: "custom",
    setup_status: "configuring", setup_current_step: "code", setup_completed_steps: ["basics"],
    setup_data: {
      code: { repository_id: branchRepoId, branch, commit_sha: null },
      ai: { enabled: true, context_permissions: { documents: false, app_data: true, conversation_history: false, model_ids: [], document_ids: [] } },
      intelligence: { classification: {
        label: "community resource coordination",
        confidence: 0.91,
        archetypes: ["resource-coordination"],
        business_models: ["member-supported"],
        audiences: ["community organizers"],
        workflow_patterns: ["request-review-match"]
      } }
    }
  }],
  feltus_models: [], feltus_model_relationships: [], feltus_model_columns: [], feltus_documents: [],
  feltus_environments: [
    { id: developmentEnvironmentId, kind: "development", name: "Development", status: "active" },
    { id: stagingEnvironmentId, kind: "staging", name: "Staging", status: "active" }
  ],
  feltus_deployment_targets: [],
  feltus_project_repositories: [{ app_id: branchAppId, repository_id: branchRepoId }],
  feltus_repositories: [{ id: branchRepoId, repository_name: "feltus", default_branch: branch, archived_at: null }],
  feltus_repository_branches: [
    { app_id: branchAppId, repository_id: branchRepoId, environment_id: developmentEnvironmentId, branch_name: branch, is_default: true, latest_commit_sha: commitA, updated_at: "2026-11-05T10:00:00.000Z" },
    { app_id: branchAppId, repository_id: branchRepoId, environment_id: stagingEnvironmentId, branch_name: branch, is_default: true, latest_commit_sha: commitA, updated_at: "2026-11-05T10:01:00.000Z" }
  ],
  feltus_application_blueprints: [], feltus_builds: [], feltus_build_steps: [], feltus_artifacts: [],
  feltus_deployments: [], feltus_observed_application_states: [], feltus_application_state_deltas: [],
  feltus_worker_heartbeats: [{ worker_id: "build-worker-lineage-test", worker_type: "build", status: "online", last_seen_at: new Date().toISOString() }]
};
let blueprintRevision = 0;
let queuedBuild = null;
let blueprintHistoryFailureStatus = null;
let branchRemoteVerification = { status: "REMOTE_VERIFIED", remote_commit: commitA };
const branchRemoteVerifications = [];
const branchTableRequest = async (table, method, options = {}) => {
  if (table === "rpc/feltus_create_application_blueprint") {
    const parent = [...branchFixtures.feltus_application_blueprints].sort((a, b) => b.version - a.version)[0] || null;
    const payload = options.body;
    if (parent?.state_hash === payload.p_state_hash) return { status: 200, data: parent };
    if (parent?.status === "ready") parent.status = "superseded";
    const id = [blueprintAId, blueprintBId][blueprintRevision++];
    const version = Number(parent?.version || 0) + 1;
    const createdAt = new Date(Date.now() + blueprintRevision).toISOString();
    const state = {
      ...payload.p_state,
      blueprint: {
        ...payload.p_state.blueprint, id, version,
        parent_id: parent?.id || null, parent_version: parent?.version || null,
        status: "ready", created_by: USER_ID, created_at: createdAt, state_hash: payload.p_state_hash
      }
    };
    const row = {
      id, app_id: branchAppId, version, parent_blueprint_id: parent?.id || null,
      parent_version: parent?.version || null, state_hash: payload.p_state_hash,
      state, status: "ready", created_by: USER_ID, created_at: createdAt
    };
    branchFixtures.feltus_application_blueprints.push(row);
    return { status: 200, data: row };
  }
  if (table === "feltus_applications") return { status: 200, data: branchFixtures.feltus_applications };
  const rows = branchFixtures[table] || [];
  if (table === "feltus_repository_branches") {
    return { status: 200, data: [...rows].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)) };
  }
  if (table === "feltus_application_blueprints") {
    if (blueprintHistoryFailureStatus !== null) {
      return { status: blueprintHistoryFailureStatus, data: { message: "simulated Blueprint history database failure" } };
    }
    return { status: 200, data: [...rows].sort((a, b) => b.version - a.version) };
  }
  return { status: 200, data: rows };
};
const branchServiceRequest = async (path, options = {}) => {
  if (path === "/rest/v1/rpc/feltus_queue_application_build") {
    queuedBuild = {
      id: "33333333-3333-4333-8333-333333333333", app_id: branchAppId,
      repository_id: options.body.p_repository_id, blueprint_id: options.body.p_blueprint_id,
      source_branch: options.body.p_source_branch, commit_sha: options.body.p_commit_sha, status: "queued"
    };
    branchFixtures.feltus_builds.push(queuedBuild);
    return { status: 200, data: queuedBuild };
  }
  return { status: 200, data: [] };
};
const branchHandler = createApplicationStateHandler({
  tableRequest: branchTableRequest,
  serviceRequest: branchServiceRequest,
  readBody: async request => request.body || {},
  getUser: () => ({ id: USER_ID }),
  verifyRemoteSource: async request => {
    branchRemoteVerifications.push(request);
    return branchRemoteVerification;
  }
});
const invokeBranch = async (pathname, method = "GET", body = {}) => {
  const result = { status: null, headers: {}, text: "" };
  const res = {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(text) { result.text = String(text || ""); }
  };
  await branchHandler({ method, headers: {}, body }, res, new URL(`http://feltus.test${pathname}`));
  const contentType = result.headers["Content-Type"] || "";
  return { ...result, body: contentType.startsWith("application/json") ? JSON.parse(result.text) : result.text };
};
const branchEnvBefore = process.env.FELTUS_BUILD_RUNNER_ENABLED;
process.env.FELTUS_BUILD_RUNNER_ENABLED = "true";
try {
  const initial = await invokeBranch(`/api/apps/${branchAppId}/state`);
  assert.equal(initial.body.state.desired_state.code.commit, commitA);
  assert.equal(initial.body.persisted, false);
  const initialIntelligence = initial.body.state.desired_state.intelligence;
  assert.equal(initialIntelligence.classification.application_type, "custom");
  assert.equal(initialIntelligence.classification.label, "community resource coordination");
  assert.deepEqual(initialIntelligence.classification.archetypes, ["ai-assisted", "multi-environment", "resource-coordination", "source-controlled"]);
  assert.deepEqual(initialIntelligence.classification.business_models, ["member-supported"]);
  assert.deepEqual(initialIntelligence.classification.audiences, ["community organizers"]);
  assert.deepEqual(initialIntelligence.classification.workflow_patterns, ["assistant-interaction", "environment-delivery", "request-review-match", "source-controlled-development"]);
  assert.equal(initialIntelligence.capabilities.hosted_repository, true);
  assert.equal(initialIntelligence.permissions.ai_context.app_data, true);
  assert.deepEqual(initialIntelligence.environment_provider_state.map(item => item.kind), ["development", "preview", "staging", "production"]);
  const emptyBlueprintHistory = await invokeBranch(`/api/apps/${branchAppId}/blueprints`);
  assert.equal(emptyBlueprintHistory.status, 200, "a valid app with no saved Blueprint must receive a successful history response");
  assert.deepEqual(emptyBlueprintHistory.body.blueprints, [], "a new app must have an empty Blueprint collection rather than an error");
  const savedA = await invokeBranch(`/api/apps/${branchAppId}/blueprints`, "POST", { confirm: true });
  assert.equal(savedA.status, 201);
  assert.equal(savedA.body.blueprint.version, 1);
  assert.equal(savedA.body.blueprint.state.desired_state.code.commit, commitA);
  assert.equal(savedA.body.export_url, `/api/apps/${branchAppId}/blueprints/${blueprintAId}/export`);
  assert.match(savedA.body.yaml, new RegExp(`commit: "${commitA}"`));
  assert.deepEqual(savedA.body.blueprint.state.desired_state.intelligence, initialIntelligence,
    "Blueprint persistence includes the same canonical intelligence profile");
  assert.equal(branchFixtures.feltus_application_blueprints[0].state.desired_state.intelligence.classification.label,
    "community resource coordination");
  const hydratedAfterSaveA = await invokeBranch(`/api/apps/${branchAppId}/state`);
  assert.equal(hydratedAfterSaveA.status, 200);
  assert.equal(hydratedAfterSaveA.body.persisted, true);
  assert.equal(canonicalJson(parseApplicationBlueprint(hydratedAfterSaveA.body.yaml_preview)),
    canonicalJson(parseApplicationBlueprint(savedA.body.yaml)),
    "normalize, serialize, persist, hydrate/reconstruct, and serialize produce canonical equality");
  const oneBlueprintHistory = await invokeBranch(`/api/apps/${branchAppId}/blueprints`);
  assert.equal(oneBlueprintHistory.status, 200);
  assert.equal(oneBlueprintHistory.body.blueprints.length, 1, "one valid saved Blueprint must load as one history record");
  assert.equal(oneBlueprintHistory.body.blueprints[0].id, blueprintAId);
  const exportedA = await invokeBranch(savedA.body.export_url);
  assert.equal(exportedA.status, 200);
  assert.equal(exportedA.body, savedA.body.yaml, "the save response YAML must match the authoritative export endpoint");

  // Simulate the verified push webhook updating Development while a later-written
  // Staging row for the same branch still contains the previous source SHA.
  branchFixtures.feltus_repository_branches.find(row => row.environment_id === developmentEnvironmentId).latest_commit_sha = commitB;
  branchFixtures.feltus_repository_branches.find(row => row.environment_id === developmentEnvironmentId).updated_at = "2026-11-05T10:30:00.000Z";
  branchFixtures.feltus_repository_branches.find(row => row.environment_id === stagingEnvironmentId).updated_at = "2026-11-05T10:31:00.000Z";
  const stale = await invokeBranch(`/api/apps/${branchAppId}/state`);
  assert.equal(stale.body.state.desired_state.code.commit, commitB, "state must take the webhook-updated Development branch SHA");
  assert.equal(stale.body.persisted, false, "Blueprint A must become stale when the tracked source commit changes");
  assert.equal(stale.body.latest_blueprint.id, blueprintAId);

  const savedB = await invokeBranch(`/api/apps/${branchAppId}/blueprints`, "POST", { confirm: true });
  assert.equal(savedB.status, 201);
  assert.equal(savedB.body.blueprint.version, 2);
  assert.equal(savedB.body.blueprint.parent_blueprint_id, blueprintAId);
  assert.equal(savedB.body.blueprint.state.desired_state.code.commit, commitB);
  assert.match(savedB.body.yaml, new RegExp(`commit: "${commitB}"`));
  const multipleBlueprintHistory = await invokeBranch(`/api/apps/${branchAppId}/blueprints`);
  assert.equal(multipleBlueprintHistory.status, 200);
  assert.deepEqual(multipleBlueprintHistory.body.blueprints.map(row => row.id), [blueprintBId, blueprintAId], "multiple Blueprint records must load newest first");
  assert.equal(branchFixtures.feltus_application_blueprints.find(row => row.id === blueprintAId).status, "superseded");
  assert.equal(branchFixtures.feltus_application_blueprints.find(row => row.id === blueprintAId).state.desired_state.code.commit, commitA);

  const current = await invokeBranch(`/api/apps/${branchAppId}/state`);
  assert.equal(current.body.persisted, true);
  assert.equal(current.body.state.desired_state.code.commit, commitB);
  assert.equal(current.body.state_hash, savedB.body.blueprint.state_hash);

  blueprintHistoryFailureStatus = 500;
  const failedBlueprintHistory = await invokeBranch(`/api/apps/${branchAppId}/blueprints`);
  blueprintHistoryFailureStatus = null;
  assert.equal(failedBlueprintHistory.status, 502, "a genuine Blueprint history database failure must not be converted to empty history");
  assert.match(failedBlueprintHistory.body.error, /could not be loaded/i, "a genuine Blueprint history failure must remain an explicit error");
  assert.equal(failedBlueprintHistory.body.blueprints, undefined);

  const mismatchedBuild = await invokeBranch(`/api/apps/${branchAppId}/builds`, "POST", {
    repository_id: branchRepoId, branch, commit_sha: commitA, idempotency_key: "branch-lineage-mismatch"
  });
  assert.equal(mismatchedBuild.status, 409, "a build cannot pair Blueprint B with commit A");
  branchRemoteVerification = { status: "REMOTE_DIVERGED", remote_commit: commitA };
  const remotelyDivergedBuild = await invokeBranch(`/api/apps/${branchAppId}/builds`, "POST", {
    repository_id: branchRepoId, branch, commit_sha: commitB, idempotency_key: "remote-diverged-build"
  });
  assert.equal(remotelyDivergedBuild.status, 409);
  assert.equal(remotelyDivergedBuild.body.error_code, "REMOTE_DIVERGED");
  assert.equal(queuedBuild, null, "remote divergence must block the build RPC");
  branchRemoteVerification = { status: "REMOTE_UNAVAILABLE", error_code: "REMOTE_VERIFICATION_FAILED" };
  const unavailableRemoteBuild = await invokeBranch(`/api/apps/${branchAppId}/builds`, "POST", {
    repository_id: branchRepoId, branch, commit_sha: commitB, idempotency_key: "remote-unavailable-build"
  });
  assert.equal(unavailableRemoteBuild.status, 503);
  assert.equal(unavailableRemoteBuild.body.error_code, "REMOTE_UNAVAILABLE");
  assert.equal(queuedBuild, null, "unavailable remote state must block the build RPC");
  branchRemoteVerification = { status: "REMOTE_VERIFIED", remote_commit: commitB };
  const build = await invokeBranch(`/api/apps/${branchAppId}/builds`, "POST", {
    repository_id: branchRepoId, branch, commit_sha: commitB, idempotency_key: "branch-lineage-commit-b"
  });
  assert.equal(build.status, 202);
  assert.equal(build.body.remote_verification.status, "REMOTE_VERIFIED");
  assert.equal(branchRemoteVerifications.at(-1).repositoryId, branchRepoId);
  assert.equal(branchRemoteVerifications.at(-1).expectedCommit, commitB);
  assert.equal(queuedBuild.blueprint_id, savedB.body.blueprint.id);
  assert.equal(queuedBuild.commit_sha, commitB);
  assert.equal(queuedBuild.source_branch, branch);
  const buildHistoryResult = await invokeBranch(`/api/apps/${branchAppId}/builds`);
  assert.equal(buildHistoryResult.body.builds[0].blueprint_id, savedB.body.blueprint.id);
  assert.equal(buildHistoryResult.body.builds[0].commit_sha, commitB);
  console.log("PASS branch A→B advances desired state, stales and supersedes Blueprints, saves the new revision, and queues exact Blueprint/commit lineage");
} finally {
  if (branchEnvBefore === undefined) delete process.env.FELTUS_BUILD_RUNNER_ENABLED;
  else process.env.FELTUS_BUILD_RUNNER_ENABLED = branchEnvBefore;
}

const checkpointId = randomUUID();
const observationId = randomUUID();
const previousBlueprintId = randomUUID();
const nextBlueprintId = randomUUID();
const currentDeploymentId = randomUUID();
const knownGoodDeploymentId = randomUUID();
const externalCommit = "d".repeat(40);
const savedFixtureRows = {
  checkpoints: data.feltus_code_checkpoints,
  blueprints: data.feltus_application_blueprints,
  observations: data.feltus_observed_application_states,
  deployments: data.feltus_deployments
};
const previousBlueprintState = structuredClone(stateResult.body.state);
previousBlueprintState.blueprint = {
  ...previousBlueprintState.blueprint,
  id: previousBlueprintId,
  version: 1,
  status: "ready",
  state_hash: stateResult.body.state_hash
};
const previousBlueprint = {
  id: previousBlueprintId,
  app_id: APP_ID,
  version: 1,
  parent_blueprint_id: null,
  parent_version: null,
  state_hash: stateResult.body.state_hash,
  state: previousBlueprintState,
  status: "superseded",
  created_by: USER_ID,
  created_at: "2026-11-04T10:03:00.000Z",
  source_commit: null
};
data.feltus_code_checkpoints = [{ id: checkpointId, git_commit: externalCommit, created_at: "2026-11-07T10:00:00.000Z" }];
data.feltus_application_blueprints = [previousBlueprint];
data.feltus_observed_application_states = [{
  id: observationId,
  deployment_id: currentDeploymentId,
  environment: "staging",
  provider: "synthetic",
  provider_deployment_id: "synthetic-run-1",
  blueprint_id: previousBlueprintId,
  blueprint_version: 1,
  commit_sha: externalCommit,
  artifact_digest: `sha256:${"c".repeat(64)}`,
  health: "healthy",
  state_hash: "e".repeat(64),
  observed_state: { deployment_state: "healthy" },
  observed_at: "2026-11-07T10:01:00.000Z"
}, {
  id: randomUUID(),
  deployment_id: currentDeploymentId,
  environment: "staging",
  provider: "synthetic",
  provider_deployment_id: "synthetic-run-0",
  blueprint_id: previousBlueprintId,
  blueprint_version: 1,
  commit_sha: externalCommit,
  artifact_digest: `sha256:${"b".repeat(64)}`,
  health: "healthy",
  state_hash: "a".repeat(64),
  observed_state: { deployment_state: "healthy" },
  observed_at: "2026-11-06T10:01:00.000Z"
}];
data.feltus_deployments = [
  { id: currentDeploymentId, environment: "staging", environment_id: null, provider: null, provider_reference: null,
    blueprint_id: nextBlueprintId, artifact_id: null, artifact_digest: null, commit_sha: externalCommit,
    status: "HEALTHY", created_at: "2026-11-07T10:00:00.000Z", started_at: null, completed_at: null },
  { id: knownGoodDeploymentId, environment: "staging", environment_id: null, provider: null, provider_reference: null,
    blueprint_id: previousBlueprintId, artifact_id: null, artifact_digest: null, commit_sha: null,
    status: "HEALTHY", created_at: "2026-11-06T10:00:00.000Z", started_at: null, completed_at: null }
];
let reconciliationUserId = USER_ID;
let reconciliationBlueprintRpcCalls = 0;
let reconciliationValidationCalls = 0;
let reconciliationAudit = [];
let reconciliationServiceRequest = null;
const reconciliationHandler = createApplicationStateHandler({
  tableRequest: async (table, method, options = {}) => {
    if (table === "feltus_applications") {
      return { status: 200, data: (options.query || "").includes(`id=eq.${APP_ID}`) ? [app] : [] };
    }
    if (table === "rpc/feltus_create_application_blueprint") {
      reconciliationBlueprintRpcCalls += 1;
      lastRpc = options.body;
      return { status: 200, data: {
        id: nextBlueprintId,
        app_id: APP_ID,
        version: options.body.p_state.blueprint.version,
        parent_blueprint_id: options.body.p_state.blueprint.parent_id,
        parent_version: options.body.p_state.blueprint.parent_version,
        state_hash: options.body.p_state_hash,
        state: options.body.p_state,
        status: "ready",
        created_by: USER_ID,
        created_at: "2026-11-07T10:02:00.000Z"
      } };
    }
    return tableRequest(table, method, options);
  },
  serviceRequest: async (path, options = {}) => {
    if (path.startsWith("/rest/v1/feltus_app_backups?")) return { status: 200, data: [] };
    reconciliationServiceRequest = { path, body: options.body };
    return { status: 200, data: { id: randomUUID(), environment: options.body?.p_environment_kind || "staging", status: "QUEUED" } };
  },
  readBody: async request => request.body || {},
  getUser: () => ({ id: reconciliationUserId }),
  authorizeApp: async (applicationId, capability) => applicationId === APP_ID &&
    ["canViewCode", "canPrepareVersion", "canDeployTesting"].includes(capability),
  validateReconciliation: async input => {
    reconciliationValidationCalls += 1;
    assert.equal(input.applicationId, APP_ID);
    assert.equal(input.sourceCommit, externalCommit);
    assert.equal(input.sourceCheckpointId, checkpointId);
    return { ready_for_release: true, source_commit: externalCommit, run_id: "synthetic-validation-run" };
  },
  recordReconciliation: async event => { reconciliationAudit.push(event); }
});
const invokeReconciliation = (pathname, method = "GET", body = {}) => {
  const result = { status: null, headers: {}, text: "" };
  const res = {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(text) { result.text = String(text || ""); }
  };
  const req = { method, headers: {}, body };
  return reconciliationHandler(req, res, new URL(`http://feltus.test${pathname}`)).then(handled => ({
    handled,
    ...result,
    body: result.headers["Content-Type"]?.startsWith("application/json") ? JSON.parse(result.text) : result.text
  }));
};
try {
  reconciliationUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const nonOwnerAccept = await invokeReconciliation(`/api/apps/${APP_ID}/state/reconciliation/accept`, "POST", {
    observation_id: observationId, delta_key: "desired_state.unpersisted", confirm: true
  });
  assert.equal(nonOwnerAccept.status, 403, "a collaborator cannot accept an external change without application ownership");
  assert.equal(reconciliationBlueprintRpcCalls, 0);
  assert.equal(reconciliationValidationCalls, 0);

  reconciliationUserId = USER_ID;
  const currentReconciliationState = await invokeReconciliation(`/api/apps/${APP_ID}/state`);
  assert.equal(currentReconciliationState.status, 200, JSON.stringify(currentReconciliationState.body));
  assert.equal(currentReconciliationState.body.delta.some(item => item.key === "desired_state.unpersisted" && item.status === "changed"), true);
  const staleObservation = await invokeReconciliation(`/api/apps/${APP_ID}/state/reconciliation/accept`, "POST", {
    observation_id: data.feltus_observed_application_states[1].id, delta_key: "desired_state.unpersisted", confirm: true
  });
  assert.equal(staleObservation.status, 409, "stale observations cannot be accepted after a newer observation exists");
  assert.equal(reconciliationBlueprintRpcCalls, 0);
  const acceptedExternalChange = await invokeReconciliation(`/api/apps/${APP_ID}/state/reconciliation/accept`, "POST", {
    observation_id: observationId, delta_key: "desired_state.unpersisted", confirm: true
  });
  assert.equal(acceptedExternalChange.status, 201);
  assert.equal(acceptedExternalChange.body.blueprint.version, 2);
  assert.equal(acceptedExternalChange.body.blueprint.parent_blueprint_id, previousBlueprintId);
  assert.equal(acceptedExternalChange.body.blueprint.state.desired_state.code.commit, externalCommit);
  assert.equal(reconciliationBlueprintRpcCalls, 1);
  assert.equal(lastRpc.p_state_hash, acceptedExternalChange.body.state_hash);
  assert.equal(previousBlueprint.version, 1);
  assert.equal(previousBlueprint.state_hash, stateResult.body.state_hash);
  assert.equal(previousBlueprint.state.desired_state.code.commit, null, "accepting an observed change never mutates the prior immutable Blueprint");
  assert.equal(reconciliationAudit[0].action, "accept_external_change");
  assert.equal(reconciliationAudit[0].details.previous_blueprint_id, previousBlueprintId);
  assert.equal(reconciliationAudit[0].details.source_checkpoint_id, checkpointId);
  assert.equal(reconciliationAudit[0].details.new_blueprint_id, nextBlueprintId);
  console.log("PASS owner reconciliation validates the exact checkpoint and creates an immutable child Blueprint");

  const restoredVersion = await invokeReconciliation(`/api/apps/${APP_ID}/state/reconciliation/restore`, "POST", {
    target_blueprint_id: previousBlueprintId,
    environment: "staging",
    reason: "Synthetic rollback verification",
    confirm: true,
    idempotency_key: "synthetic-restore-1"
  });
  assert.equal(restoredVersion.status, 202);
  assert.equal(restoredVersion.body.target_blueprint.id, previousBlueprintId);
  assert.equal(reconciliationServiceRequest.path, "/rest/v1/rpc/feltus_request_deployment_rollback");
  assert.equal(reconciliationServiceRequest.body.p_current_deployment_id, currentDeploymentId);
  assert.equal(reconciliationServiceRequest.body.p_known_good_deployment_id, knownGoodDeploymentId);
  assert.equal(reconciliationServiceRequest.body.p_reason, "Synthetic rollback verification");
  assert.equal(reconciliationAudit.at(-1).details.target_blueprint_id, previousBlueprintId);
  const crossApplicationRead = await invokeReconciliation(`/api/apps/${randomUUID()}/state`);
  assert.equal(crossApplicationRead.status, 404, "reconciliation handler must reject access outside the authorized application");
  console.log("PASS restore queues the explicitly selected healthy desired version and cross-application access is rejected");
} finally {
  for (const [key, value] of Object.entries({
    feltus_code_checkpoints: savedFixtureRows.checkpoints,
    feltus_application_blueprints: savedFixtureRows.blueprints,
    feltus_observed_application_states: savedFixtureRows.observations,
    feltus_deployments: savedFixtureRows.deployments
  })) {
    if (value === undefined) delete data[key];
    else data[key] = value;
  }
}
