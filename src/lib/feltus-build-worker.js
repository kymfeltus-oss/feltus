import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decryptGithubSecret, normalizeGithubBranch } from "./feltus-github.js";

const MAX_LOG_CHARS = 50_000;
const COMMIT_SHA = /^[0-9a-f]{40,64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENCRYPTION_KEY_VERSION = "aes-256-gcm-hkdf-v1";

export class BuildWorkerError extends Error {
  constructor(code, message = code, exitCode = null) {
    super(message);
    this.name = "BuildWorkerError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function redactBuildLog(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("[REDACTED]");
  }
  text = text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)\S+/ig, "$1[REDACTED]")
    .replace(/((?:password|passwd|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/ig, "$1[REDACTED]");
  if (text.length > MAX_LOG_CHARS) text = `[Earlier build output truncated]\n${text.slice(-MAX_LOG_CHARS + 36)}`;
  return text;
}

export function createBuildLogSanitizer(secrets = []) {
  let partialLine = "";
  return {
    append(value) {
      partialLine += String(value ?? "");
      const lines = partialLine.split("\n");
      partialLine = lines.pop() || "";
      const complete = lines.length ? redactBuildLog(`${lines.join("\n")}\n`, secrets) : "";
      if (partialLine.length > MAX_LOG_CHARS * 2) {
        const bounded = redactBuildLog(partialLine, secrets);
        partialLine = "";
        return complete + bounded;
      }
      return complete;
    },
    finish() {
      const tail = partialLine;
      partialLine = "";
      return redactBuildLog(tail, secrets);
    }
  };
}

export function parseBuildKitDigest(metadata) {
  let value = metadata;
  if (typeof metadata === "string") {
    try { value = JSON.parse(metadata); } catch { throw new BuildWorkerError("BUILD_METADATA_INVALID"); }
  }
  const digest = value?.["containerimage.digest"];
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new BuildWorkerError("BUILD_DIGEST_MISSING");
  }
  return digest;
}

export function parseArtifactRegistry(value) {
  const registry = String(value || "").trim().toLowerCase().replace(/\/+$/, "");
  if (!registry || registry.includes("://") || /[@\s?#]/.test(registry)) return null;
  const [host, ...segments] = registry.split("/");
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(host || "") ||
      !segments.length || segments.some(segment => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(segment))) return null;
  return { prefix: registry, host, repositoryPrefix: segments.join("/") };
}

export function artifactImageReference(registry, appId, buildId) {
  const parsed = parseArtifactRegistry(registry);
  if (!parsed || !UUID.test(String(appId || "")) || !UUID.test(String(buildId || ""))) {
    throw new BuildWorkerError("ARTIFACT_REFERENCE_INVALID");
  }
  const repository = `${parsed.repositoryPrefix}/${appId}`;
  const tag = `build-${buildId}`;
  return { image: `${parsed.host}/${repository}:${tag}`, repository, tag, host: parsed.host };
}

const CONFIG_NAMES = [
  "FELTUS_BUILD_WORKER_ENABLED", "FELTUS_GATEWAY_URL", "FELTUS_SERVICE_ROLE_KEY",
  "FELTUS_SECRET_ENCRYPTION_KEY", "FELTUS_BUILDKIT_ADDR", "FELTUS_BUILDKIT_CA_PEM",
  "FELTUS_BUILDKIT_CLIENT_CERT_PEM", "FELTUS_BUILDKIT_CLIENT_KEY_PEM",
  "FELTUS_ARTIFACT_REGISTRY", "FELTUS_ARTIFACT_REGISTRY_USERNAME", "FELTUS_ARTIFACT_REGISTRY_PASSWORD"
];

export function missingBuildWorkerConfiguration(env = process.env) {
  const missing = [];
  if (env.FELTUS_BUILD_WORKER_ENABLED !== "true") missing.push("FELTUS_BUILD_WORKER_ENABLED");
  for (const key of CONFIG_NAMES.slice(1)) if (!String(env[key] || "").trim()) missing.push(key);
  if (String(env.FELTUS_SECRET_ENCRYPTION_KEY || "").length < 32 && !missing.includes("FELTUS_SECRET_ENCRYPTION_KEY")) {
    missing.push("FELTUS_SECRET_ENCRYPTION_KEY");
  }
  if (env.FELTUS_GATEWAY_URL && !/^https?:\/\//i.test(env.FELTUS_GATEWAY_URL)) missing.push("FELTUS_GATEWAY_URL");
  if (env.FELTUS_BUILDKIT_ADDR && !/^tcp:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})$/.test(env.FELTUS_BUILDKIT_ADDR)) missing.push("FELTUS_BUILDKIT_ADDR");
  if (env.FELTUS_ARTIFACT_REGISTRY && !parseArtifactRegistry(env.FELTUS_ARTIFACT_REGISTRY)) missing.push("FELTUS_ARTIFACT_REGISTRY");
  return [...new Set(missing)];
}

function firstRow(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function safeFailureCode(value, fallback = "BUILD_FAILED") {
  const code = String(value || "").toUpperCase();
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : fallback;
}

function postgrestFilter(value) {
  return encodeURIComponent(String(value));
}

export function createBuildWorker({
  env = process.env,
  fetchImpl = globalThis.fetch,
  spawnImpl = nodeSpawn,
  now = () => Date.now(),
  workerId = env.FELTUS_BUILD_WORKER_ID || `build-${crypto.randomUUID()}`,
  pollMs = Math.max(500, Number(env.FELTUS_BUILD_WORKER_POLL_MS || 2500)),
  heartbeatMs = Math.max(10_000, Number(env.FELTUS_BUILD_WORKER_HEARTBEAT_MS || 30_000)),
  leaseSeconds = Math.max(60, Math.min(3600, Number(env.FELTUS_BUILD_LEASE_SECONDS || 600))),
  buildTimeoutSeconds = Math.max(60, Math.min(7200, Number(env.FELTUS_BUILD_TIMEOUT_SECONDS || 1800)))
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Build worker requires fetch.");
  let running = false;
  let ready = false;
  let lastLoopAt = null;
  let lastErrorCode = null;
  let lastProbeAt = 0;
  let runtimeDir = null;
  let runtimeFiles = null;
  const secrets = [env.FELTUS_ARTIFACT_REGISTRY_PASSWORD, env.FELTUS_SECRET_ENCRYPTION_KEY].filter(Boolean);
  const missing = missingBuildWorkerConfiguration(env);
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(workerId)) throw new TypeError("Build worker ID is invalid.");

  const gateway = String(env.FELTUS_GATEWAY_URL || "").replace(/\/+$/, "");
  async function rest(endpoint, { method = "GET", body = null, prefer = "" } = {}) {
    const response = await fetchImpl(`${gateway}${endpoint}`, {
      method,
      headers: {
        apikey: env.FELTUS_SERVICE_ROLE_KEY || "",
        Authorization: `Bearer ${env.FELTUS_SERVICE_ROLE_KEY || ""}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(prefer ? { Prefer: prefer } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000)
    });
    const raw = await response.text();
    let data = null;
    if (raw) { try { data = JSON.parse(raw); } catch { data = null; } }
    if (!response.ok) {
      const error = new BuildWorkerError("BUILD_DATABASE_UNAVAILABLE");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function tlsArgs() {
    return ["--addr", env.FELTUS_BUILDKIT_ADDR, "--tlscacert", runtimeFiles.ca,
      "--tlscert", runtimeFiles.cert, "--tlskey", runtimeFiles.key];
  }

  function ensureConfigured() {
    if (missing.length) throw new BuildWorkerError("BUILD_WORKER_NOT_CONFIGURED");
    if (!runtimeFiles) throw new BuildWorkerError("BUILD_WORKER_NOT_INITIALIZED");
  }

  async function prepareRuntime() {
    if (missing.length) return false;
    if (runtimeFiles) return true;
    const directory = await mkdtemp(path.join(os.tmpdir(), "feltus-build-worker-"));
    const ca = path.join(directory, "ca.pem");
    const cert = path.join(directory, "client-cert.pem");
    const key = path.join(directory, "client-key.pem");
    const dockerConfigDir = path.join(directory, "docker");
    try {
      await mkdir(dockerConfigDir, { mode: 0o700 });
      await writeFile(ca, env.FELTUS_BUILDKIT_CA_PEM, { mode: 0o600 });
      await writeFile(cert, env.FELTUS_BUILDKIT_CLIENT_CERT_PEM, { mode: 0o600 });
      await writeFile(key, env.FELTUS_BUILDKIT_CLIENT_KEY_PEM, { mode: 0o600 });
      const registry = parseArtifactRegistry(env.FELTUS_ARTIFACT_REGISTRY);
      const auth = Buffer.from(`${env.FELTUS_ARTIFACT_REGISTRY_USERNAME}:${env.FELTUS_ARTIFACT_REGISTRY_PASSWORD}`).toString("base64");
      await writeFile(path.join(dockerConfigDir, "config.json"), JSON.stringify({
        auths: { [registry.host]: { auth } }
      }), { mode: 0o600 });
      runtimeDir = directory;
      runtimeFiles = { ca, cert, key, dockerConfigDir };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return true;
  }

  function runProcess(command, args, { cwd, extraEnv = {}, signal, timeoutMs = 30_000, onOutput = null } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let killTimer = null;
      let terminationError = null;
      let stdoutText = "";
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => {
        if (settled) return;
        terminationError = signal?.reason instanceof Error
          ? signal.reason
          : new BuildWorkerError("BUILD_CANCELLED", "Build cancelled", 143);
        if (!child) {
          finish(terminationError);
          return;
        }
        try { child?.kill("SIGTERM"); } catch {}
        killTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch {} }, 2000);
      };
      const timer = setTimeout(() => {
        terminationError = new BuildWorkerError("BUILD_TIMEOUT", "Build timed out", 124);
        try { child?.kill("SIGTERM"); } catch {}
        killTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch {} }, 2000);
      }, timeoutMs);
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        child = spawnImpl(command, args, {
          cwd,
          env: {
            PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
            HOME: runtimeDir || os.tmpdir(),
            TMPDIR: os.tmpdir(),
            LANG: "C.UTF-8",
            ...extraEnv
          },
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch {
        finish(new BuildWorkerError("BUILD_EXECUTOR_UNAVAILABLE"));
        return;
      }
      child.stdout?.on("data", chunk => {
        stdoutText = (stdoutText + String(chunk)).slice(-4096);
        onOutput?.(String(chunk));
      });
      child.stderr?.on("data", chunk => onOutput?.(String(chunk)));
      child.on("error", () => finish(terminationError || new BuildWorkerError("BUILD_EXECUTOR_UNAVAILABLE")));
      child.on("close", (code, childSignal) => {
        if (terminationError) return finish(terminationError);
        if (signal?.aborted) return abort();
        finish(null, { exitCode: Number.isInteger(code) ? code : childSignal ? 128 : 1, stdout: stdoutText });
      });
    });
  }

  async function probeBuildKit() {
    ensureConfigured();
    const result = await runProcess(env.FELTUS_BUILDCTL_PATH || "buildctl", [
      ...tlsArgs(), "debug", "workers"
    ], { timeoutMs: 8000 });
    return result.exitCode === 0;
  }

  async function heartbeat(status, details = {}) {
    await rest("/rest/v1/feltus_worker_heartbeats?on_conflict=worker_id", {
      method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        worker_id: workerId, worker_type: "build", status,
        metadata: {
          builder: "remote_buildkit_mtls",
          ready: status === "online",
          missing_configuration_names: details.missing_configuration_names || [],
          last_error_code: details.last_error_code || null
        },
        last_seen_at: new Date(now()).toISOString()
      }
    });
  }

  function stepLogger(build, stepKey, attempt = Number(build.attempt_count || 1)) {
    let step = null;
    let logText = "";
    let pending = "";
    const sanitizer = createBuildLogSanitizer(secrets);
    let flushPromise = Promise.resolve();
    let flushTimer = null;
    const append = value => {
      pending = redactBuildLog(pending + sanitizer.append(value), secrets);
      if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush().catch(() => {}); }, 1000);
    };
    async function flush() {
      if (!step || !pending) return flushPromise;
      const chunk = pending;
      pending = "";
      logText = redactBuildLog(logText + chunk, secrets);
      flushPromise = flushPromise.then(() => rest(
        `/rest/v1/feltus_build_steps?id=eq.${postgrestFilter(step.id)}`,
        { method: "PATCH", prefer: "return=minimal", body: { log_text: logText } }
      ));
      return flushPromise;
    }
    return {
      append,
      async start() {
        const rows = await rest("/rest/v1/feltus_build_steps", {
          method: "POST", prefer: "return=representation",
          body: {
            organization_id: build.organization_id, app_id: build.app_id, build_id: build.id,
            step_key: stepKey, attempt, status: "running", started_at: new Date(now()).toISOString()
          }
        });
        step = firstRow(rows);
        if (!step?.id) throw new BuildWorkerError("BUILD_STEP_PERSIST_FAILED");
      },
      async finish(status, exitCode = null, errorCode = null) {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        pending = redactBuildLog(pending + sanitizer.finish(), secrets);
        await flush();
        await flushPromise;
        if (!step) return;
        await rest(`/rest/v1/feltus_build_steps?id=eq.${postgrestFilter(step.id)}`, {
          method: "PATCH", prefer: "return=minimal",
          body: { status, exit_code: exitCode, error_code: errorCode, completed_at: new Date(now()).toISOString() }
        });
      }
    };
  }

  async function fetchGithubJson(slug, pathPart, token) {
    const response = await fetchImpl(`https://api.github.com/repos/${slug}/${pathPart}`, {
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "FELTUS-Build-Worker"
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new BuildWorkerError(response.status === 401 ? "GITHUB_AUTH_EXPIRED" : response.status === 404 ? "GITHUB_SOURCE_UNAVAILABLE" : "GITHUB_SOURCE_REQUEST_FAILED");
    return response.json();
  }

  async function loadSource(build, checkoutStep, signal, tempRoot) {
    const repository = firstRow(await rest(`/rest/v1/feltus_repositories?${new URLSearchParams({
      select: "id,organization_id,git_connection_id,provider_repository_id,repository_name,clone_url,archived_at",
      id: `eq.${build.repository_id}`, organization_id: `eq.${build.organization_id}`, archived_at: "is.null", limit: "1"
    })}`));
    if (!repository || !UUID.test(repository.id) || !UUID.test(repository.git_connection_id)) throw new BuildWorkerError("GITHUB_REPOSITORY_MAPPING_MISSING");
    const slug = String(repository.repository_name || "").replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) throw new BuildWorkerError("GITHUB_REPOSITORY_MAPPING_INVALID");
    const clone = new URL(repository.clone_url || "");
    if (clone.protocol !== "https:" || clone.hostname.toLowerCase() !== "github.com" || clone.username || clone.password ||
        clone.pathname.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase() !== slug.toLowerCase()) {
      throw new BuildWorkerError("GITHUB_CLONE_URL_INVALID");
    }
    if (!COMMIT_SHA.test(String(build.commit_sha || "")) || normalizeGithubBranch(build.source_branch) !== build.source_branch) {
      throw new BuildWorkerError("BUILD_SOURCE_INVALID");
    }
    const connection = firstRow(await rest(`/rest/v1/feltus_git_connections?${new URLSearchParams({
      select: "id,provider,credential_ciphertext,encryption_key_version,disabled_at",
      id: `eq.${repository.git_connection_id}`, organization_id: `eq.${build.organization_id}`, limit: "1"
    })}`));
    if (!connection || connection.provider !== "github" || connection.disabled_at || connection.encryption_key_version !== ENCRYPTION_KEY_VERSION) {
      throw new BuildWorkerError("GITHUB_CONNECTION_UNAVAILABLE");
    }
    let token;
    try { token = decryptGithubSecret(connection.credential_ciphertext, env.FELTUS_SECRET_ENCRYPTION_KEY, "github-oauth-token:v1"); }
    catch { throw new BuildWorkerError("GITHUB_CREDENTIAL_UNAVAILABLE"); }
    const repoInfo = await fetchGithubJson(slug, "", token);
    if (String(repoInfo?.id) !== String(repository.provider_repository_id)) throw new BuildWorkerError("GITHUB_REPOSITORY_ID_MISMATCH");
    const commit = await fetchGithubJson(slug, `commits/${encodeURIComponent(build.commit_sha)}`, token);
    if (String(commit?.sha || "").toLowerCase() !== String(build.commit_sha).toLowerCase()) throw new BuildWorkerError("GITHUB_COMMIT_MISMATCH");

    const sourceDir = path.join(tempRoot, "source");
    await mkdir(sourceDir, { mode: 0o700 });
    const githubAuthSecret = Buffer.from("x-access-token:" + token).toString("base64");
    const githubAuthValue = "AUTHORIZATION: basic " + githubAuthSecret;
    secrets.push(token, githubAuthSecret);
    const gitEnv = {
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: githubAuthValue
    };
    const runGit = async args => {
      const result = await runProcess(env.FELTUS_GIT_PATH || "git", args, {
        cwd: sourceDir, extraEnv: gitEnv, signal, timeoutMs: 120_000, onOutput: checkoutStep.append
      });
      if (result.exitCode !== 0) throw new BuildWorkerError("GITHUB_CHECKOUT_FAILED", "GitHub source checkout failed", result.exitCode);
      return result;
    };
    try {
      await runGit(["init", "--quiet"]);
      await runGit(["remote", "add", "origin", clone.toString()]);
      await runGit(["fetch", "--no-tags", "--depth=1", "origin", build.commit_sha]);
      await runGit(["checkout", "--quiet", "--detach", build.commit_sha]);
      const verified = await runGit(["rev-parse", "HEAD"]);
      if (signal?.aborted) throw signal.reason || new BuildWorkerError("BUILD_CANCELLED");
      const actualSha = String(verified.stdout || "").trim().toLowerCase();
      if (actualSha !== build.commit_sha.toLowerCase()) throw new BuildWorkerError("GITHUB_COMMIT_MISMATCH");
      await rm(path.join(sourceDir, ".git"), { recursive: true, force: true });
      try { await access(path.join(sourceDir, "Dockerfile")); } catch { throw new BuildWorkerError("BUILD_DOCKERFILE_MISSING"); }
      return { sourceDir, repository };
    } finally {
      for (const secret of [token, githubAuthSecret]) {
        const index = secrets.indexOf(secret);
        if (index >= 0) secrets.splice(index, 1);
      }
    }
  }

  async function registryDigest(image, repository, digest, registry) {
    const url = new URL(`https://${registry.host}/v2/${repository}/manifests/${digest}`);
    const accepts = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json";
    const basic = `Basic ${Buffer.from(`${env.FELTUS_ARTIFACT_REGISTRY_USERNAME}:${env.FELTUS_ARTIFACT_REGISTRY_PASSWORD}`).toString("base64")}`;
    let response = await fetchImpl(url, {
      method: "HEAD", headers: { Authorization: basic, Accept: accepts }, redirect: "error", signal: AbortSignal.timeout(20_000)
    });
    if (response.status === 401) {
      const challenge = response.headers.get("www-authenticate") || "";
      const match = /^Bearer\s+(.+)$/i.exec(challenge);
      if (!match) throw new BuildWorkerError("ARTIFACT_REGISTRY_AUTH_FAILED");
      const attrs = Object.fromEntries([...match[1].matchAll(/([a-z]+)=\"([^\"]*)\"/gi)].map(item => [item[1].toLowerCase(), item[2]]));
      let tokenUrl;
      try { tokenUrl = new URL(attrs.realm || ""); } catch { throw new BuildWorkerError("ARTIFACT_REGISTRY_CHALLENGE_INVALID"); }
      if (tokenUrl.protocol !== "https:" || !attrs.scope || !attrs.service) throw new BuildWorkerError("ARTIFACT_REGISTRY_CHALLENGE_INVALID");
      tokenUrl.searchParams.set("service", attrs.service);
      tokenUrl.searchParams.set("scope", attrs.scope);
      const tokenResponse = await fetchImpl(tokenUrl, {
        headers: { Authorization: basic, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000)
      });
      if (!tokenResponse.ok) throw new BuildWorkerError("ARTIFACT_REGISTRY_AUTH_FAILED");
      const tokenBody = await tokenResponse.json();
      const bearer = tokenBody.token || tokenBody.access_token;
      if (typeof bearer !== "string" || !bearer) throw new BuildWorkerError("ARTIFACT_REGISTRY_AUTH_FAILED");
      response = await fetchImpl(url, {
        method: "HEAD", headers: { Authorization: `Bearer ${bearer}`, Accept: accepts }, redirect: "error", signal: AbortSignal.timeout(20_000)
      });
    }
    if (!response.ok) throw new BuildWorkerError("ARTIFACT_REGISTRY_DIGEST_UNVERIFIED");
    if (response.headers.get("docker-content-digest") !== digest) throw new BuildWorkerError("ARTIFACT_DIGEST_MISMATCH");
    return { image, digest };
  }

  async function recordBuildEvent(build, key, summary, metadata = {}, severity = "info") {
    await rest("/rest/v1/rpc/feltus_record_application_event", {
      method: "POST",
      body: {
        p_app_id: build.app_id,
        p_event: {
          actor_kind: "service", category: "build", severity, event_key: key,
          entity_type: "application_build", entity_id: build.id, summary,
          blueprint_id: build.blueprint_id, commit_sha: build.commit_sha, build_id: build.id,
          metadata
        }
      }
    });
  }

  async function startLeaseMonitor(build, controller) {
    let polling = false;
    let dbErrors = 0;
    const check = async () => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        const current = firstRow(await rest(`/rest/v1/feltus_builds?${new URLSearchParams({
          select: "id,status", id: `eq.${build.id}`, limit: "1"
        })}`));
        if (!current || current.status === "cancelled") {
          controller.abort(new BuildWorkerError("BUILD_CANCELLED", "Build cancelled", 143));
          return;
        }
        if (["failed", "succeeded"].includes(current.status)) {
          controller.abort(new BuildWorkerError("BUILD_LEASE_LOST"));
          return;
        }
        dbErrors = 0;
      } catch {
        dbErrors += 1;
        if (dbErrors >= 3) controller.abort(new BuildWorkerError("BUILD_LEASE_UNCERTAIN"));
      } finally { polling = false; }
    };
    const cancelTimer = setInterval(check, 3000);
    const leaseTimer = setInterval(async () => {
      try {
        const ok = await rest("/rest/v1/rpc/feltus_heartbeat_build", {
          method: "POST", body: { p_build_id: build.id, p_lease_token: build.lease_token, p_lease_seconds: leaseSeconds }
        });
        if (ok !== true && ok !== "true") {
          const current = firstRow(await rest(`/rest/v1/feltus_builds?${new URLSearchParams({ select: "status", id: `eq.${build.id}`, limit: "1" })}`));
          controller.abort(new BuildWorkerError(current?.status === "cancelled" ? "BUILD_CANCELLED" : "BUILD_LEASE_LOST"));
        }
      } catch { controller.abort(new BuildWorkerError("BUILD_LEASE_UNCERTAIN")); }
    }, Math.max(15_000, Math.floor(leaseSeconds * 1000 / 3)));
    return () => { clearInterval(cancelTimer); clearInterval(leaseTimer); };
  }

  async function persistCancelledExit(build, exitCode) {
    if (!Number.isInteger(exitCode)) return;
    try {
      await rest(`/rest/v1/feltus_builds?id=eq.${postgrestFilter(build.id)}&status=eq.cancelled`, {
        method: "PATCH", prefer: "return=minimal", body: { exit_code: Math.max(0, Math.min(255, exitCode || 143)) }
      });
    } catch {}
  }

  async function processBuild(claimed) {
    if (!claimed || !UUID.test(claimed.id) || !UUID.test(claimed.app_id) || !UUID.test(claimed.repository_id) ||
        !UUID.test(claimed.blueprint_id) || !UUID.test(claimed.lease_token) || !COMMIT_SHA.test(String(claimed.commit_sha || ""))) {
      throw new BuildWorkerError("BUILD_CLAIM_INVALID");
    }
    const build = { ...claimed };
    const controller = new AbortController();
    const stopMonitor = await startLeaseMonitor(build, controller);
    let activeStep = null;
    let cancellationExitCode = null;
    let tempRoot = null;
    try {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "feltus-build-"));
      await rest("/rest/v1/rpc/feltus_start_application_build", {
        method: "POST", body: { p_build_id: build.id, p_lease_token: build.lease_token }
      });
      activeStep = stepLogger(build, "checkout");
      await activeStep.start();
      let source;
      try {
        source = await loadSource(build, activeStep, controller.signal, tempRoot);
        await activeStep.finish("succeeded", 0);
        activeStep = null;
      } catch (error) {
        await activeStep.finish(error.code === "BUILD_CANCELLED" ? "skipped" : "failed", error.exitCode, safeFailureCode(error.code));
        activeStep = null;
        throw error;
      }

      await rest("/rest/v1/rpc/feltus_update_build_status", {
        method: "POST", body: { p_build_id: build.id, p_lease_token: build.lease_token, p_status: "building" }
      });
      activeStep = stepLogger(build, "build");
      await activeStep.start();
      const registry = parseArtifactRegistry(env.FELTUS_ARTIFACT_REGISTRY);
      const output = artifactImageReference(env.FELTUS_ARTIFACT_REGISTRY, build.app_id, build.id);
      const metadataPath = path.join(tempRoot, "build-metadata.json");
      const timeoutMs = buildTimeoutSeconds * 1000;
      let result;
      try {
        result = await runProcess(env.FELTUS_BUILDCTL_PATH || "buildctl", [
          ...tlsArgs(), "build", "--frontend", "dockerfile.v0",
          "--local", `context=${source.sourceDir}`, "--local", `dockerfile=${source.sourceDir}`,
          "--opt", "filename=Dockerfile", "--output", `type=image,name=${output.image},push=true`,
          "--metadata-file", metadataPath, "--progress", "plain"
        ], {
          cwd: source.sourceDir, signal: controller.signal, timeoutMs,
          extraEnv: { DOCKER_CONFIG: runtimeFiles.dockerConfigDir }, onOutput: activeStep.append
        });
        cancellationExitCode = result.exitCode || 143;
        if (result.exitCode !== 0) throw new BuildWorkerError("BUILD_COMMAND_FAILED", "BuildKit reported a build failure", result.exitCode);
        await activeStep.finish("succeeded", result.exitCode);
        activeStep = null;
      } catch (error) {
        cancellationExitCode = Number.isInteger(error.exitCode) ? error.exitCode : cancellationExitCode;
        await activeStep.finish(error.code === "BUILD_CANCELLED" ? "skipped" : "failed", cancellationExitCode, safeFailureCode(error.code));
        activeStep = null;
        throw error;
      }

      await rest("/rest/v1/rpc/feltus_update_build_status", {
        method: "POST", body: { p_build_id: build.id, p_lease_token: build.lease_token, p_status: "verifying" }
      });
      activeStep = stepLogger(build, "verify-artifact");
      await activeStep.start();
      const digest = parseBuildKitDigest(await readFile(metadataPath, "utf8"));
      await registryDigest(output.image, output.repository, digest, registry);
      const provenance = {
        builder: "remote_buildkit_mtls",
        build_id: build.id,
        app_id: build.app_id,
        blueprint_id: build.blueprint_id,
        repository_id: build.repository_id,
        source_branch: build.source_branch,
        commit_sha: build.commit_sha.toLowerCase(),
        image_reference: output.image,
        artifact_digest: digest,
        digest_verified_at: new Date(now()).toISOString()
      };
      await rest("/rest/v1/rpc/feltus_finish_application_build", {
        method: "POST",
        body: {
          p_build_id: build.id, p_lease_token: build.lease_token,
          p_registry_image: output.image, p_digest: digest, p_provenance: provenance
        }
      });
      await activeStep.finish("succeeded", 0);
      activeStep = null;
      return { status: "succeeded", digest };
    } catch (error) {
      let code = safeFailureCode(error.code, "BUILD_FAILED");
      if (controller.signal.reason?.code === "BUILD_CANCELLED") {
        code = "BUILD_CANCELLED";
      } else if (code === "BUILD_DATABASE_UNAVAILABLE") {
        const statusQuery = new URLSearchParams({ select: "status", id: "eq." + build.id, limit: "1" });
        const current = firstRow(await rest("/rest/v1/feltus_builds?" + statusQuery.toString()).catch(() => null));
        if (current?.status === "cancelled") code = "BUILD_CANCELLED";
      }
      if (code === "BUILD_CANCELLED") {
        cancellationExitCode = Number.isInteger(error.exitCode) ? error.exitCode : cancellationExitCode;
        if (activeStep) await activeStep.finish("skipped", cancellationExitCode, "BUILD_CANCELLED").catch(() => {});
        await persistCancelledExit(build, cancellationExitCode);
        return { status: "cancelled" };
      }
      if (["BUILD_LEASE_LOST", "BUILD_LEASE_UNCERTAIN"].includes(code)) return { status: "lease_lost" };
      const exitCode = Number.isInteger(error.exitCode) ? Math.max(0, Math.min(255, error.exitCode)) : 1;
      if (activeStep) await activeStep.finish("failed", exitCode, code).catch(() => {});
      try {
        await rest("/rest/v1/rpc/feltus_fail_application_build", {
          method: "POST", body: {
            p_build_id: build.id, p_lease_token: build.lease_token,
            p_failure_code: code, p_exit_code: exitCode
          }
        });
      } catch {}
      return { status: "failed", failure_code: code, exit_code: exitCode };
    } finally {
      stopMonitor();
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function initialize() {
    if (missing.length) {
      ready = false;
      lastErrorCode = "BUILD_WORKER_CONFIGURATION_MISSING";
      return false;
    }
    await prepareRuntime();
    try {
      ready = await probeBuildKit();
      lastErrorCode = ready ? null : "BUILDKIT_UNAVAILABLE";
    } catch {
      ready = false;
      lastErrorCode = "BUILDKIT_UNAVAILABLE";
    }
    lastProbeAt = now();
    return ready;
  }

  async function tick() {
    lastLoopAt = new Date(now()).toISOString();
    if (!ready || now() - lastProbeAt >= heartbeatMs) await initialize();
    if (!ready) {
      await heartbeat("offline", { missing_configuration_names: missing, last_error_code: lastErrorCode });
      return { status: "offline", missing_configuration_names: missing };
    }
    await heartbeat("online");
    await rest("/rest/v1/rpc/feltus_recover_stale_builds", { method: "POST", body: {} });
    const claimed = await rest("/rest/v1/rpc/feltus_claim_builds", {
      method: "POST", body: { p_worker_id: workerId, p_limit: 1, p_lease_seconds: leaseSeconds }
    });
    const build = firstRow(claimed);
    if (!build) return { status: "idle" };
    const result = await processBuild(build);
    lastErrorCode = null;
    return result;
  }

  async function start() {
    if (running) return;
    running = true;
    if (missing.length) await heartbeat("offline", { missing_configuration_names: missing, last_error_code: "BUILD_WORKER_CONFIGURATION_MISSING" }).catch(() => {});
    while (running) {
      try {
        await tick();
      } catch (error) {
        lastErrorCode = safeFailureCode(error.code, "BUILD_WORKER_ERROR");
        await heartbeat(ready ? "degraded" : "offline", { missing_configuration_names: missing, last_error_code: lastErrorCode }).catch(() => {});
      }
      if (running) await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }

  async function stop() {
    running = false;
    await heartbeat("stopping", { missing_configuration_names: missing }).catch(() => {});
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    runtimeDir = null;
    runtimeFiles = null;
  }

  function health() {
    return {
      status: ready && !lastErrorCode ? "healthy" : "degraded",
      worker_id: workerId,
      configured: missing.length === 0,
      ready,
      missing_configuration_names: missing,
      last_error_code: lastErrorCode,
      last_loop_at: lastLoopAt
    };
  }

  return { initialize, tick, start, stop, health, processBuild, missingConfiguration: missing, workerId };
}
