import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { studioCapabilities } from "../src/feltus-code/server/studio-capabilities.mjs";
import { applyChangeSet, resolveChangeSetSelection, reviewChangeSet, undoChangeSet } from "../src/feltus-code/server/change-set.mjs";
import { createFileTools } from "../src/feltus-code/server/file-tools.mjs";
import { createTaskRunner } from "../src/feltus-code/server/task-runner.mjs";
import { buildStudioContext } from "../src/feltus-code/server/studio-context.mjs";
import { createCodeAgent } from "../src/feltus-code/server/agent.mjs";
import { createFeltusCodeAIGateway } from "../src/feltus-code/server/ai-gateway.mjs";
import { runStudioAgent } from "../src/feltus-code/server/studio-workflow.mjs";
import { createPreviewManager } from "../src/feltus-code/server/preview-manager.mjs";
import { createDockerPreviewLauncher } from "../src/feltus-code/server/docker-preview-runner.mjs";
import { createFeltusCodeHandlers } from "../src/feltus-code/server/routes.mjs";
import { createApplicationStateHandler } from "../src/lib/feltus-application-state-api.js";
import { FeltusAI } from "../src/lib/feltus-ai.js";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const webSource = readFileSync(path.join(root, "src/feltus-code/web/feltus-code.js"), "utf8");
const webHtml = readFileSync(path.join(root, "src/feltus-code/web/index.html"), "utf8");
const webCss = readFileSync(path.join(root, "src/feltus-code/web/feltus-code.css"), "utf8");
const serverSource = readFileSync(path.join(root, "src/server.js"), "utf8");
const infrastructureSource = readFileSync(path.join(root, "src/lib/feltus-infrastructure-worker.js"), "utf8");

const owner = studioCapabilities({ role: "owner" });
const admin = studioCapabilities({ role: "admin" });
const member = studioCapabilities({ role: "member", permissions: ["read", "write", "builds.trigger"] });
const orgMember = studioCapabilities({ role: "org_member" });
const operator = studioCapabilities({ role: "member", permissions: ["read", "write", "deployments.create"] });
const viewer = studioCapabilities({ role: "viewer", permissions: ["read"] });
assert.equal(owner.canPublishProduction, true);
assert.equal(admin.canManageSchema, true);
assert.equal(member.canEditCode, true);
assert.equal(member.canRunAgent, true);
assert.equal(orgMember.canViewCode, true);
assert.equal(orgMember.canEditCode, false, "organization membership alone must not grant project write access");
assert.equal(operator.canDeployTesting, true);
assert.equal(viewer.canViewCode, true);
assert.equal(viewer.canEditCode, false);
assert.equal(viewer.canUseTerminal, false);
assert.equal(viewer.canApplyAIChanges, false);
console.log("PASS Build Studio Owner, Admin, Member, and Viewer capability enforcement");

const tempParent = await fs.realpath(process.env.FELTUS_TEST_TMPDIR || os.tmpdir());
const tempRootPrefix = ".feltus-build-studio-tests-";
const tempRoot = await fs.mkdtemp(path.join(tempParent, tempRootPrefix));
const validationTempRoot = path.join(tempRoot, "validation-workspaces");
process.on("exit", () => {
  if (path.dirname(tempRoot) === tempParent && path.basename(tempRoot).startsWith(tempRootPrefix)) {
    try { rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  }
});
const project = path.join(tempRoot, "project-a");
const otherProject = path.join(tempRoot, "project-b");
await fs.mkdir(project, { recursive: true });
await fs.mkdir(otherProject, { recursive: true });
await fs.writeFile(path.join(project, "app.js"), "export const value = 1;\n");
await fs.writeFile(path.join(project, "rename.js"), "export const renameMe = true;\n");
await fs.writeFile(path.join(project, "delete.js"), "temporary\n");
await fs.writeFile(path.join(project, ".env"), "SECRET=do-not-read\n");
await fs.writeFile(path.join(otherProject, "private.js"), "other project\n");

function git(args) {
  const result = spawnSync("git", args, { cwd: project, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}
git(["init", "--initial-branch=main"]);
git(["config", "user.name", "Build Studio Test"]);
git(["config", "user.email", "studio@localhost"]);
git(["add", "app.js", "rename.js", "delete.js"]);
git(["commit", "-m", "baseline"]);

const localWorkspace = path.join(tempRoot, "local-code-workspace");
await fs.mkdir(localWorkspace, { recursive: true });
await fs.writeFile(path.join(localWorkspace, "index.html"), "<h1>Local Build Studio</h1>\n");
const localGit = args => {
  const result = spawnSync("git", ["-C", localWorkspace, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
};
localGit(["init", "--initial-branch=main"]);
localGit(["config", "user.name", "Build Studio Local Fixture"]);
localGit(["config", "user.email", "studio-local@localhost"]);
localGit(["add", "index.html"]);
localGit(["commit", "-m", "Initialize local CODE fixture"]);

const localCode = createFeltusCodeHandlers({ repoRoot: localWorkspace });
const localGitStatus = await localCode.gitStatus();
const localGitHistory = await localCode.gitLog({ limit: 100 });
assert.match(localGitStatus.stdout, /^## main\s*$/m);
assert.match(localGitHistory.stdout, /Initialize local CODE fixture/);

const emptyWorkspace = path.join(tempRoot, "empty-new-app-workspace");
await fs.mkdir(emptyWorkspace, { recursive: true });
const emptyCode = createFeltusCodeHandlers({ repoRoot: emptyWorkspace });
const emptyInitialized = await emptyCode.gitInitialize();
const emptyInitializedAgain = await emptyCode.gitInitialize();
assert.equal(emptyInitialized.initialized, true, "a new private workspace initializes through existing FELTUS CODE Git tooling");
assert.equal(emptyInitialized.branch, "main");
assert.equal(emptyInitializedAgain.initialized, false, "repeated initialization reuses the same existing workspace");
assert.equal((await emptyCode.gitStatus()).stdout.trim(), "## No commits yet on main", "an empty initialized workspace is valid local Git state");
assert.deepEqual((await emptyCode.listTree({ path: "." })).items, [], "a new workspace starts with an empty project tree");
const genericWorkspace = path.join(tempRoot, "generic-ai-workspace");
await fs.mkdir(genericWorkspace, { recursive: true });
await createFeltusCodeHandlers({ repoRoot: genericWorkspace }).gitInitialize();
const genericApp = { id: randomUUID(), app_name: "Generic Test App", app_type: "web_application" };
const genericFiles = createFileTools({ repoRoot: genericWorkspace });
const genericContext = await buildStudioContext({
  repoRoot: genericWorkspace,
  app: genericApp,
  capabilities: owner,
  prompt: "Create the initial responsive application structure"
});
const structuredRequests = [];
const focusedRequests = [];
let genericCompletion = 0;
const genericAgent = createCodeAgent({
  repoRoot: genericWorkspace,
  fileTools: genericFiles,
  aiGateway: {
    async complete(options) {
      structuredRequests.push(options.responseFormat);
      genericCompletion += 1;
      if (genericCompletion === 1) return { content: JSON.stringify({
        title: "Initial application", summary: "Create a small supported web application", significant: true,
        steps: [{ id: "structure", title: "Create the application structure", agent: "project-agent", status: "planned", details: "Add source, validation, and preview configuration" }],
        pages: ["Home"], components: [], data_models: [], relationships: [], roles: [], permissions: [], apis: [], workflows: [],
        files: [
          { path: "package.json", description: "Define supported validation and preview tasks" },
          { path: "src/app.js", description: "Provide the initial application behavior" }
        ], tests: ["npm run check"], deployment_considerations: []
      }) };
      const userMessage = options.messages.find(message => message.role === "user")?.content || "";
      const target = userMessage.match(/(?:Target file|Required target path): ([^\n]+)/)?.[1];
      const refinement = options.messages.some(message => /refinement pass/i.test(message.content));
      focusedRequests.push({ target, refinement, userMessage });
      const content = target === "package.json"
        ? JSON.stringify({ scripts: { check: "node --check src/app.js", dev: "vite" } }, null, 2) + "\n"
        : "export const applicationReady = true;\n";
      return { content: JSON.stringify({
        summary: `${refinement ? "Refine" : "Generate"} ${target}`,
        operations: [{
          id: target === "package.json" ? "manifest" : "source",
          type: "create",
          path: refinement ? `./${target}` : target,
          content,
          reason: "Implement the focused planned file",
          agent: "code-agent"
        }]
      }) };
    }
  }
});
const genericPlan = await genericAgent.architectPlan({ prompt: "Create the initial responsive application structure", context: genericContext });
assert.deepEqual((await createFeltusCodeHandlers({ repoRoot: genericWorkspace }).listTree({ path: "." })).items, [], "plan-only work does not modify an empty workspace");
const genericProposal = await genericAgent.proposeChangeSet({ prompt: "Implement the approved plan", context: genericContext, plan: genericPlan });
assert.ok(genericProposal.operations.every(operation => operation.type === "create"), "an empty workspace can receive reviewable create operations without a seeded manifest");
assert.deepEqual(focusedRequests.map(request => [request.target, request.refinement]), [
  ["package.json", false],
  ["src/app.js", false]
], "clean planned files receive one focused generation without an unnecessary refinement pass");
assert.deepEqual(genericProposal.operations.map(operation => operation.path), ["package.json", "src/app.js"], "harmless ./ prefixes normalize without changing the planned target");
const genericReview = await reviewChangeSet({ repoRoot: genericWorkspace, changeSet: genericProposal });
assert.equal(genericReview.operations.length, 2, "the initial generated files remain reviewable before application");
await applyChangeSet({ repoRoot: genericWorkspace, changeSet: genericReview });
assert.equal(await genericFiles.read("src/app.js"), "export const applicationReady = true;\n");
const generatedTasks = createTaskRunner({ repoRoot: genericWorkspace });
assert.ok(generatedTasks.list().includes("npm-check"), "validation tasks are detected after the generated manifest is applied");
assert.equal((await generatedTasks.run("npm-check")).code, 0, "the dynamically detected validation runs against generated source");

const iterativeContext = await buildStudioContext({
  repoRoot: genericWorkspace,
  app: genericApp,
  capabilities: owner,
  prompt: "Update the existing application",
  selectedPaths: ["src/app.js"]
});
const iterativeAgent = createCodeAgent({
  repoRoot: genericWorkspace,
  fileTools: genericFiles,
  aiGateway: { async complete(options) {
    structuredRequests.push(options.responseFormat);
    return { content: JSON.stringify({
      summary: "Update existing source",
      operations: [{ id: "source-update", type: "update", path: "src/app.js", before_sha256: iterativeContext.editor.selected_files[0].sha256, content: "export const applicationReady = 'updated';\n", reason: "Apply the follow-up instruction", agent: "code-agent" }]
    }) };
  } }
});
const iterativeProposal = await iterativeAgent.proposeChangeSet({ prompt: "Update the existing application", context: iterativeContext, plan: genericPlan, mode: "edit" });
await applyChangeSet({ repoRoot: genericWorkspace, changeSet: await reviewChangeSet({ repoRoot: genericWorkspace, changeSet: iterativeProposal }) });
assert.equal(await genericFiles.read("src/app.js"), "export const applicationReady = 'updated';\n", "later prompts update authoritative existing source");
assert.match(await genericFiles.read("package.json"), /"check"/, "iterative work preserves unrelated generated files");
assert.equal(structuredRequests[0], "json");
assert.ok(structuredRequests.slice(1).every(format => format?.name === "feltus_code_change_set"));
assert.deepEqual(structuredRequests[1].schema.properties.operations.items.properties.type.enum, ["create", "update", "rename", "delete"], "the provider schema constrains change operations to the existing safe contract");

let malformedCalls = 0;
const malformedAgent = createCodeAgent({
  repoRoot: emptyWorkspace,
  fileTools: createFileTools({ repoRoot: emptyWorkspace }),
  aiGateway: { async complete() {
    malformedCalls += 1;
    if (malformedCalls === 1) return { content: "{not-json" };
    return { content: JSON.stringify({
      summary: "Focused source",
      operations: [{ id: "valid", type: "create", path: malformedCalls === 3 ? "./src/valid.js" : "src/valid.js", content: "export default true;\n", reason: "Complete source", agent: "code-agent" }]
    }) };
  } }
});
const malformedRecovered = await malformedAgent.proposeChangeSet({
  prompt: "Create a valid module",
  context: { editor: { selected_files: [], related_files: [] } },
  plan: { title: "Valid module", summary: "Create one module", steps: [], files: ["src/valid.js"] }
});
assert.equal(malformedCalls, 3, "malformed generation receives one correction before the required refinement");
assert.equal(malformedRecovered.operations[0].content, "export default true;\n", "short complete source is accepted without a length threshold");

let placeholderRefinementCalls = 0;
const placeholderRefinementAgent = createCodeAgent({
  repoRoot: emptyWorkspace,
  fileTools: createFileTools({ repoRoot: emptyWorkspace }),
  aiGateway: { async complete() {
    placeholderRefinementCalls += 1;

    const content = placeholderRefinementCalls === 3
      ? "/* Responsive styles for desktop, tablet, and mobile devices */\n"
      : "body { margin: 0; color: #222; }\n@media (max-width: 40rem) { body { font-size: 0.95rem; } }\n";

    const path = placeholderRefinementCalls === 1
      ? "wrong-styles.css"
      : "styles.css";

    return { content: JSON.stringify({
      summary: "Focused stylesheet",
      operations: [{ id: "styles", type: "create", path, content, reason: "Complete responsive styles", agent: "code-agent" }]
    }) };
  } }
});
const placeholderRefined = await placeholderRefinementAgent.proposeChangeSet({
  prompt: "Create a responsive stylesheet",
  context: { editor: { selected_files: [], related_files: [] } },
  plan: { title: "Responsive styles", summary: "Create styles", steps: [], files: [{ path: "styles.css", type: "css" }] }
});
assert.equal(placeholderRefinementCalls, 4, "a recovered generation triggers refinement and a comment-only refinement receives one corrective retry");
assert.match(placeholderRefined.operations[0].content, /@media/, "the corrected refinement contains actual responsive implementation");

let invalidTargetCalls = 0;
const invalidTargetAgent = createCodeAgent({
  repoRoot: emptyWorkspace,
  fileTools: createFileTools({ repoRoot: emptyWorkspace }),
  aiGateway: { async complete() {
    invalidTargetCalls += 1;
    return { content: JSON.stringify({
      summary: "Invalid focused response",
      operations: [{
        id: "invalid",
        type: invalidTargetCalls === 1 ? "create" : "update",
        path: invalidTargetCalls === 1 ? "src/unrelated.js" : "src/required.js",
        content: "export default true;\n",
        reason: "Invalid fixture",
        agent: "code-agent"
      }]
    }) };
  } }
});
await assert.rejects(
  () => invalidTargetAgent.proposeChangeSet({
    prompt: "Create the required module",
    context: { editor: { selected_files: [], related_files: [] } },
    plan: { title: "Required module", summary: "Create one module", steps: [], files: ["src/required.js"] }
  }),
  error => error.code === "AI_CHANGE_SET_INVALID_RESPONSE"
);
assert.equal(invalidTargetCalls, 2, "a wrong path followed by a wrong operation type fails after exactly one corrective retry");

let combinedRetryCalls = 0;
const combinedRetryAgent = createCodeAgent({
  repoRoot: genericWorkspace,
  fileTools: genericFiles,
  aiGateway: { async complete() {
    combinedRetryCalls += 1;
    return { content: JSON.stringify({
      summary: "Combined planned create",
      operations: [{
        id: "landing",
        type: "create",
        path: combinedRetryCalls === 1 ? "src/unplanned.html" : "./landing.html",
        content: "<!doctype html><html lang=\"en\"><title>Complete page</title><body><main><h1>Complete page</h1></main></body></html>\n",
        reason: "Create the planned page",
        agent: "code-agent"
      }]
    }) };
  } }
});
const combinedRecovered = await combinedRetryAgent.proposeChangeSet({
  prompt: "Create the planned page",
  context: iterativeContext,
  plan: { title: "Landing page", summary: "Create the page", steps: [], files: [{ path: "landing.html", type: "html" }] },
  mode: "build"
});
assert.equal(combinedRetryCalls, 2, "the combined existing-project path corrects an unplanned path at most once");
assert.equal(combinedRecovered.operations[0].path, "landing.html", "the combined path preserves the exact planned target after harmless prefix normalization");

let placeholderCalls = 0;
const placeholderAgent = createCodeAgent({
  repoRoot: genericWorkspace,
  fileTools: genericFiles,
  aiGateway: { async complete() {
    placeholderCalls += 1;
    return { content: JSON.stringify({
      summary: "Stub update",
      operations: [{ id: "stub", type: "update", path: "src/app.js", before_sha256: iterativeProposal.operations[0].before_sha256, content: "export function render() { throw new Error('Not implemented'); }\n", reason: "Stub fixture", agent: "code-agent" }]
    }) };
  } }
});
await assert.rejects(
  () => placeholderAgent.proposeChangeSet({ prompt: "Update the source", context: iterativeContext, plan: genericPlan, mode: "edit" }),
  error => error.code === "AI_CHANGE_SET_PLACEHOLDER_RESPONSE"
);
assert.equal(placeholderCalls, 2, "obvious stub source is rejected after exactly one corrective retry");

let providerOptions = null;
const structuredGateway = createFeltusCodeAIGateway({
  model: "fixture-model",
  async generate(_prompt, options) { providerOptions = options; return { done: true, response: "{}" }; }
});
await structuredGateway.complete({ messages: [{ role: "user", content: "Return structured output" }], responseFormat: "json" });
assert.equal(providerOptions.format, "json", "the existing AI gateway forwards structured-output requirements to the provider");

const originalFetch = globalThis.fetch;
const originalContextTokens = process.env.FELTUS_AI_CONTEXT_TOKENS;
const ollamaBodies = [];
try {
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    ollamaBodies.push(body);
    if (body.stream === false) return Response.json({ done: true, response: "ok" });
    return new Response('{"response":"ok","done":false}\n{"done":true}\n', {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    });
  };
  const ollama = new FeltusAI({ baseUrl: "http://127.0.0.1:11434", model: "fixture" });
  process.env.FELTUS_AI_CONTEXT_TOKENS = "12288";
  await ollama.generate("configured context");
  for await (const _event of ollama.generateStream("configured stream context")) {}
  delete process.env.FELTUS_AI_CONTEXT_TOKENS;
  await ollama.generate("default context");
  for await (const _event of ollama.generateStream("default stream context")) {}
} finally {
  globalThis.fetch = originalFetch;
  if (originalContextTokens === undefined) delete process.env.FELTUS_AI_CONTEXT_TOKENS;
  else process.env.FELTUS_AI_CONTEXT_TOKENS = originalContextTokens;
}
assert.deepEqual(ollamaBodies.map(body => body.options.num_ctx), [12288, 12288, 8192, 8192], "Ollama generation and streaming honor configured context tokens and default to 8192");
console.log("PASS generic per-file generation/refinement, bounded structured-output correction, placeholder rejection, Ollama context, reviewed build, validation, and existing-project iteration");
const alternateBranch = spawnSync("git", ["-C", emptyWorkspace, "checkout", "-b", "integration-check"], { encoding: "utf8", windowsHide: true });
assert.equal(alternateBranch.status, 0, alternateBranch.stderr);
assert.equal((await emptyCode.gitStatus()).stdout.trim(), "## No commits yet on integration-check", "the workspace reports its actual branch when it differs from main");
assert.match(webSource, /No files yet\. Tell FELTUS AI what you want to build\./, "empty project tree tells the user how to start");
console.log("PASS new empty private workspace initializes idempotently, loads an empty tree, and reports local main branch state");

const LOCAL_APP_ID = randomUUID();
const LOCAL_OWNER_ID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const localApp = {
  id: LOCAL_APP_ID,
  owner_id: LOCAL_OWNER_ID,
  app_name: "Local CODE fixture",
  app_type: "web_application",
  environment: "development",
  setup_status: "active",
  setup_data: {},
  created_at: "2026-11-06T00:00:00.000Z"
};
let hostedBranchReads = 0;
const localAuthorizationChecks = [];
const localStateHandler = createApplicationStateHandler({
  tableRequest: async table => {
    if (table === "feltus_applications") return { status: 200, data: [localApp] };
    if (table === "feltus_repository_branches") {
      hostedBranchReads += 1;
      return { status: 400, data: { message: "No hosted repository is linked." } };
    }
    return { status: 200, data: [] };
  },
  serviceRequest: async () => ({ status: 200, data: [] }),
  readBody: async request => request.body || {},
  getUser: () => ({ id: LOCAL_OWNER_ID }),
  authorizeApp: async (appId, capability) => {
    localAuthorizationChecks.push({ appId, capability });
    return appId === LOCAL_APP_ID && capability === "canViewCode";
  }
});
async function invokeLocalStateApi(route) {
  const result = { status: null, headers: {}, body: "" };
  await localStateHandler(
    { method: "GET", headers: {} },
    {
      writeHead(status, headers) { result.status = status; result.headers = headers; },
      end(body) { result.body = String(body || ""); }
    },
    new URL(`http://feltus.test/api/apps/${LOCAL_APP_ID}/${route}`)
  );
  return { ...result, json: JSON.parse(result.body || "{}") };
}
const [localStateResponse, localEnvironmentResponse, localBuildResponse, localBlueprintHistoryResponse] = await Promise.all([
  invokeLocalStateApi("state"),
  invokeLocalStateApi("environments"),
  invokeLocalStateApi("builds"),
  invokeLocalStateApi("blueprints")
]);
assert.equal(localStateResponse.status, 200, "Build Studio state loading must succeed without a hosted repository");
assert.equal(localEnvironmentResponse.status, 200, "Build Studio environment loading must succeed without Blueprint history");
assert.equal(localBuildResponse.status, 200, "Build Studio build history loading must succeed without Blueprint history");
assert.equal(localBlueprintHistoryResponse.status, 200, "an authorized app with no Blueprint history must load an empty history");
assert.deepEqual(localBlueprintHistoryResponse.json.blueprints, [], "an unsaved app has an empty Blueprint history");
assert.equal(localAuthorizationChecks.length, 4, "each Build Studio startup API request must authorize the app");
assert.ok(localAuthorizationChecks.every(check => check.appId === LOCAL_APP_ID && check.capability === "canViewCode"));
for (const response of [localStateResponse, localEnvironmentResponse, localBuildResponse, localBlueprintHistoryResponse]) {
  assert.doesNotMatch(response.body, /Blueprint history could not be loaded/, "empty Blueprint history must not show a startup error");
}
assert.equal(hostedBranchReads, 0, "local CODE branch state must not query hosted repository branches");
assert.match(webSource, /async function refreshGitStatus\(\)[\s\S]*?api\(projectQuery\("\/api\/code\/git\/status"\)\)/);
assert.match(webSource, /async function loadCheckpoints\([\s\S]*?api\(projectQuery\("\/api\/code\/git\/log\?limit=100"\)\)/);
assert.match(webSource, /async function loadVersion\(\)[\s\S]*?api\(`\/api\/apps\/\$\{encodeURIComponent\(projectId\)\}\/state`\)[\s\S]*?\/environments[\s\S]*?\/builds/);
assert.match(webSource, /async function loadWorkspace\(\)[\s\S]*?loadVersion\(\)/, "Build Studio startup must continue to load authoritative version state");
const initializeWorkspaceSource = webSource.match(/async function initializeWorkspace\(\)[\s\S]*?\n\}/)?.[0] || "";
assert.match(initializeWorkspaceSource, /action: "initialize"/);
assert.match(initializeWorkspaceSource, /await loadWorkspace\(\)/, "Studio refreshes the workspace after initialization");
assert.doesNotMatch(initializeWorkspaceSource, /seed_local/, "normal workspace initialization never uses the development fixture seeder");
assert.match(initializeWorkspaceSource, /renderFriendlyError\(errorNode, error\)/, "initialization errors keep a friendly message and expandable diagnostics");
assert.match(webSource, /function renderFriendlyError\(node, error\)[\s\S]*technical\.textContent = errorMessage\(error\)/, "technical error codes and request IDs remain available in diagnostics");
assert.match(webSource, /async function loadWorkspace\(\)[\s\S]*?loadTree\(\)[\s\S]*?refreshGitStatus\(\)/, "Studio loads the local project tree and Git status after initialization");
assert.match(webSource, /async function boot\(\)[\s\S]*?await loadWorkspace\(\)/);
assert.ok(webSource.includes('branchLine.match(/^## No commits yet on (.+)$/)'), "an unborn empty repository still displays its reported active branch");
assert.ok(webSource.includes('`Branch: ${branchName || "main"}`'), "the Studio header uses repository metadata and falls back to main only when missing");
assert.match(serverSource, /const app = await authorizedCodeProject\(appId, permission\);[\s\S]*?if \(workspaceRoute\)/, "workspace initialization is protected by the existing app authorization check");
assert.match(serverSource, /function codePermissionForRequest\(route, method\)[\s\S]*?return "canEditCode";/, "workspace POST remains restricted to app editors");
assert.match(localGitStatus.stdout, /^## main$/m, "the local CODE Git API reports the branch initialized by the Git fixture");
console.log("PASS authorized local Build Studio startup succeeds with initialized main workspace, empty Blueprint history, and no hosted repository");

try {
  const files = createFileTools({ repoRoot: project });
  const appHash = await files.hash("app.js");
  const selectedChangeSet = {
    id: "selected-change-set",
    summary: "Update app and add a test",
    operations: [
      { id: "update-app", type: "update", path: "app.js", before_sha256: appHash, content: "export const value = 2;\n", reason: "Update value", agent: "code-agent" },
      { id: "create-test", type: "create", path: "app.test.js", content: "console.log('test');\n", reason: "Add test", agent: "code-agent" },
      { id: "delete-old", type: "delete", path: "delete.js", before_sha256: await files.hash("delete.js"), reason: "Remove old fixture", agent: "project-agent" }
    ]
  };
  const reviewed = await reviewChangeSet({ repoRoot: project, changeSet: selectedChangeSet });
  assert.equal(reviewed.operations.length, 3);
  assert.equal(reviewed.operations[0].before_content, "export const value = 1;\n");
  const allSelected = resolveChangeSetSelection(selectedChangeSet, undefined);
  assert.deepEqual(allSelected.selectedIds, ["update-app", "create-test", "delete-old"], "omitted selection resolves to all operations");
  const exactSelection = resolveChangeSetSelection(selectedChangeSet, ["create-test"]);
  assert.deepEqual(exactSelection.changeSet.operations.map(operation => operation.id), ["create-test"], "explicit selection resolves only selected operations");
  assert.throws(
    () => resolveChangeSetSelection(selectedChangeSet, []),
    error => error.code === "INVALID_CHANGE_SET",
    "an explicitly empty selection is invalid"
  );
  const allApplied = await applyChangeSet({
    repoRoot: project,
    changeSet: selectedChangeSet,
    confirmDestructive: true
  });
  assert.equal(allApplied.applied.length, 3, "omitted selection applies every eligible operation");
  assert.equal(await files.read("app.js"), "export const value = 2;\n");
  assert.equal(await files.read("app.test.js"), "console.log('test');\n");
  await assert.rejects(() => files.read("delete.js"), error => error.code === "ENOENT");
  await undoChangeSet({ repoRoot: project, token: allApplied.undo_token, confirm: true });

  await assert.rejects(
    () => applyChangeSet({ repoRoot: project, changeSet: selectedChangeSet }),
    error => error.code === "CONFIRMATION_REQUIRED"
  );
  const applied = await applyChangeSet({ repoRoot: project, changeSet: selectedChangeSet, selectedIds: ["update-app", "create-test"] });
  assert.equal(await files.read("app.js"), "export const value = 2;\n");
  assert.equal(await files.read("app.test.js"), "console.log('test');\n");
  assert.equal(await files.read("delete.js"), "temporary\n", "unselected deletion must not run");
  const undone = await undoChangeSet({ repoRoot: project, token: applied.undo_token, confirm: true });
  assert.deepEqual(new Set(undone.restored), new Set(["app.js", "app.test.js"]));
  assert.equal(await files.read("app.js"), "export const value = 1;\n");
  await assert.rejects(() => files.read("app.test.js"), error => error.code === "ENOENT");
  await assert.rejects(
    () => applyChangeSet({ repoRoot: project, changeSet: selectedChangeSet, selectedIds: [] }),
    error => error.code === "INVALID_CHANGE_SET"
  );

  const protectedSelection = {
    id: "protected-empty-selection",
    operations: [{ id: "protected-update", type: "create", path: "protected-contract.js", content: "export const contract = true;\n" }]
  };
  assert.throws(
    () => resolveChangeSetSelection(protectedSelection, []),
    error => error.code === "INVALID_CHANGE_SET",
    "an empty selection is rejected before any caller's owner-approval decision"
  );
  const applyRoute = serverSource.match(/if \(route === "\/api\/code\/change-set\/apply" && method === "POST"\)[\s\S]*?if \(route === "\/api\/code\/change-set\/reject"/)?.[0] || "";
  assert.ok(applyRoute.indexOf("resolveChangeSetSelection") >= 0);
  assert.ok(applyRoute.indexOf("resolveChangeSetSelection") < applyRoute.indexOf("classifyChangeSetContracts"));
  assert.ok(applyRoute.indexOf("resolveChangeSetSelection") < applyRoute.indexOf("const exactOwner"));
  assert.match(applyRoute, /changeSet: selectedSet,[\s\S]*selectedIds,/);
  assert.match(applyRoute, /result\.result\.applied\.flatMap/, "activity records are derived from the exact applied operation set");

  const failureChangeSet = {
    id: "partial-apply",
    summary: "Exercise partial apply recovery",
    operations: [
      { id: "first-create", type: "create", path: "rollback-first.js", content: "export const first = true;\n" },
      { id: "second-create", type: "create", path: "rollback-second.js", content: "export const second = true;\n" }
    ]
  };
  const originalApplyError = Object.assign(new Error("synthetic apply failure"), { code: "SYNTHETIC_APPLY_FAILURE" });
  let successfulRollbackError;
  await assert.rejects(
    () => applyChangeSet({
      repoRoot: project,
      changeSet: failureChangeSet,
      beforeApplyOperation: operation => {
        if (operation.id === "second-create") throw originalApplyError;
      },
      beforeRollbackOperation: operation => {
        successfulRollbackError = operation;
      }
    }),
    error => error === originalApplyError && error.recovery?.status === "rollback_complete" && error.recovery.backup_retained === false
  );
  assert.deepEqual(successfulRollbackError && [successfulRollbackError.id], ["first-create"], "only the successful operation is rolled back");
  await assert.rejects(() => files.read("rollback-first.js"), error => error.code === "ENOENT");
  await assert.rejects(
    () => fs.access(path.join(project, ".feltus-code-backups", `${originalApplyError.recovery.recovery_token}.json`)),
    error => error.code === "ENOENT",
    "the recovery backup is removed after successful rollback"
  );

  const rollbackFailureApplyError = Object.assign(new Error("synthetic apply failure"), { code: "SYNTHETIC_APPLY_FAILURE" });
  const rollbackFailureError = Object.assign(new Error("synthetic rollback failure"), { code: "SYNTHETIC_ROLLBACK_FAILURE" });
  await assert.rejects(
    () => applyChangeSet({
      repoRoot: project,
      changeSet: { ...failureChangeSet, id: "rollback-failure" },
      beforeApplyOperation: operation => {
        if (operation.id === "second-create") throw rollbackFailureApplyError;
      },
      beforeRollbackOperation: operation => {
        if (operation.id === "first-create") throw rollbackFailureError;
      }
    }),
    error => error === rollbackFailureApplyError &&
      error.code === "SYNTHETIC_APPLY_FAILURE" &&
      error.recovery?.status === "rollback_failed" &&
      error.recovery.backup_retained === true &&
      error.recovery.uncertain_operations.some(operation => operation.id === "first-create") &&
      error.recovery.rollback_errors.some(item => item.error.code === "SYNTHETIC_ROLLBACK_FAILURE")
  );
  const retainedRecoveryPath = path.join(project, ".feltus-code-backups", `${rollbackFailureApplyError.recovery.recovery_token}.json`);
  const retainedRecovery = JSON.parse(await fs.readFile(retainedRecoveryPath, "utf8"));
  assert.equal(retainedRecovery.recovery.status, "rollback_failed");
  assert.equal(retainedRecovery.recovery.apply_error.code, "SYNTHETIC_APPLY_FAILURE");
  assert.equal(retainedRecovery.recovery.rollback_errors[0].error.code, "SYNTHETIC_ROLLBACK_FAILURE");
  assert.equal(await files.read("rollback-first.js"), "export const first = true;\n", "a failed rollback does not claim the file was reverted");
  await fs.rm(retainedRecoveryPath, { force: true });

  await assert.rejects(
    () => applyChangeSet({ repoRoot: project, changeSet: { summary: "escape", operations: [{ type: "create", path: "../private.js", content: "bad" }] } }),
    error => error.code === "INVALID_REPO_PATH"
  );
  await assert.rejects(
    () => applyChangeSet({ repoRoot: project, changeSet: { summary: "secret", operations: [{ type: "create", path: ".env.local", content: "bad" }] } }),
    error => error.code === "SENSITIVE_FILE_BLOCKED"
  );
  console.log("PASS multi-file review, selected apply, destructive confirmation, reject-by-omission, undo, and path isolation");

  const runner = createTaskRunner({
    repoRoot: project,
    validationTempRoot,
    tasks: {
      "fixture-check": {
        command: process.execPath,
        args: ["-e", "const fs=require('fs');process.exit(fs.readFileSync('app.js','utf8').includes('value = 3')&&fs.existsSync('new.js')?0:1)"]
      }
    }
  });
  const validation = await runner.runAgainstChangeSet("fixture-check", {
    summary: "Validate snapshot",
    operations: [
      { type: "update", path: "app.js", before_sha256: await files.hash("app.js"), content: "export const value = 3;\n" },
      { type: "create", path: "new.js", content: "export default true;\n" }
    ]
  });
  assert.equal(validation.code, 0);
  assert.equal(await files.read("app.js"), "export const value = 1;\n", "snapshot validation must not edit the project");
  await assert.rejects(() => files.read("new.js"), error => error.code === "ENOENT");
  console.log("PASS proposed create/update validation runs in a temporary project snapshot");

  const context = await buildStudioContext({
    repoRoot: project,
    app: { id: "11111111-1111-4111-8111-111111111111", app_name: "Test App", app_type: "web_application" },
    capabilities: owner,
    prompt: "Update app value",
    selectedPaths: ["app.js"],
    schema: { models: [{ id: "customers", logical_name: "customers", fields: [] }], relationships: [] },
    preview: { status: "failed", errors: [{ type: "runtime", message: "TOKEN=do-not-leak", source: "app.js" }] },
    recentActions: [{ action_type: "ai.architect.plan", summary: "Plan ready", actor_id: "actor", created_at: new Date().toISOString() }]
  });
  assert.equal(context.editor.current_file, "app.js");
  assert.match(context.editor.selected_files[0].content, /value = 1/);
  assert.doesNotMatch(JSON.stringify(context), /do-not-read/);
  assert.doesNotMatch(JSON.stringify(context), /do-not-leak/);
  assert.equal(context.data.models[0].logical_name, "customers");
  assert.equal(context.recent_activity[0].actor_id, "actor");
  await assert.rejects(
    () => buildStudioContext({ repoRoot: project, app: { id: "a" }, selectedPaths: ["../project-b/private.js"] }),
    error => error.code === "INVALID_REPO_PATH"
  );
  console.log("PASS unified context includes selected code, schema, Git, errors, and activity without secrets or cross-project access");

  let completionCall = 0;
  const agent = createCodeAgent({
    repoRoot: project,
    fileTools: files,
    aiGateway: {
      async complete() {
        completionCall += 1;
        if (completionCall === 1) return { content: JSON.stringify({
          title: "Add a page", summary: "Plan page work", significant: true,
          steps: [{ id: "one", title: "Update app", agent: "code-agent", details: "Use current file" }],
          pages: ["Home"], components: [], data_models: [], relationships: [], roles: [], permissions: [], apis: [], workflows: [], files: ["app.js"], tests: ["fixture-check"], deployment_considerations: []
        }) };
        return { content: JSON.stringify({
          summary: "Update app",
          operations: [{ id: "app", type: "update", path: "app.js", before_sha256: context.editor.selected_files[0].sha256, content: "export const value = 4;\n", reason: "Implement plan", agent: "code-agent" }]
        }) };
      }
    }
  });
  const plan = await agent.architectPlan({ prompt: "Add a page", context });
  const proposal = await agent.proposeChangeSet({ prompt: "Build it", context, plan });
  assert.equal(plan.steps[0].agent, "code-agent");
  assert.equal(proposal.operations.length, 1);
  assert.equal(proposal.operations[0].before_sha256, await files.hash("app.js"));
  console.log("PASS App Architect plan delegates to controlled Project/Code change-set work");

  let proposals = 0;
  const workflow = await runStudioAgent({
    prompt: "Repair fixture",
    context,
    model: "fixture",
    task: "fixture-check",
    repairLimit: 2,
    architect: async () => plan,
    propose: async () => { proposals += 1; return proposal; },
    validate: async () => ({ task: "fixture-check", code: 1, stdout: "", stderr: "still failing" })
  });
  assert.equal(proposals, 3, "initial proposal plus exactly two repairs");
  assert.equal(workflow.attempts.length, 3);
  assert.match(workflow.blocker, /allowed repair attempts/);
  console.log("PASS Studio agent stops at the controlled two-repair limit and preserves review state");

  let repairProposalMode = null;
  let repairValidationCalls = 0;
  const repairedWorkflow = await runStudioAgent({
    prompt: "Repair fixture",
    context,
    model: "fixture",
    task: "fixture-check",
    repairLimit: 2,
    architect: async () => plan,
    propose: async options => {
      repairProposalMode = options.mode;
      return proposal;
    },
    validate: async () => {
      repairValidationCalls += 1;
      return { task: "fixture-check", code: repairValidationCalls === 1 ? 1 : 0, stdout: "repaired", stderr: "" };
    }
  });
  assert.equal(repairProposalMode, "fix");
  assert.equal(repairedWorkflow.attempts.length, 2);
  assert.equal(repairedWorkflow.validation.code, 0);
  assert.equal(repairedWorkflow.ready_for_review, true);
  assert.equal(repairedWorkflow.blocker, undefined);
  console.log("PASS bounded repair succeeds after validation failure and returns the repaired change set for review");

  await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  const children = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("close", 0)); return true; };
    children.push(child);
    return child;
  };
  const fetchImpl = async url => new Response(
    String(url).endsWith("/") ? '<html><head></head><body><script type="module" src="/src.js"></script></body></html>' : 'import value from "/module.js";',
    { status: 200, headers: { "content-type": String(url).endsWith("/") ? "text/html" : "text/javascript" } }
  );
  const unavailablePreview = createPreviewManager({ repoRoot: project, fetchImpl, allocate: async () => 4173 });
  assert.equal(unavailablePreview.status().status, "unavailable");
  assert.equal(unavailablePreview.status().available, false);
  await assert.rejects(() => unavailablePreview.start(), error => error.code === "PREVIEW_ISOLATION_UNAVAILABLE");
  const preview = createPreviewManager({
    repoRoot: project,
    launchIsolatedPreview: async options => {
      assert.equal(options.port, 4173);
      assert.equal(options.command, "npm");
      assert.deepEqual(options.args, ["run", "dev", "--ignore-scripts", "--", "--host", "0.0.0.0", "--port", "4173", "--strictPort"]);
      assert.equal(options.env.PORT, "4173");
      assert.equal(options.env.HOST, "0.0.0.0");
      assert.equal(Object.hasOwn(options.env, "OPENAI_API_KEY"), false, "project preview must not inherit server secrets");
      return { child: fakeSpawn(), port: options.port, isolated: true };
    },
    fetchImpl,
    allocate: async () => 4173
  });
  assert.equal((await preview.start()).status, "running");
  const proxied = await preview.proxy("11111111-1111-4111-8111-111111111111", "/");
  assert.match(proxied.body.toString(), /feltus-preview-ready/);
  assert.match(proxied.body.toString(), /preview\/proxy\/11111111-1111-4111-8111-111111111111\/src\.js/);
  preview.recordError({ type: "console", message: "password=hidden-value", source: "/src.js" });
  assert.doesNotMatch(JSON.stringify(preview.status().errors), /hidden-value/);
  preview.recordError({ type: "network", message: "request failed", source: "https://example.test/item?token=private-value" });
  assert.doesNotMatch(JSON.stringify(preview.status().errors), /private-value|\?token=/);
  assert.equal((await preview.restart()).status, "running");
  assert.equal(children.length, 2);
  assert.equal(preview.status().errors.length, 0, "restart clears old errors so repair verification uses fresh results");
  assert.equal(preview.heartbeat().status, "running");
  await preview.stop();
  console.log("PASS preview fails closed without isolation; isolated-runner contract, reload, proxy bridge, browser-error capture, and secret redaction");

  const runnerWorkspaceRoot = path.join(tempRoot, "runner-workspaces");
  const runnerAppId = "11111111-1111-4111-8111-111111111111";
  const runnerProject = path.join(runnerWorkspaceRoot, runnerAppId);
  const scratchRoot = path.join(runnerWorkspaceRoot, ".preview-sandboxes");
  await fs.mkdir(runnerProject, { recursive: true });
  await fs.writeFile(path.join(runnerProject, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
  await fs.writeFile(path.join(runnerProject, ".env"), "SUPABASE_SERVICE_ROLE_KEY=must-not-enter-preview\n");
  await fs.mkdir(path.join(runnerProject, ".git"), { recursive: true });
  await fs.writeFile(path.join(runnerProject, ".git", "config"), "private repository metadata\n");
  await fs.writeFile(path.join(runnerProject, "index.html"), "<h1>Preview fixture</h1>\n");
  const dockerCalls = [];
  const dockerRuns = [];
  let dockerWaitMonitor = null;
  const fakeDockerSpawn = (command, args) => {
    assert.equal(command, "docker");
    dockerCalls.push([...args]);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit("close", 0)); return true; };
    if (args[0] === "run") {
      dockerRuns.push([...args]);
      queueMicrotask(() => child.emit("close", 0));
    } else if (args[0] === "logs") {
      // Keep the app output stream attached until the container stops.
    } else if (args[0] === "wait") {
      dockerWaitMonitor = child;
    } else if (args[0] === "stop") {
      queueMicrotask(() => {
        child.emit("close", 0);
        dockerWaitMonitor?.stdout.write("0\n");
        dockerWaitMonitor?.emit("close", 0);
      });
    } else queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  const dockerLauncher = createDockerPreviewLauncher({
    workspaceRoot: runnerWorkspaceRoot,
    scratchRoot,
    appId: runnerAppId,
    spawnImpl: fakeDockerSpawn
  });
  const launch = await dockerLauncher({
    repoRoot: runnerProject,
    command: "npm",
    args: ["run", "dev", "--ignore-scripts", "--", "--host", "0.0.0.0", "--port", "4173", "--strictPort"],
    script: "dev",
    port: 4173
  });
  assert.equal(launch.isolated, true);
  assert.equal(dockerRuns.length, 2, "the project and the trusted localhost connection run in separate containers");
  const networks = dockerCalls.filter(args => args[0] === "network" && args[1] === "create");
  const networkCall = networks.find(args => args.includes("--internal"));
  const proxyNetworkCall = networks.find(args => args.includes("--driver"));
  assert.ok(networkCall, "the app gets a private network with no outbound route");
  assert.ok(proxyNetworkCall, "the trusted localhost connection uses a separate host-published network");
  const runCall = dockerRuns.find(args => args.includes("com.feltus.preview.role=app"));
  const proxyRunCall = dockerRuns.find(args => args.includes("com.feltus.preview.role=connection"));
  assert.ok(runCall && proxyRunCall);
  assert.ok(runCall.includes("--cpus") && runCall.includes("--memory") && runCall.includes("--pids-limit"));
  assert.ok(runCall.includes("--cap-drop") && runCall.includes("ALL"));
  assert.ok(runCall.includes("--read-only"));
  assert.ok(!runCall.includes("--privileged"));
  assert.ok(!runCall.includes("--publish"), "user code must not own a host-published port");
  assert.ok(proxyRunCall.some(arg => String(arg).startsWith("127.0.0.1:")), "only the trusted connection publishes a localhost port");
  assert.ok(!runCall.some(arg => /docker\.sock|service.role|coolify|ghcr/i.test(arg)));
  const mountArg = runCall[runCall.indexOf("--mount") + 1];
  assert.match(mountArg, /source=.*preview-[a-f0-9]+,target=\/workspace/);
  const snapshot = mountArg.match(/source=(.*),target=\/workspace/)[1];
  assert.equal(path.dirname(snapshot), scratchRoot);
  assert.equal(await fs.readFile(path.join(snapshot, "index.html"), "utf8"), "<h1>Preview fixture</h1>\n");
  assert.equal(await fs.stat(path.join(snapshot, ".env")).then(() => true, () => false), false, "project secrets must not be copied into Preview");
  assert.equal(await fs.stat(path.join(snapshot, ".git")).then(() => true, () => false), false, "repository metadata must not be copied into Preview");
  assert.ok(!runCall.some(arg => String(arg).includes("SUPABASE_SERVICE_ROLE_KEY")));
  const runEnvironment = runCall.filter((arg, index) => runCall[index - 1] === "--env");
  assert.ok(!runEnvironment.some(value => /SERVICE_ROLE|OPENAI|GITHUB|COOLIFY|GHCR|DATABASE_URL/i.test(value)));
  assert.ok(dockerCalls.some(args => args[0] === "network" && args[1] === "connect" && args.includes(networkCall.at(-1))));
  const closed = new Promise(resolve => launch.child.once("close", resolve));
  launch.child.kill("SIGTERM");
  await closed;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await fs.stat(snapshot).then(() => true, () => false), false, "stopping Preview removes its isolated snapshot");
  const callsBeforeInvalid = dockerCalls.length;
  await assert.rejects(() => dockerLauncher({
    repoRoot: runnerProject,
    command: "npm",
    args: ["run", "dev", "&&", "whoami"],
    script: "dev",
    port: 4173
  }), error => error.code === "PREVIEW_COMMAND_UNSUPPORTED");
  await assert.rejects(() => dockerLauncher({
    repoRoot: otherProject,
    command: "node",
    args: ["server.js"],
    script: "dev",
    port: 4173
  }), error => error.code === "PREVIEW_WORKSPACE_UNSAFE");
  assert.equal(dockerCalls.length, callsBeforeInvalid, "invalid commands and cross-project mounts fail before Docker starts");
  const linkedAppId = "22222222-2222-4222-8222-222222222222";
  const linkedAppPath = path.join(runnerWorkspaceRoot, linkedAppId);
  let linkedWorkspaceCreated = false;
  try {
    await fs.symlink(otherProject, linkedAppPath, "junction");
    linkedWorkspaceCreated = true;
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
  }
  if (linkedWorkspaceCreated) {
    try {
      await assert.rejects(() => createDockerPreviewLauncher({
        workspaceRoot: runnerWorkspaceRoot,
        scratchRoot,
        appId: linkedAppId,
        spawnImpl: fakeDockerSpawn
      })({
        repoRoot: linkedAppPath,
        command: "node",
        args: ["server.js"],
        script: "dev",
        port: 4173
      }), error => ["SYMLINK_NOT_ALLOWED", "PREVIEW_WORKSPACE_UNSAFE"].includes(error.code));
      assert.equal(dockerCalls.length, callsBeforeInvalid, "linked workspaces fail before Docker starts");
    } finally {
      await fs.rm(linkedAppPath, { recursive: true, force: true });
    }
    console.log("PASS linked workspaces fail closed before Docker starts");
  } else {
    console.log("SKIP linked workspace test because Windows directory-link permission is unavailable");
  }
  console.log("PASS Docker preview runner snapshots one project, strips secrets, applies container limits, isolates its network, and fails closed for unsafe inputs");

  const startupFailure = createPreviewManager({
    repoRoot: project,
    launchIsolatedPreview: async options => ({ child: fakeSpawn(), port: options.port, isolated: true }),
    fetchImpl: async () => { throw new Error("not ready"); },
    allocate: async () => 4173,
    readyTimeoutMs: 5,
    idleTimeoutMs: 0
  });
  await assert.rejects(() => startupFailure.start(), error => error.code === "PREVIEW_START_TIMEOUT");
  assert.equal(startupFailure.status().status, "failed");
  console.log("PASS preview startup timeout marks the preview failed and terminates its runner");

  const runtimeFailureChildren = [];
  const runtimeFailurePreview = createPreviewManager({
    repoRoot: project,
    launchIsolatedPreview: async options => {
      const child = fakeSpawn();
      runtimeFailureChildren.push(child);
      return { child, port: options.port, isolated: true };
    },
    fetchImpl,
    allocate: async () => 4173,
    idleTimeoutMs: 0
  });
  assert.equal((await runtimeFailurePreview.start()).status, "running");
  runtimeFailureChildren[0].stderr.write("Error: password=runtime-secret\n");
  runtimeFailureChildren[0].emit("close", 1);
  assert.equal(runtimeFailurePreview.status().status, "failed");
  assert.equal(runtimeFailurePreview.status().exit_code, 1);
  assert.doesNotMatch(runtimeFailurePreview.status().stderr, /runtime-secret/);
  console.log("PASS runtime process failure is surfaced with a sanitized error and exit status");

  const expiringPreview = createPreviewManager({
    repoRoot: project,
    launchIsolatedPreview: async options => ({ child: fakeSpawn(), port: options.port, isolated: true }),
    fetchImpl,
    allocate: async () => 4173,
    idleTimeoutMs: 20
  });
  await expiringPreview.start();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(expiringPreview.status().status, "stopped", "an unresponsive/closed Studio session must expire its preview lease");
  console.log("PASS preview lease expires when Studio stops sending heartbeats");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

for (const id of ["pane-chat", "pane-code", "pane-preview", "pane-design", "pane-data", "pane-launch", "pane-terminal", "pane-changes", "application-result-card", "chat-preview-card", "chat-preview-frame", "chat-start-preview", "request-app-change", "change-files", "checkpoint-list", "studio-activity", "prepare-version", "send-testing"]) {
  assert.match(webHtml, new RegExp(`id=["']${id}["']`));
}
for (const route of ["/api/code/ai/architect", "/api/code/ai/studio-agent", "/api/code/change-set/apply", "/api/code/change-set/reject", "/api/code/change-set/undo", "/api/code/preview/start", "/api/code/preview/reload", "/api/code/preview/heartbeat"]) {
  assert.ok(webSource.includes(route), `Studio browser wiring missing ${route}`);
  assert.ok(serverSource.includes(route), `Studio server wiring missing ${route}`);
}
assert.match(readFileSync(path.join(root, "src/feltus-code/server/preview-manager.mjs"), "utf8"), /preview\/errors\?app_id=/);
assert.match(readFileSync(path.join(root, "src/feltus-code/server/docker-preview-runner.mjs"), "utf8"), /--internal/);
assert.match(webSource, /window\.addEventListener\("pagehide"/);
assert.match(webSource, /fetch\(projectQuery\("\/api\/code\/preview\/stop"\)/, "leaving a project asks its preview to stop");
assert.match(serverSource, /const codePreviewManagers = new Map\(\)/);
assert.match(serverSource, /codePreviewManagers\.get\(appId\)/);
assert.match(serverSource, /codePreviewManagers\.set\(appId, manager\)/, "each app keeps its own preview manager");
assert.match(webSource, /runStudioAgent\(prompt\)/);
assert.match(serverSource, /manager\.dispose\(\)/);
assert.ok(serverSource.includes("/api/code/preview/errors"), "Studio server error-reporting route is missing");
assert.equal((webSource.match(/\/deployments["'`]/g) || []).length, 1, "Send to testing must have one deployment submission path");
assert.match(webSource, /deploymentBusy/);
assert.match(webSource, /idempotencyKey/);
assert.match(webSource, /renderStudioActivity/);
assert.match(webSource, /\/api\/code\/activity\?limit=12/);
assert.match(webSource, /function replaceInFile\(\)/);
const primaryNavigation = webHtml.match(/<nav id="primary-nav"[\s\S]*?<\/nav>/)?.[0] || "";
for (const destination of ["Home", "Create", "Preview", "Design", "Connections", "Launch", "My App"]) {
  assert.ok(primaryNavigation.includes(destination), `primary navigation must include ${destination}`);
}
assert.match(webHtml, /id="prompt"[\s\S]*id="send-ai"/, "the conversational composer stays available on the primary screen");
assert.match(webHtml, /<details class="advanced-controls">[\s\S]*id="context-chips"/, "technical AI context is tucked under Advanced by default");
assert.doesNotMatch(webHtml.match(/<div class="chat-composer-footer">[\s\S]*?<\/div>/)?.[0] || "", /context-chips|Git state|Data model|Project map/, "the customer-facing composer does not surface developer context");
assert.match(webSource, /function appendMessage\(kind, label, content\)[\s\S]*?\$\("chat-welcome"\)\.hidden = true/, "message rendering hides the existing welcome node");
const staticHtmlIds = new Set([...webHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const staticIdLookups = new Set([...webSource.matchAll(/(?<!\$)\$\("([^"]+)"\)/g)].map(match => match[1]));
assert.deepEqual([...staticIdLookups].filter(id => id !== "chat-progress" && !staticHtmlIds.has(id)), [], "every static DOM lookup resolves; chat-progress is created before use");
assert.match(webHtml, /id="chat-welcome"/, "chat welcome has the ID required by appendMessage");
assert.match(webHtml, /<button[^>]*id="send-ai"[^>]*>Create my app/, "the default composer action uses customer-facing language");
assert.doesNotMatch(webHtml, /Maya Beauty|Maya salon/i, "the chat UI does not hardcode a specific application");
assert.match(webSource, /state\.appName = appResult\.app\?\.app_name \|\| sessionResult\.session\?\.title/, "application identity comes from the selected application or conversation");
assert.match(webHtml, /id="advanced-tools" class="advanced-tools"/, "developer project tools are grouped under Advanced");
assert.match(webSource, /state\.applicationCreated = true[\s\S]*renderApplicationResult\(\)/, "the app result card appears only after approved changes are applied");
assert.match(webSource, /api\(`\/api\/apps\/\$\{encodeURIComponent\(projectId\)\}`\)/, "the app result uses the current application identity");
assert.match(webHtml, /id="assistant-error"[\s\S]*role="alert"/, "assistant failures have a dedicated accessible alert");
assert.match(webSource, /function renderFriendlyError\(node, error\)[\s\S]*Technical details[\s\S]*errorMessage\(error\)/, "friendly errors retain the technical detail for diagnostics");
assert.match(webSource, /async function applyChanges\(selectedOnly\)[\s\S]*?if \(!window\.confirm\(wording\)\) return;[\s\S]*?\/api\/code\/change-set\/apply/, "AI changes remain subject to explicit approval before application");
assert.match(webCss, /\.embedded-studio \.primary-nav \{ display: none; \}/, "embedded mode hides duplicate inner navigation");
assert.match(webCss, /@media \(min-width: 761px\) \{\s*\.embedded-studio \.app-shell \{ grid-template-rows: minmax\(0, 1fr\); \}/, "embedded desktop layout allocates the viewport to the workspace rather than hidden chrome");
assert.match(webCss, /\.conversation \{[^}]*overflow: auto/, "conversation history remains independently scrollable");
assert.match(webCss, /\.ai-panel \{[^}]*flex: 0 0 auto/, "composer remains anchored below the scrollable conversation");
assert.match(webCss, /#prompt \{ flex: 1; width: auto; min-width: 0;/, "composer input receives remaining width instead of shrinking beside the send button");
assert.match(webCss, /\.send-button \{ width: auto; flex: 0 0 auto;/, "send action keeps its intrinsic width in the composer");
assert.match(webSource, /api\(projectQuery\("\/api\/code\/tasks"\)\)[\s\S]*renderTasks\(await taskCatalogPromise\)/, "applying generated source refreshes validation task discovery");
assert.match(webSource, /loadPreviewStatus\(\)/, "applying generated source refreshes Preview availability");
assert.doesNotMatch(webCss, /translateX\(calc\(100% - 8px\)\)/, "the assistant is not exposed through an invisible eight-pixel edge");
assert.match(serverSource, /current_actor:/);
assert.doesNotMatch(webSource, /coolify/i);
assert.match(infrastructureSource, /docker_registry_image_name/);
assert.doesNotMatch(serverSource.match(/function codePreviewManager[\s\S]*?async function ensureCodeSession/)?.[0] || "", /Coolify|registry_image|artifact_digest/);
console.log("PASS Studio route, workspace tabs, data/version/testing handoff, and one guarded deployment submission path");
