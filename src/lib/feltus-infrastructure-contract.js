export const INFRASTRUCTURE_CONTRACT = "feltus.infrastructure/v1";
export const INFRASTRUCTURE_MODES = Object.freeze([
  "FELTUS_MANAGED",
  "CUSTOMER_MANAGED",
  "HYBRID",
  "EXISTING_APPLICATION"
]);
export const INFRASTRUCTURE_OWNERS = Object.freeze(["FELTUS", "CUSTOMER", "EXTERNAL_PROVIDER"]);
export const INFRASTRUCTURE_MANAGEMENT = Object.freeze([
  "FELTUS_MANAGED",
  "CUSTOMER_MANAGED",
  "CONNECTED_EXTERNAL"
]);
export const INFRASTRUCTURE_STATUSES = Object.freeze([
  "CONFIGURED",
  "PARTIAL",
  "UNAVAILABLE",
  "NOT_CONFIGURED",
  "UNKNOWN"
]);

export const INFRASTRUCTURE_REGISTRATION_STATUSES = Object.freeze([
  "NOT_CHECKED",
  "REACHABLE",
  "NEEDS_ATTENTION",
  "UNAVAILABLE"
]);

export const INFRASTRUCTURE_SERVICE_TYPES = Object.freeze([
  "database",
  "authentication",
  "object_storage",
  "api_endpoint"
]);

export const INFRASTRUCTURE_ENVIRONMENT_TYPES = Object.freeze([
  "customer_runtime",
  "existing_hosted_runtime"
]);

export const INFRASTRUCTURE_COMPONENTS = Object.freeze([
  "source_repository",
  "runtime_hosting",
  "database",
  "authentication",
  "object_storage",
  "domain_dns",
  "tls",
  "build_execution",
  "deployment_execution",
  "secrets_configuration",
  "monitoring_health",
  "backups_recovery"
]);

import {
  FELTUS_FULL_PLATFORM_SERVICE_IDS,
  FELTUS_PLATFORM_SERVICE_COMPONENTS,
  FELTUS_SUPPORTED_PLATFORM_SERVICE_IDS
} from "./feltus-app-wizard-shared.js";
export {
  FELTUS_FULL_PLATFORM_SERVICE_IDS,
  FELTUS_PLATFORM_SERVICE_COMPONENTS,
  FELTUS_SUPPORTED_PLATFORM_SERVICE_IDS
} from "./feltus-app-wizard-shared.js";

const COMPONENT_SET = new Set(INFRASTRUCTURE_COMPONENTS);
const REGISTRATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICE_COMPONENTS = Object.freeze({
  database: "database",
  authentication: "authentication",
  object_storage: "object_storage",
  api_endpoint: "monitoring_health"
});
const ENVIRONMENT_COMPONENTS = Object.freeze({
  customer_runtime: "runtime_hosting",
  existing_hosted_runtime: "runtime_hosting"
});
const OBSERVATION_FAILURE_CODES = new Set([
  "ENDPOINT_NOT_PUBLIC",
  "DNS_LOOKUP_FAILED",
  "CONNECTION_FAILED",
  "TIMEOUT",
  "HTTP_RESPONSE_ERROR"
]);

export function infrastructureRegistrationComponent(kind, type) {
  if (kind === "services") return SERVICE_COMPONENTS[type] || null;
  if (kind === "environments") return ENVIRONMENT_COMPONENTS[type] || null;
  return null;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function shortLabel(value, label, maximum = 80) {
  if (typeof value !== "string") {
    throw Object.assign(new Error(`${label} must be a short label.`), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw Object.assign(new Error(`${label} must be a short label.`), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  return normalized;
}

export function normalizeInfrastructureEndpoint(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 300 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw Object.assign(new Error("Enter a valid public web address without sign-in details."), { status: 400, code: "INFRASTRUCTURE_ENDPOINT_INVALID" });
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("Enter a valid public web address without sign-in details."), { status: 400, code: "INFRASTRUCTURE_ENDPOINT_INVALID" });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/" || url.port) {
    throw Object.assign(new Error("Use an HTTP(S) base address without credentials, a path, or query data."), { status: 400, code: "INFRASTRUCTURE_ENDPOINT_INVALID" });
  }
  return `${url.origin}/`;
}

function normalizeObservation(value, method) {
  if (!plainObject(value) || !["NONE", "HTTP_HEAD"].includes(method) ||
      value.method !== method || !INFRASTRUCTURE_REGISTRATION_STATUSES.includes(value.status)) {
    throw Object.assign(new Error("The saved endpoint status is invalid."), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  const checkedAt = value.checked_at == null ? null : value.checked_at;
  if (checkedAt !== null && (typeof checkedAt !== "string" || !Number.isFinite(Date.parse(checkedAt)))) {
    throw Object.assign(new Error("The saved endpoint check time is invalid."), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  const httpStatus = value.http_status == null ? null : value.http_status;
  if (httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
    throw Object.assign(new Error("The saved endpoint response is invalid."), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  const failureCode = value.failure_code == null ? null : value.failure_code;
  if (failureCode !== null && !OBSERVATION_FAILURE_CODES.has(failureCode)) {
    throw Object.assign(new Error("The saved endpoint result is invalid."), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  if (method === "NONE" &&
      (value.status !== "NOT_CHECKED" || checkedAt !== null || httpStatus !== null || failureCode !== null)) {
    throw Object.assign(new Error("This service type cannot have a connection check."), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  return {
    method,
    status: value.status,
    checked_at: checkedAt,
    http_status: httpStatus,
    failure_code: failureCode
  };
}

function normalizeRegistration(value, kind) {
  if (!plainObject(value) || !REGISTRATION_UUID.test(value.id || "")) {
    throw Object.assign(new Error("A saved service or environment record is invalid."), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  const type = value.type;
  const component = infrastructureRegistrationComponent(kind, type);
  if (!component || value.component !== component) {
    throw Object.assign(new Error("This service or environment type is not supported."), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  const owner = value.owner;
  const expectedEnvironmentOwner = type === "customer_runtime" ? "CUSTOMER" : "EXTERNAL_PROVIDER";
  if (!["CUSTOMER", "EXTERNAL_PROVIDER"].includes(owner) ||
      (kind === "environments" && owner !== expectedEnvironmentOwner)) {
    throw Object.assign(new Error("The service owner is invalid."), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  const management = owner === "CUSTOMER" ? "CUSTOMER_MANAGED" : "CONNECTED_EXTERNAL";
  if (value.management !== management) {
    throw Object.assign(new Error("The service management authority is invalid."), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  const endpoint = normalizeInfrastructureEndpoint(value.endpoint);
  const method = type === "api_endpoint" || kind === "environments" ? "HTTP_HEAD" : "NONE";
  if ((type === "api_endpoint" || kind === "environments") && !endpoint) {
    throw Object.assign(new Error("Enter the public web address to check."), { status: 400, code: "INFRASTRUCTURE_ENDPOINT_REQUIRED" });
  }
  if (typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at)) ||
      typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at))) {
    throw Object.assign(new Error("The saved service dates are invalid."), { status: 400, code: "INFRASTRUCTURE_REGISTRATION_INVALID" });
  }
  return {
    id: value.id,
    type,
    component,
    name: shortLabel(value.name, "Name"),
    provider: value.provider == null || value.provider === "" ? null : shortLabel(value.provider, "Provider"),
    owner,
    management,
    endpoint,
    observation: normalizeObservation(value.observation, method),
    created_at: value.created_at,
    updated_at: value.updated_at
  };
}

export function normalizeInfrastructureRegistrations(value) {
  if (!plainObject(value) || !Array.isArray(value.services) || !Array.isArray(value.environments) ||
      value.services.length > 20 || value.environments.length > 20) {
    throw Object.assign(new Error("The saved service and environment list is invalid."), { status: 400, code: "INFRASTRUCTURE_REGISTRATIONS_INVALID" });
  }
  const services = value.services.map(item => normalizeRegistration(item, "services"));
  const environments = value.environments.map(item => normalizeRegistration(item, "environments"));
  if (new Set([...services, ...environments].map(item => item.id)).size !== services.length + environments.length) {
    throw Object.assign(new Error("Service and environment identifiers must be unique."), { status: 400, code: "INFRASTRUCTURE_REGISTRATIONS_INVALID" });
  }
  return { services, environments };
}

function safeReference(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(value) || /(?:token|secret|password|credential|private[_-]?key)=/i.test(value)) {
    throw Object.assign(new Error(`${label} must be a short, non-secret reference.`), { status: 400, code: "INFRASTRUCTURE_REFERENCE_INVALID" });
  }
  return value;
}

export function normalizeInfrastructureConfiguration(value) {
  if (!plainObject(value) || value.contract !== INFRASTRUCTURE_CONTRACT ||
      !INFRASTRUCTURE_MODES.includes(value.mode) || !plainObject(value.components)) {
    throw Object.assign(new Error("A supported infrastructure contract and mode are required."), { status: 400, code: "INFRASTRUCTURE_CONTRACT_INVALID" });
  }
  const keys = Object.keys(value.components);
  if (keys.length !== INFRASTRUCTURE_COMPONENTS.length || keys.some(key => !COMPONENT_SET.has(key))) {
    throw Object.assign(new Error("Provide an ownership record for every supported infrastructure component."), { status: 400, code: "INFRASTRUCTURE_COMPONENTS_INVALID" });
  }
  const components = {};
  for (const component of INFRASTRUCTURE_COMPONENTS) {
    const item = value.components[component];
    if (!plainObject(item) ||
        !INFRASTRUCTURE_OWNERS.includes(item.owner) ||
        !INFRASTRUCTURE_MANAGEMENT.includes(item.management) ||
        !INFRASTRUCTURE_STATUSES.includes(item.status)) {
      throw Object.assign(new Error(`Infrastructure ownership for ${component} is invalid.`), { status: 400, code: "INFRASTRUCTURE_COMPONENT_INVALID" });
    }
    if ((item.owner === "FELTUS") !== (item.management === "FELTUS_MANAGED") ||
        (item.owner === "CUSTOMER") !== (item.management === "CUSTOMER_MANAGED")) {
      throw Object.assign(new Error(`Owner and management model disagree for ${component}.`), { status: 400, code: "INFRASTRUCTURE_OWNERSHIP_CONFLICT" });
    }
    components[component] = {
      owner: item.owner,
      management: item.management,
      status: item.status,
      ownership_configured: true,
      ...(item.provider ? { provider: safeReference(item.provider, "Provider") } : {}),
      ...(item.resource_reference ? { resource_reference: safeReference(item.resource_reference, "Resource reference") } : {}),
      ...(item.evidence_ref ? { evidence_ref: safeReference(item.evidence_ref, "Evidence reference") } : {})
    };
  }
  const configuredOwners = new Set(Object.values(components)
    .filter(component => component.status !== "UNKNOWN")
    .map(component => component.owner));
  if (value.mode === "FELTUS_MANAGED" && [...configuredOwners].some(owner => owner !== "FELTUS")) {
    throw Object.assign(new Error("FELTUS-managed mode requires FELTUS ownership for every component."), { status: 400, code: "INFRASTRUCTURE_MODE_CONFLICT" });
  }
  if (value.mode === "CUSTOMER_MANAGED" && (!configuredOwners.has("CUSTOMER") || configuredOwners.has("FELTUS"))) {
    throw Object.assign(new Error("Customer-managed mode requires at least one customer-owned component."), { status: 400, code: "INFRASTRUCTURE_MODE_CONFLICT" });
  }
  if (value.mode === "HYBRID" && (configuredOwners.size < 2 || !configuredOwners.has("FELTUS"))) {
    throw Object.assign(new Error("Hybrid mode requires FELTUS and at least one other component owner."), { status: 400, code: "INFRASTRUCTURE_MODE_CONFLICT" });
  }
  return { contract: INFRASTRUCTURE_CONTRACT, mode: value.mode, components };
}

export function infrastructureConfigurationForServices(serviceIds, current = null) {
  if (!Array.isArray(serviceIds) || serviceIds.length > FELTUS_SUPPORTED_PLATFORM_SERVICE_IDS.length ||
      serviceIds.some(id => !FELTUS_SUPPORTED_PLATFORM_SERVICE_IDS.includes(id))) {
    throw Object.assign(new Error("Choose only currently supported FELTUS services."), {
      status: 400,
      code: "PLATFORM_SERVICE_SELECTION_INVALID"
    });
  }
  if (current?.configuration_status === "INVALID") {
    throw Object.assign(new Error("Resolve the existing infrastructure configuration before changing services."), {
      status: 409,
      code: "INFRASTRUCTURE_CONFIGURATION_INVALID"
    });
  }

  const components = Object.fromEntries(INFRASTRUCTURE_COMPONENTS.map(name => {
    const saved = current?.components?.[name];
    if (saved && INFRASTRUCTURE_OWNERS.includes(saved.owner) &&
        INFRASTRUCTURE_MANAGEMENT.includes(saved.management) &&
        INFRASTRUCTURE_STATUSES.includes(saved.status)) {
      return [name, {
        owner: saved.owner,
        management: saved.management,
        status: saved.status,
        ...(saved.provider ? { provider: saved.provider } : {}),
        ...(saved.resource_reference ? { resource_reference: saved.resource_reference } : {}),
        ...(saved.evidence_ref ? { evidence_ref: saved.evidence_ref } : {})
      }];
    }
    return [name, {
      owner: "EXTERNAL_PROVIDER",
      management: "CONNECTED_EXTERNAL",
      status: "UNKNOWN"
    }];
  }));
  const requestedComponents = new Set(serviceIds
    .filter(id => id !== "my_services")
    .flatMap(id => FELTUS_PLATFORM_SERVICE_COMPONENTS[id]));
  const externalComponents = serviceIds.includes("my_services")
    ? FELTUS_PLATFORM_SERVICE_COMPONENTS.my_services
    : [];
  const blockedComponents = [];
  for (const name of requestedComponents) {
    const component = components[name];
    const hasConfiguredOwner = component.status !== "UNKNOWN";
    if (hasConfiguredOwner && (component.owner !== "FELTUS" || component.management !== "FELTUS_MANAGED")) {
      blockedComponents.push(name);
      continue;
    }
    component.owner = "FELTUS";
    component.management = "FELTUS_MANAGED";
    if (component.status === "UNKNOWN") component.status = "NOT_CONFIGURED";
  }
  for (const name of externalComponents) {
    const component = components[name];
    const hasConfiguredOwner = component.status !== "UNKNOWN";
    if (hasConfiguredOwner &&
        (component.owner !== "EXTERNAL_PROVIDER" || component.management !== "CONNECTED_EXTERNAL")) {
      blockedComponents.push(name);
      continue;
    }
    component.owner = "EXTERNAL_PROVIDER";
    component.management = "CONNECTED_EXTERNAL";
    if (component.status === "UNKNOWN") component.status = "NOT_CONFIGURED";
  }
  const knownOwners = new Set(Object.values(components)
    .filter(component => component.status !== "UNKNOWN")
    .map(component => component.owner));
  const mode = knownOwners.size > 1 && knownOwners.has("FELTUS")
    ? "HYBRID"
    : knownOwners.has("FELTUS")
      ? "FELTUS_MANAGED"
      : knownOwners.has("CUSTOMER")
        ? "CUSTOMER_MANAGED"
        : "EXISTING_APPLICATION";
  const configuration = normalizeInfrastructureConfiguration({
    contract: INFRASTRUCTURE_CONTRACT,
    mode,
    components
  });
  return { configuration, blocked_components: blockedComponents };
}

function unknownComponent() {
  return {
    owner: "EXTERNAL_PROVIDER",
    management: "CONNECTED_EXTERNAL",
    status: "UNKNOWN",
    ownership_configured: false,
    verification: { status: "UNVERIFIED", evidence: "No infrastructure evidence is recorded." }
  };
}

function inferredComponent(owner, management, status, evidence, verification = "UNVERIFIED", details = {}) {
  return {
    owner,
    management,
    status,
    ownership_configured: true,
    ...details,
    verification: { status: verification, evidence }
  };
}

export function resolveInfrastructureContract({
  app,
  inputs = {},
  buildWorkerReady = false,
  appAuthenticationReady = false,
  deploymentWorkerReady = false,
  deploymentWorkerEnvironments = [],
  backupState = null
}) {
  const saved = plainObject(app?.setup_data?.infrastructure) ? app.setup_data.infrastructure : null;
  let explicit = null;
  let registrations = null;
  let configurationError = null;
  try {
    if (saved) explicit = normalizeInfrastructureConfiguration(saved);
  } catch (error) {
    configurationError = /^[A-Z0-9_]{1,64}$/.test(error?.code || "")
      ? error.code
      : "INFRASTRUCTURE_CONFIGURATION_INVALID";
  }
  const storedRegistrations = app?.setup_data?.infrastructure_registrations;
  if (storedRegistrations != null) {
    try {
      registrations = normalizeInfrastructureRegistrations(storedRegistrations);
    } catch {
      configurationError ||= "INFRASTRUCTURE_REGISTRATIONS_INVALID";
    }
  }
  const links = Array.isArray(inputs.repoLinks) ? inputs.repoLinks : [];
  const repositories = Array.isArray(inputs.repositories) ? inputs.repositories : [];
  const repositoryIds = [...new Set(links.map(link => link.repository_id).filter(Boolean))];
  const repository = repositoryIds.length === 1
    ? repositories.find(item => item.id === repositoryIds[0]) || null
    : null;
  const targets = Array.isArray(inputs.targets) ? inputs.targets : [];
  const activeTargets = targets.filter(target => target?.active !== false);
  const coolifyTargets = activeTargets.filter(target => String(target.provider_key || "").toLowerCase() === "coolify");
  const deployments = Array.isArray(inputs.deployments) ? inputs.deployments : [];
  const observations = Array.isArray(inputs.observations) ? inputs.observations : [];
  const models = Array.isArray(inputs.models) ? inputs.models : [];
  const selectedServices = Array.isArray(app?.setup_data?.platform_services?.selected_service_ids)
    ? app.setup_data.platform_services.selected_service_ids
    : [];
  const inferred = Object.fromEntries(INFRASTRUCTURE_COMPONENTS.map(component => [component, unknownComponent()]));

  if (repository) {
    inferred.source_repository = inferredComponent(
      "EXTERNAL_PROVIDER",
      "CONNECTED_EXTERNAL",
      "CONFIGURED",
      "A repository is linked to the application; remote verification occurs at release boundaries.",
      "UNVERIFIED",
      { provider: "github", resource_reference: repository.repository_name || repository.id }
    );
  } else if (repositoryIds.length > 1) {
    inferred.source_repository = inferredComponent(
      "EXTERNAL_PROVIDER",
      "CONNECTED_EXTERNAL",
      "PARTIAL",
      "Multiple repositories are linked; the release source repository is unresolved."
    );
  }
  if (coolifyTargets.length) {
    const hasHealthyObservation = observations.some(item => String(item.health || "").toLowerCase() === "healthy");
    const targetStatus = deploymentWorkerReady ? "CONFIGURED" : "PARTIAL";
    inferred.runtime_hosting = inferredComponent(
      "FELTUS", "FELTUS_MANAGED", targetStatus,
      "An existing application-scoped Coolify deployment target is recorded.",
      hasHealthyObservation ? "VERIFIED" : "UNVERIFIED",
      { provider: "coolify", resource_reference: coolifyTargets[0].provider_resource_reference || coolifyTargets[0].id }
    );
    inferred.deployment_execution = inferredComponent(
      "FELTUS", "FELTUS_MANAGED", targetStatus,
      deploymentWorkerReady ? "Coolify target and active FELTUS infrastructure worker are available." : "Coolify target exists, but an active FELTUS infrastructure worker is not confirmed.",
      deploymentWorkerReady ? "VERIFIED" : "UNVERIFIED",
      { provider: "coolify" }
    );
  } else if (activeTargets.length) {
    inferred.runtime_hosting = inferredComponent(
      "FELTUS", "FELTUS_MANAGED", "PARTIAL",
      "A deployment target exists, but its provider is not the supported Coolify path.",
      "UNSUPPORTED",
      { provider: safeReference(String(activeTargets[0].provider_key || "unknown"), "Provider") }
    );
    inferred.deployment_execution = { ...inferred.runtime_hosting };
  }
  inferred.build_execution = inferredComponent(
    "FELTUS", "FELTUS_MANAGED", buildWorkerReady ? "CONFIGURED" : "UNAVAILABLE",
    buildWorkerReady ? "An active isolated build worker is available." : "An active isolated build worker is not confirmed.",
    buildWorkerReady ? "VERIFIED" : "UNVERIFIED"
  );
  if (deploymentWorkerEnvironments.length) {
    inferred.deployment_execution.supported_environments = [...deploymentWorkerEnvironments];
  }
  if (observations.length) {
    const latest = observations[0];
    const health = String(latest.health || "").toLowerCase();
    inferred.monitoring_health = inferredComponent(
      "FELTUS", "FELTUS_MANAGED", "CONFIGURED",
      "An application runtime observation is recorded.",
      health === "healthy" ? "VERIFIED" : "UNVERIFIED",
      { observed_health: health || "unknown", observed_at: latest.observed_at || null }
    );
  }
  if (models.length) {
    inferred.database = inferredComponent(
      "FELTUS", "FELTUS_MANAGED", "CONFIGURED",
      "FELTUS-managed application data models are available through the scoped database API.",
      "VERIFIED"
    );
  }
  if (selectedServices.includes("data_sign_in")) {
    inferred.authentication = inferredComponent(
      "FELTUS", "FELTUS_MANAGED", appAuthenticationReady ? "CONFIGURED" : "UNAVAILABLE",
      appAuthenticationReady
        ? "Generated-app user registration, sessions, and application-scoped access are configured through the existing Auth service."
        : "Generated-app authentication is not ready for this application.",
      appAuthenticationReady ? "VERIFIED" : "UNAVAILABLE"
    );
  }
  const documents = Array.isArray(inputs.documents) ? inputs.documents : [];
  if (documents.length && (!explicit?.components.object_storage ||
      (explicit.components.object_storage.owner === "FELTUS" && explicit.components.object_storage.management === "FELTUS_MANAGED"))) {
    inferred.object_storage = inferredComponent(
      "FELTUS", "FELTUS_MANAGED", "PARTIAL",
      "Private app documents are recorded and processable; generic object storage and raw-file management are not available.",
      documents.some(document => document.processing_status === "ready") ? "VERIFIED" : "UNVERIFIED"
    );
  }
  const appAuthentication = explicit?.components.authentication;
  if (inferred.authentication.status === "UNKNOWN" && appAuthentication?.owner === "FELTUS" && appAuthentication.management === "FELTUS_MANAGED") {
    inferred.authentication = inferredComponent(
      "FELTUS", "FELTUS_MANAGED", "UNAVAILABLE",
      "Application-specific user accounts and sign-in are not available; FELTUS workspace sign-in is separate.",
      "UNSUPPORTED"
    );
  }
  const appBackupRecovery = explicit?.components.backups_recovery;
  if (appBackupRecovery?.owner === "FELTUS" && appBackupRecovery.management === "FELTUS_MANAGED") {
    const backupStatus = backupState?.available === false
      ? "UNAVAILABLE"
      : backupState?.backup?.status === "available"
        ? "CONFIGURED"
        : backupState?.backup?.status === "failed"
          ? "PARTIAL"
          : "NOT_CONFIGURED";
    const restoreStatus = backupState?.available === false
      ? "UNAVAILABLE"
      : backupState?.restore?.status === "succeeded"
        ? "CONFIGURED"
        : ["failed", "restoring"].includes(backupState?.restore?.status)
          ? "PARTIAL"
          : "NOT_CONFIGURED";
    inferred.backups_recovery = inferredComponent(
      "FELTUS", "FELTUS_MANAGED",
      backupStatus === "CONFIGURED" && restoreStatus !== "PARTIAL" ? "CONFIGURED" :
        backupStatus === "UNAVAILABLE" ? "UNAVAILABLE" : "PARTIAL",
      "App data and private uploaded files use app-scoped customer backups. Deployment rollback and source checkpoints are separate.",
      backupStatus === "UNAVAILABLE" ? "UNVERIFIED" : "VERIFIED",
      {
        backup: {
          status: backupStatus,
          last_status: backupState?.backup?.status || "not_created",
          completed_at: backupState?.backup?.completed_at || null,
          failure_code: backupState?.backup?.failure_code || null
        },
        restore: {
          status: restoreStatus,
          last_status: backupState?.restore?.status || "not_started",
          started_at: backupState?.restore?.started_at || null,
          completed_at: backupState?.restore?.completed_at || null,
          failure_code: backupState?.restore?.failure_code || null
        }
      }
    );
  }
  const components = Object.fromEntries(INFRASTRUCTURE_COMPONENTS.map(component => {
    const savedComponent = explicit?.components[component];
    const inferredComponentState = inferred[component];
    const selected = savedComponent
      ? inferredComponentState.status === "UNKNOWN"
        ? savedComponent
        : {
            ...savedComponent,
            ...inferredComponentState,
            owner: savedComponent.owner,
            management: savedComponent.management,
            ownership_configured: true,
            resource_reference: savedComponent.resource_reference || inferredComponentState.resource_reference,
            provider: savedComponent.provider || inferredComponentState.provider
          }
      : inferredComponentState;
    const verification = selected.verification || {
      status: "UNVERIFIED",
      evidence: selected.evidence_ref || "Configured ownership has not been independently verified."
    };
    return [component, {
      ...selected,
      verification
    }];
  }));
  const knownOwners = new Set(Object.values(components)
    .filter(component => component.status !== "UNKNOWN")
    .map(component => component.owner));
  const registrationOwners = new Set(registrations
    ? [...registrations.services, ...registrations.environments].map(item => item.owner)
    : []);
  const combinedOwners = new Set([...knownOwners, ...registrationOwners]);
  const mode = registrationOwners.size
    ? (combinedOwners.size > 1 && combinedOwners.has("FELTUS")
        ? "HYBRID"
        : combinedOwners.has("CUSTOMER")
          ? "CUSTOMER_MANAGED"
          : combinedOwners.has("FELTUS")
            ? "FELTUS_MANAGED"
            : "EXISTING_APPLICATION")
    : explicit?.mode || (knownOwners.size > 1
    ? knownOwners.has("FELTUS") ? "HYBRID" : "CUSTOMER_MANAGED"
    : knownOwners.has("CUSTOMER")
      ? "CUSTOMER_MANAGED"
      : knownOwners.has("FELTUS")
        ? "FELTUS_MANAGED"
        : "EXISTING_APPLICATION");
  return {
    contract: INFRASTRUCTURE_CONTRACT,
    mode,
    mode_source: registrationOwners.size
      ? "REGISTRATIONS_AND_EXISTING_EVIDENCE"
      : explicit ? "EXPLICIT_CONFIGURATION" : "EXISTING_EVIDENCE",
    configuration_status: configurationError ? "INVALID" : explicit ? "CONFIGURED" : "INFERRED",
    ...(configurationError ? { error_code: configurationError } : {}),
    components,
    ...(registrations ? { registrations } : {})
  };
}

export function applyInfrastructureRepositoryVerification(contract, result) {
  if (!contract?.components?.source_repository) return contract;
  const remoteStatus = ["REMOTE_VERIFIED", "REMOTE_DIVERGED", "REMOTE_UNAVAILABLE", "NOT_CONNECTED"].includes(result?.status)
    ? result.status
    : "REMOTE_UNAVAILABLE";
  const verificationStatus = remoteStatus === "REMOTE_VERIFIED"
    ? "VERIFIED"
    : remoteStatus === "REMOTE_DIVERGED"
      ? "DIVERGED"
      : remoteStatus === "NOT_CONNECTED"
        ? "NOT_CONNECTED"
        : "UNAVAILABLE";
  const remoteCommit = /^[0-9a-f]{40,64}$/i.test(String(result?.remote_commit || ""))
    ? String(result.remote_commit).toLowerCase()
    : null;
  const evidence = remoteStatus === "REMOTE_VERIFIED"
    ? "The connected repository branch currently resolves to the selected source commit."
    : remoteStatus === "REMOTE_DIVERGED"
      ? "The connected repository branch resolves to a different commit than the selected source."
      : remoteStatus === "NOT_CONNECTED"
        ? "No external repository is connected to this application."
        : "The connected repository branch could not be confirmed.";
  return {
    ...contract,
    components: {
      ...contract.components,
      source_repository: {
        ...contract.components.source_repository,
        verification: {
          ...contract.components.source_repository.verification,
          status: verificationStatus,
          remote_status: remoteStatus,
          ...(remoteCommit ? { remote_commit: remoteCommit } : {}),
          evidence
        }
      }
    }
  };
}

export function managedMutationPolicy(contract, componentNames) {
  if (contract?.configuration_status === "INVALID") {
    return { allowed: false, component: null, code: "INFRASTRUCTURE_CONFIGURATION_INVALID" };
  }
  for (const name of componentNames) {
    const component = contract?.components?.[name];
    if (component && (component.owner !== "FELTUS" || component.management !== "FELTUS_MANAGED") &&
        (component.ownership_configured === true || component.status !== "UNKNOWN")) {
      return { allowed: false, component: name, code: "INFRASTRUCTURE_OWNER_MISMATCH" };
    }
  }
  return { allowed: true, component: null, code: null };
}
