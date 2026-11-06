import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decryptGithubOAuthCredentialBundle, encryptGithubOAuthCredentialBundle, encryptGithubSecret } from "../src/lib/feltus-github.js";
import {
  artifactImageReference,
  createBuildLogSanitizer,
  createBuildWorker,
  missingBuildWorkerConfiguration,
  parseArtifactRegistry,
  parseBuildKitDigest,
  redactBuildLog
} from "../src/lib/feltus-build-worker.js";

const digest = `sha256:${"a".repeat(64)}`;
const appId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const buildId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const caFixtureBody = Buffer.from("test-only CA fixture; not a real certificate or credential").toString("base64");
const certFixtureBody = Buffer.from("test-only client certificate fixture; not a real certificate").toString("base64");
const keyFixtureBody = Buffer.from("test-only private key fixture; not a real private key").toString("base64");
const wrapPem = (label, body) => `-----${"BEGIN"} ${label}-----\n${body}\n-----${"END"} ${label}-----\n`;
const caFixturePem = wrapPem("CERTIFICATE", caFixtureBody);
const certFixturePem = wrapPem("CERTIFICATE", certFixtureBody);
const keyFixturePem = wrapPem("PRIVATE KEY", keyFixtureBody);
const credentialFixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "feltus-buildkit-credentials-test-"));
const credentialFixturePaths = {
  FELTUS_BUILDKIT_CA_FILE: path.join(credentialFixtureDirectory, "ca.pem"),
  FELTUS_BUILDKIT_CLIENT_CERT_FILE: path.join(credentialFixtureDirectory, "client-cert.pem"),
  FELTUS_BUILDKIT_CLIENT_KEY_FILE: path.join(credentialFixtureDirectory, "client-key.pem")
};
await writeFile(credentialFixturePaths.FELTUS_BUILDKIT_CA_FILE, caFixturePem, { mode: 0o600 });
await writeFile(credentialFixturePaths.FELTUS_BUILDKIT_CLIENT_CERT_FILE, certFixturePem, { mode: 0o600 });
await writeFile(credentialFixturePaths.FELTUS_BUILDKIT_CLIENT_KEY_FILE, keyFixturePem, { mode: 0o600 });
assert.equal(parseBuildKitDigest({ "containerimage.digest": digest }), digest);
assert.throws(() => parseBuildKitDigest({ "containerimage.digest": "sha256:bad" }), /BUILD_DIGEST_MISSING/);
console.log("PASS artifact digest is accepted only in canonical sha256 form");

const registry = parseArtifactRegistry("GHCR.IO/FELTUS-APPS");
assert.deepEqual(registry, { prefix: "ghcr.io/feltus-apps", host: "ghcr.io", repositoryPrefix: "feltus-apps" });
assert.equal(parseArtifactRegistry("https://ghcr.io/feltus-apps"), null);
assert.equal(parseArtifactRegistry("ghcr.io/feltus-apps/../other"), null);
const output = artifactImageReference("ghcr.io/feltus-apps", appId, buildId);
assert.equal(output.image, `ghcr.io/feltus-apps/${appId}:build-${buildId}`);
assert.equal(output.repository, `feltus-apps/${appId}`);
console.log("PASS artifact push references use unique per-build tags while digest remains canonical");

const redacted = redactBuildLog(
  `token=very-secret-value Authorization: Bearer abcdef123 password: hide-me ghp_${"x".repeat(32)}`,
  ["very-secret-value"]
);
assert.equal(redacted.includes("very-secret-value"), false);
assert.equal(redacted.includes("abcdef123"), false);
assert.equal(redacted.includes("hide-me"), false);
assert.equal(redacted.includes(`ghp_${"x".repeat(32)}`), false);
assert.ok(redacted.includes("[REDACTED]"));
assert.ok(redactBuildLog("x".repeat(60_000)).length <= 50_000);
const streamingRedactor = createBuildLogSanitizer(["split-secret-value"]);
assert.equal(streamingRedactor.append("Authorization: Bearer split-secret-"), "");
assert.equal(streamingRedactor.append("value\n"), "Authorization: Bearer [REDACTED]\n");
assert.equal(streamingRedactor.finish(), "");
console.log("PASS build logs redact secrets and stay within the database log bound");

const noConfig = missingBuildWorkerConfiguration({});
assert.ok(noConfig.includes("FELTUS_BUILDKIT_ADDR"));
assert.ok(noConfig.includes("FELTUS_ARTIFACT_REGISTRY_PASSWORD"));
assert.equal(noConfig.includes("do-not-print-this"), false);
assert.ok(missingBuildWorkerConfiguration({ FELTUS_BUILDKIT_ADDR: "https://builder.internal:1234" }).includes("FELTUS_BUILDKIT_ADDR"));
assert.ok(missingBuildWorkerConfiguration({ FELTUS_BUILDKIT_CA_FILE: "relative/ca.pem" }).includes("FELTUS_BUILDKIT_CA_FILE"));
console.log("PASS BuildKit address and absolute credential-file path validation remain enforced");

const heartbeats = [];
const missingEnv = { FELTUS_ARTIFACT_REGISTRY_PASSWORD: "do-not-print-this" };
const missingWorker = createBuildWorker({
  env: missingEnv,
  fetchImpl: async (_url, init = {}) => {
    if (init.method === "POST") heartbeats.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  },
  workerId: "build-worker-test",
  now: () => Date.parse("2026-11-04T12:00:00.000Z")
});
const unavailable = await missingWorker.tick();
assert.equal(unavailable.status, "offline");
assert.deepEqual(heartbeats[0].metadata.missing_configuration_names, missingBuildWorkerConfiguration(missingEnv));
assert.equal(JSON.stringify(heartbeats).includes("do-not-print-this"), false);
console.log("PASS missing configuration keeps the worker offline and publishes names only");

const readyEnv = {
  FELTUS_BUILD_WORKER_ENABLED: "true",
  FELTUS_GATEWAY_URL: "http://gateway:8000",
  FELTUS_SERVICE_ROLE_KEY: "service-role-placeholder",
  FELTUS_SECRET_ENCRYPTION_KEY: "x".repeat(32),
  FELTUS_GITHUB_CLIENT_ID: "github-client-id",
  FELTUS_GITHUB_CLIENT_SECRET: "github-worker-client-secret",
  FELTUS_BUILDKIT_ADDR: "tcp://builder.internal:1234",
  FELTUS_BUILDKIT_CA_PEM: caFixturePem,
  FELTUS_BUILDKIT_CLIENT_CERT_PEM: certFixturePem,
  FELTUS_BUILDKIT_CLIENT_KEY_PEM: keyFixturePem,
  FELTUS_ARTIFACT_REGISTRY: "ghcr.io/feltus-apps",
  FELTUS_ARTIFACT_REGISTRY_USERNAME: "feltus-ci",
  FELTUS_ARTIFACT_REGISTRY_PASSWORD: "registry-secret-value"
};
const probeCertificatePaths = [];
const fakeSpawn = (_command, args) => {
  const caIndex = args.indexOf("--tlscacert");
  if (caIndex >= 0) probeCertificatePaths.push(args[caIndex + 1]);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  process.nextTick(() => child.emit("close", 0, null));
  return child;
};
const readyWorker = createBuildWorker({
  env: readyEnv,
  spawnImpl: fakeSpawn,
  fetchImpl: async () => new Response(null, { status: 204 }),
  workerId: "build-worker-ready-test"
});
assert.deepEqual(readyWorker.missingConfiguration, []);
assert.equal(await readyWorker.initialize(), true);
assert.equal(await readyWorker.initialize(), true);
assert.equal(probeCertificatePaths.length, 2);
assert.equal(probeCertificatePaths[0], probeCertificatePaths[1], "re-probing BuildKit reuses one private runtime directory");
assert.equal(readyWorker.health().ready, true);
await readyWorker.stop();
console.log("PASS legacy environment PEM credentials remain supported and probe BuildKit before reporting ready");

const fileCredentialEnv = { ...readyEnv, ...credentialFixturePaths };
delete fileCredentialEnv.FELTUS_BUILDKIT_CA_PEM;
delete fileCredentialEnv.FELTUS_BUILDKIT_CLIENT_CERT_PEM;
delete fileCredentialEnv.FELTUS_BUILDKIT_CLIENT_KEY_PEM;
const fileCredentialProbeArgs = [];
const fileCredentialWorker = createBuildWorker({
  env: fileCredentialEnv,
  spawnImpl: (_command, args) => {
    fileCredentialProbeArgs.push(args);
    return fakeSpawn(_command, args);
  },
  fetchImpl: async () => new Response(null, { status: 204 }),
  workerId: "build-worker-file-credentials-test"
});
assert.deepEqual(fileCredentialWorker.missingConfiguration, []);
assert.equal(await fileCredentialWorker.initialize(), true);
assert.equal(fileCredentialWorker.health().ready, true);
assert.equal(fileCredentialProbeArgs[0][0], "--addr");
assert.equal(fileCredentialProbeArgs[0][1], readyEnv.FELTUS_BUILDKIT_ADDR);
assert.equal(fileCredentialProbeArgs[0][2], "--tlscacert");
assert.equal(fileCredentialProbeArgs[0][4], "--tlscert");
assert.equal(fileCredentialProbeArgs[0][6], "--tlskey");
assert.notEqual(fileCredentialProbeArgs[0][3], credentialFixturePaths.FELTUS_BUILDKIT_CA_FILE, "file credentials are copied into a private worker runtime directory");
await fileCredentialWorker.stop();
console.log("PASS mounted BuildKit credential files are loaded into the private runtime directory and used for mTLS");

const missingCredentialWorker = createBuildWorker({
  env: { ...fileCredentialEnv, FELTUS_BUILDKIT_CLIENT_KEY_FILE: path.join(credentialFixtureDirectory, "missing-key.pem") },
  spawnImpl: fakeSpawn,
  fetchImpl: async () => new Response(null, { status: 204 }),
  workerId: "build-worker-missing-file-test"
});
assert.equal(await missingCredentialWorker.initialize(), false);
assert.equal(missingCredentialWorker.health().last_error_code, "BUILDKIT_CREDENTIALS_INVALID");
assert.equal(JSON.stringify(missingCredentialWorker.health()).includes("test-only private key fixture"), false);
await missingCredentialWorker.stop();

const malformedCredentialPath = path.join(credentialFixtureDirectory, "malformed-cert.pem");
await writeFile(malformedCredentialPath, wrapPem("CERTIFICATE", "not-base64!"));
const malformedCredentialWorker = createBuildWorker({
  env: { ...fileCredentialEnv, FELTUS_BUILDKIT_CLIENT_CERT_FILE: malformedCredentialPath },
  spawnImpl: fakeSpawn,
  fetchImpl: async () => new Response(null, { status: 204 }),
  workerId: "build-worker-malformed-file-test"
});
assert.equal(await malformedCredentialWorker.initialize(), false);
assert.equal(malformedCredentialWorker.health().last_error_code, "BUILDKIT_CREDENTIALS_INVALID");
assert.equal(JSON.stringify(malformedCredentialWorker.health()).includes("not-base64"), false);
await malformedCredentialWorker.stop();
console.log("PASS missing and malformed credential files fail closed with generic, non-secret health errors");

const sourceBuildId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sourceAppId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const sourceRepoId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const sourceBlueprintId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const sourceOrgId = "11111111-1111-4111-8111-111111111111";
const sourceLeaseId = "22222222-2222-4222-8222-222222222222";
const commitSha = "1".repeat(40);
const githubToken = "expired-private-github-token-value";
const githubRefreshToken = "private-github-refresh-token-value";
const refreshedGithubToken = "private-github-refreshed-token-value";
const rotatedGithubRefreshToken = "rotated-private-github-refresh-token";
const githubClientSecret = "github-worker-client-secret";
const masterKey = "unit-test-encryption-key-material-32-bytes";
const restCalls = [];
const persistedSteps = [];
const githubRefreshRequests = [];
let nextStep = 0;
const repository = {
  id: sourceRepoId, organization_id: sourceOrgId,
  git_connection_id: "33333333-3333-4333-8333-333333333333",
  provider_repository_id: "fixture-repository-1", repository_name: "fixture/app",
  clone_url: "https://github.com/fixture/app.git", archived_at: null
};
const gitConnection = {
  id: repository.git_connection_id, provider: "github", disabled_at: null,
  credential_ciphertext: encryptGithubOAuthCredentialBundle({
    access_token: githubToken,
    refresh_token: githubRefreshToken,
    expires_in: 1,
    refresh_token_expires_in: 15897600
  }, masterKey, { now: Date.now() - 60_000 }),
  encryption_key_version: "aes-256-gcm-hkdf-v1"
};
const sourceEnv = {
  ...fileCredentialEnv,
  FELTUS_SECRET_ENCRYPTION_KEY: masterKey,
  FELTUS_GITHUB_CLIENT_ID: "github-client-id",
  FELTUS_GITHUB_CLIENT_SECRET: githubClientSecret
};
const sourceWorker = createBuildWorker({
  env: sourceEnv,
  workerId: "build-worker-source-test",
  spawnImpl: asyncSpawn,
  fetchImpl: async (url, init = {}) => {
    const address = String(url);
    if (address === "https://github.com/login/oauth/access_token") {
      const form = new URLSearchParams(init.body);
      githubRefreshRequests.push({ form, headers: init.headers });
      assert.equal(form.get("client_id"), "github-client-id");
      assert.equal(form.get("client_secret"), githubClientSecret);
      assert.equal(form.get("refresh_token"), githubRefreshToken);
      assert.equal(form.get("grant_type"), "refresh_token");
      return Response.json({
        access_token: refreshedGithubToken,
        expires_in: 28800,
        refresh_token: rotatedGithubRefreshToken,
        refresh_token_expires_in: 15897600
      });
    }
    if (address.startsWith("https://api.github.com/")) {
      assert.equal(init.headers.Authorization, "Bearer " + refreshedGithubToken);
      if (address.endsWith("/commits/" + commitSha)) return Response.json({ sha: commitSha });
      return Response.json({ id: repository.provider_repository_id });
    }
    if (address.startsWith("https://ghcr.io/v2/")) {
      return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
    }
    restCalls.push({ url: address, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (address.includes("/rest/v1/feltus_repositories?")) return Response.json([repository]);
    if (address.includes("/rest/v1/feltus_git_connections?") && init.method === "PATCH") {
      gitConnection.credential_ciphertext = JSON.parse(init.body).credential_ciphertext;
      return Response.json([{ id: gitConnection.id, credential_ciphertext: gitConnection.credential_ciphertext }]);
    }
    if (address.includes("/rest/v1/feltus_git_connections?")) return Response.json([gitConnection]);
    if (address.includes("/rest/v1/feltus_build_steps") && init.method === "POST") {
      const step = { id: `step-${++nextStep}`, ...JSON.parse(init.body) };
      persistedSteps.push(step);
      return Response.json([step]);
    }
    if (address.includes("/rest/v1/feltus_build_steps") && init.method === "PATCH") {
      const stepId = new URL(address).searchParams.get("id")?.replace("eq.", "");
      Object.assign(persistedSteps.find(step => step.id === stepId), JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 204 });
  }
});

function asyncSpawn(command, args, options) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  assert.equal(args.join(" ").includes(githubToken), false, "source credentials never enter the subprocess argument list");
  assert.equal(JSON.stringify(options.env).includes(githubClientSecret), false, "GitHub client secret is never passed to Git or BuildKit subprocesses");
  process.nextTick(async () => {
    try {
      if (command === "git" && args[0] === "init") {
        await writeFile(path.join(options.cwd, "Dockerfile"), "FROM scratch\n");
        child.stdout.emit("data", "checkout Authorization: Bearer private-github-refreshed-");
        child.stdout.emit("data", "token-value\n");
      }
      if (command === "git" && args[0] === "fetch") {
        const expectedAuth = "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + refreshedGithubToken).toString("base64");
        assert.equal(options.env.GIT_CONFIG_VALUE_0, expectedAuth, "pinned Git checkout must use the automatically refreshed token");
      }
      if (command === "git" && args[0] === "rev-parse") child.stdout.emit("data", `${commitSha}\n`);
      if (command === "buildctl" && args.includes("build")) {
        child.stdout.emit("data", `${keyFixtureBody}\n`);
        const index = args.indexOf("--metadata-file");
        await writeFile(args[index + 1], JSON.stringify({ "containerimage.digest": digest }));
      }
      child.emit("close", 0, null);
    } catch {
      child.emit("close", 1, null);
    }
  });
  return child;
}

assert.equal(await sourceWorker.initialize(), true);
const sourceResult = await sourceWorker.processBuild({
  id: sourceBuildId, organization_id: sourceOrgId, app_id: sourceAppId,
  repository_id: sourceRepoId, blueprint_id: sourceBlueprintId,
  source_branch: "main", commit_sha: commitSha, lease_token: sourceLeaseId, attempt_count: 1
});
assert.equal(sourceResult.status, "succeeded");
assert.equal(githubRefreshRequests.length, 1, "expired worker credentials refresh exactly once before GitHub checkout");
assert.notEqual(gitConnection.credential_ciphertext, "");
assert.equal(decryptGithubOAuthCredentialBundle(gitConnection.credential_ciphertext, masterKey).access_token, refreshedGithubToken);
assert.equal(gitConnection.credential_ciphertext.includes(refreshedGithubToken), false);
assert.equal(gitConnection.credential_ciphertext.includes(githubRefreshToken), false);
assert.equal(gitConnection.credential_ciphertext.includes(rotatedGithubRefreshToken), false);
assert.equal(JSON.stringify(sourceWorker.health()).includes(githubClientSecret), false);
assert.equal(JSON.stringify(restCalls).includes(githubClientSecret), false);
assert.equal(JSON.stringify(restCalls).includes(githubRefreshToken), false);
assert.equal(JSON.stringify(restCalls).includes(rotatedGithubRefreshToken), false);
const finishCall = restCalls.find(call => call.url.includes("feltus_finish_application_build"));
assert.ok(finishCall, "worker persists the verified artifact through the canonical completion RPC");
assert.equal(finishCall.body.p_digest, digest);
assert.equal(finishCall.body.p_provenance.commit_sha, commitSha);
assert.equal(finishCall.body.p_provenance.blueprint_id, sourceBlueprintId);
assert.equal(persistedSteps.length, 3);
assert.ok(persistedSteps.every(step => step.status === "succeeded"));
assert.equal(persistedSteps.some(step => String(step.log_text).includes(githubToken)), false);
assert.equal(persistedSteps.some(step => String(step.log_text).includes(refreshedGithubToken)), false, "rotated access token is redacted from build output");
assert.equal(persistedSteps.some(step => String(step.log_text).includes(githubRefreshToken)), false);
assert.equal(persistedSteps.some(step => String(step.log_text).includes(rotatedGithubRefreshToken)), false);
assert.equal(persistedSteps.some(step => String(step.log_text).includes(githubClientSecret)), false);
assert.equal(persistedSteps.some(step => String(step.log_text).includes(keyFixtureBody)), false, "BuildKit private-key material is redacted from persisted build logs");
assert.ok(restCalls.some(call => call.url.includes("feltus_start_application_build")));
assert.ok(restCalls.some(call => call.url.includes("feltus_update_build_status") && call.body.p_status === "building"));
assert.ok(restCalls.some(call => call.url.includes("feltus_update_build_status") && call.body.p_status === "verifying"));
const workerMetadataWrites = restCalls.filter(call => call.url.includes("feltus_worker_heartbeats"));
assert.equal(JSON.stringify(workerMetadataWrites).includes(githubClientSecret), false);
assert.equal(JSON.stringify(workerMetadataWrites).includes(githubToken), false);
assert.equal(JSON.stringify(workerMetadataWrites).includes(refreshedGithubToken), false);
assert.equal(restCalls.filter(call => call.method === "PATCH" && call.url.includes("feltus_git_connections?")).length, 1);
assert.equal(restCalls.some(call => call.method !== "GET" && call.url.includes("feltus_repositories?")), false, "refresh does not modify the repository record");
assert.equal(restCalls.some(call => call.url.includes("feltus_project_repositories?") || call.url.includes("feltus_repository_branches?")), false, "refresh does not recreate project links or branch selections");
await sourceWorker.stop();
console.log("PASS expired GitHub access token refreshes and rotates before pinned checkout while preserving links, redacting credentials, and persisting artifact lineage");

const cancellationBuildId = "44444444-4444-4444-8444-444444444444";
let cancellationObserved = false;
let buildProcessStarted = false;
const cancellationCalls = [];
const cancellationWorker = createBuildWorker({
  env: sourceEnv,
  workerId: "build-worker-cancellation-test",
  spawnImpl(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = signal => {
      process.nextTick(() => child.emit("close", null, signal));
      return true;
    };
    process.nextTick(async () => {
      if (command === "git" && args[0] === "init") await writeFile(path.join(options.cwd, "Dockerfile"), "FROM scratch\n");
      if (command === "git" && args[0] === "rev-parse") child.stdout.emit("data", `${commitSha}\n`);
      if (command === "buildctl" && args.includes("build")) {
        buildProcessStarted = true;
        return;
      }
      child.emit("close", 0, null);
    });
    return child;
  },
  fetchImpl: async (url, init = {}) => {
    const address = String(url);
    if (address.startsWith("https://api.github.com/")) {
      if (address.endsWith("/commits/" + commitSha)) return Response.json({ sha: commitSha });
      return Response.json({ id: repository.provider_repository_id });
    }
    cancellationCalls.push({ url: address, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (address.includes("/rest/v1/feltus_repositories?")) return Response.json([repository]);
    if (address.includes("/rest/v1/feltus_git_connections?")) return Response.json([gitConnection]);
    if (address.includes("/rest/v1/feltus_builds?") && init.method !== "PATCH") {
      cancellationObserved = true;
      return Response.json([{ id: cancellationBuildId, status: "cancelled" }]);
    }
    if (address.includes("/rest/v1/feltus_build_steps") && init.method === "POST") {
      return Response.json([{ id: `cancel-step-${cancellationCalls.length}` }]);
    }
    return new Response(null, { status: 204 });
  }
});
assert.equal(await cancellationWorker.initialize(), true);
const cancellationResult = await cancellationWorker.processBuild({
  id: cancellationBuildId, organization_id: sourceOrgId, app_id: sourceAppId,
  repository_id: sourceRepoId, blueprint_id: sourceBlueprintId,
  source_branch: "main", commit_sha: commitSha, lease_token: sourceLeaseId, attempt_count: 1
});
assert.equal(buildProcessStarted, true);
assert.equal(cancellationObserved, true);
assert.equal(cancellationResult.status, "cancelled");
assert.ok(cancellationCalls.some(call => call.method === "PATCH" && call.url.includes("feltus_builds?") && call.body.exit_code === 143));
assert.ok(cancellationCalls.some(call => call.method === "PATCH" && call.url.includes("feltus_build_steps") && call.body.status === "skipped"));
await cancellationWorker.stop();
console.log("PASS worker cancellation stops the active build client and persists the cancelled exit");

const timeoutBuildId = "55555555-5555-4555-8555-555555555555";
const timeoutCalls = [];
const timeoutWorker = createBuildWorker({
  env: sourceEnv,
  workerId: "build-worker-timeout-test",
  buildTimeoutSeconds: 0.05,
  spawnImpl(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = signal => {
      process.nextTick(() => child.emit("close", null, signal));
      return true;
    };
    process.nextTick(async () => {
      if (command === "git" && args[0] === "init") await writeFile(path.join(options.cwd, "Dockerfile"), "FROM scratch\n");
      if (command === "git" && args[0] === "rev-parse") child.stdout.emit("data", `${commitSha}\n`);
      if (command === "buildctl" && args.includes("build")) return;
      child.emit("close", 0, null);
    });
    return child;
  },
  fetchImpl: async (url, init = {}) => {
    const address = String(url);
    if (address.startsWith("https://api.github.com/")) {
      if (address.endsWith("/commits/" + commitSha)) return Response.json({ sha: commitSha });
      return Response.json({ id: repository.provider_repository_id });
    }
    timeoutCalls.push({ url: address, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (address.includes("/rest/v1/feltus_repositories?")) return Response.json([repository]);
    if (address.includes("/rest/v1/feltus_git_connections?")) return Response.json([gitConnection]);
    if (address.includes("/rest/v1/feltus_build_steps") && init.method === "POST") {
      return Response.json([{ id: `timeout-step-${timeoutCalls.length}` }]);
    }
    return new Response(null, { status: 204 });
  }
});
assert.equal(await timeoutWorker.initialize(), true);
const timeoutResult = await timeoutWorker.processBuild({
  id: timeoutBuildId, organization_id: sourceOrgId, app_id: sourceAppId,
  repository_id: sourceRepoId, blueprint_id: sourceBlueprintId,
  source_branch: "main", commit_sha: commitSha, lease_token: sourceLeaseId, attempt_count: 1
});
assert.equal(timeoutResult.status, "failed");
assert.equal(timeoutResult.failure_code, "BUILD_TIMEOUT");
assert.equal(timeoutResult.exit_code, 124);
assert.ok(timeoutCalls.some(call => call.url.includes("feltus_fail_application_build") && call.body.p_exit_code === 124));
assert.ok(timeoutCalls.some(call => call.method === "PATCH" && call.url.includes("feltus_build_steps") && call.body.status === "failed" && call.body.exit_code === 124));
await timeoutWorker.stop();
console.log("PASS build timeout terminates the active client and persists the timeout exit code");
await rm(credentialFixtureDirectory, { recursive: true, force: true });
