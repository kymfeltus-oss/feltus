import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(root, ".feltus-runtime");
fs.mkdirSync(runtimeRoot, { recursive: true });
const storageRoot = fs.mkdtempSync(path.join(runtimeRoot, "production-handler-smoke-"));

Object.assign(process.env, {
  FELTUS_ENV: "production",
  NODE_ENV: "production",
  FELTUS_LOCAL_DEV_MODE: "0",
  FELTUS_DISABLE_LISTEN: "1",
  FELTUS_HOST: "127.0.0.1",
  FELTUS_PORT: "18080",
  FELTUS_PUBLIC_URL: "https://feltuslabs.com",
  FELTUS_ALLOWED_ORIGINS: "https://feltuslabs.com,https://www.feltuslabs.com",
  FELTUS_GATEWAY_URL: "http://127.0.0.1:1",
  FELTUS_EVIDENCE_EXTRACTION_URL: "http://127.0.0.1:1",
  FELTUS_EVIDENCE_EXTRACTION_TOKEN: "local-smoke-evidence-extractor-token-0001",
  FELTUS_PUBLISHABLE_KEY: "local-smoke-anon-key",
  FELTUS_OWNER_EMAIL: "smoke-owner@example.com",
  FELTUS_STORAGE_ROOT: storageRoot
});

const { handleHttpRequest } = await import("../src/server.js");

function makeResponse() {
  let finish;
  const completed = new Promise(resolve => {
    finish = resolve;
  });
  const response = {
    statusCode: 200,
    headers: {},
    body: "",
    finished: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value);
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers)) {
        this.setHeader(name, value);
      }
    },
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
    end(chunk = "") {
      this.body += String(chunk);
      this.finished = true;
      finish();
    },
    flushHeaders() {}
  };
  return { response, completed };
}

async function request(method, url, headers = {}, body = "") {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  Object.assign(request, {
    method,
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" }
  });
  const { response, completed } = makeResponse();
  await handleHttpRequest(request, response);
  if (!response.finished) {
    await completed;
  }
  return response;
}

try {
  const health = await request("GET", "/api/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.headers["cache-control"], "no-store");
  assert.equal(health.headers["x-content-type-options"], "nosniff");
  assert.match(health.headers["x-request-id"], /^[0-9a-f-]{36}$/i);
  assert.equal(JSON.parse(health.body).auth_required, true);

  const readiness = await request("GET", "/api/ready");
  assert.equal(readiness.statusCode, 503);
  const readinessBody = JSON.parse(readiness.body);
  assert.equal(readinessBody.status, "not_ready");
  assert.equal(readinessBody.services.database, "offline");
  assert.equal(readinessBody.services.auth, "offline");
  assert.equal(readinessBody.services.evidence_extraction, "offline");

  const session = await request("GET", "/api/auth/session");
  assert.equal(session.statusCode, 200);
  assert.equal(JSON.parse(session.body).authenticated, false);

  const protectedApps = await request("GET", "/api/apps");
  assert.equal(protectedApps.statusCode, 401);

  const protectedAI = await request("GET", "/api/ai/status");
  assert.equal(protectedAI.statusCode, 401);

  const rejectedOrigin = await request(
    "POST",
    "/api/auth/login",
    { "content-type": "application/json", origin: "https://attacker.invalid" },
    "{}"
  );
  assert.equal(rejectedOrigin.statusCode, 403);

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const recovery = await request(
        "POST",
        "/auth/v1/recover",
        { "content-type": "application/json", origin: "https://feltuslabs.com" },
        JSON.stringify({ email: `not-owner-${attempt}@example.com` })
      );
      assert.equal(recovery.statusCode, 200);
      assert.deepEqual(JSON.parse(recovery.body), {});
    }

    const throttledRecovery = await request(
      "POST",
      "/auth/v1/recover",
      { "content-type": "application/json", origin: "https://feltuslabs.com" },
      JSON.stringify({ email: "another-address@example.com" })
    );
    assert.equal(throttledRecovery.statusCode, 429);
  } finally {
    console.warn = originalWarn;
  }

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://feltuslabs.com/#access_token=smoke&type=recovery" }
      });
    };
    const allowedRecoveryRedirect = await request(
      "GET",
      "/auth/v1/verify?type=recovery&token=smoke"
    );
    assert.equal(allowedRecoveryRedirect.statusCode, 302);
    assert.equal(
      allowedRecoveryRedirect.headers.location,
      "https://feltuslabs.com/#access_token=smoke&type=recovery"
    );

    globalThis.fetch = async () => new Response(null, {
      status: 302,
      headers: { location: "https://attacker.invalid/#access_token=smoke" }
    });
    const rejectedRecoveryRedirect = await request(
      "GET",
      "/auth/v1/verify?type=recovery&token=smoke"
    );
    assert.equal(rejectedRecoveryRedirect.statusCode, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }

  process.stdout.write("PASS production handler liveness, session gate, and recovery throttling\n");
} finally {
  const resolvedStorage = path.resolve(storageRoot);
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  if (resolvedStorage.startsWith(`${resolvedRuntimeRoot}${path.sep}`)) {
    fs.rmSync(resolvedStorage, { recursive: true, force: true });
  }
}
