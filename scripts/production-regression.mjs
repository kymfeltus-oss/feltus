import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AI_CAPABILITIES, routeModel } from "../src/lib/feltus-ai-router.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, status: "PASS" });
  } catch (error) {
    results.push({ name, status: "FAIL", message: error.message });
  }
}

async function liveCheck(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
  } catch (error) {
    results.push({ name, status: "BLOCKED", message: error.message });
  }
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const compose = fs.readFileSync(path.join(root, "compose.production.yaml"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
const backupScript = fs.readFileSync(path.join(root, "scripts/backup.sh"), "utf8");
const storageBackupScript = fs.readFileSync(path.join(root, "scripts/backup-storage.sh"), "utf8");
const storageRestoreScript = fs.readFileSync(path.join(root, "scripts/restore-storage.sh"), "utf8");
const deployment = fs.readFileSync(path.join(root, "DEPLOYMENT.md"), "utf8");

check("AI capability controls and auto model", () => {
  assert.equal((html.match(/id="aiCapabilitySelect"/g) || []).length, 1);
  assert.equal((html.match(/id="aiModelSelect"/g) || []).length, 1);
  assert.match(html, /Auto - Best Available/);
  for (const capability of AI_CAPABILITIES) {
    assert.match(html, new RegExp(`value="${capability}"`));
  }
  assert.match(html, /autoModelOption\.value\s*=\s*"__auto__"/);
  assert.match(html, /selectedModel\s*===\s*"__auto__"\s*\?\s*""\s*:\s*selectedModel/);
  assert.match(html, /capability\s*,[\s\S]{0,140}model\s*,/);
});

check("canonical cross-platform package entrypoints", () => {
  assert.equal(packageJson.scripts.dev, "node scripts/dev.js");
  assert.equal(packageJson.scripts.start, "node src/server.js");
  assert.equal(packageJson.scripts.check, "node scripts/check.js");
  assert.equal(packageJson.scripts.regression, "node scripts/production-regression.mjs");
});

check("AI capability and model routing", () => {
  const models = [
    { name: "llama3:8b", size: 8_000_000_000 },
    { name: "deepseek-r1:14b", size: 14_000_000_000 },
    { name: "qwen2.5-coder:7b", size: 7_000_000_000 },
    { name: "llava:7b", size: 7_500_000_000 }
  ];
  assert.equal(routeModel({ installedModels: models, capability: "reasoning" }).model, "deepseek-r1:14b");
  assert.equal(routeModel({ installedModels: models, capability: "coding" }).model, "qwen2.5-coder:7b");
  assert.equal(routeModel({ installedModels: models, capability: "vision" }).model, "llava:7b");
  assert.equal(routeModel({ installedModels: models, capability: "fast" }).model, "qwen2.5-coder:7b");
  assert.throws(
    () => routeModel({ installedModels: models, capability: "not-a-capability" }),
    error => error.code === "FELTUS_AI_INVALID_CAPABILITY"
  );
  assert.throws(
    () => routeModel({ installedModels: models, requestedModel: "not-installed" }),
    error => error.code === "FELTUS_AI_MODEL_NOT_INSTALLED"
  );
});

check("production auth, cookie and origin protections", () => {
  assert.match(server, /__Host-feltus_session/);
  assert.match(server, /HttpOnly/);
  assert.match(server, /SameSite=Strict/);
  assert.match(server, /Content-Security-Policy/);
  assert.match(server, /Authentication required\./);
  assert.match(server, /url\.pathname\.startsWith\("\/auth\/v1\/"\)/);
  assert.match(server, /FELTUS_TRUST_PROXY === "1"/);
  assert.match(server, /requireOrigin/);
  assert.match(server, /SESSION_TTL_SECONDS = 8 \* 60 \* 60/);
  assert.doesNotMatch(html, /localStorage\.(?:setItem|getItem)\([^\n]*(?:token|session)/i);
});

check("persistent storage and private service exposure", () => {
  assert.match(compose, /feltus_postgres:\s*$/m);
  assert.match(compose, /feltus_documents:\s*$/m);
  assert.match(compose, /feltus_object_storage:\s*$/m);
  assert.match(compose, /FELTUS_STORAGE_ROOT: \/data\/feltus-storage/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:[\s\S]{0,35}- ALL/);
});

check("production Docker runtime and build-context exclusions", () => {
  assert.match(dockerfile, /^FROM node:22-alpine/m);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /CMD \["node", "src\/server\.js"\]/);
  for (const pattern of ["node_modules", ".env", ".env.*", ".feltus-dev-auth.json", ".feltus-storage", ".feltus-runtime", "**/*.bak", "**/*.backup*", "**/*-backup", "**/*.pre-*"]) {
    assert.ok(dockerignore.split(/\r?\n/).includes(pattern), `Docker build context does not exclude ${pattern}`);
  }
});

check("timestamped database, file and configuration backups", () => {
  assert.match(backupScript, /date -u/);
  assert.match(backupScript, /deployment\.env/);
  assert.match(backupScript, /pg_dump/);
  assert.match(backupScript, /pg_restore --list/);
  assert.match(storageBackupScript, /tar -tzf/);
  assert.match(storageBackupScript, /for entry in documents object-storage/);
  assert.match(storageRestoreScript, /tar -xzf/);
  assert.match(deployment, /pg_restore --clean --if-exists/);
  assert.match(deployment, /stop writes on the old stack/);
});

check("tracked and pending files contain no committed secret material", () => {
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "buffer" }
  );
  assert.equal(listed.status, 0, "git could not list repository files");
  const names = listed.stdout.toString("utf8").split("\0").filter(Boolean);
  const secretName = names.find(name => /(^|\/)(\.env(\..*)?|\.feltus-dev-auth\.json)$/i.test(name) && !name.endsWith(".env.example"));
  assert.equal(secretName, undefined, `secret-bearing file is tracked: ${secretName}`);
  const backupName = names.find(name => /(?:\.bak(?:$|\.)|\.backup(?:$|[-.])|-backup$|\.pre-[^/]*)/i.test(name));
  assert.equal(backupName, undefined, `local backup snapshot is tracked: ${backupName}`);

  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /sb_secret_[A-Za-z0-9_-]{20,}/,
    /sb_service_role_[A-Za-z0-9_-]{20,}/,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/
  ];
  for (const name of names) {
    const absolute = path.resolve(root, name);
    assert.ok(absolute.startsWith(`${root}${path.sep}`), `unsafe repository path: ${name}`);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const content = fs.readFileSync(absolute);
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    for (const pattern of secretPatterns) {
      assert.equal(pattern.test(text), false, `secret-like value found in ${name}`);
    }
  }
});

check("Docker Compose production configuration", () => {
  const result = spawnSync(
    "docker",
    ["compose", "--env-file", ".env.example", "--file", "compose.production.yaml", "config", "--quiet"],
    { cwd: root, encoding: "utf8", timeout: 30000 }
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message || "docker compose config failed");
});

const localPort = 18000 + Math.floor(Math.random() * 10000);
const runtimeRoot = path.join(root, ".feltus-runtime");
fs.mkdirSync(runtimeRoot, { recursive: true });
const storageRoot = fs.mkdtempSync(path.join(runtimeRoot, "production-smoke-"));
const dummyKey = "local-smoke-anon-key";
const child = spawn(process.execPath, ["src/server.js"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    FELTUS_ENV: "production",
    NODE_ENV: "production",
    FELTUS_LOCAL_DEV_MODE: "0",
    FELTUS_HOST: "127.0.0.1",
    FELTUS_PORT: String(localPort),
    FELTUS_PUBLIC_URL: "https://feltuslabs.com",
    FELTUS_ALLOWED_ORIGINS: "https://feltuslabs.com,https://www.feltuslabs.com",
    FELTUS_GATEWAY_URL: "http://127.0.0.1:1",
    FELTUS_PUBLISHABLE_KEY: dummyKey,
    FELTUS_OWNER_EMAIL: "smoke-owner@example.com",
    FELTUS_STORAGE_ROOT: storageRoot
  }
});
let childError = "";
let childOutput = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  childOutput = `${childOutput}${chunk}`.slice(-1200);
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", chunk => {
  childError = `${childError}${chunk}`.slice(-1200);
});

const baseUrl = `http://127.0.0.1:${localPort}`;

try {
  await liveCheck("production-mode server liveness and session gate", async () => {
    let healthResponse;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error(`production smoke server exited before listening${childError ? `: ${childError.trim()}` : ""}`);
      }
      try {
        healthResponse = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
    assert.ok(
      healthResponse,
      /Listening on /.test(childOutput)
        ? "restricted runtime could not connect to the loopback smoke server"
        : `production smoke server did not start${childError ? `: ${childError.trim()}` : ""}`
    );
    assert.equal(healthResponse.status, 200);
    assert.equal(healthResponse.headers.get("cache-control"), "no-store");
    assert.equal(healthResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await healthResponse.json()).auth_required, true);

    const readinessResponse = await fetch(`${baseUrl}/api/ready`);
    assert.equal(readinessResponse.status, 503);

    const aiStatusResponse = await fetch(`${baseUrl}/api/ai/status`);
    assert.equal(aiStatusResponse.status, 401, "AI model inventory is not protected by the production session gate");

    const sessionResponse = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(sessionResponse.status, 200);
    assert.equal((await sessionResponse.json()).authenticated, false);

    const protectedResponse = await fetch(`${baseUrl}/api/apps`);
    assert.equal(protectedResponse.status, 401);

    const rejectedOriginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.invalid"
      },
      body: "{}"
    });
    assert.equal(rejectedOriginResponse.status, 403);

    const pageResponse = await fetch(baseUrl);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /feltus-auth-gate/);
  });
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const timeout = setTimeout(resolve, 3000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  const resolvedStorage = path.resolve(storageRoot);
  const safeRuntimeRoot = path.resolve(root, ".feltus-runtime");
  if (resolvedStorage.startsWith(`${safeRuntimeRoot}${path.sep}`)) {
    fs.rmSync(resolvedStorage, { recursive: true, force: true });
  }
}

const localRegressionBase = process.env.FELTUS_LOCAL_REGRESSION_URL?.replace(/\/$/, "");
const localRegressionAppId = process.env.FELTUS_LOCAL_REGRESSION_APP_ID || "";
if (localRegressionBase || localRegressionAppId) {
  if (
    !localRegressionBase ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(localRegressionAppId)
  ) {
    results.push({
      name: "local live regression configuration",
      status: "FAIL",
      message: "Set FELTUS_LOCAL_REGRESSION_URL and a valid existing FELTUS_LOCAL_REGRESSION_APP_ID."
    });
  } else {
    async function localJson(pathname, timeoutMs = 15000) {
      const response = await fetch(`${localRegressionBase}${pathname}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        // Keep response content out of regression output.
      }
      return { response, body };
    }

    await liveCheck("local database and Auth readiness", async () => {
      const ready = await localJson("/api/ready");
      assert.equal(ready.response.status, 200, "local backend is not ready");
      assert.equal(ready.body?.status, "ready", "local backend readiness did not report ready");
    });

    await liveCheck("local application, document, model and relationship retrieval", async () => {
      const [apps, documents, models, relationships] = await Promise.all([
        localJson("/api/apps"),
        localJson(`/api/documents?app_id=${encodeURIComponent(localRegressionAppId)}`),
        localJson(`/api/models?app_id=${encodeURIComponent(localRegressionAppId)}`),
        localJson(`/api/relationships?app_id=${encodeURIComponent(localRegressionAppId)}`)
      ]);
      assert.equal(apps.response.status, 200, "application retrieval failed");
      assert.ok(Array.isArray(apps.body), "application response was not a list");
      assert.ok(apps.body.some(app => app.id === localRegressionAppId), "configured app ID is not an existing application");
      assert.equal(documents.response.status, 200, "document retrieval failed");
      assert.ok(Array.isArray(documents.body), "document response was not a list");
      assert.equal(models.response.status, 200, "model retrieval failed");
      assert.ok(Array.isArray(models.body), "model response was not a list");
      assert.equal(relationships.response.status, 200, "relationship retrieval failed");
      assert.ok(Array.isArray(relationships.body), "relationship response was not a list");
    });

    let localModels = [];
    await liveCheck("local AI status", async () => {
      const status = await localJson("/api/ai/status");
      assert.equal(status.response.status, 200, "configured local AI endpoint is unavailable");
      assert.ok(Array.isArray(status.body?.models) && status.body.models.length > 0, "local AI has no installed models");
      localModels = status.body.models;
    });

    await liveCheck("local deterministic routes and fail-closed cases", async () => {
      for (const capability of ["document-analysis", "reasoning", "coding"]) {
        const result = await localJson(`/api/ai/route?capability=${capability}`);
        assert.equal(result.response.status, 200, `${capability} route failed`);
        assert.ok(localModels.some(model => model.name === result.body?.route?.model), `${capability} route selected an uninstalled model`);
      }
      if (localModels.length === 1 && localModels[0].name === "llama3:8b") {
        for (const capability of ["reasoning", "coding"]) {
          const result = await localJson(`/api/ai/route?capability=${capability}`);
          assert.equal(result.body?.route?.model, "llama3:8b", `${capability} did not fall back to the general model`);
          assert.equal(result.body?.route?.fallback, true, `${capability} fallback was not identified`);
        }
      }
      const vision = await localJson("/api/ai/route?capability=vision");
      if (vision.response.status !== 200) {
        assert.equal(vision.response.status, 400, "vision returned an unexpected failure status");
        assert.equal(vision.body?.code, "FELTUS_AI_CAPABILITY_UNAVAILABLE", "vision did not fail closed");
      } else {
        assert.ok(localModels.some(model => model.name === vision.body?.route?.model), "vision selected an uninstalled model");
      }
      const invalid = await localJson("/api/ai/route?capability=not-a-capability");
      assert.equal(invalid.response.status, 400, "invalid capability was not rejected");
      assert.equal(invalid.body?.code, "FELTUS_AI_INVALID_CAPABILITY", "invalid capability error code changed");
      const unknownModel = await localJson("/api/ai/route?capability=general&model=not-installed-for-regression");
      assert.equal(unknownModel.response.status, 400, "unknown explicit model was not rejected");
      assert.equal(unknownModel.body?.code, "FELTUS_AI_MODEL_NOT_INSTALLED", "unknown model error code changed");
    });

    await liveCheck("local document-grounded NDJSON reconstruction", async () => {
      const response = await fetch(`${localRegressionBase}/api/ai/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
          Origin: new URL(localRegressionBase).origin
        },
        body: JSON.stringify({
          app_id: localRegressionAppId,
          model: "",
          capability: "document-analysis",
          prompt: "Find the verification marker in this project's documents. Return the exact marker and nothing else."
        }),
        signal: AbortSignal.timeout(180000)
      });
      const raw = await response.text();
      const events = raw.split(/\r?\n/).filter(Boolean).map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
      const reconstructedAnswer = events
        .filter(event => event.type === "token" && typeof event.text === "string")
        .map(event => event.text)
        .join("");
      const errors = events.filter(event => event.type === "error").map(event => event.code || "error");
      assert.equal(response.status, 200, "document-grounded stream failed");
      assert.ok(events.length > 0, "stream did not contain NDJSON events");
      assert.equal(errors.length, 0, `stream emitted error events: ${errors.join(",")}`);
      assert.ok(reconstructedAnswer.includes("FELTUS-5G3-UI-PASS"), "reconstructed answer missed the existing document marker");
    });
  }
}

if (process.env.FELTUS_REGRESSION_BASE_URL) {
  await liveCheck("configured FELTUS deployment health and sign-in gate", async () => {
    const base = process.env.FELTUS_REGRESSION_BASE_URL.replace(/\/$/, "");
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10000) });
    assert.equal(health.status, 200);
    const session = await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(10000) });
    assert.equal(session.status, 200);
    const apps = await fetch(`${base}/api/apps`, { signal: AbortSignal.timeout(10000) });
    assert.equal(apps.status, 401);
  });
}

for (const result of results) {
  const details = result.message ? ` — ${result.message}` : "";
  process.stdout.write(`${result.status} ${result.name}${details}\n`);
}

const failed = results.some(result => result.status === "FAIL");
const blocked = results.some(result => result.status === "BLOCKED");
process.stdout.write(`FELTUS PRODUCTION READINESS: ${failed || blocked ? "FAIL" : "PASS"}\n`);
process.exitCode = failed ? 1 : blocked ? 2 : 0;
