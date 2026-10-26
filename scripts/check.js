import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "src/server.js",
  "src/index.js",
  "src/ai-ingest.js",
  "src/lib/feltus-ai.js",
  "src/lib/feltus-ai-router.js",
  "src/lib/feltus-client.js",
  "scripts/dev.js",
  "scripts/check.js",
  "scripts/bootstrap-owner.mjs",
  "scripts/production-regression.mjs"
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

process.exitCode = failed ? 1 : 0;
