import crypto from "node:crypto";
import { isGithubIntegrationConfigured, normalizeGithubBranch } from "./feltus-github.js";
import {
  INFRASTRUCTURE_ENVIRONMENT_TYPES,
  INFRASTRUCTURE_SERVICE_TYPES,
  infrastructureConfigurationForServices,
  infrastructureRegistrationComponent,
  normalizeInfrastructureEndpoint,
  managedMutationPolicy,
  normalizeInfrastructureRegistrations,
  normalizeInfrastructureConfiguration,
  resolveInfrastructureContract
} from "./feltus-infrastructure-contract.js";
import { observePublicHttpEndpoint } from "./feltus-safe-endpoint-observer.js";
import {
  APPLICATION_STATE_CONTRACT,
  applicationStateHash,
  applicationStateIdentity,
  canonicalJson,
  compareDesiredAndObserved,
  createBlueprintRevision,
  applicationLifecycleIsAccessible,
  normalizeApplicationState,
  resolveApplicationLifecycleStatus,
  serializeApplicationBlueprint
} from "./feltus-application-state.js";
import { deserializeDesignStateFromSetupData } from "./feltus-design-state-storage.js";
import {
  createDay2ReconciliationManifest,
  evaluateDay2Reconciliation,
  reconciliationBindings,
  resolveStoredDay2Reconciliation
} from "./feltus-day2-reconciliation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENTS = ["development", "preview", "staging", "production"];
const MAX_EVENT_LIMIT = 100;
const BUILD_WORKER_MAX_AGE_MS = 90_000;

function firstRow(result) {
  return Array.isArray(result?.data) ? result.data[0] || null : result?.data || null;
}

function response(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  res.end(JSON.stringify(value));
}

function fail(status, message, publicCode = null) {
  const error = new Error(message);
  error.status = status;
  if (publicCode) error.publicCode = publicCode;
  return error;
}

function safeRpcDiagnosticCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(code) ? `DB_${code}` : "DEPLOYMENT_RPC_FAILED";
}

function sameFullCommit(left, right) {
  const first = String(left || "").toLowerCase();
  const second = String(right || "").toLowerCase();
  return /^[0-9a-f]{40,64}$/.test(first) && first === second;
}

function firstSuccessful(result, label) {
  if (!result || result.status < 200 || result.status >= 300) {
    throw fail(result?.status >= 400 && result.status < 500 ? result.status : 502, `${label} could not be loaded.`);
  }
  return Array.isArray(result.data) ? result.data : [];
}

function query(table, tableRequest, params) {
  return tableRequest(table, "GET", { query: `?${new URLSearchParams(params)}` });
}

async function buildRunnerAvailable(tableRequest) {
  if (process.env.FELTUS_BUILD_RUNNER_ENABLED !== "true") return false;
  const cutoff = Date.now() - BUILD_WORKER_MAX_AGE_MS;
  try {
    const result = await query("feltus_worker_heartbeats", tableRequest, {
      select: "worker_id,worker_type,status,last_seen_at",
      worker_type: "eq.build",
      status: "eq.online",
      last_seen_at: "gte." + new Date(cutoff).toISOString(),
      limit: "1"
    });
    return firstSuccessful(result, "Build runner status").some(worker =>
      worker.worker_type === "build" && worker.status === "online" &&
      Number.isFinite(Date.parse(worker.last_seen_at)) && Date.parse(worker.last_seen_at) >= cutoff
    );
  } catch {
    return false;
  }
}

async function deploymentWorkerAvailability(tableRequest) {
  const cutoff = Date.now() - 90_000;
  try {
    const result = await query("feltus_worker_heartbeats", tableRequest, {
      select: "worker_id,worker_type,status,last_seen_at,metadata",
      worker_type: "eq.core",
      status: "in.(online,degraded)",
      last_seen_at: "gte." + new Date(cutoff).toISOString(),
      limit: "5"
    });
    const rows = firstSuccessful(result, "Deployment worker status");
    const worker = rows.find(row => row.worker_type === "core" && ["online", "degraded"].includes(row.status) &&
      Date.parse(row.last_seen_at) >= cutoff && row.metadata?.infrastructure_outbox === "enabled" &&
      !row.metadata?.infrastructure_error_code);
    const configured = Array.isArray(worker?.metadata?.infrastructure_environments)
      ? worker.metadata.infrastructure_environments.filter(kind => ENVIRONMENTS.includes(kind))
      : [];
    return { ready: Boolean(worker), allowedEnvironments: configured };
  } catch {
    return { ready: false, allowedEnvironments: [] };
  }
}

function lifecycleStatus(app) {
  return resolveApplicationLifecycleStatus(app) === "archived" ? "archived" : "active";
}

function safeInstructionVersion(instructions) {
  return crypto.createHash("sha256").update(String(instructions || ""), "utf8").digest("hex").slice(0, 16);
}

function documentEligible(document, permissions) {
  if (permissions?.documents === true) return true;
  const selected = Array.isArray(permissions?.document_ids) ? permissions.document_ids : [];
  return selected.includes(document.id);
}

function mapAppIdentity(app) {
  return {
    id: app.id,
    name: app.app_name,
    type: app.app_type || "custom",
    lifecycle_status: lifecycleStatus(app)
  };
}

function persistedColumnType(column) {
  // Metadata may come from the saved model-column row or a schema/RPC adapter.
  // Keep its type as a string in the blueprint instead of relying on one row shape.
  const value = column.data_type ?? column.type ?? column.column_type ?? column.udt_name;
  if (value === null || value === undefined || String(value).trim() === "") {
    throw fail(502, "A saved model field is missing its data type.");
  }
  return String(value).trim().toLowerCase();
}

function textLabels(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean))]
    : [];
}

function mapDesiredState({ app, models, columns, relationships, documents, aiSettings, repositories, repoBranches, codeCheckpoints, environments, targets }) {
  const fieldsByModel = new Map();
  for (const column of columns) {
    const fields = fieldsByModel.get(column.model_id) || [];
    fields.push({
      id: column.id,
      name: column.column_name,
      data_type: persistedColumnType(column),
      nullable: column.is_nullable,
      ordinal_position: column.ordinal_position
    });
    fieldsByModel.set(column.model_id, fields);
  }
  const repoById = new Map(repositories.map(repository => [repository.id, repository]));
  const permissionConfig = aiSettings.context_permissions && typeof aiSettings.context_permissions === "object"
    ? aiSettings.context_permissions
    : {};
  const repoLinks = app._repoLinks || [];
  const linkedRepo = repoLinks.map(link => repoById.get(link.repository_id)).find(Boolean) || null;
  const code = app.setup_data?.code && typeof app.setup_data.code === "object" ? app.setup_data.code : {};
  const branchName = code.branch || linkedRepo?.default_branch || null;
  const developmentEnvironment = environments.find(environment => environment.kind === "development");
  const matchingBranches = linkedRepo ? repoBranches.filter(branch =>
    branch.repository_id === linkedRepo.id && branch.branch_name === branchName
  ).sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0)) : [];
  const linkedBranch = matchingBranches.find(branch => branch.environment_id === developmentEnvironment?.id) ||
    matchingBranches[0] || null;
  const localCheckpoint = [...(codeCheckpoints || [])].sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0] || null;
  const sourceCommit = linkedRepo
    ? code.commit_sha || linkedBranch?.latest_commit_sha || null
    : localCheckpoint?.git_commit || code.commit_sha || null;
  const targetByEnvironment = new Map(targets.map(target => [target.environment_id, target]));
  const envByKind = new Map(environments.map(environment => [environment.kind, environment]));
  const instructionText = aiSettings.instructions || aiSettings.system_prompt || "";
  const intelligenceSettings = app.setup_data?.intelligence && typeof app.setup_data.intelligence === "object"
    ? app.setup_data.intelligence
    : {};
  const declaredClassification = intelligenceSettings.classification && typeof intelligenceSettings.classification === "object"
    ? intelligenceSettings.classification
    : {};
  const configuredEnvironments = ENVIRONMENTS.map(kind => {
    const environment = envByKind.get(kind);
    const target = environment ? targetByEnvironment.get(environment.id) : null;
    return {
      kind,
      status: environment?.status || "not_configured",
      provider: target?.provider_key || null
    };
  });
  const hasModels = models.length > 0;
  const hasDocuments = documents.length > 0;
  const aiEnabled = aiSettings.enabled !== false;
  const hasCodeWorkspace = Boolean(code.workspace);
  const hasEnvironmentDelivery = configuredEnvironments.some(environment => environment.status !== "not_configured");
  const workflowPatterns = textLabels(declaredClassification.workflow_patterns);
  if (hasModels) workflowPatterns.push("data-management");
  if (hasDocuments) workflowPatterns.push("knowledge-management");
  if (aiEnabled) workflowPatterns.push("assistant-interaction");
  if (linkedRepo || hasCodeWorkspace) workflowPatterns.push("source-controlled-development");
  if (hasEnvironmentDelivery) workflowPatterns.push("environment-delivery");
  const archetypes = textLabels(declaredClassification.archetypes);
  if (hasModels) archetypes.push("relational-data");
  if (hasDocuments) archetypes.push("knowledge-enabled");
  if (aiEnabled) archetypes.push("ai-assisted");
  if (linkedRepo || hasCodeWorkspace) archetypes.push("source-controlled");
  if (configuredEnvironments.filter(environment => environment.status !== "not_configured").length > 1) {
    archetypes.push("multi-environment");
  }
  const intelligence = {
    classification: {
      application_type: app.app_type || "custom",
      label: typeof declaredClassification.label === "string" ? declaredClassification.label : null,
      confidence: Number.isFinite(Number(declaredClassification.confidence)) &&
        Number(declaredClassification.confidence) >= 0 && Number(declaredClassification.confidence) <= 1
        ? Number(declaredClassification.confidence)
        : null,
      archetypes,
      business_models: textLabels(declaredClassification.business_models),
      audiences: textLabels(declaredClassification.audiences),
      workflow_patterns: workflowPatterns
    },
    capabilities: {
      data_models: hasModels,
      relationships: relationships.length > 0,
      knowledge_documents: hasDocuments,
      ai_assistant: aiEnabled,
      local_code_workspace: hasCodeWorkspace,
      hosted_repository: Boolean(linkedRepo),
      environment_kinds: configuredEnvironments
        .filter(environment => environment.status !== "not_configured")
        .map(environment => environment.kind)
    },
    permissions: {
      ai_context: {
        documents: permissionConfig.documents === true,
        app_data: permissionConfig.app_data === true,
        model_ids: Array.isArray(permissionConfig.model_ids) ? permissionConfig.model_ids : [],
        document_ids: Array.isArray(permissionConfig.document_ids) ? permissionConfig.document_ids : [],
        conversation_history: permissionConfig.conversation_history === true
      }
    },
    repository: {
      source: linkedRepo ? "hosted" : hasCodeWorkspace ? "local" : "none",
      repository_id: linkedRepo?.id || null,
      name: linkedRepo?.repository_name || null,
      default_branch: linkedRepo?.default_branch || null,
      branch: branchName,
      commit: sourceCommit
    },
    environment_provider_state: configuredEnvironments
  };

  return {
    data: {
      models: models.map(model => ({
        id: model.id,
        name: model.logical_name,
        physical_table_name: model.physical_table_name,
        rls_enabled: model.rls_enabled,
        fields: fieldsByModel.get(model.id) || []
      })),
      relationships: relationships.map(relationship => ({
        id: relationship.id,
        source_model_id: relationship.source_model_id,
        source_column: relationship.source_column,
        target_model_id: relationship.target_model_id,
        target_column: relationship.target_column,
        on_delete: relationship.on_delete_action
      }))
    },
    knowledge: {
      documents: documents.map(document => ({
        id: document.id,
        name: document.original_name,
        version: Number(document.metadata?.version || 1),
        processing_state: document.processing_status,
        ai_eligible: documentEligible(document, permissionConfig)
      }))
    },
    ai: {
      enabled: aiSettings.enabled !== false,
      assistant_purpose: aiSettings.assistant_purpose || null,
      model: aiSettings.model || null,
      runtime: aiSettings.runtime || process.env.FELTUS_AI_PROVIDER || "unknown",
      system_instructions_version: aiSettings.instructions_version || safeInstructionVersion(`${aiSettings.assistant_purpose || ""}\n${instructionText}`),
      context_permissions: {
        documents: permissionConfig.documents === true,
        app_data: permissionConfig.app_data === true,
        model_ids: Array.isArray(permissionConfig.model_ids) ? permissionConfig.model_ids : [],
        document_ids: Array.isArray(permissionConfig.document_ids) ? permissionConfig.document_ids : [],
        conversation_history: permissionConfig.conversation_history === true
      },
      token_settings: {
        max_response_tokens: Number(aiSettings.max_tokens || 2048),
        context_budget: Number(aiSettings.context_budget || 16000),
        temperature: Number(aiSettings.temperature ?? 0.2)
      }
    },
    code: {
      workspace: code.workspace || null,
      repository_id: linkedRepo?.id || code.repository_id || null,
      repository: linkedRepo?.repository_name || null,
      branch: branchName,
      commit: sourceCommit,
      status: code.status || (linkedRepo ? "connected" : "not_connected"),
      ...(code.design && typeof code.design === "object" && !Array.isArray(code.design)
        ? { design: deserializeDesignStateFromSetupData(code.design) }
        : {})
    },
    intelligence,
    environments: ENVIRONMENTS.map(kind => {
      const environment = envByKind.get(kind);
      const target = environment ? targetByEnvironment.get(environment.id) : null;
      return {
        id: environment?.id || null,
        kind,
        status: environment?.status || "not_configured",
        provider: target?.provider_key || null,
        resource_reference: target?.provider_resource_reference || null
      };
    })
  };
}

function mapBlueprintState(row) {
  return normalizeApplicationState(row.state);
}

function validCommit(value) {
  const commit = String(value || "").toLowerCase();
  return /^[0-9a-f]{40,64}$/.test(commit) ? commit : null;
}

function sourceCommitFromBlueprint(blueprint) {
  return validCommit(blueprint?.state?.desired_state?.code?.commit || blueprint?.source_commit);
}

function blueprintStateIntegrity(blueprint) {
  if (!blueprint?.state || !/^[0-9a-f]{64}$/i.test(String(blueprint.state_hash || ""))) return "UNRESOLVED";
  try {
    return applicationStateHash(blueprint.state) === String(blueprint.state_hash).toLowerCase()
      ? "CONFIRMED"
      : "DIVERGED";
  } catch {
    return "DIVERGED";
  }
}

export function resolveApplicationLineage({
  app,
  inputs,
  sourceEvidence = [],
  sourceEvidenceAvailable = true,
  codeWorkspaceSource = null,
  blueprintId = null,
  deploymentId = null
}) {
  const blueprint = blueprintId
    ? inputs.blueprints.find(item => item.id === blueprintId) || null
    : inputs.blueprints[0] || null;
  const deployment = deploymentId
    ? inputs.deployments.find(item => item.id === deploymentId) || null
    : inputs.deployments[0] || null;
  const code = app.setup_data?.code && typeof app.setup_data.code === "object" ? app.setup_data.code : {};
  const repository = inputs.repoLinks
    .map(link => inputs.repositories.find(item => item.id === link.repository_id))
    .find(Boolean) || null;
  const branchName = blueprint?.state?.desired_state?.code?.branch || code.branch || repository?.default_branch || null;
  const branch = repository && branchName
    ? inputs.repoBranches.find(item => item.repository_id === repository.id && item.branch_name === branchName) || null
    : null;
  const checkpoint = inputs.codeCheckpoints[0] || null;
  const checkpointCommit = validCommit(checkpoint?.git_commit);
  const workspaceCommit = codeWorkspaceSource?.available && codeWorkspaceSource.clean === true
    ? validCommit(codeWorkspaceSource.commit)
    : null;
  const codeCommit = workspaceCommit;
  const repositoryCommit = validCommit(branch?.latest_commit_sha);
  const workspaceBranch = typeof codeWorkspaceSource?.branch === "string" ? codeWorkspaceSource.branch : null;
  let codeRepositoryStatus = "UNRESOLVED";
  let codeRepositoryReason = "A clean CODE workspace, recorded checkpoint, and connected repository branch commit are required to compare source.";
  const blueprintRepositoryId = blueprint?.state?.desired_state?.code?.repository_id || null;
  if (repository && blueprintRepositoryId && repository.id !== blueprintRepositoryId) {
    codeRepositoryStatus = "DIVERGED";
    codeRepositoryReason = "The selected Blueprint names a different source repository than the one currently connected.";
  } else if (repository && codeWorkspaceSource?.available && codeWorkspaceSource.clean !== true) {
    codeRepositoryStatus = "UNRESOLVED";
    codeRepositoryReason = "The CODE workspace has uncommitted changes, so its current source cannot be matched to a repository commit.";
  } else if (repository && !codeWorkspaceSource?.available) {
    codeRepositoryStatus = "UNRESOLVED";
    codeRepositoryReason = "The current CODE workspace Git state could not be verified.";
  } else if (repository && !checkpointCommit) {
    codeRepositoryStatus = "UNRESOLVED";
    codeRepositoryReason = "No recorded CODE checkpoint is available to bind the current workspace source.";
  } else if (repository && workspaceCommit && checkpointCommit && !sameFullCommit(workspaceCommit, checkpointCommit)) {
    codeRepositoryStatus = "DIVERGED";
    codeRepositoryReason = "The current CODE workspace commit differs from its latest recorded checkpoint.";
  } else if (repository && branchName && workspaceBranch && branchName !== workspaceBranch) {
    codeRepositoryStatus = "DIVERGED";
    codeRepositoryReason = "The current CODE workspace branch differs from the branch selected for this application source.";
  } else if (repository && branchName && !workspaceBranch) {
    codeRepositoryStatus = "UNRESOLVED";
    codeRepositoryReason = "The current CODE workspace branch could not be verified.";
  } else if (!repository && checkpointCommit) {
    codeRepositoryStatus = "NOT_SYNCHRONIZED";
    codeRepositoryReason = "No connected repository is linked to the current CODE checkpoint.";
  } else if (repository && codeCommit && repositoryCommit) {
    codeRepositoryStatus = sameFullCommit(codeCommit, repositoryCommit) ? "SYNCHRONIZED" : "DIVERGED";
    codeRepositoryReason = codeRepositoryStatus === "SYNCHRONIZED"
      ? null
      : "The CODE checkpoint and connected repository branch point to different commits.";
  }

  const blueprintCommit = sourceCommitFromBlueprint(blueprint);
  const blueprintIntegrity = blueprintStateIntegrity(blueprint);
  const sourceIdentityMatchesBlueprint = Boolean(
    blueprint && blueprintIntegrity === "CONFIRMED" && blueprintCommit && (
      !blueprint.state?.desired_state?.code?.commit ||
      sameFullCommit(blueprintCommit, blueprint.state.desired_state.code.commit)
    )
  );
  const validationActions = (Array.isArray(sourceEvidence) ? sourceEvidence : [])
    .filter(action => action?.action_type === "productionization.validation")
    .sort((left, right) => Date.parse(right.created_at || 0) - Date.parse(left.created_at || 0));
  const matchingValidation = validationActions.find(action => {
    const run = action.details?.productionization_run;
    return blueprintCommit && run?.application_id === app.id && run.source_workspace_id === app.id &&
      sameFullCommit(run.source_commit, blueprintCommit) &&
      sameFullCommit(run.source_checkpoint_id, blueprintCommit) &&
      Boolean(run.run_id || action.details?.productionization_run_id);
  }) || null;
  const latestValidation = matchingValidation || validationActions[0] || null;
  const productionizationEvidence = !sourceEvidenceAvailable
    ? { status: "UNAVAILABLE", required: false, run_id: null }
    : matchingValidation
      ? {
          status: "MATCHED",
          required: false,
          run_id: matchingValidation.details?.productionization_run_id || matchingValidation.details?.productionization_run?.run_id || null,
          run_status: matchingValidation.details?.productionization_run?.status || null,
          action_id: matchingValidation.id || null,
          evaluated_at: matchingValidation.created_at || null,
          source_commit: blueprintCommit,
          source_checkpoint: matchingValidation.details?.productionization_run?.source_checkpoint_id || null,
          source_snapshot_sha256: matchingValidation.details?.productionization_run?.source_snapshot_sha256 || null,
          result_status: matchingValidation.result_status || null
        }
      : {
          status: latestValidation ? "STALE" : "NOT_RECORDED",
          required: false,
          run_id: latestValidation?.details?.productionization_run_id || latestValidation?.details?.productionization_run?.run_id || null,
          source_commit: validCommit(latestValidation?.details?.productionization_run?.source_commit) || null
        };

  const artifact = deployment
    ? inputs.artifacts.find(item => item.id === deployment.artifact_id) || null
    : null;
  const build = artifact
    ? inputs.builds.find(item => item.id === artifact.build_id) || null
    : null;
  const releaseBlueprint = deployment
    ? inputs.blueprints.find(item => item.id === deployment.blueprint_id) || null
    : null;
  const releaseCode = releaseBlueprint?.state?.desired_state?.code || {};
  const releaseRepositoryId = releaseCode.repository_id || null;
  const releaseBranch = releaseCode.branch || null;
  const releaseBlueprintCommit = sourceCommitFromBlueprint(releaseBlueprint);
  const releaseBlueprintIntegrity = blueprintStateIntegrity(releaseBlueprint);
  const releaseCommit = validCommit(deployment?.commit_sha || build?.commit_sha || releaseBlueprint?.state?.desired_state?.code?.commit || releaseBlueprint?.source_commit);
  let releaseStatus = "UNRESOLVED";
  const releaseReasons = [];
  if (deployment) {
    if (!artifact || !build || !releaseBlueprint) {
      releaseReasons.push("The deployment is missing its linked artifact, build, or Blueprint record.");
    } else {
      const completeBinding = Boolean(
        releaseBlueprintIntegrity === "CONFIRMED" && releaseRepositoryId && releaseBranch && releaseBlueprintCommit &&
        validCommit(build.commit_sha) && validCommit(deployment.commit_sha) &&
        artifact.artifact_digest && deployment.artifact_digest
      );
      if (releaseBlueprintIntegrity === "DIVERGED") {
        releaseStatus = "DIVERGED";
        releaseReasons.push("The release Blueprint state does not match its stored canonical state hash.");
      } else if (!completeBinding) {
        releaseReasons.push("The release is missing a repository, branch, exact source commit, or immutable artifact digest binding.");
      } else if (artifact.blueprint_id !== deployment.blueprint_id || build.blueprint_id !== artifact.blueprint_id ||
          build.repository_id !== releaseRepositoryId || build.source_branch !== releaseBranch ||
          !sameFullCommit(build.commit_sha, releaseBlueprintCommit) ||
          !sameFullCommit(deployment.commit_sha, build.commit_sha) ||
          artifact.artifact_digest !== deployment.artifact_digest) {
        releaseStatus = "DIVERGED";
        releaseReasons.push("Deployment, artifact, build, Blueprint, repository, branch, or source commit bindings disagree.");
      } else if (repository && releaseRepositoryId !== repository.id) {
        releaseStatus = "DIVERGED";
        releaseReasons.push("The release repository differs from the application's currently connected repository.");
      } else {
        releaseStatus = "CONFIRMED";
      }
    }
  } else {
    releaseReasons.push("No deployment is recorded for the selected release context.");
  }

  const observation = deployment
    ? inputs.observations.find(item => item.deployment_id === deployment.id) || null
    : null;
  const observationBindingComplete = Boolean(
    observation && validCommit(observation.commit_sha) && observation.artifact_digest && observation.blueprint_id
  );
  const observationStatus = !observation || !observationBindingComplete
    ? "UNRESOLVED"
    : sameFullCommit(observation.commit_sha, deployment.commit_sha) &&
      observation.artifact_digest === deployment.artifact_digest &&
      observation.blueprint_id === deployment.blueprint_id
      ? "CONFIRMED"
      : "DIVERGED";
  if (observationStatus === "DIVERGED" && releaseStatus === "CONFIRMED") {
    releaseStatus = "DIVERGED";
    releaseReasons.push("Observed runtime identity disagrees with the deployment source, artifact, or Blueprint.");
  } else if (observationStatus === "UNRESOLVED" && deployment && releaseStatus === "CONFIRMED") {
    releaseReasons.push("Observed runtime identity is not yet available or does not contain a complete source binding.");
  }
  const rollbackTarget = deployment
    ? inputs.deployments.find(item => item.environment === deployment.environment && item.status === "HEALTHY" && item.id !== deployment.id) || null
    : null;
  const rollbackBlueprint = rollbackTarget
    ? inputs.blueprints.find(item => item.id === rollbackTarget.blueprint_id) || null
    : null;
  const rollbackArtifact = rollbackTarget
    ? inputs.artifacts.find(item => item.id === rollbackTarget.artifact_id) || null
    : null;
  const rollbackTargetStatus = rollbackTarget && rollbackBlueprint && rollbackArtifact &&
    rollbackArtifact.blueprint_id === rollbackBlueprint.id &&
    sameFullCommit(rollbackTarget.commit_sha, sourceCommitFromBlueprint(rollbackBlueprint)) &&
    rollbackTarget.artifact_digest === rollbackArtifact.artifact_digest
    ? "CONFIRMED"
    : rollbackTarget ? "UNRESOLVED" : null;
  const codeBlueprintDiverged = Boolean(codeCommit && blueprintCommit && !sameFullCommit(codeCommit, blueprintCommit));
  const lineageStatus = codeRepositoryStatus === "DIVERGED" || releaseStatus === "DIVERGED" ||
      blueprintIntegrity === "DIVERGED" || codeBlueprintDiverged
    ? "DIVERGED"
    : codeRepositoryStatus === "NOT_SYNCHRONIZED"
      ? "NOT_SYNCHRONIZED"
      : codeRepositoryStatus !== "SYNCHRONIZED" || !blueprint || !sourceIdentityMatchesBlueprint || releaseStatus !== "CONFIRMED"
        ? "UNRESOLVED"
        : "CONFIRMED";

  return {
    contract: "feltus.application-lineage/v1",
    application: {
      id: app.id,
      lifecycle_status: resolveApplicationLifecycleStatus(app)
    },
    blueprint: blueprint ? {
      id: blueprint.id,
      version: blueprint.version,
      state_hash: blueprint.state_hash,
      source_commit: blueprintCommit,
      state_hash_matches: blueprintIntegrity === "CONFIRMED",
      source_identity_matches: sourceIdentityMatchesBlueprint
    } : null,
    source: {
      workspace_id: app.id,
      checkpoint_id: checkpoint?.id || null,
      checkpoint_commit: checkpointCommit,
      code_commit: codeCommit,
      workspace_commit: validCommit(codeWorkspaceSource?.commit),
      workspace_branch: workspaceBranch,
      workspace_available: codeWorkspaceSource?.available === true,
      workspace_clean: codeWorkspaceSource?.available === true ? codeWorkspaceSource.clean === true : null,
      workspace_error_code: codeWorkspaceSource?.error_code || null,
      repository_id: repository?.id || null,
      repository_name: repository?.repository_name || null,
      branch: branchName,
      repository_commit: repositoryCommit,
      repository_branch_recorded: Boolean(branch),
      reconciliation: { status: codeRepositoryStatus, reason: codeRepositoryReason }
    },
    productionization: productionizationEvidence,
    release: {
      status: releaseStatus,
      source_commit: releaseCommit,
      build: build ? {
        id: build.id,
        repository_id: build.repository_id,
        blueprint_id: build.blueprint_id,
        branch: build.source_branch,
        commit: validCommit(build.commit_sha),
        status: build.status
      } : null,
      artifact: artifact ? {
        id: artifact.id,
        build_id: artifact.build_id,
        blueprint_id: artifact.blueprint_id,
        digest: artifact.artifact_digest,
        verification_status: artifact.verification_status
      } : null,
      deployment: deployment ? {
        id: deployment.id,
        environment: deployment.environment,
        status: deployment.status,
        blueprint_id: deployment.blueprint_id,
        artifact_id: deployment.artifact_id,
        artifact_digest: deployment.artifact_digest,
        commit: validCommit(deployment.commit_sha)
      } : null,
      observed_state: observation ? {
        id: observation.id,
        deployment_id: observation.deployment_id,
        health: observation.health,
        commit: validCommit(observation.commit_sha),
        observed_at: observation.observed_at
      } : null,
      observed_state_status: observationStatus,
      reasons: releaseReasons
    },
    rollback_target: rollbackTarget ? {
      deployment_id: rollbackTarget.id,
      blueprint_id: rollbackBlueprint?.id || null,
      blueprint_version: rollbackBlueprint?.version || null,
      source_commit: validCommit(rollbackTarget.commit_sha || rollbackBlueprint?.source_commit),
      artifact_id: rollbackArtifact?.id || null,
      artifact_digest: rollbackArtifact?.artifact_digest || rollbackTarget.artifact_digest || null,
      environment: rollbackTarget.environment,
      status: rollbackTarget.status,
      lineage_status: rollbackTargetStatus
    } : null,
    code_blueprint_source_matches: sourceIdentityMatchesBlueprint && Boolean(codeCommit) && sameFullCommit(codeCommit, blueprintCommit),
    code_source_matches_release: releaseStatus === "CONFIRMED" && Boolean(codeCommit) && sameFullCommit(codeCommit, releaseCommit),
    lineage_status: lineageStatus
  };
}

export function createApplicationStateHandler({ tableRequest, serviceRequest, readBody, getUser, authorizeApp = null, validateReconciliation = null, recordReconciliation = null, findReconciliationRun = null, reconciliationContext = null, releaseReadiness = null, loadSourceEvidence = null, loadCodeWorkspaceSource = null, verifyRemoteSource = null, prepareGeneratedAppAuth = null, generatedAppAuthReady = null, observeEndpoint = observePublicHttpEndpoint }) {
  if (typeof tableRequest !== "function" || typeof serviceRequest !== "function" || typeof readBody !== "function" || typeof getUser !== "function") {
    throw new TypeError("Application state API requires tableRequest, serviceRequest, readBody, and getUser.");
  }

  async function loadApp(appId, ownerId = null) {
    const result = await query("feltus_applications", tableRequest, {
      select: "id,owner_id,organization_id,app_name,app_type,environment,lifecycle_status,setup_status,setup_data,setup_current_step,setup_completed_steps,created_at,setup_updated_at",
      id: `eq.${appId}`,
      ...(ownerId ? { owner_id: `eq.${ownerId}` } : {}),
      limit: "1"
    });
    return firstSuccessful(result, "Application")[0] || null;
  }

  async function checkRemoteSource({ app, repositoryId, branch, expectedCommit }) {
    if (!repositoryId) {
      return { status: "NOT_CONNECTED", branch: branch || null, expected_commit: expectedCommit || null };
    }
    if (typeof verifyRemoteSource !== "function") {
      return { status: "REMOTE_UNAVAILABLE", error_code: "REMOTE_VERIFIER_UNAVAILABLE" };
    }
    try {
      const result = await verifyRemoteSource({ app, repositoryId, branch, expectedCommit });
      if (result && ["REMOTE_VERIFIED", "REMOTE_DIVERGED", "REMOTE_UNAVAILABLE"].includes(result.status)) return result;
    } catch {
      return { status: "REMOTE_UNAVAILABLE", error_code: "REMOTE_VERIFICATION_FAILED" };
    }
    return { status: "REMOTE_UNAVAILABLE", error_code: "REMOTE_VERIFICATION_INVALID" };
  }

  function requireVerifiedRemote(result) {
    if (result.status === "REMOTE_VERIFIED" || result.status === "NOT_CONNECTED") return;
    if (result.status === "REMOTE_DIVERGED") {
      throw fail(409, "The connected repository branch no longer points to the selected source commit.", "REMOTE_DIVERGED");
    }
    throw fail(503, "The connected repository branch could not be verified.", "REMOTE_UNAVAILABLE");
  }

  function requireManagedMutation(contract, components) {
    const policy = managedMutationPolicy(contract, components);
    if (!policy.allowed) {
      throw fail(409, `FELTUS-managed changes are blocked for ${policy.component}; its ownership is not FELTUS-managed.`, policy.code);
    }
  }

  async function resolveAppInfrastructure(app, inputs) {
    const [buildWorkerReady, deploymentWorker, appAuthenticationReady, backupResult] = await Promise.all([
      buildRunnerAvailable(tableRequest),
      deploymentWorkerAvailability(tableRequest),
      typeof generatedAppAuthReady === "function" ? generatedAppAuthReady(app) : false,
      serviceRequest
        ? serviceRequest(`/rest/v1/feltus_app_backups?${new URLSearchParams({
            select: "status,created_at,completed_at,failure_code,restore_status,restore_started_at,restore_completed_at,restore_failure_code",
            app_id: `eq.${app.id}`,
            owner_id: `eq.${app.owner_id}`,
            backup_kind: "eq.customer",
            order: "created_at.desc",
            limit: "100"
          }).toString()}`)
        : Promise.resolve({ status: 503, data: null })
    ]);
    const backupRecords = backupResult.status >= 200 && backupResult.status < 300 && Array.isArray(backupResult.data)
      ? backupResult.data
      : null;
    const latestRestore = backupRecords
      ?.filter(item => item.restore_started_at)
      .sort((left, right) => Date.parse(right.restore_started_at) - Date.parse(left.restore_started_at))[0] || null;
    const backupState = {
      available: backupRecords !== null,
      backup: backupRecords?.[0] ? {
        status: backupRecords[0].status,
        completed_at: backupRecords[0].completed_at,
        failure_code: backupRecords[0].failure_code
      } : null,
      restore: latestRestore ? {
        status: latestRestore.restore_status,
        started_at: latestRestore.restore_started_at,
        completed_at: latestRestore.restore_completed_at,
        failure_code: latestRestore.restore_failure_code
      } : null
    };
    return resolveInfrastructureContract({
      app,
      inputs,
      buildWorkerReady,
      appAuthenticationReady,
      deploymentWorkerReady: deploymentWorker.ready,
      deploymentWorkerEnvironments: deploymentWorker.allowedEnvironments,
      backupState
    });
  }

  async function saveAppSetupData(app, ownerId, setupData) {
    const timestampFilter = app.setup_updated_at
      ? `&setup_updated_at=eq.${encodeURIComponent(app.setup_updated_at)}`
      : "&setup_updated_at=is.null";
    const saved = await tableRequest("feltus_applications", "PATCH", {
      query: `?id=eq.${encodeURIComponent(app.id)}&owner_id=eq.${encodeURIComponent(ownerId)}${timestampFilter}&select=id,setup_updated_at`,
      body: { setup_data: setupData, setup_updated_at: new Date().toISOString() }
    });
    if (saved.status < 200 || saved.status >= 300) {
      throw fail(saved.status >= 400 && saved.status < 500 ? saved.status : 502,
        "Application services could not be saved.", "APPLICATION_SERVICES_SAVE_FAILED");
    }
    if (!Array.isArray(saved.data) || !saved.data.length) {
      throw fail(409, "Application setup changed concurrently. Refresh the service settings before saving.", "APPLICATION_SERVICES_STALE");
    }
  }

  function registrationsForApp(app) {
    const stored = app.setup_data?.infrastructure_registrations;
    if (stored == null) return { services: [], environments: [] };
    try {
      return normalizeInfrastructureRegistrations(stored);
    } catch {
      throw fail(409, "This app’s saved service settings need review before they can be changed.", "INFRASTRUCTURE_REGISTRATIONS_INVALID");
    }
  }

  async function saveRegistrations(app, ownerId, registrations) {
    const currentSetup = app.setup_data && typeof app.setup_data === "object" && !Array.isArray(app.setup_data)
      ? app.setup_data
      : {};
    const nextSetup = { ...currentSetup, infrastructure_registrations: registrations };
    if (Buffer.byteLength(JSON.stringify(nextSetup), "utf8") > 24000) {
      throw fail(400, "The app’s service settings are too large.", "INFRASTRUCTURE_REGISTRATIONS_TOO_LARGE");
    }
    await saveAppSetupData(app, ownerId, nextSetup);
  }

  function noEndpointObservation() {
    return {
      method: "NONE",
      status: "NOT_CHECKED",
      checked_at: null,
      http_status: null,
      failure_code: null
    };
  }

  async function checkedRegistration(registration) {
    if (registration.observation.method !== "HTTP_HEAD" || !registration.endpoint) {
      throw fail(409, "This service type does not support an endpoint check.", "INFRASTRUCTURE_CHECK_UNAVAILABLE");
    }
    const observation = await observeEndpoint(registration.endpoint);
    try {
      const collection = registration.component === "runtime_hosting"
        ? { services: [], environments: [{ ...registration, observation, updated_at: new Date().toISOString() }] }
        : { services: [{ ...registration, observation, updated_at: new Date().toISOString() }], environments: [] };
      return normalizeInfrastructureRegistrations(collection)[registration.component === "runtime_hosting" ? "environments" : "services"][0];
    } catch {
      throw fail(502, "The endpoint check returned an invalid status.", "INFRASTRUCTURE_CHECK_INVALID");
    }
  }

  async function loadInputs(app) {
    const appId = app.id;
    const common = `eq.${appId}`;
    const [modelsResult, relationshipsResult, documentsResult, environmentsResult, targetsResult,
      repoLinksResult, codeCheckpointsResult, blueprintsResult, buildsResult, artifactsResult, deploymentsResult, observationsResult, stateDeltasResult] = await Promise.all([
      query("feltus_models", tableRequest, { select: "id,logical_name,physical_table_name,rls_enabled,created_at", app_id: common, order: "created_at.asc", limit: "500" }),
      query("feltus_model_relationships", tableRequest, { select: "id,source_model_id,source_column,target_model_id,target_column,on_delete_action,created_at", app_id: common, order: "created_at.asc", limit: "1000" }),
      query("feltus_documents", tableRequest, { select: "id,original_name,processing_status,metadata,created_at,processed_at", app_id: common, order: "created_at.asc", limit: "500" }),
      query("feltus_environments", tableRequest, { select: "id,name,kind,status,created_at", app_id: common, order: "created_at.asc", limit: "20" }),
      query("feltus_deployment_targets", tableRequest, { select: "id,environment_id,provider_key,provider_resource_reference,active", app_id: common, active: "eq.true", limit: "20" }),
      query("feltus_project_repositories", tableRequest, { select: "repository_id,created_at", app_id: common, order: "created_at.desc", limit: "20" }),
      query("feltus_code_checkpoints", tableRequest, { select: "id,git_commit,created_at", app_id: common, order: "created_at.desc", limit: "100" }),
      query("feltus_application_blueprints", tableRequest, { select: "id,app_id,version,parent_blueprint_id,parent_version,state_hash,state,status,created_by,created_at,source_commit", app_id: common, order: "version.desc", limit: "100" }),
      query("feltus_builds", tableRequest, { select: "id,repository_id,blueprint_id,source_branch,commit_sha,status,created_at,completed_at", app_id: common, order: "created_at.desc", limit: "100" }),
      query("feltus_artifacts", tableRequest, { select: "id,build_id,blueprint_id,registry_image,artifact_digest,verification_status,environment_eligibility,created_at,verified_at", app_id: common, order: "created_at.desc", limit: "100" }),
      query("feltus_deployments", tableRequest, { select: "id,environment,environment_id,status,provider,provider_reference,blueprint_id,artifact_id,artifact_digest,commit_sha,created_at,started_at,completed_at", app_id: common, order: "created_at.desc", limit: "100" }),
      query("feltus_observed_application_states", tableRequest, { select: "id,deployment_id,environment,provider,provider_deployment_id,blueprint_id,blueprint_version,commit_sha,artifact_digest,health,state_hash,observed_state,observed_at", app_id: common, order: "observed_at.desc", limit: "20" }),
      query("feltus_application_state_deltas", tableRequest, { select: "id,observed_state_id,blueprint_id,delta_key,path,status,desired_value,observed_value,created_at", app_id: common, order: "created_at.desc", limit: "200" })
    ]);
    const models = firstSuccessful(modelsResult, "Data models");
    const links = firstSuccessful(repoLinksResult, "Repository links");
    const [columnsResult, repositoriesResult] = await Promise.all([
      models.length
        ? tableRequest("feltus_model_columns", "GET", {
          query: `?select=id,model_id,column_name,data_type,is_nullable,ordinal_position&model_id=in.(${models.map(model => model.id).join(",")})&order=ordinal_position.asc&limit=2000`
        })
        : { status: 200, data: [] },
      links.length
        ? tableRequest("feltus_repositories", "GET", {
          query: `?select=id,repository_name,default_branch,archived_at&id=in.(${links.map(link => link.repository_id).join(",")})`
        })
        : { status: 200, data: [] }
    ]);
    const repositories = firstSuccessful(repositoriesResult, "Repositories")
      .filter(repository => !repository.archived_at);
    const repoBranchesResult = repositories.length
      ? await query("feltus_repository_branches", tableRequest, {
          select: "repository_id,environment_id,branch_name,is_default,latest_commit_sha,updated_at",
          app_id: common,
          repository_id: `in.(${repositories.map(repository => repository.id).join(",")})`,
          order: "updated_at.desc",
          limit: "100"
        })
      : { status: 200, data: [] };
    return {
      models,
      columns: firstSuccessful(columnsResult, "Model fields"),
      relationships: firstSuccessful(relationshipsResult, "Relationships"),
      documents: firstSuccessful(documentsResult, "Documents"),
      environments: firstSuccessful(environmentsResult, "Environments"),
      targets: firstSuccessful(targetsResult, "Environment targets"),
      repoLinks: links,
      codeCheckpoints: firstSuccessful(codeCheckpointsResult, "Source checkpoints"),
      // Local CODE workspaces have their own Git state. Read hosted branch rows
      // only after resolving an active hosted repository linked to this app.
      repoBranches: firstSuccessful(repoBranchesResult, "Repository branches"),
      repositories,
      blueprints: firstSuccessful(blueprintsResult, "Blueprint history"),
      builds: firstSuccessful(buildsResult, "Build history"),
      artifacts: firstSuccessful(artifactsResult, "Artifacts"),
      deployments: firstSuccessful(deploymentsResult, "Deployments"),
      observations: firstSuccessful(observationsResult, "Observed state"),
      stateDeltas: firstSuccessful(stateDeltasResult, "Application state deltas")
    };
  }

  function makeState(app, inputs, blueprint = null) {
    const desiredState = mapDesiredState({
      app: { ...app, _repoLinks: inputs.repoLinks },
      models: inputs.models,
      columns: inputs.columns,
      relationships: inputs.relationships,
      documents: inputs.documents,
      aiSettings: app.setup_data?.ai && typeof app.setup_data.ai === "object" ? app.setup_data.ai : {},
      repositories: inputs.repositories,
      repoBranches: inputs.repoBranches,
      codeCheckpoints: inputs.codeCheckpoints,
      environments: inputs.environments,
      targets: inputs.targets
    });
    const latestObservation = inputs.observations[0] || null;
    const latestDeployment = inputs.deployments[0] || null;
    const recordedDeltas = latestObservation
      ? inputs.stateDeltas.filter(delta => delta.observed_state_id === latestObservation.id)
      : [];
    const currentState = normalizeApplicationState({
      contract: APPLICATION_STATE_CONTRACT,
      application: mapAppIdentity(app),
      blueprint: {
        id: null,
        version: null,
        parent_id: null,
        parent_version: null,
        status: resolveApplicationLifecycleStatus(app) === "archived" ? "archived" : "draft",
        created_by: null,
        created_at: null,
        state_hash: null,
        source_commit: null
      },
      desired_state: desiredState,
      execution: { builds: [], artifacts: [], deployments: [] },
      observed_state: null
    });
    const currentHash = applicationStateHash(currentState);
    const blueprintMatches = Boolean(blueprint && blueprint.state_hash === currentHash);
    const state = blueprintMatches ? mapBlueprintState(blueprint) : normalizeApplicationState({
      ...currentState,
      blueprint: {
        id: null,
        version: null,
        parent_id: null,
        parent_version: null,
        status: "draft",
        created_by: null,
        created_at: null,
        state_hash: currentHash,
        source_commit: null
      }
    });
    const dynamicState = {
      ...state,
      execution: {
        builds: inputs.builds.map(build => ({
          id: build.id, blueprint_id: build.blueprint_id, repository_id: build.repository_id,
          branch: build.source_branch, commit: build.commit_sha, status: build.status,
          created_at: build.created_at, completed_at: build.completed_at
        })),
        artifacts: inputs.artifacts.map(artifact => ({
          id: artifact.id, build_id: artifact.build_id, blueprint_id: artifact.blueprint_id,
          image: artifact.registry_image, digest: artifact.artifact_digest,
          status: artifact.verification_status, environments: artifact.environment_eligibility,
          created_at: artifact.created_at, verified_at: artifact.verified_at
        })),
        deployments: inputs.deployments.map(deployment => ({
          id: deployment.id, environment: deployment.environment, environment_id: deployment.environment_id,
          provider: deployment.provider, provider_deployment_id: deployment.provider_reference,
          blueprint_id: deployment.blueprint_id, artifact_id: deployment.artifact_id,
          artifact_digest: deployment.artifact_digest, commit: deployment.commit_sha,
          status: deployment.status, created_at: deployment.created_at,
          started_at: deployment.started_at, completed_at: deployment.completed_at
        }))
      },
      observed_state: latestObservation ? {
        id: latestObservation.id,
        deployment_id: latestObservation.deployment_id,
        environment: latestObservation.environment,
        provider: latestObservation.provider,
        provider_deployment_id: latestObservation.provider_deployment_id,
        blueprint_id: latestObservation.blueprint_id,
        blueprint_version: latestObservation.blueprint_version,
        commit_sha: latestObservation.commit_sha,
        artifact_digest: latestObservation.artifact_digest,
        health: latestObservation.health,
        state_hash: latestObservation.state_hash,
        observed_at: latestObservation.observed_at
      } : null
    };
    const deltas = compareDesiredAndObserved(state, latestObservation);
    if (blueprint && !blueprintMatches) {
      deltas.unshift({
        key: "desired_state.unpersisted",
        path: "blueprint",
        status: "changed",
        desired: { state_hash: currentHash },
        observed: { blueprint_id: blueprint.id, version: blueprint.version, state_hash: blueprint.state_hash }
      });
    }
    return {
      state: normalizeApplicationState(dynamicState),
      blueprint,
      persisted: blueprintMatches,
      latestDeployment,
      latestObservation,
      deltas,
      recordedDeltas
    };
  }

  const reconciliationInFlight = new Map();

  function reconciliationScopeSnapshot(inputs, environmentKind, deploymentId, asOf) {
    const environment = inputs.environments.find(item => item.kind === environmentKind) || null;
    const deployments = inputs.deployments
      .filter(item => item.environment === environmentKind && (!deploymentId || item.id === deploymentId))
      .sort((left, right) => Date.parse(right.created_at || 0) - Date.parse(left.created_at || 0));
    const deployment = deployments[0] || null;
    const cutoff = Date.parse(asOf);
    const observations = inputs.observations
      .filter(item => item.environment === environmentKind && (!deploymentId && deployment ? item.deployment_id === deployment.id : !deploymentId || item.deployment_id === deploymentId))
      .sort((left, right) => Date.parse(right.observed_at || 0) - Date.parse(left.observed_at || 0));
    const observation = observations.find(item => Number.isFinite(Date.parse(item.observed_at || "")) && Date.parse(item.observed_at) <= cutoff) || null;
    const target = environment ? inputs.targets.find(item => item.environment_id === environment.id) || null : null;
    return { environment, deployment, observation, target };
  }

  async function withReconciliationRun(runId, callback) {
    const existing = reconciliationInFlight.get(runId);
    if (existing) return existing;
    const pending = Promise.resolve().then(callback).finally(() => reconciliationInFlight.delete(runId));
    reconciliationInFlight.set(runId, pending);
    return pending;
  }

  function fallbackReconciliationSource(app, current, inputs) {
    const code = current.state?.desired_state?.code || {};
    const checkpoint = inputs.codeCheckpoints[0]?.git_commit || code.commit || null;
    return {
      application_id: app.id,
      workspace_id: code.workspace || null,
      branch: code.branch || null,
      checkpoint,
      source_commit: code.commit || checkpoint,
      source_snapshot_sha256: null,
      source_snapshot_complete: false,
      classifier_version: null,
      source_clean: false
    };
  }

  async function persistBlueprint(app, inputs, user) {
    if (resolveApplicationLifecycleStatus(app) === "archived") throw fail(409, "Archived applications cannot create a blueprint.");
    const current = makeState(app, inputs, null).state;
    const revision = createBlueprintRevision({ state: current, parent: inputs.blueprints[0] || null, createdBy: user.id });
    const alreadyPersisted = inputs.blueprints[0]?.state_hash === revision.blueprint.state_hash;
    const identity = canonicalJson(applicationStateIdentity(revision));
    const result = await tableRequest("rpc/feltus_create_application_blueprint", "POST", {
      body: {
        p_app_id: app.id,
        p_state: revision,
        p_state_hash: revision.blueprint.state_hash,
        p_identity_json: identity,
        p_source_wizard_state: {
          setup_status: app.setup_status,
          setup_current_step: app.setup_current_step,
          setup_completed_steps: app.setup_completed_steps || []
        }
      }
    });
    const row = firstRow(result);
    if (result.status < 200 || result.status >= 300 || !row?.state) {
      throw fail(result.status >= 400 && result.status < 500 ? result.status : 502,
        result.data?.message || result.data?.error || "The application blueprint could not be saved.");
    }
    return { blueprint: row, state_hash: row.state_hash, reused: alreadyPersisted, yaml: serializeApplicationBlueprint(row.state) };
  }

  return async function handleApplicationStateApi(req, res, url) {
    const match = /^\/api\/apps\/([0-9a-f-]{36})\/(state|lineage|infrastructure|infrastructure-registrations|services|blueprints|environments|events|builds|deployments)(?:\/([0-9a-f-]{36}|target|promote|reconciliation|check))?(?:\/(export|cancel|rollback|accept|restore|evaluate))?$/i.exec(url.pathname);
    if (!match) return false;
    const [, appId, resource, record, action] = match;
    const recordId = UUID.test(record || "") ? record : null;
    if (!UUID.test(appId) || (record && !recordId && !["target", "promote", "reconciliation", "check"].includes(record))) {
      response(res, 400, { error: "A valid application reference is required." });
      return true;
    }
    const user = getUser();
    if (!user?.id) {
      response(res, 401, { error: "Authentication required." });
      return true;
    }
    try {
      const method = String(req.method || "GET").toUpperCase();
      const body = method === "GET" ? {} : await readBody(req, resource === "infrastructure" ? 8192 : 4096);
      let app;
      if (authorizeApp) {
        let requiredCapability = "canViewCode";
        if (method !== "GET") {
          if (resource === "blueprints" || resource === "builds") requiredCapability = "canPrepareVersion";
          if (resource === "environments" && record === "target") {
            requiredCapability = body.environment === "production" ? "canPublishProduction" : "canDeployTesting";
          }
          if (resource === "state" && record === "reconciliation" && action === "accept") requiredCapability = "canPrepareVersion";
          if (resource === "state" && record === "reconciliation" && action === "evaluate") requiredCapability = "canRunAgent";
          if (resource === "state" && record === "reconciliation" && action === "restore") {
            requiredCapability = body.environment === "production" ? "canPublishProduction" : "canDeployTesting";
          }
          if (resource === "infrastructure") requiredCapability = "canEditCode";
          if (resource === "services") requiredCapability = "canEditCode";
          if (resource === "infrastructure-registrations") requiredCapability = "canEditCode";
          if (resource === "deployments") {
            requiredCapability = body.environment === "production" || ["promote", "rollback"].includes(record)
              ? "canPublishProduction"
              : "canDeployTesting";
          }
        }
        const authorized = await authorizeApp(appId, requiredCapability);
        app = authorized ? await loadApp(appId) : null;
      } else {
        app = await loadApp(appId, user.id);
      }
      if (!app) {
        response(res, 404, { error: "Application not found." });
        return true;
      }
      if (!applicationLifecycleIsAccessible(app)) {
        response(res, 404, { error: "Application not found." });
        return true;
      }
      const appFilter = `eq.${appId}`;
      if (resource === "infrastructure-registrations") {
        if (method === "GET" && !record) {
          response(res, 200, { registrations: registrationsForApp(app) });
          return true;
        }
        if (app.owner_id !== user.id) {
          throw fail(403, "Only the app owner can add, check, or remove these records.", "INFRASTRUCTURE_REGISTRATION_OWNER_REQUIRED");
        }
        if (resolveApplicationLifecycleStatus(app) !== "active") {
          throw fail(409, "Archived apps cannot change service or environment records.", "APPLICATION_ARCHIVED");
        }

        const registrations = registrationsForApp(app);
        if (method === "POST" && !record) {
          const kind = body.kind;
          if (!["services", "environments"].includes(kind)) {
            throw fail(400, "Choose a supported service or environment type.", "INFRASTRUCTURE_REGISTRATION_INVALID");
          }
          const type = body.type;
          const component = infrastructureRegistrationComponent(kind, type);
          if (!component ||
              (kind === "services" && !INFRASTRUCTURE_SERVICE_TYPES.includes(type)) ||
              (kind === "environments" && !INFRASTRUCTURE_ENVIRONMENT_TYPES.includes(type))) {
            throw fail(400, "Choose a supported service or environment type.", "INFRASTRUCTURE_REGISTRATION_INVALID");
          }
          if (registrations[kind].length >= 20) {
            throw fail(409, "This app has reached the limit for saved service and environment records.", "INFRASTRUCTURE_REGISTRATION_LIMIT_REACHED");
          }
          let endpoint;
          try {
            endpoint = normalizeInfrastructureEndpoint(body.endpoint);
          } catch (error) {
            throw fail(error.status || 400, error.message, error.code || "INFRASTRUCTURE_ENDPOINT_INVALID");
          }
          const expectedOwner = type === "customer_runtime" ? "CUSTOMER" : "EXTERNAL_PROVIDER";
          const owner = kind === "services" ? body.owner : expectedOwner;
          if (kind === "services" && !["CUSTOMER", "EXTERNAL_PROVIDER"].includes(owner)) {
            throw fail(400, "Choose who owns this service.", "INFRASTRUCTURE_REGISTRATION_INVALID");
          }
          if (kind === "environments" && body.owner && body.owner !== expectedOwner) {
            throw fail(400, "The environment owner must match the selected environment type.", "INFRASTRUCTURE_REGISTRATION_INVALID");
          }
          const now = new Date().toISOString();
          const registration = {
            id: crypto.randomUUID(),
            type,
            component,
            name: body.name,
            provider: body.provider == null || body.provider === "" ? null : body.provider,
            owner,
            management: owner === "CUSTOMER" ? "CUSTOMER_MANAGED" : "CONNECTED_EXTERNAL",
            endpoint,
            observation: component === "runtime_hosting" || type === "api_endpoint"
              ? await observeEndpoint(endpoint)
              : noEndpointObservation(),
            created_at: now,
            updated_at: now
          };
          try {
            const nextRegistrations = normalizeInfrastructureRegistrations({
              ...registrations,
              [kind]: [...registrations[kind], registration]
            });
            await saveRegistrations(app, user.id, nextRegistrations);
            response(res, 201, { registration: nextRegistrations[kind].at(-1), registrations: nextRegistrations });
          } catch (error) {
            if (error?.publicCode) throw error;
            throw fail(error.status || 400, error.message || "The service record could not be saved.", error.code || "INFRASTRUCTURE_REGISTRATION_INVALID");
          }
          return true;
        }
        if (method === "POST" && record === "check") {
          const kind = body.kind;
          const id = body.id;
          if (!["services", "environments"].includes(kind) || !UUID.test(id || "")) {
            throw fail(400, "Choose a valid service or environment record.", "INFRASTRUCTURE_REGISTRATION_INVALID");
          }
          const index = registrations[kind].findIndex(item => item.id === id);
          if (index < 0) throw fail(404, "Service or environment record not found.", "INFRASTRUCTURE_REGISTRATION_NOT_FOUND");
          const checked = await checkedRegistration(registrations[kind][index]);
          const nextRegistrations = normalizeInfrastructureRegistrations({
            ...registrations,
            [kind]: registrations[kind].map(item => item.id === id ? checked : item)
          });
          await saveRegistrations(app, user.id, nextRegistrations);
          response(res, 200, { registration: checked, registrations: nextRegistrations });
          return true;
        }
        if (method === "DELETE" && recordId) {
          const kind = registrations.services.some(item => item.id === recordId)
            ? "services"
            : registrations.environments.some(item => item.id === recordId) ? "environments" : null;
          if (!kind) {
            throw fail(404, "Service or environment record not found.", "INFRASTRUCTURE_REGISTRATION_NOT_FOUND");
          }
          const nextRegistrations = {
            ...registrations,
            [kind]: registrations[kind].filter(item => item.id !== recordId)
          };
          await saveRegistrations(app, user.id, nextRegistrations);
          response(res, 200, { registrations: nextRegistrations, removed: true });
          return true;
        }
        throw fail(405, "This service or environment action is not supported.", "METHOD_NOT_ALLOWED");
      }
      if (resource === "services" && !record && method === "PUT") {
        if (app.owner_id !== user.id) {
          throw fail(403, "Only the application owner can select platform services.", "APPLICATION_SERVICES_OWNER_REQUIRED");
        }
        if (body.service_ids !== undefined && !Array.isArray(body.service_ids)) {
          throw fail(400, "Choose a list of supported services.", "PLATFORM_SERVICE_SELECTION_INVALID");
        }
        const serviceIds = [...new Set(body.service_ids || [])];
        const inputs = await loadInputs(app);
        if (serviceIds.includes("data_sign_in") && inputs.models.some(model => model.rls_enabled !== true)) {
          throw fail(409, "Enable privacy protection on every data model before enabling app sign-in.", "APP_AUTH_REQUIRES_MODEL_RLS");
        }
        const currentContract = await resolveAppInfrastructure(app, inputs);
        const { configuration, blocked_components } = infrastructureConfigurationForServices(serviceIds, currentContract);
        const currentSetup = app.setup_data && typeof app.setup_data === "object" && !Array.isArray(app.setup_data)
          ? app.setup_data
          : {};
        const nextSetup = {
          ...currentSetup,
          platform_services: { selected_service_ids: serviceIds },
          infrastructure: configuration
        };
        if (Buffer.byteLength(JSON.stringify(nextSetup), "utf8") > 24000) {
          throw fail(400, "Application service settings are too large.", "APPLICATION_SERVICES_TOO_LARGE");
        }
        await saveAppSetupData(app, user.id, nextSetup);
        if (serviceIds.includes("data_sign_in")) {
          if (typeof prepareGeneratedAppAuth !== "function") {
            throw fail(503, "Application sign-in is unavailable right now.", "APP_AUTH_UNAVAILABLE");
          }
          const prepared = await prepareGeneratedAppAuth(app.id);
          if (!prepared || prepared.status < 200 || prepared.status >= 300) {
            throw fail(503, "Application sign-in could not be configured.", "APP_AUTH_CONFIGURATION_FAILED");
          }
        }
        response(res, 200, {
          services: nextSetup.platform_services,
          blocked_components,
          infrastructure: await resolveAppInfrastructure({ ...app, setup_data: nextSetup }, inputs)
        });
        return true;
      }
      if (resource === "infrastructure" && !record && method === "GET") {
        const inputs = await loadInputs(app);
        response(res, 200, { infrastructure: await resolveAppInfrastructure(app, inputs) });
        return true;
      }
      if (resource === "infrastructure" && !record && method === "PUT") {
        if (app.owner_id !== user.id) {
          throw fail(403, "Only the application owner can change infrastructure ownership.", "INFRASTRUCTURE_OWNER_APPROVAL_REQUIRED");
        }
        const configuration = normalizeInfrastructureConfiguration(body);
        const currentSetup = app.setup_data && typeof app.setup_data === "object" && !Array.isArray(app.setup_data)
          ? app.setup_data
          : {};
        const nextSetup = { ...currentSetup, infrastructure: configuration };
        if (Buffer.byteLength(JSON.stringify(nextSetup), "utf8") > 24000) {
          throw fail(400, "Application infrastructure configuration is too large.", "INFRASTRUCTURE_CONFIGURATION_TOO_LARGE");
        }
        await saveAppSetupData(app, user.id, nextSetup);
        response(res, 200, {
          infrastructure: await resolveAppInfrastructure({ ...app, setup_data: nextSetup }, await loadInputs(app))
        });
        return true;
      }
      if (resource === "lineage" && method === "GET") {
        const blueprintId = url.searchParams.get("blueprint_id") || null;
        const deploymentId = url.searchParams.get("deployment_id") || null;
        const verifyRemoteParameter = url.searchParams.get("verify_remote");
        if (verifyRemoteParameter !== null && !["true", "false"].includes(verifyRemoteParameter)) {
          throw fail(400, "Remote verification must be explicitly enabled or disabled.", "REMOTE_VERIFICATION_OPTION_INVALID");
        }
        if ((blueprintId && !UUID.test(blueprintId)) || (deploymentId && !UUID.test(deploymentId))) {
          throw fail(400, "Choose a valid Blueprint or deployment identifier.", "LINEAGE_CONTEXT_INVALID");
        }
        const inputs = await loadInputs(app);
        if ((blueprintId && !inputs.blueprints.some(item => item.id === blueprintId)) ||
            (deploymentId && !inputs.deployments.some(item => item.id === deploymentId))) {
          throw fail(404, "The selected Blueprint or deployment was not found for this application.", "LINEAGE_CONTEXT_NOT_FOUND");
        }
        let sourceEvidence = [];
        let sourceEvidenceAvailable = typeof loadSourceEvidence === "function";
        let sourceEvidenceError = null;
        if (sourceEvidenceAvailable) {
          try {
            sourceEvidence = await loadSourceEvidence({ appId, blueprintId, deploymentId });
            if (!Array.isArray(sourceEvidence)) throw new TypeError("Source evidence loader returned an invalid result.");
          } catch (error) {
            sourceEvidenceAvailable = false;
            sourceEvidenceError = /^[A-Z0-9_]{1,64}$/.test(error?.code || "")
              ? error.code
              : "SOURCE_EVIDENCE_UNAVAILABLE";
          }
        }
        let codeWorkspaceSource = { available: false, clean: false, commit: null, error_code: "CODE_WORKSPACE_UNAVAILABLE" };
        if (typeof loadCodeWorkspaceSource === "function") {
          try {
            const loaded = await loadCodeWorkspaceSource({ appId });
            if (loaded && typeof loaded === "object" && loaded.available === true) {
              codeWorkspaceSource = {
                available: true,
                clean: loaded.clean === true,
                commit: validCommit(loaded.commit),
                branch: typeof loaded.branch === "string" ? loaded.branch : null
              };
            } else if (loaded && typeof loaded === "object" && /^[A-Z0-9_]{1,64}$/.test(loaded.error_code || "")) {
              codeWorkspaceSource.error_code = loaded.error_code;
            }
          } catch (error) {
            codeWorkspaceSource.error_code = /^[A-Z0-9_]{1,64}$/.test(error?.code || "")
              ? error.code
              : "CODE_WORKSPACE_SOURCE_UNAVAILABLE";
          }
        }
        const lineage = resolveApplicationLineage({
          app,
          inputs,
          sourceEvidence,
          sourceEvidenceAvailable,
          codeWorkspaceSource,
          blueprintId,
          deploymentId
        });
        if (sourceEvidenceError) lineage.productionization.error_code = sourceEvidenceError;
        const verifyRemote = verifyRemoteParameter === "true";
        lineage.remote_verification = verifyRemote
          ? await checkRemoteSource({
              app,
              repositoryId: lineage.source.repository_id,
              branch: lineage.source.branch,
              expectedCommit: lineage.blueprint?.source_commit || lineage.source.code_commit
            })
          : lineage.source.repository_id
            ? {
                status: "NOT_CHECKED",
                branch: lineage.source.branch,
                expected_commit: lineage.blueprint?.source_commit || lineage.source.code_commit || null
              }
            : { status: "NOT_CONNECTED" };
        if (lineage.remote_verification.status === "REMOTE_DIVERGED") lineage.lineage_status = "DIVERGED";
        else if (lineage.remote_verification.status === "REMOTE_UNAVAILABLE" && lineage.lineage_status === "CONFIRMED") {
          lineage.lineage_status = "UNRESOLVED";
        }
        response(res, 200, { lineage });
        return true;
      }
      if (resource === "state" && !record && method === "GET") {
        const inputs = await loadInputs(app);
        const result = makeState(app, inputs, inputs.blueprints[0] || null);
        const buildRunnerReady = await buildRunnerAvailable(tableRequest);
        const deploymentWorker = await deploymentWorkerAvailability(tableRequest);
        response(res, 200, {
          contract: APPLICATION_STATE_CONTRACT,
          state: result.state,
          infrastructure: resolveInfrastructureContract({
            app,
            inputs,
            buildWorkerReady: buildRunnerReady,
            deploymentWorkerReady: deploymentWorker.ready,
            deploymentWorkerEnvironments: deploymentWorker.allowedEnvironments
          }),
          state_hash: result.state.blueprint.state_hash || applicationStateHash(result.state),
          yaml_preview: serializeApplicationBlueprint(result.state),
          persisted: result.persisted,
          features: {
            build_runner: buildRunnerReady,
            github: isGithubIntegrationConfigured(),
            deployment_provider: deploymentWorker.ready
          },
          latest_blueprint: result.blueprint ? {
            id: result.blueprint.id,
            version: result.blueprint.version,
            state_hash: result.blueprint.state_hash,
            status: result.blueprint.status
          } : null,
          delta: result.deltas,
          recorded_deltas: result.recordedDeltas
        });
        return true;
      }
      if (resource === "state" && record === "reconciliation" && !action && method === "GET") {
        const environmentKind = String(url.searchParams.get("environment") || "").toLowerCase();
        const asOf = url.searchParams.get("as_of") || new Date().toISOString();
        if (!ENVIRONMENTS.includes(environmentKind) || !Number.isFinite(Date.parse(asOf))) {
          throw fail(400, "Choose a valid reconciliation environment and as-of timestamp.", "RECONCILIATION_SCOPE_INVALID");
        }
        if (typeof findReconciliationRun !== "function") {
          throw fail(503, "Reconciliation evidence lookup is unavailable.", "RECONCILIATION_EVIDENCE_UNAVAILABLE");
        }
        const inputs = await loadInputs(app);
        const current = makeState(app, inputs, inputs.blueprints[0] || null);
        const scope = reconciliationScopeSnapshot(inputs, environmentKind, null, asOf);
        const context = typeof reconciliationContext === "function"
          ? await reconciliationContext({ app, inputs, current, environment: environmentKind, deployment: scope.deployment, actorId: user.id })
          : {};
        const sourceIdentity = context?.source_identity || fallbackReconciliationSource(app, current, inputs);
        const manifest = createDay2ReconciliationManifest({
          application: app,
          inputs,
          environment: environmentKind,
          environmentRecord: scope.environment,
          deployment: scope.deployment,
          desiredBlueprint: current.blueprint,
          desiredState: current.blueprint?.state || null,
          sourceIdentity,
          design: context?.design || { applicable: false },
          target: scope.target,
          observation: scope.observation,
          asOf,
          policyVersion: context?.policy_version,
          evaluatorVersions: context?.evaluator_versions
        });
        const prior = await findReconciliationRun({ app, scope: manifest.scope });
        const reconciliation = resolveStoredDay2Reconciliation(prior?.details?.day2_reconciliation || null, { bindings: manifest.bindings });
        response(res, 200, {
          contract: reconciliation.contract,
          reconciliation,
          latest_evaluation: prior ? {
            id: prior.id || null,
            created_at: prior.created_at || null,
            result_status: prior.result_status || null
          } : null
        });
        return true;
      }
      if (resource === "state" && record === "reconciliation" && action === "evaluate" && method === "POST") {
        const environmentKind = String(body.environment || "").toLowerCase();
        const asOf = body.as_of || new Date().toISOString();
        const freshnessMs = body.freshness_ms === undefined ? 15 * 60 * 1000 : Number(body.freshness_ms);
        const idempotencyKey = body.idempotency_key === undefined ? null : String(body.idempotency_key);
        if (!ENVIRONMENTS.includes(environmentKind) || !Number.isFinite(Date.parse(asOf)) ||
            !Number.isFinite(freshnessMs) || freshnessMs < 60_000 || freshnessMs > 7 * 24 * 60 * 60 * 1000 ||
            (idempotencyKey !== null && !/^[A-Za-z0-9._:-]{1,160}$/.test(idempotencyKey))) {
          throw fail(400, "Choose a valid reconciliation environment, as-of timestamp, freshness window, and idempotency key.", "RECONCILIATION_INPUT_INVALID");
        }
        if (typeof recordReconciliation !== "function" || typeof findReconciliationRun !== "function") {
          throw fail(503, "Reconciliation evidence persistence is unavailable.", "RECONCILIATION_EVIDENCE_UNAVAILABLE");
        }
        const inputs = await loadInputs(app);
        const current = makeState(app, inputs, inputs.blueprints[0] || null);
        const scope = reconciliationScopeSnapshot(inputs, environmentKind, null, asOf);
        const context = typeof reconciliationContext === "function"
          ? await reconciliationContext({ app, inputs, current, environment: environmentKind, deployment: scope.deployment, actorId: user.id })
          : {};
        const sourceIdentity = context?.source_identity || fallbackReconciliationSource(app, current, inputs);
        const deploymentWorker = await deploymentWorkerAvailability(tableRequest);
        const correlationId = typeof req.headers?.["x-request-id"] === "string" ? req.headers["x-request-id"].slice(0, 160) : null;
        const manifest = createDay2ReconciliationManifest({
          application: app,
          inputs,
          environment: environmentKind,
          environmentRecord: scope.environment,
          deployment: scope.deployment,
          desiredBlueprint: current.blueprint,
          desiredState: current.blueprint?.state || null,
          sourceIdentity,
          design: context?.design || { applicable: false },
          target: scope.target,
          observation: scope.observation,
          asOf,
          freshnessMs,
          idempotencyKey,
          actorId: user.id,
          correlationId,
          trigger: "manual",
          policyVersion: context?.policy_version,
          evaluatorVersions: context?.evaluator_versions,
          infrastructure: { worker_verified: deploymentWorker.ready, evaluator_version: context?.infrastructure?.evaluator_version || null }
        });
        const result = await withReconciliationRun(manifest.run_id, async () => {
          const prior = await findReconciliationRun({ app, runId: manifest.run_id, scope: manifest.scope });
          if (prior?.details?.day2_reconciliation) {
            await recordReconciliation({
              app,
              actorId: user.id,
              action: "day2_duplicate",
              resultStatus: "complete",
              summary: "Reused an identical Day-2 reconciliation run",
              details: {
                run_id: manifest.run_id,
                duplicate_of_action_id: prior.id || null,
                action_status: "superseded",
                idempotency_key: manifest.idempotency_key || null
              }
            });
            return {
              reused: true,
              reconciliation: resolveStoredDay2Reconciliation(prior.details.day2_reconciliation, { bindings: manifest.bindings }),
              evaluation: { id: prior.id || null, created_at: prior.created_at || null, result_status: prior.result_status || null }
            };
          }
          await recordReconciliation({
            app,
            actorId: user.id,
            action: "day2_started",
            resultStatus: "detected",
            summary: "Started a source-bound Day-2 reconciliation",
            details: {
              run_id: manifest.run_id,
              reconciliation_manifest: manifest,
              action_status: "detected"
            }
          });
          const previous = await findReconciliationRun({ app, scope: manifest.scope });
          const priorState = previous?.details?.day2_reconciliation
            ? resolveStoredDay2Reconciliation(previous.details.day2_reconciliation, { bindings: manifest.bindings })
            : null;
          if (previous && priorState?.state === "STALE") {
            await recordReconciliation({
              app,
              actorId: user.id,
              action: "day2_superseded",
              resultStatus: "complete",
              summary: "Superseded stale Day-2 reconciliation evidence",
              details: {
                run_id: manifest.run_id,
                superseded_run_id: previous.details.day2_reconciliation.run_id,
                action_status: "superseded",
                stale_reasons: priorState.stale_reasons || []
              }
            });
          }
          try {
            const reconciliation = evaluateDay2Reconciliation({
              application: app,
              inputs,
              environment: environmentKind,
              environmentRecord: scope.environment,
              deployment: scope.deployment,
              desiredBlueprint: current.blueprint,
              desiredState: current.blueprint?.state || null,
              currentState: current.state,
              sourceIdentity,
              sourceContext: {
                available: context?.available !== false,
                source_clean: context?.source_clean,
                classification_current: context?.classification?.is_current,
                classification_stale: context?.classification?.stale
              },
              design: context?.design || { applicable: false },
              configuration: context?.configuration || {},
              protectedContractChanges: context?.protected_contract_changes || [],
              target: scope.target,
              observation: scope.observation,
              asOf,
              freshnessMs,
              manifest,
              infrastructure: { worker_verified: deploymentWorker.ready, evaluator_version: context?.infrastructure?.evaluator_version || null }
            });
            await recordReconciliation({
              app,
              actorId: user.id,
              action: "day2_evaluated",
              resultStatus: reconciliation.action_status,
              summary: reconciliation.summary.headline,
              details: {
                run_id: reconciliation.run_id,
                day2_reconciliation: reconciliation,
                action_status: reconciliation.action_status,
                source_application_id: reconciliation.manifest.scope.application_id,
                source_workspace_id: reconciliation.manifest.source_identity.workspace_id,
                source_branch: reconciliation.manifest.source_identity.branch,
                source_checkpoint: reconciliation.manifest.source_identity.checkpoint,
                source_snapshot_sha256: reconciliation.manifest.source_identity.source_snapshot_sha256,
                classifier_version: reconciliation.manifest.source_identity.classifier_version,
                desired_blueprint_id: reconciliation.desired_snapshot.blueprint_id,
                observation_id: reconciliation.observed_snapshot?.observation_id || null
              }
            });
            return { reused: false, reconciliation, evaluation: null };
          } catch (error) {
            await recordReconciliation({
              app,
              actorId: user.id,
              action: "day2_failed",
              resultStatus: "failed",
              summary: "Day-2 reconciliation could not finish",
              details: {
                run_id: manifest.run_id,
                action_status: "failed",
                error_code: /^[A-Z0-9_]{1,96}$/.test(String(error?.code || "")) ? error.code : "RECONCILIATION_EVALUATION_FAILED"
              }
            });
            throw error;
          }
        });
        response(res, 200, { contract: result.reconciliation.contract, ...result });
        return true;
      }
      if (resource === "state" && record === "reconciliation" && action === "accept" && method === "POST") {
        if (app.owner_id !== user.id) throw fail(403, "Only the application owner can accept an observed change.", "OWNER_APPROVAL_REQUIRED");
        if (body.confirm !== true || !UUID.test(String(body.observation_id || "")) || body.delta_key !== "desired_state.unpersisted") {
          throw fail(400, "Confirm the unpersisted desired-state change and provide its observation identifier.");
        }
        if (typeof validateReconciliation !== "function" || typeof recordReconciliation !== "function") {
          throw fail(503, "Observed-change validation and audit recording are unavailable.");
        }
        const inputs = await loadInputs(app);
        const observation = inputs.observations.find(item => item.id === body.observation_id);
        if (!observation) throw fail(404, "Observed state was not found for this application.");
        const current = makeState(app, inputs, inputs.blueprints[0] || null);
        if (current.latestObservation?.id !== observation.id) {
          throw fail(409, "Refresh observed state and review the latest checkpoint before accepting a change.");
        }
        const delta = current.deltas.find(item => item.key === body.delta_key);
        if (current.persisted || !delta || delta.status !== "changed") {
          throw fail(409, "The selected desired-state change is no longer current.");
        }
        const desiredCommit = current.state.desired_state.code.commit;
        const observedCommit = observation.commit_sha;
        if (!sameFullCommit(desiredCommit, observedCommit)) {
          throw fail(409, "The observed source checkpoint is not represented by the application's current desired state. Reconcile its repository branch before accepting it.");
        }
        const sourceCheckpoint = inputs.codeCheckpoints.find(checkpoint => sameFullCommit(checkpoint.git_commit, observedCommit));
        if (!sourceCheckpoint) throw fail(409, "The observed source commit must match a CODE checkpoint recorded for this application.");
        const validation = await validateReconciliation({
          applicationId: app.id,
          sourceCommit: observedCommit,
          sourceCheckpointId: sourceCheckpoint.id,
          actorId: user.id
        });
        if (!validation?.ready_for_release || !validation?.source_commit ||
            !sameFullCommit(validation.source_commit, observedCommit)) {
          throw fail(409, validation?.reason || "Required source validation must pass for the observed checkpoint before acceptance.");
        }
        const persisted = await persistBlueprint(app, inputs, user);
        if (persisted.reused) throw fail(409, "The observed change does not produce a new desired-state version.");
        await recordReconciliation({
          app,
          actorId: user.id,
          action: "accept_external_change",
          details: {
            observation_id: observation.id,
            source_checkpoint_id: sourceCheckpoint.id,
            delta_key: delta.key,
            source_commit: validation.source_commit,
            validation_run_id: validation.run_id,
            previous_blueprint_id: inputs.blueprints[0]?.id || null,
            new_blueprint_id: persisted.blueprint.id,
            state_hash: persisted.state_hash
          }
        });
        response(res, 201, { accepted: true, blueprint: persisted.blueprint, state_hash: persisted.state_hash, observation_id: observation.id, validation_run_id: validation.run_id });
        return true;
      }
      if (resource === "state" && record === "reconciliation" && action === "restore" && method === "POST") {
        const environment = String(body.environment || "");
        const targetBlueprintId = String(body.target_blueprint_id || "");
        const reason = String(body.reason || "").trim();
        if (body.confirm !== true || !UUID.test(targetBlueprintId) || !ENVIRONMENTS.includes(environment) || reason.length < 1 || reason.length > 500) {
          throw fail(400, "Confirm a target Blueprint, deployment environment, and reason for restoration.");
        }
        if (typeof recordReconciliation !== "function") throw fail(503, "Reconciliation audit recording is unavailable.");
        const inputs = await loadInputs(app);
        const targetBlueprint = inputs.blueprints.find(item => item.id === targetBlueprintId);
        if (!targetBlueprint) throw fail(404, "The requested desired Blueprint was not found for this application.");
        const currentDeployment = inputs.deployments.find(item => item.environment === environment);
        const knownGood = inputs.deployments.find(item => item.environment === environment &&
          item.blueprint_id === targetBlueprintId && item.status === "HEALTHY");
        if (!currentDeployment || !knownGood) throw fail(409, "A current deployment and healthy deployment for the requested Blueprint are required to restore this environment.");
        if (currentDeployment.id === knownGood.id) throw fail(409, "This environment already runs the requested desired version.");
        requireManagedMutation(await resolveAppInfrastructure(app, inputs), ["runtime_hosting", "deployment_execution"]);
        const productionEnabled = process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED === "true" &&
          process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED === "true";
        const result = await serviceRequest("/rest/v1/rpc/feltus_request_deployment_rollback", {
          method: "POST",
          body: {
            p_app_id: app.id,
            p_current_deployment_id: currentDeployment.id,
            p_known_good_deployment_id: knownGood.id,
            p_actor_id: user.id,
            p_reason: reason,
            p_idempotency_key: String(body.idempotency_key || crypto.randomUUID()),
            p_production_enabled: productionEnabled
          }
        });
        const deployment = firstRow(result);
        if (result.status < 200 || result.status >= 300 || !deployment?.id) {
          throw fail(result.status >= 400 && result.status < 500 ? result.status : 502,
            result.data?.message || "Desired-version restoration could not be queued.");
        }
        await recordReconciliation({
          app,
          actorId: user.id,
          action: "restore_desired_state",
          details: {
            target_blueprint_id: targetBlueprint.id,
            target_blueprint_version: targetBlueprint.version,
            current_deployment_id: currentDeployment.id,
            known_good_deployment_id: knownGood.id,
            queued_deployment_id: deployment.id,
            environment,
            reason
          }
        });
        response(res, 202, { accepted: true, target_blueprint: { id: targetBlueprint.id, version: targetBlueprint.version, state_hash: targetBlueprint.state_hash }, deployment });
        return true;
      }
      if (resource === "blueprints" && method === "GET" && !record) {
        const result = await query("feltus_application_blueprints", tableRequest, {
          select: "id,app_id,version,parent_blueprint_id,parent_version,state_hash,state,status,created_by,created_at,source_commit",
          app_id: appFilter,
          order: "version.desc",
          limit: "100"
        });
        response(res, 200, { blueprints: firstSuccessful(result, "Blueprint history") });
        return true;
      }
      if (resource === "blueprints" && method === "POST" && !record) {
        if (Object.keys(body || {}).some(key => key !== "confirm")) throw fail(400, "Blueprint input must be saved in the app setup first.");
        const inputs = await loadInputs(app);
        const persisted = await persistBlueprint(app, inputs, user);
        const row = persisted.blueprint;
        response(res, 201, {
          blueprint: row,
          state_hash: persisted.state_hash,
          reused: persisted.reused,
          yaml: persisted.yaml,
          export_url: `/api/apps/${encodeURIComponent(appId)}/blueprints/${encodeURIComponent(row.id)}/export`
        });
        return true;
      }
      if (resource === "blueprints" && method === "GET" && recordId && action === "export") {
        const result = await query("feltus_application_blueprints", tableRequest, {
          select: "id,app_id,version,state_hash,state,status,created_by,created_at,parent_blueprint_id,parent_version,source_commit",
          id: `eq.${recordId}`,
          app_id: appFilter,
          limit: "1"
        });
        const row = firstSuccessful(result, "Blueprint")[0];
        if (!row) throw fail(404, "Blueprint not found.");
        const yaml = serializeApplicationBlueprint(row.state);
        res.writeHead(200, {
          "Content-Type": "application/yaml; charset=utf-8",
          "Content-Disposition": `attachment; filename="application.feltus.v${row.version}.yaml"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        res.end(yaml);
        return true;
      }
      if (resource === "environments" && method === "GET") {
        const inputs = await loadInputs(app);
        const states = makeState(app, inputs, inputs.blueprints[0] || null);
        const deploymentWorker = await deploymentWorkerAvailability(tableRequest);
        const environments = states.state.desired_state.environments.map(environment => {
          const deployments = inputs.deployments.filter(item => item.environment === environment.kind);
          const current = deployments[0] || null;
          const observation = current && inputs.observations.find(item => item.deployment_id === current.id) || null;
          const artifact = current && inputs.artifacts.find(item => item.id === current.artifact_id) || null;
          return {
            ...environment,
            current_blueprint: current?.blueprint_id ? inputs.blueprints.find(row => row.id === current.blueprint_id)?.version || null : null,
            current_artifact: artifact ? { id: artifact.id, digest: artifact.artifact_digest, status: artifact.verification_status } : null,
            available_artifact: (() => {
              const item = inputs.artifacts.find(candidate => candidate.verification_status === "passed" &&
                Array.isArray(candidate.environment_eligibility) && candidate.environment_eligibility.includes(environment.kind));
              return item ? { id: item.id, digest: item.artifact_digest, image: item.registry_image, blueprint_id: item.blueprint_id } : null;
            })(),
            health: observation?.health || "unknown",
            deployment: current ? { id: current.id, status: current.status, provider: current.provider, updated_at: current.completed_at || current.started_at || current.created_at } : null,
            can_configure_target: Boolean(deploymentWorker.ready && deploymentWorker.allowedEnvironments.includes(environment.kind) &&
              (environment.kind !== "production" || (process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED === "true" && process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED === "true"))),
            can_deploy: Boolean(deploymentWorker.ready && deploymentWorker.allowedEnvironments.includes(environment.kind) &&
              environment.provider === "coolify" && environment.resource_reference &&
              (environment.kind !== "production" || (process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED === "true" && process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED === "true")))
          };
        });
        response(res, 200, { environments });
        return true;
      }
      if (resource === "events" && method === "GET") {
        const requestedLimit = Number(url.searchParams.get("limit") || 50);
        const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), MAX_EVENT_LIMIT) : 50;
        const result = await query("feltus_audit_events", tableRequest, {
          select: "id,actor_user_id,actor_kind,request_id,blueprint_id,commit_sha,build_id,artifact_id,deployment_id,environment_id,event_category,event_severity,action_key,summary,after_data,created_at",
          app_id: appFilter,
          event_category: "not.is.null",
          order: "created_at.desc",
          limit: String(limit)
        });
        response(res, 200, { events: firstSuccessful(result, "Application activity").map(event => ({
          ...event,
          actor_id: event.actor_user_id,
          category: event.event_category,
          severity: event.event_severity,
          event_key: event.action_key,
          metadata: event.after_data
        })) });
        return true;
      }
      if (resource === "builds" && method === "GET") {
        const result = await query("feltus_builds", tableRequest, {
          select: "id,repository_id,blueprint_id,source_branch,commit_sha,status,attempt_count,exit_code,created_at,started_at,completed_at,failure_code",
          app_id: appFilter,
          order: "created_at.desc",
          limit: "100"
        });
        const builds = firstSuccessful(result, "Build history");
        if (!builds.length) {
          response(res, 200, { builds: [] });
          return true;
        }
        const buildIds = builds.map(build => build.id).filter(id => UUID.test(String(id)));
        if (!buildIds.length) {
          response(res, 200, { builds: builds.map(build => ({ ...build, steps: [] })) });
          return true;
        }
        const stepsResult = await query("feltus_build_steps", tableRequest, {
          select: "id,build_id,step_key,attempt,status,exit_code,error_code,log_text,started_at,completed_at,created_at",
          app_id: appFilter,
          build_id: "in.(" + buildIds.join(",") + ")",
          order: "created_at.asc",
          limit: "500"
        });
        const steps = firstSuccessful(stepsResult, "Build steps");
        response(res, 200, { builds: builds.map(build => ({
          ...build, steps: steps.filter(step => step.build_id === build.id)
        })) });
        return true;
      }
      if (resource === "builds" && method === "POST" && !record) {
        if (!await buildRunnerAvailable(tableRequest)) {
          response(res, 503, { error: "Builds are unavailable until an isolated build worker is online and the immutable artifact registry is configured." });
          return true;
        }
        const repositoryId = String(body.repository_id || "");
        const sourceBranch = String(body.branch || "");
        const commitSha = String(body.commit_sha || "");
        const idempotencyKey = String(body.idempotency_key || crypto.randomUUID());
        if (!UUID.test(repositoryId) || normalizeGithubBranch(sourceBranch) !== sourceBranch ||
            !/^[0-9a-f]{40,64}$/i.test(commitSha) || idempotencyKey.length > 200) {
          throw fail(400, "Choose a connected repository, branch, and full commit SHA.");
        }
        const inputs = await loadInputs(app);
        const currentState = makeState(app, inputs, inputs.blueprints[0] || null);
        if (!currentState.persisted || !currentState.blueprint) {
          throw fail(409, "Save the current application blueprint before starting a build.");
        }
        if (!inputs.repoLinks.some(link => link.repository_id === repositoryId)) {
          throw fail(400, "That repository is not connected to this application.");
        }
        const blueprintCode = currentState.state.desired_state.code;
        if ((blueprintCode.branch && sourceBranch !== blueprintCode.branch) ||
            (blueprintCode.commit && commitSha.toLowerCase() !== String(blueprintCode.commit).toLowerCase())) {
          throw fail(409, "Choose the branch and commit recorded in the current application blueprint.");
        }
        requireManagedMutation(await resolveAppInfrastructure(app, inputs), ["build_execution"]);
        const remoteVerification = await checkRemoteSource({
          app,
          repositoryId,
          branch: sourceBranch,
          expectedCommit: commitSha
        });
        requireVerifiedRemote(remoteVerification);
        if (typeof releaseReadiness === "function") {
          const gate = await releaseReadiness({ appId, sourceCommit: commitSha, blueprint: currentState.blueprint, actorId: user.id });
          if (!gate?.ready_for_release) throw fail(409, gate?.reason || "Required productionization checks must pass for this exact source checkpoint before a build can start.", gate?.code || "RELEASE_READINESS_REQUIRED");
        }
        const result = await serviceRequest("/rest/v1/rpc/feltus_queue_application_build", {
          method: "POST",
          body: {
            p_app_id: appId,
            p_repository_id: repositoryId,
            p_blueprint_id: currentState.blueprint.id,
            p_source_branch: sourceBranch,
            p_commit_sha: commitSha,
            p_actor_id: user.id,
            p_idempotency_key: idempotencyKey
          }
        });
        const build = firstRow(result);
        if (result.status < 200 || result.status >= 300 || !build?.id) {
          throw fail(result.status >= 400 && result.status < 500 ? result.status : 502,
            result.data?.message || result.data?.error || "The build could not be queued.");
        }
        response(res, 202, { build, remote_verification: remoteVerification });
        return true;
      }
      if (resource === "builds" && recordId && action === "cancel" && method === "POST") {
        const result = await serviceRequest("/rest/v1/rpc/feltus_cancel_build", {
          method: "POST",
          body: { p_app_id: appId, p_build_id: recordId, p_actor_id: user.id }
        });
        if (result.status < 200 || result.status >= 300) {
          throw fail(result.status >= 400 && result.status < 500 ? result.status : 502,
            result.data?.message || "The build could not be cancelled.");
        }
        response(res, 200, { cancelled: result.data === true || result.data === "true" });
        return true;
      }
      if (resource === "environments" && record === "target" && method === "POST") {
        const environment = String(body.environment || "");
        const reference = String(body.resource_reference || "");
        const productionEnabled = process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED === "true" &&
          process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED === "true";
        if (!ENVIRONMENTS.includes(environment) || !/^[A-Za-z0-9-]{3,80}$/.test(reference)) {
          throw fail(400, "Choose a valid environment and deployment resource reference.");
        }
        const deploymentWorker = await deploymentWorkerAvailability(tableRequest);
        if (!deploymentWorker.ready || !deploymentWorker.allowedEnvironments.includes(environment)) {
          throw fail(503, "Environment targets are unavailable because the deployment worker or this environment is not configured.");
        }
        if (environment === "production" && !productionEnabled) {
          throw fail(403, "Production target configuration is disabled.");
        }
        const inputs = await loadInputs(app);
        requireManagedMutation(await resolveAppInfrastructure(app, inputs), ["runtime_hosting", "deployment_execution"]);
        const result = await serviceRequest("/rest/v1/rpc/feltus_set_environment_target", {
          method: "POST",
          body: {
            p_app_id: appId,
            p_environment_kind: environment,
            p_resource_reference: reference,
            p_actor_id: user.id,
            p_production_enabled: productionEnabled
          }
        });
        const target = firstRow(result);
        if (result.status < 200 || result.status >= 300 || !target?.id) {
          throw fail(result.status >= 400 && result.status < 500 ? result.status : 502,
            result.data?.message || "The environment target could not be saved.");
        }
        response(res, 201, { target });
        return true;
      }
      if (resource === "deployments" && method === "GET") {
        const result = await query("feltus_deployments", tableRequest, {
          select: "id,environment,status,provider,provider_reference,blueprint_id,artifact_id,artifact_digest,commit_sha,rollback_reason,created_at,started_at,completed_at",
          app_id: appFilter,
          order: "created_at.desc",
          limit: "100"
        });
        response(res, 200, { deployments: firstSuccessful(result, "Deployment history") });
        return true;
      }
      if (resource === "deployments" && method === "POST" && !record) {
        const environment = String(body.environment || "");
        const artifactId = String(body.artifact_id || "");
        const idempotencyKey = String(body.idempotency_key || crypto.randomUUID());
        const productionEnabled = process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED === "true" &&
          process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED === "true";
        const deploymentWorker = await deploymentWorkerAvailability(tableRequest);
        const allowed = environment === "production"
          ? String(process.env.FELTUS_COOLIFY_ALLOWED_ENVIRONMENTS || "").split(",").map(value => value.trim().toLowerCase())
          : deploymentWorker.allowedEnvironments;
        if (!ENVIRONMENTS.includes(environment) || !UUID.test(artifactId) || idempotencyKey.length > 200) {
          throw fail(400, "Choose a valid environment and verified artifact.");
        }
        if ((environment === "production" && (!process.env.FELTUS_COOLIFY_URL || !process.env.FELTUS_COOLIFY_API_TOKEN)) ||
            (environment !== "production" && !deploymentWorker.ready) || !allowed.includes(environment)) {
          throw fail(503, "This deployment environment is unavailable because its provider path is not configured.");
        }
        if (environment === "preview") throw fail(409, "Temporary Preview deployment is not enabled until isolated preview provisioning is configured.");
        if (environment === "production" && !productionEnabled) throw fail(403, "Production deployment is disabled.");
        const inputs = await loadInputs(app);
        requireManagedMutation(await resolveAppInfrastructure(app, inputs), ["runtime_hosting", "deployment_execution"]);
        let remoteVerification = { status: "NOT_CONNECTED" };
        if (typeof releaseReadiness === "function") {
          const artifact = inputs.artifacts.find(item => item.id === artifactId);
          const blueprint = artifact && inputs.blueprints.find(item => item.id === artifact.blueprint_id);
          if (!artifact || !blueprint) throw fail(404, "The selected artifact Blueprint is unavailable for this application.");
          const sourceCommit = blueprint.state?.desired_state?.code?.commit || blueprint.source_commit;
          remoteVerification = await checkRemoteSource({
            app,
            repositoryId: blueprint.state?.desired_state?.code?.repository_id || null,
            branch: blueprint.state?.desired_state?.code?.branch || null,
            expectedCommit: sourceCommit
          });
          requireVerifiedRemote(remoteVerification);
          const gate = await releaseReadiness({ appId, sourceCommit, blueprint, actorId: user.id });
          if (!gate?.ready_for_release) throw fail(409, gate?.reason || "Required productionization checks must pass before deployment readiness is granted.", gate?.code || "RELEASE_READINESS_REQUIRED");
        }
        let result;
        try {
          result = await serviceRequest("/rest/v1/rpc/feltus_request_artifact_deployment", {
            method: "POST",
            body: {
              p_app_id: appId,
              p_environment_kind: environment,
              p_artifact_id: artifactId,
              p_actor_id: user.id,
              p_idempotency_key: idempotencyKey,
              p_production_enabled: productionEnabled
            }
          });
        } catch {
          throw fail(502, "Deployment could not be queued (DEPLOYMENT_RPC_UNAVAILABLE).", "DEPLOYMENT_RPC_UNAVAILABLE");
        }
        const deployment = firstRow(result);
        if (!result || result.status < 200 || result.status >= 300 || !deployment?.id) {
          const diagnosticCode = safeRpcDiagnosticCode(result?.data?.code);
          throw fail(result?.status >= 400 && result.status < 500 ? result.status : 502,
            `Deployment could not be queued (${diagnosticCode}).`, diagnosticCode);
        }
        response(res, 202, { deployment, remote_verification: remoteVerification });
        return true;
      }
      if (resource === "deployments" && record === "promote" && method === "POST") {
        const sourceDeploymentId = String(body.staging_deployment_id || "");
        if (!UUID.test(sourceDeploymentId)) throw fail(400, "Choose a Staging deployment to promote.");
        const productionEnabled = process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED === "true" &&
          process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED === "true";
        if (!productionEnabled || !process.env.FELTUS_COOLIFY_URL || !process.env.FELTUS_COOLIFY_API_TOKEN ||
            !process.env.FELTUS_COOLIFY_ALLOWED_ENVIRONMENTS?.split(",").map(value => value.trim()).includes("production")) {
          throw fail(403, "Production promotion is disabled.");
        }
        const inputs = await loadInputs(app);
        requireManagedMutation(await resolveAppInfrastructure(app, inputs), ["runtime_hosting", "deployment_execution"]);
        let remoteVerification = { status: "NOT_CONNECTED" };
        if (typeof releaseReadiness === "function") {
          const stagingResult = await query("feltus_deployments", tableRequest, {
            select: "id,blueprint_id,commit_sha",
            id: `eq.${sourceDeploymentId}`,
            app_id: `eq.${appId}`,
            environment: "eq.staging",
            limit: "1"
          });
          const sourceDeployment = firstSuccessful(stagingResult, "Staging deployment")[0];
          if (!sourceDeployment) throw fail(404, "The selected Staging deployment was not found for this application.");
          const blueprint = inputs.blueprints.find(item => item.id === sourceDeployment.blueprint_id);
          if (!blueprint) throw fail(404, "The Staging Blueprint is unavailable for this application.");
          const sourceCommit = blueprint.state?.desired_state?.code?.commit || sourceDeployment.commit_sha || blueprint.source_commit;
          remoteVerification = await checkRemoteSource({
            app,
            repositoryId: blueprint.state?.desired_state?.code?.repository_id || null,
            branch: blueprint.state?.desired_state?.code?.branch || null,
            expectedCommit: sourceCommit
          });
          requireVerifiedRemote(remoteVerification);
          const gate = await releaseReadiness({ appId, sourceCommit, blueprint, actorId: user.id });
          if (!gate?.ready_for_release) throw fail(409, gate?.reason || "Required productionization checks must pass before promotion.", gate?.code || "RELEASE_READINESS_REQUIRED");
        }
        const result = await serviceRequest("/rest/v1/rpc/feltus_request_artifact_promotion", {
          method: "POST",
          body: {
            p_app_id: appId,
            p_staging_deployment_id: sourceDeploymentId,
            p_actor_id: user.id,
            p_idempotency_key: String(body.idempotency_key || crypto.randomUUID()),
            p_production_enabled: productionEnabled
          }
        });
        const deployment = firstRow(result);
        if (result.status < 200 || result.status >= 300 || !deployment?.id) {
          throw fail(result.status >= 400 && result.status < 500 ? result.status : 502,
            result.data?.message || "Promotion could not be queued.");
        }
        response(res, 202, { deployment, remote_verification: remoteVerification });
        return true;
      }
      if (resource === "deployments" && recordId && action === "rollback" && method === "POST") {
        const previousId = String(body.known_good_deployment_id || "");
        const reason = String(body.reason || "").trim();
        if (!UUID.test(previousId) || reason.length < 1 || reason.length > 500) {
          throw fail(400, "Choose a previous healthy deployment and enter a rollback reason.");
        }
        const inputs = await loadInputs(app);
        requireManagedMutation(await resolveAppInfrastructure(app, inputs), ["runtime_hosting", "deployment_execution"]);
        const productionEnabled = process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED === "true" &&
          process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED === "true";
        const result = await serviceRequest("/rest/v1/rpc/feltus_request_deployment_rollback", {
          method: "POST",
          body: {
            p_app_id: appId,
            p_current_deployment_id: recordId,
            p_known_good_deployment_id: previousId,
            p_actor_id: user.id,
            p_reason: reason,
            p_idempotency_key: String(body.idempotency_key || crypto.randomUUID()),
            p_production_enabled: productionEnabled
          }
        });
        const deployment = firstRow(result);
        if (result.status < 200 || result.status >= 300 || !deployment?.id) {
          throw fail(result.status >= 400 && result.status < 500 ? result.status : 502,
            result.data?.message || "Rollback could not be queued.");
        }
        response(res, 202, { deployment });
        return true;
      }
      response(res, 405, { error: "Method not allowed." }, { Allow: "GET, POST" });
      return true;
    } catch (error) {
      const body = {
        error: error?.publicCode
          ? error.message
          : error?.status && error.status < 500
            ? error.message
            : "Application state could not be loaded. Try again shortly."
      };
      if (typeof error?.publicCode === "string" && /^[A-Z0-9_]{1,64}$/.test(error.publicCode)) {
        body.error_code = error.publicCode;
      }
      response(res, Number.isInteger(error?.status) ? error.status : 502, body);
      return true;
    }
  };
}
