import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  evaluateReleaseReadiness,
  readinessBindings,
  resolveStoredReleaseReadiness
} from "../src/feltus-code/server/release-readiness.mjs";
import {
  applyInfrastructureRepositoryVerification,
  INFRASTRUCTURE_COMPONENTS,
  INFRASTRUCTURE_CONTRACT,
  managedMutationPolicy,
  normalizeInfrastructureConfiguration,
  resolveInfrastructureContract
} from "../src/lib/feltus-infrastructure-contract.js";
import { createFeltusCodeHandlers } from "../src/feltus-code/server/routes.mjs";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const COMMIT_B = "c".repeat(40);
const SNAPSHOT_B = "d".repeat(64);
const tempParent = await fs.realpath(process.env.FELTUS_TEST_TMPDIR || os.tmpdir());
const tempRootPrefix = ".feltus-release-readiness-tests-";
const tempRoot = await fs.mkdtemp(path.join(tempParent, tempRootPrefix));
let readyFixture = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" }
  }).trim();
}

async function write(root, relative, content) {
  const target = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function createReadyFixture() {
  const root = path.join(tempRoot, "ready-app");
  await fs.mkdir(root, { recursive: true });
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "FELTUS tests"]);
  git(root, ["config", "user.email", "tests@localhost"]);
  await write(root, "package.json", JSON.stringify({
    name: "phase-g-ready-fixture",
    private: true,
    type: "module",
    packageManager: "npm@10.0.0",
    scripts: {
      check: "node --check src/index.js",
      test: "node --test",
      build: "node scripts/build.mjs"
    }
  }));
  await write(root, "src/index.js", "export function label() { return 'ready'; }\n");
  await write(root, "test/label.test.js", "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/index.js';\ntest('label', () => assert.equal(label(), 'ready'));\n");
  await write(root, "scripts/build.mjs", "process.stdout.write('build ok\\n');\n");
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", "ready fixture"]);
  const handlers = createFeltusCodeHandlers({ repoRoot: root, validationTempRoot: path.join(tempRoot, "validation-workspaces") });
  const overview = (await handlers.productionizationOverview({ applicationId: APP_ID })).result;
  const validation = (await handlers.productionizationValidate({
    applicationId: APP_ID,
    sourceCheckpointId: overview.source_checkpoint,
    sourceSnapshotSha256: overview.source_snapshot_sha256,
    classifierVersion: overview.classification.classifier_version
  })).result;
  const run = clone(validation.run);
  run.source_checkpoint_recorded = true;
  assert.equal(run.status, "READY_FOR_RELEASE", JSON.stringify(run.checks, null, 2));
  assert(run.checks.some(item => item.id === "source.check" && item.status === "PASSED"));
  assert(run.checks.some(item => item.id === "source.tests" && item.status === "PASSED"));
  assert(run.checks.some(item => item.id === "source.build" && item.status === "PASSED"));
  return {
    root,
    overview,
    validation,
    run,
    source: {
      application_id: APP_ID,
      workspace_id: run.source_workspace_id,
      branch: run.source_branch,
      checkpoint: run.source_checkpoint_id,
      source_commit: run.source_commit,
      source_snapshot_sha256: run.source_snapshot_sha256,
      source_snapshot_complete: run.source_snapshot_complete,
      classifier_version: run.classifier_version
    }
  };
}

function source({ commit = readyFixture.source.source_commit, snapshot = readyFixture.source.source_snapshot_sha256 } = {}) {
  return {
    application_id: APP_ID,
    workspace_id: readyFixture.source.workspace_id,
    branch: readyFixture.source.branch,
    checkpoint: commit,
    source_commit: commit,
    source_snapshot_sha256: snapshot,
    source_snapshot_complete: true,
    classifier_version: readyFixture.source.classifier_version
  };
}

function classification(overrides = {}) {
  return { ...clone(readyFixture.validation.classification), evidence_refs: ["fixture.repository-classification"], ...overrides };
}

function passedChecks() {
  return clone(readyFixture.run.checks);
}

function run(overrides = {}) {
  return { ...clone(readyFixture.run), checks: passedChecks(), ...overrides };
}

function baseInput(overrides = {}) {
  const currentRun = run();
  return {
    sourceIdentity: source(),
    classification: classification(),
    productionization: {
      run: currentRun,
      is_current: true,
      stale: false,
      evidence_refs: ["fixture.productionization-run"]
    },
    validation: { run: currentRun, checks: currentRun.checks },
    design: { applicable: false, evidence_refs: ["fixture.design-not-applicable"] },
    configuration: { required: [], configured_names: [], evidence_refs: ["fixture.application-configuration"] },
    environment: { required: false, evidence_refs: ["fixture.environment-not-applicable"] },
    ...overrides
  };
}

function infrastructureConfiguration(mode, overrides = {}) {
  const defaultOwner = mode === "CUSTOMER_MANAGED"
    ? "CUSTOMER"
    : mode === "EXISTING_APPLICATION"
      ? "EXTERNAL_PROVIDER"
      : "FELTUS";
  const defaultManagement = {
    FELTUS: "FELTUS_MANAGED",
    CUSTOMER: "CUSTOMER_MANAGED",
    EXTERNAL_PROVIDER: "CONNECTED_EXTERNAL"
  };
  return {
    contract: INFRASTRUCTURE_CONTRACT,
    mode,
    components: Object.fromEntries(INFRASTRUCTURE_COMPONENTS.map(name => {
      const owner = overrides[name]?.owner || (mode === "HYBRID" && name === "database" ? "CUSTOMER" : defaultOwner);
      return [name, {
        owner,
        management: overrides[name]?.management || defaultManagement[owner],
        status: overrides[name]?.status || (mode === "EXISTING_APPLICATION" ? "UNKNOWN" : "CONFIGURED"),
        ...(overrides[name]?.resource_reference ? { resource_reference: overrides[name].resource_reference } : {})
      }];
    }))
  };
}

function check(result, id) {
  const match = result.checks.find(item => item.id === id);
  assert.ok(match, `Expected readiness check ${id}`);
  return match;
}

const cases = [];
function test(name, callback) {
  cases.push({ name, callback });
}

test("1 fully ready application", () => {
  const result = evaluateReleaseReadiness(baseInput());
  assert.equal(result.state, "READY");
  assert.equal(result.ready_for_release, true);
});

test("2 stale repository classification", () => {
  const result = evaluateReleaseReadiness(baseInput({ classification: classification({ stale: true, is_current: false }) }));
  assert.equal(result.state, "BLOCKED");
  assert.equal(check(result, "code.repository-classification").gate, "BLOCKING");
});

test("3 stale productionization plan", () => {
  const input = baseInput();
  input.productionization.stale = true;
  const result = evaluateReleaseReadiness(input);
  assert.equal(result.state, "BLOCKED");
  assert.equal(check(result, "security.productionization").gate, "BLOCKING");
});

test("4 failing syntax", () => {
  const input = baseInput();
  input.validation.checks = passedChecks();
  const syntaxIndex = input.validation.checks.findIndex(item => item.id === "source.check");
  assert.ok(syntaxIndex >= 0, "Expected real configured syntax check");
  input.validation.checks[syntaxIndex] = { ...input.validation.checks[syntaxIndex], status: "FAILED", exit_code: 1, output_summary: "syntax failed" };
  input.productionization.run = { ...input.productionization.run, status: "BLOCKED", checks: input.validation.checks };
  input.validation.run = input.productionization.run;
  const result = evaluateReleaseReadiness(input);
  assert.equal(result.state, "NOT_READY");
  assert.equal(check(result, "validation.source.check").gate, "BLOCKING");
});

test("5 failing tests", () => {
  const input = baseInput();
  input.validation.checks = passedChecks();
  input.validation.checks[1] = { ...input.validation.checks[1], status: "FAILED", exit_code: 1, output_summary: "test failed" };
  input.productionization.run = { ...input.productionization.run, status: "BLOCKED", checks: input.validation.checks };
  input.validation.run = input.productionization.run;
  const result = evaluateReleaseReadiness(input);
  assert.equal(result.state, "NOT_READY");
  assert.equal(check(result, "validation.source.tests").category, "Tests");
});

test("6 missing applicable build requirement", () => {
  const input = baseInput();
  input.validation.checks = passedChecks().filter(item => item.id !== "source.build");
  const result = evaluateReleaseReadiness(input);
  assert.equal(result.state, "NOT_READY");
  assert.equal(check(result, "build.requirement").gate, "BLOCKING");
});

test("7 protected contract violation", () => {
  const input = baseInput();
  input.productionization.blocked_contract_changes = [{ path: "src/server.js" }];
  const result = evaluateReleaseReadiness(input);
  assert.equal(result.state, "BLOCKED");
  assert.equal(check(result, "security.protected-contracts").gate, "BLOCKING");
});

test("8 Design Studio reconciliation required", () => {
  const input = baseInput({
    design: {
      applicable: true,
      design_state_hash: "e".repeat(64),
      source_identity: source(),
      components: [{ id: "hero", ownership_state: "FELTUS_MANAGED", reconciliation_state: "REQUIRED", sync_state: "RECONCILIATION_REQUIRED" }],
      reconciliation: [{ component_id: "hero", outcome: "RECONCILIATION_REQUIRED" }],
      sync_summary: { reconciliation_required: 1, stylesheet_reconciliation_required: 0 },
      evidence_refs: ["fixture.design-reconciliation"]
    }
  });
  const result = evaluateReleaseReadiness(input);
  assert.equal(result.state, "REVIEW_REQUIRED");
  assert.equal(check(result, "design.reconciliation").gate, "REVIEW REQUIRED");
});

test("9 valid Developer Managed component", () => {
  const input = baseInput({
    design: {
      applicable: true,
      design_state_hash: "f".repeat(64),
      source_identity: source(),
      components: [{ id: "hero", ownership_state: "DEVELOPER_MANAGED", reconciliation_state: "NOT_REQUIRED", sync_state: "SYNCED" }],
      reconciliation: [{ component_id: "hero", outcome: "DEVELOPER_VERSION_PRESERVED" }],
      sync_summary: { developer_managed: 1, reconciliation_required: 0, stylesheet_reconciliation_required: 0 },
      evidence_refs: ["fixture.design-developer-managed"]
    }
  });
  const result = evaluateReleaseReadiness(input);
  assert.equal(result.state, "READY");
  assert.equal(check(result, "design.state").result, "PASSED");
});

test("10 source changed after evaluation", () => {
  const evaluated = evaluateReleaseReadiness(baseInput());
  const changed = source({ commit: COMMIT_B, snapshot: SNAPSHOT_B });
  const current = {
    source_identity: changed,
    bindings: readinessBindings({ configuration: {}, environment: {}, design: { applicable: false } })
  };
  const resolved = resolveStoredReleaseReadiness(evaluated, current);
  assert.equal(resolved.state, "STALE");
  assert.equal(resolved.build_eligibility.eligible, false);
});

test("11 successful reevaluation", () => {
  const changedSource = source({ commit: COMMIT_B, snapshot: SNAPSHOT_B });
  const changedClassification = classification({
    source_checkpoint_id: COMMIT_B,
    source_commit: COMMIT_B,
    source_snapshot_sha256: SNAPSHOT_B
  });
  const changedRun = run({
    source_checkpoint_id: COMMIT_B,
    source_commit: COMMIT_B,
    source_snapshot_sha256: SNAPSHOT_B
  });
  const reevaluated = evaluateReleaseReadiness(baseInput({
    sourceIdentity: changedSource,
    classification: changedClassification,
    productionization: { run: changedRun, is_current: true, evidence_refs: ["fixture.reevaluated-run"] },
    validation: { run: changedRun, checks: changedRun.checks }
  }));
  const resolved = resolveStoredReleaseReadiness(reevaluated, {
    source_identity: changedSource,
    bindings: readinessBindings({ configuration: {}, environment: {}, design: { applicable: false } })
  });
  assert.equal(resolved.state, "READY");
  assert.equal(resolved.source_identity.source_snapshot_sha256, SNAPSHOT_B);
});

test("12 non-applicable check", () => {
  const input = baseInput({ classification: classification({ build_systems: [] }) });
  input.validation.checks = passedChecks().filter(item => item.id !== "source.build");
  const result = evaluateReleaseReadiness(input);
  assert.equal(result.state, "READY");
  assert.equal(check(result, "build.requirement").gate, "NOT APPLICABLE");
});

test("13 progressive disclosure summary matches detail", () => {
  const input = baseInput();
  input.validation.checks = passedChecks();
  input.validation.checks[1] = { ...input.validation.checks[1], status: "FAILED", exit_code: 1 };
  const result = evaluateReleaseReadiness(input);
  const detail = result.progressive_disclosure.detailed_evidence;
  assert.equal(result.summary.blocking_count, detail.filter(item => item.gate === "BLOCKING").length);
  assert.equal(result.summary.review_required_count, detail.filter(item => item.gate === "REVIEW REQUIRED").length);
  assert.equal(result.progressive_disclosure.categories.reduce((sum, item) => sum + item.check_count, 0), detail.length);
});

test("14 critical evidence traceability", () => {
  const input = baseInput();
  input.productionization.blocked_contract_changes = [{ path: "src/server.js" }];
  input.validation.checks = passedChecks();
  input.validation.checks[0] = { ...input.validation.checks[0], output_summary: "API_KEY=supersecret" };
  const result = evaluateReleaseReadiness(input);
  const critical = check(result, "security.protected-contracts");
  assert.ok(critical.evidence.summary);
  assert.ok(critical.evidence.references.length > 0);
  assert.equal(critical.source_identity.source_snapshot_sha256, readyFixture.source.source_snapshot_sha256);
  assert.ok(critical.evaluated_at);
  assert.equal(JSON.stringify(result).includes("supersecret"), false);
});

test("15 readiness to build eligibility boundary", () => {
  const result = evaluateReleaseReadiness(baseInput());
  assert.equal(result.state, "READY");
  assert.equal(result.build_eligibility.eligible, true);
  assert.equal(result.build_eligibility.requires_explicit_build_action, true);
  assert.equal(Object.hasOwn(result, "build_started"), false);
});

test("16 ownership contract represents all four modes", () => {
  for (const mode of ["FELTUS_MANAGED", "CUSTOMER_MANAGED", "HYBRID", "EXISTING_APPLICATION"]) {
    const configuration = normalizeInfrastructureConfiguration(infrastructureConfiguration(mode));
    assert.equal(configuration.mode, mode);
    assert.equal(Object.keys(configuration.components).length, INFRASTRUCTURE_COMPONENTS.length);
  }
});

test("17 hybrid/customer ownership is not independently verified", () => {
  const configuration = infrastructureConfiguration("HYBRID", {
    database: { owner: "CUSTOMER", resource_reference: "customer-db-1" }
  });
  const infrastructure = resolveInfrastructureContract({
    app: { setup_data: { infrastructure: configuration } }
  });
  assert.equal(infrastructure.mode, "HYBRID");
  assert.equal(infrastructure.components.database.owner, "CUSTOMER");
  assert.equal(infrastructure.components.database.verification.status, "UNVERIFIED");
  assert.equal(managedMutationPolicy(infrastructure, ["database"]).allowed, false);
  assert.equal(managedMutationPolicy(infrastructure, ["build_execution"]).allowed, true);

  const ambiguousRepositories = resolveInfrastructureContract({
    app: { setup_data: {} },
    inputs: {
      repoLinks: [{ repository_id: "repo-a" }, { repository_id: "repo-b" }],
      repositories: [
        { id: "repo-a", repository_name: "one/app" },
        { id: "repo-b", repository_name: "two/app" }
      ]
    }
  });
  assert.equal(ambiguousRepositories.components.source_repository.status, "PARTIAL");
  assert.equal(ambiguousRepositories.components.source_repository.verification.status, "UNVERIFIED");
});

test("18 existing Coolify target remains FELTUS-managed and uses verified worker evidence", () => {
  const infrastructure = resolveInfrastructureContract({
    app: { setup_data: {} },
    inputs: {
      targets: [{ id: "target-1", provider_key: "coolify", active: true }],
      observations: [{ health: "healthy", observed_at: "2026-11-08T10:00:00.000Z" }]
    },
    buildWorkerReady: true,
    deploymentWorkerReady: true
  });
  assert.equal(infrastructure.components.runtime_hosting.owner, "FELTUS");
  assert.equal(infrastructure.components.runtime_hosting.verification.status, "VERIFIED");
  assert.equal(infrastructure.components.deployment_execution.verification.status, "VERIFIED");
  assert.equal(infrastructure.components.build_execution.verification.status, "VERIFIED");
});

test("19 unverified external infrastructure is a readiness warning and ownership changes stale readiness", () => {
  const infrastructure = resolveInfrastructureContract({
    app: { setup_data: { infrastructure: infrastructureConfiguration("CUSTOMER_MANAGED") } }
  });
  const evaluated = evaluateReleaseReadiness(baseInput({ infrastructure }));
  const databaseCheck = check(evaluated, "infrastructure.database");
  assert.equal(databaseCheck.gate, "WARNING");
  assert.equal(databaseCheck.result, "NOT_RUN");
  const changedInfrastructure = resolveInfrastructureContract({
    app: { setup_data: { infrastructure: infrastructureConfiguration("HYBRID") } }
  });
  const current = {
    source_identity: source(),
    bindings: readinessBindings({
      configuration: {},
      environment: {},
      design: { applicable: false },
      infrastructure: changedInfrastructure
    })
  };
  const resolved = resolveStoredReleaseReadiness(evaluated, current);
  assert.equal(resolved.state, "STALE");
});

test("20 connected repository verification is reflected in readiness and source bindings", () => {
  const contract = resolveInfrastructureContract({
    app: {
      setup_data: {
        infrastructure: infrastructureConfiguration("HYBRID", {
          source_repository: { owner: "EXTERNAL_PROVIDER", resource_reference: "feltus-test/catalog" }
        })
      }
    }
  });
  const remoteCommit = "a".repeat(40);
  const verified = applyInfrastructureRepositoryVerification(contract, {
    status: "REMOTE_VERIFIED",
    remote_commit: remoteCommit
  });
  const result = evaluateReleaseReadiness(baseInput({ infrastructure: verified }));
  assert.equal(verified.components.source_repository.verification.status, "VERIFIED");
  assert.equal(check(result, "infrastructure.source_repository").result, "PASSED");
  assert.equal(result.infrastructure.components.source_repository.remote_commit, remoteCommit);

  const diverged = applyInfrastructureRepositoryVerification(contract, {
    status: "REMOTE_DIVERGED",
    remote_commit: "b".repeat(40)
  });
  assert.equal(diverged.components.source_repository.verification.status, "DIVERGED");
  assert.equal(diverged.components.source_repository.verification.remote_status, "REMOTE_DIVERGED");
  assert.equal(check(evaluateReleaseReadiness(baseInput({ infrastructure: diverged })), "infrastructure.source_repository").gate, "WARNING");

  const unavailable = applyInfrastructureRepositoryVerification(contract, { status: "REMOTE_UNAVAILABLE" });
  assert.equal(unavailable.components.source_repository.verification.status, "UNAVAILABLE");
  assert.equal(check(evaluateReleaseReadiness(baseInput({ infrastructure: unavailable })), "infrastructure.source_repository").gate, "WARNING");
  const notConnected = applyInfrastructureRepositoryVerification(contract, { status: "NOT_CONNECTED" });
  assert.equal(notConnected.components.source_repository.verification.status, "NOT_CONNECTED");

  const changedRemote = applyInfrastructureRepositoryVerification(contract, {
    status: "REMOTE_VERIFIED",
    remote_commit: "c".repeat(40)
  });
  const resolved = resolveStoredReleaseReadiness(result, {
    source_identity: source(),
    bindings: readinessBindings({
      configuration: {},
      environment: {},
      design: { applicable: false },
      infrastructure: changedRemote
    })
  });
  assert.equal(resolved.state, "STALE", "a changed remote branch commit invalidates the prior evidence binding");
});

test("bounded validating state", () => {
  const result = evaluateReleaseReadiness({ ...baseInput(), validating: true });
  assert.equal(result.state, "VALIDATING");
  assert.equal(result.ready_for_release, false);
});

try {
  readyFixture = await createReadyFixture();
  for (const item of cases) {
    item.callback();
    process.stdout.write(`PASS ${item.name}\n`);
  }
  assert.equal(cases.length, 21);
  process.stdout.write("Release readiness acceptance: 20 planned cases + validating-state transition passed.\n");
} finally {
  const resolvedTempRoot = await fs.realpath(tempRoot);
  if (path.dirname(resolvedTempRoot) !== tempParent || !path.basename(resolvedTempRoot).startsWith(tempRootPrefix)) {
    throw new Error("Refusing to remove a release-readiness test directory outside its configured temp root.");
  }
  await fs.rm(resolvedTempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
