import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
  "scripts/production-regression.mjs",
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

  if (inlineScriptCount === 0) {
    throw new Error("No inline application scripts were found");
  }

  process.stdout.write(`PASS syntax index.html (${inlineScriptCount} inline scripts)\n`);
} catch (error) {
  failed = true;
  process.stdout.write("FAIL syntax index.html inline scripts\n");
  process.stderr.write(`${error.stack || error}\n`);
}

process.exitCode = failed ? 1 : 0;
