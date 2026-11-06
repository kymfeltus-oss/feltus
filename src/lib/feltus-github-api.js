import crypto from "node:crypto";
import {
  createGithubOAuthState,
  decryptGithubSecret,
  encryptGithubSecret,
  encryptGithubOAuthCredentialBundle,
  resolveGithubOAuthAccessToken,
  normalizeGithubBranch,
  parseGithubWebhookEvent,
  sha256Hex,
  verifyGithubOAuthState,
  verifyGithubWebhookSignature
} from "./feltus-github.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_WEBHOOK_BYTES = 1_048_576;
const ENCRYPTION_KEY_VERSION = "aes-256-gcm-hkdf-v1";
const OAUTH_COOKIE = "feltus_github_oauth";

function rows(result, label) {
  if (!result || result.status < 200 || result.status >= 300) {
    const error = new Error(label + " could not be loaded.");
    error.status = result?.status >= 400 && result.status < 500 ? result.status : 502;
    throw error;
  }
  return Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
}

function firstRow(result, label) {
  return rows(result, label)[0] || null;
}

function send(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  res.end(JSON.stringify(value));
}

function errorResult(error) {
  const status = Number.isInteger(error?.status) ? error.status : 502;
  const message = status >= 500 ? "GitHub is temporarily unavailable." : error.message || "GitHub request could not be completed.";
  return { status, message };
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const index = cookie.indexOf("=");
    if (index < 0 || cookie.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(cookie.slice(index + 1).trim()); } catch { return null; }
  }
  return null;
}

function cookieHeader(value, { secure, maxAge = 600 } = {}) {
  return OAUTH_COOKIE + "=" + encodeURIComponent(value) +
    "; Path=/api/github/callback; HttpOnly; SameSite=Lax; Max-Age=" + maxAge +
    (secure ? "; Secure" : "");
}

function githubConfiguration(env = process.env) {
  const missing = [];
  if (!env.FELTUS_GITHUB_CLIENT_ID) missing.push("FELTUS_GITHUB_CLIENT_ID");
  if (!env.FELTUS_GITHUB_CLIENT_SECRET) missing.push("FELTUS_GITHUB_CLIENT_SECRET");
  if (typeof env.FELTUS_SECRET_ENCRYPTION_KEY !== "string" || Buffer.byteLength(env.FELTUS_SECRET_ENCRYPTION_KEY, "utf8") < 32) missing.push("FELTUS_SECRET_ENCRYPTION_KEY");
  let publicUrl = null;
  try { publicUrl = new URL(env.FELTUS_PUBLIC_URL || ""); } catch { missing.push("FELTUS_PUBLIC_URL"); }
  const production = String(env.FELTUS_ENV || "").toLowerCase() === "production";
  if (publicUrl && (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash ||
      (production && publicUrl.protocol !== "https:") ||
      (!production && !["http:", "https:"].includes(publicUrl.protocol)))) {
    missing.push("a valid FELTUS_PUBLIC_URL");
  }
  return {
    available: missing.length === 0,
    reason: missing.length ? "GitHub connection needs " + [...new Set(missing)].join(", ") + " to be configured." : null,
    publicUrl
  };
}

function publicWebhookUrl(publicUrl, repositoryId) {
  if (!publicUrl || publicUrl.protocol !== "https:" || !UUID.test(repositoryId)) return null;
  const host = publicUrl.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "0.0.0.0" || host === "::1" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  return new URL("/api/github/webhooks/" + encodeURIComponent(repositoryId), publicUrl).toString();
}

async function readRawBody(req, maxBytes = MAX_WEBHOOK_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error("Webhook payload is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createGithubApiHandler({
  tableRequest,
  serviceRequest,
  readBody,
  getUser,
  fetchImpl = globalThis.fetch,
  env = process.env
} = {}) {
  if (typeof tableRequest !== "function" || typeof serviceRequest !== "function" ||
      typeof readBody !== "function" || typeof getUser !== "function" || typeof fetchImpl !== "function") {
    throw new TypeError("GitHub API requires tableRequest, serviceRequest, readBody, getUser, and fetch.");
  }

  const loadApp = async (appId, userId) => firstRow(await tableRequest("feltus_applications", "GET", {
    query: "?" + new URLSearchParams({
      select: "id,owner_id,organization_id,app_name,setup_status,environment",
      id: "eq." + appId,
      owner_id: "eq." + userId,
      limit: "1"
    })
  }), "Application");

  async function githubRequest(path, token, { method = "GET", body = null, form = null } = {}) {
    const isOAuth = path === "https://github.com/login/oauth/access_token";
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "FELTUS-Labs",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
    };
    let response;
    try {
      response = await fetchImpl(isOAuth ? path : "https://api.github.com" + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      const error = new Error("GitHub could not be reached.");
      error.status = 502;
      throw error;
    }
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(response.status === 401
        ? "GitHub authorization is no longer valid. Reconnect GitHub."
        : response.status === 403 || response.status === 422
          ? "GitHub did not allow this action. Check the repository permissions and authorized scopes."
          : response.status === 404
            ? "The selected GitHub repository is unavailable to this connection."
            : "GitHub request could not be completed.");
      error.status = response.status === 401 ? 409 : response.status === 403 || response.status === 422 ? 403 : response.status === 404 ? 404 : 502;
      throw error;
    }
    return payload;
  }

  async function loadConnection(app) {
    if (!app?.organization_id) return null;
    return firstRow(await serviceRequest("/rest/v1/feltus_git_connections?" + new URLSearchParams({
      select: "id,organization_id,provider,account_label,credential_ciphertext,encryption_key_version,created_at",
      organization_id: "eq." + app.organization_id,
      provider: "eq.github",
      disabled_at: "is.null",
      order: "created_at.desc",
      limit: "1"
    })), "GitHub connection");
  }

  async function reloadConnectionCredential(connection) {
    if (!connection?.id) return null;
    return firstRow(await serviceRequest("/rest/v1/feltus_git_connections?" + new URLSearchParams({
      select: "id,organization_id,provider,account_label,credential_ciphertext,encryption_key_version,disabled_at",
      id: "eq." + connection.id,
      disabled_at: "is.null",
      limit: "1"
    })), "GitHub connection");
  }

  async function connectionToken(connection, { forceRefresh = false } = {}) {
    if (!connection || connection.provider !== "github" || connection.encryption_key_version !== ENCRYPTION_KEY_VERSION) {
      const error = new Error("GitHub authorization is unavailable. Reconnect GitHub.");
      error.status = 409;
      throw error;
    }
    const resolved = await resolveGithubOAuthAccessToken({
      credentialCiphertext: connection.credential_ciphertext,
      masterKey: env.FELTUS_SECRET_ENCRYPTION_KEY,
      clientId: env.FELTUS_GITHUB_CLIENT_ID,
      clientSecret: env.FELTUS_GITHUB_CLIENT_SECRET,
      fetchImpl,
      persist: async (nextCiphertext, previousCiphertext) => {
        const filter = new URLSearchParams({
          id: "eq." + connection.id,
          disabled_at: "is.null",
          credential_ciphertext: "eq." + previousCiphertext
        });
        const saved = await serviceRequest("/rest/v1/feltus_git_connections?" + filter.toString(), {
          method: "PATCH",
          prefer: "return=representation",
          body: { credential_ciphertext: nextCiphertext }
        });
        const updated = firstRow(saved, "GitHub connection");
        if (updated?.credential_ciphertext) connection.credential_ciphertext = updated.credential_ciphertext;
        return Boolean(updated?.id);
      },
      reload: () => reloadConnectionCredential(connection),
      forceRefresh
    });
    connection.credential_ciphertext = resolved.credential_ciphertext;
    return resolved.access_token;
  }

  async function githubRequestWithConnection(path, connection, options = {}) {
    let token = await connectionToken(connection);
    try {
      return await githubRequest(path, token, options);
    } catch (error) {
      if (error.status !== 409) throw error;
      token = await connectionToken(connection, { forceRefresh: true });
      return githubRequest(path, token, options);
    }
  }

  async function attachedRepositories(app) {
    const links = rows(await serviceRequest("/rest/v1/feltus_project_repositories?" + new URLSearchParams({
      select: "repository_id,created_at",
      app_id: "eq." + app.id,
      order: "created_at.desc",
      limit: "10"
    })), "Application repositories");
    if (!links.length) return [];
    const ids = links.map(link => link.repository_id).filter(id => UUID.test(String(id)));
    if (!ids.length) return [];
    const repositories = rows(await serviceRequest("/rest/v1/feltus_repositories?" + new URLSearchParams({
      select: "id,provider_repository_id,repository_name,default_branch,webhook_id,webhook_secret_ciphertext,webhook_secret_key_version,archived_at,git_connection_id",
      id: "in.(" + ids.join(",") + ")",
      archived_at: "is.null"
    })), "Application repositories");
    const branches = rows(await serviceRequest("/rest/v1/feltus_repository_branches?" + new URLSearchParams({
      select: "repository_id,branch_name,is_default,latest_commit_sha,updated_at",
      app_id: "eq." + app.id,
      order: "updated_at.desc",
      limit: "100"
    })), "Repository branches");
    return repositories.map(repository => ({
      id: repository.id,
      provider_repository_id: repository.provider_repository_id,
      name: repository.repository_name,
      default_branch: repository.default_branch,
      webhook_status: repository.webhook_id && repository.webhook_secret_ciphertext &&
        repository.webhook_secret_key_version === ENCRYPTION_KEY_VERSION ? "active" : "not_configured",
      branches: branches.filter(branch => branch.repository_id === repository.id)
    }));
  }

  async function githubRepositories(app, knownConnection = null) {
    const connection = knownConnection || await loadConnection(app);
    if (!connection) {
      const error = new Error("Connect GitHub before choosing a repository.");
      error.status = 409;
      throw error;
    }
    const payload = await githubRequestWithConnection("/user/repos?per_page=100&type=all&sort=updated", connection);
    if (!Array.isArray(payload)) throw new Error("GitHub returned an invalid repository list.");
    return payload.filter(repository =>
      repository && /^\d{1,30}$/.test(String(repository.id)) &&
      typeof repository.full_name === "string" &&
      typeof repository.clone_url === "string" &&
      repository.clone_url.startsWith("https://github.com/") &&
      normalizeGithubBranch(repository.default_branch) === repository.default_branch &&
      !repository.archived && !repository.disabled
    ).map(repository => ({
      provider_repository_id: String(repository.id),
      name: repository.full_name,
      description: typeof repository.description === "string" ? repository.description.slice(0, 240) : null,
      private: repository.private === true,
      default_branch: repository.default_branch,
      html_url: repository.html_url
    }));
  }

  async function setupWebhook(app, repository, remoteRepository, connection) {
    const url = publicWebhookUrl(githubConfiguration(env).publicUrl, repository.id);
    if (!url) return { status: "not_configured", message: "A public HTTPS FELTUS URL is required before GitHub can send webhooks." };
    const secret = crypto.randomBytes(32).toString("base64url");
    const existingHookId = /^\d{1,30}$/.test(String(repository.webhook_id || "")) ? String(repository.webhook_id) : null;
    let hook;
    let createdNewHook = false;
    try {
      const repositoryPath = "/repos/" + encodeURIComponent(remoteRepository.owner.login) + "/" +
        encodeURIComponent(remoteRepository.name) + "/hooks";
      const body = {
        name: "web",
        active: true,
        events: ["push", "pull_request"],
        config: { url, content_type: "json", secret, insecure_ssl: "0" }
      };
      if (existingHookId) {
        try {
          hook = await githubRequestWithConnection(repositoryPath + "/" + encodeURIComponent(existingHookId), connection, {
            method: "PATCH",
            body
          });
        } catch (error) {
          if (error.status !== 404) throw error;
          hook = await githubRequestWithConnection(repositoryPath, connection, { method: "POST", body });
          createdNewHook = true;
        }
      } else {
        hook = await githubRequestWithConnection(repositoryPath, connection, { method: "POST", body });
        createdNewHook = true;
      }
    } catch (error) {
      return { status: error.status === 403 ? "permission_required" : "failed", message: error.message };
    }
    if (!hook || !/^\d{1,30}$/.test(String(hook.id))) {
      return { status: "failed", message: "GitHub did not return a webhook reference." };
    }
    const saved = await serviceRequest("/rest/v1/feltus_repositories?id=eq." + encodeURIComponent(repository.id), {
      method: "PATCH",
      prefer: "return=representation",
      body: {
        webhook_id: String(hook.id),
        webhook_secret_ciphertext: encryptGithubSecret(secret, env.FELTUS_SECRET_ENCRYPTION_KEY, "github-webhook-secret:v1"),
        webhook_secret_key_version: ENCRYPTION_KEY_VERSION
      }
    });
    if (saved.status < 200 || saved.status >= 300) {
      if (createdNewHook) {
        try {
          await githubRequestWithConnection("/repos/" + encodeURIComponent(remoteRepository.owner.login) + "/" +
            encodeURIComponent(remoteRepository.name) + "/hooks/" + encodeURIComponent(String(hook.id)), connection, { method: "DELETE" });
        } catch {}
      }
      return { status: "failed", message: "GitHub created the webhook, but FELTUS could not store its verification secret." };
    }
    return { status: "active", message: "Push and pull request updates are connected." };
  }

  async function handleWebhook(req, res, url) {
    const match = /^\/api\/github\/webhooks\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (!match) return false;
    if (String(req.method || "").toUpperCase() !== "POST") {
      send(res, 405, { error: "Method not allowed." }, { Allow: "POST" });
      return true;
    }
    try {
      if (Buffer.byteLength(env.FELTUS_SECRET_ENCRYPTION_KEY || "", "utf8") < 32) {
        send(res, 503, { error: "GitHub webhook verification is not configured." });
        return true;
      }
      const repositoryId = match[1];
      const repository = firstRow(await serviceRequest("/rest/v1/feltus_repositories?" + new URLSearchParams({
        select: "id,organization_id,webhook_id,webhook_secret_ciphertext,webhook_secret_key_version,archived_at",
        id: "eq." + repositoryId,
        limit: "1"
      })), "GitHub repository");
      if (!repository || repository.archived_at || !repository.webhook_secret_ciphertext ||
          repository.webhook_secret_key_version !== ENCRYPTION_KEY_VERSION) {
        send(res, 404, { error: "GitHub webhook is unavailable." });
        return true;
      }
      const rawBody = await readRawBody(req);
      const signature = req.headers["x-hub-signature-256"];
      const secret = decryptGithubSecret(repository.webhook_secret_ciphertext, env.FELTUS_SECRET_ENCRYPTION_KEY, "github-webhook-secret:v1");
      if (!verifyGithubWebhookSignature(rawBody, signature, secret)) {
        send(res, 401, { error: "GitHub webhook signature is invalid." });
        return true;
      }
      const deliveryId = String(req.headers["x-github-delivery"] || "");
      const eventName = String(req.headers["x-github-event"] || "");
      if (!/^[A-Za-z0-9-]{1,200}$/.test(deliveryId)) {
        send(res, 400, { error: "GitHub delivery reference is invalid." });
        return true;
      }
      let payload;
      try { payload = JSON.parse(rawBody.toString("utf8")); } catch {
        send(res, 400, { error: "GitHub webhook payload is invalid." });
        return true;
      }
      const event = parseGithubWebhookEvent(eventName, payload);
      const result = firstRow(await serviceRequest("/rest/v1/rpc/feltus_record_github_webhook_event", {
        method: "POST",
        body: {
          p_repository_id: repository.id,
          p_delivery_id: deliveryId,
          p_event: {
            ...event,
            payload_sha256: sha256Hex(rawBody),
            signature_verified: true
          }
        }
      }), "GitHub webhook event");
      if (!result?.event_id) throw new Error("FELTUS did not confirm the webhook event.");
      send(res, 202, { accepted: true, duplicate: result.duplicate === true });
    } catch (error) {
      const result = errorResult(error);
      send(res, result.status, { error: result.message });
    }
    return true;
  }

  async function handleAuthenticated(req, res, url) {
    const callback = url.pathname === "/api/github/callback";
    const appMatch = /^\/api\/apps\/([0-9a-f-]{36})\/github(?:\/(connect|repositories|repository|webhook))?$/i.exec(url.pathname);
    let callbackAppId = null;
    if (!callback && !appMatch) return false;
    let user = getUser();
    try {
      if (callback && String(req.method || "").toUpperCase() === "GET") {
        const { available, publicUrl } = githubConfiguration(env);
        const cookie = cookieValue(req, OAUTH_COOKIE);
        let claim;
        try {
          claim = verifyGithubOAuthState(url.searchParams.get("state"), cookie, {
            masterKey: env.FELTUS_SECRET_ENCRYPTION_KEY
          });
          user = { id: claim.user_id };
        } catch {
          res.writeHead(302, {
            Location: "/apps?github=authorization_failed",
            "Cache-Control": "no-store",
            "Set-Cookie": cookieHeader("", { secure: String(env.FELTUS_ENV).toLowerCase() === "production", maxAge: 0 })
          });
          res.end();
          return true;
        }
        callbackAppId = claim.app_id;
        const app = await loadApp(claim.app_id, user.id);
        if (!app) {
          res.writeHead(302, { Location: "/apps?github=authorization_failed", "Cache-Control": "no-store" });
          res.end();
          return true;
        }
        if (!available) {
          res.writeHead(302, { Location: "/apps/" + encodeURIComponent(app.id) + "/source?github=not_configured", "Cache-Control": "no-store" });
          res.end();
          return true;
        }
        const code = url.searchParams.get("code");
        if (!code || code.length > 2048) {
          res.writeHead(302, { Location: "/apps/" + encodeURIComponent(app.id) + "/source?github=authorization_failed", "Cache-Control": "no-store" });
          res.end();
          return true;
        }
        const tokenResult = await githubRequest("https://github.com/login/oauth/access_token", null, {
          method: "POST",
          form: { client_id: env.FELTUS_GITHUB_CLIENT_ID, client_secret: env.FELTUS_GITHUB_CLIENT_SECRET, code }
        });
        if (typeof tokenResult?.access_token !== "string" || tokenResult.access_token.length < 20 || tokenResult.access_token.length > 4096) {
          throw new Error("GitHub authorization did not return an access token.");
        }
        const profile = await githubRequest("/user", tokenResult.access_token);
        if (!profile || !/^[A-Za-z0-9-]{1,39}$/.test(String(profile.login || "")) || !app.organization_id) {
          throw new Error("GitHub account details could not be verified.");
        }
        const credentialCiphertext = encryptGithubOAuthCredentialBundle(tokenResult, env.FELTUS_SECRET_ENCRYPTION_KEY);
        const existingConnectionFilter = new URLSearchParams({
          select: "id,account_label,created_at",
          organization_id: "eq." + app.organization_id,
          provider: "eq.github",
          account_label: "ilike." + String(profile.login),
          disabled_at: "is.null"
        });
        const updatedConnections = rows(await serviceRequest(
          "/rest/v1/feltus_git_connections?" + existingConnectionFilter.toString(),
          {
            method: "PATCH",
            prefer: "return=representation",
            body: { credential_ciphertext: credentialCiphertext }
          }
        ), "GitHub connection");
        const connection = updatedConnections[0] || firstRow(await serviceRequest(
          "/rest/v1/feltus_git_connections?select=id,account_label,created_at",
          {
            method: "POST",
            prefer: "return=representation",
            body: {
              organization_id: app.organization_id,
              provider: "github",
              account_label: String(profile.login).slice(0, 120),
              credential_ciphertext: credentialCiphertext,
              encryption_key_version: ENCRYPTION_KEY_VERSION,
              created_by: user.id
            }
          }
        ), "GitHub connection");
        if (!connection?.id) throw new Error("GitHub connection could not be saved.");
        res.writeHead(302, {
          Location: "/apps/" + encodeURIComponent(app.id) + "/source?github=connected",
          "Cache-Control": "no-store",
          "Set-Cookie": cookieHeader("", { secure: String(env.FELTUS_ENV).toLowerCase() === "production", maxAge: 0 })
        });
        res.end();
        return true;
      }

      if (!user?.id) {
        send(res, 401, { error: "Authentication required." });
        return true;
      }

      const [, appId, action] = appMatch;
      if (!UUID.test(appId)) {
        send(res, 400, { error: "A valid application reference is required." });
        return true;
      }
      const app = await loadApp(appId, user.id);
      if (!app) {
        send(res, 404, { error: "Application not found." });
        return true;
      }
      const method = String(req.method || "GET").toUpperCase();
      const config = githubConfiguration(env);
      if (action === "connect" && method === "GET") {
        if (!config.available) {
          send(res, 503, { error: config.reason });
          return true;
        }
        const { state, nonce } = createGithubOAuthState({ appId, userId: user.id, masterKey: env.FELTUS_SECRET_ENCRYPTION_KEY });
        const callbackUrl = new URL("/api/github/callback", config.publicUrl).toString();
        const authorize = new URL("https://github.com/login/oauth/authorize");
        authorize.searchParams.set("client_id", env.FELTUS_GITHUB_CLIENT_ID);
        authorize.searchParams.set("redirect_uri", callbackUrl);
        authorize.searchParams.set("scope", "repo admin:repo_hook read:user");
        authorize.searchParams.set("state", state);
        res.writeHead(302, {
          Location: authorize.toString(),
          "Cache-Control": "no-store",
          "Set-Cookie": cookieHeader(nonce, { secure: String(env.FELTUS_ENV).toLowerCase() === "production" })
        });
        res.end();
        return true;
      }
      if (action === "repositories" && method === "GET") {
        const connection = await loadConnection(app);
        const attached = await attachedRepositories(app);
        send(res, 200, {
          connected: Boolean(connection),
          account_label: connection?.account_label || null,
          repositories: await githubRepositories(app, connection),
          attached
        });
        return true;
      }
      if (!action && method === "GET") {
        const connection = await loadConnection(app);
        send(res, 200, {
          configured: config.available,
          configuration_reason: config.reason,
          webhook_setup_available: Boolean(publicWebhookUrl(config.publicUrl, app.id)),
          connected: Boolean(connection),
          account_label: connection?.account_label || null,
          repositories: await attachedRepositories(app)
        });
        return true;
      }
      if (action === "repository" && method === "POST") {
        const body = await readBody(req, 4096);
        const providerRepositoryId = String(body.provider_repository_id || "");
        const requestedBranch = String(body.branch_name || "").trim();
        if (!/^\d{1,30}$/.test(providerRepositoryId)) {
          send(res, 400, { error: "Choose a valid GitHub repository." });
          return true;
        }
        const connection = await loadConnection(app);
        if (!connection) {
          send(res, 409, { error: "Connect GitHub before choosing a repository." });
          return true;
        }
        const choices = await githubRepositories(app, connection);
        const selected = choices.find(repository => repository.provider_repository_id === providerRepositoryId);
        if (!selected) {
          send(res, 404, { error: "That repository is not available to the connected GitHub account." });
          return true;
        }
        const remote = await githubRequestWithConnection("/repositories/" + encodeURIComponent(providerRepositoryId), connection);
        const branch = requestedBranch || selected.default_branch;
        if (!remote || typeof remote.owner?.login !== "string" || typeof remote.name !== "string" ||
            normalizeGithubBranch(branch) !== branch || !remote.clone_url?.startsWith("https://github.com/")) {
          send(res, 502, { error: "GitHub returned incomplete repository details." });
          return true;
        }
        let repository = firstRow(await serviceRequest("/rest/v1/feltus_repositories?" + new URLSearchParams({
          select: "id,organization_id,git_connection_id,provider_repository_id,repository_name,default_branch,webhook_id,webhook_secret_ciphertext,webhook_secret_key_version",
          git_connection_id: "eq." + connection.id,
          provider_repository_id: "eq." + providerRepositoryId,
          limit: "1"
        })), "GitHub repository");
        if (!repository) {
          repository = firstRow(await serviceRequest("/rest/v1/feltus_repositories?select=id,organization_id,git_connection_id,provider_repository_id,repository_name,default_branch,webhook_id", {
            method: "POST",
            prefer: "return=representation",
            body: {
              organization_id: app.organization_id,
              git_connection_id: connection.id,
              provider_repository_id: providerRepositoryId,
              repository_name: selected.name,
              clone_url: remote.clone_url,
              default_branch: branch
            }
          }), "GitHub repository");
        } else if (repository.default_branch !== branch) {
          repository = firstRow(await serviceRequest("/rest/v1/feltus_repositories?id=eq." + encodeURIComponent(repository.id) +
            "&select=id,organization_id,git_connection_id,provider_repository_id,repository_name,default_branch,webhook_id,webhook_secret_ciphertext,webhook_secret_key_version", {
            method: "PATCH",
            prefer: "return=representation",
            body: { default_branch: branch }
          }), "GitHub repository");
        }
        if (!repository?.id || repository.organization_id !== app.organization_id) throw new Error("Repository could not be securely linked.");
        const attached = await serviceRequest("/rest/v1/feltus_project_repositories?on_conflict=app_id,repository_id", {
          method: "POST",
          prefer: "resolution=merge-duplicates,return=representation",
          body: {
            organization_id: app.organization_id,
            app_id: app.id,
            repository_id: repository.id,
            attached_by: user.id
          }
        });
        if (attached.status < 200 || attached.status >= 300) throw new Error("Repository could not be attached to this application.");

        const branchResult = await githubRequestWithConnection("/repos/" + encodeURIComponent(remote.owner.login) + "/" +
          encodeURIComponent(remote.name) + "/branches/" + encodeURIComponent(branch), connection);
        const latestCommit = /^[0-9a-f]{40,64}$/i.test(String(branchResult?.commit?.sha || ""))
          ? branchResult.commit.sha.toLowerCase()
          : null;
        const development = firstRow(await serviceRequest("/rest/v1/feltus_environments?" + new URLSearchParams({
          select: "id",
          app_id: "eq." + app.id,
          kind: "eq.development",
          limit: "1"
        })), "Development environment");
        if (development?.id) {
          const branchSaved = await serviceRequest("/rest/v1/feltus_repository_branches?on_conflict=repository_id,branch_name,environment_id", {
            method: "POST",
            prefer: "resolution=merge-duplicates,return=minimal",
            body: {
              organization_id: app.organization_id,
              app_id: app.id,
              repository_id: repository.id,
              environment_id: development.id,
              branch_name: branch,
              is_default: true,
              latest_commit_sha: latestCommit,
              updated_at: new Date().toISOString()
            }
          });
          if (branchSaved.status < 200 || branchSaved.status >= 300) throw new Error("Repository was connected, but its default branch could not be saved.");
        }
        const webhookIsVerified = repository.webhook_id && repository.webhook_secret_ciphertext &&
          repository.webhook_secret_key_version === ENCRYPTION_KEY_VERSION;
        const webhook = webhookIsVerified
          ? { status: "active", message: "Push and pull request updates are connected." }
          : await setupWebhook(app, repository, remote, connection);
        send(res, 200, {
          repository: {
            id: repository.id,
            name: repository.repository_name || selected.name,
            default_branch: branch,
            latest_commit_sha: latestCommit
          },
          webhook
        });
        return true;
      }
      if (action === "webhook" && method === "POST") {
        const attached = await attachedRepositories(app);
        if (!attached.length) {
          send(res, 409, { error: "Connect a repository before setting up its webhook." });
          return true;
        }
        const connection = await loadConnection(app);
        const repositoryRecord = firstRow(await serviceRequest("/rest/v1/feltus_repositories?" + new URLSearchParams({
          select: "id,provider_repository_id,git_connection_id,webhook_id",
          id: "eq." + attached[0].id,
          limit: "1"
        })), "GitHub repository");
        const remote = await githubRequestWithConnection("/repositories/" + encodeURIComponent(repositoryRecord.provider_repository_id), connection);
        const webhook = await setupWebhook(app, repositoryRecord, remote, connection);
        send(res, 200, { webhook });
        return true;
      }
      send(res, 405, { error: "Method not allowed." }, { Allow: action === "connect" ? "GET" : action ? "GET, POST" : "GET" });
    } catch (error) {
      if (callback) {
        res.writeHead(302, {
          Location: callbackAppId
            ? "/apps/" + encodeURIComponent(callbackAppId) + "/source?github=connection_failed"
            : "/apps?github=authorization_failed",
          "Cache-Control": "no-store",
          "Set-Cookie": cookieHeader("", { secure: String(env.FELTUS_ENV).toLowerCase() === "production", maxAge: 0 })
        });
        res.end();
        return true;
      }
      const result = errorResult(error);
      send(res, result.status, { error: result.message });
    }
    return true;
  }

  return Object.freeze({ handleWebhook, handleAuthenticated });
}
