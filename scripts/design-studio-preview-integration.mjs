import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createFeltusCodeHandlers } from "../src/feltus-code/server/routes.mjs";
import { createDesignStudioLifecycle } from "../src/feltus-code/server/design-studio-lifecycle.mjs";
import { DESIGN_RECIPES, designStateHash } from "../src/feltus-code/server/design-studio.mjs";
import { createDockerPreviewLauncher } from "../src/feltus-code/server/docker-preview-runner.mjs";
import { createPreviewManager } from "../src/feltus-code/server/preview-manager.mjs";
import { repositorySnapshotHash, scanRepository } from "../src/feltus-code/server/repository-productionization.mjs";
import { deserializeDesignStateFromSetupData, serializeDesignStateForSetupData } from "../src/lib/feltus-design-state-storage.js";
import { validateSetupData } from "../src/lib/feltus-app-wizard.js";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const fixtureName = ".feltus-design-preview-integration-" + process.pid + "-" + crypto.randomUUID().slice(0, 8);
const fixtureRoot = path.join(repoRoot, fixtureName);
const workspaceRoot = path.join(fixtureRoot, "workspaces");
const appId = crypto.randomUUID();
const siblingAppId = crypto.randomUUID();
const projectRoot = path.join(workspaceRoot, appId);
const siblingProjectRoot = path.join(workspaceRoot, siblingAppId);
const scratchRoot = path.join(workspaceRoot, ".preview-sandboxes");
const validationRoot = path.join(fixtureRoot, "validation-workspaces");
const app = { id: appId, app_name: "Design Studio Live Preview Fixture", app_type: "e-commerce" };
const recipe = DESIGN_RECIPES.find(item => item.id === "commerce-modern");
const image = "node:22-alpine";
const initialSetup = {
  intelligence: { classification: { industry: "e-commerce", confidence: 0.91, archetypes: ["marketplace"] } },
  capability_graph: { payments: true, authentication: true },
  code: {}
};
let persistedSetup = structuredClone(initialSetup);
let preview = null;
let launchDetails = null;
let validationRun = null;

function git(...args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }
  }).trim();
}

function docker(...args) {
  return execFileSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function readSetup() {
  const setup = structuredClone(persistedSetup);
  if (setup.code?.design) setup.code.design = deserializeDesignStateFromSetupData(setup.code.design);
  return { setup_data: setup, setup_updated_at: "fixture-version" };
}

async function saveSetup({ expectedStateHash, designState, undoRecord }) {
  const current = readSetup().setup_data.code?.design || null;
  assert.equal(current ? designStateHash(current) : null, expectedStateHash, "Design State writes use optimistic hash checks");
  const next = structuredClone(persistedSetup);
  next.code = {
    ...(next.code || {}),
    design: serializeDesignStateForSetupData(designState)
  };
  if (undoRecord) next.code.design_undo = undoRecord;
  else delete next.code.design_undo;
  validateSetupData(next);
  persistedSetup = next;
  return { setup_updated_at: "fixture-" + Date.now() };
}

async function writeFixture() {
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(siblingProjectRoot, { recursive: true });
  await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "scripts"), { recursive: true });
  await fs.writeFile(path.join(siblingProjectRoot, "private.txt"), "sibling workspace marker");
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "feltus-design-preview-fixture",
    private: true,
    scripts: { dev: "node server.mjs", check: "node scripts/check.mjs" }
  }, null, 2) + "\n");
  await fs.writeFile(path.join(projectRoot, "index.html"), [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Live Design Studio Preview</title></head>",
    "<body>",
    "  <main data-feltus-design-root>",
    "    <section data-feltus-id=\"hero-main\" data-feltus-component=\"hero\" data-feltus-page=\"home\" data-feltus-variant=\"centered\" data-feltus-managed=\"v1\">",
    "      <h1>Live Design Studio Preview</h1><p>Commerce Design State rendered from the CODE checkpoint.</p>",
    "    </section>",
    "    <article data-feltus-id=\"feature-card\" data-feltus-component=\"card\" data-feltus-page=\"home\" data-feltus-variant=\"elevated\" data-feltus-managed=\"v1\">Featured product</article>",
    "  </main>",
    "</body></html>",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "server.mjs"), [
    "import crypto from \"node:crypto\";",
    "import fs from \"node:fs/promises\";",
    "import http from \"node:http\";",
    "import path from \"node:path\";",
    "const root = process.cwd();",
    "const server = http.createServer(async (request, response) => {",
    "  const pathname = new URL(request.url || \"/\", \"http://preview.local\").pathname;",
    "  if (pathname === \"/runtime-failure\") { response.writeHead(500, { \"content-type\": \"text/plain\" }); response.end(\"controlled runtime failure\"); return; }",
    "  if (pathname === \"/runtime-identity\") {",
    "    const html = await fs.readFile(path.join(root, \"index.html\"));",
    "    const css = await fs.readFile(path.join(root, \"src\", \"feltus-design.css\"));",
    "    response.writeHead(200, { \"content-type\": \"application/json\" });",
    "    response.end(JSON.stringify({ preview: process.env.FELTUS_PREVIEW, cwd: process.cwd(), html_sha256: crypto.createHash(\"sha256\").update(html).digest(\"hex\"), css_sha256: crypto.createHash(\"sha256\").update(css).digest(\"hex\") }));",
    "    return;",
    "  }",
    "  if (pathname === \"/security-check\") {",
    "    let network = \"egress-blocked\";",
    "    try { await fetch(\"https://example.com\", { signal: AbortSignal.timeout(800) }); network = \"egress-open\"; } catch {}",
    "    response.writeHead(200, { \"content-type\": \"application/json\" });",
    "    response.end(JSON.stringify({ network, docker_socket: await fs.access(\"/var/run/docker.sock\").then(() => true, () => false), sibling_workspace: await fs.access(\"/workspace/../" + siblingAppId + "\").then(() => true, () => false), sensitive_environment: Object.keys(process.env).filter(key => /SERVICE_ROLE|SECRET|OPENAI|GITHUB|COOLIFY|DATABASE_URL/i.test(key)) }));",
    "    return;",
    "  }",
    "  const relative = pathname === \"/\" ? \"index.html\" : decodeURIComponent(pathname.slice(1));",
    "  const target = path.resolve(root, relative);",
    "  if (target !== root && !target.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }",
    "  try {",
    "    const content = await fs.readFile(target);",
    "    const contentType = target.endsWith(\".css\") ? \"text/css; charset=utf-8\" : \"text/html; charset=utf-8\";",
    "    response.writeHead(200, { \"content-type\": contentType });",
    "    response.end(content);",
    "  } catch { response.writeHead(404); response.end(); }",
    "});",
    "server.listen(Number(process.env.PORT), \"0.0.0.0\");",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "scripts", "check.mjs"), [
    "import assert from \"node:assert/strict\";",
    "import fs from \"node:fs\";",
    "const html = fs.readFileSync(\"index.html\", \"utf8\");",
    "const css = fs.readFileSync(\"src/feltus-design.css\", \"utf8\");",
    "assert.match(html, /data-feltus-design-stylesheet=\"v1\"/);",
    "assert.match(html, /data-feltus-variant=\"compact\"/);",
    "assert.match(css, /FELTUS-DESIGN-MANAGED-V1/);",
    "assert.match(css, /@media \\(max-width: 1024px\\)/);",
    "assert.match(css, /@media \\(max-width: 760px\\)/);",
    "assert.match(css, /data-feltus-id=\"hero-main\"/);",
    ""
  ].join("\n"));
  await fs.writeFile(path.join(projectRoot, "src", "server-contract.js"), "export const apiRoute = \"/api/products\";\n");
  git("init", "--initial-branch=main");
  git("config", "user.name", "FELTUS Design Preview Acceptance");
  git("config", "user.email", "feltus-design-preview@localhost");
  git("add", "--all");
  git("commit", "--quiet", "-m", "Disposable Design Studio preview baseline");
}

function assertDockerResourceGone(type, name) {
  const child = execFileSync;
  try {
    child("docker", [type, "inspect", name], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    return;
  }
  assert.fail("Expected Docker " + type + " " + name + " to have been removed.");
}

async function main() {
  if (!recipe) throw new Error("The e-commerce Design Recipe fixture is unavailable.");
  await fs.mkdir(fixtureRoot, { recursive: true });
  await writeFixture();

  const imageInfo = JSON.parse(docker("image", "inspect", image))[0];
  assert.equal(docker("ps", "-aq", "--filter", "label=com.feltus.preview.app-id=" + appId), "", "the disposable application ID has no pre-existing preview containers");
  assert.equal(docker("network", "ls", "-q", "--filter", "label=com.feltus.preview.app-id=" + appId), "", "the disposable application ID has no pre-existing preview networks");

  const code = createFeltusCodeHandlers({
    repoRoot: projectRoot,
    validationTempRoot: validationRoot,
    approvedTasks: { "npm-check": { command: process.execPath, args: ["scripts/check.mjs"] } }
  });
  const validateChangeSet = code.validateChangeSet.bind(code);
  code.validateChangeSet = async (...args) => {
    validationRun = await validateChangeSet(...args);
    return validationRun;
  };
  code.loadDesignCapabilities = async () => ({ models: [{ id: "products" }], relationships: [], knowledge_documents: false });
  const lifecycle = createDesignStudioLifecycle({
    app,
    code,
    userId: "design-preview-acceptance-user",
    readState: async () => readSetup(),
    saveState: saveSetup
  });
  const initialized = await lifecycle.initialize();
  assert.equal(initialized.design_state.contract, "feltus.design-state/v1");
  assert.equal(initialized.design_state.sync.source_clean, true);

  const guardrails = {
    ...initialized.design_state.brand_guardrails,
    allowed_colors: [...new Set(Object.values(recipe.tokens.colors))],
    prohibited_colors: ["#ff0000"]
  };
  const proposed = await lifecycle.propose({
    base_state_hash: designStateHash(initialized.design_state),
    summary: "Apply the guarded commerce recipe and responsive hero Canvas edit",
    actions: [
      { type: "select_recipe", recipe_id: recipe.id },
      { type: "guardrails", value: guardrails },
      { type: "edit", changes: [
        { target: "component", component_id: "hero-main", property: "variant", value: "compact" },
        { target: "component", component_id: "hero-main", property: "padding", value: "32px", responsive_target: "tablet" },
        { target: "component", component_id: "hero-main", property: "padding", value: "16px", responsive_target: "mobile" }
      ] }
    ]
  });
  assert.ok(proposed.proposal.operations.some(operation => operation.path === "index.html"));
  assert.ok(proposed.proposal.operations.some(operation => operation.path === "src/feltus-design.css"));
  const review = await lifecycle.review({ proposal_id: proposed.proposal.id });
  assert.deepEqual(review.contract_review.blocked_operations, []);
  const applied = await lifecycle.apply({ proposal_id: proposed.proposal.id, confirm_review: true });
  assert.equal(applied.ok, true);
  assert.equal(validationRun.result.code, 0, "the actual isolated CODE validation task passed before apply");
  assert.deepEqual([...applied.paths].sort(), ["index.html", "src/feltus-design.css"]);
  assert.equal(git("rev-parse", "HEAD"), applied.checkpoint, "the Design Studio checkpoint is the current Git source identity");
  assert.equal(applied.source_identity.checkpoint, applied.checkpoint);
  assert.equal(applied.source_identity.application_id, appId);
  assert.equal(applied.source_identity.source_clean, true);

  assert.equal(persistedSetup.code.design.contract, "feltus.design-state-storage/v1");
  const design = await lifecycle.get();
  assert.equal(design.design_state.active_recipe_id, recipe.id);
  assert.equal(design.design_state_hash, applied.design_state_hash);
  assert.equal(design.design_state.sync.source_checkpoint, applied.checkpoint);
  assert.equal(design.design_state.sync.source_snapshot_sha256, applied.source_identity.snapshot_sha256);
  assert.deepEqual(design.design_state.brand_guardrails.allowed_colors, guardrails.allowed_colors);
  assert.ok(design.design_state.brand_guardrails.prohibited_colors.includes("#ff0000"));
  assert.equal(git("status", "--porcelain"), "", "the CODE checkpoint is clean before Preview starts");
  const checkpointPaths = git("show", "--format=", "--name-only", "HEAD").split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(checkpointPaths, ["index.html", "src/feltus-design.css"], "the CODE change set modified only intended visual source paths");

  const sourceResult = await code.designSourceContext({ applicationId: appId });
  const sourceIdentity = sourceResult.result.source_identity;
  const sourceSnapshot = sourceResult.result.snapshot;
  assert.equal(sourceIdentity.checkpoint, applied.checkpoint);
  assert.equal(sourceIdentity.snapshot_sha256, applied.source_identity.snapshot_sha256);
  assert.equal(sourceSnapshot.snapshot_sha256, sourceIdentity.snapshot_sha256);
  assert.equal(repositorySnapshotHash(sourceSnapshot.files), sourceIdentity.snapshot_sha256);

  const htmlPath = path.join(projectRoot, "index.html");
  const cssPath = path.join(projectRoot, "src", "feltus-design.css");
  const sourceHtml = await fs.readFile(htmlPath, "utf8");
  const sourceCss = await fs.readFile(cssPath, "utf8");
  assert.match(sourceHtml, /data-feltus-variant="compact"/);
  assert.ok(sourceCss.includes("--feltus-color-primary: " + recipe.tokens.colors.primary + ";"));
  assert.match(sourceCss, /@media \(max-width: 1024px\)/);
  assert.match(sourceCss, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(sourceCss.toLowerCase(), /#ff0000/, "the prohibited Brand Guardrail color is absent from generated visual source");

  const dockerLauncher = createDockerPreviewLauncher({ workspaceRoot, scratchRoot, appId });
  preview = createPreviewManager({
    repoRoot: projectRoot,
    launchIsolatedPreview: async options => {
      launchDetails = await dockerLauncher(options);
      return launchDetails;
    },
    idleTimeoutMs: 0,
    readyTimeoutMs: 45000
  });
  const started = await preview.start();
  assert.equal(started.status, "running");
  assert.equal(started.available, true);
  assert.ok(started.url.startsWith("http://127.0.0.1:"));
  assert.ok(launchDetails?.containerName && launchDetails?.networkName && launchDetails?.snapshot);

  const container = JSON.parse(docker("inspect", launchDetails.containerName))[0];
  assert.equal(container.State.Running, true, "the isolated Docker Preview application container is running");
  assert.equal(container.Image, imageInfo.Id, "Preview used the cached Node image ID");
  assert.equal(container.Config.Image, image);
  assert.equal(container.Config.Labels["com.feltus.preview.managed"], "true");
  assert.equal(container.Config.Labels["com.feltus.preview.app-id"], appId);
  assert.equal(container.Config.Labels["com.feltus.preview.role"], "app");
  const appNetwork = JSON.parse(docker("network", "inspect", launchDetails.networkName))[0];
  assert.equal(appNetwork.Internal, true, "the rendered application runs on the isolated internal network");

  const previewSnapshot = await scanRepository(launchDetails.snapshot);
  assert.equal(previewSnapshot.complete, true);
  assert.equal(repositorySnapshotHash(previewSnapshot.files), sourceIdentity.snapshot_sha256, "Docker received the same repository snapshot hash as the Design State checkpoint");
  assert.equal(await fs.readFile(path.join(launchDetails.snapshot, "index.html"), "utf8"), sourceHtml);
  assert.equal(await fs.readFile(path.join(launchDetails.snapshot, "src", "feltus-design.css"), "utf8"), sourceCss);
  assert.equal(await fs.readFile(path.join(launchDetails.snapshot, "src", "server-contract.js"), "utf8"), "export const apiRoute = \"/api/products\";\n");

  const baseUrl = new URL(started.url + "/");
  const renderedResponse = await fetch(baseUrl);
  assert.equal(renderedResponse.status, 200);
  const renderedHtml = await renderedResponse.text();
  assert.equal(renderedHtml, sourceHtml, "the running container serves the exact reviewed application HTML source");
  assert.match(renderedHtml, /Live Design Studio Preview/);
  assert.match(renderedHtml, /data-feltus-variant="compact"/);
  const stylesheetHref = /<link[^>]+href=["']([^"']+)["'][^>]+data-feltus-design-stylesheet=["']v1["']/i.exec(renderedHtml)?.[1];
  assert.ok(stylesheetHref, "the rendered application links the generated Design Studio stylesheet");
  const renderedCssResponse = await fetch(new URL(stylesheetHref, baseUrl));
  assert.equal(renderedCssResponse.status, 200);
  const renderedCss = await renderedCssResponse.text();
  assert.equal(renderedCss, sourceCss, "the running container serves the exact reviewed Design Studio CSS source");
  assert.ok(renderedCss.includes("--feltus-color-primary: " + recipe.tokens.colors.primary + ";"));
  assert.match(renderedCss, /@media \(max-width: 1024px\)[\s\S]*--feltus-grid-columns: 8/);
  assert.match(renderedCss, /@media \(max-width: 760px\)[\s\S]*--feltus-grid-columns: 4/);
  assert.match(renderedCss, /data-feltus-id="hero-main"\]\[data-feltus-variant="compact"\]/);

  const runtimeIdentity = await (await fetch(new URL("/runtime-identity", baseUrl))).json();
  assert.equal(runtimeIdentity.preview, "1");
  assert.equal(runtimeIdentity.cwd, "/workspace");
  assert.equal(runtimeIdentity.html_sha256, crypto.createHash("sha256").update(sourceHtml).digest("hex"));
  assert.equal(runtimeIdentity.css_sha256, crypto.createHash("sha256").update(sourceCss).digest("hex"));
  const security = await (await fetch(new URL("/security-check", baseUrl))).json();
  assert.equal(security.network, "egress-blocked");
  assert.equal(security.docker_socket, false);
  assert.equal(security.sibling_workspace, false);
  assert.deepEqual(security.sensitive_environment, []);
  const runtimeFailure = await fetch(new URL("/runtime-failure", baseUrl));
  assert.equal(runtimeFailure.status, 500);
  assert.equal(await runtimeFailure.text(), "controlled runtime failure");

  const proxiedPage = await preview.proxy(appId, "/");
  assert.equal(proxiedPage.status, 200);
  assert.match(proxiedPage.body.toString(), /Live Design Studio Preview/);
  assert.match(proxiedPage.body.toString(), /feltus-preview-ready/, "Studio's preview proxy bridges the live app document");
  assert.equal(preview.status().status, "running");

  const result = {
    application_id: appId,
    branch: sourceIdentity.branch,
    checkpoint: sourceIdentity.checkpoint,
    source_snapshot_sha256: sourceIdentity.snapshot_sha256,
    design_state_hash: design.design_state_hash,
    change_set_paths: applied.paths,
    validation: { task: validationRun.task, code: validationRun.result.code },
    preview_url: started.url,
    container_id: container.Id,
    image: container.Config.Image,
    image_id: container.Image,
    image_repo_digests: imageInfo.RepoDigests || [],
    html_sha256: runtimeIdentity.html_sha256,
    css_sha256: runtimeIdentity.css_sha256
  };
  process.stdout.write("PASS Design State -> Canvas -> CODE review/isolated validation/apply/checkpoint -> Docker Preview -> rendered source\n");
  process.stdout.write("PREVIEW_EVIDENCE=" + JSON.stringify(result) + "\n");
  if (process.env.FELTUS_HOLD_PREVIEW === "1" || process.argv.includes("--hold-preview")) {
    process.stdout.write("Preview is held open for browser viewport inspection; send Enter to clean up.\n");
    await new Promise(resolve => process.stdin.once("data", resolve));
    process.stdin.pause();
  }

  await preview.stop();
  assert.equal(preview.status().status, "stopped");
  assert.equal(await fs.stat(launchDetails.snapshot).then(() => true, () => false), false, "Preview stop removed its copied source snapshot");
  assert.equal(docker("ps", "-aq", "--filter", "label=com.feltus.preview.app-id=" + appId), "", "Preview stop removed every disposable app/proxy container");
  assert.equal(docker("network", "ls", "-q", "--filter", "label=com.feltus.preview.app-id=" + appId), "", "Preview stop removed every disposable network");
  assertDockerResourceGone("container", launchDetails.containerName);
  assertDockerResourceGone("container", launchDetails.proxyName);
  assertDockerResourceGone("network", launchDetails.networkName);
  assertDockerResourceGone("network", launchDetails.proxyNetworkName);
  process.stdout.write("PASS Preview cleanup removed the isolated app/proxy containers, networks, and copied source snapshot\n");
  process.stdout.write("PASS live e-commerce Design Studio Preview acceptance\n");
}

try {
  await main();
} finally {
  if (preview) await preview.dispose().catch(() => {});
  const resolvedFixture = path.resolve(fixtureRoot);
  if (path.dirname(resolvedFixture) !== repoRoot || !path.basename(resolvedFixture).startsWith(".feltus-design-preview-integration-")) {
    throw new Error("Refusing to remove an unexpected Design Studio Preview fixture path.");
  }
  await fs.rm(resolvedFixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
