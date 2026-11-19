import assert from "node:assert/strict";
import { createGeneratedAppAuthHandler } from "../src/lib/feltus-generated-app-auth.js";

const APP_A = "11111111-1111-4111-8111-111111111111";
const APP_B = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const accounts = new Map();
const memberships = new Map();
const registrationIntents = new Set();
const workspaceMemberships = new Set();
const accessTokens = new Map();
const rows = new Map([[APP_A, []], [APP_B, []]]);
let createdMetadata = null;
let createdUserCount = 0;
let sessionCount = 0;

function parseQuery(path) {
  return new URL(path, "http://feltus.test").searchParams;
}

async function serviceRequest(path, { method = "GET", body = null } = {}) {
  const url = new URL(path, "http://feltus.test");
  if (url.pathname === "/rest/v1/rpc/feltus_generated_app_auth_configuration") {
    const appId = body.p_app_id;
    return { status: 200, data: {
      application_id: appId,
      active: [APP_A, APP_B].includes(appId),
      enabled: [APP_A, APP_B].includes(appId),
      models: [APP_A, APP_B].includes(appId) ? [{
        id: `model-${appId}`,
        logical_name: "customers",
        physical_table_name: `fm_${appId === APP_A ? "aaaaaaaa" : "bbbbbbbb"}_customers`,
        rls_enabled: true,
        columns: [{ column_name: "name" }]
      }] : []
    } };
  }
  if (url.pathname === "/rest/v1/feltus_applications") {
    const appId = url.searchParams.get("id")?.replace(/^eq\./, "");
    const selected = [APP_A, APP_B].includes(appId);
    return { status: 200, data: selected ? [{
      id: appId,
      owner_id: OWNER_ID,
      lifecycle_status: "active",
      setup_data: { platform_services: { selected_service_ids: ["data_sign_in"] } }
    }] : [] };
  }
  if (url.pathname === "/rest/v1/feltus_models") {
    const appId = url.searchParams.get("app_id")?.replace(/^eq\./, "");
    return { status: 200, data: appId === APP_A || appId === APP_B ? [{
      id: `model-${appId}`,
      logical_name: "customers",
      physical_table_name: `fm_${appId === APP_A ? "aaaaaaaa" : "bbbbbbbb"}_customers`,
      rls_enabled: true
    }] : [] };
  }
  if (url.pathname === "/rest/v1/feltus_model_columns") {
    return { status: 200, data: [{ column_name: "name" }] };
  }
  if (url.pathname === "/rest/v1/feltus_app_user_memberships" && method === "POST") {
    memberships.set(`${body.app_id}:${body.user_id}`, { ...body, id: "membership-id" });
    return { status: 201, data: null };
  }
  if (url.pathname === "/rest/v1/feltus_app_user_memberships" && method === "DELETE") {
    const appId = url.searchParams.get("app_id")?.replace(/^eq\./, "");
    const userId = url.searchParams.get("user_id")?.replace(/^eq\./, "");
    memberships.delete(`${appId}:${userId}`);
    return { status: 204, data: null };
  }
  if (url.pathname === "/rest/v1/feltus_generated_app_registration_intents" && method === "POST") {
    registrationIntents.add(body.auth_email);
    return { status: 201, data: null };
  }
  if (url.pathname === "/rest/v1/feltus_generated_app_registration_intents" && method === "DELETE") {
    registrationIntents.delete(url.searchParams.get("auth_email")?.replace(/^eq\./, ""));
    return { status: 204, data: null };
  }
  if (url.pathname === "/rest/v1/feltus_app_user_memberships") {
    const appId = url.searchParams.get("app_id")?.replace(/^eq\./, "");
    const userId = url.searchParams.get("user_id")?.replace(/^eq\./, "");
    const email = url.searchParams.get("normalized_identifier")?.replace(/^eq\./, "");
    const row = userId
      ? memberships.get(`${appId}:${userId}`)
      : [...memberships.values()].find(item => item.app_id === appId && item.normalized_identifier === email);
    return { status: 200, data: row?.status === "active" && (!email || row.normalized_identifier === email) ? [row] : [] };
  }
  throw new Error(`Unexpected service request: ${path} ${method}`);
}

async function authRequest(path, { method = "GET", body = null, token = null } = {}) {
  if (path === "/auth/v1/health") return { status: 200, data: { status: "ok" } };
  if (path === "/auth/v1/admin/users" && method === "POST") {
    const email = body.email.toLowerCase();
    if (accounts.has(email)) return { status: 422, data: { msg: "already registered" } };
    if (!registrationIntents.has(email)) workspaceMemberships.add(email);
    createdMetadata = body.app_metadata;
    const account = {
      id: createdUserCount++ === 0 ? USER_ID : "55555555-5555-4555-8555-555555555555",
      email,
      password: body.password,
      app_metadata: body.app_metadata
    };
    accounts.set(email, account);
    registrationIntents.delete(email);
    return { status: 201, data: { id: account.id, email, app_metadata: account.app_metadata } };
  }
  if (path.startsWith("/auth/v1/admin/users/") && method === "DELETE") {
    for (const [email, account] of accounts) if (account.id === path.split("/").at(-1)) accounts.delete(email);
    return { status: 200, data: {} };
  }
  if (path === "/auth/v1/token?grant_type=password" && method === "POST") {
    const account = accounts.get(body.email.toLowerCase());
    if (!account || account.password !== body.password) return { status: 400, data: { msg: "invalid credentials" } };
    const accessToken = `access-${account.id}`;
    accessTokens.set(accessToken, account);
    return { status: 200, data: { user: { id: account.id, email: account.email }, access_token: accessToken, refresh_token: `refresh-${account.id}`, expires_in: 3600 } };
  }
  if (path === "/auth/v1/user") {
    const account = accessTokens.get(token);
    return account ? { status: 200, data: { id: account.id, email: account.email } } : { status: 401, data: {} };
  }
  if (path === "/auth/v1/logout") {
    accessTokens.delete(token);
    return { status: 204, data: null };
  }
  throw new Error(`Unexpected auth request: ${path} ${method}`);
}

const handler = createGeneratedAppAuthHandler({
  readBody: async request => request.body,
  serviceRequest,
  authRequest,
  adminAuthRequest: authRequest,
  prepareApp: async () => ({ status: 200 }),
  dataRequest: async (table, method, options) => {
    const account = accessTokens.get(options.accessToken);
    if (!account) return { status: 401, data: [] };
    const appId = table.includes("aaaaaaaa") ? APP_A : table.includes("bbbbbbbb") ? APP_B : null;
    if (!appId || !memberships.has(`${appId}:${account.id}`)) return { status: 403, data: [] };
    if (method === "POST") {
      assert.equal(options.body.__feltus_app_id, appId);
      const saved = { id: `row-${rows.get(appId).length + 1}`, ...options.body };
      rows.get(appId).push(saved);
      return { status: 201, data: [saved] };
    }
    return { status: 200, data: rows.get(appId) };
  },
  isProduction: true,
  randomToken: () => `opaque-generated-app-session-${++sessionCount}`
});

function response() {
  return {
    status: null,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(value) { this.body = value ? JSON.parse(String(value)) : null; }
  };
}

async function invoke(appId, action, { method = "GET", body = null, cookie = "" } = {}) {
  const res = response();
  const pathname = action.startsWith("data/")
    ? `/api/apps/${appId}/auth/${action}`
    : `/api/apps/${appId}/auth/${action}`;
  const handled = await handler({ method, headers: { cookie }, body }, res, new URL(`http://feltus.test${pathname}`));
  assert.equal(handled, true);
  return res;
}

const email = "generated-user@example.test";
const password = "isolated-test-password-2026";
const registration = await invoke(APP_A, "register", { method: "POST", body: { email: " Generated-User@Example.Test ", password } });
assert.equal(registration.status, 201);
assert.deepEqual(registration.body.user, { id: USER_ID, email });
assert.equal(JSON.stringify(registration.body).includes(password), false);
assert.deepEqual(createdMetadata, { feltus_identity_type: "generated_app", feltus_app_id: APP_A });
assert.equal(memberships.has(`${APP_A}:${USER_ID}`), true);
assert.equal(memberships.has(`${APP_B}:${USER_ID}`), false);
assert.equal(workspaceMemberships.size, 0, "generated-app registration intent prevents FELTUS workspace provisioning");
const appCookie = registration.headers["Set-Cookie"].split(";")[0];

assert.equal((await invoke(APP_A, "login", { method: "POST", body: { email, password: "wrong-password" } })).status, 401);
assert.equal((await invoke(APP_A, "session")).body.authenticated, false);
assert.equal((await invoke(APP_A, "data/customers")).status, 401);

const protectedWrite = await invoke(APP_A, "data/customers", { method: "POST", cookie: appCookie, body: { name: "Private test record" } });
assert.equal(protectedWrite.status, 201);
assert.equal((await invoke(APP_A, "data/customers", { cookie: appCookie })).body.length, 1);
assert.equal((await invoke(APP_B, "data/customers", { cookie: appCookie })).status, 401);
const secondAppRegistration = await invoke(APP_B, "register", { method: "POST", body: { email, password } });
assert.equal(secondAppRegistration.status, 201, "the same normalized identifier can register independently in another app");
assert.notEqual(secondAppRegistration.body.user.id, registration.body.user.id, "app identities use separate Auth identities");
const secondAppCookie = secondAppRegistration.headers["Set-Cookie"].split(";")[0];
assert.equal(memberships.has(`${APP_B}:${secondAppRegistration.body.user.id}`), true);
assert.equal((await invoke(APP_A, "data/customers", { cookie: secondAppCookie })).status, 401);
const appAAfterSecondRegistration = await invoke(APP_A, "data/customers", { method: "POST", cookie: appCookie, body: { name: "second app isolation check" } });
assert.equal(appAAfterSecondRegistration.status, 201, JSON.stringify(appAAfterSecondRegistration.body));

assert.equal(await handler({ method: "GET", headers: {} }, response(), new URL("http://feltus.test/api/apps")), false,
  "generated-app sessions do not intercept FELTUS workspace APIs");
const logout = await invoke(APP_A, "logout", { method: "POST", cookie: appCookie });
assert.equal(logout.status, 200);
assert.equal((await invoke(APP_A, "session", { cookie: appCookie })).body.authenticated, false);
assert.equal((await invoke(APP_A, "data/customers", { cookie: appCookie })).status, 401);

process.stdout.write("PASS generated-app registration, login, invalid credentials, app-scoped sessions, protected data, cross-app isolation, workspace route separation, and logout revocation\n");