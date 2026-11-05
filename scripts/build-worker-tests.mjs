import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encryptGithubSecret } from "../src/lib/feltus-github.js";
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
const githubToken = "private-github-token-value";
const masterKey = "unit-test-encryption-key-material-32-bytes";
const restCalls = [];
const persistedSteps = [];
let nextStep = 0;
const repository = {
  id: sourceRepoId, organization_id: sourceOrgId,
  git_connection_id: "33333333-3333-4333-8333-333333333333",
  provider_repository_id: "fixture-repository-1", repository_name: "fixture/app",
  clone_url: "https://github.com/fixture/app.git", archived_at: null
};
const gitConnection = {
  id: repository.git_connection_id, provider: "github", disabled_at: null,
  credential_ciphertext: encryptGithubSecret(githubToken, masterKey, "github-oauth-token:v1"),
  encryption_key_version: "aes-256-gcm-hkdf-v1"
};
const sourceEnv = {
  ...fileCredentialEnv,
  FELTUS_SECRET_ENCRYPTION_KEY: masterKey
};
const sourceWorker = createBuildWorker({
  env: sourceEnv,
  workerId: "build-worker-source-test",
  spawnImpl: asyncSpawn,
  fetchImpl: async (url, init = {}) => {
    const address = String(url);
    if (address.startsWith("https://api.github.com/")) {
      if (address.endsWith("/commits/" + commitSha)) return Response.json({ sha: commitSha });
      return Response.json({ id: repository.provider_repository_id });
    }
    if (address.startsWith("https://ghcr.io/v2/")) {
      return new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
    }
    restCalls.push({ url: address, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (address.includes("/rest/v1/feltus_repositories?")) return Response.json([repository]);
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
  process.nextTick(async () => {
    try {
      if (command === "git" && args[0] === "init") {
        await writeFile(path.join(options.cwd, "Dockerfile"), "FROM scratch\n");
        child.stdout.emit("data", "checkout private-github-");
        child.stdout.emit("data", "token-value\n");
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
const finishCall = restCalls.find(call => call.url.includes("feltus_finish_application_build"));
assert.ok(finishCall, "worker persists the verified artifact through the canonical completion RPC");
assert.equal(finishCall.body.p_digest, digest);
assert.equal(finishCall.body.p_provenance.commit_sha, commitSha);
assert.equal(finishCall.body.p_provenance.blueprint_id, sourceBlueprintId);
assert.equal(persistedSteps.length, 3);
assert.ok(persistedSteps.every(step => step.status === "succeeded"));
assert.equal(persistedSteps.some(step => String(step.log_text).includes(githubToken)), false);
assert.equal(persistedSteps.some(step => String(step.log_text).includes(keyFixtureBody)), false, "BuildKit private-key material is redacted from persisted build logs");
assert.ok(restCalls.some(call => call.url.includes("feltus_start_application_build")));
assert.ok(restCalls.some(call => call.url.includes("feltus_update_build_status") && call.body.p_status === "building"));
assert.ok(restCalls.some(call => call.url.includes("feltus_update_build_status") && call.body.p_status === "verifying"));
await sourceWorker.stop();
console.log("PASS pinned GitHub checkout, isolated BuildKit invocation, redacted step logs, registry digest verification, and artifact lineage persistence");

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
