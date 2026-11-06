import { createHash } from "node:crypto";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { canonicalJson } from "./feltus-application-state.js";

const PRIVATE_NETWORKS = new BlockList();
for (const [subnet, prefix, type] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"], ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"], ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"], ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"], ["::1", 128, "ipv6"], ["::ffff:0:0", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"], ["100::", 64, "ipv6"], ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"], ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"]
]) PRIVATE_NETWORKS.addSubnet(subnet, prefix, type);

function failure(code, retryable = false) {
  return Object.assign(new Error(code), { code, retryable });
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function safeUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeResourceReference(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]{3,80}$/.test(value);
}

function safeImageName(value) {
  return typeof value === "string" && value.length <= 255 &&
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/.test(value);
}

export function registryRepositoryWithoutTag(registryImage) {
  if (!safeImageName(registryImage)) throw failure("ARTIFACT_REFERENCE_INVALID");
  const finalPathComponent = registryImage.lastIndexOf("/") + 1;
  const tagSeparator = registryImage.indexOf(":", finalPathComponent);
  return tagSeparator === -1 ? registryImage : registryImage.slice(0, tagSeparator);
}

function coolifyDigestTag(artifactDigest) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(artifactDigest || "");
  if (!match) throw failure("ARTIFACT_REFERENCE_INVALID");
  return `sha256-${match[1]}`;
}

function coolifyDeploymentId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
}

function envAllowed(kind, allowedEnvironments, productionEnabled) {
  return allowedEnvironments.has(kind) && (kind !== "production" || productionEnabled);
}

function retryableProviderStatus(status) {
  return ["queued", "in_progress", "running", "building", "deploying", "starting"].includes(status);
}

function terminalProviderStatus(status) {
  if (retryableProviderStatus(status)) return "in_progress";
  if (["finished", "success", "succeeded", "healthy", "completed"].includes(status)) return "finished";
  if (["failed", "error", "cancelled", "canceled", "rollback_failed"].includes(status)) return "failed";
  return "unknown";
}

function isPublicAddress(address, family) {
  const type = family === 4 ? "ipv4" : "ipv6";
  return isIP(address) === family && !PRIVATE_NETWORKS.check(address, type);
}

async function requestHealth(url, timeoutMs = 8_000) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(host);
  const records = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address, record.family))) {
    throw failure("HEALTHCHECK_ADDRESS_NOT_PUBLIC", false);
  }
  const pinned = records[0];

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => request.destroy(failure("HEALTHCHECK_TIMEOUT", true)), timeoutMs);
    const request = https.request(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      servername: literalFamily ? undefined : host,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, records);
        else callback(null, pinned.address, pinned.family);
      }
    }, response => {
      response.resume();
      response.on("end", () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode || 0, durationMs: Date.now() - startedAt });
      });
    });
    const startedAt = Date.now();
    request.on("error", error => {
      clearTimeout(timer);
      reject(error?.code ? failure("HEALTHCHECK_TLS_OR_NETWORK_ERROR", true) : error);
    });
    request.end();
  });
}

async function readDomainRows(rest, deployment) {
  return rest(
    "/rest/v1/feltus_deployment_domains?select=id,domain_name,tls_status,verified_at" +
    `&app_id=eq.${encodeURIComponent(deployment.app_id)}` +
    `&environment_id=eq.${encodeURIComponent(deployment.environment_id)}` +
    "&tls_status=neq.disabled&order=created_at.asc&limit=10"
  );
}

async function probeEnvironment(rest, deployment) {
  const domains = await readDomainRows(rest, deployment);
  let lastReason = "HEALTHCHECK_DOMAIN_MISSING";
  for (const domain of Array.isArray(domains) ? domains : []) {
    const url = new URL(`https://${domain.domain_name}/api/health`);
    const readinessUrl = new URL("/api/ready", url);
    try {
      const health = await requestHealth(url);
      if (health.status !== 200) {
        lastReason = `HEALTHCHECK_HTTP_${health.status}`;
        continue;
      }
      const ready = await requestHealth(readinessUrl);
      if (ready.status !== 200) {
        lastReason = `READINESS_HTTP_${ready.status}`;
        continue;
      }
      if (domain.tls_status !== "active" || !domain.verified_at) {
        await rest(`/rest/v1/feltus_deployment_domains?id=eq.${encodeURIComponent(domain.id)}`, {
          method: "PATCH",
          prefer: "return=minimal",
          body: { tls_status: "active", verified_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        });
      }
      return { healthy: true, domain: domain.domain_name, durationMs: Math.max(health.durationMs, ready.durationMs) };
    } catch (error) {
      lastReason = /^[A-Z0-9_]{1,64}$/.test(error?.code || "") ? error.code : "HEALTHCHECK_FAILED";
    }
  }
  return { healthy: false, reason: lastReason, durationMs: 0 };
}

export function createInfrastructureWorker({
  rest,
  coolify,
  workerId,
  leaseSeconds = 180,
  allowedEnvironments = [],
  resourceMap = {},
  productionEnabled = false,
  healthGraceMs = 180_000,
  now = () => Date.now(),
  probeEnvironmentFn = probeEnvironment
} = {}) {
  if (typeof rest !== "function") throw new Error("Infrastructure worker requires a database request function.");
  if (!coolify) throw new Error("Infrastructure worker requires a configured Coolify client.");
  const allowed = new Set(allowedEnvironments);
  const targetMap = new Map();
  for (const [kind, references] of Object.entries(resourceMap || {})) {
    if (!["development", "staging", "production"].includes(kind)) continue;
    const values = Array.isArray(references) ? references : [references];
    const filtered = new Set(values.filter(safeResourceReference));
    if (filtered.size) targetMap.set(kind, filtered);
  }
  const enabled = [...allowed].some(kind => targetMap.get(kind)?.size);
  let lastReconcileAt = 0;
  let lastErrorCode = null;

  async function loadContext(command) {
    const deployment = firstRow(await rest(
      `/rest/v1/feltus_deployments?select=id,organization_id,app_id,environment_id,environment,status,provider,provider_reference,artifact_id,started_at` +
      `&id=eq.${encodeURIComponent(command.deployment_id)}&limit=1`
    ));
    const target = firstRow(await rest(
      `/rest/v1/feltus_deployment_targets?select=id,organization_id,app_id,environment_id,provider_key,provider_resource_reference,active` +
      `&id=eq.${encodeURIComponent(command.target_id)}&limit=1`
    ));
    const environment = firstRow(await rest(
      `/rest/v1/feltus_environments?select=id,organization_id,app_id,kind,status` +
      `&id=eq.${encodeURIComponent(command.environment_id)}&limit=1`
    ));
    const artifact = firstRow(await rest(
      `/rest/v1/feltus_artifacts?select=id,organization_id,app_id,registry_image,artifact_digest,verification_status` +
      `&id=eq.${encodeURIComponent(command.artifact_id)}&limit=1`
    ));

    if (!deployment || !target || !environment || !artifact) throw failure("OUTBOX_REFERENCE_MISSING");
    if (deployment.id !== command.deployment_id || target.id !== command.target_id ||
        environment.id !== command.environment_id || artifact.id !== command.artifact_id ||
        deployment.app_id !== command.app_id || target.app_id !== command.app_id ||
        environment.app_id !== command.app_id || artifact.app_id !== command.app_id ||
        deployment.organization_id !== command.organization_id || target.organization_id !== command.organization_id ||
        environment.organization_id !== command.organization_id || artifact.organization_id !== command.organization_id ||
        deployment.environment_id !== command.environment_id || target.environment_id !== command.environment_id) {
      throw failure("OUTBOX_SCOPE_MISMATCH");
    }
    if (!envAllowed(environment.kind, allowed, productionEnabled)) throw failure("ENVIRONMENT_NOT_ENABLED");
    if (target.provider_key !== command.provider_key || command.provider_key !== "coolify") {
      throw failure("DEPLOYMENT_PROVIDER_MISMATCH");
    }
    if (!target.active && ["deploy_artifact", "configure_domain_tls"].includes(command.command_type)) {
      throw failure("DEPLOYMENT_TARGET_DISABLED");
    }
    if (deployment.status === "FAILED" || deployment.status === "CANCELLED" || deployment.status === "ROLLED_BACK") {
      throw failure("DEPLOYMENT_NOT_EXECUTABLE");
    }
    if (!safeResourceReference(target.provider_resource_reference)) throw failure("COOLIFY_RESOURCE_REFERENCE_INVALID");
    if (!targetMap.get(environment.kind)?.has(target.provider_resource_reference)) {
      throw failure("COOLIFY_TARGET_NOT_MAPPED");
    }
    if (command.command_type === "deploy_artifact") {
      if (artifact.verification_status !== "passed") throw failure("ARTIFACT_NOT_VERIFIED");
      if (!/^sha256:[0-9a-f]{64}$/.test(artifact.artifact_digest || "")) {
        throw failure("ARTIFACT_REFERENCE_INVALID");
      }
      registryRepositoryWithoutTag(artifact.registry_image);
    }
    return { deployment, target, environment, artifact };
  }

  async function callRpc(name, body) {
    return rest(`/rest/v1/rpc/${name}`, { method: "POST", body });
  }

  async function deploymentOperation(command, context, signal) {
    const { target, artifact } = context;
    const imageName = `${registryRepositoryWithoutTag(artifact.registry_image)}@sha256`;
    const imageTag = coolifyDigestTag(artifact.artifact_digest);
    const application = await coolify.getApplication(target.provider_resource_reference, { signal });
    if (!application || !["dockerimage", "docker_image", "docker-image"].includes(String(application.build_pack || "").toLowerCase())) {
      throw failure("COOLIFY_RESOURCE_NOT_DOCKER_IMAGE");
    }

    const history = await coolify.listApplicationDeployments(target.provider_resource_reference, { signal });
    const createdAt = Date.parse(command.created_at || "");
    const existing = (Array.isArray(history) ? history : []).find(item => {
      const timestamp = Date.parse(item.created_at || "");
      const status = String(item.status || "").toLowerCase();
      return item.docker_registry_image_tag === imageTag &&
        item.deployment_uuid && Number.isFinite(timestamp) && Number.isFinite(createdAt) &&
        timestamp >= createdAt && !["failed", "error", "cancelled", "canceled"].includes(status);
    });
    if (existing && coolifyDeploymentId(existing.deployment_uuid)) return existing.deployment_uuid;

    await coolify.updateApplication(target.provider_resource_reference, {
      docker_registry_image_name: imageName,
      docker_registry_image_tag: imageTag
    }, { signal });
    const refreshed = await coolify.getApplication(target.provider_resource_reference, { signal });
    if (refreshed?.docker_registry_image_name !== imageName ||
        refreshed?.docker_registry_image_tag !== imageTag) {
      throw failure("COOLIFY_IMAGE_CONFIGURATION_MISMATCH", true);
    }

    const latestContext = await loadContext(command);
    if (latestContext.artifact.artifact_digest !== artifact.artifact_digest ||
        latestContext.target.provider_resource_reference !== target.provider_resource_reference) {
      throw failure("DEPLOYMENT_INPUT_CHANGED", false);
    }
    const historyAfterConfiguration = await coolify.listApplicationDeployments(target.provider_resource_reference, { signal });
    const acceptedDuringConfiguration = (Array.isArray(historyAfterConfiguration) ? historyAfterConfiguration : []).find(item => {
      const timestamp = Date.parse(item.created_at || "");
      const status = String(item.status || "").toLowerCase();
      return item.docker_registry_image_tag === imageTag && item.deployment_uuid &&
        Number.isFinite(timestamp) && Number.isFinite(createdAt) && timestamp >= createdAt &&
        !["failed", "error", "cancelled", "canceled"].includes(status);
    });
    if (acceptedDuringConfiguration && coolifyDeploymentId(acceptedDuringConfiguration.deployment_uuid)) {
      return acceptedDuringConfiguration.deployment_uuid;
    }
    const result = await coolify.deployApplication(target.provider_resource_reference, { signal });
    const deployments = Array.isArray(result?.deployments) ? result.deployments : [];
    const accepted = deployments.find(item =>
      item.resource_uuid === target.provider_resource_reference && coolifyDeploymentId(item.deployment_uuid)
    ) || deployments.find(item => coolifyDeploymentId(item.deployment_uuid));
    if (!accepted) throw failure("COOLIFY_DEPLOYMENT_REFERENCE_MISSING", true);
    return accepted.deployment_uuid;
  }

  async function configureDomain(command, context, signal) {
    const domainId = command.command_payload?.domain_id;
    if (!safeUuid(domainId)) throw failure("DOMAIN_REFERENCE_INVALID");
    const domain = firstRow(await rest(
      `/rest/v1/feltus_deployment_domains?select=id,organization_id,app_id,environment_id,domain_name,tls_status` +
      `&id=eq.${encodeURIComponent(domainId)}&app_id=eq.${encodeURIComponent(command.app_id)}` +
      `&environment_id=eq.${encodeURIComponent(command.environment_id)}&limit=1`
    ));
    if (!domain || domain.organization_id !== command.organization_id || domain.tls_status === "disabled") {
      throw failure("DOMAIN_NOT_CONFIGURABLE");
    }
    const reference = context.target.provider_resource_reference;
    const application = await coolify.getApplication(reference, { signal });
    if (["dockercompose", "docker-compose"].includes(String(application?.build_pack || "").toLowerCase())) {
      throw failure("COOLIFY_COMPOSE_DOMAIN_CONFIGURATION_UNSUPPORTED");
    }
    const configured = String(application?.fqdn || "").split(",").map(value => value.trim()).filter(Boolean);
    const host = `https://${domain.domain_name}`;
    const domains = [...new Set([...configured, host])].join(",");

    const findAccepted = async configHash => {
      if (!configHash) return null;
      const history = await coolify.listApplicationDeployments(reference, { signal });
      const commandTime = Date.parse(command.created_at || "");
      return (Array.isArray(history) ? history : []).find(item => {
        const createdAt = Date.parse(item.created_at || "");
        const status = String(item.status || "").toLowerCase();
        return item.configuration_hash === configHash && item.deployment_uuid &&
          Number.isFinite(createdAt) && Number.isFinite(commandTime) && createdAt >= commandTime &&
          !["failed", "error", "cancelled", "canceled"].includes(status);
      }) || null;
    };
    const recordIssuing = async deploymentUuid => {
      await rest(`/rest/v1/feltus_deployment_domains?id=eq.${encodeURIComponent(domain.id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: { tls_status: "issuing", provider_reference: deploymentUuid, updated_at: new Date().toISOString() }
      });
    };

    const prior = await findAccepted(application.config_hash);
    if (prior && coolifyDeploymentId(prior.deployment_uuid)) {
      await recordIssuing(prior.deployment_uuid);
      return prior.deployment_uuid;
    }

    await coolify.updateApplication(reference, { domains, is_force_https_enabled: true }, { signal });
    const refreshed = await coolify.getApplication(reference, { signal });
    const refreshedHosts = String(refreshed?.fqdn || "").split(",").map(value => {
      try { return new URL(value.trim()).hostname.toLowerCase(); } catch { return ""; }
    });
    if (!refreshedHosts.includes(domain.domain_name)) {
      throw failure("COOLIFY_DOMAIN_CONFIGURATION_MISMATCH", true);
    }
    if (!refreshed.config_hash) throw failure("COOLIFY_IDEMPOTENCY_EVIDENCE_MISSING");
    await loadContext(command);
    const acceptedBeforeDispatch = await findAccepted(refreshed.config_hash);
    if (acceptedBeforeDispatch && coolifyDeploymentId(acceptedBeforeDispatch.deployment_uuid)) {
      await recordIssuing(acceptedBeforeDispatch.deployment_uuid);
      return acceptedBeforeDispatch.deployment_uuid;
    }
    const result = await coolify.deployApplication(reference, { signal });
    const deployments = Array.isArray(result?.deployments) ? result.deployments : [];
    const accepted = deployments.find(item =>
      item.resource_uuid === reference && coolifyDeploymentId(item.deployment_uuid)
    ) || deployments.find(item => coolifyDeploymentId(item.deployment_uuid));
    if (!accepted) throw failure("COOLIFY_DEPLOYMENT_REFERENCE_MISSING", true);
    await recordIssuing(accepted.deployment_uuid);
    return accepted.deployment_uuid;
  }

  async function teardownEnvironment(command, context, signal) {
    if (context.environment.kind === "production") throw failure("PRODUCTION_TEARDOWN_BLOCKED");
    if (context.environment.status !== "tearing_down") throw failure("ENVIRONMENT_TEARDOWN_NOT_AUTHORIZED");
    if (["QUEUED", "BUILDING", "DEPLOYING"].includes(context.deployment.status)) {
      throw failure("DEPLOYMENT_STILL_ACTIVE");
    }
    try {
      await coolify.stopApplication(context.target.provider_resource_reference, { signal });
    } catch (error) {
      if (error?.code !== "COOLIFY_HTTP_404") throw error;
    }
    return `stopped:${context.target.provider_resource_reference}:${command.id}`;
  }

  async function processOne(command) {
    if (!command || !safeUuid(command.id) || !safeUuid(command.lease_token)) return false;
    const controller = new AbortController();
    let leaseLost = false;
    let heartbeatRunning = false;
    const renewLease = async () => {
      if (heartbeatRunning || leaseLost) return;
      heartbeatRunning = true;
      try {
        const renewed = await callRpc("feltus_heartbeat_infrastructure_outbox", {
          p_outbox_id: command.id,
          p_lease_token: command.lease_token,
          p_lease_seconds: leaseSeconds
        });
        if (renewed !== true) {
          leaseLost = true;
          controller.abort();
        }
      } catch {
        leaseLost = true;
        controller.abort();
      } finally {
        heartbeatRunning = false;
      }
    };
    await renewLease();
    const timer = setInterval(renewLease, Math.max(5_000, Math.floor(leaseSeconds * 1000 / 3)));
    try {
      if (leaseLost) return false;
      const context = await loadContext(command);
      let providerOperationId;
      switch (command.command_type) {
        case "deploy_artifact":
          providerOperationId = await deploymentOperation(command, context, controller.signal);
          break;
        case "reconcile_deployment": {
          const reference = context.deployment.provider_reference || command.provider_operation_id;
          if (!coolifyDeploymentId(reference)) throw failure("PROVIDER_DEPLOYMENT_REFERENCE_MISSING");
          const providerDeployment = await coolify.getDeployment(reference, { signal: controller.signal });
          const state = terminalProviderStatus(String(providerDeployment?.status || "").toLowerCase());
          if (state === "failed") throw failure("COOLIFY_DEPLOYMENT_FAILED");
          if (state !== "finished") throw failure("COOLIFY_DEPLOYMENT_STATUS_UNKNOWN", true);
          providerOperationId = reference;
          break;
        }
        case "configure_domain_tls":
          providerOperationId = await configureDomain(command, context, controller.signal);
          break;
        case "teardown_environment":
          providerOperationId = await teardownEnvironment(command, context, controller.signal);
          break;
        default:
          throw failure("OUTBOX_COMMAND_UNSUPPORTED");
      }
      if (leaseLost) return false;
      const completed = await callRpc("feltus_complete_infrastructure_outbox", {
        p_outbox_id: command.id,
        p_lease_token: command.lease_token,
        p_provider_operation_id: providerOperationId
      });
      if (completed === true) lastErrorCode = null;
      return completed === true;
    } catch (error) {
      if (leaseLost) return false;
      const code = /^[A-Z0-9_]{1,64}$/.test(error?.code || "") ? error.code : "INFRASTRUCTURE_WORKER_ERROR";
      lastErrorCode = code;
      const retryable = error?.retryable !== false;
      try {
        await callRpc("feltus_retry_infrastructure_outbox", {
          p_outbox_id: command.id,
          p_lease_token: command.lease_token,
          p_error_code: code,
          p_retryable: retryable
        });
      } catch {
        // The lease recovery path is authoritative when the database is unavailable.
      }
      return false;
    } finally {
      clearInterval(timer);
      if (controller.signal.aborted) controller.abort();
    }
  }

  async function reconcileDeployment(deployment) {
    if (!deployment?.provider_reference || !safeUuid(deployment.id)) return false;
    const environment = firstRow(await rest(
      `/rest/v1/feltus_environments?select=id,kind,status&id=eq.${encodeURIComponent(deployment.environment_id)}&limit=1`
    ));
    if (!environment || !envAllowed(environment.kind, allowed, productionEnabled)) return false;
    const target = firstRow(await rest(
      `/rest/v1/feltus_deployment_targets?select=id,provider_resource_reference` +
      `&app_id=eq.${encodeURIComponent(deployment.app_id)}` +
      `&environment_id=eq.${encodeURIComponent(deployment.environment_id)}` +
      "&provider_key=eq.coolify&limit=1"
    ));
    if (!target || !safeResourceReference(target.provider_resource_reference)) return false;
    if (!targetMap.get(environment.kind)?.has(target.provider_resource_reference)) return false;

    const provider = await coolify.getDeployment(deployment.provider_reference);
    const providerStatus = String(provider?.status || "").toLowerCase();
    const terminal = terminalProviderStatus(providerStatus);
    if (terminal === "unknown" || terminal === "in_progress") return false;
    let nextStatus;
    let checkStatus;
    let summary;
    let health = { provider: "coolify", provider_status: providerStatus };

    if (terminal === "failed") {
      nextStatus = "FAILED";
      checkStatus = "unhealthy";
      summary = "Coolify reported deployment failure.";
    } else {
      const probe = await probeEnvironmentFn(rest, deployment);
      health.health_check = probe;
      if (probe.healthy) {
        nextStatus = "HEALTHY";
        checkStatus = "healthy";
        summary = "Coolify deployment and HTTPS readiness checks passed.";
      } else {
        const startedAt = Date.parse(deployment.started_at || deployment.created_at || "");
        const elapsed = Number.isFinite(startedAt) ? now() - startedAt : healthGraceMs;
        if (elapsed < healthGraceMs) return false;
        nextStatus = "DEGRADED";
        checkStatus = "degraded";
        summary = "Coolify deployment completed, but HTTPS readiness checks did not pass.";
      }
    }

    const observedAt = new Date(now()).toISOString();
    const healthStatus = checkStatus === "healthy" ? "healthy" : ["unhealthy", "degraded"].includes(checkStatus) ? "unhealthy" : "unknown";
    const observation = {
      deployment_id: deployment.id,
      environment: environment.kind,
      provider: deployment.provider || "coolify",
      provider_deployment_id: deployment.provider_reference,
      blueprint_id: deployment.blueprint_id || null,
      commit_sha: deployment.commit_sha || null,
      artifact_id: deployment.artifact_id || null,
      artifact_digest: deployment.artifact_digest || null,
      deployment_state: nextStatus.toLowerCase(),
      provider_status: providerStatus,
      reconciliation_status: nextStatus === "HEALTHY" ? "verified" : nextStatus === "FAILED" ? "failed" : "degraded",
      health: healthStatus,
      runtime_health: health.health_check || null,
      observed_at: observedAt
    };
    const identity = {
      deployment_id: observation.deployment_id,
      environment: observation.environment,
      provider: observation.provider,
      provider_deployment_id: observation.provider_deployment_id,
      blueprint_id: observation.blueprint_id,
      commit_sha: observation.commit_sha,
      artifact_id: observation.artifact_id,
      artifact_digest: observation.artifact_digest,
      deployment_state: observation.deployment_state,
      provider_status: observation.provider_status,
      reconciliation_status: observation.reconciliation_status,
      health: observation.health,
      runtime_health_status: observation.runtime_health?.healthy === true
        ? "healthy"
        : observation.runtime_health?.reason || (observation.runtime_health ? "unhealthy" : null)
    };
    const stateHash = createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex");
    observation.state_hash = stateHash;

    const existingObservation = firstRow(await rest(
      `/rest/v1/feltus_observed_application_states?select=id,state_hash&app_id=eq.${encodeURIComponent(deployment.app_id)}` +
      `&deployment_id=eq.${encodeURIComponent(deployment.id)}&state_hash=eq.${stateHash}&limit=1`
    ));
    if (existingObservation && deployment.status === nextStatus) return false;

    const result = await rest(
      `/rest/v1/feltus_deployments?id=eq.${encodeURIComponent(deployment.id)}` +
      `&status=eq.${encodeURIComponent(deployment.status)}`,
      {
        method: "PATCH",
        prefer: "return=representation",
        body: {
          status: nextStatus,
          service_health: health,
          ...(nextStatus === "FAILED" || nextStatus === "HEALTHY" ? { completed_at: new Date(now()).toISOString() } : {})
        }
      }
    );
    if (!Array.isArray(result) || !result.length) return false;
    await rest("/rest/v1/feltus_deployment_health_checks", {
      method: "POST",
      prefer: "return=minimal",
      body: {
        organization_id: deployment.organization_id,
        app_id: deployment.app_id,
        deployment_id: deployment.id,
        environment_id: deployment.environment_id,
        status: checkStatus,
        duration_ms: Math.max(0, Math.min(2_147_483_647, health.health_check?.durationMs || 0)),
        safe_summary: summary,
        safe_metadata: health
      }
    });

    const recordedObservation = firstRow(await callRpc("feltus_record_observed_application_state", {
      p_app_id: deployment.app_id,
      p_observed: observation
    }));
    if (!recordedObservation?.id) throw failure("OBSERVED_STATE_RECORD_FAILED", true);

    const deltas = [];
    const desiredBlueprint = firstRow(await rest(
      `/rest/v1/feltus_application_blueprints?select=id,version,state&app_id=eq.${encodeURIComponent(deployment.app_id)}` +
      "&order=version.desc&limit=1"
    ));
    if (!desiredBlueprint) {
      deltas.push({ key: "blueprint.version", path: "blueprint.version", status: "unknown", desired: null, observed: recordedObservation.blueprint_version || null });
    } else if (desiredBlueprint.id !== deployment.blueprint_id || Number(desiredBlueprint.version) !== Number(recordedObservation.blueprint_version)) {
      deltas.push({
        key: "blueprint.version",
        path: "blueprint.version",
        status: "changed",
        desired: { id: desiredBlueprint.id, version: Number(desiredBlueprint.version) },
        observed: { id: deployment.blueprint_id || null, version: recordedObservation.blueprint_version || null }
      });
    }

    if (desiredBlueprint?.id && deployment.artifact_digest) {
      const desiredArtifact = firstRow(await rest(
        `/rest/v1/feltus_artifacts?select=id,artifact_digest&app_id=eq.${encodeURIComponent(deployment.app_id)}` +
        `&blueprint_id=eq.${encodeURIComponent(desiredBlueprint.id)}&verification_status=eq.passed&order=created_at.desc&limit=1`
      ));
      if (desiredArtifact && desiredArtifact.artifact_digest !== deployment.artifact_digest) {
        deltas.push({
          key: "artifact.digest",
          path: "artifact.digest",
          status: "changed",
          desired: desiredArtifact.artifact_digest,
          observed: deployment.artifact_digest
        });
      }
    }
    if (healthStatus !== "healthy") {
      deltas.push({
        key: "health",
        path: "health",
        status: healthStatus === "unknown" ? "unknown" : "changed",
        desired: "healthy",
        observed: healthStatus
      });
    }
    if (deltas.length) {
      await callRpc("feltus_record_application_state_deltas", {
        p_app_id: deployment.app_id,
        p_observed_state_id: recordedObservation.id,
        p_deltas: deltas
      });
    }
    lastErrorCode = null;
    return true;
  }

  async function reconcileActiveDeployments({ force = false } = {}) {
    const intervalMs = 30_000;
    if (!force && now() - lastReconcileAt < intervalMs) return 0;
    lastReconcileAt = now();
    const deployments = await rest(
      "/rest/v1/feltus_deployments?select=id,organization_id,app_id,environment_id,environment,status,provider,provider_reference,blueprint_id,artifact_id,artifact_digest,commit_sha,started_at,created_at" +
      "&provider=eq.coolify&status=in.(DEPLOYING,DEGRADED,HEALTHY,FAILED)&provider_reference=not.is.null&order=started_at.asc&limit=20"
    );
    let reconciled = 0;
    for (const deployment of Array.isArray(deployments) ? deployments : []) {
      try {
        if (await reconcileDeployment(deployment)) reconciled += 1;
      } catch (error) {
        // One provider outage or endpoint failure must not block other deployments.
        lastErrorCode = /^[A-Z0-9_]{1,64}$/.test(error?.code || "") ? error.code : "RECONCILIATION_FAILED";
      }
    }
    return reconciled;
  }

  async function processNext() {
    if (!enabled) return false;
    const commands = await callRpc("feltus_claim_infrastructure_outbox", {
      p_worker_id: workerId,
      p_limit: 1,
      p_lease_seconds: leaseSeconds
    });
    if (!Array.isArray(commands) || !commands[0]) return false;
    return processOne(commands[0]);
  }

  return Object.freeze({
    enabled,
    health: () => ({ enabled, last_error_code: lastErrorCode }),
    processNext,
    processOne,
    reconcileActiveDeployments
  });
}
