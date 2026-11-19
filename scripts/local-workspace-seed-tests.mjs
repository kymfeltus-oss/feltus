import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitTools } from "../src/feltus-code/server/git-tools.mjs";
import { createFeltusCodeHandlers } from "../src/feltus-code/server/routes.mjs";
import { isLocalSourceSeedingEnabled, seedLocalCodeWorkspace } from "../src/feltus-code/server/local-source-seeder.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSource = await fs.readFile(path.join(root, "src/server.js"), "utf8");
const testRoot = await fs.mkdtemp(path.join(root, `.feltus-local-source-seed-${process.pid}-`));
const allowedRoot = path.join(testRoot, "approved-sources");
const source = path.join(allowedRoot, "fixture");
const sibling = path.join(allowedRoot, "sibling-app");
const outsideRoot = path.join(testRoot, "outside");
const workspaceRoot = path.join(testRoot, "private-workspaces");
const appId = "33333333-3333-4333-8333-333333333333";
const anotherAppId = "44444444-4444-4444-8444-444444444444";
const workspace = path.join(workspaceRoot, appId);

async function write(relativePath, contents = "fixture data\n") {
  const target = path.join(source, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

try {
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.mkdir(workspaceRoot, { recursive: true });

  await write("package.json", JSON.stringify({ name: "safe-fixture", private: true, scripts: { dev: "node server.mjs" } }));
  await write("index.html", "<h1>Safe fixture</h1>\n");
  await write("server.mjs", "console.log('fixture');\n");
  await write("src/main.js", "document.body.dataset.ready = 'true';\n");
  await write(".env", "TOKEN=must-not-copy\n");
  await write(".env.local", "TOKEN=must-not-copy\n");
  await write("secrets.json", "{\"token\":\"must-not-copy\"}\n");
  await write("feltus-dev-token.json", "must-not-copy\n");
  await write(".git/config", "private source git metadata\n");
  await write("node_modules/example/index.js", "runtime dependency\n");
  await write("dist/index.html", "generated build\n");
  await write("build/output.js", "generated build\n");
  await write(".cache/compiler.json", "generated cache\n");
  await write(".turbo/cache.bin", "generated cache\n");
  await fs.writeFile(path.join(sibling, "sibling-private.txt"), "must-not-copy from a sibling app\n");
  await fs.writeFile(path.join(outsideRoot, "outside-private.txt"), "must-not-copy from outside the root\n");

  assert.equal(isLocalSourceSeedingEnabled({ environment: "development", localDevMode: true, sourceRoot: allowedRoot }), true);
  assert.equal(isLocalSourceSeedingEnabled({ environment: "production", localDevMode: false, sourceRoot: allowedRoot }), false);
  assert.equal(isLocalSourceSeedingEnabled({ environment: "development", localDevMode: false, sourceRoot: allowedRoot }), false);
  assert.equal(isLocalSourceSeedingEnabled({ environment: "development", localDevMode: true, sourceRoot: "" }), false);
  console.log("PASS local seeding is enabled only for configured local development mode");

  const base = { appId, sourceRoot: allowedRoot, sourcePath: "fixture", workspaceRoot, development: true };
  await assert.rejects(
    () => seedLocalCodeWorkspace({ ...base, development: false }),
    error => error.code === "LOCAL_SEED_DEVELOPMENT_ONLY"
  );
  await assert.rejects(
    () => seedLocalCodeWorkspace({ ...base, sourcePath: "../outside" }),
    error => error.code === "LOCAL_SOURCE_PATH_INVALID"
  );
  await assert.rejects(
    () => seedLocalCodeWorkspace({ ...base, sourcePath: path.join(outsideRoot, "outside-private.txt") }),
    error => error.code === "LOCAL_SOURCE_PATH_INVALID"
  );
  await assert.rejects(
    () => seedLocalCodeWorkspace({ ...base, sourcePath: "outside" }),
    error => error.code === "LOCAL_SOURCE_NOT_FOUND"
  );
  await assert.rejects(
    () => seedLocalCodeWorkspace({ ...base, sourceRoot: testRoot }),
    error => error.code === "LOCAL_SOURCE_ROOT_UNSAFE"
  );
  console.log("PASS outside-root, absolute, traversal, and overlapping-source-root inputs fail closed");

  const preexistingRoot = path.join(workspaceRoot, anotherAppId);
  await fs.mkdir(preexistingRoot, { recursive: true });
  await fs.writeFile(path.join(preexistingRoot, "keep.txt"), "existing workspace must remain unchanged\n");
  await assert.rejects(
    () => seedLocalCodeWorkspace({ ...base, appId: anotherAppId }),
    error => error.code === "CODE_WORKSPACE_ALREADY_EXISTS"
  );
  assert.equal(await fs.readFile(path.join(preexistingRoot, "keep.txt"), "utf8"), "existing workspace must remain unchanged\n");
  console.log("PASS an existing app workspace is not overwritten");

  let symlinkCreated = false;
  const escapeLink = path.join(source, "linked-sibling");
  try {
    await fs.symlink(sibling, escapeLink, "junction");
    symlinkCreated = true;
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
  }
  if (symlinkCreated) {
    try {
      await assert.rejects(
        () => seedLocalCodeWorkspace({ ...base, appId: "55555555-5555-4555-8555-555555555555" }),
        error => error.code === "LOCAL_SOURCE_SYMLINK_UNSAFE"
      );
    } finally {
      await fs.rm(escapeLink, { recursive: true, force: true });
    }
    console.log("PASS source symlinks and junctions are rejected");
  } else {
    console.log("SKIP source junction test because Windows directory-link permission is unavailable");
  }

  const seeded = await seedLocalCodeWorkspace(base);
  assert.equal(seeded.initialized, true);
  assert.equal(seeded.already_seeded, false);
  assert.equal(seeded.seeded_file_count, 4);
  assert.equal(seeded.source_path, "fixture");
  assert.match(seeded.baseline_commit, /^[0-9a-f]{40}$/);
  assert.equal(await fs.readFile(path.join(workspace, "package.json"), "utf8"), JSON.stringify({ name: "safe-fixture", private: true, scripts: { dev: "node server.mjs" } }));
  assert.equal(await fs.readFile(path.join(workspace, "src", "main.js"), "utf8"), "document.body.dataset.ready = 'true';\n");
  for (const excluded of [
    ".env", ".env.local", "secrets.json", "feltus-dev-token.json", "node_modules", "dist", "build", ".cache", ".turbo"
  ]) {
    assert.equal(await fs.stat(path.join(workspace, excluded)).then(() => true, () => false), false, `${excluded} must not be copied`);
  }
  assert.doesNotMatch(await fs.readFile(path.join(workspace, ".git", "config"), "utf8"), /private source git metadata/);
  assert.equal(await fs.stat(path.join(workspaceRoot, "sibling-app")).then(() => true, () => false), false, "a sibling workspace must not be copied");
  assert.equal(await fs.stat(path.join(workspace, "sibling-private.txt")).then(() => true, () => false), false);
  const git = createGitTools({ repoRoot: workspace });
  const gitStatus = await git.status();
  assert.equal(gitStatus.code, 0, "the seeded private workspace must be a valid Git repository");
  assert.match(gitStatus.stdout, /^## main\s*$/m, "branch/status inspection must work immediately after seeding");
  assert.equal(gitStatus.stdout.trim(), "## main", "the new baseline should leave a clean Git workspace");
  assert.equal((await git.head()).stdout.trim(), seeded.baseline_commit);
  const baselineHistory = await git.log(10);
  assert.equal(baselineHistory.stdout.trim().split(/\r?\n/).length, 1, "a new workspace starts with one baseline commit");
  assert.match(baselineHistory.stdout, /Initialize FELTUS CODE workspace$/m);
  const baselineFiles = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: workspace, encoding: "utf8" })
    .trim().split(/\r?\n/).sort();
  assert.deepEqual(baselineFiles, ["index.html", "package.json", "server.mjs", "src/main.js"]);
  const codeHandlers = createFeltusCodeHandlers({ repoRoot: workspace });
  assert.equal((await codeHandlers.gitStatus()).ok, true);
  assert.equal((await codeHandlers.gitLog({ limit: 20 })).stdout.trim(), baselineHistory.stdout.trim());
  console.log("PASS approved fixture seed creates one clean baseline commit containing only admitted files; CODE branch/status/history APIs work immediately");

  await fs.writeFile(path.join(workspace, "src", "main.js"), "user edit must survive repeat seed\n");
  const repeated = await seedLocalCodeWorkspace(base);
  assert.equal(repeated.initialized, false);
  assert.equal(repeated.already_seeded, true);
  assert.equal(repeated.seeded_file_count, 4);
  assert.equal(repeated.source_path, "fixture");
  assert.equal(repeated.baseline_commit, seeded.baseline_commit);
  assert.equal((await git.head()).stdout.trim(), seeded.baseline_commit, "repeat seed must not create a second baseline commit");
  assert.equal((await git.log(10)).stdout.trim().split(/\r?\n/).length, 1);
  assert.equal(await fs.readFile(path.join(workspace, "src", "main.js"), "utf8"), "user edit must survive repeat seed\n");
  assert.match((await git.status()).stdout, /src\/main\.js|src\\main\.js/, "repeat seed must preserve and report existing workspace edits");
  await fs.mkdir(path.join(allowedRoot, "other-source"), { recursive: true });
  await assert.rejects(
    () => seedLocalCodeWorkspace({ ...base, sourcePath: "other-source" }),
    error => error.code === "CODE_WORKSPACE_ALREADY_EXISTS"
  );
  console.log("PASS repeated matching seed is idempotent and does not replace workspace edits or accept a different source");

  const legacyAppId = "66666666-6666-4666-8666-666666666666";
  const legacyWorkspace = path.join(workspaceRoot, legacyAppId);
  await seedLocalCodeWorkspace({ ...base, appId: legacyAppId });
  execFileSync("git", ["update-ref", "-d", "refs/heads/main"], { cwd: legacyWorkspace });
  await fs.rm(path.join(legacyWorkspace, ".git", "index"), { force: true });
  const legacyMarkerPath = path.join(legacyWorkspace, ".git", ".feltus-local-seed.json");
  const legacyMarker = JSON.parse(await fs.readFile(legacyMarkerPath, "utf8"));
  delete legacyMarker.baseline_commit;
  await fs.writeFile(legacyMarkerPath, JSON.stringify(legacyMarker));
  const migratedLegacy = await seedLocalCodeWorkspace({ ...base, appId: legacyAppId });
  assert.match(migratedLegacy.baseline_commit, /^[0-9a-f]{40}$/, "a matching legacy seed receives a baseline commit");
  assert.equal((await createGitTools({ repoRoot: legacyWorkspace }).log(10)).stdout.trim().split(/\r?\n/).length, 1);

  const editedLegacyAppId = "77777777-7777-4777-8777-777777777777";
  const editedLegacyWorkspace = path.join(workspaceRoot, editedLegacyAppId);
  await seedLocalCodeWorkspace({ ...base, appId: editedLegacyAppId });
  execFileSync("git", ["update-ref", "-d", "refs/heads/main"], { cwd: editedLegacyWorkspace });
  await fs.rm(path.join(editedLegacyWorkspace, ".git", "index"), { force: true });
  const editedLegacyMarkerPath = path.join(editedLegacyWorkspace, ".git", ".feltus-local-seed.json");
  const editedLegacyMarker = JSON.parse(await fs.readFile(editedLegacyMarkerPath, "utf8"));
  delete editedLegacyMarker.baseline_commit;
  await fs.writeFile(editedLegacyMarkerPath, JSON.stringify(editedLegacyMarker));
  const editedLegacyContent = "keep this pre-existing workspace edit\n";
  await fs.writeFile(path.join(editedLegacyWorkspace, "src", "main.js"), editedLegacyContent);
  await assert.rejects(
    () => seedLocalCodeWorkspace({ ...base, appId: editedLegacyAppId }),
    error => error.code === "LOCAL_SEED_BASELINE_UNSAFE"
  );
  assert.equal(await fs.readFile(path.join(editedLegacyWorkspace, "src", "main.js"), "utf8"), editedLegacyContent);
  assert.equal((await createGitTools({ repoRoot: editedLegacyWorkspace }).log(10)).stdout, "");
  console.log("PASS legacy empty workspaces are baselined only when unchanged; existing edits remain intact when baseline creation is unsafe");

  const authCheck = serverSource.indexOf("const app = await authorizedCodeProject(appId, permission);");
  const deniedCheck = serverSource.indexOf('code: "PROJECT_ACCESS_DENIED"', authCheck);
  const seedAction = serverSource.indexOf('body.action === "seed_local"', authCheck);
  assert.ok(authCheck >= 0 && deniedCheck > authCheck && seedAction > deniedCheck, "the app authorization gate must run and deny access before local seeding");
  assert.match(serverSource, /const permission = codePermissionForRequest\([\s\S]*?authorizedCodeProject\(appId, permission\)/);
  assert.match(serverSource, /isLocalSourceSeedingEnabled\([\s\S]*?environment: FELTUS_ENV,[\s\S]*?localDevMode: LOCAL_DEV_MODE/);
  console.log("PASS seed action remains behind existing app authorization and the development-only route gate");
} finally {
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
