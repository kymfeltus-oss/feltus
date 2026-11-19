import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";
import { createApplicationStateHandler } from "../src/lib/feltus-application-state-api.js";
import { resolveInfrastructureContract } from "../src/lib/feltus-infrastructure-contract.js";

dotenv.config();

function localConfig() {
  let gateway = process.env.FELTUS_GATEWAY_URL || "";
  let apiKey = process.env.FELTUS_PUBLISHABLE_KEY || process.env.FELTUS_API_KEY || "";
  let serviceKey = process.env.FELTUS_SERVICE_ROLE_KEY || "";
  if (!gateway || !apiKey || !serviceKey) {
    try {
      const output = execFileSync("supabase", ["status", "-o", "env"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      for (const line of output.split(/\r?\n/)) {
        const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (!match) continue;
        const value = match[2].replace(/^["']|["']$/g, "");
        if (match[1] === "API_URL") gateway ||= value;
        if (match[1] === "ANON_KEY") apiKey ||= value;
        if (match[1] === "SERVICE_ROLE_KEY") serviceKey ||= value;
      }
    } catch { /* The explicit blocker below reports unavailable local services. */ }
  }
  return { gateway: gateway || "http://127.0.0.1:54321", apiKey, serviceKey };
}

function localQuery(sql) {
  const output = execFileSync("supabase", ["db", "query", "--local", "--output-format", "json", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const start = [output.indexOf("["), output.indexOf("{")].filter(index => index >= 0).sort((a, b) => a - b)[0] ?? -1;
  if (start < 0) throw new Error("The isolated local database query returned no result.");
  const result = JSON.parse(output.slice(start));
  if (result && !Array.isArray(result) && result.error) throw new Error("The isolated local database query failed.");
  return Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
}

const { gateway, apiKey, serviceKey } = localConfig();
let gatewayUrl;
try { gatewayUrl = new URL(gateway); } catch { gatewayUrl = null; }
const gatewayHost = gatewayUrl?.hostname.replace(/^\[|\]$/g, "");
if (!gatewayUrl || !["localhost", "127.0.0.1", "::1"].includes(gatewayHost) || !apiKey || !serviceKey) {
  process.stderr.write("BLOCKED local infrastructure registration E2E: start the local Supabase stack and configure its local keys.\n");
  process.exitCode = 1;
} else {
  const password = crypto.randomBytes(32).toString("base64url");
  const ownerEmail = `feltus-infra-owner-${crypto.randomUUID()}@example.invalid`;
  const workspaceEmail = `feltus-infra-workspace-${crypto.randomUUID()}@example.invalid`;
  const generatedEmail = `feltus-infra-generated-${crypto.randomUUID()}@example.invalid`;
  const identities = [];
  const apps = [];
  let actor = null;
  let serviceMutations = 0;
  let cleanupPassed = true;

  async function request(endpoint, {
    method = "GET",
    body,
    token = serviceKey,
    isService = true,
    prefer = ""
  } = {}) {
    const response = await fetch(new URL(endpoint, gatewayUrl), {
      method,
      headers: {
        apikey: isService ? serviceKey : apiKey,
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(prefer ? { Prefer: prefer } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const code = typeof data?.code === "string" ? ` (${data.code})` : "";
      throw Object.assign(new Error(`${method} ${endpoint} failed with HTTP ${response.status}${code}.`), {
        status: response.status,
        data
      });
    }
    return data;
  }

  async function tableRequest(table, method = "GET", options = {}) {
    if (!actor?.token) return { status: 401, data: null };
    try {
      const data = await request(`/rest/v1/${table}${options.query || ""}`, {
        method,
        body: options.body,
        token: actor.token,
        isService: false,
        prefer: options.prefer || (method === "GET" ? "" : "return=representation")
      });
      return { status: 200, data };
    } catch (error) {
      return { status: error.status || 502, data: error.data || null };
    }
  }

  async function createIdentity(email, appMetadata = {}) {
    const user = await request("/auth/v1/admin/users", {
      method: "POST",
      body: { email, password, email_confirm: true, app_metadata: appMetadata }
    });
    identities.push(user.id);
    const session = await request("/auth/v1/token?grant_type=password", {
      method: "POST",
      isService: false,
      token: apiKey,
      body: { email, password }
    });
    return { id: user.id, token: session.access_token };
  }

  async function createApp(owner, label) {
    const id = crypto.randomUUID();
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    localQuery(`INSERT INTO public.feltus_applications (id, owner_id, app_name, app_type, setup_status, setup_current_step, setup_data, lifecycle_status) VALUES (${quote(id)}::uuid, ${quote(owner.id)}::uuid, ${quote(label)}, 'other', 'active', 'basics', '{}'::jsonb, 'active') RETURNING id`);
    const app = { id, owner_id: owner.id, app_name: label };
    apps.push(app);
    const visible = await request(`/rest/v1/feltus_applications?select=id,owner_id,organization_id,app_name,lifecycle_status&id=eq.${id}&limit=1`, {
      token: owner.token,
      isService: false
    });
    Object.assign(app, Array.isArray(visible) ? visible[0] : {});
    assert.equal(app.id, id, "the owner can read the isolated local app");
    return app;
  }

  const handler = createApplicationStateHandler({
    tableRequest,
    serviceRequest: async (_endpoint, options = {}) => {
      if (options.method && options.method !== "GET") serviceMutations += 1;
      return { status: 200, data: [] };
    },
    readBody: async req => req.body || {},
    getUser: () => actor ? { id: actor.id } : null
  });

  async function invoke(appId, suffix, method = "GET", body = {}) {
    const result = { status: null, headers: {}, text: "" };
    const res = {
      writeHead(status, headers = {}) { result.status = status; result.headers = headers; },
      end(text) { result.text = String(text || ""); }
    };
    const handled = await handler(
      { method, headers: {}, body },
      res,
      new URL(`/api/apps/${appId}/${suffix}`, "http://feltus.test")
    );
    assert.equal(handled, true, `${method} ${suffix} should be handled`);
    return {
      ...result,
      body: result.headers["Content-Type"]?.startsWith("application/json") ? JSON.parse(result.text) : null
    };
  }

  async function cleanupApp(owner, app) {
    const requested = await request("/rest/v1/rpc/feltus_request_application_deletion", {
      method: "POST",
      isService: false,
      token: owner.token,
      body: { p_app_id: app.id, p_confirmation: app.app_name }
    });
    if (!requested?.request_id) throw new Error("The isolated app cleanup request was not recorded.");
    await request("/rest/v1/rpc/feltus_start_application_cleanup", {
      method: "POST",
      body: { p_app_id: app.id, p_request_id: requested.request_id }
    });
    await request("/rest/v1/rpc/feltus_mark_application_files_removed", {
      method: "POST",
      body: { p_app_id: app.id, p_request_id: requested.request_id }
    });
    await request("/rest/v1/rpc/feltus_complete_application_cleanup", {
      method: "POST",
      body: { p_app_id: app.id, p_request_id: requested.request_id }
    });
    const cleanupState = localQuery(`SELECT lifecycle_status, setup_data FROM public.feltus_applications WHERE id='${app.id}'::uuid AND owner_id='${owner.id}'::uuid`);
    assert.equal(cleanupState.length, 1, "the lifecycle tombstone remains for audit");
    assert.equal(cleanupState[0].lifecycle_status, "cleanup_complete");
    assert.deepEqual(cleanupState[0].setup_data, {}, "customer registrations are removed during lifecycle cleanup");
  }

  try {
    const owner = await createIdentity(ownerEmail);
    actor = owner;
    const workspaceUser = await createIdentity(workspaceEmail);
    const appA = await createApp(owner, `Infrastructure E2E ${crypto.randomUUID()}`);
    const appB = await createApp(owner, `Infrastructure E2E B ${crypto.randomUUID()}`);

    const metadataService = await invoke(appA.id, "infrastructure-registrations", "POST", {
      kind: "services",
      type: "database",
      name: "Reporting database",
      provider: "Customer provider",
      owner: "CUSTOMER"
    });
    assert.equal(metadataService.status, 201, JSON.stringify(metadataService.body));
    assert.equal(metadataService.body.registration.observation.status, "NOT_CHECKED");
    assert.equal(metadataService.body.registration.owner, "CUSTOMER");
    assert.equal(metadataService.body.registration.management, "CUSTOMER_MANAGED");

    const reachable = await invoke(appA.id, "infrastructure-registrations", "POST", {
      kind: "environments",
      type: "customer_runtime",
      name: "Public app endpoint",
      endpoint: "https://example.com/"
    });
    assert.equal(reachable.status, 201, JSON.stringify(reachable.body));
    assert.equal(reachable.body.registration.observation.status, "REACHABLE",
      "the explicitly configured public endpoint must receive a real successful response");

    const missingHost = `https://feltus-${crypto.randomUUID()}.example.com/`;
    const unavailable = await invoke(appA.id, "infrastructure-registrations", "POST", {
      kind: "environments",
      type: "existing_hosted_runtime",
      name: "Unavailable hosted endpoint",
      endpoint: missingHost
    });
    assert.equal(unavailable.status, 201, JSON.stringify(unavailable.body));
    assert.equal(unavailable.body.registration.observation.status, "UNAVAILABLE",
      "a real DNS failure must not be reported as connected");

    const privateAddress = await invoke(appA.id, "infrastructure-registrations", "POST", {
      kind: "environments",
      type: "customer_runtime",
      name: "Private runtime",
      endpoint: "http://127.0.0.1/"
    });
    assert.equal(privateAddress.status, 201);
    assert.equal(privateAddress.body.registration.observation.status, "NOT_CHECKED",
      "loopback addresses are never contacted by the observer");

    const appState = await request(`/rest/v1/feltus_applications?select=id,setup_data&id=eq.${appA.id}&limit=1`, {
      token: owner.token,
      isService: false
    });
    const infrastructure = resolveInfrastructureContract({ app: appState[0], inputs: {} });
    assert.equal(infrastructure.registrations.services.length, 1);
    assert.equal(infrastructure.registrations.environments.length, 3);
    assert.equal(infrastructure.mode, "HYBRID");
    actor = null;
    const unauthenticated = await invoke(appA.id, "infrastructure-registrations");
    assert.equal(unauthenticated.status, 401, "a missing FELTUS session cannot read service records");
    actor = owner;
    process.stdout.write("PASS real local app records customer services and environments with persisted ownership and observed status\n");
    process.stdout.write("PASS explicit public endpoint is reachable; missing endpoint is unavailable; loopback endpoint is not checked\n");

    const crossAppDisconnect = await invoke(
      appB.id,
      `infrastructure-registrations/${metadataService.body.registration.id}`,
      "DELETE"
    );
    assert.equal(crossAppDisconnect.status, 404, "App B cannot remove App Aâ€™s registration");
    assert.equal((await invoke(appA.id, "infrastructure-registrations")).body.registrations.services.length, 1);
    assert.equal((await invoke(appB.id, "infrastructure-registrations")).body.registrations.services.length, 0);

    actor = workspaceUser;
    const workspaceDisconnect = await invoke(
      appA.id,
      `infrastructure-registrations/${metadataService.body.registration.id}`,
      "DELETE"
    );
    assert.equal(workspaceDisconnect.status, 404, "a non-owner workspace user cannot disconnect a service");

    const generated = await createIdentity(generatedEmail, {
      feltus_identity_type: "generated_app",
      feltus_app_id: appA.id
    });
    actor = generated;
    const generatedRegistration = await invoke(appA.id, "infrastructure-registrations");
    assert.equal(generatedRegistration.status, 404, "generated-app users cannot read or change FELTUS registrations");

    actor = owner;
    const disconnected = await invoke(
      appA.id,
      `infrastructure-registrations/${metadataService.body.registration.id}`,
      "DELETE"
    );
    assert.equal(disconnected.status, 200);
    assert.equal(disconnected.body.removed, true);
    assert.equal(serviceMutations, 0, "disconnect must not call a provider or deployment API");
    assert.equal((await invoke(appA.id, "infrastructure-registrations")).body.registrations.services.length, 0);
    process.stdout.write("PASS cross-app and generated-app access are denied; disconnect removes only the FELTUS record\n");
  } catch (error) {
    process.stderr.write(`FAIL real local infrastructure registration E2E: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    const ownerSession = identities.length
      ? await request("/auth/v1/token?grant_type=password", {
          method: "POST",
          isService: false,
          token: apiKey,
          body: { email: ownerEmail, password }
        }).catch(() => null)
      : null;
    const owner = ownerSession?.access_token
      ? { id: identities[0], token: ownerSession.access_token }
      : null;
    if (apps.length && !owner) {
      cleanupPassed = false;
      process.stderr.write("BLOCKED cleanup: could not renew the isolated local test owner session.\n");
    } else if (owner) {
      for (const app of apps) {
        try { await cleanupApp(owner, app); }
        catch (error) {
          cleanupPassed = false;
          process.stderr.write(`FAIL isolated app cleanup: ${error.message}\n`);
        }
      }
    }
    for (const id of identities) {
      try { await request(`/auth/v1/admin/users/${id}`, { method: "DELETE" }); }
      catch {
        cleanupPassed = false;
        process.stderr.write("FAIL isolated test identity cleanup.\n");
      }
    }
    if (cleanupPassed) process.stdout.write("PASS isolated apps and test identities cleaned up\n");
    else process.exitCode = 1;
  }
}
