import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createGithubOAuthState,
  decryptGithubSecret,
  encryptGithubSecret,
  normalizeGithubBranch,
  parseGithubWebhookEvent,
  verifyGithubOAuthState,
  verifyGithubWebhookSignature
} from "../src/lib/feltus-github.js";
import { createGithubApiHandler } from "../src/lib/feltus-github-api.js";

const APP_ID = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const USER_ID = "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2";
const REPO_ID = "c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3";
const KEY = "phase-three-test-key-that-is-longer-than-32-bytes";
const OAUTH_TOKEN = "gho_test_token_value_that_must_never_be_returned";
const HOOK_SECRET = "webhook-secret-used-only-for-signature-tests";

function result() {
  const value = { status: null, headers: {}, text: "" };
  return {
    value,
    res: {
      writeHead(status, headers = {}) { value.status = status; value.headers = headers; },
      end(text) { value.text = String(text || ""); }
    }
  };
}

async function makeRequest(handler, fn, pathname, req) {
  const response = result();
  await fn(req, response.res, new URL("https://feltus.test" + pathname));
  return response.value;
}

const encrypted = encryptGithubSecret(OAUTH_TOKEN, KEY, "github-oauth-token:v1");
assert.match(encrypted, /^\\x[0-9a-f]+$/i);
assert.equal(encrypted.includes(OAUTH_TOKEN), false);
assert.equal(decryptGithubSecret(encrypted, KEY, "github-oauth-token:v1"), OAUTH_TOKEN);
assert.throws(() => decryptGithubSecret(encrypted, "wrong-key-value-that-is-over-32-bytes", "github-oauth-token:v1"));
console.log("PASS GitHub credentials are authenticated-encrypted and never stored as plaintext");

const oauth = createGithubOAuthState({ appId: APP_ID, userId: USER_ID, masterKey: KEY, now: 100_000 });
assert.deepEqual(verifyGithubOAuthState(oauth.state, oauth.nonce, { masterKey: KEY, userId: USER_ID, now: 101_000 }), {
  app_id: APP_ID,
  user_id: USER_ID
});
assert.throws(() => verifyGithubOAuthState(oauth.state, "different-browser-nonce", { masterKey: KEY, userId: USER_ID, now: 101_000 }));
assert.throws(() => verifyGithubOAuthState(oauth.state, oauth.nonce, { masterKey: KEY, userId: APP_ID, now: 101_000 }));
assert.throws(() => verifyGithubOAuthState(oauth.state, oauth.nonce, { masterKey: KEY, userId: USER_ID, now: 700_000 }));
console.log("PASS GitHub OAuth state binds the callback to the initiating user and browser");

assert.equal(normalizeGithubBranch("feature/rewards-v2"), "feature/rewards-v2");
assert.equal(normalizeGithubBranch("../outside"), null);
assert.equal(normalizeGithubBranch("release/.hidden"), null);
assert.equal(normalizeGithubBranch("release/private.lock"), null);
assert.equal(normalizeGithubBranch("refs/heads/main"), "refs/heads/main");
const commit = "a".repeat(40);
assert.deepEqual(parseGithubWebhookEvent("push", { ref: "refs/heads/main", after: commit, deleted: false }), {
  event_name: "push",
  action_name: null,
  branch_name: "main",
  commit_sha: commit,
  pull_request_number: null
});
assert.deepEqual(parseGithubWebhookEvent("push", { ref: "refs/tags/v1.2.0", after: commit, deleted: false }), {
  event_name: "push",
  action_name: "tag_push",
  branch_name: null,
  commit_sha: commit,
  pull_request_number: null
});
assert.deepEqual(parseGithubWebhookEvent("pull_request", {
  action: "synchronize",
  number: 17,
  pull_request: { head: { ref: "feature/rewards", sha: commit } }
}), {
  event_name: "pull_request",
  action_name: "synchronize",
  branch_name: "feature/rewards",
  commit_sha: commit,
  pull_request_number: 17
});
assert.throws(() => parseGithubWebhookEvent("push", { ref: "refs/heads/../../etc", after: commit }));
assert.throws(() => parseGithubWebhookEvent("pull_request", { action: "opened", number: 1, pull_request: { head: { ref: "feature/x", sha: "short" } } }));
console.log("PASS GitHub push, tag, and pull request payloads are validated without treating tags as branches");

const connectEnv = {
  FELTUS_ENV: "production",
  FELTUS_PUBLIC_URL: "https://feltus.test",
  FELTUS_GITHUB_CLIENT_ID: "client-id",
  FELTUS_GITHUB_CLIENT_SECRET: "client-secret",
  FELTUS_SECRET_ENCRYPTION_KEY: KEY
};
let savedConnection = null;
const oauthFetches = [];
const oauthHandler = createGithubApiHandler({
  tableRequest: async (table, method, options = {}) => {
    assert.equal(table, "feltus_applications");
    assert.match(options.query, new RegExp("id=eq." + APP_ID));
    assert.match(options.query, new RegExp("owner_id=eq." + USER_ID));
    return { status: 200, data: [{ id: APP_ID, owner_id: USER_ID, organization_id: "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4", app_name: "Northwind", setup_status: "configuring" }] };
  },
  serviceRequest: async (path, options = {}) => {
    if (options.method === "POST") {
      savedConnection = options.body;
      return { status: 201, data: [{ id: "e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5", account_label: "feltus-owner" }] };
    }
    return { status: 200, data: [] };
  },
  readBody: async () => ({}),
  getUser: () => ({ id: USER_ID }),
  env: connectEnv,
  fetchImpl: async (url, options) => {
    oauthFetches.push({ url: String(url), options });
    if (String(url) === "https://github.com/login/oauth/access_token") return Response.json({ access_token: OAUTH_TOKEN, token_type: "bearer", scope: "repo,admin:repo_hook,read:user" });
    if (String(url) === "https://api.github.com/user") return Response.json({ login: "feltus-owner" });
    throw new Error("Unexpected GitHub request.");
  }
});
const connect = await makeRequest(oauthHandler, oauthHandler.handleAuthenticated.bind(oauthHandler),
  "/api/apps/" + APP_ID + "/github/connect", { method: "GET", headers: {} });
assert.equal(connect.status, 302);
const authorizationUrl = new URL(connect.headers.Location);
assert.equal(authorizationUrl.hostname, "github.com");
assert.match(authorizationUrl.searchParams.get("scope"), /admin:repo_hook/);
const state = authorizationUrl.searchParams.get("state");
const oauthCookie = connect.headers["Set-Cookie"].split(";")[0];
const callback = await makeRequest(oauthHandler, oauthHandler.handleAuthenticated.bind(oauthHandler),
  "/api/github/callback?state=" + encodeURIComponent(state) + "&code=one-time-code", {
    method: "GET",
    headers: { cookie: oauthCookie }
  });
assert.equal(callback.status, 302);
assert.equal(callback.headers.Location, "/apps/" + APP_ID + "/source?github=connected");
assert.equal(savedConnection.provider, "github");
assert.equal(savedConnection.credential_ciphertext.includes(OAUTH_TOKEN), false);
assert.equal(decryptGithubSecret(savedConnection.credential_ciphertext, KEY, "github-oauth-token:v1"), OAUTH_TOKEN);
assert.equal(callback.text.includes(OAUTH_TOKEN), false);
console.log("PASS GitHub OAuth callback stores an encrypted token and returns to the app source screen");

const failedCallbackHandler = createGithubApiHandler({
  tableRequest: async () => ({ status: 200, data: [{
    id: APP_ID,
    owner_id: USER_ID,
    organization_id: "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4",
    app_name: "Northwind"
  }] }),
  serviceRequest: async () => ({ status: 200, data: [] }),
  readBody: async () => ({}),
  getUser: () => ({ id: USER_ID }),
  env: connectEnv,
  fetchImpl: async () => { throw new Error("Network error must not be displayed to the user."); }
});
const failedCallback = await makeRequest(failedCallbackHandler, failedCallbackHandler.handleAuthenticated.bind(failedCallbackHandler),
  "/api/github/callback?state=" + encodeURIComponent(state) + "&code=one-time-code", {
    method: "GET",
    headers: { cookie: oauthCookie }
  });
assert.equal(failedCallback.status, 302);
assert.equal(failedCallback.headers.Location, "/apps/" + APP_ID + "/source?github=connection_failed");
assert.equal(failedCallback.text.includes("Network error"), false);
console.log("PASS GitHub OAuth exchange failures return users to the repository screen without raw error details");

const connectedRepository = {
  id: REPO_ID,
  provider_repository_id: "123456789",
  repository_name: "feltus-owner/northwind",
  default_branch: "main",
  webhook_id: "42",
  webhook_secret_ciphertext: null,
  webhook_secret_key_version: null,
  archived_at: null,
  git_connection_id: "e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5"
};
const statusHandler = createGithubApiHandler({
  tableRequest: async () => ({ status: 200, data: [{
    id: APP_ID,
    owner_id: USER_ID,
    organization_id: "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4",
    app_name: "Northwind"
  }] }),
  serviceRequest: async path => {
    if (path.includes("feltus_git_connections?")) return { status: 200, data: [{
      id: connectedRepository.git_connection_id,
      provider: "github",
      account_label: "feltus-owner"
    }] };
    if (path.includes("feltus_project_repositories?")) return { status: 200, data: [{ repository_id: REPO_ID }] };
    if (path.includes("feltus_repositories?")) return { status: 200, data: [connectedRepository] };
    if (path.includes("feltus_repository_branches?")) return { status: 200, data: [] };
    throw new Error("Unexpected GitHub status query.");
  },
  readBody: async () => ({}),
  getUser: () => ({ id: USER_ID }),
  env: connectEnv
});
const connectionStatus = await makeRequest(statusHandler, statusHandler.handleAuthenticated.bind(statusHandler),
  "/api/apps/" + APP_ID + "/github", { method: "GET", headers: {} });
const statusPayload = JSON.parse(connectionStatus.text);
assert.equal(connectionStatus.status, 200);
assert.equal(statusPayload.connected, true);
assert.equal(statusPayload.repositories[0].webhook_status, "not_configured");
assert.equal(connectionStatus.text.includes("webhook_secret_ciphertext"), false);
console.log("PASS GitHub status does not call a legacy webhook active without its encrypted verification secret");

const organizationId = "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4";
const gitConnectionId = "e5e5e5e5-e5e5-45e5-85e5-e5e5e5e5e5e5";
const developmentEnvironmentId = "f7f7f7f7-f7f7-47f7-87f7-f7f7f7f7f7f7";
const gitConnection = {
  id: gitConnectionId,
  organization_id: organizationId,
  provider: "github",
  account_label: "feltus-owner",
  credential_ciphertext: encryptGithubSecret(OAUTH_TOKEN, KEY, "github-oauth-token:v1"),
  encryption_key_version: "aes-256-gcm-hkdf-v1"
};
const linkedRepo = {
  id: REPO_ID,
  organization_id: organizationId,
  git_connection_id: gitConnectionId,
  provider_repository_id: "123456789",
  repository_name: "feltus-owner/northwind",
  default_branch: "main",
  webhook_id: null
};
let repositoryExists = false;
const repositoryWrites = [];
const repositoryFetches = [];
const repositoryHandler = createGithubApiHandler({
  tableRequest: async () => ({ status: 200, data: [{
    id: APP_ID,
    owner_id: USER_ID,
    organization_id: organizationId,
    app_name: "Northwind"
  }] }),
  serviceRequest: async (path, options = {}) => {
    repositoryWrites.push({ path, options });
    if (path.includes("feltus_git_connections?")) return { status: 200, data: [gitConnection] };
    if (path.includes("feltus_repositories?") && options.method === "POST") {
      repositoryExists = true;
      return { status: 201, data: [linkedRepo] };
    }
    if (path.includes("feltus_repositories?") && options.method === "PATCH") {
      linkedRepo.webhook_id = "77";
      linkedRepo.webhook_secret_ciphertext = options.body.webhook_secret_ciphertext;
      linkedRepo.webhook_secret_key_version = options.body.webhook_secret_key_version;
      return { status: 200, data: [linkedRepo] };
    }
    if (path.includes("feltus_repositories?")) return { status: 200, data: repositoryExists ? [linkedRepo] : [] };
    if (path.includes("feltus_project_repositories?")) return { status: 201, data: [] };
    if (path.includes("feltus_environments?")) return { status: 200, data: [{ id: developmentEnvironmentId }] };
    if (path.includes("feltus_repository_branches?")) return { status: 201, data: [] };
    throw new Error("Unexpected repository-link database request: " + path);
  },
  readBody: async () => ({ provider_repository_id: "123456789" }),
  getUser: () => ({ id: USER_ID }),
  env: connectEnv,
  fetchImpl: async (url, options = {}) => {
    repositoryFetches.push({ url: String(url), options });
    if (String(url) === "https://api.github.com/user/repos?per_page=100&type=all&sort=updated") {
      return Response.json([{ id: 123456789, full_name: "feltus-owner/northwind", clone_url: "https://github.com/feltus-owner/northwind.git", private: true, default_branch: "main", archived: false, disabled: false }]);
    }
    if (String(url) === "https://api.github.com/repositories/123456789") {
      return Response.json({ owner: { login: "feltus-owner" }, name: "northwind", clone_url: "https://github.com/feltus-owner/northwind.git" });
    }
    if (String(url) === "https://api.github.com/repos/feltus-owner/northwind/branches/main") {
      return Response.json({ commit: { sha: commit } });
    }
    if (String(url) === "https://api.github.com/repos/feltus-owner/northwind/hooks" ||
        String(url) === "https://api.github.com/repos/feltus-owner/northwind/hooks/77") {
      return Response.json({ id: 77 });
    }
    throw new Error("Unexpected GitHub repository request: " + String(url));
  }
});
const repositoryResponse = await makeRequest(repositoryHandler, repositoryHandler.handleAuthenticated.bind(repositoryHandler),
  "/api/apps/" + APP_ID + "/github/repository", { method: "POST", headers: {} });
const repositoryPayload = JSON.parse(repositoryResponse.text);
assert.equal(repositoryResponse.status, 200);
assert.equal(repositoryPayload.repository.latest_commit_sha, commit);
assert.equal(repositoryPayload.webhook.status, "active");
assert.equal(repositoryResponse.text.includes(OAUTH_TOKEN), false);
assert.equal(repositoryWrites.some(call => call.path.includes("feltus_project_repositories?") && call.options.method === "POST"), true);
const branchWrite = repositoryWrites.find(call => call.path.includes("feltus_repository_branches?") && call.options.method === "POST");
assert.equal(branchWrite.options.body.latest_commit_sha, commit);
assert.equal(branchWrite.options.body.environment_id, developmentEnvironmentId);
const createdHook = repositoryFetches.find(call => call.url.endsWith("/hooks"));
assert.equal(createdHook.options.method, "POST");

linkedRepo.webhook_secret_ciphertext = null;
linkedRepo.webhook_secret_key_version = null;
const repairedWebhookResponse = await makeRequest(repositoryHandler, repositoryHandler.handleAuthenticated.bind(repositoryHandler),
  "/api/apps/" + APP_ID + "/github/repository", { method: "POST", headers: {} });
assert.equal(repairedWebhookResponse.status, 200);
assert.equal(JSON.parse(repairedWebhookResponse.text).webhook.status, "active");
const repairedHook = repositoryFetches.find(call => call.url.endsWith("/hooks/77"));
assert.equal(repairedHook.options.method, "PATCH");
assert.equal(Boolean(linkedRepo.webhook_secret_ciphertext), true);
console.log("PASS GitHub repository selection persists its commit and repairs legacy webhooks in place");

const webhookRepo = {
  id: REPO_ID,
  organization_id: "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4",
  webhook_id: "42",
  webhook_secret_ciphertext: encryptGithubSecret(HOOK_SECRET, KEY, "github-webhook-secret:v1"),
  webhook_secret_key_version: "aes-256-gcm-hkdf-v1",
  archived_at: null
};
const webhookCalls = [];
const webhookHandler = createGithubApiHandler({
  tableRequest: async () => ({ status: 200, data: [] }),
  serviceRequest: async (path, options = {}) => {
    webhookCalls.push({ path, options });
    if (path.includes("feltus_repositories?")) return { status: 200, data: [webhookRepo] };
    if (path.includes("feltus_record_github_webhook_event")) return {
      status: 200,
      data: { duplicate: webhookCalls.filter(call => call.path.includes("feltus_record_github_webhook_event")).length > 1, event_id: "f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6" }
    };
    throw new Error("Unexpected webhook database request.");
  },
  readBody: async () => ({}),
  getUser: () => null,
  env: { FELTUS_SECRET_ENCRYPTION_KEY: KEY }
});
const pushPayload = JSON.stringify({ ref: "refs/heads/main", after: commit, deleted: false });
const rawPush = Buffer.from(pushPayload);
const signature = "sha256=" + createHmac("sha256", HOOK_SECRET).update(rawPush).digest("hex");
const webhookRequest = () => ({
  method: "POST",
  headers: {
    "x-hub-signature-256": signature,
    "x-github-delivery": "1f1f1f1f-2222-4333-8444-555555555555",
    "x-github-event": "push"
  },
  async *[Symbol.asyncIterator]() { yield rawPush; }
});
assert.equal(verifyGithubWebhookSignature(rawPush, signature, HOOK_SECRET), true);
assert.equal(verifyGithubWebhookSignature(rawPush, "sha256=" + "0".repeat(64), HOOK_SECRET), false);
const firstWebhook = await makeRequest(webhookHandler, webhookHandler.handleWebhook.bind(webhookHandler),
  "/api/github/webhooks/" + REPO_ID, webhookRequest());
assert.equal(firstWebhook.status, 202);
assert.equal(JSON.parse(firstWebhook.text).duplicate, false);
const recordCall = webhookCalls.find(call => call.path.includes("feltus_record_github_webhook_event"));
assert.equal(recordCall.options.body.p_event.branch_name, "main");
assert.equal(recordCall.options.body.p_event.commit_sha, commit);
assert.match(recordCall.options.body.p_event.payload_sha256, /^[0-9a-f]{64}$/);
const duplicateWebhook = await makeRequest(webhookHandler, webhookHandler.handleWebhook.bind(webhookHandler),
  "/api/github/webhooks/" + REPO_ID, webhookRequest());
assert.equal(duplicateWebhook.status, 202);
assert.equal(JSON.parse(duplicateWebhook.text).duplicate, true);
const invalidWebhookRequest = webhookRequest();
invalidWebhookRequest.headers["x-hub-signature-256"] = "sha256=" + "0".repeat(64);
const invalidWebhook = await makeRequest(webhookHandler, webhookHandler.handleWebhook.bind(webhookHandler),
  "/api/github/webhooks/" + REPO_ID, invalidWebhookRequest);
assert.equal(invalidWebhook.status, 401);
assert.equal(webhookCalls.filter(call => call.path.includes("feltus_record_github_webhook_event")).length, 2);
console.log("PASS GitHub webhook signatures are verified before idempotent event persistence");
