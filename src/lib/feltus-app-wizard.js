export const APP_TYPES = Object.freeze([
  "web_application",
  "internal_tool",
  "api_backend",
  "ai_application",
  "data_application",
  "other"
]);

export const SETUP_STEPS = Object.freeze([
  "basics",
  "data",
  "relationships",
  "documents",
  "ai",
  "code",
  "environment",
  "review",
  "build"
]);

export const WORKSPACE_PAGES = Object.freeze([
  "overview",
  "code",
  "data",
  "relationships",
  "documents",
  "ai",
  "deployments",
  "environments",
  "infrastructure",
  "logs",
  "team",
  "settings"
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_COLOR = "#62D6C9";
const APP_SELECT = [
  "id", "owner_id", "app_name", "environment", "created_at", "description",
  "app_type", "app_icon", "accent_color", "setup_status", "setup_current_step",
  "setup_completed_steps", "setup_data", "setup_updated_at", "deployment_state",
  "deployed_at", "organization_id"
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
    if (/(secret|password|token|credential|private[_-]?key|api[_-]?key)/i.test(key)) {
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

export function resumeSetupPath(app) {
  const step = SETUP_STEPS.includes(app?.setup_current_step) && app.setup_current_step !== "build"
    ? app.setup_current_step
    : "basics";
  return `/apps/${encodeURIComponent(app.id)}/setup/${step}`;
}

export function resolveAppRoute(pathname) {
  const path = String(pathname || "/").split("?")[0].replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/index.html") return { kind: "home" };
  if (path === "/apps") return { kind: "apps" };
  if (path === "/apps/new") return { kind: "new-app" };
  if (path === "/apps/new/basics") return { kind: "new-basics" };

  const appRoute = /^\/apps\/([0-9a-f-]{36})(?:\/(.*))?$/i.exec(path);
  if (!appRoute || !UUID_PATTERN.test(appRoute[1])) return { kind: "not-found" };
  const appId = appRoute[1];
  const rest = appRoute[2] || "";
  if (!rest) return { kind: "app-overview", appId };

  const setup = /^setup\/([a-z-]+)$/.exec(rest);
  if (setup && SETUP_STEPS.includes(setup[1])) return { kind: "setup-step", appId, step: setup[1] };
  if (WORKSPACE_PAGES.includes(rest)) return { kind: "workspace-page", appId, page: rest };
  return { kind: "not-found" };
}

export function isAppShellRoute(pathname) {
  return resolveAppRoute(pathname).kind !== "not-found";
}

export function nextSetupRoute(appId, step) {
  const index = SETUP_STEPS.indexOf(step);
  if (index < 0 || index >= SETUP_STEPS.length - 1) return null;
  return `/apps/${encodeURIComponent(appId)}/setup/${SETUP_STEPS[index + 1]}`;
}

export function previousSetupRoute(appId, step) {
  const index = SETUP_STEPS.indexOf(step);
  if (index <= 0) return `/apps/${encodeURIComponent(appId)}`;
  return `/apps/${encodeURIComponent(appId)}/setup/${SETUP_STEPS[index - 1]}`;
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

export function createAppWizardHandler({ tableRequest, readBody, getUser }) {
  if (typeof tableRequest !== "function" || typeof readBody !== "function" || typeof getUser !== "function") {
    throw new TypeError("App wizard handler requires tableRequest, readBody, and getUser.");
  }

  async function loadApp(id, ownerId) {
    const result = await tableRequest("feltus_applications", "GET", {
      query: `?select=${APP_SELECT}&id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}&limit=1`
    });
    if (result.status < 200 || result.status >= 300) return { error: responseForDatabaseError(result, "App could not be loaded.") };
    return { app: firstRow(result) };
  }

  return async function handleAppWizardRequest(req, res, url) {
    const pathname = url.pathname;
    const collectionRoute = pathname === "/api/apps";
    const itemRoute = /^\/api\/apps\/([0-9a-f-]{36})(?:\/(setup|archive))?$/i.exec(pathname);
    if (!collectionRoute && !itemRoute) return false;

    const ownerId = getUser()?.id;
    if (!ownerId) {
      respond(res, 401, { error: "Authentication required." });
      return true;
    }

    const method = String(req.method || "GET").toUpperCase();
    try {
      if (collectionRoute && method === "GET") {
        const result = await tableRequest("feltus_applications", "GET", {
          query: `?select=${APP_SELECT}&owner_id=eq.${encodeURIComponent(ownerId)}&order=setup_updated_at.desc,created_at.desc`
        });
        if (result.status < 200 || result.status >= 300) {
          const failure = responseForDatabaseError(result, "Apps could not be loaded.");
          respond(res, failure.status, failure.body);
        } else {
          respond(res, 200, Array.isArray(result.data) ? result.data : []);
        }
        return true;
      }

      if (collectionRoute && method === "POST") {
        const body = await readBody(req, 32768);
        const basics = validateAppBasics(body);
        const environment = String(body.environment || "development").trim().toLowerCase();
        if (!["development", "staging", "production"].includes(environment)) {
          respond(res, 400, { error: "Choose a valid environment." });
          return true;
        }
        const result = await tableRequest("feltus_applications", "POST", {
          body: {
            owner_id: ownerId,
            ...basics,
            environment,
            setup_status: body.continue_setup === true ? "configuring" : "draft",
            setup_current_step: body.continue_setup === true ? "data" : "basics",
            setup_completed_steps: body.continue_setup === true ? ["basics"] : [],
            setup_data: {}
          }
        });
        if (result.status < 200 || result.status >= 300) {
          const failure = responseForDatabaseError(result, "The app draft could not be saved.");
          respond(res, failure.status, failure.body);
        } else {
          const app = firstRow(result);
          if (!app) respond(res, 502, { error: "The app was created, but its details could not be loaded." });
          else respond(res, 201, { app });
        }
        return true;
      }

      if (!itemRoute || !UUID_PATTERN.test(itemRoute[1])) {
        respond(res, 404, { error: "App not found." });
        return true;
      }

      const [, appId, action = ""] = itemRoute;
      if (method === "GET" && (action === "" || action === "setup")) {
        const result = await loadApp(appId, ownerId);
        if (result.error) respond(res, result.error.status, result.error.body);
        else if (!result.app) respond(res, 404, { error: "App not found." });
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
        if (app.setup_status === "archived") {
          respond(res, 409, { error: "Archived apps cannot be changed. Open the Apps list to review this app." });
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
          if (body.setup_completed_steps.some(step => step !== "basics")) {
            respond(res, 400, { error: "Only App Details can be marked complete in this phase." });
            return true;
          }
          patch.setup_completed_steps = [...new Set(body.setup_completed_steps)];
        }
        if (Object.hasOwn(body, "setup_status")) {
          if (!["draft", "configuring"].includes(body.setup_status)) {
            respond(res, 400, { error: "This setup status is not available in this phase." });
            return true;
          }
          patch.setup_status = body.setup_status;
        }
        if (Object.hasOwn(body, "setup_data")) {
          const data = validateSetupData(body.setup_data);
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
        const result = await tableRequest("feltus_applications", "PATCH", {
          query: `?id=eq.${encodeURIComponent(appId)}&owner_id=eq.${encodeURIComponent(ownerId)}&select=${APP_SELECT}`,
          body: { setup_status: "archived", setup_updated_at: new Date().toISOString() }
        });
        if (result.status < 200 || result.status >= 300) {
          const failure = responseForDatabaseError(result, "The app could not be archived.");
          respond(res, failure.status, failure.body);
        } else {
          const archived = firstRow(result);
          if (!archived) respond(res, 404, { error: "App not found." });
          else respond(res, 200, { app: archived });
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
