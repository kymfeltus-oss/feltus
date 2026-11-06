import assert from "node:assert/strict";
import { createCoolifyClient } from "../src/lib/feltus-coolify.js";
import { createInfrastructureWorker } from "../src/lib/feltus-infrastructure-worker.js";

const outboxId = "71000000-0000-4000-8000-000000000001";
const deploymentId = "72000000-0000-4000-8000-000000000001";
const targetId = "73000000-0000-4000-8000-000000000001";
const environmentId = "74000000-0000-4000-8000-000000000001";
const artifactId = "75000000-0000-4000-8000-000000000001";
const appId = "76000000-0000-4000-8000-000000000001";
const orgId = "77000000-0000-4000-8000-000000000001";
const ownerId = "78000000-0000-4000-8000-000000000001";
const leaseToken = "79000000-0000-4000-8000-000000000001";
const domainId = "7a000000-0000-4000-8000-000000000001";
const resourceReference = "coolify-app-123";
const image = "ghcr.io/feltus/app";
const digest = `sha256:${"a".repeat(64)}`;

const outboxCommand = {
  id: outboxId,
  organization_id: orgId,
  app_id: appId,
  environment_id: environmentId,
  target_id: targetId,
  artifact_id: artifactId,
  deployment_id: deploymentId,
  provider_key: "coolify",
  command_type: "deploy_artifact",
  command_payload: {},
  lease_token: leaseToken,
  created_at: "2026-11-03T12:00:00.000Z"
};

function fixtures(environmentKind = "staging", targetActive = true, artifactStatus = "passed", environmentStatus = "active", deploymentStatus = "QUEUED", providerHistory = [], registryImage = image) {
  let coolifyImage = {
    docker_registry_image_name: "ghcr.io/feltus/old",
    docker_registry_image_tag: "old",
    fqdn: "https://old.example.test",
    config_hash: "old-config"
  };
  const calls = [];
  const deployment = {
    id: deploymentId,
    organization_id: orgId,
    app_id: appId,
    environment_id: environmentId,
    environment: environmentKind,
    status: deploymentStatus,
    provider: "coolify",
    artifact_id: artifactId,
    started_at: null
  };
  const target = {
    id: targetId,
    organization_id: orgId,
    app_id: appId,
    environment_id: environmentId,
    provider_key: "coolify",
    provider_resource_reference: resourceReference,
    active: targetActive
  };
  const environment = { id: environmentId, organization_id: orgId, app_id: appId, kind: environmentKind, status: environmentStatus };
  const artifact = {
    id: artifactId,
    organization_id: orgId,
    app_id: appId,
    registry_image: registryImage,
    artifact_digest: digest,
    verification_status: artifactStatus
  };
  const rest = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.includes("feltus_heartbeat_infrastructure_outbox")) return true;
    if (path.includes("feltus_complete_infrastructure_outbox")) return true;
    if (path.includes("feltus_retry_infrastructure_outbox")) return true;
    if (path.includes("/feltus_deployments?")) return [deployment];
    if (path.includes("/feltus_deployment_targets?")) return [target];
    if (path.includes("/feltus_environments?")) return [environment];
    if (path.includes("/feltus_artifacts?")) return [artifact];
    if (path.includes("/feltus_deployment_domains?")) {
      if (options.method === "PATCH") return [];
      return [{
        id: domainId,
        organization_id: orgId,
        app_id: appId,
        environment_id: environmentId,
        domain_name: "staging.example.test",
        tls_status: "pending"
      }];
    }
    throw new Error(`Unexpected database request: ${path}`);
  };
  const coolify = {
    async getApplication(reference) {
      assert.equal(reference, resourceReference);
      return { build_pack: "dockerimage", ...coolifyImage };
    },
    async listApplicationDeployments(reference) {
      assert.equal(reference, resourceReference);
      return providerHistory;
    },
    async updateApplication(reference, body) {
      assert.equal(reference, resourceReference);
      calls.push({ coolify_update: body });
      coolifyImage = {
        ...coolifyImage,
        ...body,
        ...(body.domains ? { fqdn: body.domains, config_hash: "updated-config" } : {})
      };
      return { uuid: reference };
    },
    async deployApplication(reference) {
      assert.equal(reference, resourceReference);
      calls.push({ coolify_deploy: reference });
      return { deployments: [{ resource_uuid: reference, deployment_uuid: "coolify-deploy-456" }] };
    },
    async getDeployment() { return { status: "finished" }; },
    async stopApplication(reference) {
      calls.push({ coolify_stop: reference });
      return { message: "stopped" };
    }
  };
  return { rest, coolify, calls };
}

{
  const { rest, coolify, calls } = fixtures("staging", true, "revoked", "active", "HEALTHY");
  const worker = createInfrastructureWorker({ rest, coolify, workerId: "worker-test", allowedEnvironments: ["staging"], resourceMap: { staging: [resourceReference] } });
  const command = { ...outboxCommand, command_type: "configure_domain_tls", command_payload: { domain_id: domainId } };
  assert.equal(await worker.processOne(command), true);
  assert.ok(calls.some(call => call.coolify_update?.is_force_https_enabled === true));
  assert.ok(calls.some(call => call.coolify_deploy));
  assert.ok(calls.some(call => call.path?.startsWith("/rest/v1/feltus_deployment_domains?") && call.method === "PATCH"));
  console.log("PASS domain/TLS commands use the scoped domain record and force HTTPS on the mapped resource");
}

{
  const { rest, coolify, calls } = fixtures("staging", true, "revoked", "tearing_down", "HEALTHY");
  const worker = createInfrastructureWorker({ rest, coolify, workerId: "worker-test", allowedEnvironments: ["staging"], resourceMap: { staging: [resourceReference] } });
  const command = { ...outboxCommand, command_type: "teardown_environment" };
  assert.equal(await worker.processOne(command), true);
  assert.ok(calls.some(call => call.coolify_stop === resourceReference));
  console.log("PASS teardown requires a non-production environment already marked for teardown");
}

{
  const { rest, coolify, calls } = fixtures("staging", true, "revoked", "active", "DEPLOYING");
  const worker = createInfrastructureWorker({ rest, coolify, workerId: "worker-test", allowedEnvironments: ["staging"], resourceMap: { staging: [resourceReference] } });
  const command = { ...outboxCommand, command_type: "reconcile_deployment", provider_operation_id: "coolify-deploy-456" };
  assert.equal(await worker.processOne(command), true);
  assert.ok(calls.some(call => call.path?.includes("feltus_complete_infrastructure_outbox")));
  console.log("PASS reconciliation reads provider state without requiring a deployable artifact");
}

{
  const requests = [];
  const client = createCoolifyClient({
    baseUrl: "https://coolify.example.test",
    apiToken: "unit-test-token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ deployments: [{ resource_uuid: "app-1", deployment_uuid: "deploy-1" }] });
    }
  });
  await client.deployApplication("app-1");
  assert.match(requests[0].url, /\/api\/v1\/deploy\?uuid=app-1&cancel_previous=queued$/);
  assert.equal(requests[0].options.headers.Authorization, "Bearer unit-test-token");
  assert.equal(requests[0].options.redirect, "manual");
  assert.throws(() => createCoolifyClient({ baseUrl: "http://coolify.example.test", apiToken: "token" }));
  assert.throws(() => createCoolifyClient({
    baseUrl: "http://8.8.8.8",
    apiToken: "token",
    allowHttp: true
  }));
  assert.doesNotThrow(() => createCoolifyClient({
    baseUrl: "http://coolify.internal:8000",
    apiToken: "token",
    allowHttp: true
  }));

  const redirectClient = createCoolifyClient({
    baseUrl: "https://coolify.example.test",
    apiToken: "unit-test-token",
    fetchImpl: async () => new Response("", { status: 302, headers: { Location: "https://other.example.test" } })
  });
  await assert.rejects(redirectClient.getApplication("app-1"), error => error.code === "COOLIFY_REDIRECT_BLOCKED");
  console.log("PASS Coolify client keeps credentials server-side, requires HTTPS, and blocks redirects");
}

{
  const { rest, coolify, calls } = fixtures();
  const worker = createInfrastructureWorker({
    rest,
    coolify,
    workerId: "worker-test",
    allowedEnvironments: ["staging"],
    resourceMap: { staging: [resourceReference] }
  });
  assert.equal(await worker.processOne(outboxCommand), true);
  const updateIndex = calls.findIndex(call => call.coolify_update);
  const deployIndex = calls.findIndex(call => call.coolify_deploy);
  assert.ok(updateIndex >= 0 && deployIndex > updateIndex, "the immutable image digest is configured before deploy");
  assert.deepEqual(calls[updateIndex].coolify_update, {
    docker_registry_image_name: image,
    docker_registry_image_tag: digest
  });
  assert.ok(calls.some(call => call.path?.includes("feltus_complete_infrastructure_outbox")));
  console.log("PASS outbox deployment validates scope and artifact, configures the digest, then completes the lease");
}

{
  const generatedImage = `ghcr.io/feltus/${appId}:build-${outboxId}`;
  const { rest, coolify, calls } = fixtures("staging", true, "passed", "active", "QUEUED", [], generatedImage);
  const worker = createInfrastructureWorker({
    rest,
    coolify,
    workerId: "worker-test",
    allowedEnvironments: ["staging"],
    resourceMap: { staging: [resourceReference] }
  });
  assert.equal(await worker.processOne(outboxCommand), true);
  assert.deepEqual(calls.find(call => call.coolify_update)?.coolify_update, {
    docker_registry_image_name: generatedImage,
    docker_registry_image_tag: digest
  });
  assert.ok(calls.some(call => call.coolify_deploy));
  console.log("PASS generated per-build image tags pass infrastructure artifact validation");
}

{
  const history = [{
    docker_registry_image_tag: digest,
    deployment_uuid: "coolify-deploy-previous-attempt",
    created_at: "2026-11-03T12:01:00.000Z",
    status: "in_progress"
  }];
  const { rest, coolify, calls } = fixtures("staging", true, "passed", "active", "QUEUED", history);
  const worker = createInfrastructureWorker({ rest, coolify, workerId: "worker-test", allowedEnvironments: ["staging"], resourceMap: { staging: [resourceReference] } });
  assert.equal(await worker.processOne(outboxCommand), true);
  assert.equal(calls.some(call => call.coolify_deploy), false);
  assert.equal(calls.some(call => call.coolify_update), false);
  assert.ok(calls.some(call => call.path?.includes("feltus_complete_infrastructure_outbox")));
  console.log("PASS retries adopt an already accepted deployment with the same immutable digest");
}

{
  const { rest, coolify, calls } = fixtures("production");
  const worker = createInfrastructureWorker({
    rest,
    coolify,
    workerId: "worker-test",
    allowedEnvironments: ["staging"],
    resourceMap: { staging: [resourceReference] }
  });
  assert.equal(await worker.processOne(outboxCommand), false);
  assert.equal(calls.some(call => call.coolify_update || call.coolify_deploy), false);
  const retry = calls.find(call => call.path?.includes("feltus_retry_infrastructure_outbox"));
  assert.equal(retry?.body?.p_error_code, "ENVIRONMENT_NOT_ENABLED");
  assert.equal(retry?.body?.p_retryable, false);
  console.log("PASS production outbox commands fail closed unless explicitly enabled");
}

{
  const { rest, coolify, calls } = fixtures();
  const worker = createInfrastructureWorker({
    rest,
    coolify,
    workerId: "worker-test",
    allowedEnvironments: ["staging"],
    resourceMap: { staging: ["different-coolify-resource"] }
  });
  assert.equal(await worker.processOne(outboxCommand), false);
  assert.equal(calls.some(call => call.coolify_update || call.coolify_deploy), false);
  const retry = calls.find(call => call.path?.includes("feltus_retry_infrastructure_outbox"));
  assert.equal(retry?.body?.p_error_code, "COOLIFY_TARGET_NOT_MAPPED");
  assert.equal(worker.enabled, true);
  console.log("PASS staging dispatch is blocked when its mapped Coolify resource does not match");
}

{
  const { rest, coolify, calls } = fixtures("staging", true, "revoked");
  const worker = createInfrastructureWorker({
    rest,
    coolify,
    workerId: "worker-test",
    allowedEnvironments: ["staging"],
    resourceMap: { staging: [resourceReference] }
  });
  assert.equal(await worker.processOne(outboxCommand), false);
  assert.equal(calls.some(call => call.coolify_update || call.coolify_deploy), false);
  const retry = calls.find(call => call.path?.includes("feltus_retry_infrastructure_outbox"));
  assert.equal(retry?.body?.p_error_code, "ARTIFACT_NOT_VERIFIED");
  console.log("PASS revoked artifacts are rejected before contacting Coolify");
}

{
  const currentBlueprintId = "7b000000-0000-4000-8000-000000000001";
  const deployedBlueprintId = "7b000000-0000-4000-8000-000000000002";
  const deployment = {
    id: deploymentId,
    organization_id: orgId,
    app_id: appId,
    environment_id: environmentId,
    environment: "staging",
    status: "DEPLOYING",
    provider: "coolify",
    provider_reference: "coolify-deploy-456",
    blueprint_id: deployedBlueprintId,
    artifact_id: artifactId,
    artifact_digest: digest,
    commit_sha: "a".repeat(40),
    started_at: "2026-11-03T12:00:00.000Z",
    created_at: "2026-11-03T12:00:00.000Z"
  };
  const target = {
    id: targetId,
    organization_id: orgId,
    app_id: appId,
    environment_id: environmentId,
    provider_key: "coolify",
    provider_resource_reference: resourceReference
  };
  const environment = { id: environmentId, organization_id: orgId, app_id: appId, kind: "staging", status: "active" };
  const calls = [];
  const savedObservations = [];
  const rest = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.includes("/feltus_deployments?") && options.method === "PATCH") {
      const status = options.body?.status || deployment.status;
      deployment.status = status;
      return [{ ...deployment, status }];
    }
    if (path.includes("/feltus_deployments?")) return [{ ...deployment }];
    if (path.includes("/feltus_deployment_targets?")) return [target];
    if (path.includes("/feltus_environments?")) return [environment];
    if (path.includes("/feltus_deployment_health_checks")) return [];
    if (path.includes("/feltus_observed_application_states?")) {
      const match = /state_hash=eq\.([0-9a-f]{64})/.exec(path);
      return savedObservations.filter(item => item.state_hash === match?.[1]);
    }
    if (path.includes("/rpc/feltus_record_observed_application_state")) {
      const row = { id: "7c000000-0000-4000-8000-000000000001", blueprint_version: 1, ...options.body.p_observed };
      savedObservations.push(row);
      return row;
    }
    if (path.includes("/feltus_application_blueprints?")) return [{ id: currentBlueprintId, version: 2 }];
    if (path.includes("/feltus_artifacts?")) return [{ id: "7d000000-0000-4000-8000-000000000001", artifact_digest: `sha256:${"b".repeat(64)}` }];
    if (path.includes("/rpc/feltus_record_application_state_deltas")) return 2;
    throw new Error(`Unexpected reconciliation request: ${path}`);
  };
  const coolify = { async getDeployment() { return { status: "finished" }; } };
  const worker = createInfrastructureWorker({
    rest,
    coolify,
    workerId: "worker-test",
    allowedEnvironments: ["staging"],
    resourceMap: { staging: [resourceReference] },
    probeEnvironmentFn: async () => ({ healthy: true, domain: "staging.example.test", durationMs: 23 })
  });

  assert.equal(await worker.reconcileActiveDeployments({ force: true }), 1);
  const observationCall = calls.find(call => call.path?.includes("/rpc/feltus_record_observed_application_state"));
  assert.ok(observationCall);
  assert.match(observationCall.body.p_observed.state_hash, /^[0-9a-f]{64}$/);
  assert.equal(observationCall.body.p_observed.health, "healthy");
  assert.equal(observationCall.body.p_observed.blueprint_id, deployedBlueprintId);
  const deltaCall = calls.find(call => call.path?.includes("/rpc/feltus_record_application_state_deltas"));
  assert.deepEqual(deltaCall.body.p_deltas.map(delta => delta.key), ["blueprint.version", "artifact.digest"]);
  assert.equal(await worker.reconcileActiveDeployments({ force: true }), 0, "an unchanged verified observation is idempotent");
  assert.equal(calls.filter(call => call.path?.includes("/feltus_deployment_health_checks")).length, 1);
  console.log("PASS Coolify reconciliation persists immutable observed state and factual blueprint/artifact deltas idempotently");
}
