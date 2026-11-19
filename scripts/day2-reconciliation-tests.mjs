import assert from "node:assert/strict";
import {
  applicationStateHash,
  normalizeApplicationState
} from "../src/lib/feltus-application-state.js";
import {
  createDay2ReconciliationManifest,
  evaluateDay2Reconciliation,
  reconciliationBindings,
  resolveStoredDay2Reconciliation
} from "../src/lib/feltus-day2-reconciliation.js";
import { createApplicationStateHandler } from "../src/lib/feltus-application-state-api.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const BLUEPRINT_ID = "44444444-4444-4444-8444-444444444444";
const ENVIRONMENT_ID = "55555555-5555-4555-8555-555555555555";
const TARGET_ID = "66666666-6666-4666-8666-666666666666";
const DEPLOYMENT_ID = "77777777-7777-4777-8777-777777777777";
const OBSERVATION_ID = "88888888-8888-4888-8888-888888888888";
const ARTIFACT_ID = "99999999-9999-4999-8999-999999999999";
const CHECKPOINT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const SNAPSHOT_A = "c".repeat(64);
const SNAPSHOT_B = "d".repeat(64);
const DIGEST_A = `sha256:${"e".repeat(64)}`;
const DIGEST_B = `sha256:${"f".repeat(64)}`;
const AS_OF = "2026-11-09T12:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stateFixture() {
  const state = normalizeApplicationState({
    application: { id: APP_ID, name: "Reconciliation fixture", type: "custom", lifecycle_status: "active" },
    blueprint: {
      id: BLUEPRINT_ID,
      version: 1,
      parent_id: null,
      parent_version: null,
      status: "ready",
      created_by: USER_ID,
      created_at: "2026-11-09T10:00:00.000Z",
      state_hash: null,
      source_commit: COMMIT_A
    },
    desired_state: {
      data: { models: [], relationships: [] },
      knowledge: { documents: [] },
      ai: { enabled: true, assistant_purpose: "Support" },
      code: {
        workspace: "workspace-a",
        repository_id: "repository-a",
        repository: "reconciliation-fixture",
        branch: "main",
        commit: COMMIT_A,
        status: "connected"
      },
      environments: [
        { id: ENVIRONMENT_ID, kind: "staging", status: "active", provider: "synthetic", resource_reference: "target-a" }
      ]
    },
    execution: { builds: [], artifacts: [], deployments: [] },
    observed_state: null
  }, { verifyStateHash: false });
  state.blueprint.state_hash = applicationStateHash(state);
  return state;
}

function fixture() {
  const state = stateFixture();
  const blueprint = {
    id: BLUEPRINT_ID,
    app_id: APP_ID,
    version: 1,
    parent_blueprint_id: null,
    parent_version: null,
    state_hash: state.blueprint.state_hash,
    source_commit: COMMIT_A,
    status: "ready",
    state,
    created_at: "2026-11-09T10:00:00.000Z"
  };
  const observation = {
    id: OBSERVATION_ID,
    deployment_id: DEPLOYMENT_ID,
    environment: "staging",
    provider: "synthetic",
    provider_deployment_id: "synthetic-deployment-a",
    blueprint_id: BLUEPRINT_ID,
    blueprint_version: 1,
    commit_sha: COMMIT_A,
    artifact_digest: DIGEST_A,
    health: "healthy",
    state_hash: "1".repeat(64),
    observed_state: { deployment_state: "healthy", probe_scope_valid: true },
    observed_at: "2026-11-09T11:59:00.000Z"
  };
  const application = {
    id: APP_ID,
    owner_id: USER_ID,
    organization_id: ORG_ID,
    app_name: "Reconciliation fixture",
    app_type: "custom",
    setup_status: "active",
    setup_data: { code: { workspace: "workspace-a", branch: "main", commit_sha: COMMIT_A } }
  };
  const inputs = {
    environments: [{ id: ENVIRONMENT_ID, kind: "staging", status: "active" }],
    targets: [{ id: TARGET_ID, environment_id: ENVIRONMENT_ID, provider_key: "synthetic", provider_resource_reference: "target-a", active: true }],
    codeCheckpoints: [{ id: CHECKPOINT_ID, git_commit: COMMIT_A, created_at: "2026-11-09T10:00:00.000Z" }],
    blueprints: [blueprint],
    artifacts: [{ id: ARTIFACT_ID, build_id: null, blueprint_id: BLUEPRINT_ID, registry_image: null, artifact_digest: DIGEST_A, verification_status: "passed", environment_eligibility: [], created_at: "2026-11-09T11:30:00.000Z", verified_at: null }],
    deployments: [{ id: DEPLOYMENT_ID, environment: "staging", environment_id: ENVIRONMENT_ID, provider: "synthetic", provider_reference: "synthetic-deployment-a", status: "HEALTHY", artifact_id: ARTIFACT_ID, artifact_digest: DIGEST_A, blueprint_id: BLUEPRINT_ID, commit_sha: COMMIT_A, created_at: "2026-11-09T11:40:00.000Z", started_at: null, completed_at: null }],
    observations: [observation],
    stateDeltas: []
  };
  const sourceIdentity = {
    application_id: APP_ID,
    workspace_id: "workspace-a",
    branch: "main",
    checkpoint: COMMIT_A,
    source_commit: COMMIT_A,
    source_snapshot_sha256: SNAPSHOT_A,
    source_snapshot_complete: true,
    classifier_version: "repository-v1"
  };
  return { application, state, blueprint, observation, inputs, sourceIdentity };
}

function input(overrides = {}) {
  const value = fixture();
  return {
    application: value.application,
    inputs: value.inputs,
    environment: "staging",
    desiredBlueprint: value.blueprint,
    desiredState: value.state,
    currentState: clone(value.state),
    sourceIdentity: value.sourceIdentity,
    sourceContext: { available: true, source_clean: true, classification_current: true, classification_stale: false },
    target: value.inputs.targets[0],
    observation: value.observation,
    design: { applicable: false },
    configuration: { required: [] },
    infrastructure: { worker_verified: true, evaluator_version: "fixture-infrastructure-v1" },
    asOf: AS_OF,
    freshnessMs: 5 * 60 * 1000,
    actorId: USER_ID,
    correlationId: "phase-h-fixture",
    ...overrides
  };
}

function drift(result, reasonCode) {
  const found = result.drifts.find(item => item.reason_code === reasonCode);
  assert.ok(found, `Expected drift ${reasonCode}; received ${result.drifts.map(item => item.reason_code).join(", ")}`);
  return found;
}

const cases = [];
function test(name, callback) {
  cases.push({ name, callback });
}

test("A scope and manifest determinism", () => {
  const value = input();
  const first = createDay2ReconciliationManifest(value);
  const second = createDay2ReconciliationManifest({ ...value, actorId: "different-actor", correlationId: "different-request" });
  assert.equal(first.run_id, second.run_id);
  assert.equal(first.manifest_hash, second.manifest_hash);
  const changedPolicy = createDay2ReconciliationManifest({ ...value, policyVersion: "phase-h-v2" });
  assert.notEqual(first.run_id, changedPolicy.run_id);
  const crossScope = evaluateDay2Reconciliation(input({ application: { ...value.application, organization_id: null } }));
  assert.equal(crossScope.state, "BLOCKED");
  assert.equal(drift(crossScope, "RECONCILIATION_SCOPE_INCOMPLETE").classification, "BLOCKED");
});

test("B desired and observed snapshots", () => {
  const current = evaluateDay2Reconciliation(input());
  assert.equal(current.state, "CURRENT", JSON.stringify(current.drifts, null, 2));
  assert.equal(current.reconciliation_current, true);

  const draft = input();
  draft.currentState.desired_state.ai.assistant_purpose = "Changed without a Blueprint";
  const desiredDrift = evaluateDay2Reconciliation(draft);
  assert.equal(desiredDrift.state, "REVIEW_REQUIRED");
  assert.equal(drift(desiredDrift, "DESIRED_STATE_UNPERSISTED").classification, "REVIEW_REQUIRED");

  const missing = input();
  missing.inputs.observations = [];
  missing.observation = null;
  const missingResult = evaluateDay2Reconciliation(missing);
  assert.equal(missingResult.state, "BLOCKED");
  drift(missingResult, "OBSERVATION_MISSING");

  const stale = input();
  stale.inputs.observations[0].observed_at = "2026-11-09T11:40:00.000Z";
  stale.observation = stale.inputs.observations[0];
  const staleResult = evaluateDay2Reconciliation(stale);
  assert.equal(staleResult.state, "STALE");
  assert.equal(drift(staleResult, "OBSERVATION_STALE").status, "stale");
});

test("C classification matrix", () => {
  const dirty = evaluateDay2Reconciliation(input({ sourceContext: { available: true, source_clean: false, classification_current: true } }));
  assert.equal(dirty.state, "BLOCKED");
  drift(dirty, "SOURCE_WORKSPACE_DIRTY");

  const changedSource = input();
  changedSource.sourceIdentity = { ...changedSource.sourceIdentity, checkpoint: COMMIT_B, source_commit: COMMIT_B, source_snapshot_sha256: SNAPSHOT_B };
  changedSource.inputs.codeCheckpoints = [{ id: CHECKPOINT_ID, git_commit: COMMIT_B }];
  const sourceReview = evaluateDay2Reconciliation(changedSource);
  assert.equal(sourceReview.state, "REVIEW_REQUIRED");
  assert.equal(drift(sourceReview, "SOURCE_CHECKPOINT_MISMATCH").classification, "REVIEW_REQUIRED");

  const protectedChange = evaluateDay2Reconciliation(input({ protectedContractChanges: [{ path: "supabase/migrations/example.sql", type: "migration" }] }));
  assert.equal(protectedChange.state, "BLOCKED");
  drift(protectedChange, "PROTECTED_CONTRACT_CHANGE_BLOCKED");

  const ambiguousProvider = input();
  ambiguousProvider.inputs.deployments[0].status = "BUILDING";
  ambiguousProvider.observation.observed_state.deployment_state = "deploying";
  ambiguousProvider.infrastructure.worker_verified = false;
  const providerResult = evaluateDay2Reconciliation(ambiguousProvider);
  assert.equal(providerResult.state, "BLOCKED");
  drift(providerResult, "DEPLOYMENT_WORKER_UNVERIFIED");
});

test("D rollback eligibility remains bounded", () => {
  const noKnownGood = input({ requestedAction: "ROLLBACK" });
  noKnownGood.inputs.deployments[0].status = "FAILED";
  const noKnownGoodResult = evaluateDay2Reconciliation(noKnownGood);
  assert.equal(noKnownGoodResult.state, "BLOCKED");
  drift(noKnownGoodResult, "ROLLBACK_TARGET_UNSAFE");

  const mutable = input({ requestedAction: "ROLLBACK" });
  mutable.inputs.artifacts[0].artifact_digest = "latest";
  const mutableResult = evaluateDay2Reconciliation(mutable);
  assert.equal(mutableResult.state, "BLOCKED");
  drift(mutableResult, "ROLLBACK_TARGET_UNSAFE");

  const digestMismatch = input({ requestedAction: "ROLLBACK" });
  digestMismatch.inputs.deployments[0].artifact_digest = DIGEST_B;
  const digestResult = evaluateDay2Reconciliation(digestMismatch);
  assert.equal(digestResult.state, "BLOCKED");
  drift(digestResult, "ROLLBACK_TARGET_UNSAFE");

  const crossApplication = input();
  crossApplication.inputs.artifacts[0].app_id = "00000000-0000-4000-8000-000000000000";
  const crossResult = evaluateDay2Reconciliation(crossApplication);
  assert.equal(crossResult.state, "BLOCKED");
  drift(crossResult, "ARTIFACT_CROSS_SCOPE");
  assert.equal(crossResult.verification.deployment_changed, false);
});

test("E stale-state races", () => {
  const evaluated = evaluateDay2Reconciliation(input());
  const changedBindings = reconciliationBindings(evaluated);
  changedBindings.source_identity.source_snapshot_sha256 = SNAPSHOT_B;
  const stale = resolveStoredDay2Reconciliation(evaluated, { bindings: changedBindings });
  assert.equal(stale.state, "STALE");
  assert.equal(stale.reconciliation_current, false);
  assert.equal(evaluated.state, "CURRENT", "the prior immutable result must not be rewritten");
  assert.equal(stale.events.at(-1).status, "stale");
});

test("F Design Studio remains component-scoped", () => {
  const base = input();
  const developerManaged = evaluateDay2Reconciliation({
    ...base,
    design: {
      applicable: true,
      design_state_hash: "2".repeat(64),
      source_identity: base.sourceIdentity,
      components: [{ id: "hero", source_path: "src/hero.html", ownership_state: "DEVELOPER_MANAGED", reconciliation_state: "NOT_REQUIRED", sync_state: "SYNCED" }],
      reconciliation: [{ component_id: "hero", outcome: "DEVELOPER_VERSION_PRESERVED" }],
      sync_summary: { developer_managed: 1, reconciliation_required: 0, stylesheet_reconciliation_required: 0 }
    }
  });
  assert.equal(developerManaged.state, "CURRENT");

  const required = evaluateDay2Reconciliation({
    ...base,
    design: {
      applicable: true,
      design_state_hash: "3".repeat(64),
      source_identity: base.sourceIdentity,
      components: [{ id: "hero", source_path: "src/hero.html", ownership_state: "FELTUS_MANAGED", reconciliation_state: "REQUIRED", sync_state: "RECONCILIATION_REQUIRED" }],
      reconciliation: [{ component_id: "hero", outcome: "RECONCILIATION_REQUIRED" }],
      sync_summary: { reconciliation_required: 1, stylesheet_reconciliation_required: 0 }
    }
  });
  assert.equal(required.state, "REVIEW_REQUIRED");
  assert.equal(drift(required, "DESIGN_COMPONENT_RECONCILIATION_REQUIRED").source.source_path, "src/hero.html");

  const conflict = evaluateDay2Reconciliation({
    ...base,
    design: {
      applicable: true,
      design_state_hash: "4".repeat(64),
      source_identity: base.sourceIdentity,
      components: [],
      reconciliation: [],
      conflict: true,
      sync_summary: { stylesheet_reconciliation_required: 1 }
    }
  });
  assert.equal(conflict.state, "BLOCKED");
  drift(conflict, "DESIGN_STYLESHEET_CONFLICT");
});

test("G infrastructure stays at the worker boundary", () => {
  const value = input();
  value.inputs.deployments[0].status = "BUILDING";
  value.observation.observed_state.deployment_state = "deploying";
  const result = evaluateDay2Reconciliation(value);
  const refresh = drift(result, "DEPLOYMENT_OBSERVATION_REFRESH_AVAILABLE");
  assert.equal(refresh.classification, "SAFE_AUTOMATIC");
  assert.equal(refresh.action.execution, "NOT_EXECUTED");
  assert.equal(result.verification.provider_called, false);
  assert.equal(result.verification.deployment_changed, false);
});

test("H source identity and checkpoints", () => {
  const missingCheckpoint = input();
  missingCheckpoint.inputs.codeCheckpoints = [];
  const result = evaluateDay2Reconciliation(missingCheckpoint);
  assert.equal(result.state, "BLOCKED");
  drift(result, "SOURCE_CHECKPOINT_MISSING");
  assert.equal(result.manifest.source_identity.source_snapshot_sha256, SNAPSHOT_A);
  assert.equal(result.manifest.source_identity.classifier_version, "repository-v1");
});

test("I evidence and history safety", () => {
  const result = evaluateDay2Reconciliation(input({
    protectedContractChanges: [{ path: "src/server.js", api_key: "not-for-output" }],
    correlationId: "correlation-fixture"
  }));
  const event = result.events[0];
  assert.ok(event.precondition_hashes.desired_hash);
  assert.equal(event.actor_id, USER_ID);
  assert.equal(event.correlation_id, "correlation-fixture");
  assert.equal(event.post_verification.status, "not_executed");
  assert.equal(JSON.stringify(result).includes("not-for-output"), false, "evidence must not expose secret values");
  const stale = resolveStoredDay2Reconciliation(result, { bindings: { ...result.bindings, desired_blueprint: { ...result.bindings.desired_blueprint, state_hash: "5".repeat(64) } } });
  assert.equal(stale.events.at(-1).status, "stale");
});

test("J API persistence never performs live activity", async () => {
  const value = fixture();
  const rows = {
    feltus_applications: [value.application],
    feltus_models: [],
    feltus_model_columns: [],
    feltus_model_relationships: [],
    feltus_documents: [],
    feltus_environments: value.inputs.environments,
    feltus_deployment_targets: value.inputs.targets,
    feltus_project_repositories: [],
    feltus_repositories: [],
    feltus_repository_branches: [],
    feltus_code_checkpoints: value.inputs.codeCheckpoints,
    feltus_application_blueprints: [],
    feltus_builds: [],
    feltus_artifacts: value.inputs.artifacts,
    feltus_deployments: value.inputs.deployments,
    feltus_observed_application_states: value.inputs.observations,
    feltus_application_state_deltas: [],
    feltus_worker_heartbeats: []
  };
  const activity = [];
  const tableCalls = [];
  let serviceCalls = 0;
  const handler = createApplicationStateHandler({
    tableRequest: async (table, method, options = {}) => {
      tableCalls.push({ table, method, query: options.query || null });
      if (table === "rpc/feltus_create_application_blueprint") {
        const state = options.body.p_state;
        const saved = {
          id: state.blueprint.id,
          app_id: APP_ID,
          version: state.blueprint.version,
          parent_blueprint_id: state.blueprint.parent_id,
          parent_version: state.blueprint.parent_version,
          state_hash: options.body.p_state_hash,
          state,
          status: state.blueprint.status,
          created_by: USER_ID,
          created_at: AS_OF,
          source_commit: state.blueprint.source_commit
        };
        rows.feltus_application_blueprints = [saved];
        return { status: 200, data: saved };
      }
      return { status: 200, data: rows[table] || [] };
    },
    serviceRequest: async () => {
      serviceCalls += 1;
      return { status: 500, data: { error: "A reconciliation evaluation must not call services." } };
    },
    readBody: async request => request.body || {},
    getUser: () => ({ id: USER_ID }),
    authorizeApp: async (appId, capability) => appId === APP_ID && ["canViewCode", "canRunAgent", "canPrepareVersion"].includes(capability),
    reconciliationContext: async () => ({
      available: true,
      source_clean: true,
      source_identity: value.sourceIdentity,
      classification: { is_current: true, stale: false },
      configuration: { required: [] },
      design: { applicable: false }
    }),
    findReconciliationRun: async ({ runId = null, scope = null }) => activity.find(item => {
      if (item.action_type !== "state.reconciliation.day2_evaluated") return false;
      if (runId) return item.details.day2_reconciliation?.run_id === runId;
      if (!scope) return true;
      return item.details.day2_reconciliation?.manifest?.scope?.environment_id === scope.environment_id;
    }) || null,
    recordReconciliation: async ({ action, details, resultStatus }) => {
      activity.unshift({
        id: `${action}-${activity.length + 1}`,
        action_type: `state.reconciliation.${action}`,
        details: { reconciliation_action: action, ...details },
        result_status: resultStatus,
        created_at: AS_OF
      });
    }
  });
  const invoke = async (pathname, method = "POST", body = {}) => {
    const captured = { status: 0, headers: {}, text: "" };
    const response = {
      writeHead(status, headers) { captured.status = status; captured.headers = headers || {}; },
      end(text) { captured.text = String(text || ""); }
    };
    const handled = await handler({ method, headers: {}, body }, response, new URL(`http://feltus.test${pathname}`));
    return { handled, ...captured, body: JSON.parse(captured.text) };
  };
  const prepared = await invoke(`/api/apps/${APP_ID}/blueprints`, "POST", { confirm: true });
  assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
  const preparedBlueprintId = prepared.body.blueprint.id;
  rows.feltus_artifacts[0].blueprint_id = preparedBlueprintId;
  rows.feltus_deployments[0].blueprint_id = preparedBlueprintId;
  rows.feltus_observed_application_states[0].blueprint_id = preparedBlueprintId;
  rows.feltus_observed_application_states[0].blueprint_version = prepared.body.blueprint.version;
  const first = await invoke(`/api/apps/${APP_ID}/state/reconciliation/evaluate`, "POST", {
    environment: "staging", as_of: AS_OF, freshness_ms: 300000, idempotency_key: "phase-h-fixture"
  });
  assert.equal(first.handled, true);
  assert.equal(first.status, 200, `${JSON.stringify(first.body)}\n${JSON.stringify(activity)}\n${JSON.stringify(tableCalls)}`);
  assert.equal(first.body.reconciliation.state, "CURRENT", JSON.stringify(first.body.reconciliation.drifts));
  assert.equal(activity.some(item => item.action_type === "state.reconciliation.day2_started"), true);
  assert.equal(activity.some(item => item.action_type === "state.reconciliation.day2_evaluated"), true);
  const second = await invoke(`/api/apps/${APP_ID}/state/reconciliation/evaluate`, "POST", {
    environment: "staging", as_of: AS_OF, freshness_ms: 300000, idempotency_key: "phase-h-fixture"
  });
  assert.equal(second.body.reused, true);
  assert.equal(activity.some(item => item.action_type === "state.reconciliation.day2_duplicate"), true);
  const read = await invoke(`/api/apps/${APP_ID}/state/reconciliation?environment=staging&as_of=${encodeURIComponent(AS_OF)}`, "GET");
  assert.equal(read.status, 200);
  assert.equal(read.body.reconciliation.state, "CURRENT");
  assert.equal(serviceCalls, 0, "Phase H evaluation must not call a provider or deployment service");
});

let failures = 0;
for (const { name, callback } of cases) {
  try {
    await callback();
    console.log(`PASS Phase H ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL Phase H ${name}`);
    console.error(error.stack || error.message || error);
  }
}

if (failures) process.exitCode = 1;
