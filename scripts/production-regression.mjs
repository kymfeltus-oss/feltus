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
const compose = fs.readFileSync(path.join(root, "compose.production.yaml"), "utf8");

check("AI capability controls and auto model", () => {
  assert.equal((html.match(/id="aiCapabilitySelect"/g) || []).length, 1);
  assert.equal((html.match(/id="aiModelSelect"/g) || []).length, 1);
  assert.match(html, /Auto - Best Available/);
  for (const capability of AI_CAPABILITIES) {
    assert.match(html, new RegExp(`value="${capability}"`));
  }
  assert.match(html, /capability\s*,[\s\S]{0,140}model\s*,/);
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
    assert.equal((await healthResponse.json()).auth_required, true);

    const sessionResponse = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(sessionResponse.status, 200);
    assert.equal((await sessionResponse.json()).authenticated, false);

    const protectedResponse = await fetch(`${baseUrl}/api/apps`);
    assert.equal(protectedResponse.status, 401);

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
process.exitCode = failed ? 1 : blocked ? 2 : 0;
