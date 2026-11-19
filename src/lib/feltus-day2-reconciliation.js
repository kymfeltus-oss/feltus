import crypto from "node:crypto";
import {
  APPLICATION_STATE_CONTRACT,
  applicationStateHash,
  canonicalJson,
  normalizeApplicationState
} from "./feltus-application-state.js";
import { normalizeSourceIdentity } from "../feltus-code/server/release-readiness.mjs";
import { redactSecrets } from "../feltus-code/server/security.mjs";

// Phase H is a policy and evidence layer over the existing application-state,
// Blueprint, CODE, deployment, and Design Studio contracts. It intentionally
// has no provider adapter, source writer, or deployment executor.
export const DAY2_RECONCILIATION_CONTRACT = "feltus.day2-reconciliation/v1";
export const DAY2_RECONCILIATION_POLICY_VERSION = "phase-h-v1";
export const DAY2_RECONCILIATION_EVALUATOR_VERSION = "phase-h-v1";
export const DAY2_RECONCILIATION_STATES = Object.freeze([
  "CURRENT",
  "REVIEW_REQUIRED",
  "BLOCKED",
  "STALE"
]);
export const DAY2_RECONCILIATION_ACTION_STATUSES = Object.freeze([
  "detected",
  "review_required",
  "blocked",
  "queued",
  "executing",
  "verified",
  "failed",
  "stale",
  "superseded"
]);
export const DAY2_RECONCILIATION_ACTION_CLASSES = Object.freeze([
  "SAFE_AUTOMATIC",
  "REVIEW_REQUIRED",
  "BLOCKED"
]);

const ENVIRONMENTS = new Set(["development", "preview", "staging", "production"]);
const SOURCE_FIELDS = Object.freeze([
  "application_id",
  "workspace_id",
  "branch",
  "checkpoint",
  "source_commit",
  "source_snapshot_sha256",
  "classifier_version"
]);
const SENSITIVE_KEY = /(secret|password|credential|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token)/i;
const FULL_COMMIT = /^[0-9a-f]{40,64}$/i;
const IMMUTABLE_DIGEST = /^sha256:[0-9a-f]{64}$/i;
const HEALTHY = new Set(["healthy", "passed", "ready"]);
const TERMINAL_UNHEALTHY = new Set(["unhealthy", "degraded", "failed", "cancelled"]);
const KNOWN_DEPLOYMENT_STATES = new Set([
  "queued", "building", "deploying", "running", "healthy", "failed", "degraded", "cancelled", "pending", "unknown"
]);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, limit = 1200) {
  if (value === null || value === undefined || value === "") return null;
  return redactSecrets(String(value)).normalize("NFC").slice(0, limit);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeValue(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => safeValue(item));
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return text(value, 8000);
    if (value === undefined) return null;
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map(name => [name, safeValue(value[name], name)]));
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(canonicalJson(safeValue(value)), "utf8").digest("hex");
}

function timestamp(value, fallback = null) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizedText(value) {
  return value === null || value === undefined || value === "" ? null : String(value).normalize("NFC");
}

function normalizedCommit(value) {
  const result = normalizedText(value);
  return result ? result.toLowerCase() : null;
}

function sameCommit(left, right) {
  return normalizedCommit(left) === normalizedCommit(right);
}

function sameValue(left, right) {
  return canonicalJson(safeValue(left)) === canonicalJson(safeValue(right));
}

function hasFullCommit(value) {
  return FULL_COMMIT.test(String(value || ""));
}

function sortedByTime(rows, field = "created_at") {
  return [...array(rows)].sort((left, right) => {
    const difference = Date.parse(right?.[field] || 0) - Date.parse(left?.[field] || 0);
    return difference || String(right?.id || "").localeCompare(String(left?.id || ""));
  });
}

function actionStatus(classification, stale = false) {
  if (stale) return "stale";
  if (classification === "BLOCKED") return "blocked";
  if (classification === "REVIEW_REQUIRED") return "review_required";
  return "detected";
}

function severity(classification) {
  if (classification === "BLOCKED") return "blocking";
  if (classification === "REVIEW_REQUIRED") return "review_required";
  return "info";
}

function actionFor(classification, action, { workerRequired = false } = {}) {
  return {
    class: classification,
    requested_action: action,
    execution: "NOT_EXECUTED",
    worker_required: workerRequired,
    reason: classification === "SAFE_AUTOMATIC"
      ? "The action is eligible only through an existing verified lifecycle executor. This evaluator never calls a provider or changes source state."
      : classification === "REVIEW_REQUIRED"
        ? "Use the existing explicit lifecycle action after owner review of this exact evidence."
        : "No action is available until the blocking identity or evidence issue is resolved."
  };
}

function currentDesignHash(design = {}) {
  return text(design.design_state_hash || design.state_hash);
}

function environmentFor(inputs = {}, kind) {
  return array(inputs.environments).find(item => String(item?.kind || "").toLowerCase() === kind) || null;
}

function targetFor(inputs = {}, environment) {
  if (!environment?.id) return null;
  return array(inputs.targets).find(item => String(item?.environment_id || "") === String(environment.id)) || null;
}

function selectedDeployment(inputs = {}, kind, deploymentId = null) {
  const matching = sortedByTime(array(inputs.deployments).filter(item =>
    String(item?.environment || "").toLowerCase() === kind && (!deploymentId || item.id === deploymentId)
  ));
  return matching[0] || null;
}

function relevantObservation(inputs = {}, kind, deploymentId, cutoffMs) {
  const scoped = sortedByTime(array(inputs.observations).filter(item =>
    String(item?.environment || "").toLowerCase() === kind && (!deploymentId || item.deployment_id === deploymentId)
  ), "observed_at");
  const latest = scoped[0] || null;
  const afterCutoff = latest && Date.parse(latest.observed_at || "") > cutoffMs ? latest : null;
  const eligible = scoped.find(item => {
    const observedAt = Date.parse(item?.observed_at || "");
    return Number.isFinite(observedAt) && observedAt <= cutoffMs;
  }) || null;
  return { scoped, latest, afterCutoff, eligible };
}

function stateFromBlueprint(blueprint) {
  if (!blueprint?.state) return null;
  try {
    return normalizeApplicationState(blueprint.state);
  } catch {
    return null;
  }
}

function sourceApplicable(desired) {
  const code = object(desired?.desired_state?.code);
  return Boolean(code.workspace || code.repository_id || code.repository || code.branch || code.commit);
}

function sourceIssues(identity, applicationId) {
  const issues = [];
  if (normalizedText(identity.application_id) !== normalizedText(applicationId)) {
    issues.push({ field: "application_id", expected: applicationId || null, observed: identity.application_id || null });
  }
  for (const field of ["workspace_id", "branch", "checkpoint", "source_commit", "source_snapshot_sha256", "classifier_version"]) {
    if (!identity[field]) issues.push({ field, expected: "present", observed: null });
  }
  if (identity.source_snapshot_complete !== true) {
    issues.push({ field: "source_snapshot_complete", expected: true, observed: identity.source_snapshot_complete });
  }
  if (identity.checkpoint && identity.source_commit && !sameCommit(identity.checkpoint, identity.source_commit)) {
    issues.push({ field: "checkpoint", expected: identity.source_commit, observed: identity.checkpoint });
  }
  return issues;
}

function sourceMismatches(expected, observed) {
  const mismatches = [];
  for (const field of SOURCE_FIELDS) {
    if (!expected?.[field] || !observed?.[field]) continue;
    const equal = ["checkpoint", "source_commit", "source_snapshot_sha256"].includes(field)
      ? sameCommit(expected[field], observed[field])
      : normalizedText(expected[field]) === normalizedText(observed[field]);
    if (!equal) mismatches.push({ field, expected: expected[field], observed: observed[field] });
  }
  if (expected?.source_snapshot_complete !== undefined && observed?.source_snapshot_complete !== undefined &&
      expected.source_snapshot_complete !== observed.source_snapshot_complete) {
    mismatches.push({
      field: "source_snapshot_complete",
      expected: expected.source_snapshot_complete,
      observed: observed.source_snapshot_complete
    });
  }
  return mismatches;
}

function deploymentState(value) {
  const normalized = String(value || "unknown").toLowerCase();
  return KNOWN_DEPLOYMENT_STATES.has(normalized) ? normalized : "unknown";
}

function observationHash(observation) {
  if (!observation) return null;
  const supplied = String(observation.state_hash || "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(supplied) ? supplied : fingerprint({
    deployment_id: observation.deployment_id || null,
    environment: observation.environment || null,
    provider: observation.provider || null,
    provider_deployment_id: observation.provider_deployment_id || null,
    blueprint_id: observation.blueprint_id || null,
    blueprint_version: observation.blueprint_version ?? null,
    commit_sha: observation.commit_sha || null,
    artifact_digest: observation.artifact_digest || null,
    health: observation.health || null,
    observed_state: observation.observed_state || null
  });
}

function bindingsFrom({ application = {}, scope = {}, desiredBlueprint = null, desiredState = null, sourceIdentity = {}, design = {}, observation = null, target = null }) {
  return {
    application: {
      organization_id: normalizedText(application.organization_id),
      application_id: normalizedText(application.id || desiredState?.application?.id)
    },
    scope: {
      environment_id: normalizedText(scope.environment_id),
      environment_kind: normalizedText(scope.environment_kind),
      deployment_id: normalizedText(scope.deployment_id),
      repository_id: normalizedText(scope.repository_id),
      workspace_id: normalizedText(scope.workspace_id),
      branch: normalizedText(scope.branch)
    },
    desired_blueprint: {
      id: normalizedText(desiredBlueprint?.id || desiredState?.blueprint?.id),
      version: desiredBlueprint?.version ?? desiredState?.blueprint?.version ?? null,
      state_hash: normalizedText(desiredBlueprint?.state_hash || desiredState?.blueprint?.state_hash ||
        (desiredState ? applicationStateHash(desiredState) : null))
    },
    source_identity: normalizeSourceIdentity(sourceIdentity),
    environment_target: {
      id: normalizedText(target?.id),
      provider: normalizedText(target?.provider_key || target?.provider),
      resource_reference: normalizedText(target?.provider_resource_reference || target?.resource_reference)
    },
    design: {
      applicable: design?.applicable === true,
      state_hash: currentDesignHash(design),
      source_identity: design?.applicable === true ? normalizeSourceIdentity(design.source_identity || {}) : null
    },
    observation: observation ? {
      id: normalizedText(observation.id),
      state_hash: observationHash(observation),
      observed_at: timestamp(observation.observed_at),
      deployment_id: normalizedText(observation.deployment_id),
      blueprint_id: normalizedText(observation.blueprint_id),
      artifact_digest: normalizedText(observation.artifact_digest),
      commit_sha: normalizedCommit(observation.commit_sha)
    } : null
  };
}

export function reconciliationBindings(input = {}) {
  if (input?.bindings && typeof input.bindings === "object") return clone(input.bindings);
  return bindingsFrom(input);
}

export function createDay2ReconciliationManifest(input = {}) {
  const application = object(input.application);
  const desiredBlueprint = input.desiredBlueprint || null;
  const desiredState = input.desiredState || stateFromBlueprint(desiredBlueprint);
  const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity || input.source_identity || {});
  const requestedEnvironment = String(input.environment || input.scope?.environment_kind || "").toLowerCase();
  const environment = input.environmentRecord || environmentFor(input.inputs, requestedEnvironment);
  const target = input.target || targetFor(input.inputs, environment);
  const deployment = input.deployment || selectedDeployment(input.inputs, requestedEnvironment, input.deploymentId || input.scope?.deployment_id || null);
  const scope = {
    organization_id: normalizedText(application.organization_id),
    application_id: normalizedText(application.id || desiredState?.application?.id),
    environment_id: normalizedText(environment?.id || input.scope?.environment_id),
    environment_kind: ENVIRONMENTS.has(requestedEnvironment) ? requestedEnvironment : null,
    deployment_id: normalizedText(deployment?.id || input.deploymentId || input.scope?.deployment_id),
    repository_id: normalizedText(desiredState?.desired_state?.code?.repository_id),
    workspace_id: normalizedText(sourceIdentity.workspace_id || desiredState?.desired_state?.code?.workspace),
    branch: normalizedText(sourceIdentity.branch || desiredState?.desired_state?.code?.branch)
  };
  const asOf = timestamp(input.asOf || input.as_of, new Date().toISOString());
  const policyVersion = text(input.policyVersion || input.policy_version || DAY2_RECONCILIATION_POLICY_VERSION, 120);
  const evaluatorVersions = {
    application_state: APPLICATION_STATE_CONTRACT,
    reconciliation: DAY2_RECONCILIATION_EVALUATOR_VERSION,
    classifier: sourceIdentity.classifier_version || null,
    design: text(input.design?.evaluator_version || input.design?.contract || null, 160),
    infrastructure: text(input.infrastructure?.evaluator_version || null, 160)
  };
  const bindings = bindingsFrom({
    application,
    scope,
    desiredBlueprint,
    desiredState,
    sourceIdentity,
    design: input.design,
    observation: input.observation || null,
    target
  });
  const idempotencyKey = text(input.idempotencyKey || input.idempotency_key || null, 160);
  const identity = {
    contract: DAY2_RECONCILIATION_CONTRACT,
    scope,
    desired_blueprint: bindings.desired_blueprint,
    source_identity: bindings.source_identity,
    environment_target: bindings.environment_target,
    design: bindings.design,
    observation: bindings.observation,
    as_of: asOf,
    policy_version: policyVersion,
    evaluator_versions: evaluatorVersions,
    idempotency_key: idempotencyKey
  };
  const manifestHash = fingerprint(identity);
  return {
    contract: DAY2_RECONCILIATION_CONTRACT,
    run_id: `reconciliation-${manifestHash.slice(0, 32)}`,
    manifest_hash: manifestHash,
    scope,
    desired_blueprint: bindings.desired_blueprint,
    source_identity: bindings.source_identity,
    environment_target: bindings.environment_target,
    design_state_hash: bindings.design.state_hash,
    trigger: text(input.trigger || "manual", 80),
    actor_id: text(input.actorId || input.actor_id || null, 160),
    correlation_id: text(input.correlationId || input.correlation_id || null, 160),
    as_of: asOf,
    observation_cutoff: asOf,
    policy_version: policyVersion,
    evaluator_versions: evaluatorVersions,
    idempotency_key: idempotencyKey,
    bindings
  };
}

function createDrift({
  manifest,
  category,
  path,
  desired = null,
  observed = null,
  classification,
  reasonCode,
  reason,
  source = {},
  lineage = {},
  action,
  stale = false,
  confidence = "high"
}) {
  const safeDesired = safeValue(desired);
  const safeObserved = safeValue(observed);
  const scope = manifest.scope;
  const normalizedLineage = safeValue(lineage);
  const preconditions = {
    desired_hash: fingerprint(safeDesired),
    observed_hash: fingerprint(safeObserved),
    scope_hash: fingerprint(scope),
    lineage_hash: fingerprint(normalizedLineage),
    manifest_hash: manifest.manifest_hash
  };
  const driftFingerprint = fingerprint({
    contract: DAY2_RECONCILIATION_CONTRACT,
    category,
    path,
    desired_hash: preconditions.desired_hash,
    observed_hash: preconditions.observed_hash,
    scope,
    lineage: normalizedLineage,
    policy_version: manifest.policy_version
  });
  const status = actionStatus(classification, stale);
  return {
    drift_id: `drift-${driftFingerprint.slice(0, 32)}`,
    fingerprint: driftFingerprint,
    category,
    path,
    desired: safeDesired,
    observed: safeObserved,
    classification,
    severity: severity(classification),
    reason_code: reasonCode,
    reason: text(reason, 1200),
    confidence,
    scope: safeValue(scope),
    lineage: normalizedLineage,
    source: {
      observation_id: text(source.observation_id || null, 160),
      observation_hash: text(source.observation_hash || null, 160),
      delta_ids: [...new Set(array(source.delta_ids).map(value => text(value, 160)).filter(Boolean))].sort(),
      component_id: text(source.component_id || null, 160),
      source_path: text(source.source_path || null, 1024)
    },
    first_seen_at: manifest.as_of,
    last_seen_at: manifest.as_of,
    precondition_hashes: preconditions,
    policy_version: manifest.policy_version,
    action: actionFor(classification, action, { workerRequired: action === "REQUEST_OBSERVATION_REFRESH" }),
    status
  };
}

function addDrift(drifts, drift) {
  const existing = drifts.find(item => item.fingerprint === drift.fingerprint);
  if (!existing) {
    drifts.push(drift);
    return;
  }
  existing.source.delta_ids = [...new Set([...existing.source.delta_ids, ...drift.source.delta_ids])].sort();
}

function knownGoodDeployment(inputs, environmentKind, desiredBlueprintId) {
  return sortedByTime(array(inputs.deployments).filter(deployment =>
    String(deployment?.environment || "").toLowerCase() === environmentKind &&
    String(deployment?.status || "").toUpperCase() === "HEALTHY" &&
    (!desiredBlueprintId || deployment.blueprint_id === desiredBlueprintId)
  ))[0] || null;
}

function sameEnvironmentTarget(left = {}, right = {}) {
  return normalizedText(left?.id) === normalizedText(right?.id) &&
    normalizedText(left?.provider) === normalizedText(right?.provider) &&
    normalizedText(left?.resource_reference) === normalizedText(right?.resource_reference);
}

function bindingMismatches(stored, current) {
  const mismatches = [];
  const pairs = [
    ["application.organization_id", stored?.application?.organization_id, current?.application?.organization_id],
    ["application.application_id", stored?.application?.application_id, current?.application?.application_id],
    ["scope.environment_id", stored?.scope?.environment_id, current?.scope?.environment_id],
    ["scope.environment_kind", stored?.scope?.environment_kind, current?.scope?.environment_kind],
    ["scope.deployment_id", stored?.scope?.deployment_id, current?.scope?.deployment_id],
    ["scope.repository_id", stored?.scope?.repository_id, current?.scope?.repository_id],
    ["desired_blueprint.id", stored?.desired_blueprint?.id, current?.desired_blueprint?.id],
    ["desired_blueprint.version", stored?.desired_blueprint?.version, current?.desired_blueprint?.version],
    ["desired_blueprint.state_hash", stored?.desired_blueprint?.state_hash, current?.desired_blueprint?.state_hash],
    ["design.applicable", stored?.design?.applicable, current?.design?.applicable],
    ["design.state_hash", stored?.design?.state_hash, current?.design?.state_hash],
    ["observation.id", stored?.observation?.id, current?.observation?.id],
    ["observation.state_hash", stored?.observation?.state_hash, current?.observation?.state_hash],
    ["observation.observed_at", stored?.observation?.observed_at, current?.observation?.observed_at]
  ];
  for (const [field, expected, observed] of pairs) {
    if (!sameValue(expected, observed)) mismatches.push({ field, expected: safeValue(expected), observed: safeValue(observed) });
  }
  if (!sameEnvironmentTarget(stored?.environment_target, current?.environment_target)) {
    mismatches.push({ field: "environment_target", expected: safeValue(stored?.environment_target || null), observed: safeValue(current?.environment_target || null) });
  }
  for (const source of ["source_identity", "design.source_identity"]) {
    const expected = source === "source_identity" ? stored?.source_identity : stored?.design?.source_identity;
    const observed = source === "source_identity" ? current?.source_identity : current?.design?.source_identity;
    if (!expected && !observed) continue;
    for (const mismatch of sourceMismatches(normalizeSourceIdentity(expected || {}), normalizeSourceIdentity(observed || {}))) {
      mismatches.push({ field: `${source}.${mismatch.field}`, expected: safeValue(mismatch.expected), observed: safeValue(mismatch.observed) });
    }
  }
  return mismatches;
}

export function resolveStoredDay2Reconciliation(evaluation, current = {}) {
  if (!evaluation || evaluation.contract !== DAY2_RECONCILIATION_CONTRACT) {
    return {
      contract: DAY2_RECONCILIATION_CONTRACT,
      state: "BLOCKED",
      reconciliation_current: false,
      reason: "Run a source-bound Day-2 reconciliation before treating historical state as authoritative.",
      action_status: "blocked"
    };
  }
  const storedBindings = evaluation.bindings || evaluation.manifest?.bindings;
  if (!storedBindings) {
    return {
      ...clone(evaluation),
      state: "BLOCKED",
      reconciliation_current: false,
      reason: "The stored reconciliation has no source bindings and cannot be authoritative.",
      action_status: "blocked"
    };
  }
  const mismatches = bindingMismatches(storedBindings, reconciliationBindings(current));
  if (!mismatches.length) return clone(evaluation);
  const stale = clone(evaluation);
  stale.state = "STALE";
  stale.reconciliation_current = false;
  stale.action_status = "stale";
  stale.stale_reasons = mismatches;
  stale.summary = {
    ...(stale.summary || {}),
    state: "STALE",
    headline: "Reconciliation evidence is stale",
    stale_reason_count: mismatches.length
  };
  stale.events = [
    ...array(stale.events),
    {
      event_id: `stale-${fingerprint({ run_id: stale.run_id, mismatches }).slice(0, 32)}`,
      status: "stale",
      reason_code: "RECONCILIATION_BINDING_STALE",
      stale_reasons: mismatches,
      recorded_at: new Date().toISOString()
    }
  ];
  return stale;
}

export function evaluateDay2Reconciliation(input = {}) {
  const application = object(input.application);
  const inputs = object(input.inputs);
  const requestedEnvironment = String(input.environment || input.scope?.environment_kind || "").toLowerCase();
  const environment = input.environmentRecord || environmentFor(inputs, requestedEnvironment);
  const requestedDeploymentId = input.deploymentId || input.scope?.deployment_id || null;
  const deployment = input.deployment || selectedDeployment(inputs, requestedEnvironment, requestedDeploymentId);
  const desiredBlueprint = input.desiredBlueprint || null;
  const persistedDesired = input.desiredState || stateFromBlueprint(desiredBlueprint);
  const currentState = input.currentState || null;
  const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity || input.source_identity || {});
  const design = object(input.design);
  const target = input.target || targetFor(inputs, environment);
  const asOf = timestamp(input.asOf || input.as_of, new Date().toISOString());
  const cutoffMs = Date.parse(asOf);
  const observationSelection = Number.isFinite(cutoffMs)
    ? relevantObservation(inputs, requestedEnvironment, requestedDeploymentId || deployment?.id || null, cutoffMs)
    : { scoped: [], latest: null, afterCutoff: null, eligible: null };
  const observation = input.observation || observationSelection.eligible;
  const manifest = input.manifest || createDay2ReconciliationManifest({
    ...input,
    application,
    inputs,
    environment: requestedEnvironment,
    environmentRecord: environment,
    deployment,
    desiredBlueprint,
    desiredState: persistedDesired,
    sourceIdentity,
    design,
    target,
    observation,
    asOf
  });
  const freshWindow = Math.min(Math.max(Number(input.freshnessMs ?? input.freshness_ms ?? 15 * 60 * 1000), 60_000), 7 * 24 * 60 * 60 * 1000);
  const drifts = [];
  const appId = application.id || persistedDesired?.application?.id || null;
  const deltaIds = observation
    ? array(inputs.stateDeltas).filter(item => item?.observed_state_id === observation.id).map(item => item.id).filter(Boolean)
    : [];
  const source = { observation_id: observation?.id || null, observation_hash: observationHash(observation), delta_ids: deltaIds };

  const baseLineage = {
    application_id: appId,
    organization_id: application.organization_id || null,
    desired_blueprint_id: desiredBlueprint?.id || persistedDesired?.blueprint?.id || null,
    desired_blueprint_version: desiredBlueprint?.version ?? persistedDesired?.blueprint?.version ?? null,
    deployment_id: deployment?.id || null,
    observation_id: observation?.id || null
  };

  if (!appId || !application.organization_id || !ENVIRONMENTS.has(requestedEnvironment) || !environment?.id) {
    addDrift(drifts, createDrift({
      manifest,
      category: "scope",
      path: "scope",
      desired: { application_id: appId, organization_id: application.organization_id || null, environment: requestedEnvironment || null },
      observed: { application_id: manifest.scope.application_id, organization_id: manifest.scope.organization_id, environment_id: manifest.scope.environment_id },
      classification: "BLOCKED",
      reasonCode: "RECONCILIATION_SCOPE_INCOMPLETE",
      reason: "A Day-2 reconciliation requires an exact organization, application, and configured environment scope.",
      lineage: baseLineage,
      action: "ESTABLISH_EXACT_SCOPE"
    }));
  }

  if (desiredBlueprint?.app_id && desiredBlueprint.app_id !== appId) {
    addDrift(drifts, createDrift({
      manifest,
      category: "blueprint_lineage",
      path: "blueprint.application_id",
      desired: appId,
      observed: desiredBlueprint.app_id,
      classification: "BLOCKED",
      reasonCode: "BLUEPRINT_CROSS_SCOPE",
      reason: "The selected desired Blueprint is not owned by the scoped application.",
      lineage: baseLineage,
      action: "SELECT_IN_SCOPE_BLUEPRINT"
    }));
  }

  if (!desiredBlueprint || !persistedDesired) {
    addDrift(drifts, createDrift({
      manifest,
      category: "desired_state",
      path: "blueprint",
      desired: "An immutable persisted Blueprint",
      observed: desiredBlueprint ? "Malformed Blueprint state" : "No persisted Blueprint",
      classification: "REVIEW_REQUIRED",
      reasonCode: "DESIRED_BLUEPRINT_REQUIRED",
      reason: "Day-2 reconciliation cannot treat a draft or malformed desired state as an authoritative deployment target.",
      lineage: baseLineage,
      action: "PERSIST_OR_SELECT_DESIRED_BLUEPRINT"
    }));
  }

  if (desiredBlueprint && persistedDesired && currentState) {
    let currentHash = null;
    try { currentHash = applicationStateHash(currentState); } catch { currentHash = null; }
    const desiredHash = desiredBlueprint.state_hash || applicationStateHash(persistedDesired);
    if (!currentHash || currentHash !== desiredHash) {
      addDrift(drifts, createDrift({
        manifest,
        category: "desired_state",
        path: "desired_state",
        desired: { blueprint_id: desiredBlueprint.id, state_hash: desiredHash },
        observed: { state_hash: currentHash },
        classification: "REVIEW_REQUIRED",
        reasonCode: "DESIRED_STATE_UNPERSISTED",
        reason: "The current application draft differs from the latest immutable Blueprint. The evaluator will not reconcile deployment or source state against an unpersisted intention.",
        lineage: baseLineage,
        action: "REVIEW_AND_PERSIST_DESIRED_STATE"
      }));
    }
  }

  const protectedContractChanges = [
    ...array(input.protectedContractChanges),
    ...array(input.protected_contract_changes),
    ...array(input.migrationChanges),
    ...array(input.migration_changes)
  ];
  if (protectedContractChanges.length) {
    addDrift(drifts, createDrift({
      manifest,
      category: "source",
      path: "protected_contracts",
      desired: "No protected-contract, migration, secret, or RLS changes outside the approved lifecycle contract",
      observed: protectedContractChanges.map(change => safeValue(change)),
      classification: "BLOCKED",
      reasonCode: "PROTECTED_CONTRACT_CHANGE_BLOCKED",
      reason: "A protected contract or migration-related change is present. Day-2 reconciliation cannot weaken or bypass protected contracts, migrations, secrets, or RLS.",
      lineage: baseLineage,
      action: "USE_EXISTING_REVIEWED_CHANGESET"
    }));
  }

  if (observationSelection.afterCutoff) {
    addDrift(drifts, createDrift({
      manifest,
      category: "temporal",
      path: "observed_state.observed_at",
      desired: { cutoff: manifest.observation_cutoff },
      observed: { observation_id: observationSelection.afterCutoff.id, observed_at: observationSelection.afterCutoff.observed_at },
      classification: "BLOCKED",
      reasonCode: "OBSERVATION_AFTER_RUN_CUTOFF",
      reason: "A newer persisted observation exists after this run cutoff. The run is stale and cannot silently merge newer evidence.",
      source: { observation_id: observationSelection.afterCutoff.id, observation_hash: observationHash(observationSelection.afterCutoff) },
      lineage: baseLineage,
      action: "START_FRESH_RECONCILIATION_RUN",
      stale: true
    }));
  }

  if (!observation && !observationSelection.afterCutoff) {
    addDrift(drifts, createDrift({
      manifest,
      category: "temporal",
      path: "observed_state",
      desired: { environment: requestedEnvironment, persisted_observation: true },
      observed: null,
      classification: "BLOCKED",
      reasonCode: "OBSERVATION_MISSING",
      reason: "No persisted in-scope observation is available for this cutoff. The evaluator does not query a provider or guess runtime state.",
      lineage: baseLineage,
      action: "REQUEST_OBSERVATION_REFRESH"
    }));
  }

  const observedAtMs = Date.parse(observation?.observed_at || "");
  if (observation && !Number.isFinite(observedAtMs)) {
    addDrift(drifts, createDrift({
      manifest,
      category: "temporal",
      path: "observed_state.observed_at",
      desired: "A valid persisted observation timestamp",
      observed: observation?.observed_at || null,
      classification: "BLOCKED",
      reasonCode: "OBSERVATION_TIMESTAMP_INVALID",
      reason: "The persisted observation has no valid timestamp and cannot be used as reconciliation evidence.",
      source,
      lineage: baseLineage,
      action: "RECORD_VALID_OBSERVATION"
    }));
  } else if (observation && Number.isFinite(observedAtMs) && cutoffMs - observedAtMs > freshWindow) {
    addDrift(drifts, createDrift({
      manifest,
      category: "temporal",
      path: "observed_state.freshness",
      desired: { maximum_age_ms: freshWindow, cutoff: manifest.observation_cutoff },
      observed: { observed_at: observation.observed_at, age_ms: cutoffMs - observedAtMs },
      classification: "BLOCKED",
      reasonCode: "OBSERVATION_STALE",
      reason: "The persisted observation is older than the declared freshness window and cannot authorize reconciliation.",
      source,
      lineage: baseLineage,
      action: "REQUEST_OBSERVATION_REFRESH",
      stale: true
    }));
  }

  const temporalStale = drifts.some(item => item.category === "temporal" && item.status === "stale");
  const canCompareObserved = Boolean(observation) && !temporalStale && !drifts.some(item =>
    item.category === "scope" || item.reason_code === "DESIRED_BLUEPRINT_REQUIRED"
  );

  if (sourceApplicable(persistedDesired)) {
    const sourceContext = object(input.sourceContext || input.source_context);
    const identityIssues = sourceIssues(sourceIdentity, appId);
    if (sourceContext.available === false || identityIssues.length) {
      addDrift(drifts, createDrift({
        manifest,
        category: "source",
        path: "source.identity",
        desired: { application_id: appId, complete_identity: true },
        observed: { identity: sourceIdentity, issues: identityIssues, context_available: sourceContext.available !== false },
        classification: "BLOCKED",
        reasonCode: sourceContext.available === false ? "SOURCE_CONTEXT_UNAVAILABLE" : "SOURCE_IDENTITY_INCOMPLETE",
        reason: "Source reconciliation requires a complete, current application/workspace/branch/checkpoint/snapshot/classifier identity.",
        lineage: { ...baseLineage, source_commit: persistedDesired?.desired_state?.code?.commit || null },
        action: "REESTABLISH_SOURCE_IDENTITY"
      }));
    }
    if (sourceContext.source_clean === false || sourceIdentity.source_clean === false) {
      addDrift(drifts, createDrift({
        manifest,
        category: "source",
        path: "source.workspace.clean",
        desired: true,
        observed: false,
        classification: "BLOCKED",
        reasonCode: "SOURCE_WORKSPACE_DIRTY",
        reason: "A dirty workspace cannot be reconciled automatically or used to authorize a source/deployment correction.",
        lineage: { ...baseLineage, source_commit: sourceIdentity.source_commit },
        action: "CHECKPOINT_OR_DISCARD_NO_CHANGES"
      }));
    }
    if (sourceContext.classification_current === false || sourceContext.classification_stale === true) {
      addDrift(drifts, createDrift({
        manifest,
        category: "source",
        path: "source.classification",
        desired: "Current repository classification",
        observed: "Stale or unavailable classification",
        classification: "BLOCKED",
        reasonCode: "SOURCE_CLASSIFICATION_STALE",
        reason: "Repository classification must be current before source reconciliation can be considered.",
        lineage: { ...baseLineage, source_commit: sourceIdentity.source_commit },
        action: "RECLASSIFY_SOURCE"
      }));
    }
    const desiredCode = object(persistedDesired?.desired_state?.code);
    if (desiredCode.branch && sourceIdentity.branch && desiredCode.branch !== sourceIdentity.branch) {
      addDrift(drifts, createDrift({
        manifest,
        category: "source",
        path: "source.branch",
        desired: desiredCode.branch,
        observed: sourceIdentity.branch,
        classification: "BLOCKED",
        reasonCode: "SOURCE_BRANCH_MISMATCH",
        reason: "The current source branch differs from the Blueprint-bound branch, so H cannot choose a source target automatically.",
        lineage: { ...baseLineage, desired_commit: desiredCode.commit || null, observed_commit: sourceIdentity.source_commit || null },
        action: "REESTABLISH_BLUEPRINT_SOURCE_BINDING"
      }));
    }
    if (desiredCode.commit && sourceIdentity.source_commit && !sameCommit(desiredCode.commit, sourceIdentity.source_commit)) {
      addDrift(drifts, createDrift({
        manifest,
        category: "source",
        path: "source.checkpoint",
        desired: desiredCode.commit,
        observed: sourceIdentity.source_commit,
        classification: "REVIEW_REQUIRED",
        reasonCode: "SOURCE_CHECKPOINT_MISMATCH",
        reason: "The workspace checkpoint differs from the desired Blueprint commit. H can record the exact mismatch but cannot change source automatically.",
        lineage: { ...baseLineage, desired_commit: desiredCode.commit, observed_commit: sourceIdentity.source_commit },
        action: "REVIEW_SOURCE_CHANGESET_OR_BLUEPRINT"
      }));
    }
    if (sourceIdentity.source_commit && !array(inputs.codeCheckpoints).some(checkpoint => sameCommit(checkpoint?.git_commit, sourceIdentity.source_commit))) {
      addDrift(drifts, createDrift({
        manifest,
        category: "source",
        path: "source.checkpoint.record",
        desired: sourceIdentity.source_commit,
        observed: "No exact CODE checkpoint record",
        classification: "BLOCKED",
        reasonCode: "SOURCE_CHECKPOINT_MISSING",
        reason: "The current source commit is not recorded as a CODE checkpoint for this application.",
        lineage: { ...baseLineage, source_commit: sourceIdentity.source_commit },
        action: "CREATE_EXPLICIT_CODE_CHECKPOINT"
      }));
    }
  }

  if (canCompareObserved && persistedDesired) {
    if (observation.app_id && observation.app_id !== appId || observation.organization_id && observation.organization_id !== application.organization_id) {
      addDrift(drifts, createDrift({
        manifest,
        category: "blueprint_lineage",
        path: "observed_state.scope",
        desired: { application_id: appId, organization_id: application.organization_id || null },
        observed: { application_id: observation.app_id || null, organization_id: observation.organization_id || null },
        classification: "BLOCKED",
        reasonCode: "OBSERVATION_CROSS_SCOPE",
        reason: "The observed state is not scoped to this application and organization.",
        source,
        lineage: baseLineage,
        action: "RECORD_IN_SCOPE_OBSERVATION"
      }));
    }

    if (!observation.blueprint_id || observation.blueprint_version === null || observation.blueprint_version === undefined) {
      addDrift(drifts, createDrift({
        manifest,
        category: "blueprint_lineage",
        path: "observed_state.blueprint",
        desired: { id: desiredBlueprint?.id || persistedDesired.blueprint.id, version: desiredBlueprint?.version ?? persistedDesired.blueprint.version },
        observed: { id: observation.blueprint_id || null, version: observation.blueprint_version ?? null },
        classification: "BLOCKED",
        reasonCode: "OBSERVED_BLUEPRINT_LINEAGE_MISSING",
        reason: "The observed deployment lacks a complete Blueprint identity.",
        source,
        lineage: baseLineage,
        action: "RECORD_COMPLETE_OBSERVATION"
      }));
    } else {
      const observedBlueprint = array(inputs.blueprints).find(item => item.id === observation.blueprint_id) || null;
      if (!observedBlueprint || observedBlueprint.app_id && observedBlueprint.app_id !== appId) {
        addDrift(drifts, createDrift({
          manifest,
          category: "blueprint_lineage",
          path: "observed_state.blueprint_id",
          desired: desiredBlueprint?.id || persistedDesired.blueprint.id,
          observed: observation.blueprint_id,
          classification: "BLOCKED",
          reasonCode: "OBSERVED_BLUEPRINT_CROSS_SCOPE_OR_UNKNOWN",
          reason: "The observation references a Blueprint that is unknown or outside the scoped application.",
          source,
          lineage: baseLineage,
          action: "RECORD_IN_SCOPE_BLUEPRINT_LINEAGE"
        }));
      } else if (Number(observedBlueprint.version) !== Number(observation.blueprint_version)) {
        addDrift(drifts, createDrift({
          manifest,
          category: "blueprint_lineage",
          path: "observed_state.blueprint_version",
          desired: observedBlueprint.version,
          observed: observation.blueprint_version,
          classification: "BLOCKED",
          reasonCode: "OBSERVED_BLUEPRINT_VERSION_AMBIGUOUS",
          reason: "The observed Blueprint ID and version do not agree with immutable Blueprint history.",
          source,
          lineage: baseLineage,
          action: "RECORD_COMPLETE_OBSERVATION"
        }));
      } else if (observation.blueprint_id !== (desiredBlueprint?.id || persistedDesired.blueprint.id)) {
        addDrift(drifts, createDrift({
          manifest,
          category: "blueprint_lineage",
          path: "observed_state.blueprint_id",
          desired: { id: desiredBlueprint?.id || persistedDesired.blueprint.id, version: desiredBlueprint?.version ?? persistedDesired.blueprint.version },
          observed: { id: observation.blueprint_id, version: observation.blueprint_version },
          classification: "REVIEW_REQUIRED",
          reasonCode: "BLUEPRINT_VERSION_MISMATCH",
          reason: "The observed deployment runs an exact historical Blueprint in this application. Selecting a desired version or rollback requires explicit review.",
          source,
          lineage: baseLineage,
          action: "REVIEW_EXISTING_DEPLOYMENT_OR_ROLLBACK"
        }));
      }
    }

    const desiredCommit = persistedDesired.desired_state?.code?.commit || desiredBlueprint?.source_commit || null;
    if (desiredCommit && !observation.commit_sha) {
      addDrift(drifts, createDrift({
        manifest,
        category: "source",
        path: "observed_state.commit_sha",
        desired: desiredCommit,
        observed: null,
        classification: "BLOCKED",
        reasonCode: "OBSERVED_SOURCE_COMMIT_MISSING",
        reason: "The observed deployment has no commit identity, so source lineage cannot be reconciled safely.",
        source,
        lineage: { ...baseLineage, desired_commit: desiredCommit },
        action: "RECORD_COMPLETE_OBSERVATION"
      }));
    } else if (desiredCommit && observation.commit_sha && !sameCommit(desiredCommit, observation.commit_sha)) {
      const safeMismatch = hasFullCommit(desiredCommit) && hasFullCommit(observation.commit_sha);
      addDrift(drifts, createDrift({
        manifest,
        category: "source",
        path: "observed_state.commit_sha",
        desired: desiredCommit,
        observed: observation.commit_sha,
        classification: safeMismatch ? "REVIEW_REQUIRED" : "BLOCKED",
        reasonCode: safeMismatch ? "OBSERVED_SOURCE_COMMIT_MISMATCH" : "OBSERVED_SOURCE_COMMIT_AMBIGUOUS",
        reason: safeMismatch
          ? "The observed deployment commit differs from the Blueprint commit. H records the exact mismatch but cannot overwrite or roll back source automatically."
          : "The observed source identity is not a complete immutable commit.",
        source,
        lineage: { ...baseLineage, desired_commit: desiredCommit, observed_commit: observation.commit_sha },
        action: safeMismatch ? "REVIEW_SOURCE_OR_DEPLOYMENT_LINEAGE" : "RECORD_COMPLETE_OBSERVATION"
      }));
    }

    const scopedArtifacts = sortedByTime(array(inputs.artifacts).filter(item => item?.blueprint_id === (desiredBlueprint?.id || persistedDesired.blueprint.id)));
    const verifiedArtifact = scopedArtifacts.find(item => String(item?.verification_status || "").toLowerCase() === "passed" && IMMUTABLE_DIGEST.test(String(item?.artifact_digest || ""))) || null;
    const artifactRelevant = Boolean(observation.artifact_digest || deployment?.artifact_id || scopedArtifacts.length);
    if (verifiedArtifact && (verifiedArtifact.app_id && verifiedArtifact.app_id !== appId ||
        verifiedArtifact.organization_id && verifiedArtifact.organization_id !== application.organization_id)) {
      addDrift(drifts, createDrift({
        manifest,
        category: "artifact",
        path: "artifact.scope",
        desired: { application_id: appId, organization_id: application.organization_id || null },
        observed: { application_id: verifiedArtifact.app_id || null, organization_id: verifiedArtifact.organization_id || null },
        classification: "BLOCKED",
        reasonCode: "ARTIFACT_CROSS_SCOPE",
        reason: "The selected artifact is not owned by the exact application and organization scope.",
        source,
        lineage: baseLineage,
        action: "SELECT_IN_SCOPE_VERIFIED_ARTIFACT"
      }));
    } else if (artifactRelevant && !verifiedArtifact) {
      addDrift(drifts, createDrift({
        manifest,
        category: "artifact",
        path: "artifact.verification",
        desired: { blueprint_id: desiredBlueprint?.id || persistedDesired.blueprint.id, verified_artifact: true },
        observed: { artifact_digest: observation.artifact_digest || null },
        classification: "BLOCKED",
        reasonCode: "VERIFIED_ARTIFACT_MISSING",
        reason: "No verified immutable artifact is available for the desired Blueprint.",
        source,
        lineage: baseLineage,
        action: "SELECT_OR_BUILD_VERIFIED_ARTIFACT"
      }));
    } else if (verifiedArtifact && (!observation.artifact_digest || !IMMUTABLE_DIGEST.test(String(observation.artifact_digest)))) {
      addDrift(drifts, createDrift({
        manifest,
        category: "artifact",
        path: "observed_state.artifact_digest",
        desired: verifiedArtifact.artifact_digest,
        observed: observation.artifact_digest || null,
        classification: "BLOCKED",
        reasonCode: "OBSERVED_ARTIFACT_DIGEST_INVALID",
        reason: "The observed deployment does not identify an immutable artifact digest.",
        source,
        lineage: { ...baseLineage, artifact_id: verifiedArtifact.id, artifact_digest: verifiedArtifact.artifact_digest },
        action: "RECORD_COMPLETE_OBSERVATION"
      }));
    } else if (verifiedArtifact && observation.artifact_digest !== verifiedArtifact.artifact_digest) {
      addDrift(drifts, createDrift({
        manifest,
        category: "artifact",
        path: "observed_state.artifact_digest",
        desired: verifiedArtifact.artifact_digest,
        observed: observation.artifact_digest,
        classification: "REVIEW_REQUIRED",
        reasonCode: "ARTIFACT_DIGEST_MISMATCH",
        reason: "A verified in-scope artifact exists, but the observed deployment uses another immutable digest. Selecting a known-good artifact requires explicit review.",
        source,
        lineage: { ...baseLineage, artifact_id: verifiedArtifact.id, artifact_digest: verifiedArtifact.artifact_digest },
        action: "REVIEW_EXISTING_ARTIFACT_ROLLBACK"
      }));
    }

    if (!target || !target.provider_key || !target.provider_resource_reference) {
      addDrift(drifts, createDrift({
        manifest,
        category: "environment",
        path: "environment.target",
        desired: { environment_id: environment?.id || null, active_target: true },
        observed: target ? { id: target.id, provider: target.provider_key || null, resource_reference: target.provider_resource_reference || null } : null,
        classification: "BLOCKED",
        reasonCode: "ENVIRONMENT_TARGET_UNVERIFIED",
        reason: "The scoped environment has no complete active target identity. H cannot infer a provider or resource reference.",
        source,
        lineage: baseLineage,
        action: "VERIFY_EXISTING_ENVIRONMENT_TARGET"
      }));
    } else if (!observation.provider) {
      addDrift(drifts, createDrift({
        manifest,
        category: "environment",
        path: "observed_state.provider",
        desired: target.provider_key,
        observed: null,
        classification: "BLOCKED",
        reasonCode: "OBSERVED_PROVIDER_MISSING",
        reason: "The persisted observation does not identify its provider, so target scope cannot be proven.",
        source,
        lineage: baseLineage,
        action: "RECORD_COMPLETE_OBSERVATION"
      }));
    } else if (observation.provider !== target.provider_key) {
      addDrift(drifts, createDrift({
        manifest,
        category: "environment",
        path: "observed_state.provider",
        desired: target.provider_key,
        observed: observation.provider,
        classification: "REVIEW_REQUIRED",
        reasonCode: "ENVIRONMENT_PROVIDER_MISMATCH",
        reason: "The observation is associated with a different provider than the desired environment target. A target change requires explicit review.",
        source,
        lineage: baseLineage,
        action: "REVIEW_ENVIRONMENT_TARGET_CHANGE"
      }));
    }

    if (!deployment || !deployment.id) {
      addDrift(drifts, createDrift({
        manifest,
        category: "deployment_state",
        path: "deployment",
        desired: { environment: requestedEnvironment, deployment_record: true },
        observed: null,
        classification: "BLOCKED",
        reasonCode: "DEPLOYMENT_RECORD_MISSING",
        reason: "The persisted observation has no matching scoped deployment record.",
        source,
        lineage: baseLineage,
        action: "RECORD_IN_SCOPE_DEPLOYMENT"
      }));
    } else {
      const storedStatus = deploymentState(deployment.status);
      const providerStatus = deploymentState(observation?.observed_state?.deployment_state || observation?.observed_state?.status || null);
      if (storedStatus === "unknown") {
        addDrift(drifts, createDrift({
          manifest,
          category: "deployment_state",
          path: "deployment.status",
          desired: "Known deployment status",
          observed: deployment.status || null,
          classification: "BLOCKED",
          reasonCode: "DEPLOYMENT_STATUS_AMBIGUOUS",
          reason: "The deployment record has an unknown status and cannot be reconciled without a fresh scoped observation.",
          source,
          lineage: { ...baseLineage, deployment_id: deployment.id },
          action: "REQUEST_OBSERVATION_REFRESH"
        }));
      } else if (providerStatus !== "unknown" && providerStatus !== storedStatus) {
        const infrastructure = object(input.infrastructure);
        const terminal = TERMINAL_UNHEALTHY.has(storedStatus) || TERMINAL_UNHEALTHY.has(providerStatus);
        const classification = terminal ? "REVIEW_REQUIRED" : infrastructure.worker_verified === true ? "SAFE_AUTOMATIC" : "BLOCKED";
        addDrift(drifts, createDrift({
          manifest,
          category: "deployment_state",
          path: "deployment.status",
          desired: storedStatus,
          observed: providerStatus,
          classification,
          reasonCode: terminal ? "DEPLOYMENT_TERMINAL_STATE_MISMATCH" : classification === "SAFE_AUTOMATIC" ? "DEPLOYMENT_OBSERVATION_REFRESH_AVAILABLE" : "DEPLOYMENT_WORKER_UNVERIFIED",
          reason: terminal
            ? "Terminal deployment state differs from persisted provider evidence and requires recovery review."
            : classification === "SAFE_AUTOMATIC"
              ? "A verified existing worker may refresh observation evidence; this evaluator does not execute that request."
              : "Deployment state differs, but no verified existing observation worker is available to refresh factual evidence.",
          source,
          lineage: { ...baseLineage, deployment_id: deployment.id },
          action: classification === "SAFE_AUTOMATIC" ? "REQUEST_OBSERVATION_REFRESH" : "REVIEW_DEPLOYMENT_STATE"
        }));
      }
    }

    const health = String(observation.health || "unknown").toLowerCase();
    if (!HEALTHY.has(health)) {
      const probeScopeKnown = observation?.observed_state?.probe_scope_valid !== false;
      const healthyDeployment = knownGoodDeployment(inputs, requestedEnvironment, desiredBlueprint?.id || persistedDesired.blueprint.id);
      const classification = probeScopeKnown && (TERMINAL_UNHEALTHY.has(health) || health === "pending") ? "REVIEW_REQUIRED" : "BLOCKED";
      addDrift(drifts, createDrift({
        manifest,
        category: "runtime_health",
        path: "observed_state.health",
        desired: "healthy",
        observed: health,
        classification,
        reasonCode: classification === "BLOCKED" ? "RUNTIME_HEALTH_EVIDENCE_UNCERTAIN" : "RUNTIME_HEALTH_NOT_READY",
        reason: classification === "BLOCKED"
          ? "Runtime-health evidence is missing, unknown, or has an uncertain probe scope. H cannot infer a healthy runtime."
          : "Persisted runtime health is not ready. A known-good rollback or bounded redeploy requires explicit review and a fresh post-action observation.",
        source,
        lineage: { ...baseLineage, known_good_deployment_id: healthyDeployment?.id || null },
        action: classification === "BLOCKED" ? "RECORD_SCOPED_HEALTH_EVIDENCE" : "REVIEW_RUNTIME_RECOVERY"
      }));
    }

    const modelCount = array(persistedDesired?.desired_state?.data?.models).length;
    const requiredConfiguration = array(input.configuration?.required).length > 0;
    const observedState = object(observation.observed_state);
    const schemaState = String(observedState.schema_state?.status || observedState.schema_status || "").toLowerCase();
    const configurationState = String(observedState.configuration_state?.status || observedState.configuration_status || "").toLowerCase();
    if (modelCount > 0 && !["current", "verified", "healthy"].includes(schemaState)) {
      addDrift(drifts, createDrift({
        manifest,
        category: "schema_configuration",
        path: "observed_state.schema_state",
        desired: { models: modelCount, scoped_schema_evidence: "current" },
        observed: schemaState || null,
        classification: "BLOCKED",
        reasonCode: "SCHEMA_EVIDENCE_UNAVAILABLE",
        reason: "The application has persisted data models but no scoped schema-state evidence. H must not infer schema parity from deployment health or Blueprint metadata.",
        source,
        lineage: baseLineage,
        action: "COLLECT_SCOPED_SCHEMA_EVIDENCE"
      }));
    }
    if (requiredConfiguration && !["current", "verified", "healthy"].includes(configurationState)) {
      addDrift(drifts, createDrift({
        manifest,
        category: "schema_configuration",
        path: "observed_state.configuration_state",
        desired: "Scoped required-configuration evidence by name only",
        observed: configurationState || null,
        classification: "BLOCKED",
        reasonCode: "CONFIGURATION_EVIDENCE_UNAVAILABLE",
        reason: "Required runtime configuration has no scoped persisted evidence. H never exposes or requests secret values.",
        source,
        lineage: baseLineage,
        action: "COLLECT_SCOPED_CONFIGURATION_EVIDENCE"
      }));
    }

    if (String(input.requestedAction || input.requested_action || "").toUpperCase() === "ROLLBACK") {
      const knownGood = knownGoodDeployment(inputs, requestedEnvironment, desiredBlueprint?.id || persistedDesired.blueprint.id);
      const knownGoodArtifact = knownGood && array(inputs.artifacts).find(item => item.id === knownGood.artifact_id) || null;
      const rollbackSafe = knownGood && knownGoodArtifact &&
        String(knownGoodArtifact.verification_status || "").toLowerCase() === "passed" &&
        IMMUTABLE_DIGEST.test(String(knownGoodArtifact.artifact_digest || "")) &&
        knownGood.artifact_digest === knownGoodArtifact.artifact_digest &&
        (!knownGoodArtifact.app_id || knownGoodArtifact.app_id === appId) &&
        (!knownGoodArtifact.organization_id || knownGoodArtifact.organization_id === application.organization_id);
      if (!rollbackSafe) {
        addDrift(drifts, createDrift({
          manifest,
          category: "deployment_state",
          path: "rollback.target",
          desired: "A prior same-scope healthy deployment with a verified immutable artifact",
          observed: knownGood ? { deployment_id: knownGood.id, artifact_id: knownGood.artifact_id || null, artifact_digest: knownGoodArtifact?.artifact_digest || null } : null,
          classification: "BLOCKED",
          reasonCode: "ROLLBACK_TARGET_UNSAFE",
          reason: "Rollback is blocked without an exact same-scope healthy deployment and a verified immutable artifact digest.",
          source,
          lineage: baseLineage,
          action: "SELECT_VERIFIED_KNOWN_GOOD_TARGET"
        }));
      }
    }
  }

  if (design.applicable === true) {
    if (design.available === false) {
      addDrift(drifts, createDrift({
        manifest,
        category: "design",
        path: "design_state",
        desired: "Current Design Studio evidence",
        observed: "Unavailable",
        classification: "BLOCKED",
        reasonCode: "DESIGN_EVIDENCE_UNAVAILABLE",
        reason: "Design Studio evidence could not be loaded for this source-bound run.",
        lineage: baseLineage,
        action: "RELOAD_DESIGN_EVIDENCE"
      }));
    }
    const designSourceMismatches = sourceMismatches(sourceIdentity, normalizeSourceIdentity(design.source_identity || {}));
    if (designSourceMismatches.length) {
      addDrift(drifts, createDrift({
        manifest,
        category: "design",
        path: "design_state.source_identity",
        desired: sourceIdentity,
        observed: design.source_identity || null,
        classification: "BLOCKED",
        reasonCode: "DESIGN_SOURCE_IDENTITY_STALE",
        reason: "The Design State is not bound to the same source identity as this reconciliation run.",
        lineage: baseLineage,
        action: "RECONCILE_DESIGN_AT_CURRENT_SOURCE"
      }));
    }
    const stylesheetConflict = design.conflict === true || Number(design.sync_summary?.stylesheet_reconciliation_required || 0) > 0;
    if (stylesheetConflict) {
      addDrift(drifts, createDrift({
        manifest,
        category: "design",
        path: "src/feltus-design.css",
        desired: "Managed stylesheet matching the reviewed Design State",
        observed: "Managed stylesheet reconciliation required",
        classification: "BLOCKED",
        reasonCode: "DESIGN_STYLESHEET_CONFLICT",
        reason: "A managed Design Studio stylesheet conflict cannot be reconciled automatically.",
        lineage: baseLineage,
        action: "REVIEW_MANAGED_STYLESHEET"
      }));
    }
    const decisionsByComponent = new Map(array(design.reconciliation).map(item => [item?.component_id, item]));
    for (const component of [...array(design.components)].sort((left, right) => String(left?.id || "").localeCompare(String(right?.id || "")))) {
      const decision = decisionsByComponent.get(component.id) || null;
      const componentSource = { ...source, component_id: component.id, source_path: component.source_path || null };
      const reconciliationRequired = component.reconciliation_state === "REQUIRED" || component.sync_state === "RECONCILIATION_REQUIRED";
      const conflict = component.sync_state === "CONFLICT";
      if (conflict) {
        addDrift(drifts, createDrift({
          manifest,
          category: "design",
          path: `components.${component.id}`,
          desired: { ownership: component.ownership_state, sync_state: "SYNCED" },
          observed: { ownership: component.ownership_state, sync_state: component.sync_state },
          classification: "BLOCKED",
          reasonCode: "DESIGN_COMPONENT_CONFLICT",
          reason: "The component has a Design Studio conflict and must remain component-scoped until reviewed.",
          source: componentSource,
          lineage: baseLineage,
          action: "REVIEW_COMPONENT_CONFLICT"
        }));
        continue;
      }
      if (reconciliationRequired) {
        const automatic = component.ownership_state === "FELTUS_MANAGED" && decision?.outcome === "AUTOMATIC_RECONCILIATION";
        addDrift(drifts, createDrift({
          manifest,
          category: "design",
          path: `components.${component.id}`,
          desired: { ownership: component.ownership_state, reconciliation_state: "NOT_REQUIRED", sync_state: "SYNCED" },
          observed: { ownership: component.ownership_state, reconciliation_state: component.reconciliation_state, sync_state: component.sync_state, decision: decision?.outcome || null },
          classification: automatic ? "SAFE_AUTOMATIC" : "REVIEW_REQUIRED",
          reasonCode: automatic ? "DESIGN_COMPONENT_SAFE_RECONCILIATION_AVAILABLE" : "DESIGN_COMPONENT_RECONCILIATION_REQUIRED",
          reason: automatic
            ? "A stable FELTUS Managed component has a deterministic F.5 reconciliation decision. The evaluator records it but does not apply source or Design State changes."
            : "This component requires an explicit Design Studio review. Developer Managed ownership remains preserved and is never used as a whole-application failure.",
          source: componentSource,
          lineage: baseLineage,
          action: automatic ? "RECONCILE_MANAGED_COMPONENT" : "REVIEW_COMPONENT_RECONCILIATION"
        }));
      } else if (["VALIDATING", "CODE_CHANGED", "CANVAS_CHANGED"].includes(component.sync_state)) {
        addDrift(drifts, createDrift({
          manifest,
          category: "design",
          path: `components.${component.id}`,
          desired: "SYNCED",
          observed: component.sync_state,
          classification: "REVIEW_REQUIRED",
          reasonCode: "DESIGN_COMPONENT_VALIDATION_OR_CHANGE_PENDING",
          reason: "The component has pending Design Studio validation or a source/canvas change that must remain component-scoped.",
          source: componentSource,
          lineage: baseLineage,
          action: "REVIEW_COMPONENT_RECONCILIATION"
        }));
      }
    }
  }

  const orderedDrifts = drifts.sort((left, right) =>
    left.category.localeCompare(right.category) || left.path.localeCompare(right.path) || left.fingerprint.localeCompare(right.fingerprint)
  );
  const stale = orderedDrifts.some(item => item.status === "stale");
  const blocked = orderedDrifts.some(item => item.classification === "BLOCKED");
  const reviewRequired = orderedDrifts.some(item => item.classification === "REVIEW_REQUIRED");
  const state = stale ? "STALE" : blocked ? "BLOCKED" : reviewRequired ? "REVIEW_REQUIRED" : "CURRENT";
  const summary = {
    state,
    headline: state === "CURRENT"
      ? "Observed state matches the selected desired state"
      : state === "STALE"
        ? "Reconciliation evidence is stale"
        : state === "BLOCKED"
          ? `${orderedDrifts.filter(item => item.classification === "BLOCKED").length} reconciliation issue${orderedDrifts.filter(item => item.classification === "BLOCKED").length === 1 ? "" : "s"} blocked`
          : `${orderedDrifts.filter(item => item.classification === "REVIEW_REQUIRED").length} reconciliation item${orderedDrifts.filter(item => item.classification === "REVIEW_REQUIRED").length === 1 ? "" : "s"} need review`,
    drift_count: orderedDrifts.length,
    safe_automatic_count: orderedDrifts.filter(item => item.classification === "SAFE_AUTOMATIC").length,
    review_required_count: orderedDrifts.filter(item => item.classification === "REVIEW_REQUIRED").length,
    blocking_count: orderedDrifts.filter(item => item.classification === "BLOCKED").length,
    stale_count: orderedDrifts.filter(item => item.status === "stale").length
  };
  const actionStatusValue = state === "CURRENT" ? "verified" : state === "STALE" ? "stale" : state === "BLOCKED" ? "blocked" : "review_required";
  const bindings = bindingsFrom({
    application,
    scope: manifest.scope,
    desiredBlueprint,
    desiredState: persistedDesired,
    sourceIdentity,
    design,
    observation,
    target
  });
  return {
    contract: DAY2_RECONCILIATION_CONTRACT,
    evaluator_version: DAY2_RECONCILIATION_EVALUATOR_VERSION,
    run_id: manifest.run_id,
    manifest,
    bindings,
    state,
    reconciliation_current: state === "CURRENT" && orderedDrifts.length === 0,
    action_status: actionStatusValue,
    summary,
    desired_snapshot: {
      application_id: appId,
      blueprint_id: desiredBlueprint?.id || persistedDesired?.blueprint?.id || null,
      blueprint_version: desiredBlueprint?.version ?? persistedDesired?.blueprint?.version ?? null,
      state_hash: desiredBlueprint?.state_hash || (persistedDesired ? applicationStateHash(persistedDesired) : null),
      source_commit: persistedDesired?.desired_state?.code?.commit || desiredBlueprint?.source_commit || null,
      design_state_hash: currentDesignHash(design)
    },
    observed_snapshot: observation ? {
      observation_id: observation.id || null,
      observation_hash: observationHash(observation),
      observed_at: timestamp(observation.observed_at),
      deployment_id: observation.deployment_id || null,
      provider: observation.provider || null,
      blueprint_id: observation.blueprint_id || null,
      blueprint_version: observation.blueprint_version ?? null,
      commit_sha: observation.commit_sha || null,
      artifact_digest: observation.artifact_digest || null,
      health: observation.health || null,
      delta_ids: deltaIds
    } : null,
    drifts: orderedDrifts,
    events: orderedDrifts.map(drift => ({
      event_id: `event-${fingerprint({ run_id: manifest.run_id, drift: drift.fingerprint, status: drift.status }).slice(0, 32)}`,
      run_id: manifest.run_id,
      status: drift.status,
      category: drift.category,
      path: drift.path,
      fingerprint: drift.fingerprint,
      classification: drift.classification,
      precondition_hashes: drift.precondition_hashes,
      source: drift.source,
      actor_id: manifest.actor_id,
      correlation_id: manifest.correlation_id,
      post_verification: { status: "not_executed", evidence_ids: [] },
      recorded_at: manifest.as_of
    })),
    verification: {
      status: state === "CURRENT" ? "verified" : "not_executed",
      evidence_scope: "persisted application, Blueprint, CODE, Design Studio, and observed-state records only",
      provider_called: false,
      source_changed: false,
      deployment_changed: false,
      note: state === "CURRENT"
        ? "The selected persisted evidence is internally consistent at this cutoff. No provider, source, Blueprint, artifact, or deployment action was performed."
        : "No reconciliation action was performed. Review/blocked/safe candidates remain bound to this exact evidence."
    },
    actions: {
      safe_automatic: orderedDrifts.filter(item => item.classification === "SAFE_AUTOMATIC").map(item => item.action),
      review_required: orderedDrifts.filter(item => item.classification === "REVIEW_REQUIRED").map(item => item.action),
      blocked: orderedDrifts.filter(item => item.classification === "BLOCKED").map(item => item.action)
    }
  };
}
