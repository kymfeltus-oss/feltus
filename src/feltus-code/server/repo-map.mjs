import fs from "node:fs/promises";
import path from "node:path";
import { isSensitivePath } from "./security.mjs";

const EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".sql", ".json", ".md", ".yaml", ".yml",
  ".toml", ".html", ".css"
]);

const IGNORE = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

export async function buildRepoMap(repoRoot, { maxFiles = 1200 } = {}) {
  const files = [];

  async function walk(abs, rel) {
    if (files.length >= maxFiles) return;
    const entries = await fs.readdir(abs, { withFileTypes: true });

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (IGNORE.has(entry.name) || entry.isSymbolicLink()) continue;

      const childAbs = path.join(abs, entry.name);
      const childRel = path.join(rel, entry.name);
      if (isSensitivePath(childRel)) continue;

      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }

      if (!entry.isFile() || !EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      let summary = "";
      try {
        const stat = await fs.stat(childAbs);
        if (stat.size < 256000) {
          const text = await fs.readFile(childAbs, "utf8");
          const symbols = [];
          const regexes = [
            /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm,
            /^\s*(?:export\s+)?class\s+([A-Za-z0-9_$]+)/gm,
            /^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/gm,
            /^\s*def\s+([A-Za-z0-9_]+)/gm,
            /^\s*class\s+([A-Za-z0-9_]+)/gm
          ];

          for (const rx of regexes) {
            for (const match of text.matchAll(rx)) {
              symbols.push(match[1]);
              if (symbols.length >= 20) break;
            }
            if (symbols.length >= 20) break;
          }
          summary = symbols.length ? ` symbols: ${symbols.join(", ")}` : "";
        }
      } catch {}

      files.push(`${childRel.replaceAll("\\", "/")}${summary}`);
    }
  }

  await walk(path.resolve(repoRoot), "");
  return files.join("\n");
}
