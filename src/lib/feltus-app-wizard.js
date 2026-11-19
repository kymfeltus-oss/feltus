import { randomUUID } from "node:crypto";
import { applicationLifecycleIsAccessible, resolveApplicationLifecycleStatus } from "./feltus-application-state.js";
import { infrastructureConfigurationForServices } from "./feltus-infrastructure-contract.js";
import { isGithubIntegrationConfigured } from "./feltus-github.js";
import {
  APP_TYPES,
  FELTUS_SUPPORTED_PLATFORM_SERVICE_IDS,
  SETUP_STEPS,
  UUID_PATTERN,
  WORKSPACE_PAGES,
  isAppShellRoute,
  nextSetupRoute,
  previousSetupRoute,
  resolveAppRoute,
  resumeSetupPath
} from "./feltus-app-wizard-shared.js";
export {
  APP_TYPES,
  FELTUS_FULL_PLATFORM_SERVICE_IDS,
  FELTUS_PLATFORM_SERVICE_IDS,
  FELTUS_SUPPORTED_PLATFORM_SERVICE_IDS,
  SETUP_STEPS,
  WORKSPACE_PAGES,
  isAppShellRoute,
  nextSetupRoute,
  previousSetupRoute,
  resolveAppRoute,
  resumeSetupPath
} from "./feltus-app-wizard-shared.js";

const DEFAULT_COLOR = "#62D6C9";
const APP_SELECT = [
  "id", "owner_id", "app_name", "environment", "created_at", "description",
  "app_type", "app_icon", "accent_color", "setup_status", "setup_current_step",
  "setup_completed_steps", "setup_data", "setup_updated_at", "deployment_state",
  "deployed_at", "organization_id", "lifecycle_status", "archive_previous_setup_status",
  "lifecycle_request_id"
].join(",");

function normalizeType(value) {
  return String(value || "other").trim().toLowerCase();
}

function normalizeIcon(value) {
  const icon = String(value ?? "✦").trim() || "✦";
  if ([...icon].length > 8 || /[\u0000-\u001f<>]/.test(icon)) {
    throw Object.assign(new Error("Choose a short app icon."), { status: 400, field: "app_icon" });
  }
  return icon;
}

export function validateAppBasics(input = {}) {
  const name = String(input.app_name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const appType = normalizeType(input.app_type);
  const accentColor = String(input.accent_color || DEFAULT_COLOR).trim();

  if (!name) throw Object.assign(new Error("Enter an app name."), { status: 400, field: "app_name" });
  if (name.length > 200) throw Object.assign(new Error("App name must be 200 characters or fewer."), { status: 400, field: "app_name" });
  if (/[\u0000-\u001f\u007f]/.test(name)) throw Object.assign(new Error("App name contains unsupported characters."), { status: 400, field: "app_name" });
  if (description.length > 2000) throw Object.assign(new Error("Description must be 2,000 characters or fewer."), { status: 400, field: "description" });
  if (!APP_TYPES.includes(appType)) throw Object.assign(new Error("Choose a supported app type."), { status: 400, field: "app_type" });
  if (!/^#[0-9a-f]{6}$/i.test(accentColor)) throw Object.assign(new Error("Choose a valid accent color."), { status: 400, field: "accent_color" });

  return {
    app_name: name,
    description,
    app_type: appType,
    app_icon: normalizeIcon(input.app_icon),
    accent_color: accentColor.toUpperCase()
  };
}

function assertSafeSetupValue(value, path = "setup_data", depth = 0) {
  if (depth > 8) throw Object.assign(new Error("Setup data is nested too deeply."), { status: 400 });
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "string" && value.length > 12000) {
      throw Object.assign(new Error("A setup value is too long."), { status: 400 });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw Object.assign(new Error("A setup list is too large."), { status: 400 });
    for (const item of value) assertSafeSetupValue(item, path, depth + 1);
    return;
  }
  if (typeof value !== "object") throw Object.assign(new Error("Setup data must contain JSON values."), { status: 400 });
  for (const [key, child] of Object.entries(value)) {
    const isGenerationTokenLimit = /^max[_-]?tokens$/i.test(key);
    const isInfrastructureOwnershipLabel = path === "setup_data.infrastructure.components" && key === "secrets_configuration";
    if (!isGenerationTokenLimit && !isInfrastructureOwnershipLabel &&
        /(secret|password|token|credential|private[_-]?key|api[_-]?key)/i.test(key)) {
      throw Object.assign(new Error("Secrets must be stored through FELTUS secret settings, not app setup data."), { status: 400 });
    }
    assertSafeSetupValue(child, `${path}.${key}`, depth + 1);
  }
}

export function validateSetupData(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Setup data must be an object."), { status: 400 });
  }
  assertSafeSetupValue(value);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 24000) {
    throw Object.assign(new Error("Setup data is too large."), { status: 400 });
  }
  return value;
}

function firstRow(result) {
  return Array.isArray(result?.data) ? result.data[0] || null : result?.data || null;
}

function respond(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

function responseForDatabaseError(result, fallback) {
  const code = result?.data?.code || result?.data?.error?.code || "";
  if (code === "23505" || result?.status === 409) return { status: 409, body: { error: "An app with that name already exists.", field: "app_name" } };
  if (result?.status === 401 || result?.status === 403) return { status: result.status, body: { error: "You do not have permission to change this app." } };
  return { status: result?.status >= 500 ? 502 : (result?.status || 502), body: { error: fallback } };
}

export function createAppWizardHandler({ tableRequest, readBody, getUser, rpcRequest = null, env = process.env }) {
  if (typeof tableRequest !== "function" || typeof readBody !== "function" || typeof getUser !== "function") {
    throw new TypeError("App wizard handler requires tableRequest, readBody, and getUser.");
  }

  async function loadApp(id, ownerId) {
    const result = await tableRequest("feltus_applications", "GET", {
      query: `?select=${APP_SELECT}&id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}&limit=1`
    });
    if (result.status < 200 || result.status >= 300) return { error: responseForDatabaseError(result, "App could not be loaded.") };
    const app = firstRow(result);
    if (app && !applicationLifecycleIsAccessible(app)) {
      return { app: null };
    }
    return { app };
  }

  return async function handleAppWizardRequest(req, res, url) {
    const pathname = url.pathname;
    const collectionRoute = pathname === "/api/apps";
    const deletionCollectionRoute = pathname === "/api/apps/deletions";
    const itemRoute = /^\/api\/apps\/([0-9a-f-]{36})(?:\/(setup|archive|restore|deletion-impact|deletion|delete))?$/i.exec(pathname);
    if (!collectionRoute && !deletionCollectionRoute && !itemRoute) return false;

    const ownerId = getUser()?.id;
    if (!ownerId) {
      respond(res, 401, { error: "Authentication required." });
      return true;
    }

    const method = String(req.method || "GET").toUpperCase();
    try {
      if (deletionCollectionRoute && method === "GET") {
        const result = await tableRequest("feltus_applications", "GET", {
          query: "?select=id,owner_id,app_name,lifecycle_status,lifecycle_request_id,lifecycle_cleanup_progress,lifecycle_retry_count,lifecycle_snapshot,setup_updated_at" +
            `&owner_id=eq.${encodeURIComponent(ownerId)}` +
            "&lifecycle_status=in.(requested,validated,tombstoned,cleanup_pending,cleanup_in_progress,cleanup_failed,cleanup_blocked)" +
            "&order=setup_updated_at.asc"
        });
        if (result.status < 200 || result.status >= 300) {
          const failure = responseForDatabaseError(result, "Deletion status could not be loaded.");
          respond(res, failure.status, failure.body);
        } else {
          respond(res, 200, Array.isArray(result.data) ? result.data : []);
        }
        return true;
      }

      if (collectionRoute && method === "GET") {
        const result = await tableRequest("feltus_applications", "GET", {
          query: `?select=${APP_SELECT}&owner_id=eq.${encodeURIComponent(ownerId)}&order=setup_updated_at.desc,created_at.desc`
        });
        if (result.status < 200 || result.status >= 300) {
          const failure = responseForDatabaseError(result, "Apps could not be loaded.");
          respond(res, failure.status, failure.body);
        } else {
          respond(res, 200, (Array.isArray(result.data) ? result.data : []).filter(applicationLifecycleIsAccessible));
        }
        return true;
      }

      if (collectionRoute && method === "POST") {
        const body = await readBody(req, 32768);
        const basics = validateAppBasics(body);
        const setupData = validateSetupData(body.setup_data || {});
        if (Object.hasOwn(setupData, "infrastructure_registrations")) {
          respond(res, 400, { error: "Service and environment records must be created from their app workspace pages." });
          return true;
        }
        const creationPath = body.creation_path || "build_with_feltus";
        if (!["build_with_feltus", "existing_application"].includes(creationPath)) {
          respond(res, 400, { error: "Choose a supported way to start this app." });
          return true;
        }
        if (creationPath === "existing_application" && !isGithubIntegrationConfigured(env)) {
          respond(res, 503, { error: "GitHub connection is unavailable right now.", error_code: "GITHUB_INTEGRATION_UNAVAILABLE" });
          return true;
        }
        const requestedServices = creationPath === "existing_application"
          ? body.service_ids || []
          : ["hosting", "publish"];
        if (!Array.isArray(requestedServices) ||
            requestedServices.some(id => !FELTUS_SUPPORTED_PLATFORM_SERVICE_IDS.includes(id))) {
          respond(res, 400, { error: "Choose only currently supported FELTUS services." });
          return true;
        }
        const infrastructure = infrastructureConfigurationForServices(requestedServices).configuration;
        const productSetupData = {
          ...setupData,
          product_path: creationPath,
          infrastructure,
          ...(creationPath === "existing_application"
            ? { platform_services: { selected_service_ids: [...new Set(requestedServices)] } }
            : { platform_service_defaults: [...new Set(requestedServices)] })
        };
        const environment = String(body.environment || "development").trim().toLowerCase();
        if (!["development", "staging", "production"].includes(environment)) {
          respond(res, 400, { error: "Choose a valid environment." });
          return true;
        }
        const appId = randomUUID();
        const result = await tableRequest("feltus_applications", "POST", {
          prefer: "return=minimal",
          body: {
            id: appId,
            owner_id: ownerId,
            ...basics,
            environment,
            setup_status: creationPath === "existing_application"
              ? "active"
              : body.continue_setup === true ? "configuring" : "draft",
            setup_current_step: creationPath === "existing_application"
              ? "basics"
              : body.continue_setup === true ? "data" : "basics",
            setup_completed_steps: body.continue_setup === true && creationPath === "build_with_feltus" ? ["basics"] : [],
            setup_data: productSetupData
          }
        });
        if (result.status < 200 || result.status >= 300) {
          const failure = responseForDatabaseError(result, "The app draft could not be saved.");
          respond(res, failure.status, failure.body);
        } else {
          const saved = await loadApp(appId, ownerId);
          if (saved.error) respond(res, saved.error.status, saved.error.body);
          else if (!saved.app) respond(res, 502, { error: "The app was created, but its details could not be loaded." });
          else respond(res, 201, { app: saved.app });
        }
        return true;
      }

      if (!itemRoute || !UUID_PATTERN.test(itemRoute[1])) {
        respond(res, 404, { error: "App not found." });
        return true;
      }

      const [, appId, action = ""] = itemRoute;
      if (["deletion-impact", "deletion"].includes(action)) {
        if (typeof rpcRequest !== "function") {
          respond(res, 503, { error: "Application lifecycle controls are unavailable." });
          return true;
        }
        if (method !== "GET") {
          respond(res, 405, { error: "Method not allowed." });
          return true;
        }
        const name = action === "deletion-impact"
          ? "feltus_application_deletion_impact"
          : "feltus_application_deletion_status";
        const result = await rpcRequest(name, { p_app_id: appId });
        if (result.status < 200 || result.status >= 300) {
          const status = result.status === 404 ? 404 : result.status === 401 || result.status === 403 ? result.status : result.status >= 500 ? 502 : result.status;
          respond(res, status, { error: status >= 500 ? "Application lifecycle details could not be loaded." : "Application not found or unavailable." });
        } else {
          respond(res, 200, result.data || {});
        }
        return true;
      }
      if (action === "delete") {
        if (method !== "POST") {
          respond(res, 405, { error: "Method not allowed." });
          return true;
        }
        if (typeof rpcRequest !== "function") {
          respond(res, 503, { error: "Application lifecycle controls are unavailable." });
          return true;
        }
        const body = await readBody(req, 4096);
        const confirmation = typeof body.confirmation === "string" ? body.confirmation : "";
        if (!confirmation || confirmation.length > 200) {
          respond(res, 400, { error: "Enter the exact application name to confirm permanent deletion." });
          return true;
        }
        const result = await rpcRequest("feltus_request_application_deletion", {
          p_app_id: appId,
          p_confirmation: confirmation
        });
        if (result.status < 200 || result.status >= 300) {
          const message = String(result.data?.message || result.data?.details || "");
          const status = result.status === 401 || result.status === 403 ? result.status : result.status >= 500 ? 502 : result.status || 502;
          respond(res, status, { error: message.includes("exact application name")
            ? "The name does not match. Enter the exact app name shown above."
            : message.includes("blocked")
              ? "Deletion is waiting for running work to finish. Refresh the impact summary and try again."
              : status >= 500 ? "The deletion request could not be saved. Try again shortly." : "The app could not be deleted." });
        } else {
          respond(res, 202, result.data || {});
        }
        return true;
      }
      if (method === "GET" && (action === "" || action === "setup")) {
        const result = await loadApp(appId, ownerId);
        if (result.error) respond(res, result.error.status, result.error.body);
        else if (!result.app) respond(res, 404, { error: "App not found." });
        else if (!applicationLifecycleIsAccessible(result.app)) respond(res, 404, { error: "App not found." });
        else respond(res, 200, { app: result.app });
        return true;
      }

      if (method === "PATCH" && action === "setup") {
        const body = await readBody(req, 32768);
        const loaded = await loadApp(appId, ownerId);
        if (loaded.error) {
          respond(res, loaded.error.status, loaded.error.body);
          return true;
        }
        if (!loaded.app) {
          respond(res, 404, { error: "App not found." });
          return true;
        }

        const app = loaded.app;
        const lifecycle = resolveApplicationLifecycleStatus(app);
        if (lifecycle !== "active") {
          respond(res, 409, { error: lifecycle === "archived"
            ? "Archived apps cannot be changed. Restore the app before editing it."
            : "Deletion has started for this app. Changes are no longer available." });
          return true;
        }
        const hasBasics = ["app_name", "description", "app_type", "app_icon", "accent_color"]
          .some(key => Object.hasOwn(body, key));
        const patch = {};
        if (hasBasics) Object.assign(patch, validateAppBasics({ ...app, ...body }));

        if (Object.hasOwn(body, "setup_current_step")) {
          if (!SETUP_STEPS.includes(body.setup_current_step)) {
            respond(res, 400, { error: "Choose a valid setup step." });
            return true;
          }
          patch.setup_current_step = body.setup_current_step;
        }
        if (Object.hasOwn(body, "setup_completed_steps")) {
          if (!Array.isArray(body.setup_completed_steps) || body.setup_completed_steps.length > SETUP_STEPS.length ||
              body.setup_completed_steps.some(step => !SETUP_STEPS.includes(step))) {
            respond(res, 400, { error: "Setup progress is invalid." });
            return true;
          }
          patch.setup_completed_steps = [...new Set(body.setup_completed_steps)];
        }
        if (Object.hasOwn(body, "setup_status")) {
          if (!["draft", "configuring", "active"].includes(body.setup_status)) {
            respond(res, 400, { error: "This setup status is not available in this phase." });
            return true;
          }
          if (body.setup_status === "active" && !SETUP_STEPS.every(step =>
            (patch.setup_completed_steps || app.setup_completed_steps || []).includes(step))) {
            respond(res, 409, { error: "Complete every setup step before creating the app." });
            return true;
          }
          patch.setup_status = body.setup_status;
        }
        if (Object.hasOwn(body, "setup_data")) {
          const data = validateSetupData(body.setup_data);
          if (Object.hasOwn(data, "infrastructure_registrations")) {
            respond(res, 400, { error: "Service and environment records must be changed from their app workspace pages." });
            return true;
          }
          patch.setup_data = { ...(app.setup_data || {}), ...data };
          validateSetupData(patch.setup_data);
        }
        if (!Object.keys(patch).length) {
          respond(res, 400, { error: "There are no setup changes to save." });
          return true;
        }

        const result = await tableRequest("feltus_applications", "PATCH", {
          query: `?id=eq.${encodeURIComponent(appId)}&owner_id=eq.${encodeURIComponent(ownerId)}&select=${APP_SELECT}`,
          body: { ...patch, setup_updated_at: new Date().toISOString() }
        });
        if (result.status < 200 || result.status >= 300) {
          const failure = responseForDatabaseError(result, "Setup changes could not be saved.");
          respond(res, failure.status, failure.body);
        } else {
          const updated = firstRow(result);
          if (!updated) respond(res, 404, { error: "App not found." });
          else respond(res, 200, { app: updated });
        }
        return true;
      }

      if (method === "POST" && action === "archive") {
        const loaded = await loadApp(appId, ownerId);
        if (loaded.error) {
          respond(res, loaded.error.status, loaded.error.body);
          return true;
        }
        if (!loaded.app) {
          respond(res, 404, { error: "App not found." });
          return true;
        }
        if (typeof rpcRequest !== "function") {
          respond(res, 503, { error: "Application lifecycle controls are unavailable." });
          return true;
        }
        const result = await rpcRequest("feltus_set_application_archive", { p_app_id: appId, p_archived: true });
        if (result.status < 200 || result.status >= 300) {
          const failure = responseForDatabaseError(result, "The app could not be archived.");
          respond(res, failure.status, failure.body);
        } else {
          const loaded = await loadApp(appId, ownerId);
          if (loaded.error) respond(res, loaded.error.status, loaded.error.body);
          else if (!loaded.app) respond(res, 404, { error: "App not found." });
          else respond(res, 200, { app: loaded.app, lifecycle: result.data || {} });
        }
        return true;
      }

      if (method === "POST" && action === "restore") {
        if (typeof rpcRequest !== "function") {
          respond(res, 503, { error: "Application lifecycle controls are unavailable." });
          return true;
        }
        const result = await rpcRequest("feltus_set_application_archive", { p_app_id: appId, p_archived: false });
        if (result.status < 200 || result.status >= 300) {
          const failure = responseForDatabaseError(result, "The app could not be restored.");
          respond(res, failure.status, failure.body);
        } else {
          const loaded = await loadApp(appId, ownerId);
          if (loaded.error) respond(res, loaded.error.status, loaded.error.body);
          else if (!loaded.app) respond(res, 404, { error: "App not found." });
          else respond(res, 200, { app: loaded.app, lifecycle: result.data || {} });
        }
        return true;
      }

      respond(res, 405, { error: "Method not allowed." });
      return true;
    } catch (error) {
      respond(res, Number.isInteger(error?.status) ? error.status : 502, {
        error: Number.isInteger(error?.status) && error.status < 500
          ? error.message
          : "FELTUS could not save this app setup. Try again shortly.",
        ...(error?.field ? { field: error.field } : {})
      });
      return true;
    }
  };
}
