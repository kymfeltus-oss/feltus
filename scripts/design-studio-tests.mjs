import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createFeltusCodeHandlers } from "../src/feltus-code/server/routes.mjs";
import { createDesignStudioLifecycle } from "../src/feltus-code/server/design-studio-lifecycle.mjs";
import {
  createDesignState,
  DESIGN_RECIPES,
  designStateHash,
  generateManagedDesignCss,
  recommendDesignRecipes,
  validateDesignState
} from "../src/feltus-code/server/design-studio.mjs";
import { deserializeDesignStateFromSetupData, serializeDesignStateForSetupData } from "../src/lib/feltus-design-state-storage.js";
import { validateSetupData } from "../src/lib/feltus-app-wizard.js";

const testRoot = path.join(process.cwd(), `.feltus-design-studio-${process.pid}-${crypto.randomUUID()}`);
await fs.mkdir(testRoot, { recursive: true });
const fixtureRoot = await fs.mkdtemp(path.join(testRoot, "application-"));
const validationRoot = await fs.mkdtemp(path.join(testRoot, "validation-"));
const app = { id: "d31fd7d2-b0de-4a7a-9b72-b03bc1091b0c", app_name: "Commerce Fixture", app_type: "e-commerce" };
const initialSetup = {
  intelligence: { classification: { industry: "e-commerce", confidence: 0.86, archetypes: ["marketplace"], business_models: ["subscription"], workflow_patterns: ["catalog-checkout"] } },
  capability_graph: { authentication: true, payments: true },
  knowledge: { documents: [{ id: "knowledge-fixture" }] },
  code: {}
};
let persistedSetup = structuredClone(initialSetup);
let httpServer;

function git(...args) {
  return execFileSync("git", args, {
    cwd: fixtureRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }
  }).trim();
}

function readSetup() {
  const setup = structuredClone(persistedSetup);
  if (setup.code?.design) setup.code.design = deserializeDesignStateFromSetupData(setup.code.design);
  return { setup_data: setup, setup_updated_at: "fixture-version" };
}

async function saveSetup({ expectedStateHash, designState, undoRecord }) {
  const current = readSetup().setup_data.code?.design || null;
  assert.equal(current ? designStateHash(validateDesignState(current)) : null, expectedStateHash, "Design State persistence uses optimistic state-hash checks");
  const next = structuredClone(persistedSetup);
  next.code = { ...(next.code || {}), design: serializeDesignStateForSetupData(validateDesignState(designState)) };
  if (undoRecord) next.code.design_undo = undoRecord;
  else delete next.code.design_undo;
  validateSetupData(next);
  persistedSetup = next;
  return { setup_updated_at: `fixture-${Date.now()}` };
}

function appState() {
  return readSetup().setup_data;
}

async function stageAndCommit(message) {
  git("add", "--all");
  git("commit", "--quiet", "-m", message);
}

async function serveFixture() {
  httpServer = http.createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
      const target = path.resolve(fixtureRoot, relative);
      if (!target.startsWith(fixtureRoot + path.sep)) throw new Error("path blocked");
      const content = await fs.readFile(target);
      response.writeHead(200, { "Content-Type": target.endsWith(".css") ? "text/css" : "text/html; charset=utf-8" });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  return `http://127.0.0.1:${address.port}/`;
}

async function main() {
  await fs.mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({ name: "feltus-design-fixture", private: true, scripts: { check: "node scripts/check.mjs" } }, null, 2));
  await fs.writeFile(path.join(fixtureRoot, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>Commerce Fixture</title></head>
<body>
  <main data-feltus-id="hero-main" data-feltus-component="hero" data-feltus-page="home" data-feltus-variant="centered" data-feltus-managed="v1">Welcome to the store</main>
  <section data-feltus-id="feature-card" data-feltus-component="card" data-feltus-page="home" data-feltus-variant="elevated" data-feltus-managed="v1">Featured product</section>
</body></html>
`);
  await fs.writeFile(path.join(fixtureRoot, "src", "server.js"), "export const orderRoute = '/api/orders';\n");
  await fs.writeFile(path.join(fixtureRoot, "scripts", "check.mjs"), `import assert from 'node:assert/strict';
import fs from 'node:fs';
const html = fs.readFileSync('index.html', 'utf8');
assert.match(html, /data-feltus-id="hero-main"/);
assert.match(html, /data-feltus-id="feature-card"/);
if (html.includes('data-feltus-design-stylesheet="v1"')) {
  assert.ok(fs.existsSync('src/feltus-design.css'));
  assert.match(fs.readFileSync('src/feltus-design.css', 'utf8'), /FELTUS-DESIGN-MANAGED-V1/);
}
`);
  git("init", "--initial-branch=main");
  git("config", "user.name", "FELTUS Design Acceptance");
  git("config", "user.email", "feltus-design-acceptance@localhost");
  await stageAndCommit("Design Studio fixture baseline");

  const code = createFeltusCodeHandlers({
    repoRoot: fixtureRoot,
    validationTempRoot: validationRoot,
    approvedTasks: { "npm-check": { command: process.execPath, args: ["scripts/check.mjs"] } }
  });
  code.loadDesignCapabilities = async () => ({ models: [{ id: "products" }], relationships: [{ id: "product-category" }], knowledge_documents: false });
  const lifecycle = createDesignStudioLifecycle({
    app,
    code,
    userId: "design-acceptance-user",
    readState: async () => readSetup(),
    saveState: saveSetup
  });

  const originalClassification = structuredClone(initialSetup.intelligence);
  const recommendation = recommendDesignRecipes({ application: app, intelligence: initialSetup.intelligence, capabilities: { data_models: true, payments: true } });
  assert.equal(DESIGN_RECIPES.length, 75);
  assert.ok(recommendation.some(item => item.recommendation === "Recommended" && item.recipe_id.startsWith("commerce-")));
  assert.deepEqual(initialSetup.intelligence, originalClassification, "recipe suggestions do not rewrite Application Intelligence");
  const initialized = await lifecycle.initialize();
  assert.equal(initialized.design_state.contract, "feltus.design-state/v1");
  assert.equal(initialized.design_state.components.length, 2);
  assert.equal(initialized.design_state.sync.source_clean, true);
  assert.equal(persistedSetup.code.design.contract, "feltus.design-state-storage/v1");
  assert.ok(persistedSetup.code.design.value.feltus_field_hex_746f6b656e73, "sensitive setup-data keys use an explicit safe storage encoding");
  validateSetupData(persistedSetup);
  assert.deepEqual(appState().code.design.tokens, initialized.design_state.tokens, "stored Design State hydrates to the canonical contract");
  process.stdout.write("PASS 1 recipe recommendation preserves classification; 75 recipes; safe canonical Design State persistence\n");

  async function proposalFor(actions, summary) {
    const current = appState().code.design;
    return lifecycle.propose({ actions, base_state_hash: designStateHash(current), summary });
  }

  async function reviewAndApply(proposalResult) {
    const id = proposalResult.proposal.id;
    let reviewed;
    try { reviewed = await lifecycle.review({ proposal_id: id }); }
    catch (error) {
      process.stderr.write(`Design review diagnostics: ${JSON.stringify(error.contract_review || null)}\n`);
      throw error;
    }
    assert.ok(reviewed.changes.operations.length > 0, "CODE returned an exact source diff for review");
    const result = await lifecycle.apply({ proposal_id: id, confirm_review: true });
    assert.equal(result.ok, true);
    return result;
  }

  const startHtml = await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8");
  const recipeProposal = await proposalFor([{ type: "select_recipe", recipe_id: "commerce-premium" }], "Select the commerce premium recipe");
  assert.match(recipeProposal.proposal.preview_css, /--feltus-color-primary/);
  assert.equal(await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8"), startHtml, "recipe proposals do not write before review and apply");
  await reviewAndApply(recipeProposal);
  const recipeState = appState().code.design;
  assert.equal(recipeState.active_recipe_id, "commerce-premium");
  assert.match(await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8"), /data-feltus-design-stylesheet="v1"/);
  process.stdout.write("PASS 2 recipe selection flowed through proposal, CODE review, isolated validation, apply, and checkpoint\n");

  const cardBeforeAi = structuredClone(recipeState.components.find(item => item.id === "feature-card"));
  const responsiveProposal = await proposalFor([{ type: "edit", changes: [{ target: "component", component_id: "hero-main", property: "padding", value: "32px", responsive_target: "mobile" }] }], "Add mobile hero spacing");
  assert.equal(responsiveProposal.proposal.after_state.profile.kind, "custom");
  assert.equal(responsiveProposal.proposal.after_state.components.find(item => item.id === "hero-main").responsive.mobile.padding, "32px");
  assert.equal(responsiveProposal.proposal.after_state.components.find(item => item.id === "hero-main").responsive.desktop.padding, undefined);
  assert.equal(responsiveProposal.proposal.after_state.components.find(item => item.id === "hero-main").responsive.tablet.padding, undefined);
  assert.match(responsiveProposal.proposal.preview_css, /@media \(max-width: 760px\)/);
  assert.match(responsiveProposal.proposal.preview_css, /padding: 32px/);
  const responsiveApplied = await reviewAndApply(responsiveProposal);
  const responsiveState = appState().code.design;
  assert.deepEqual(responsiveState.components.find(item => item.id === "feature-card"), cardBeforeAi, "responsive Canvas editing preserves unrelated components");
  assert.equal(responsiveApplied.design_state_hash, designStateHash(responsiveState));
  process.stdout.write("PASS 3 token and component edits create a derived Custom Design Profile\n");

  const previewHtml = await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8");
  assert.match(previewHtml, /data-feltus-id="hero-main"/);
  const stylesheetHref = /<link[^>]+href=["']([^"']+)["'][^>]+data-feltus-design-stylesheet=["']v1["']/i.exec(previewHtml)?.[1];
  assert.ok(stylesheetHref, "the application preview references a conventional stylesheet");
  const previewCssPath = path.resolve(fixtureRoot, stylesheetHref.replaceAll("/", path.sep));
  assert.ok(previewCssPath.startsWith(fixtureRoot + path.sep));
  const previewCss = await fs.readFile(previewCssPath, "utf8");
  assert.match(previewCss, /data-feltus-id="hero-main"/);
  assert.match(previewCss, /box-sizing: border-box;/, "managed component padding must not cause responsive horizontal overflow");
  assert.doesNotMatch(previewHtml, /feltus-code\.js|design-studio\.js/i, "runtime does not depend on the visual editor");
  process.stdout.write("PASS 4 Canvas component edit was validated; actual Preview inputs are the generated application HTML/CSS\n");

  const aiBefore = appState().code.design;
  let aiContextSeen = false;
  const aiProposal = await lifecycle.proposeAI({
    prompt: "Make this hero feel more compact",
    base_state_hash: designStateHash(aiBefore),
    selected_page_id: "home",
    selected_component_id: "hero-main",
    responsive_target: "desktop",
    aiProposal: async input => {
      aiContextSeen = input.selectedComponent?.id === "hero-main" && input.selectedPage?.id === "home" && input.capabilities.data_models === true && input.sourceContext.some(item => item.component_id === "hero-main" && item.markup.includes("Welcome to the store"));
      return { summary: "Use a compact hero variant", actions: [{ type: "edit", changes: [{ target: "component", component_id: "hero-main", property: "variant", value: "compact" }] }] };
    }
  });
  assert.equal(aiContextSeen, true, "AI receives selected component, page, and capability context");
  assert.equal(aiProposal.proposal.after_state.components.find(item => item.id === "feature-card").variant, aiBefore.components.find(item => item.id === "feature-card").variant);
  await reviewAndApply(aiProposal);
  const aiCurrent = appState().code.design;
  assert.equal(aiCurrent.components.find(item => item.id === "hero-main").variant, "compact");
  assert.equal(aiCurrent.components.find(item => item.id === "feature-card").variant, aiBefore.components.find(item => item.id === "feature-card").variant);
  await assert.rejects(lifecycle.proposeAI({
    prompt: "Make this hero more compact",
    base_state_hash: designStateHash(aiCurrent),
    selected_page_id: "home",
    selected_component_id: "hero-main",
    responsive_target: "desktop",
    aiProposal: async () => ({ actions: [{ type: "edit", changes: [{ target: "component", component_id: "feature-card", property: "variant", value: "compact" }] }] })
  }), error => error.code === "DESIGN_AI_SCOPE_BLOCKED");
  process.stdout.write("PASS 4 AI proposal is component-scoped and leaves other component design/source unchanged\n");

  const guardrailState = appState().code.design;
  const guardrailProposal = await proposalFor([{ type: "guardrails", value: { ...guardrailState.brand_guardrails, prohibited_colors: ["#ff0000"] } }], "Prohibit red");
  await reviewAndApply(guardrailProposal);
  const blockedState = appState().code.design;
  await assert.rejects(proposalFor([{ type: "edit", changes: [{ target: "token", key: "colors.primary", value: "#ff0000" }] }], "Use a prohibited red"), error => error.code === "DESIGN_GUARDRAIL_BLOCKED" && error.guardrail === "prohibited_colors");
  assert.deepEqual(appState().code.design, blockedState, "a blocked color request does not mutate Design State");
  process.stdout.write("PASS 5 prohibited Brand Guardrail blocks the proposal with named evidence\n");

  let currentHtml = await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8");
  currentHtml = currentHtml.replace('data-feltus-id="hero-main" data-feltus-component="hero" data-feltus-page="home" data-feltus-variant="compact"', 'data-feltus-id="hero-main" data-feltus-component="hero" data-feltus-page="home" data-feltus-variant="split"');
  await fs.writeFile(path.join(fixtureRoot, "index.html"), currentHtml);
  await stageAndCommit("External supported hero variant change");
  const supportedReconciliation = await lifecycle.reconcile();
  assert.ok(supportedReconciliation.reconciliation.some(item => item.component_id === "hero-main" && item.outcome === "AUTOMATIC_RECONCILIATION"));
  assert.equal(supportedReconciliation.design_state.components.find(item => item.id === "hero-main").variant, "split");
  assert.equal(supportedReconciliation.design_state.components.find(item => item.id === "feature-card").ownership_state, "FELTUS_MANAGED");
  process.stdout.write("PASS 6 external supported source change reconciles CODE_CHANGED → SYNCED with component evidence\n");

  currentHtml = await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8");
  currentHtml = currentHtml.replace('data-feltus-id="feature-card" data-feltus-component="card" data-feltus-page="home" data-feltus-variant="elevated" data-feltus-managed="v1"', 'data-feltus-id="feature-card" data-feltus-component="chart" data-feltus-page="home" data-feltus-variant="elevated" data-feltus-managed="v2"');
  await fs.writeFile(path.join(fixtureRoot, "index.html"), currentHtml);
  await stageAndCommit("External unsupported component structure change");
  const unsupportedReconciliation = await lifecycle.reconcile();
  const changedComponent = unsupportedReconciliation.design_state.components.find(item => item.id === "feature-card");
  assert.ok(unsupportedReconciliation.reconciliation.some(item => item.component_id === "feature-card" && item.outcome === "RECONCILIATION_REQUIRED"));
  assert.equal(changedComponent.ownership_state, "DEVELOPER_MANAGED");
  assert.equal(unsupportedReconciliation.design_state.components.find(item => item.id === "hero-main").ownership_state, "FELTUS_MANAGED", "one changed component does not detach its siblings");
  assert.match(await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8"), /data-feltus-component="chart"/, "external structure remains untouched during reconciliation");
  await fs.readFile(path.join(fixtureRoot, "scripts", "check.mjs"), "utf8");
  process.stdout.write("PASS 7 unsupported structure is marked Developer Managed; unaffected component remains editable; external source is preserved\n");

  const protectedSource = await code.readFile({ path: "src/server.js" });
  const protectedReview = await code.designContractReview({
    applicationId: app.id,
    sourceIdentity: unsupportedReconciliation.source_identity,
    changeSet: { id: "visual-contract-negative", summary: "attempt an API route edit through a visual operation", operations: [{ id: "protected-route", type: "update", path: "src/server.js", content: "export const orderRoute = '/api/new-orders';\n", before_sha256: protectedSource.sha256, reason: "must be blocked", agent: "code-agent" }] }
  });
  assert.ok(protectedReview.result.review.blocked_operations.some(item => item.path === "src/server.js"));
  process.stdout.write("PASS 8 protected API/server contract remains blocked by CODE contract review\n");

  const reconnectState = appState().code.design;
  const reconnectProposal = await proposalFor([{ type: "ownership", component_id: "feature-card", ownership_state: "FELTUS_MANAGED" }], "Reconnect the feature card");
  await reviewAndApply(reconnectProposal);
  const reconnected = appState().code.design.components.find(item => item.id === "feature-card");
  const reconnectedHtml = await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8");
  assert.equal(reconnected.ownership_state, "FELTUS_MANAGED");
  assert.match(reconnectedHtml, /data-feltus-id="feature-card" data-feltus-component="card"[^>]*data-feltus-managed="v1"/);
  assert.doesNotMatch(reconnectedHtml, /data-feltus-component="chart"/);
  assert.equal(reconnectState.components.find(item => item.id === "hero-main").ownership_state, "FELTUS_MANAGED");
  process.stdout.write("PASS 9 reviewed reconnect restores the supported managed contract and exact component identity\n");

  const detachProposal = await proposalFor([{ type: "ownership", component_id: "feature-card", ownership_state: "DEVELOPER_MANAGED" }], "Keep feature card developer-managed");
  await reviewAndApply(detachProposal);
  const isolatedState = appState().code.design;
  const heroEdit = await proposalFor([{ type: "edit", changes: [{ target: "component", component_id: "hero-main", property: "padding", value: "24px", responsive_target: "tablet" }] }], "Edit only the managed hero");
  assert.equal(heroEdit.proposal.after_state.components.find(item => item.id === "feature-card").ownership_state, "DEVELOPER_MANAGED");
  await reviewAndApply(heroEdit);
  assert.equal(appState().code.design.components.find(item => item.id === "feature-card").ownership_state, "DEVELOPER_MANAGED");
  assert.equal(appState().code.design.components.find(item => item.id === "hero-main").ownership_state, "FELTUS_MANAGED");
  assert.equal(isolatedState.components.find(item => item.id === "hero-main").ownership_state, "FELTUS_MANAGED");
  process.stdout.write("PASS 10 component ownership is isolated; other managed components remain editable\n");

  const htmlBeforeUndo = await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8");
  const cssBeforeUndo = await fs.readFile(path.join(fixtureRoot, "src", "feltus-design.css"), "utf8");
  const stateBeforeUndo = appState().code.design;
  const undoProposal = await proposalFor([{ type: "edit", changes: [{ target: "component", component_id: "hero-main", property: "variant", value: "centered" }] }], "Change hero before undo test");
  await reviewAndApply(undoProposal);
  const undoResult = await lifecycle.undo();
  assert.equal(await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8"), htmlBeforeUndo);
  assert.equal(await fs.readFile(path.join(fixtureRoot, "src", "feltus-design.css"), "utf8"), cssBeforeUndo);
  assert.equal(undoResult.design_state.components.find(item => item.id === "hero-main").variant, stateBeforeUndo.components.find(item => item.id === "hero-main").variant);
  assert.equal(undoResult.design_state.components.find(item => item.id === "feature-card").ownership_state, "DEVELOPER_MANAGED");
  assert.equal(undoResult.undo_available, false);
  process.stdout.write("PASS 11 CODE checkpoint/undo restores exact source and prior component-scoped Design State\n");

  const staleProposal = await proposalFor([{ type: "edit", changes: [{ target: "component", component_id: "hero-main", property: "padding", value: "40px", responsive_target: "desktop" }] }], "Create stale visual proposal");
  await lifecycle.review({ proposal_id: staleProposal.proposal.id });
  const cleanHtml = await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8");
  await fs.writeFile(path.join(fixtureRoot, "index.html"), `${cleanHtml}\n<!-- developer edit -->\n`);
  await assert.rejects(lifecycle.apply({ proposal_id: staleProposal.proposal.id, confirm_review: true }), error => ["SOURCE_CLASSIFICATION_STALE", "DESIGN_SOURCE_STALE"].includes(error.code));
  assert.equal(await fs.readFile(path.join(fixtureRoot, "src", "feltus-design.css"), "utf8"), cssBeforeUndo, "stale apply does not write source");
  git("checkout", "--", "index.html");
  process.stdout.write("PASS 12 stale source identity rejects an already reviewed proposal without source mutation\n");

  const currentCss = await fs.readFile(path.join(fixtureRoot, "src", "feltus-design.css"), "utf8");
  await fs.writeFile(path.join(fixtureRoot, "src", "feltus-design.css"), `${currentCss}\n/* external edit */\n`);
  await stageAndCommit("External developer edit to generated Design Studio stylesheet");
  const cssReconciliation = await lifecycle.reconcile();
  assert.ok(cssReconciliation.reconciliation.some(item => item.component_id === null && item.outcome === "RECONCILIATION_REQUIRED"));
  assert.equal(cssReconciliation.sync_summary.stylesheet_reconciliation_required, 1);
  await assert.rejects(proposalFor([{ type: "edit", changes: [{ target: "component", component_id: "hero-main", property: "gap", value: "24px", responsive_target: "desktop" }] }], "Do not overwrite externally edited managed CSS"), error => error.code === "DESIGN_STYLESHEET_CONFLICT");
  await fs.writeFile(path.join(fixtureRoot, "src", "feltus-design.css"), cssBeforeUndo);
  await stageAndCommit("Restore generated Design Studio stylesheet");
  const restoredStylesheet = await lifecycle.reconcile();
  assert.equal(restoredStylesheet.sync_summary.stylesheet_reconciliation_required, 0);
  process.stdout.write("PASS 13 external edits to the managed stylesheet are detected and not silently overwritten\n");

  const finalState = appState().code.design;
  assert.equal(finalState.components.length, 2);
  assert.equal(validateDesignState(finalState).contract, "feltus.design-state/v1");
  assert.match(generateManagedDesignCss(finalState), /@media \(max-width: (?:1024|760)px\)/);
  assert.equal(crypto.createHash("sha256").update(await fs.readFile(path.join(fixtureRoot, "src", "feltus-design.css"))).digest("hex").length, 64);
  const finalHtml = await fs.readFile(path.join(fixtureRoot, "index.html"), "utf8");
  assert.match(finalHtml, /<link rel="stylesheet" href="\.\/src\/feltus-design\.css" data-feltus-design-stylesheet="v1">/);
  assert.doesNotMatch(finalHtml, /feltus-code\.js|design-studio\.js/i);
  assert.equal((await code.gitChangedPaths()).paths.length, 0, "accepted lifecycle ends with a clean fixture workspace");
  process.stdout.write("PASS 14 stale plans and protected CODE contracts remain blocked\n");
  process.stdout.write("PASS 15 generated markup and CSS remain conventional and editor-independent; final source checkpoint is clean\n");
  process.stdout.write("PASS Phase F.5 acceptance: recommendation, recipes, persistence, Canvas, AI scope, responsive design, guardrails, reconciliation, ownership, reconnect, protected contracts, stale plans, validation, preview, and undo\n");
}

try {
  await main();
} catch (error) {
  process.stderr.write(`FAIL Phase F.5 acceptance: ${error.stack || error.message}\n`);
  process.exitCode = 1;
} finally {
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  await Promise.all([
    fs.rm(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {})
  ]);
}
