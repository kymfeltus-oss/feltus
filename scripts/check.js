import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "src/server.js",
  "src/lib/feltus-app-wizard.js",
  "src/app-wizard/app.js",
  "scripts/app-wizard-tests.mjs",
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
  "src/feltus-code/web/feltus-code.js",
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
