import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "src/server.js",
  "src/lib/feltus-app-wizard.js",
  "src/lib/feltus-application-filesystem-cleanup.js",
  "src/lib/feltus-application-cleanup-worker.js",
  "src/lib/feltus-app-backup-restore.js",
  "src/lib/feltus-app-wizard-shared.js",
  "src/lib/feltus-application-state.js",
  "src/lib/feltus-application-state-api.js",
  "src/lib/feltus-day2-reconciliation.js",
  "src/lib/feltus-design-state-storage.js",
  "src/lib/feltus-authorization.js",
  "src/lib/feltus-team-api.js",
  "src/lib/feltus-data-model-api.js",
  "src/lib/feltus-generated-app-auth.js",
  "src/lib/feltus-infrastructure-contract.js",
  "src/lib/feltus-safe-endpoint-observer.js",
  "src/lib/feltus-build-worker.js",
  "src/lib/feltus-github.js",
  "src/lib/feltus-github-api.js",
  "src/app-wizard/app.js",
  "src/app-wizard/capabilities.js",
  "scripts/app-wizard-tests.mjs",
  "scripts/data-model-workflow-tests.mjs",
  "scripts/model-deletion-tests.mjs",
  "scripts/application-lifecycle-tests.mjs",
  "scripts/app-backup-restore-tests.mjs",
  "scripts/generated-app-auth-tests.mjs",
  "scripts/infrastructure-registration-e2e.mjs",
  "scripts/destructive-lifecycle-checkpoint.mjs",
  "scripts/deployment-control-plane-tests.mjs",
  "scripts/deployment-control-plane-certification.mjs",
  "scripts/certification-browser-fixture.mjs",
  "scripts/application-state-contract-tests.mjs",
  "scripts/application-state-api-tests.mjs",
  "scripts/team-account-tests.mjs",
  "scripts/build-worker-tests.mjs",
  "scripts/artifact-tests.mjs",
  "scripts/github-integration-tests.mjs",
  "src/index.js",
  "src/ai-ingest.js",
  "src/lib/feltus-ai.js",
  "src/lib/feltus-ai-providers.js",
  "src/lib/feltus-ai-history.js",
  "src/lib/feltus-ai-policy.js",
  "src/lib/feltus-ai-prompt.js",
  "src/lib/feltus-ai-router.js",
  "src/lib/feltus-client.js",
  "src/lib/feltus-tools.js",
  "src/worker.js",
  "src/build-worker.js",
  "src/lib/feltus-coolify.js",
  "src/lib/feltus-infrastructure-worker.js",
  "src/feltus-code/server/agent.mjs",
  "src/feltus-code/server/agent-workflow.mjs",
  "src/feltus-code/server/ai-gateway.mjs",
  "src/feltus-code/server/file-tools.mjs",
  "src/feltus-code/server/git-tools.mjs",
  "src/feltus-code/server/repo-map.mjs",
  "src/feltus-code/server/routes.mjs",
  "src/feltus-code/server/security.mjs",
  "src/feltus-code/server/task-runner.mjs",
  "src/feltus-code/server/change-set.mjs",
  "src/feltus-code/server/design-studio.mjs",
  "src/feltus-code/server/design-studio-lifecycle.mjs",
  "src/feltus-code/server/preview-manager.mjs",
  "src/feltus-code/server/docker-preview-runner.mjs",
  "src/feltus-code/server/local-source-seeder.mjs",
  "src/feltus-code/server/repository-productionization.mjs",
  "src/feltus-code/server/release-readiness.mjs",
  "src/feltus-code/server/portable-export.mjs",
  "scripts/build-studio-preview-docker-integration.mjs",
  "scripts/design-studio-preview-integration.mjs",
  "scripts/local-workspace-seed-tests.mjs",
  "development/test-fixtures/feltus-code-e2e/server.mjs",
  "src/feltus-code/server/studio-capabilities.mjs",
  "src/feltus-code/server/studio-context.mjs",
  "src/feltus-code/server/studio-workflow.mjs",
  "src/feltus-code/web/feltus-code.js",
  "scripts/build-studio-tests.mjs",
  "scripts/design-studio-tests.mjs",
  "scripts/productionization-tests.mjs",
  "scripts/release-readiness-tests.mjs",
  "scripts/day2-reconciliation-tests.mjs",
  "src/feltus-code/tests/smoke.mjs",
  "scripts/dev.js",
  "scripts/check.js",
  "scripts/bootstrap-owner.mjs",
  "scripts/production-regression.mjs",
  "scripts/infrastructure-worker-tests.mjs",
  "scripts/core-platform-tests.mjs",
  "scripts/production-smoke.mjs"
];

let failed = false;

for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ["--check", path.join(root, file)],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    failed = true;
    process.stdout.write(`FAIL syntax ${file}\n`);
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
  } else {
    process.stdout.write(`PASS syntax ${file}\n`);
  }
}

try {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  let cursor = 0;
  let inlineScriptCount = 0;

  while (true) {
    const start = html.indexOf("<script", cursor);
    if (start < 0) break;

    const openEnd = html.indexOf(">", start);
    const closeStart = html.indexOf("</script>", openEnd + 1);
    if (openEnd < 0 || closeStart < 0) {
      throw new Error("Unterminated script element in index.html");
    }

    const attributes = html.slice(start, openEnd);
    if (!/\bsrc\s*=/i.test(attributes)) {
      new Function(html.slice(openEnd + 1, closeStart));
      inlineScriptCount += 1;
    }

    cursor = closeStart + "</script>".length;
  }

  const externalWizardShell = /<script\b[^>]*\bsrc=["']\/app-wizard\.js["'][^>]*\btype=["']module["']/i.test(html) || /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\/app-wizard\.js["']/i.test(html);
  if (inlineScriptCount === 0 && !externalWizardShell) {
    throw new Error("No recognized application script was found");
  }

  process.stdout.write(`PASS syntax index.html (${externalWizardShell ? "external wizard module" : `${inlineScriptCount} inline scripts`})\n`);
} catch (error) {
  failed = true;
  process.stdout.write("FAIL syntax index.html inline scripts\n");
  process.stderr.write(`${error.stack || error}\n`);
}

process.exitCode = failed ? 1 : 0;
