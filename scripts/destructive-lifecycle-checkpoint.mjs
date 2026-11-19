import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

function run(label, command, args, options = {}) {
  process.stdout.write(`\n[RUN] ${label}\n`);
  const input = options.input;
  const spawnOptions = { ...options };
  delete spawnOptions.input;
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    windowsHide: true,
    ...spawnOptions,
    ...(input === undefined ? {} : { input })
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
  }
  const passed = result.status === 0;
  results.push({ label, status: passed ? "PASS" : "FAIL" });
  process.stdout.write(`[${passed ? "PASS" : "FAIL"}] ${label}${result.status === null ? " (no exit status)" : ` (exit ${result.status})`}\n`);
}

function skip(label, reason) {
  results.push({ label, status: "SKIP", reason });
  process.stdout.write(`[SKIP] ${label}: ${reason}\n`);
}

function runNpmScript(name) {
  if (process.platform === "win32") {
    run(`npm run ${name}`, process.env.ComSpec || "cmd.exe", ["/d", "/c", `npm run ${name}`]);
    return;
  }
  run(`npm run ${name}`, "npm", ["run", name]);
}

function inspectDisposableContainer(container, prefixes, expectedImagePattern) {
  const acceptedPrefixes = Array.isArray(prefixes) ? prefixes : [prefixes];
  if (!container || !acceptedPrefixes.some(prefix => container.startsWith(prefix))) {
    return { safe: false, reason: `container name must start with ${acceptedPrefixes.join(" or ")}` };
  }
  const result = spawnSync("docker", ["inspect", container], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    return { safe: false, reason: "Docker container is unavailable" };
  }
  let inspected;
  try {
    inspected = JSON.parse(result.stdout)[0];
  } catch {
    return { safe: false, reason: "Docker inspect did not return valid container metadata" };
  }
  const mounts = inspected?.Mounts ?? [];
  const networkMode = inspected?.HostConfig?.NetworkMode;
  const publishedPorts = Object.values(inspected?.NetworkSettings?.Ports ?? {})
    .some(bindings => Array.isArray(bindings) && bindings.length > 0);
  const image = inspected?.Config?.Image ?? "";
  if (mounts.length > 0 || networkMode !== "none" || publishedPorts) {
    return { safe: false, reason: "container must have no mounts, no network, and no published ports" };
  }
  if (!expectedImagePattern.test(image)) {
    return { safe: false, reason: "container image is not the expected Postgres test image" };
  }
  return { safe: true };
}

runNpmScript("check");
runNpmScript("test:state-contract");
runNpmScript("test:state-api");
runNpmScript("test:wizard");
run("node scripts/data-model-workflow-tests.mjs", process.execPath, ["scripts/data-model-workflow-tests.mjs"]);
runNpmScript("test:model-deletion");
runNpmScript("test:application-lifecycle");
runNpmScript("test:core");
runNpmScript("test:teams");
runNpmScript("test:code");
runNpmScript("test:build-studio");
runNpmScript("test:build-worker");
runNpmScript("test:artifact");
runNpmScript("test:infrastructure-worker");
runNpmScript("test:productionization");
runNpmScript("test:workspace-seed");

const cleanupContainer = process.env.FELTUS_PHASED_TEST_DB_CONTAINER;
if (!cleanupContainer) {
  skip("Phase C PostgreSQL lifecycle assertions", "set FELTUS_PHASED_TEST_DB_CONTAINER to an isolated container named feltus-phasec-pg-validation-... with no mounts, network, or published ports");
} else {
  const inspection = inspectDisposableContainer(
    cleanupContainer,
    "feltus-phasec-pg-validation-",
    /(?:supabase\/postgres|postgres)(?::|$)/i
  );
  if (!inspection.safe) {
    skip("Phase C PostgreSQL lifecycle assertions", inspection.reason);
  } else {
    const sql = readFileSync(path.join(root, "scripts", "application-lifecycle-postgres-tests.sql"));
    run(
      "rollback-only Phase C PostgreSQL lifecycle assertions",
      "docker",
      ["exec", "-i", cleanupContainer, "psql", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "feltus_phasec_clean"],
      { input: sql }
    );
  }
}

const controlPlaneContainer = process.env.FELTUS_CP_TEST_DB_CONTAINER || "feltus-cp-test-db";
const controlPlaneInspection = inspectDisposableContainer(
  controlPlaneContainer,
  ["feltus-cp-test-", "feltus-phasec-pg-validation-"],
  /(?:supabase\/postgres|postgres)(?::|$)/i
);
if (!controlPlaneInspection.safe) {
  skip("Deployment control-plane PostgreSQL assertions", controlPlaneInspection.reason);
} else {
  runNpmScript("test:deployment-control-plane");
}

run("git diff --check", "git", ["diff", "--check"]);

process.stdout.write("\nDestructive lifecycle checkpoint summary\n");
for (const result of results) {
  process.stdout.write(`${result.status.padEnd(4)} ${result.label}${result.reason ? ` — ${result.reason}` : ""}\n`);
}

const failures = results.filter(result => result.status === "FAIL");
const skips = results.filter(result => result.status === "SKIP");
if (failures.length > 0) {
  process.stderr.write(`\nFAIL: ${failures.length} checkpoint suite(s) failed.\n`);
  process.exitCode = 1;
} else if (skips.length > 0) {
  process.stderr.write(`\nPARTIAL: ${skips.length} checkpoint suite(s) were skipped.\n`);
  process.exitCode = 2;
} else {
  process.stdout.write("\nPASS: all destructive lifecycle checkpoint suites completed.\n");
}
