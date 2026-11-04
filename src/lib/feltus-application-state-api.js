import crypto from "node:crypto";
import { isGithubIntegrationConfigured, normalizeGithubBranch } from "./feltus-github.js";
import {
  APPLICATION_STATE_CONTRACT,
  applicationStateHash,
  applicationStateIdentity,
  canonicalJson,
  compareDesiredAndObserved,
  createBlueprintRevision,
  normalizeApplicationState,
  serializeApplicationBlueprint
} from "./feltus-application-state.js";

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

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
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
  if (process.env.FELTUS_BUILD_RUNNER_ENABLED !== "true" ||
      !process.env.FELTUS_ARTIFACT_REGISTRY || !process.env.FELTUS_ARTIFACT_REGISTRY_TOKEN) return false;
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

function lifecycleStatus(app) {
  if (app.setup_status === "archived") return "archived";
  if (app.setup_status === "configuring") return "configuring";
  if (app.setup_status === "draft") return "draft";
  return "active";
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

function mapDesiredState({ app, models, columns, relationships, documents, aiSettings, repositories, repoBranches, environments, targets }) {
  const fieldsByModel = new Map();
  for (const column of columns) {
    const fields = fieldsByModel.get(column.model_id) || [];
    fields.push({
      id: column.id,
      name: column.column_name,
      data_type: column.data_type,
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
  const linkedBranch = linkedRepo && repoBranches.find(branch =>
    branch.repository_id === linkedRepo.id && branch.branch_name === branchName
  );
  const targetByEnvironment = new Map(targets.map(target => [target.environment_id, target]));
  const envByKind = new Map(environments.map(environment => [environment.kind, environment]));
  const instructionText = aiSettings.instructions || aiSettings.system_prompt || "";

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
      commit: code.commit_sha || linkedBranch?.latest_commit_sha || null,
      status: code.status || (linkedRepo ? "connected" : "not_connected")
    },
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

export function createApplicationStateHandler({ tableRequest, serviceRequest, readBody, getUser }) {
  if (typeof tableRequest !== "function" || typeof serviceRequest !== "function" || typeof readBody !== "function" || typeof getUser !== "function") {
    throw new TypeError("Application state API requires tableRequest, serviceRequest, readBody, and getUser.");
  }

  async function loadApp(appId, ownerId) {
    const result = await query("feltus_applications", tableRequest, {
      select: "id,owner_id,app_name,app_type,environment,setup_status,setup_data,setup_current_step,setup_completed_steps,created_at,setup_updated_at",
      id: `eq.${appId}`,
      owner_id: `eq.${ownerId}`,
      limit: "1"
    });
    return firstSuccessful(result, "Application")[0] || null;
  }

  async function loadInputs(app) {
    const appId = app.id;
    const common = `eq.${appId}`;
    const [modelsResult, relationshipsResult, documentsResult, environmentsResult, targetsResult,
      repoLinksResult, repoBranchesResult, blueprintsResult, buildsResult, artifactsResult, deploymentsResult, observationsResult, stateDeltasResult] = await Promise.all([
      query("feltus_models", tableRequest, { select: "id,logical_name,physical_table_name,rls_enabled,created_at", app_id: common, order: "created_at.asc", limit: "500" }),
      query("feltus_model_relationships", tableRequest, { select: "id,source_model_id,source_column,target_model_id,target_column,on_delete_action,created_at", app_id: common, order: "created_at.asc", limit: "1000" }),
      query("feltus_documents", tableRequest, { select: "id,original_name,processing_status,metadata,created_at,processed_at", app_id: common, order: "created_at.asc", limit: "500" }),
      query("feltus_environments", tableRequest, { select: "id,name,kind,status,created_at", app_id: common, order: "created_at.asc", limit: "20" }),
      query("feltus_deployment_targets", tableRequest, { select: "id,environment_id,provider_key,provider_resource_reference,active", app_id: common, active: "eq.true", limit: "20" }),
      query("feltus_project_repositories", tableRequest, { select: "repository_id,created_at", app_id: common, order: "created_at.desc", limit: "20" }),
      query("feltus_repository_branches", tableRequest, { select: "repository_id,branch_name,is_default,latest_commit_sha,updated_at", app_id: common, order: "updated_at.desc", limit: "100" }),
      query("feltus_application_blueprints", tableRequest, { select: "id,app_id,version,parent_blueprint_id,parent_version,state_hash,state,status,created_by,created_at,source_commit", app_id: common, order: "version.desc", limit: "100" }),
      query("feltus_builds", tableRequest, { select: "id,repository_id,blueprint_id,source_branch,commit_sha,status,created_at,completed_at", app_id: common, order: "created_at.desc", limit: "100" }),
      query("feltus_artifacts", tableRequest, { select: "id,build_id,blueprint_id,registry_image,artifact_digest,verification_status,environment_eligibility,created_at,verified_at", app_id: common, order: "created_at.desc", limit: "100" }),
      query("feltus_deployments", tableRequest, { select: "id,environment,environment_id,status,provider,provider_reference,blueprint_id,artifact_id,artifact_digest,commit_sha,created_at,started_at,completed_at", app_id: common, order: "created_at.desc", limit: "100" }),
      query("feltus_observed_application_states", tableRequest, { select: "id,deployment_id,environment,provider,provider_deployment_id,blueprint_id,blueprint_version,commit_sha,artifact_digest,health,state_hash,observed_state,observed_at", app_id: common, order: "observed_at.desc", limit: "20" }),
      query("feltus_application_state_deltas", tableRequest, { select: "id,observed_state_id,blueprint_id,delta_key,path,status,desired_value,observed_value,created_at", app_id: common, order: "created_at.desc", limit: "200" })
    ]);
    const models = firstSuccessful(modelsResult, "Data models");
    const columnsResult = models.length
      ? await tableRequest("feltus_model_columns", "GET", {
          query: `?select=id,model_id,column_name,data_type,is_nullable,ordinal_position&model_id=in.(${models.map(model => model.id).join(",")})&order=ordinal_position.asc&limit=2000`
        })
      : { status: 200, data: [] };
    const links = firstSuccessful(repoLinksResult, "Repository links");
    const repositoriesResult = links.length
      ? await tableRequest("feltus_repositories", "GET", {
          query: `?select=id,repository_name,default_branch,archived_at&id=in.(${links.map(link => link.repository_id).join(",")})`
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
      repoBranches: firstSuccessful(repoBranchesResult, "Repository branches"),
      repositories: firstSuccessful(repositoriesResult, "Repositories"),
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
        status: app.setup_status === "archived" ? "archived" : "draft",
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
    return {
      state: normalizeApplicationState(dynamicState),
      blueprint,
      persisted: blueprintMatches,
      latestDeployment,
      latestObservation,
      deltas: compareDesiredAndObserved(state, latestObservation),
      recordedDeltas
    };
  }

  return async function handleApplicationStateApi(req, res, url) {
    const match = /^\/api\/apps\/([0-9a-f-]{36})\/(state|blueprints|environments|events|builds|deployments)(?:\/([0-9a-f-]{36}|target|promote))?(?:\/(export|cancel|rollback))?$/i.exec(url.pathname);
    if (!match) return false;
    const [, appId, resource, record, action] = match;
    const recordId = UUID.test(record || "") ? record : null;
    if (!UUID.test(appId) || (record && !recordId && !["target", "promote"].includes(record))) {
      response(res, 400, { error: "A valid application reference is required." });
      return true;
    }
    const user = getUser();
    if (!user?.id) {
      response(res, 401, { error: "Authentication required." });
      return true;
    }
    try {
      const app = await loadApp(appId, user.id);
      if (!app) {
        response(res, 404, { error: "Application not found." });
        return true;
      }
      const method = String(req.method || "GET").toUpperCase();
      const appFilter = `eq.${appId}`;
      if (resource === "state" && !record && method === "GET") {
        const inputs = await loadInputs(app);
        const result = makeState(app, inputs, inputs.blueprints[0] || null);
        const buildRunnerReady = await buildRunnerAvailable(tableRequest);
        response(res, 200, {
          contract: APPLICATION_STATE_CONTRACT,
          state: result.state,
          state_hash: result.state.blueprint.state_hash || applicationStateHash(result.state),
          yaml_preview: serializeApplicationBlueprint(result.state),
          persisted: result.persisted,
          features: {
            build_runner: buildRunnerReady,
            github: isGithubIntegrationConfigured(),
            deployment_provider: Boolean(process.env.FELTUS_COOLIFY_URL && process.env.FELTUS_COOLIFY_API_TOKEN)
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
        if (app.setup_status === "archived") throw fail(409, "Archived applications cannot create a blueprint.");
        const body = await readBody(req, 4096);
        if (Object.keys(body || {}).some(key => key !== "confirm")) throw fail(400, "Blueprint input must be saved in the app setup first.");
        const inputs = await loadInputs(app);
        const current = makeState(app, inputs, null).state;
        const revision = createBlueprintRevision({ state: current, parent: inputs.blueprints[0] || null, createdBy: user.id });
        const alreadyPersisted = inputs.blueprints[0]?.state_hash === revision.blueprint.state_hash;
        const identity = canonicalJson(applicationStateIdentity(revision));
        const result = await tableRequest("rpc/feltus_create_application_blueprint", "POST", {
          body: {
            p_app_id: appId,
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
        response(res, 201, { blueprint: row, state_hash: row.state_hash, reused: alreadyPersisted });
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
            can_configure_target: Boolean(process.env.FELTUS_COOLIFY_URL && process.env.FELTUS_COOLIFY_API_TOKEN &&
              (environment.kind !== "production" || (process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED === "true" && process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED === "true"))),
            can_deploy: Boolean(process.env.FELTUS_COOLIFY_URL && process.env.FELTUS_COOLIFY_API_TOKEN &&
              String(process.env.FELTUS_COOLIFY_ALLOWED_ENVIRONMENTS || "").split(",").map(value => value.trim().toLowerCase()).includes(environment.kind) &&
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
          select: "id,repository_id,blueprint_id,source_branch,commit_sha,status,attempt_count,created_at,started_at,completed_at,failure_code",
          app_id: appFilter,
          order: "created_at.desc",
          limit: "100"
        });
        response(res, 200, { builds: firstSuccessful(result, "Build history") });
        return true;
      }
      if (resource === "builds" && method === "POST" && !record) {
        if (!await buildRunnerAvailable(tableRequest)) {
          response(res, 503, { error: "Builds are unavailable until an isolated build worker is online and the immutable artifact registry is configured." });
          return true;
        }
        const body = await readBody(req, 4096);
        const repositoryId = String(body.repository_id || "");
        const sourceBranch = String(body.branch || "");
        const commitSha = String(body.commit_sha || "");
        const idempotencyKey = String(body.idempotency_key || crypto.randomUUID());
        if (!UUID.test(repositoryId) || normalizeGithubBranch(sourceBranch) !== sourceBranch ||
            !/^[0-9a-f]{40,64}$/i.test(commitSha) || idempotencyKey.length > 200) {
          throw fail(400, "Choose a connected repository, branch, and full commit SHA.");
        }
        const inputs = await loadInputs(app);
        const currentState = makeState(app, inputs, null);
        if (!currentState.persisted || !currentState.blueprint) {
          throw fail(409, "Save the current application blueprint before starting a build.");
        }
        if (!inputs.repoLinks.some(link => link.repository_id === repositoryId)) {
          throw fail(400, "That repository is not connected to this application.");
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
        response(res, 202, { build });
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
        const body = await readBody(req, 4096);
        const environment = String(body.environment || "");
        const reference = String(body.resource_reference || "");
        const productionEnabled = process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED === "true" &&
          process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED === "true";
        if (!ENVIRONMENTS.includes(environment) || !/^[A-Za-z0-9-]{3,80}$/.test(reference)) {
          throw fail(400, "Choose a valid environment and deployment resource reference.");
        }
        if (!process.env.FELTUS_COOLIFY_URL || !process.env.FELTUS_COOLIFY_API_TOKEN) {
          throw fail(503, "Environment targets are unavailable because the deployment provider is not configured.");
        }
        if (environment === "production" && !productionEnabled) {
          throw fail(403, "Production target configuration is disabled.");
        }
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
        const body = await readBody(req, 4096);
        const environment = String(body.environment || "");
        const artifactId = String(body.artifact_id || "");
        const idempotencyKey = String(body.idempotency_key || crypto.randomUUID());
        const productionEnabled = process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED === "true" &&
          process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED === "true";
        const allowed = String(process.env.FELTUS_COOLIFY_ALLOWED_ENVIRONMENTS || "")
          .split(",").map(value => value.trim().toLowerCase());
        if (!ENVIRONMENTS.includes(environment) || !UUID.test(artifactId) || idempotencyKey.length > 200) {
          throw fail(400, "Choose a valid environment and verified artifact.");
        }
        if (!process.env.FELTUS_COOLIFY_URL || !process.env.FELTUS_COOLIFY_API_TOKEN || !allowed.includes(environment)) {
          throw fail(503, "This deployment environment is unavailable because its provider path is not configured.");
        }
        if (environment === "preview") throw fail(409, "Temporary Preview deployment is not enabled until isolated preview provisioning is configured.");
        if (environment === "production" && !productionEnabled) throw fail(403, "Production deployment is disabled.");
        const result = await serviceRequest("/rest/v1/rpc/feltus_request_artifact_deployment", {
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
        const deployment = firstRow(result);
        if (result.status < 200 || result.status >= 300 || !deployment?.id) {
          throw fail(result.status >= 400 && result.status < 500 ? result.status : 502,
            result.data?.message || "Deployment could not be queued.");
        }
        response(res, 202, { deployment });
        return true;
      }
      if (resource === "deployments" && record === "promote" && method === "POST") {
        const body = await readBody(req, 4096);
        const sourceDeploymentId = String(body.staging_deployment_id || "");
        if (!UUID.test(sourceDeploymentId)) throw fail(400, "Choose a Staging deployment to promote.");
        const productionEnabled = process.env.FELTUS_PRODUCTION_DEPLOYMENTS_ENABLED === "true" &&
          process.env.FELTUS_COOLIFY_PRODUCTION_ENABLED === "true";
        if (!productionEnabled || !process.env.FELTUS_COOLIFY_URL || !process.env.FELTUS_COOLIFY_API_TOKEN ||
            !process.env.FELTUS_COOLIFY_ALLOWED_ENVIRONMENTS?.split(",").map(value => value.trim()).includes("production")) {
          throw fail(403, "Production promotion is disabled.");
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
        response(res, 202, { deployment });
        return true;
      }
      if (resource === "deployments" && recordId && action === "rollback" && method === "POST") {
        const body = await readBody(req, 4096);
        const previousId = String(body.known_good_deployment_id || "");
        const reason = String(body.reason || "").trim();
        if (!UUID.test(previousId) || reason.length < 1 || reason.length > 500) {
          throw fail(400, "Choose a previous healthy deployment and enter a rollback reason.");
        }
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
      response(res, Number.isInteger(error?.status) ? error.status : 502, {
        error: error?.status && error.status < 500 ? error.message : "Application state could not be loaded. Try again shortly."
      });
      return true;
    }
  };
}
