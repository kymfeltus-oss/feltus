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

const html = [
  fs.readFileSync(path.join(root, "index.html"), "utf8"),
  fs.readFileSync(path.join(root, "legacy-console.html"), "utf8")
].join("\n");
const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const compose = fs.readFileSync(path.join(root, "compose.production.yaml"), "utf8");
const stagingCompose = fs.readFileSync(path.join(root, "compose.staging.yaml"), "utf8");
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
const buildWorker = fs.readFileSync(path.join(root, "src/lib/feltus-build-worker.js"), "utf8");
const buildWorkerService = fs.readFileSync(path.join(root, "src/build-worker.js"), "utf8");
const buildWorkerDockerfile = fs.readFileSync(path.join(root, "services/build-worker/Dockerfile"), "utf8");
const buildWorkerMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20261104010000_feltus_build_worker_delivery.sql"),
  "utf8"
);
const aiConversationMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20261030100000_project_scoped_ai_conversations.sql"),
  "utf8"
);

const aiClient = fs.readFileSync(path.join(root, "src/lib/feltus-ai.js"), "utf8");
const aiProviders = fs.readFileSync(path.join(root, "src/lib/feltus-ai-providers.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "src/worker.js"), "utf8");
const infrastructureWorker = fs.readFileSync(path.join(root, "src/lib/feltus-infrastructure-worker.js"), "utf8");
const coolifyClient = fs.readFileSync(path.join(root, "src/lib/feltus-coolify.js"), "utf8");
const coreMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20261102000000_feltus_core_platform.sql"),
  "utf8"
);
const codeMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20261102010000_feltus_code.sql"),
  "utf8"
);
const codeServer = fs.readFileSync(path.join(root, "src/feltus-code/server/routes.mjs"), "utf8");
const codeAgent = fs.readFileSync(path.join(root, "src/feltus-code/server/agent.mjs"), "utf8");
const codeAgentWorkflow = fs.readFileSync(path.join(root, "src/feltus-code/server/agent-workflow.mjs"), "utf8");
const codeTaskRunner = fs.readFileSync(path.join(root, "src/feltus-code/server/task-runner.mjs"), "utf8");
const codeGateway = fs.readFileSync(path.join(root, "src/feltus-code/server/ai-gateway.mjs"), "utf8");
const codeGitTools = fs.readFileSync(path.join(root, "src/feltus-code/server/git-tools.mjs"), "utf8");
const codeSecurity = fs.readFileSync(path.join(root, "src/feltus-code/server/security.mjs"), "utf8");
const codePackageScripts = packageJson.scripts;

check("FELTUS CODE is mounted behind FELTUS auth and project scope", () => {
  assert.equal(codePackageScripts["test:code"], "node src/feltus-code/tests/smoke.mjs");
  assert.match(productionWorkflow, /npm run test:code/);
  assert.match(html, /id="feltusCodeNav"[^>]*>CODE/);
  assert.match(html, /id="feltusCodeFrame"/);
  assert.match(server, /authorizedCodeProject\(appId, permission\)/);
  assert.match(server, /const repoRoot = codeRepositoryRoot\(app\.id\)/);
  assert.match(server, /return path\.join\(CODE_WORKSPACE_ROOT, appId\)/);
  assert.match(server, /consumeOperationRateLimit\(req, "feltus-code"/);
  assert.match(server, /FELTUS_CODE_WORKSPACE_ROOT/);
  assert.match(compose, /feltus_code_workspaces:\/data\/feltus-code/);
  assert.match(dockerfile, /\/data\/feltus-code/);
  assert.match(codeMigration, /feltus_code_sessions/);
  assert.match(codeMigration, /feltus_code_actions/);
  assert.match(codeMigration, /feltus_code_checkpoints/);
  assert.match(codeMigration, /feltus_can_access_app\(app_id, 'read'\)/);
  assert.match(codeMigration, /feltus_can_access_app\(app_id, 'write'\)/);
  assert.match(codeMigration, /REVOKE ALL ON public\.feltus_code_sessions, public\.feltus_code_actions, public\.feltus_code_checkpoints FROM anon/);
  assert.match(codeMigration, /CREATE UNIQUE INDEX IF NOT EXISTS feltus_code_sessions_one_active_project_idx/);
  assert.match(codeServer, /absolute repo path from the browser/);
  assert.match(codeGitTools, /rev-parse", "--show-toplevel/);
  assert.match(codeGitTools, /gitEntry\.isSymbolicLink\(\)/);
  assert.match(codeGitTools, /GIT_CONFIG_NOSYSTEM/);
  assert.match(fs.readFileSync(path.join(root, "src/feltus-code/server/task-runner.mjs"), "utf8"), /isolatedGitEnvironment/);
  assert.match(codeSecurity, /part === "\.\."/);
  assert.match(codeSecurity, /isSymbolicLink\(\)/);
  assert.match(server, /installed\.some\(model => model\.name === requestedModel\)/);
  assert.match(fs.readFileSync(path.join(root, "src/feltus-code/web/feltus-code.js"), "utf8"), /api\/ai\/runtime\/health/);
  assert.match(fs.readFileSync(path.join(root, "src/feltus-code/web/index.html"), "utf8"), /id="ai-runtime-status"/);
  assert.match(server, /const app = await authorizedCodeProject\(appId, permission\)/);
  assert.match(codeMigration, /CREATE POLICY feltus_code_sessions_read[\s\S]*feltus_can_access_app\(app_id, 'read'\)/);
  assert.match(codeMigration, /CREATE POLICY feltus_code_actions_insert[\s\S]*actor_id = auth\.uid\(\)/);
  assert.match(codeMigration, /GRANT UPDATE \(updated_at, model\) ON public\.feltus_code_sessions TO authenticated/);
  assert.match(codeMigration, /feltus_code/);
  assert.doesNotMatch(codeAgent, /conversation|history/i, "FELTUS CODE must not append stored conversation history");
});

check("FELTUS CODE streams plans and cancels stale requests", () => {
  assert.match(codeAgent, /completeStream/);
  assert.match(codeGateway, /generateStream/);
  assert.match(codeServer, /onToken/);
  assert.match(server, /\/api\/code\/ai\/plan\/stream/);
  assert.match(server, /requestSignal\.aborted/);
  assert.match(server, /X-Accel-Buffering": "no"/);
  assert.match(server, /signal: requestSignal/);
  assert.match(fs.readFileSync(path.join(root, "src/feltus-code/web/feltus-code.js"), "utf8"), /response\.body\.getReader\(\)/);
  assert.match(fs.readFileSync(path.join(root, "src/feltus-code/server/task-runner.mjs"), "utf8"), /signal \? \{ signal \} : \{\}/);
  const projectSwitch = html.match(/function selectActiveProject\(project\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(projectSwitch, /codeFrame\.src = "\/api\/code\/ui\?app_id="/);
});

check("FELTUS CODE AI grounds every action in server-read selected files", () => {
  const codeWeb = fs.readFileSync(path.join(root, "src/feltus-code/web/feltus-code.js"), "utf8");
  assert.match(codeAgent, /fileTools\.inspect\(relativePath, \{ forAI: true \}\)/);
  assert.match(codeAgent, /Server-read selected file context/);
  assert.match(codeAgent, /required: true, max: 12/);
  assert.match(codeServer, /aiPlan: async \(\{ prompt, paths, model \}/);
  assert.match(server, /handlers\.aiPlan\(\{ prompt, paths: selectedPaths, model: requestedModel \}/);
  assert.match(codeAgentWorkflow, /handlers\.aiPlan\(\{ prompt, paths, model \}/);
  assert.match(codeAgentWorkflow, /handlers\.aiEdit\(\{ prompt, paths, model \}/);
  assert.match(server, /code: "FILE_CONTEXT_REQUIRED"/);
  assert.match(codeWeb, /paths: requestPaths/);
  assert.match(codeWeb, /state\.files\.get\(state\.activePath\)\?\.dirty/);
  assert.match(codeWeb, /mode: mode\.toLowerCase\(\)/);
  assert.match(codeWeb, /Select a project file before using/);
});

check("FELTUS CODE Agent validates a temporary proposal before one-time application", () => {
  assert.match(server, /runValidatedAgent\(\{/);
  assert.ok(codeAgentWorkflow.indexOf("await handlers.validateTask") < codeAgentWorkflow.indexOf("await handlers.applyEdit"));
  assert.match(codeAgentWorkflow, /if \(!value\.validationPassed\) return/);
  assert.match(codeTaskRunner, /runAgainstProposed/);
  assert.match(codeServer, /validateTask: async \(\{ task, files \}.*tasks\.runAgainstProposed/s);
  assert.match(codeTaskRunner, /package\.json is missing; npm validation tasks are unavailable/);
  assert.match(codeTaskRunner, /"git-status"\s*\|\|\s*taskName === "git-diff"/);
  const codeWeb = fs.readFileSync(path.join(root, "src/feltus-code/web/feltus-code.js"), "utf8");
  assert.match(codeWeb, /state\.proposal = null;\s*\$\("proposal"\)\.replaceChildren\(\);\s*\$\("apply-edit"\)\.hidden = true/);
  assert.match(codeWeb, /renderProposal\(agentResult\.proposal, \{ allowApply: false \}\)/);
  assert.match(codeWeb, /option\.disabled = true/);
  assert.match(codeWeb, /window\.confirm\("Allow FELTUS CODE Agent to edit/);
});

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
  assert.equal(packageJson.scripts["test:core"], "node scripts/core-platform-tests.mjs");
});

check("self-hosted core platform services are additive and secured", () => {
  for (const table of [
    "feltus_project_memberships", "feltus_ai_runtimes", "feltus_ai_models",
    "feltus_jobs", "feltus_worker_heartbeats", "feltus_tool_executions",
    "feltus_knowledge_bases", "feltus_knowledge_chunks", "feltus_usage_records",
    "feltus_project_secrets", "feltus_deployments"
  ]) {
    assert.match(coreMigration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
  }
  assert.match(coreMigration, /feltus_claim_jobs/);
  assert.match(coreMigration, /FOR UPDATE SKIP LOCKED/);
  assert.match(coreMigration, /feltus_recover_stale_jobs/);
  assert.match(coreMigration, /feltus_knowledge_chunks TO service_role/);
  assert.match(coreMigration, /pgp_sym_encrypt/);
  assert.match(coreMigration, /REVOKE ALL ON public\.feltus_project_secrets FROM anon, authenticated/);
  assert.match(coreMigration, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.%I/);
  assert.match(coreMigration, /'feltus_ai_messages','feltus_jobs'/);
  assert.match(coreMigration, /app_member_read_policy/);
  assert.match(server, /FELTUS_SERVICE_ROLE_KEY is required for internal platform operations in production/);
  assert.match(server, /FELTUS_SERVICE_ROLE_KEY must be a service_role JWT in production/);
  assert.match(server, /FELTUS_SECRET_ENCRYPTION_KEY must contain at least 32 characters in production/);
});

check("provider-neutral AI and durable worker are wired for production", () => {
  assert.match(aiProviders, /class OpenAICompatibleAI/);
  assert.match(aiProviders, /openai_compatible/);
  assert.match(aiProviders, /vllm/);
  assert.match(aiProviders, /llama_cpp/);
  assert.match(aiProviders, /stream_options: \{ include_usage: true \}/);
  assert.match(worker, /resolveAIEndpointPolicy/);
  assert.match(worker, /feltus_claim_jobs/);
  assert.match(worker, /feltus_recover_stale_jobs/);
  assert.match(worker, /cancellation_requested/);
  assert.match(worker, /generateWithCancellation/);
  assert.match(compose, /^  worker:/m);
  assert.match(compose, /command: \["node", "src\/worker\.js"\]/);
  assert.match(compose, /FELTUS_SECRET_ENCRYPTION_KEY/);
});

check("infrastructure outbox uses fenced leases and a server-only Coolify adapter", () => {
  assert.match(worker, /FELTUS_COOLIFY_API_TOKEN/);
  assert.match(worker, /FELTUS_COOLIFY_ALLOWED_ENVIRONMENTS/);
  assert.match(worker, /FELTUS_COOLIFY_RESOURCE_MAP/);
  assert.match(infrastructureWorker, /feltus_claim_infrastructure_outbox/);
  assert.match(infrastructureWorker, /feltus_heartbeat_infrastructure_outbox/);
  assert.match(infrastructureWorker, /feltus_complete_infrastructure_outbox/);
  assert.match(infrastructureWorker, /feltus_retry_infrastructure_outbox/);
  assert.match(infrastructureWorker, /lease_token/);
  assert.match(infrastructureWorker, /verification_status !== "passed"/);
  assert.match(infrastructureWorker, /PRODUCTION_TEARDOWN_BLOCKED/);
  assert.match(infrastructureWorker, /COOLIFY_TARGET_NOT_MAPPED/);
  assert.match(infrastructureWorker, /HEALTHCHECK_ADDRESS_NOT_PUBLIC/);
  assert.match(server, /infrastructure_outbox: heartbeat\?\.metadata/);
  assert.match(coolifyClient, /Authorization: `Bearer \$\{apiToken\}`/);
  assert.match(coolifyClient, /redirect: "manual"/);
  assert.match(infrastructureWorker, /docker_registry_image_tag/);
  assert.match(compose, /FELTUS_COOLIFY_API_TOKEN/);
  const appEnvironment = compose.match(/^  app:[\s\S]*?(?=^  worker:)/m)?.[0] || "";
  assert.doesNotMatch(appEnvironment, /FELTUS_COOLIFY_API_TOKEN|FELTUS_COOLIFY_RESOURCE_MAP/);
});

check("application builds use a separate mTLS BuildKit worker and immutable verified digests", () => {
  assert.match(compose, /^  build-worker:/m);
  assert.match(compose, /profiles: \["build"\]/);
  const workerService = compose.split(/^  build-worker:\r?$/m)[1]?.split(/^  [a-z][a-z0-9-]*:\r?$/m)[0] || "";
  assert.doesNotMatch(workerService, /docker\.sock|privileged:\s*true/);
  assert.match(workerService, /FELTUS_BUILDKIT_CLIENT_KEY_PEM/);
  assert.match(buildWorkerDockerfile, /moby\/buildkit:.*rootless/);
  assert.match(buildWorkerDockerfile, /COPY --from=buildkit \/usr\/bin\/buildctl/);
  assert.match(buildWorkerService, /createBuildWorker/);
  assert.match(buildWorker, /resolveGithubOAuthAccessToken/);
  assert.doesNotMatch(buildWorker, /decryptGithubSecret/);
  assert.match(buildWorker, /feltus_claim_builds/);
  assert.match(buildWorker, /feltus_heartbeat_build/);
  assert.match(buildWorker, /GIT_CONFIG_VALUE_0/);
  assert.match(buildWorker, /--tlscacert/);
  assert.match(buildWorker, /--tlscert/);
  assert.match(buildWorker, /--tlskey/);
  assert.match(buildWorker, /feltus_finish_application_build/);
  assert.match(buildWorker, /docker-content-digest/);
  assert.match(buildWorker, /redactBuildLog/);
  assert.match(buildWorkerMigration, /feltus_build_exit_code_check/);
  assert.match(buildWorkerMigration, /build\.queued/);
  assert.match(buildWorkerMigration, /deployment\.started/);
  assert.match(buildWorkerMigration, /state\.reconciled/);
  assert.match(buildWorker, /BUILD_TIMEOUT/);
  assert.match(buildWorker, /BUILD_CANCELLED/);
  assert.doesNotMatch(buildWorker, /docker\.sock/);
});

check("Staging mounts BuildKit mTLS credentials as files without changing Production Compose", () => {
  const productionServices = [...compose.matchAll(/^  ([a-z][a-z0-9-]*):\r?$/gm)];
  const stagingServices = [...stagingCompose.matchAll(/^  ([a-z][a-z0-9-]*):\r?$/gm)];
  assert.deepEqual(stagingServices.map(match => match[1]), productionServices.map(match => match[1]));
  for (let index = 0; index < productionServices.length; index += 1) {
    const name = productionServices[index][1];
    if (name === "build-worker") continue;
    const end = productionServices[index + 1]?.index ?? compose.indexOf("\nvolumes:");
    const stagingEnd = stagingServices[index + 1]?.index ?? stagingCompose.indexOf("\nvolumes:");
    assert.equal(stagingCompose.slice(stagingServices[index].index, stagingEnd), compose.slice(productionServices[index].index, end), `${name} remains unchanged in Staging`);
  }
  const productionWorker = compose.split(/^  build-worker:\r?$/m)[1]?.split(/^  [a-z][a-z0-9-]*:\r?$/m)[0] || "";
  const stagingWorker = stagingCompose.split(/^  build-worker:\r?$/m)[1]?.split(/^  [a-z][a-z0-9-]*:\r?$/m)[0] || "";
  assert.match(productionWorker, /FELTUS_BUILDKIT_CLIENT_KEY_PEM/);
  assert.doesNotMatch(productionWorker, /FELTUS_GITHUB_CLIENT_(?:ID|SECRET)/);
  assert.match(stagingWorker, /FELTUS_GITHUB_CLIENT_ID: \$\{FELTUS_GITHUB_CLIENT_ID:-\}/);
  assert.match(stagingWorker, /FELTUS_GITHUB_CLIENT_SECRET: \$\{FELTUS_GITHUB_CLIENT_SECRET:-\}/);
  assert.doesNotMatch(stagingWorker, /FELTUS_BUILDKIT_(?:CA|CLIENT_CERT|CLIENT_KEY)_PEM/);
  assert.match(stagingWorker, /FELTUS_BUILDKIT_CA_FILE: \/run\/secrets\/feltus_buildkit_ca/);
  assert.match(stagingWorker, /FELTUS_BUILDKIT_CLIENT_CERT_FILE: \/run\/secrets\/feltus_buildkit_client_cert/);
  assert.match(stagingWorker, /FELTUS_BUILDKIT_CLIENT_KEY_FILE: \/run\/secrets\/feltus_buildkit_client_key/);
  assert.match(stagingWorker, /secrets:\s*\r?\n\s+- feltus_buildkit_ca/);
  assert.match(stagingCompose, /file: \/etc\/feltus\/staging\/buildkit\/current\/ca\.pem/);
  assert.match(stagingCompose, /file: \/etc\/feltus\/staging\/buildkit\/current\/client-cert\.pem/);
  assert.match(stagingCompose, /file: \/etc\/feltus\/staging\/buildkit\/current\/client-key\.pem/);
});

check("first-class chat controls remain project-scoped", () => {
  for (const id of [
    "newAIConversationButton", "archiveAIConversationButton", "exportAIConversationButton",
    "stopAIButton", "aiConversationSearch", "aiSystemPromptInput",
    "aiTemperatureInput", "aiMaxTokensInput", "saveAIConversationSettingsButton"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /\/api\/ai\/conversations/);
  assert.match(html, /function renderAIContent/);
  assert.match(html, /function refreshAIConversations/);
  assert.match(server, /\/api\/ai\/runtime\/health/);
  assert.match(server, /\/api\/ai\/embeddings/);
  assert.match(server, /\/api\/tools\/execute/);
  assert.match(server, /\/api\/secrets/);
  assert.match(server, /\/api\/knowledge-bases/);
  assert.match(server, /\/api\/usage/);
});

check("CI runs production checks on every branch update", () => {
  assert.match(productionWorkflow, /^on:\s*\r?\n\s+push:\s*\r?\n\s+pull_request:/m);
  assert.match(productionWorkflow, /node-version: 22/);
  assert.match(productionWorkflow, /npm run regression/);
  assert.match(productionWorkflow, /npm run test:infrastructure-worker/);
  assert.match(productionWorkflow, /python -m unittest discover/);
  assert.match(productionWorkflow, /docker compose .* build app evidence-extractor/);
  assert.match(productionWorkflow, /compose\.staging\.yaml config --quiet/);
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

check("only FELTUS CODE UI allows same-origin framing", () => {
  const override = server.match(/if \(String\(req\.method \|\| "GET"\)\.toUpperCase\(\) === "GET" && url\.pathname === "\/api\/code\/ui"\) \{[\s\S]*?\n        \}/)?.[0] || "";
  assert.match(server, /res\.setHeader\("X-Frame-Options", "DENY"\)/);
  assert.match(server, /frame-ancestors 'none'/);
  assert.match(override, /X-Frame-Options", "SAMEORIGIN"/);
  assert.match(override, /frame-ancestors 'self'/);
  assert.match(override, /url\.pathname === "\/api\/code\/ui"/);
  const smoke = fs.readFileSync(path.join(root, "scripts/production-smoke.mjs"), "utf8");
  assert.match(smoke, /health\.headers\["x-frame-options"\], "DENY"/);
  assert.match(smoke, /protectedCodeUI\.headers\["x-frame-options"\], "SAMEORIGIN"/);
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
  assert.match(html, /"\/api\/ai\/conversations"/);
  assert.match(html, /"\/api\/ai\/messages\?app_id="/);
  assert.match(html, /conversation_id:\s*activeAIConversationId/);
  assert.match(server, /loadAuthorizedAIHistory\(/);
  assert.match(server, /historyLimit:\s*policy\.sendHistory\s*&&\s*contextPermissions\.conversation_history === true\s*\?/);
  assert.match(server, /contextPermissions\.documents === true \|\| allowedDocumentIds\.length > 0/);
  assert.match(server, /contextPermissions\.app_data === true \|\| selectedModelIds\.has\(item\.id\)/);
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
  assert.match(dockerfile, /^RUN apk add --no-cache git$/m);
  assert.match(dockerfile, /^RUN git --version$/m);
  assert.match(compose, /^  app:[\s\S]{0,150}dockerfile: Dockerfile/m);
  assert.match(compose, /^  worker:[\s\S]{0,150}dockerfile: Dockerfile/m);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /CMD \["node", "src\/server\.js"\]/);
  for (const pattern of ["node_modules", "__pycache__", "*.py[cod]", ".env", ".env.*", ".feltus-dev-auth.json", ".feltus-storage", ".feltus-runtime", "src/feltus-code/dev-server.mjs", "src/feltus-code/package.json", "src/feltus-code/migrations/", "**/*.bak", "**/*.backup*", "index.before-*.html", "**/*-backup", "**/*.pre-*"]) {
    assert.ok(dockerignore.split(/\r?\n/).includes(pattern), `Docker build context does not exclude ${pattern}`);
  }
});

check("timestamped database, file and configuration backups", () => {
  assert.match(backupScript, /date -u/);
  assert.match(backupScript, /deployment\.env/);
  assert.match(backupScript, /pg_dump/);
  assert.match(backupScript, /pg_restore --list/);
  assert.match(storageBackupScript, /tar -tzf/);
  assert.match(storageBackupScript, /for entry in documents object-storage code-workspaces/);
  assert.match(storageRestoreScript, /tar -xzf/);
  assert.match(storageRestoreScript, /for entry in documents object-storage code-workspaces/);
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
  results.push({ name: "production handler liveness, session gate, FELTUS CODE access, and recovery throttling", status: "PASS" });
} else {
  results.push({
    name: "production handler liveness, session gate, FELTUS CODE access, and recovery throttling",
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
