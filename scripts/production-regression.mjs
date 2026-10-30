import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AI_CAPABILITIES, routeModel } from "../src/lib/feltus-ai-router.js";
import { resolveAIEndpointPolicy } from "../src/lib/feltus-ai-policy.js";
import { loadAuthorizedAIHistory } from "../src/lib/feltus-ai-history.js";
import { composeAIPrompt } from "../src/lib/feltus-ai-prompt.js";
import { FeltusAI } from "../src/lib/feltus-ai.js";

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

async function checkAsync(name, fn) {
  try {
    await fn();
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
const productionWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/production-regression.yml"),
  "utf8"
);
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
const backupScript = fs.readFileSync(path.join(root, "scripts/backup.sh"), "utf8");
const storageBackupScript = fs.readFileSync(path.join(root, "scripts/backup-storage.sh"), "utf8");
const storageRestoreScript = fs.readFileSync(path.join(root, "scripts/restore-storage.sh"), "utf8");
const deployment = fs.readFileSync(path.join(root, "DEPLOYMENT.md"), "utf8");
const apiInventory = fs.readFileSync(path.join(root, "docs/api/current-api.md"), "utf8");
const extractorDockerfile = fs.readFileSync(
  path.join(root, "services/evidence-extractor/Dockerfile"),
  "utf8"
);
const extractorMain = fs.readFileSync(
  path.join(root, "services/evidence-extractor/app/main.py"),
  "utf8"
);
const aiConversationMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20261030100000_project_scoped_ai_conversations.sql"),
  "utf8"
);

const aiClient = fs.readFileSync(path.join(root, "src/lib/feltus-ai.js"), "utf8");

check("AI capability controls and auto model", () => {
  assert.equal((html.match(/id="aiCapabilitySelect"/g) || []).length, 1);
  assert.equal((html.match(/id="aiModelSelect"/g) || []).length, 1);
  assert.match(html, /Auto - Best Available/);
  for (const capability of AI_CAPABILITIES) {
    assert.match(html, new RegExp(`value="${capability}"`));
  }
  assert.match(html, /autoModelOption\.value\s*=\s*"__auto__"/);
  assert.match(html, /selectedModel\s*===\s*"__auto__"\s*\?\s*""\s*:\s*selectedModel/);
  assert.ok(
    /capability,\s*app_id:\s*requestProjectId,[\s\S]{0,180}model,/.test(html),
    "stream request does not carry the selected capability and model"
  );
});

check("canonical cross-platform package entrypoints", () => {
  assert.equal(packageJson.scripts.dev, "node scripts/dev.js");
  assert.equal(packageJson.scripts.start, "node src/server.js");
  assert.equal(packageJson.scripts.check, "node scripts/check.js");
  assert.equal(packageJson.scripts.regression, "node scripts/production-regression.mjs");
});

check("CI runs production checks on every branch update", () => {
  assert.match(productionWorkflow, /^on:\s*\r?\n\s+push:\s*\r?\n\s+pull_request:/m);
  assert.match(productionWorkflow, /node-version: 22/);
  assert.match(productionWorkflow, /npm run regression/);
  assert.match(productionWorkflow, /python -m unittest discover/);
  assert.match(productionWorkflow, /docker compose .* build app evidence-extractor/);
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

check("owner-only password recovery and redirect protections", () => {
  assert.match(server, /url\.pathname === "\/auth\/v1\/recover"/);
  assert.match(server, /"password-recovery",\s*5,\s*60 \* 60 \* 1000/);
  assert.match(server, /email: IS_PRODUCTION\s*\?\s*OWNER_EMAIL/);
  assert.match(server, /redirect_to: PUBLIC_URL/);
  assert.match(server, /safeRedirect\.origin/);
  assert.match(server, /redirect:\s*method === "GET" && url\.pathname === "\/auth\/v1\/verify"\s*\?\s*"manual"/);
  assert.match(html, /id="feltus-password-recovery-request"/);
  assert.match(html, /id="feltus-password-recovery-complete"/);
  assert.match(html, /fetch\("\/auth\/v1\/user"/);
  assert.match(html, /new URLSearchParams\(window\.location\.hash/);
  assert.match(html, /window\.history\.replaceState/);
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

check("private PDF evidence extraction integration", () => {
  assert.match(compose, /^  evidence-extractor:/m);
  assert.match(compose, /FELTUS_EVIDENCE_EXTRACTION_URL: http:\/\/evidence-extractor:8090/);
  assert.match(compose, /feltus_documents:\/data\/feltus-storage:ro/);
  assert.match(server, /async function parsePdfDocument/);
  assert.match(server, /feltus-evidence-extraction-1\.0|extraction_artifact/);
  assert.match(server, /\/api\/documents\/extraction/);
  assert.match(server, /evidence_extraction:/);
  assert.match(extractorDockerfile, /tesseract-ocr/);
  assert.match(extractorDockerfile, /^USER feltus$/m);
  assert.match(extractorMain, /source_sha256/);
  assert.match(extractorMain, /resolve_document_path/);
  assert.match(extractorMain, /"NEEDS_REVIEW"/);
  assert.match(extractorMain, /secrets\.compare_digest/);
  assert.match(extractorMain, /Depends\(require_extraction_token\)/);
  assert.match(server, /FELTUS_EVIDENCE_EXTRACTION_TOKEN must contain at least 32 characters/);
  assert.match(server, /Authorization:\s*`Bearer \$\{EVIDENCE_EXTRACTION_TOKEN\}`/);
});

check("project switch aborts and isolates in-flight AI streams", () => {
  assert.match(html, /let activeAIRequest = null/);
  assert.match(html, /let activeAIProjectId = null/);
  assert.match(html, /let activeAIConversationId = null/);
  assert.match(html, /let activeAIRequestGeneration = 0/);
  assert.match(html, /function cancelActiveAIRequest\(/);
  assert.match(html, /function selectActiveProject\(project\)/);
  assert.match(html, /activeAIRequestGeneration === requestGeneration/);
  assert.match(html, /selectedProject\?\.id === requestProjectId/);
  assert.match(html, /signal:\s*controller\.signal/);
  assert.match(html, /if \(!requestIsCurrent\(\)\)/);
  const switchProject = html.match(/function selectActiveProject\(project\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  const clearConversation = html.match(/function clearAIConversation\(\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  const cancelRequest = html.match(/function cancelActiveAIRequest\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(switchProject, /clearAIConversation\(\)/);
  assert.match(clearConversation, /cancelActiveAIRequest\(\)/);
  assert.match(cancelRequest, /activeAIRequestGeneration\s*\+=\s*1/);
  assert.match(cancelRequest, /request\.abort\(\)/);
});

await checkAsync("trusted local AI endpoint is validated and history stays opt-in", async () => {
  const policy = await resolveAIEndpointPolicy({
    FELTUS_ENV: "development",
    FELTUS_AI_ENDPOINT: "http://127.0.0.1:11434",
    FELTUS_AI_ENDPOINT_TRUST: "local_private",
    FELTUS_AI_SEND_HISTORY: "false",
    FELTUS_AI_SEND_PROJECT_CONTEXT: "true",
    FELTUS_AI_MAX_HISTORY_MESSAGES: "20"
  });
  assert.equal(policy.trust, "local_private");
  assert.equal(policy.sendProjectContext, true);
  assert.equal(policy.sendHistory, false);
  assert.equal(policy.maxHistoryMessages, 20);
  const servicePolicy = await resolveAIEndpointPolicy({
    FELTUS_ENV: "production",
    FELTUS_AI_ENDPOINT: "http://ollama:11434",
    FELTUS_AI_ENDPOINT_TRUST: "private_managed",
    FELTUS_AI_ALLOWED_PRIVATE_HOSTS: "ollama"
  }, { lookup: async () => [{ address: "172.21.0.5", family: 4 }] });
  assert.equal(servicePolicy.trust, "private_managed");
  assert.equal(servicePolicy.sendProjectContext, true);
  assert.equal(servicePolicy.sendHistory, false);
  const optedInServicePolicy = await resolveAIEndpointPolicy({
    FELTUS_ENV: "production",
    FELTUS_AI_ENDPOINT: "http://ollama:11434",
    FELTUS_AI_ENDPOINT_TRUST: "private_managed",
    FELTUS_AI_ALLOWED_PRIVATE_HOSTS: "ollama",
    FELTUS_AI_SEND_HISTORY: "true"
  }, { lookup: async () => [{ address: "172.21.0.5", family: 4 }] });
  assert.equal(optedInServicePolicy.sendHistory, true);
  await assert.rejects(
    resolveAIEndpointPolicy({
      FELTUS_ENV: "production",
      FELTUS_AI_ENDPOINT: "https://public.example/ollama",
      FELTUS_AI_ENDPOINT_TRUST: "local_private",
      FELTUS_AI_ALLOWED_PRIVATE_HOSTS: "public.example"
    }, { lookup: async () => [{ address: "203.0.113.20", family: 4 }] }),
    /resolve only to loopback or private network addresses/
  );
});

await checkAsync("unverified external AI endpoint fails closed for stored data", async () => {
  const policy = await resolveAIEndpointPolicy({
    FELTUS_ENV: "production",
    FELTUS_AI_ENDPOINT: "https://ai.example.test/v1",
    FELTUS_AI_ENDPOINT_TRUST: "external_unverified",
    FELTUS_AI_SEND_HISTORY: "true"
  }, { lookup: async () => [{ address: "203.0.113.10", family: 4 }] });
  assert.equal(policy.sendHistory, false);
  assert.equal(policy.sendProjectContext, false);
  const prompt = composeAIPrompt({
    systemInstructions: "FELTUS system instructions",
    projectContext: policy.sendProjectContext ? "SENSITIVE PROJECT DATA" : "",
    history: policy.sendHistory ? [{ role: "user", content: "SENSITIVE HISTORY" }] : [],
    retrievedContext: policy.sendProjectContext ? "PRIVATE DOCUMENT" : "",
    currentPrompt: "Current prompt explicitly supplied by the user"
  });
  assert.match(prompt, /Current prompt explicitly supplied by the user/);
  assert.doesNotMatch(prompt, /SENSITIVE PROJECT DATA|SENSITIVE HISTORY|PRIVATE DOCUMENT/);
});

await checkAsync("external trusted endpoint requires HTTPS and an exact approved host", async () => {
  const base = {
    FELTUS_ENV: "production",
    FELTUS_AI_ENDPOINT: "https://trusted.example.test",
    FELTUS_AI_ENDPOINT_TRUST: "external_trusted",
    FELTUS_AI_SEND_HISTORY: "true",
    FELTUS_AI_SEND_PROJECT_CONTEXT: "true"
  };
  await assert.rejects(
    resolveAIEndpointPolicy(base, { lookup: async () => [{ address: "203.0.113.11", family: 4 }] }),
    /listed in FELTUS_AI_TRUSTED_HOSTS/
  );
  const policy = await resolveAIEndpointPolicy({
    ...base,
    FELTUS_AI_TRUSTED_HOSTS: "trusted.example.test"
  }, { lookup: async () => [{ address: "203.0.113.11", family: 4 }] });
  assert.equal(policy.sendHistory, true);
  assert.equal(policy.sendProjectContext, true);
});

await checkAsync("cross-project AI conversation history cannot load or enter a prompt", async () => {
  const projectId = "project-a";
  const otherProjectId = "project-b";
  const ownerId = "owner-a";
  const conversationId = "conversation-a";
  const calls = [];
  const tableRequest = async (table, method, options) => {
    calls.push({ table, query: options.query });
    if (table === "feltus_ai_conversations") {
      return {
        status: 200,
        data: [{ id: conversationId, app_id: otherProjectId, owner_id: ownerId, status: "active" }]
      };
    }
    return { status: 200, data: [] };
  };
  const denied = await loadAuthorizedAIHistory(tableRequest, {
    appId: projectId,
    conversationId,
    ownerId,
    maxMessages: 20
  });
  assert.equal(denied.status, 404);
  assert.deepEqual(denied.messages, []);
  assert.equal(calls.some(call => call.table === "feltus_ai_messages"), false);
  assert.match(calls[0].query, /&app_id=eq.project-a/);
  assert.match(calls[0].query, /&owner_id=eq.owner-a/);

  const safeLoader = async (table, method, options) => {
    calls.push({ table, query: options.query });
    if (table === "feltus_ai_conversations") {
      return {
        status: 200,
        data: [{ id: conversationId, app_id: projectId, owner_id: ownerId, status: "active" }]
      };
    }
    return {
      status: 200,
      data: [
        { conversation_id: conversationId, app_id: projectId, owner_id: ownerId, role: "user", content: "authorized prior turn" },
        { conversation_id: "conversation-b", app_id: otherProjectId, owner_id: ownerId, role: "user", content: "CROSS PROJECT SECRET" },
        { conversation_id: conversationId, app_id: projectId, owner_id: "owner-b", role: "assistant", content: "CROSS OWNER SECRET" }
      ]
    };
  };
  const loaded = await loadAuthorizedAIHistory(safeLoader, {
    appId: projectId,
    conversationId,
    ownerId,
    maxMessages: 20
  });
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.messages, [{ role: "user", content: "authorized prior turn" }]);
  const prompt = composeAIPrompt({
    systemInstructions: "System",
    projectContext: "authorized project context",
    history: loaded.messages,
    retrievedContext: "authorized retrieved context",
    currentPrompt: "current"
  });
  assert.match(prompt, /authorized prior turn/);
  assert.doesNotMatch(prompt, /CROSS PROJECT SECRET|CROSS OWNER SECRET/);
  assert.match(calls.at(-1).query, /&conversation_id=eq.conversation-a/);
  assert.match(calls.at(-1).query, /&app_id=eq.project-a/);
  assert.match(calls.at(-1).query, /&owner_id=eq.owner-a/);
  const order = [
    prompt.indexOf("System"),
    prompt.indexOf("PROJECT CONTEXT"),
    prompt.indexOf("RECENT AUTHORIZED CONVERSATION"),
    prompt.indexOf("RETRIEVED PROJECT/DOCUMENT CONTEXT"),
    prompt.indexOf("CURRENT USER PROMPT")
  ];
  assert.ok(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1])));
});

await checkAsync("AI HTTP clients refuse endpoint redirects", async () => {
  const originalFetch = globalThis.fetch;
  let fetchOptions;
  globalThis.fetch = async (_url, options) => {
    fetchOptions = options;
    return {
      status: 302,
      ok: false,
      text: async () => "redirect body"
    };
  };
  try {
    const ai = new FeltusAI({ baseUrl: "http://127.0.0.1:11434" });
    await assert.rejects(ai.request("/api/tags"), /redirects are not allowed/);
    assert.equal(fetchOptions.redirect, "manual");
    await assert.rejects(async () => {
      for await (const _event of ai.generateStream("current prompt")) {
        // A redirect response must be rejected before an inference stream starts.
      }
    }, /redirects are not allowed/);
    assert.equal(fetchOptions.redirect, "manual");
    assert.equal((aiClient.match(/redirect:\s*"manual"/g) || []).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

check("project-scoped AI conversation storage and authorization", () => {
  assert.match(aiConversationMigration, /UNIQUE \(app_id, owner_id\)/);
  assert.match(aiConversationMigration, /ALTER TABLE public\.feltus_ai_conversations ENABLE ROW LEVEL SECURITY/);
  assert.match(aiConversationMigration, /ALTER TABLE public\.feltus_ai_messages ENABLE ROW LEVEL SECURITY/);
  assert.match(aiConversationMigration, /owner_id = auth\.uid\(\)/);
  assert.match(aiConversationMigration, /conversation\.app_id = feltus_ai_messages\.app_id/);
  assert.match(server, /url\.pathname === "\/api\/ai\/conversation"/);
  assert.match(server, /url\.pathname === "\/api\/ai\/messages"/);
  assert.match(server, /"&app_id=eq\." \+ encodeURIComponent\(appId\)/);
  assert.match(server, /conversation_id: conversationState\.conversation\.id/);
  assert.match(html, /"\/api\/ai\/conversation"/);
  assert.match(html, /"\/api\/ai\/messages\?app_id="/);
  assert.match(html, /conversation_id:\s*activeAIConversationId/);
  assert.match(server, /loadAuthorizedAIHistory\(/);
  assert.match(server, /historyLimit:\s*policy\.sendHistory\s*\?/);
  assert.doesNotMatch(server, /body\.history/);
  assert.match(server, /&app_id=eq\." \+ encodeURIComponent\(appId\)/);
  assert.match(server, /&owner_id=eq\." \+ encodeURIComponent\(ownerId/);
});

check("AI endpoint trust and data-sharing configuration is documented and bounded", () => {
  const policy = fs.readFileSync(path.join(root, "src/lib/feltus-ai-policy.js"), "utf8");
  const history = fs.readFileSync(path.join(root, "src/lib/feltus-ai-history.js"), "utf8");
  const prompt = fs.readFileSync(path.join(root, "src/lib/feltus-ai-prompt.js"), "utf8");
  for (const trust of ["local_private", "private_managed", "external_trusted", "external_unverified"]) {
    assert.ok(policy.includes(`"${trust}"`), `missing endpoint trust level ${trust}`);
  }
  assert.match(policy, /FELTUS_AI_SEND_HISTORY[\s\S]{0,100}false/);
  assert.match(policy, /FELTUS_AI_MAX_HISTORY_MESSAGES[\s\S]{0,130}maxHistoryMessages > 20/);
  assert.match(policy, /FELTUS_AI_ALLOWED_PRIVATE_HOSTS/);
  assert.match(policy, /FELTUS_AI_TRUSTED_HOSTS/);
  assert.match(history, /&conversation_id=eq\./);
  assert.match(history, /&app_id=eq\./);
  assert.match(history, /&owner_id=eq\./);
  assert.match(history, /slice\(0, maxMessages\)/);
  assert.match(prompt, /RECENT AUTHORIZED CONVERSATION/);
  assert.match(prompt, /RETRIEVED PROJECT\/DOCUMENT CONTEXT/);
  assert.match(compose, /FELTUS_AI_ENDPOINT_TRUST: \$\{FELTUS_AI_ENDPOINT_TRUST:-external_unverified\}/);
  assert.match(compose, /FELTUS_AI_SEND_HISTORY: \$\{FELTUS_AI_SEND_HISTORY:-false\}/);
});

check("request trace IDs and expensive-operation rate limits", () => {
  assert.match(server, /res\.setHeader\("X-Request-ID", requestTelemetryId\)/);
  assert.match(server, /p_request_id:[\s\S]{0,100}requestContext\.getStore\(\)\?\.requestId/);
  assert.match(server, /function consumeOperationRateLimit\(/);
  assert.match(server, /"ai-inference",\s*20,\s*60_000/);
  assert.match(server, /"document-upload",\s*20,\s*60 \* 60 \* 1000/);
  assert.match(server, /"document-processing",\s*30,\s*60 \* 60 \* 1000/);
  assert.match(server, /Retry-After/);
});

check("current API route inventory covers server handlers", () => {
  const apiRoutes = [...server.matchAll(/url\.pathname\s*===\s*["'](\/api\/[A-Za-z0-9/_-]+)["']/g)]
    .map(match => match[1]);
  assert.ok(apiRoutes.length > 0, "no API route handlers were found");
  for (const route of new Set(apiRoutes)) {
    assert.ok(apiInventory.includes(route), `API documentation is missing ${route}`);
  }
  assert.ok(
    /secure.*__Host-feltus_session.*cookie/i.test(apiInventory),
    "API documentation must describe the secure session cookie"
  );
  assert.ok(apiInventory.includes("AI data boundary"), "API documentation must describe the AI data boundary");
});

check("production Docker runtime and build-context exclusions", () => {
  assert.match(dockerfile, /^FROM node:22-alpine/m);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /CMD \["node", "src\/server\.js"\]/);
  for (const pattern of ["node_modules", "__pycache__", "*.py[cod]", ".env", ".env.*", ".feltus-dev-auth.json", ".feltus-storage", ".feltus-runtime", "**/*.bak", "**/*.backup*", "index.before-*.html", "**/*-backup", "**/*.pre-*"]) {
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
  const backupName = names.find(name => /(?:\.bak(?:$|\.)|\.backup(?:$|[-.])|-backup$|\.pre-[^/]*|(?:^|\/)index\.before-[^/]*\.html$)/i.test(name));
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

const smoke = spawnSync(
  process.execPath,
  ["scripts/production-smoke.mjs"],
  { cwd: root, encoding: "utf8", timeout: 30000 }
);
if (smoke.status === 0) {
  results.push({ name: "production handler liveness, session gate, and recovery throttling", status: "PASS" });
} else {
  results.push({
    name: "production handler liveness, session gate, and recovery throttling",
    status: "FAIL",
    message: smoke.stderr?.trim() || smoke.error?.message || "production handler smoke failed"
  });
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
process.stdout.write(`FELTUS PRODUCTION READINESS: ${failed ? "FAIL" : blocked ? "BLOCKED" : "PASS"}\n`);
process.exitCode = failed ? 1 : blocked ? 2 : 0;
