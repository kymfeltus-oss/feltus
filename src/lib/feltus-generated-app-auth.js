import crypto from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MODEL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function send(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function cookieName(appId) {
  return `feltus_app_${appId.replaceAll("-", "")}`;
}

function readCookie(req, name) {
  for (const value of String(req.headers.cookie || "").split(";")) {
    const separator = value.indexOf("=");
    if (separator >= 0 && value.slice(0, separator).trim() === name) {
      return decodeURIComponent(value.slice(separator + 1).trim());
    }
  }
  return null;
}

function setCookie(res, name, value, maxAge, appId, secure) {
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/api/apps/${appId}/auth; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
}

function firstRow(result) {
  return Array.isArray(result?.data) ? result.data[0] || null : result?.data || null;
}

function normalizedEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function createGeneratedAppAuthHandler({
  readBody,
  serviceRequest,
  authRequest,
  adminAuthRequest,
  dataRequest,
  prepareApp,
  isProduction = false,
  allowRegistration = () => true,
  allowLogin = () => true,
  randomToken = () => crypto.randomBytes(32).toString("base64url"),
  now = () => Date.now()
}) {
  const sessions = new Map();

  async function configuredApplication(appId) {
    const result = await serviceRequest("/rest/v1/rpc/feltus_generated_app_auth_configuration", {
      method: "POST",
      body: { p_app_id: appId }
    });
    const configuration = result.data;
    if (result.status < 200 || result.status >= 300 || configuration?.application_id !== appId) {
      return { status: 503, app: null, models: [] };
    }
    if (!configuration.active) return { status: 404, app: null, models: [] };
    if (configuration.enabled !== true) {
      return { status: 409, app: null, models: [] };
    }
    const models = Array.isArray(configuration.models) ? configuration.models : [];
    if (models.some(model => model.rls_enabled !== true)) {
      return { status: 409, app: null, models: [] };
    }
    const authHealth = await authRequest("/auth/v1/health");
    if (authHealth.status < 200 || authHealth.status >= 300) {
      return { status: 503, app: null, models: [] };
    }
    return { status: 200, app: { id: appId }, models };
  }

  async function prepareApplication(appId) {
    if (typeof prepareApp !== "function") return false;
    const result = await prepareApp(appId);
    return result?.status >= 200 && result.status < 300;
  }

  function authIdentifier() {
    return `u-${crypto.randomUUID().replaceAll("-", "")}@generated.feltus.invalid`;
  }

  async function clearRegistrationIntent(appId, authEmail) {
    await serviceRequest(`/rest/v1/feltus_generated_app_registration_intents?app_id=eq.${encodeURIComponent(appId)}&auth_email=eq.${encodeURIComponent(authEmail)}`, {
      method: "DELETE"
    });
  }

  async function membership(appId, userId, email = null) {
    const filters = new URLSearchParams({
      select: "id,user_id,auth_identifier,normalized_identifier,status",
      app_id: `eq.${appId}`,
      user_id: `eq.${userId}`,
      status: "eq.active",
      limit: "1"
    });
    if (email) filters.set("normalized_identifier", `eq.${email}`);
    const result = await serviceRequest(`/rest/v1/feltus_app_user_memberships?${filters}`);
    return result.status >= 200 && result.status < 300 && Array.isArray(result.data) ? result.data[0] || null : null;
  }

  async function membershipByIdentifier(appId, email) {
    const filters = new URLSearchParams({
      select: "user_id,auth_identifier,normalized_identifier,status",
      app_id: `eq.${appId}`,
      normalized_identifier: `eq.${email}`,
      status: "eq.active",
      limit: "1"
    });
    const result = await serviceRequest(`/rest/v1/feltus_app_user_memberships?${filters}`);
    return result.status >= 200 && result.status < 300 && Array.isArray(result.data) ? result.data[0] || null : null;
  }

  async function authUser(accessToken) {
    if (!accessToken) return null;
    const result = await authRequest("/auth/v1/user", { token: accessToken });
    return result.status >= 200 && result.status < 300 && UUID.test(String(result.data?.id || ""))
      ? result.data
      : null;
  }

  async function createSession(appId, authData, email) {
    const token = randomToken();
    sessions.set(token, {
      appId,
      userId: authData.user.id,
      email,
      accessToken: authData.access_token,
      refreshToken: authData.refresh_token,
      expiresAt: now() + Math.max(60, Number(authData.expires_in || 3600)) * 1000,
      cookieExpiresAt: now() + SESSION_TTL_SECONDS * 1000
    });
    return token;
  }

  async function resolveSession(req, appId) {
    const name = cookieName(appId);
    const token = readCookie(req, name);
    const session = token ? sessions.get(token) : null;
    if (!session || session.appId !== appId || session.cookieExpiresAt <= now()) {
      if (token) sessions.delete(token);
      return null;
    }
    if (session.expiresAt <= now() + 60_000) {
      const refreshed = await authRequest("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        body: { refresh_token: session.refreshToken }
      });
      if (refreshed.status < 200 || refreshed.status >= 300 ||
          refreshed.data?.user?.id !== session.userId || !refreshed.data?.access_token || !refreshed.data?.refresh_token) {
        sessions.delete(token);
        return null;
      }
      session.accessToken = refreshed.data.access_token;
      session.refreshToken = refreshed.data.refresh_token;
      session.expiresAt = now() + Math.max(60, Number(refreshed.data.expires_in || 3600)) * 1000;
    }
    const user = await authUser(session.accessToken);
    const userMembership = user && user.id === session.userId ? await membership(appId, user.id) : null;
    if (!user || user.id !== session.userId || userMembership?.normalized_identifier !== session.email) {
      sessions.delete(token);
      return null;
    }
    return { token, name, session, user };
  }

  return async function handleGeneratedAppAuth(req, res, url) {
    const match = /^\/api\/apps\/([0-9a-f-]{36})\/auth(?:\/(register|login|logout|session)|\/data\/([a-z][a-z0-9_]{0,39}))?$/i.exec(url.pathname);
    if (!match) return false;
    const [, appId, namedAction, modelName] = match;
    const action = namedAction || (modelName ? "data" : "session");
    if (!UUID.test(appId)) {
      send(res, 400, { error: "A valid application is required." });
      return true;
    }
    const method = String(req.method || "GET").toUpperCase();
    if ((action === "session" && method !== "GET") ||
        (action !== "session" && action !== "data" && method !== "POST") ||
        (action === "data" && !["GET", "POST"].includes(method))) {
      res.setHeader("Allow", action === "session" ? "GET" : action === "data" ? "GET, POST" : "POST");
      send(res, 405, { error: "Method not allowed." });
      return true;
    }
    if (action === "logout") {
      const name = cookieName(appId);
      const token = readCookie(req, name);
      const session = token ? sessions.get(token) : null;
      if (token) sessions.delete(token);
      if (session?.appId === appId) {
        await authRequest("/auth/v1/logout", { method: "POST", token: session.accessToken }).catch(() => {});
      }
      setCookie(res, name, "", 0, appId, isProduction);
      send(res, 200, { authenticated: false });
      return true;
    }
    try {
      const configured = await configuredApplication(appId);
      if (!configured.app) {
        send(res, configured.status, {
          error: configured.status === 409
            ? "Enable Data & Sign-In and privacy protection on every data model first."
            : configured.status === 404 ? "Application not found." : "Application sign-in is unavailable right now."
        });
        return true;
      }

      if (action === "register") {
        if (!await prepareApplication(appId)) {
          send(res, 503, { error: "Application sign-in is unavailable right now." });
          return true;
        }
        const body = await readBody(req, 8192);
        const email = normalizedEmail(body?.email);
        const password = typeof body?.password === "string" ? body.password : "";
        if (!EMAIL.test(email) || email.length > 320 || password.length < 8 || password.length > 1024) {
          send(res, 400, { error: "Enter a valid email and a password of at least 8 characters." });
          return true;
        }
        const authEmail = authIdentifier();
        if (!allowRegistration(req, email, appId)) {
          send(res, 429, { error: "Too many account creation attempts. Try again later." });
          return true;
        }
        const staleBefore = new Date(now() - 10 * 60 * 1000).toISOString();
        await serviceRequest(`/rest/v1/feltus_generated_app_registration_intents?app_id=eq.${encodeURIComponent(appId)}&auth_email=eq.${encodeURIComponent(authEmail)}&created_at=lt.${encodeURIComponent(staleBefore)}`, { method: "DELETE" });
        const intent = await serviceRequest("/rest/v1/feltus_generated_app_registration_intents", {
          method: "POST",
          prefer: "return=minimal",
          body: { app_id: appId, auth_email: authEmail }
        });
        if (intent.status < 200 || intent.status >= 300) {
          send(res, 409, { error: "This account is already being created or is already registered for this app." });
          return true;
        }
        const created = await adminAuthRequest("/auth/v1/admin/users", {
          method: "POST",
          body: {
            email: authEmail,
            password,
            email_confirm: true,
            app_metadata: { feltus_identity_type: "generated_app", feltus_app_id: appId }
          }
        });
        const userId = String(created.data?.id || "");
        if (created.status < 200 || created.status >= 300 || !UUID.test(userId)) {
          await clearRegistrationIntent(appId, authEmail);
          send(res, created.status === 422 || created.status === 409 ? 409 : 400, { error: "This account could not be created. Check the details or sign in instead." });
          return true;
        }
        const linked = await serviceRequest("/rest/v1/feltus_app_user_memberships", {
          method: "POST",
          prefer: "return=minimal",
          body: { app_id: appId, user_id: userId, auth_identifier: authEmail, normalized_identifier: email, status: "active" }
        });
        if (linked.status < 200 || linked.status >= 300) {
          await clearRegistrationIntent(appId, authEmail);
          await adminAuthRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" }).catch(() => {});
          send(res, 409, { error: "This account could not be connected to the application." });
          return true;
        }
        const authenticated = await authRequest("/auth/v1/token?grant_type=password", {
          method: "POST",
          body: { email: authEmail, password }
        });
        if (authenticated.status < 200 || authenticated.status >= 300 || authenticated.data?.user?.id !== userId) {
          await clearRegistrationIntent(appId, authEmail);
          await serviceRequest(`/rest/v1/feltus_app_user_memberships?app_id=eq.${encodeURIComponent(appId)}&user_id=eq.${encodeURIComponent(userId)}`, { method: "DELETE" });
          await adminAuthRequest(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" }).catch(() => {});
          send(res, 503, { error: "The account was created but sign-in could not be started." });
          return true;
        }
        await clearRegistrationIntent(appId, authEmail);
        const sessionToken = await createSession(appId, authenticated.data, email);
        setCookie(res, cookieName(appId), sessionToken, SESSION_TTL_SECONDS, appId, isProduction);
        send(res, 201, { authenticated: true, user: { id: userId, email } });
        return true;
      }

      if (action === "login") {
        if (!await prepareApplication(appId)) {
          send(res, 503, { error: "Application sign-in is unavailable right now." });
          return true;
        }
        const body = await readBody(req, 8192);
        const email = normalizedEmail(body?.email);
        const password = typeof body?.password === "string" ? body.password : "";
        if (!EMAIL.test(email) || !password || password.length > 1024) {
          send(res, 400, { error: "Enter a valid email and password." });
          return true;
        }
        if (!allowLogin(req, email, appId)) {
          send(res, 429, { error: "Too many sign-in attempts. Try again later." });
          return true;
        }
        const appMembership = await membershipByIdentifier(appId, email);
        if (!appMembership || typeof appMembership.auth_identifier !== "string" ||
            !appMembership.auth_identifier.endsWith("@generated.feltus.invalid")) {
          send(res, 401, { error: "Sign-in failed. Check your credentials or account." });
          return true;
        }
        const authenticated = await authRequest("/auth/v1/token?grant_type=password", {
          method: "POST",
          body: { email: appMembership.auth_identifier, password }
        });
        const user = authenticated.data?.user;
        if (authenticated.status < 200 || authenticated.status >= 300 || !UUID.test(String(user?.id || "")) ||
            user.id !== appMembership.user_id || !authenticated.data?.refresh_token) {
          if (authenticated.data?.access_token) {
            await authRequest("/auth/v1/logout", { method: "POST", token: authenticated.data.access_token }).catch(() => {});
          }
          send(res, 401, { error: "Sign-in failed. Check your credentials or account." });
          return true;
        }
        const sessionToken = await createSession(appId, authenticated.data, email);
        setCookie(res, cookieName(appId), sessionToken, SESSION_TTL_SECONDS, appId, isProduction);
        send(res, 200, { authenticated: true, user: { id: user.id, email } });
        return true;
      }

      const currentSession = await resolveSession(req, appId);
      if (action === "session") {
        send(res, 200, currentSession
          ? { authenticated: true, user: { id: currentSession.user.id, email: currentSession.session.email } }
          : { authenticated: false });
        return true;
      }
      if (!currentSession) {
        send(res, 401, { error: "Application sign-in is required." });
        return true;
      }
      if (action === "data") {
        if (!MODEL_NAME.test(modelName)) {
          send(res, 400, { error: "Choose a valid application data model." });
          return true;
        }
        const model = configured.models.find(item => item.logical_name === modelName) || null;
        if (!model || model.rls_enabled !== true || !/^fm_[0-9a-f]{8}_[a-z][a-z0-9_]{0,39}$/.test(model.physical_table_name || "")) {
          send(res, 404, { error: "Application data model not found." });
          return true;
        }
        if (method === "GET") {
          const result = await dataRequest(model.physical_table_name, "GET", {
            query: `?select=*&__feltus_app_id=eq.${encodeURIComponent(appId)}&limit=100`,
            accessToken: currentSession.session.accessToken
          });
          if (result.status < 200 || result.status >= 300) {
            send(res, result.status === 401 ? 401 : 403, { error: "Application data could not be read." });
          } else send(res, 200, Array.isArray(result.data) ? result.data : []);
          return true;
        }
        const body = await readBody(req, 65536);
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            Object.keys(body).some(key => ["id", "owner_id", "created_at", "__feltus_app_id"].includes(key))) {
          send(res, 400, { error: "Provide one application data record without system fields." });
          return true;
        }
        const allowed = new Set((Array.isArray(model.columns) ? model.columns : []).map(field => field.column_name));
        if (Object.keys(body).some(key => !allowed.has(key))) {
          send(res, 400, { error: "The record contains a field that is not in this data model." });
          return true;
        }
        const result = await dataRequest(model.physical_table_name, "POST", {
          body: { ...body, __feltus_app_id: appId },
          accessToken: currentSession.session.accessToken
        });
        if (result.status < 200 || result.status >= 300) {
          send(res, result.status === 401 ? 401 : result.status === 403 ? 403 : 400, { error: "Application data could not be saved." });
        } else send(res, 201, Array.isArray(result.data) ? result.data : []);
        return true;
      }
      send(res, 404, { error: "Application authentication route not found." });
      return true;
    } catch {
      send(res, 503, { error: "Application authentication is unavailable right now." });
      return true;
    }
  };
}