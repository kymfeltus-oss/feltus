import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildContractProtectionMap,
  classifyChangeSetContracts,
  classifyRepository,
  createProductionizationPlan,
  createProductionizationRun,
  evaluateReleaseReadiness,
  normalizeLowRiskSource,
  productionizationChangeSetFingerprint,
  resolveEngineeringStandard,
  resolveRequiredReleaseChecks,
  scanRepository,
  simulateChangeSetFiles,
  validateDeterministicJsonChangeSet
} from "../src/feltus-code/server/repository-productionization.mjs";
import { createTaskRunner } from "../src/feltus-code/server/task-runner.mjs";
import { reviewChangeSet } from "../src/feltus-code/server/change-set.mjs";
import { createFeltusCodeHandlers } from "../src/feltus-code/server/routes.mjs";
import { createPortableApplicationExport } from "../src/feltus-code/server/portable-export.mjs";

const tempParent = await fs.realpath(process.env.FELTUS_TEST_TMPDIR || os.tmpdir());
const tempRootPrefix = ".feltus-productionization-tests-";
const tempRoot = await fs.mkdtemp(path.join(tempParent, tempRootPrefix));
const validationTempRoot = path.join(tempRoot, "validation-workspaces");
let passed = 0;
const baseCreateHandlers = createFeltusCodeHandlers;

function createTestHandlers(options) {
  return baseCreateHandlers({ ...options, validationTempRoot });
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

async function initGit(root) {
  await fs.mkdir(root, { recursive: true });
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "FELTUS tests"]);
  git(root, ["config", "user.email", "tests@localhost"]);
}

async function committedFixture(root, files) {
  await initGit(root);
  for (const [relative, content] of Object.entries(files)) await write(root, relative, content);
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", "fixture baseline"]);
  return git(root, ["rev-parse", "HEAD"]);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readTar(archive) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const filePath = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    const start = offset + 512;
    files.set(filePath, archive.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function test(name, operation) {
  await operation();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

try {
  const matrixRoot = path.join(tempRoot, "cross-stack-matrix");
  const jsFixture = path.join(matrixRoot, "javascript");
  const tsFixture = path.join(matrixRoot, "typescript");
  const pyFixture = path.join(matrixRoot, "python");
  const goFixture = path.join(matrixRoot, "go");
  const staticFixture = path.join(matrixRoot, "static");
  const unknownFixture = path.join(matrixRoot, "unknown");
  const mixedFixture = path.join(matrixRoot, "mixed");
  await write(jsFixture, "package.json", JSON.stringify({
    packageManager: "npm@10.0.0", engines: { node: ">=22" },
    scripts: { test: "node --test" }, dependencies: { express: "^5.0.0" }
  }));
  await write(jsFixture, "src/server.js", "export const app = process.env.API_ORIGIN;\n");
  await write(jsFixture, "test/server.test.js", "import test from 'node:test';\n");
  await write(tsFixture, "package.json", JSON.stringify({
    packageManager: "pnpm@9.0.0",
    scripts: { test: "vitest run" },
    dependencies: { next: "^15.0.0", react: "^19.0.0" },
    devDependencies: { typescript: "^5.0.0", prettier: "^3.0.0", eslint: "^9.0.0", vitest: "^2.0.0" }
  }));
  await write(tsFixture, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await write(tsFixture, "tsconfig.json", "{\"compilerOptions\":{\"strict\":true}}\n");
  await write(tsFixture, "src/__tests__/page.test.tsx", "export const value: string = 'page';\n");
  await write(pyFixture, "pyproject.toml", "[project]\nname = 'matrix-python'\nrequires-python = '>=3.12'\ndependencies = ['fastapi', 'sqlalchemy', 'psycopg']\n[project.optional-dependencies]\ntest = ['pytest', 'ruff', 'pyright']\n");
  await write(pyFixture, "uv.lock", "version = 1\n");
  await write(pyFixture, "app/main.py", "from fastapi import FastAPI\n");
  await write(pyFixture, "tests/test_main.py", "def test_app():\n    assert True\n");
  await write(goFixture, "go.mod", "module example.test/shop\n\ngo 1.23\n");
  await write(goFixture, "go.sum", "example.test/dependency v1.0.0 h1:hash\n");
  await write(goFixture, "main.go", "package main\nfunc main() {}\n");
  await write(goFixture, "main_test.go", "package main\nimport \"testing\"\n");
  await write(goFixture, ".golangci.yml", "version: '2'\n");
  await write(staticFixture, "index.html", "<html><link rel='stylesheet' href='site.css'><script src='app.js'></script></html>\n");
  await write(staticFixture, "site.css", "body { color: black; }\n");
  await write(staticFixture, "app.js", "document.title = 'Static';\n");
  await write(unknownFixture, "README.md", "A repository with no recognizable source manifests.\n");
  await write(mixedFixture, "src/main.js", "export const name = 'mixed';\n");
  await write(mixedFixture, "src/worker.py", "def run():\n    return True\n");
  await write(mixedFixture, "package.json", JSON.stringify({
    name: "feltus-mixed-negative-acceptance", private: true,
    packageManager: "npm@10.0.0", scripts: { test: "node --test" },
    dependencies: { express: "^5.0.0" }
  }));
  await write(mixedFixture, "tests/main.test.js", "import test from 'node:test';\n");
  await write(mixedFixture, "auth/authorize.js", "export function authorize(user) { return Boolean(user); }\n");

  let jsClassification;
  let tsClassification;
  let pyClassification;
  let goClassification;
  let staticClassification;
  await test("01 JavaScript stack detection", async () => {
    jsClassification = await classifyRepository(jsFixture, { sourceCommit: "js-checkpoint", sourceCheckpointId: "js-checkpoint", sourceBranch: "main", sourceWorkspaceId: "app-js" });
    assert(jsClassification.languages.some(item => item.name === "JavaScript"));
    assert.equal(jsClassification.classification_status, "CLASSIFIED");
    assert.equal(jsClassification.productionization_safe, true);
  });
  await test("02 TypeScript and framework detection", async () => {
    tsClassification = await classifyRepository(tsFixture);
    assert(tsClassification.languages.some(item => item.name === "TypeScript"));
    assert(tsClassification.frameworks.includes("Next.js"));
    assert(tsClassification.framework_evidence.some(item => item.name === "Next.js" && item.evidence.length));
  });
  await test("03 Python and FastAPI detection", async () => {
    pyClassification = await classifyRepository(pyFixture);
    assert(pyClassification.languages.some(item => item.name === "Python"));
    assert(pyClassification.frameworks.includes("FastAPI"));
    assert(pyClassification.runtimes.some(item => item.name === "Python" && item.version === ">=3.12"));
  });
  await test("04 Go module, runtime, compiler, and tests", async () => {
    goClassification = await classifyRepository(goFixture);
    assert(goClassification.languages.some(item => item.name === "Go"));
    assert(goClassification.package_managers.some(item => item.name === "go modules"));
    assert(goClassification.runtimes.some(item => item.name === "Go" && item.version === "1.23"));
    assert(goClassification.test_runners.some(item => item.name === "go test"));
    assert(goClassification.test_locations.includes("main_test.go"));
  });
  await test("05 static application is recognized without a server framework", async () => {
    staticClassification = await classifyRepository(staticFixture);
    assert.equal(staticClassification.static_application, true);
    assert.equal(staticClassification.framework_status, "NOT_APPLICABLE");
    assert(staticClassification.runtimes.some(item => item.name === "Browser"));
    assert.equal(staticClassification.frameworks.length, 0);
  });
  await test("06 framework evidence is tied to repository manifests", async () => {
    assert(tsClassification.framework_evidence.find(item => item.name === "Next.js").evidence.includes("package.json"));
    assert(pyClassification.framework_evidence.find(item => item.name === "FastAPI").evidence.includes("app/main.py"));
  });
  await test("07 declared runtime versions are retained", async () => {
    assert(jsClassification.runtimes.some(item => item.name === "Node.js" && item.version === ">=22"));
    assert(pyClassification.runtimes.some(item => item.name === "Python" && item.version === ">=3.12"));
    assert(goClassification.runtimes.some(item => item.name === "Go" && item.version === "1.23"));
  });
  await test("08 package manager conflicts are reported per ecosystem", async () => {
    const conflictRoot = path.join(matrixRoot, "manager-conflict");
    await write(conflictRoot, "package.json", "{\"name\":\"conflict\"}\n");
    await write(conflictRoot, "package-lock.json", "{}\n");
    await write(conflictRoot, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const result = await classifyRepository(conflictRoot);
    assert.equal(result.package_manager_status, "CONFLICT");
    assert.deepEqual(result.package_manager_conflicts[0].managers, ["npm", "pnpm"]);
    assert.equal(result.productionization_safe, false);
  });
  await test("09 configured formatter is detected", async () => {
    assert(tsClassification.formatters.some(item => item.name === "Prettier"));
    assert(pyClassification.formatters.some(item => item.name === "Ruff format"));
  });
  await test("10 configured linter is detected", async () => {
    assert(tsClassification.linters.some(item => item.name === "ESLint"));
    assert(pyClassification.linters.some(item => item.name === "Ruff"));
    assert(goClassification.linters.some(item => item.name === "golangci-lint"));
  });
  await test("11 type checker is detected from configured stack evidence", async () => {
    assert(tsClassification.type_checkers.some(item => item.name === "TypeScript"));
    assert(pyClassification.type_checkers.some(item => item.name === "Pyright"));
    assert(goClassification.type_checkers.some(item => item.name === "Go compiler"));
  });
  await test("12 test runners require configuration evidence", async () => {
    assert(tsClassification.test_runners.some(item => item.name === "Vitest"));
    assert(pyClassification.test_runners.some(item => item.name === "pytest"));
    const exampleRoot = path.join(matrixRoot, "test-like-files-only");
    await write(exampleRoot, "src/example.test.js", "export const example = true;\n");
    assert.equal((await classifyRepository(exampleRoot)).test_runners.length, 0);
  });
  await test("13 database engine and client evidence is detected", async () => {
    assert(pyClassification.databases.includes("PostgreSQL"));
    assert(pyClassification.databases.includes("SQLAlchemy"));
  });
  await test("14 migration engine and identifiers are detected", async () => {
    const migrationRoot = path.join(matrixRoot, "migration-app");
    await write(migrationRoot, "alembic.ini", "[alembic]\n");
    await write(migrationRoot, "database/migrations/20261107_create_items.sql", "CREATE TABLE items (id uuid PRIMARY KEY);\n");
    const result = await classifyRepository(migrationRoot);
    assert(result.migration_tools.some(item => item.name === "Alembic"));
    assert(result.migration_identifiers.includes("20261107_create_items.sql"));
  });
  await test("15 container and infrastructure files are detected", async () => {
    const infraRoot = path.join(matrixRoot, "infra-app");
    await write(infraRoot, "Dockerfile", "FROM python:3.12\n");
    await write(infraRoot, "compose.yaml", "services: {}\n");
    const result = await classifyRepository(infraRoot);
    assert(result.container_configuration.includes("Dockerfile"));
    assert(result.infrastructure_configuration.includes("compose.yaml"));
  });
  await test("16 Vercel evidence is reported without provider calls", async () => {
    const vercelRoot = path.join(matrixRoot, "vercel-app");
    await write(vercelRoot, "vercel.json", "{\"version\":2}\n");
    const result = await classifyRepository(vercelRoot);
    assert(result.provider_evidence.some(item => item.name === "Vercel" && item.evidence.includes("vercel.json")));
  });
  await test("17 unknown repositories remain unclassified", async () => {
    const result = await classifyRepository(unknownFixture);
    assert.equal(result.classification_status, "UNKNOWN");
    assert.equal(result.productionization_safe, false);
    assert.equal(resolveEngineeringStandard(result).standards.every(item => item.status === "UNKNOWN"), true);
    assert(resolveRequiredReleaseChecks(result).some(item => item.id === "source.classification" && !item.available));
  });
  await test("18 mixed stacks are explicitly unsafe for productionization", async () => {
    const result = await classifyRepository(mixedFixture);
    assert.equal(result.classification_status, "MIXED");
    assert.equal(result.productionization_safe, false);
    assert(resolveRequiredReleaseChecks(result).some(item => item.id === "source.classification"));
  });
  await test("19 checkpoint snapshot hash changes when source changes", async () => {
    const before = await classifyRepository(jsFixture, { sourceCommit: "same-commit", sourceCheckpointId: "same-commit" });
    await write(jsFixture, "src/server.js", "export const app = process.env.API_ORIGIN + '/v2';\n");
    const after = await classifyRepository(jsFixture, { sourceCommit: "same-commit", sourceCheckpointId: "same-commit" });
    assert.notEqual(before.source_snapshot_sha256, after.source_snapshot_sha256);
  });
  await test("20 CODE overview reclassifies after a dirty workspace changes", async () => {
    const staleRoot = path.join(matrixRoot, "stale-workspace");
    await initGit(staleRoot);
    await write(staleRoot, "src/index.js", "export const value = 1;\n");
    git(staleRoot, ["add", "--all"]);
    git(staleRoot, ["commit", "-m", "baseline"]);
    const handlers = createTestHandlers({ repoRoot: staleRoot });
    const before = (await handlers.productionizationOverview({ applicationId: "stale-app" })).result;
    await write(staleRoot, "src/index.js", "export const value = 2;\n");
    const after = (await handlers.productionizationOverview({ applicationId: "stale-app" })).result;
    assert.notEqual(before.source_snapshot_sha256, after.source_snapshot_sha256);
    assert.equal(before.source_checkpoint, after.source_checkpoint);
    assert.equal(after.source_clean, false);
    assert.equal(after.source_branch, "main");
    assert.equal(after.classification.source_commit, before.source_checkpoint);
    assert.equal(after.classification.source_checkpoint_id, before.source_checkpoint);
    assert.equal(after.classification.source_workspace_id, "stale-app");
    assert.equal(after.classification.source_binding_complete, true);
    await assert.rejects(() => handlers.productionizationValidate({ applicationId: "stale-app", sourceCheckpointId: "older-checkpoint" }), error => error.code === "SOURCE_CHECKPOINT_STALE");
  });
  await test("21 routes, schemas, SDKs, webhooks, events, and migration IDs are protected", async () => {
    const contractRoot = path.join(matrixRoot, "contract-app");
    await write(contractRoot, "src/api/routes.js", "export const route = '/api/items';\n");
    await write(contractRoot, "src/sdk/index.js", "export function createClient() {}\n");
    await write(contractRoot, "src/webhooks/billing.js", "if (event.type === 'invoice.created') {}\n");
    await write(contractRoot, "supabase/migrations/20261107010000_schema.sql", "CREATE TABLE public.items (id uuid); CREATE TYPE item_state AS ENUM ('new');\n");
    const snapshot = await scanRepository(contractRoot);
    const map = await buildContractProtectionMap(contractRoot, { snapshot });
    const kinds = new Set(map.contracts.map(item => item.kind));
    for (const kind of ["http_route", "database_identifier", "enum_identifier", "provider_event", "migration_identifier", "webhook"]) assert(kinds.has(kind), "missing contract marker " + kind);
    assert(map.protected_files.some(item => item.path === "src/sdk/index.js"));
    assert(map.protected_files.some(item => item.path === "src/webhooks/billing.js"));
  });
  await test("22 environment variable names are protected and secret values are absent", async () => {
    const secretRoot = path.join(matrixRoot, "secret-safe");
    const secret = "private-secret-sentinel-2026";
    await write(secretRoot, "src/config.js", "export const token = process.env.API_TOKEN;\nexport const ignored = '" + secret + "';\n");
    await write(secretRoot, ".env", "API_TOKEN=" + secret + "\n");
    const classification = await classifyRepository(secretRoot);
    const map = await buildContractProtectionMap(secretRoot);
    const serialized = JSON.stringify({ classification, map });
    assert(map.contracts.some(item => item.kind === "environment_variable" && item.value === "API_TOKEN"));
    assert(!serialized.includes(secret));
  });
  await test("23 authorized workspaces remain isolated by source root and app identity", async () => {
    const workspaceA = path.join(matrixRoot, "workspace-a");
    const workspaceB = path.join(matrixRoot, "workspace-b");
    await initGit(workspaceA);
    await initGit(workspaceB);
    await write(workspaceA, "src/a.js", "export const workspace = 'alpha';\n");
    await write(workspaceB, "src/b.py", "workspace = 'beta'\n");
    for (const root of [workspaceA, workspaceB]) {
      git(root, ["add", "--all"]);
      git(root, ["commit", "-m", "workspace baseline"]);
    }
    const appA = (await createTestHandlers({ repoRoot: workspaceA }).productionizationOverview({ applicationId: "app-alpha" })).result;
    const appB = (await createTestHandlers({ repoRoot: workspaceB }).productionizationOverview({ applicationId: "app-beta" })).result;
    assert.equal(appA.classification.source_workspace_id, "app-alpha");
    assert.equal(appB.classification.source_workspace_id, "app-beta");
    assert(appA.classification.languages.some(item => item.name === "JavaScript"));
    assert(!appA.classification.evidence.some(item => item.path === "src/b.py"));
    assert(appB.classification.languages.some(item => item.name === "Python"));
    assert(!appB.classification.evidence.some(item => item.path === "src/a.js"));
  });
  await test("24 classifier output is neutral to application category and identity", async () => {
    const generic = await classifyRepository(jsFixture, { applicationId: "catalog-application" });
    const retail = await classifyRepository(jsFixture, { applicationId: "retail-ecommerce" });
    assert.deepEqual(generic.languages, retail.languages);
    assert.deepEqual(generic.frameworks, retail.frameworks);
    assert.equal(generic.source_snapshot_sha256, retail.source_snapshot_sha256);
    assert.equal(retail.application_id, "retail-ecommerce");
  });
  await test("25 classification and contract inspection do not mutate source", async () => {
    const sourceRoot = path.join(matrixRoot, "read-only");
    await write(sourceRoot, "src/app.js", "export const stable = true;\n");
    const before = (await fs.readFile(path.join(sourceRoot, "src/app.js"))).toString("hex");
    const snapshot = await scanRepository(sourceRoot);
    await classifyRepository(sourceRoot, { snapshot });
    await buildContractProtectionMap(sourceRoot, { snapshot });
    const after = (await fs.readFile(path.join(sourceRoot, "src/app.js"))).toString("hex");
    assert.equal(after, before);
    assert.deepEqual(await fs.readdir(path.join(sourceRoot, "src")), ["app.js"]);
  });
  await test("26 engineering standards use statuses and ecosystem-specific recommendations", async () => {
    const standard = resolveEngineeringStandard(tsClassification);
    const status = (id, ecosystem = "JavaScript/TypeScript") => standard.standards.find(item => item.id === id && item.ecosystem === ecosystem);
    assert.equal(status("formatting").status, "SATISFIED");
    assert.equal(status("linting").status, "SATISFIED");
    assert.equal(status("type_checking").status, "SATISFIED");
    assert.equal(status("tests").status, "SATISFIED");
    assert.equal(status("formatting").configured, true);
    assert(status("formatting").recommended_tools.includes("Prettier"));
    const pythonStandard = resolveEngineeringStandard(pyClassification);
    assert(pythonStandard.standards.find(item => item.id === "formatting").recommended_tools.includes("Ruff"));
    assert(standard.standards.every(item => ["SATISFIED", "PARTIAL", "MISSING", "NOT_APPLICABLE", "UNKNOWN"].includes(item.status)));
  });
  await test("27 nested workspace manifests are classified from their evidence paths", async () => {
    const monorepo = path.join(matrixRoot, "monorepo");
    await write(monorepo, "apps/store/package.json", JSON.stringify({
      packageManager: "npm@10.0.0", dependencies: { vue: "^3.0.0" }
    }));
    await write(monorepo, "apps/store/src/main.js", "export const store = true;\n");
    const result = await classifyRepository(monorepo);
    assert(result.frameworks.includes("Vue"));
    assert(result.package_managers.some(item => item.name === "npm"));
    assert(result.framework_evidence.find(item => item.name === "Vue").evidence.includes("apps/store/package.json"));
    assert(result.dependency_manifests.includes("apps/store/package.json"));
  });
  await test("28 package manifests do not silently choose a package manager", async () => {
    const ambiguousRoot = path.join(matrixRoot, "manager-unknown");
    await write(ambiguousRoot, "package.json", JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^2.0.0" } }));
    const result = await classifyRepository(ambiguousRoot);
    assert.equal(result.package_manager_status, "UNKNOWN");
    assert.equal(result.package_managers.length, 0);
    assert.equal(result.configured_commands.find(item => item.id === "tests").command, null);
    assert.equal(result.test_commands.length, 0);
  });
  await test("29 framework names are not inferred from directory names alone", async () => {
    const directoryOnly = path.join(matrixRoot, "framework-directory-only");
    await write(directoryOnly, "next/pages/index.js", "export default function Page() {}\n");
    const result = await classifyRepository(directoryOnly);
    assert.equal(result.frameworks.includes("Next.js"), false);
    assert.equal(result.classification_status, "CLASSIFIED");
  });
  await test("30 large source changes affect the snapshot and force incomplete classification", async () => {
    const largeRoot = path.join(matrixRoot, "large-source");
    const first = "export const value = '" + "a".repeat(600 * 1024) + "';\n";
    const second = "export const value = '" + "b".repeat(600 * 1024) + "';\n";
    await write(largeRoot, "src/large.js", first);
    const before = await classifyRepository(largeRoot);
    await write(largeRoot, "src/large.js", second);
    const after = await classifyRepository(largeRoot);
    assert.notEqual(before.source_snapshot_sha256, after.source_snapshot_sha256);
    assert.equal(after.classification_status, "INCOMPLETE");
    assert.equal(after.productionization_safe, false);
    assert(after.incomplete_reasons.includes("source_file_evidence_limit"));
  });
  await test("31 ignored phase worktrees and local auth data stay outside classification", async () => {
    const ignoredRoot = path.join(matrixRoot, "ignored-local-data");
    const privateValue = "local-auth-sentinel";
    await write(ignoredRoot, ".phase1-worktree/package.json", "{\"dependencies\":{\"next\":\"1\"}}\n");
    await write(ignoredRoot, ".feltus-dev-auth.json", "{\"token\":\"" + privateValue + "\"}\n");
    await write(ignoredRoot, "src/app.js", "export const safe = true;\n");
    const snapshot = await scanRepository(ignoredRoot);
    const classification = await classifyRepository(ignoredRoot, { snapshot });
    assert(!snapshot.files.some(file => file.path.includes(".phase1-worktree")));
    assert(!snapshot.files.some(file => file.path === ".feltus-dev-auth.json"));
    assert.equal(classification.frameworks.includes("Next.js"), false);
    assert(!JSON.stringify(classification).includes(privateValue));
  });
  await test("bounded scans report incomplete evidence and do not claim exact coverage", async () => {
    const boundedRoot = path.join(matrixRoot, "bounded");
    await write(boundedRoot, "a.js", "export const a = 1;\n");
    await write(boundedRoot, "b.js", "export const b = 2;\n");
    const limited = await scanRepository(boundedRoot, { maxFiles: 1 });
    assert.equal(limited.truncated, true);
    assert.equal(limited.complete, false);
    assert(limited.incomplete_files.some(item => item.path === "b.js" && item.reasons.includes("file_count_limit")));
    const byteLimited = await scanRepository(boundedRoot, { maxHashBytes: 1 });
    assert.equal(byteLimited.complete, false);
    assert.equal(byteLimited.files.some(item => item.sha256 === null), true);
  });

  const jsRoot = path.join(tempRoot, "typescript-app");
  await fs.mkdir(jsRoot, { recursive: true });
  await write(jsRoot, "package.json", JSON.stringify({
    name: "synthetic-app",
    packageManager: "npm@10.0.0",
    scripts: { check: "node --check src/app.js", test: "node --test", build: "node scripts/build.mjs" },
    devDependencies: { typescript: "^5.0.0", prettier: "^3.0.0" }
  }));
  await write(jsRoot, "tsconfig.json", "{\"compilerOptions\":{\"strict\":true}}\n");
  await write(jsRoot, "src/app.ts", "export const label: string = 'app';\n");
  await write(jsRoot, "src/presentation.json", "{\"theme\":{\"name\":\"warm\"},\"visible\":true}");
  await write(jsRoot, "src/api/routes.js", "export const route = '/api/catalog';\n");
  await write(jsRoot, ".env.production", "DATABASE_URL=secret-value\n");
  await write(jsRoot, "node_modules/hidden/index.js", "should be ignored");

  let classification;
  let snapshot;
  let contractMap;
  await test("repository classification and tool detection", async () => {
    classification = await classifyRepository(jsRoot, { applicationId: "synthetic-app", sourceCommit: "abc123" });
    snapshot = await scanRepository(jsRoot);
    contractMap = await buildContractProtectionMap(jsRoot, { snapshot });
    assert.equal(classification.application_id, "synthetic-app");
    assert.equal(classification.source_commit, "abc123");
    assert(classification.languages.some(item => item.name === "TypeScript"));
    assert(classification.package_managers.some(item => item.name === "npm"));
    assert(classification.type_checkers.some(item => item.name === "TypeScript"));
    assert(!snapshot.files.some(item => item.path.includes("node_modules") || item.path === ".env.production"));
    assert.equal(contractMap.source_snapshot_sha256, snapshot.snapshot_sha256);
  });

  await test("extensible detector and stack-aware engineering policy", async () => {
    const custom = await classifyRepository(jsRoot, { detectors: [async () => ({ frameworks: ["Synthetic Framework"] })] });
    assert.deepEqual(custom.frameworks, ["Synthetic Framework"]);
    const standard = resolveEngineeringStandard(classification);
    assert.equal(standard.version, "feltus.engineering-standard/v1");
    assert(standard.checks.some(item => item.tool === "TypeScript"));
    const pkg = JSON.parse((await fs.readFile(path.join(jsRoot, "package.json"), "utf8")));
    const checks = resolveRequiredReleaseChecks(classification, pkg);
    assert(checks.some(item => item.id === "source.check" && item.available));
    assert(checks.some(item => item.id === "source.types" && !item.available));
    assert(checks.some(item => item.id === "source.tests" && item.available));
    assert(checks.some(item => item.id === "source.build" && item.available));
  });

  await test("low-risk source normalization preserves parsed JSON values", async () => {
    const source = snapshot.files.find(item => item.path === "src/presentation.json");
    const normalized = normalizeLowRiskSource(snapshot.files, contractMap, [source.path]);
    assert.equal(normalized.operations.length, 1);
    assert.deepEqual(JSON.parse(normalized.operations[0].content), JSON.parse(source.content));
    assert.equal(normalized.operations[0].before_sha256, source.sha256);
    assert.equal(normalizeLowRiskSource(snapshot.files, contractMap, ["package.json"]), null);
  });

  await test("productionization only proposes a reviewable change and does not push or deploy", async () => {
    const proposalRoot = path.join(tempRoot, "proposal-only");
    const baselineCommit = await committedFixture(proposalRoot, {
      "package.json": JSON.stringify({ name: "proposal-only", packageManager: "npm@10.0.0", scripts: {} }),
      "src/index.js": "export const stable = true;\n",
      "src/settings.json": "{\"theme\":\"warm\"}"
    });
    const handlers = createTestHandlers({ repoRoot: proposalRoot, aiGateway: async () => {
      throw new Error("Deterministic JSON normalization must not need a model call.");
    } });
    const proposal = await handlers.aiProductionize({
      prompt: "Normalize the selected file.",
      context: { editor: { selected_files: [{ path: "src/settings.json" }] } },
      applicationId: "proposal-only-app"
    });
    assert.equal(proposal.result.operations.length, 1);
    assert.equal(proposal.result.productionization.run.status, "READY_FOR_REVIEW");
    assert.equal(git(proposalRoot, ["rev-parse", "HEAD"]), baselineCommit);
    assert.equal(git(proposalRoot, ["status", "--porcelain"]), "");
    assert.equal(Object.hasOwn(handlers, "gitPush"), false);
    assert.equal(Object.hasOwn(handlers, "deploy"), false);
  });

  await test("contract-protected rename is blocked", async () => {
    const source = snapshot.files.find(item => item.path === "src/api/routes.js");
    const changeSet = {
      operations: [{ id: "rename-route", type: "rename", from: source.path, to: "src/internal/routes.js", before_sha256: source.sha256 }]
    };
    const afterFiles = simulateChangeSetFiles(snapshot.files, changeSet);
    const result = classifyChangeSetContracts(changeSet, contractMap, { beforeFiles: snapshot.files, afterFiles });
    assert.equal(result.blocked_operations.length, 1);
    assert.equal(result.blocked_operations[0].classification, "CONTRACT_PROTECTED");
    assert.equal(result.safe_operations.length, 0);
  });

  await test("required check failures block release readiness but not review", async () => {
    const failure = evaluateReleaseReadiness([{ id: "tests", tool: "synthetic test", required: true, available: true, exit_code: 7 }]);
    assert.equal(failure.status, "BLOCKED");
    assert.equal(failure.ready_for_release, false);
    const success = evaluateReleaseReadiness([{ id: "tests", tool: "synthetic test", required: true, available: true, exit_code: 0 }]);
    assert.equal(success.ready_for_release, true);
    const run = createProductionizationRun({ classification, engineeringStandard: resolveEngineeringStandard(classification), contractMap, beforeCommit: "checkpoint-1", runId: "run-synthetic" });
    assert.equal(run.run_id, "run-synthetic");
    assert.equal(run.source_commit, "checkpoint-1");
  });

  await test("Python stack detection is independent of the JavaScript fixture", async () => {
    const pythonRoot = path.join(tempRoot, "python-app");
    await write(pythonRoot, "pyproject.toml", "[project]\nname = 'synthetic-python'\ndependencies = ['pytest', 'ruff', 'mypy']\n");
    await write(pythonRoot, "requirements.txt", "requests>=2.0\n");
    await write(pythonRoot, "src/app.py", "def get_label():\n    return 'app'\n");
    const result = await classifyRepository(pythonRoot);
    assert(result.languages.some(item => item.name === "Python"));
    assert(result.test_runners.some(item => item.name === "pytest"));
    assert(result.linters.some(item => item.name === "Ruff"));
    const checks = resolveRequiredReleaseChecks(result);
    assert(checks.some(item => item.id === "source.tests" && item.command === "python"));
    assert(checks.some(item => item.id === "source.syntax" && item.command === "python"));
  });

  const phaseFRoot = path.join(tempRoot, "phase-f");
  const javascriptProductionizationRoot = path.join(phaseFRoot, "javascript");
  const javascriptPackage = {
    name: "phase-f-javascript-fixture",
    packageManager: "npm@10.0.0",
    scripts: { check: "node --check src/index.js", test: "node --test" }
  };
  const javascriptSource = "export function label() { return 'stable'; }\n";
  const javascriptTest = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/index.js';\ntest('label remains stable', () => assert.equal(label(), 'stable'));\n";
  const javascriptSettings = "{\"theme\":\"warm\",\"density\":2}";
  const javascriptCheckpoint = await committedFixture(javascriptProductionizationRoot, {
    "package.json": JSON.stringify(javascriptPackage),
    "src/index.js": javascriptSource,
    "tests/value.test.js": javascriptTest,
    "config/settings.json": javascriptSettings
  });

  await test("Phase F plan consumes the exact Phase E source snapshot and records a behavioral baseline", async () => {
    const handlers = createTestHandlers({ repoRoot: javascriptProductionizationRoot });
    const result = (await handlers.productionizationPlan({ applicationId: "app-phase-f-js" })).result;
    assert.equal(result.status, "READY_FOR_REVIEW");
    assert.equal(result.source.commit, javascriptCheckpoint);
    assert.equal(result.source.checkpoint, javascriptCheckpoint);
    assert.equal(result.source.snapshot_sha256, result.change_set.productionization.source_snapshot_sha256);
    assert.equal(result.source.classifier_version, "feltus.repository-classifier/v2");
    assert.equal(result.baseline.evidence_status, "EXISTING_CHECKS_RUN");
    assert(result.baseline.checks.some(check => check.id === "source.check" && check.exit_code === 0), JSON.stringify(result.baseline.checks, null, 2));
    assert(result.baseline.checks.some(check => check.id === "source.tests" && check.exit_code === 0));
    assert.equal(result.change_set.operations.length, 1);
    assert.equal(result.change_set.operations[0].path, "config/settings.json");
    assert.equal(git(javascriptProductionizationRoot, ["status", "--porcelain"]), "");
  });

  const javascriptLifecycleRoot = path.join(phaseFRoot, "javascript-lifecycle");
  const javascriptLifecycleCheckpoint = await committedFixture(javascriptLifecycleRoot, {
    "package.json": JSON.stringify(javascriptPackage),
    "src/index.js": javascriptSource,
    "tests/value.test.js": javascriptTest,
    "config/settings.json": javascriptSettings
  });

  await test("JavaScript productionization validates, applies, checkpoints, and restores through CODE", async () => {
    const handlers = createTestHandlers({ repoRoot: javascriptLifecycleRoot });
    const plan = (await handlers.productionizationPlan({ applicationId: "app-phase-fs-js" })).result;
    const validation = (await handlers.productionizationValidate({ applicationId: "app-phase-fs-js", changeSet: plan.change_set })).result;
    assert.equal(validation.run.status, "VALIDATED_FOR_REVIEW");
    assert(validation.release_readiness.checks.every(check => !check.blocking));
    assert(validation.run.checks.some(check => check.id === "productionization.json_semantics" && check.exit_code === 0));
    plan.change_set.productionization.release_readiness = validation.release_readiness;
    const applied = await handlers.applyChangeSet({ changeSet: plan.change_set });
    assert.equal(JSON.stringify(JSON.parse(await fs.readFile(path.join(javascriptLifecycleRoot, "config/settings.json"), "utf8"))), JSON.stringify(JSON.parse(javascriptSettings)));
    await handlers.gitStage({ paths: ["config/settings.json"] });
    const checkpoint = await handlers.checkpoint({ message: "Validated productionization fixture", confirm: true });
    assert.equal(checkpoint.code, 0);
    assert.notEqual((await handlers.gitHead()).commit, javascriptLifecycleCheckpoint);
    const restored = await handlers.undoChangeSet({ token: applied.result.undo_token, confirm: true });
    assert.deepEqual(restored.result.restored, ["config/settings.json"]);
    assert.equal(await fs.readFile(path.join(javascriptLifecycleRoot, "config/settings.json"), "utf8"), javascriptSettings);
  });

  await test("medium-risk changes require review and protected contracts remain blocked", async () => {
    const sourceSnapshot = snapshot;
    const protection = contractMap;
    const packageSource = sourceSnapshot.files.find(file => file.path === "package.json");
    const mediumChange = { operations: [{ id: "package-metadata", type: "update", path: "package.json", content: `${packageSource.content}\n`, before_sha256: packageSource.sha256 }] };
    const mediumResult = classifyChangeSetContracts(mediumChange, protection, {
      beforeFiles: sourceSnapshot.files,
      afterFiles: simulateChangeSetFiles(sourceSnapshot.files, mediumChange)
    });
    assert.equal(mediumResult.blocked_operations.length, 0);
    assert.equal(mediumResult.review_required_operations.length, 1);
    assert.equal(mediumResult.review_required_operations[0].classification, "MEDIUM_RISK_INTERNAL");
    const routeSource = sourceSnapshot.files.find(file => file.path === "src/api/routes.js");
    const protectedChange = { operations: [{ id: "route", type: "update", path: "src/api/routes.js", content: "export const route = '/different';\n", before_sha256: routeSource.sha256 }] };
    const protectedResult = classifyChangeSetContracts(protectedChange, protection, {
      beforeFiles: sourceSnapshot.files,
      afterFiles: simulateChangeSetFiles(sourceSnapshot.files, protectedChange)
    });
    assert.equal(protectedResult.blocked_operations.length, 1);
    assert.equal(protectedResult.review_required_operations.length, 0);
  });

  const typescriptProductionizationRoot = path.join(phaseFRoot, "typescript");
  const typescriptCheckpoint = await committedFixture(typescriptProductionizationRoot, {
    "package.json": JSON.stringify({
      name: "phase-f-typescript-fixture",
      packageManager: "npm@10.0.0",
      scripts: { check: "node --check scripts/check.mjs", test: "node --test" },
      devDependencies: { typescript: "5.7.2" }
    }),
    "scripts/check.mjs": "process.exit(0);\n",
    "src/index.ts": "export const label: string = 'typed';\n",
    "tests/type.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('test runtime is configured', () => assert.equal(typeof assert.equal, 'function'));\n",
    "config/settings.json": "{\"mode\":\"strict\"}"
  });

  await test("TypeScript fixture uses its detected ecosystem without framework or dependency changes", async () => {
    const handlers = createTestHandlers({ repoRoot: typescriptProductionizationRoot });
    const plan = (await handlers.productionizationPlan({ applicationId: "app-phase-f-ts" })).result;
    const overview = (await handlers.productionizationOverview({ applicationId: "app-phase-f-ts" })).result;
    assert.equal(plan.status, "READY_FOR_REVIEW");
    assert.equal(plan.source.commit, typescriptCheckpoint);
    assert(plan.run.engineering_standard.standards.some(standard => standard.ecosystem === "JavaScript/TypeScript" && standard.name === "Type checking"));
    assert.deepEqual(overview.classification.frameworks, []);
    assert.deepEqual(plan.change_set.operations.map(operation => operation.path), ["config/settings.json"]);
    assert(!plan.change_set.operations.some(operation => operation.path === "package.json"));
    assert.equal(await fs.readFile(path.join(typescriptProductionizationRoot, "package.json"), "utf8"), JSON.stringify({
      name: "phase-f-typescript-fixture",
      packageManager: "npm@10.0.0",
      scripts: { check: "node --check scripts/check.mjs", test: "node --test" },
      devDependencies: { typescript: "5.7.2" }
    }));
  });

  const pythonProductionizationRoot = path.join(phaseFRoot, "python");
  const pythonProductionizationCheckpoint = await committedFixture(pythonProductionizationRoot, {
    "pyproject.toml": "[project]\nname = 'phase-f-python-fixture'\nrequires-python = '>=3.12'\n",
    "app/main.py": "def label():\n    return 'python'\n",
    "tests/test_main.py": "import unittest\nfrom app.main import label\nclass LabelTests(unittest.TestCase):\n    def test_label(self):\n        self.assertEqual(label(), 'python')\n",
    "config/settings.json": "{\"mode\":\"safe\"}"
  });

  await test("Python productionization validates, applies, checkpoints, and restores through CODE", async () => {
    const handlers = createTestHandlers({ repoRoot: pythonProductionizationRoot });
    const plan = (await handlers.productionizationPlan({ applicationId: "app-phase-f-python" })).result;
    assert.equal(plan.status, "READY_FOR_REVIEW");
    assert.equal(plan.source.checkpoint, pythonProductionizationCheckpoint);
    assert(plan.source.classifier_version);
    assert(plan.baseline.checks.some(check => check.id === "source.syntax" && check.exit_code === 0));
    assert(plan.baseline.checks.some(check => check.id === "source.tests" && check.exit_code === 0));
    assert.deepEqual(plan.change_set.operations.map(operation => operation.path), ["config/settings.json"]);
    const validation = (await handlers.productionizationValidate({ applicationId: "app-phase-f-python", changeSet: plan.change_set })).result;
    assert.equal(validation.run.status, "VALIDATED_FOR_REVIEW");
    assert(validation.release_readiness.checks.every(check => !check.blocking));
    assert(validation.run.checks.some(check => check.id === "productionization.json_semantics" && check.exit_code === 0));
    assert.equal(await fs.readFile(path.join(pythonProductionizationRoot, "config/settings.json"), "utf8"), "{\"mode\":\"safe\"}");
    plan.change_set.productionization.release_readiness = validation.release_readiness;
    const review = await handlers.reviewChangeSet({ changeSet: plan.change_set });
    assert.deepEqual(review.result.operations.map(operation => operation.path), ["config/settings.json"]);
    assert.equal(review.result.contract_review.blocked_operations.length, 0);
    const applied = await handlers.applyChangeSet({ changeSet: plan.change_set });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(pythonProductionizationRoot, "config/settings.json"), "utf8")), { mode: "safe" });
    await handlers.gitStage({ paths: ["config/settings.json"] });
    const checkpoint = await handlers.checkpoint({ message: "Validated Python productionization fixture", confirm: true });
    assert.equal(checkpoint.code, 0);
    assert.notEqual((await handlers.gitHead()).commit, pythonProductionizationCheckpoint);
    const restored = await handlers.undoChangeSet({ token: applied.result.undo_token, confirm: true });
    assert.deepEqual(restored.result.restored, ["config/settings.json"]);
    assert.equal(await fs.readFile(path.join(pythonProductionizationRoot, "config/settings.json"), "utf8"), "{\"mode\":\"safe\"}");
    assert.equal(await fs.readFile(path.join(pythonProductionizationRoot, "app/main.py"), "utf8"), "def label():\n    return 'python'\n");
  });

  const goProductionizationRoot = path.join(phaseFRoot, "go");
  await committedFixture(goProductionizationRoot, {
    "go.mod": "module example.test/phase-f\n\ngo 1.23\n",
    "main.go": "package main\n\nfunc label() string {\n\treturn \"go\"\n}\n\nfunc main() {}\n",
    "main_test.go": "package main\n\nimport \"testing\"\n\nfunc TestLabel(t *testing.T) {\n\tif label() != \"go\" {\n\t\tt.Fatal(\"label changed\")\n\t}\n}\n",
    "config/settings.json": "{\"mode\":\"native\"}"
  });

  await test("Go fixture runs native checks when available and blocks honestly otherwise", async () => {
    const handlers = createTestHandlers({ repoRoot: goProductionizationRoot });
    let nativeGoAvailable = true;
    try {
      execFileSync("go", ["version"], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
    } catch {
      nativeGoAvailable = false;
    }
    const plan = (await handlers.productionizationPlan({ applicationId: "app-phase-f-go" })).result;
    assert.equal(plan.status, "READY_FOR_REVIEW");
    assert(plan.run.engineering_standard.standards.some(standard => standard.ecosystem === "Go"));
    if (nativeGoAvailable) {
      assert(plan.baseline.checks.some(check => check.id === "source.tests" && check.status === "PASSED"));
    }
    const validation = (await handlers.productionizationValidate({ applicationId: "app-phase-f-go", changeSet: plan.change_set })).result;
    if (nativeGoAvailable) {
      assert.equal(validation.run.status, "VALIDATED_FOR_REVIEW");
      assert(validation.run.checks.some(check => check.id === "source.tests" && check.tool === "go test" && check.status === "PASSED"));
      assert(validation.release_readiness.checks.every(check => !check.blocking));
    } else {
      assert.equal(validation.run.status, "BLOCKED");
      assert(validation.run.checks.some(check => check.tool === "go test" && check.status === "UNAVAILABLE" && check.blocking));
    }
    assert.equal(await fs.readFile(path.join(goProductionizationRoot, "config/settings.json"), "utf8"), "{\"mode\":\"native\"}");
    assert.equal(git(goProductionizationRoot, ["status", "--porcelain"]), "");
  });

  const staticProductionizationRoot = path.join(phaseFRoot, "static");
  await committedFixture(staticProductionizationRoot, {
    "index.html": "<!doctype html><title>Static fixture</title>\n",
    "site.css": "body { color: black; }\n",
    "config/settings.json": "{\"layout\":\"compact\"}"
  });

  await test("static application gets a safe plan without framework injection", async () => {
    const handlers = createTestHandlers({ repoRoot: staticProductionizationRoot });
    const plan = (await handlers.productionizationPlan({ applicationId: "app-phase-f-static" })).result;
    assert.equal(plan.status, "READY_FOR_REVIEW");
    assert.equal(plan.baseline.evidence_status, "NO_CONFIGURED_CHECKS");
    const overview = (await handlers.productionizationOverview({ applicationId: "app-phase-f-static" })).result;
    assert.equal(overview.classification.static_application, true);
    assert.deepEqual(overview.classification.frameworks, []);
    assert.deepEqual(plan.change_set.operations.map(operation => operation.path), ["config/settings.json"]);
    const validation = (await handlers.productionizationValidate({ applicationId: "app-phase-f-static", changeSet: plan.change_set })).result;
    assert.equal(validation.run.status, "VALIDATED_FOR_REVIEW");
  });

  await test("mixed and unknown repositories are refused before any source changes", async () => {
    const mixedHandlers = createTestHandlers({ repoRoot: mixedFixture });
    const mixedPlan = (await mixedHandlers.productionizationPlan({ applicationId: "app-phase-f-mixed" })).result;
    assert.equal(mixedPlan.status, "BLOCKED");
    assert.equal(mixedPlan.change_set, null);
    assert.equal(mixedPlan.run.status, "BLOCKED");
    const unknownHandlers = createTestHandlers({ repoRoot: unknownFixture });
    const unknownPlan = (await unknownHandlers.productionizationPlan({ applicationId: "app-phase-f-unknown" })).result;
    assert.equal(unknownPlan.status, "BLOCKED");
    assert.equal(unknownPlan.change_set, null);
    assert.equal(await fs.readFile(path.join(mixedFixture, "src/main.js"), "utf8"), "export const name = 'mixed';\n");
  });

  await test("secret-bearing JSON and package manifests are never automatic plan inputs", async () => {
    const secretsRoot = path.join(phaseFRoot, "secret-json");
    const secret = "sk-live-phase-f-secret-value-123456";
    await committedFixture(secretsRoot, {
      "package.json": JSON.stringify({ name: "secret-fixture", packageManager: "npm@10.0.0" }),
      "src/index.js": "export const ready = true;\n",
      "config/settings.json": `{"apiKey":"${secret}","theme":"dark"}`,
      "config/display.json": "{\"theme\":\"dark\"}"
    });
    const result = (await createTestHandlers({ repoRoot: secretsRoot }).productionizationPlan({ applicationId: "app-phase-f-secrets" })).result;
    assert(result.change_set);
    assert(!result.change_set.operations.some(operation => operation.path === "config/settings.json" || operation.path === "package.json"));
    assert(!JSON.stringify(result).includes(secret));
  });

  await test("source-stale plans are rejected and failed AI checks remain unapplicable", async () => {
    const staleRoot = path.join(phaseFRoot, "stale");
    await committedFixture(staleRoot, {
      "package.json": JSON.stringify({ name: "stale-fixture", packageManager: "npm@10.0.0", scripts: { check: "node --check src/index.js", test: "node --test" } }),
      "src/index.js": "export const label = 'before';\n",
      "tests/value.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/index.js';\ntest('label', () => assert.equal(label, 'before'));\n",
      "config/settings.json": "{\"mode\":\"stable\"}"
    });
    const handlers = createTestHandlers({ repoRoot: staleRoot });
    const plan = (await handlers.productionizationPlan({ applicationId: "app-phase-f-stale" })).result;
    await write(staleRoot, "src/index.js", "export const label = 'checkpoint-b';\n");
    git(staleRoot, ["add", "--all"]);
    git(staleRoot, ["commit", "-m", "new source checkpoint"]);
    await assert.rejects(() => handlers.productionizationValidate({ applicationId: "app-phase-f-stale", changeSet: plan.change_set }), error => error.code === "SOURCE_CHECKPOINT_STALE");

    const failedRoot = path.join(phaseFRoot, "failed-validation");
    const failedSource = "export const label = 'before';\n";
    await committedFixture(failedRoot, {
      "package.json": JSON.stringify({ name: "failed-check-fixture", packageManager: "npm@10.0.0", scripts: { check: "node --check src/index.js", test: "node --test" } }),
      "src/index.js": failedSource,
      "tests/value.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { label } from '../src/index.js';\ntest('label', () => assert.equal(label, 'before'));\n"
    });
    const failedHandlers = createTestHandlers({ repoRoot: failedRoot });
    const overview = (await failedHandlers.productionizationOverview({ applicationId: "app-phase-f-failure" })).result;
    const failureChangeSet = {
      id: "failed-productionization",
      summary: "Change application behavior",
      operations: [{ id: "change-label", type: "update", path: "src/index.js", content: "export const label = 'after';\n", before_sha256: sha256(failedSource) }]
    };
    failureChangeSet.productionization = {
      run_id: "failed-run",
      source_application_id: "app-phase-f-failure",
      source_workspace_id: "app-phase-f-failure",
      source_branch: overview.classification.source_branch,
      source_checkpoint: overview.source_checkpoint,
      source_snapshot_sha256: overview.source_snapshot_sha256,
      classifier_version: overview.classification.classifier_version,
      change_set_sha256: productionizationChangeSetFingerprint(failureChangeSet),
      proposal_type: "AI_REVIEWED"
    };
    const failedValidation = (await failedHandlers.productionizationValidate({ applicationId: "app-phase-f-failure", changeSet: failureChangeSet })).result;
    assert.equal(failedValidation.run.status, "BLOCKED");
    assert.equal(failedValidation.ready_for_review, true);
    assert(failedValidation.release_readiness.checks.some(check => check.blocking));
    await assert.rejects(() => failedHandlers.applyChangeSet({ changeSet: failureChangeSet }), error => error.code === "PRODUCTIONIZATION_VALIDATION_REQUIRED");
    assert.equal(await fs.readFile(path.join(failedRoot, "src/index.js"), "utf8"), failedSource);
  });

  await test("bounded mixed application remains a MIXED negative acceptance case", async () => {
    const currentHead = await committedFixture(mixedFixture, {});
    const currentBranch = git(mixedFixture, ["branch", "--show-current"]);
    const snapshot = await scanRepository(mixedFixture);
    const classification = await classifyRepository(mixedFixture, {
      applicationId: "feltus-mixed-negative-acceptance",
      sourceWorkspaceId: "feltus-mixed-negative-acceptance",
      sourceBranch: currentBranch,
      sourceCommit: currentHead,
      sourceCheckpointId: currentHead,
      snapshot
    });
    const protection = await buildContractProtectionMap(mixedFixture, { snapshot });
    const plan = createProductionizationPlan({
      classification,
      engineeringStandard: resolveEngineeringStandard(classification),
      contractMap: protection,
      snapshot,
      sourceClean: false
    });
    assert.equal(snapshot.complete, true);
    assert.equal(classification.classification_status, "MIXED");
    assert.equal(classification.productionization_safe, false);
    assert(protection.protected_files.some(file => file.path === "auth/authorize.js"));
    assert(protection.medium_risk_files.some(file => file.path === "package.json"));
    assert(protection.medium_risk_files.some(file => file.path === "tests/main.test.js"));
    assert.equal(plan.status, "BLOCKED");
    assert.equal(plan.change_set, null);
  });

  const gitRoot = path.join(tempRoot, "isolated-checks");
  await initGit(gitRoot);
  const original = "export const value = 'before';\n";
  await write(gitRoot, "src/app.js", original);
  git(gitRoot, ["add", "--all"]);
  git(gitRoot, ["commit", "-m", "baseline"]);
  const changeSet = {
    id: "synthetic-change-set",
    summary: "Synthetic proposed update",
    operations: [{ id: "update-app", type: "update", path: "src/app.js", content: "export const value = 'after';\n", before_sha256: sha256(original) }]
  };

  await test("checks run in an isolated workspace and keep review available on failure", async () => {
    const runner = createTaskRunner({ repoRoot: gitRoot, validationTempRoot, tasks: {
      isolated: { command: process.execPath, args: ["-e", "process.stdout.write('isolated')"] },
      failing: { command: process.execPath, args: ["-e", "process.exit(7)"] }
    } });
    const isolated = await runner.runIsolated("isolated");
    assert.equal(isolated.code, 0);
    assert.equal(isolated.stdout, "isolated");
    const failedValidation = await runner.runAgainstChangeSet("failing", changeSet);
    assert.equal(failedValidation.code, 7);
    assert.equal(await fs.readFile(path.join(gitRoot, "src/app.js"), "utf8"), original);
    const review = await reviewChangeSet({ repoRoot: gitRoot, changeSet });
    assert.equal(review.operations.length, 1);
    assert.equal(review.operations[0].before_content, original);
  });

  const exportRoot = path.join(tempRoot, "export-app");
  await initGit(exportRoot);
  const sourceText = `export const endpoint = process.env.DATABASE_URL;\nexport const token = "sk-abcdefghijklmnopqrstuvwxyz123456789";\n`;
  await write(exportRoot, "package.json", JSON.stringify({ name: "portable-sample", dependencies: { "sample-lib": "^1.2.0" } }, null, 2) + "\n");
  await write(exportRoot, "src/index.js", sourceText);
  await write(exportRoot, "src/settings.json", "{\"answer\":42}\n");
  await write(exportRoot, ".env", "DATABASE_URL=live-secret\n");
  await write(exportRoot, ".env.example", "DATABASE_URL=example-placeholder\n");
  await write(exportRoot, "database/migrations/001-create-products.sql", "CREATE TABLE products (id uuid PRIMARY KEY);\n");
  await write(exportRoot, "supabase/migrations/002-control-plane.sql", "CREATE TABLE feltus_application_blueprints (id uuid);\n");
  await write(exportRoot, "Dockerfile", "FROM node:22\nCOPY source /app\n");
  git(exportRoot, ["add", "--all"]);
  git(exportRoot, ["commit", "-m", "portable checkpoint"]);
  const exportCommit = git(exportRoot, ["rev-parse", "HEAD"]);

  await test("portable export includes exact checkpoint metadata and excludes secrets", async () => {
    const result = await createPortableApplicationExport({
      repoRoot: exportRoot,
      commit: exportCommit.slice(0, 10),
      application: { id: "app-synthetic", app_name: "Synthetic Store" },
      blueprint: { id: "bp-synthetic", version: 4, state_hash: "a".repeat(64) },
      artifact: { artifact_digest: "sha256:synthetic" },
      schemaVersion: "001-create-products.sql"
    });
    const files = readTar(result.archive);
    const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
    assert.equal(manifest.export_format, "feltus.portable-application/v1");
    assert.equal(manifest.application_id, "app-synthetic");
    assert.equal(manifest.blueprint_version, 4);
    assert.equal(manifest.desired_state_hash_v1, "a".repeat(64));
    assert.equal(manifest.source_commit, exportCommit);
    assert.equal(manifest.artifact_digest, "sha256:synthetic");
    assert(manifest.environment_variable_names.includes("DATABASE_URL"));
    assert(manifest.external_dependencies.some(item => item.name === "sample-lib"));
    assert(files.has("source/src/settings.json"));
    assert(files.has("database/database/migrations/001-create-products.sql"));
    assert(files.has("infrastructure/Dockerfile"));
    assert(!files.has("source/.env") && !files.has("source/.env.example"));
    assert(!files.has("source/supabase/migrations/002-control-plane.sql"));
    const safeSource = files.get("source/src/index.js").toString("utf8");
    assert(safeSource.includes("process.env.DATABASE_URL"));
    assert(!safeSource.includes("sk-abcdefghijklmnopqrstuvwxyz123456789"));
    assert(manifest.redacted_files.includes("src/index.js"));
  });

  process.stdout.write(`\n${passed} productionization tests passed.\n`);
} finally {
  const resolvedTempRoot = await fs.realpath(tempRoot);
  if (path.dirname(resolvedTempRoot) !== tempParent || !path.basename(resolvedTempRoot).startsWith(tempRootPrefix)) {
    throw new Error("Refusing to remove a productionization test directory outside its configured temp root.");
  }
  await fs.rm(resolvedTempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
