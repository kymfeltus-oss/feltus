import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { isSensitivePath, normalizeRelativePath, redactSecrets } from "./security.mjs";
import { assertExactGitRoot, isolatedGitEnvironment } from "./git-tools.mjs";

const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".venv", "venv", "__pycache__"]);

function runGit(root, args, input = null, maxBytes = MAX_ARCHIVE_BYTES) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      shell: false,
      windowsHide: true,
      env: isolatedGitEnvironment()
    });
    const chunks = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill("SIGKILL");
        reject(Object.assign(new Error("Portable export exceeds the configured size limit."), { code: "EXPORT_TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(Object.assign(new Error(redactSecrets(stderr).trim() || `Git export command failed (${code}).`), { code: "SOURCE_CHECKPOINT_UNAVAILABLE" }));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function parseTree(buffer) {
  const files = [];
  let start = 0;
  while (start < buffer.length) {
    const end = buffer.indexOf(0, start);
    if (end < 0) break;
    const record = buffer.subarray(start, end);
    const tab = record.indexOf(9);
    if (tab > 0) {
      const metadata = record.subarray(0, tab).toString("utf8").split(" ");
      const filePath = record.subarray(tab + 1).toString("utf8");
      if (metadata.length === 3 && metadata[1] === "blob" && ["100644", "100755"].includes(metadata[0])) {
        files.push({ path: filePath, mode: Number.parseInt(metadata[0], 8) & 0o777, oid: metadata[2] });
      }
    }
    start = end + 1;
  }
  return files;
}

function readBatch(buffer, expected) {
  const values = new Map();
  let cursor = 0;
  let count = 0;
  while (cursor < buffer.length && count < expected.length) {
    const headerEnd = buffer.indexOf(10, cursor);
    if (headerEnd < 0) throw Object.assign(new Error("Git object batch was incomplete."), { code: "EXPORT_OBJECT_READ_FAILED" });
    const [oid, type, sizeText] = buffer.subarray(cursor, headerEnd).toString("ascii").split(" ");
    const size = Number(sizeText);
    if (type !== "blob" || !Number.isSafeInteger(size) || size < 0) throw Object.assign(new Error("Git object batch returned an invalid source object."), { code: "EXPORT_OBJECT_READ_FAILED" });
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= buffer.length || buffer[contentEnd] !== 10) throw Object.assign(new Error("Git object batch content was truncated."), { code: "EXPORT_OBJECT_READ_FAILED" });
    values.set(oid, buffer.subarray(contentStart, contentEnd));
    cursor = contentEnd + 1;
    count += 1;
  }
  if (count !== expected.length) throw Object.assign(new Error("Git did not return every source file."), { code: "EXPORT_OBJECT_READ_FAILED" });
  return values;
}

function writeString(header, offset, length, value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length > length) throw Object.assign(new Error("Portable archive path exceeds the supported length."), { code: "EXPORT_PATH_TOO_LONG" });
  bytes.copy(header, offset);
}

function writeOctal(header, offset, length, value) {
  const number = Math.max(0, Number(value) || 0).toString(8);
  if (number.length > length - 1) throw Object.assign(new Error("Portable archive metadata is out of range."), { code: "EXPORT_METADATA_INVALID" });
  writeString(header, offset, length - 1, number.padStart(length - 1, "0"));
  header[offset + length - 1] = 0;
}

function tarHeader(filePath, size, mode) {
  const normalized = normalizeRelativePath(filePath);
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length > 100) {
    const slash = normalized.lastIndexOf("/");
    const prefix = normalized.slice(0, slash);
    const name = normalized.slice(slash + 1);
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) {
      throw Object.assign(new Error("Portable archive path exceeds the USTAR format limit."), { code: "EXPORT_PATH_TOO_LONG" });
    }
  }
  const header = Buffer.alloc(512);
  const slash = normalized.lastIndexOf("/");
  const prefix = bytes.length > 100 ? normalized.slice(0, slash) : "";
  const name = bytes.length > 100 ? normalized.slice(slash + 1) : normalized;
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode || 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(32, 148, 156);
  header[156] = 48;
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "FELTUS");
  if (prefix) writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 6, checksum.toString(8).padStart(6, "0"));
  header[154] = 0;
  header[155] = 32;
  return header;
}

function tarFile(filePath, content, mode = 0o644) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const padding = (512 - (data.length % 512)) % 512;
  return [tarHeader(filePath, data.length, mode), data, Buffer.alloc(padding)];
}

function environmentNames(files) {
  const patterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]*)/g,
    /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
    /\b(?:os\.)?getenv\s*\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
    /\b(?:os\.)?environ(?:\s*\.get)?\s*\[?\s*["']([A-Z][A-Z0-9_]*)["']/g,
    /\bstd::env::var\s*\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
    /\b(?:os\.)?Getenv\s*\(\s*["']([A-Z][A-Z0-9_]*)["']/g
  ];
  const names = new Set();
  for (const file of files) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of file.content.matchAll(pattern)) names.add(match[1]);
    }
  }
  return [...names].sort();
}

function dependencyManifest(files) {
  const packageFile = files.find(file => file.path === "package.json");
  let parsed = {};
  try { parsed = packageFile ? JSON.parse(packageFile.content) : {}; } catch {}
  const dependencies = ["dependencies", "devDependencies", "optionalDependencies"]
    .flatMap(group => Object.entries(parsed[group] || {}).map(([name, version]) => ({ name, version: String(version) })));
  for (const file of files) {
    if (/^requirements(?:[-_.][^/]*)?\.txt$/i.test(file.path)) {
      for (const line of file.content.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z0-9_.-]+)\s*(.*)$/.exec(line);
        if (match && !match[1].startsWith("#") && !match[1].startsWith("-")) dependencies.push({ name: match[1], version: match[2].trim() || null });
      }
    } else if (file.path === "go.mod") {
      for (const match of file.content.matchAll(/^\s*([A-Za-z0-9_.\-/]+)\s+(v[0-9][^\s]*)/gm)) dependencies.push({ name: match[1], version: match[2] });
    } else if (file.path === "Cargo.toml") {
      for (const match of file.content.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']/gm)) dependencies.push({ name: match[1], version: match[2] });
    }
  }
  const packageManager = files.some(file => file.path === "pnpm-lock.yaml") ? "pnpm"
    : files.some(file => file.path === "yarn.lock") ? "yarn"
      : files.some(file => file.path === "bun.lock" || file.path === "bun.lockb") ? "bun"
        : packageFile ? "npm" : files.some(file => file.path === "go.mod") ? "go modules"
          : files.some(file => file.path === "Cargo.toml") ? "cargo"
            : files.some(file => /^requirements.*\.txt$/i.test(file.path)) ? "pip" : null;
  const distinct = [...new Map(dependencies.map(item => [`${item.name}\0${item.version}`, item])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  return { package_manager: packageManager, dependencies: distinct };
}

function runtimeMetadata(files) {
  const packageFile = files.find(file => file.path === "package.json");
  let pkg = {};
  try { pkg = packageFile ? JSON.parse(packageFile.content) : {}; } catch {}
  const packageNames = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {})
  ]);
  const frameworks = [];
  const frameworkMap = new Map([
    ["next", "Next.js"], ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"],
    ["@sveltejs/kit", "SvelteKit"], ["astro", "Astro"], ["express", "Express"],
    ["fastify", "Fastify"], ["@nestjs/core", "NestJS"], ["nuxt", "Nuxt"], ["@remix-run/react", "Remix"]
  ]);
  for (const name of packageNames) if (frameworkMap.has(name)) frameworks.push(frameworkMap.get(name));
  const runtimes = [];
  if (packageFile) runtimes.push({ name: "Node.js", version: pkg.engines?.node || null });
  if (files.some(file => file.path.endsWith(".py") || file.path === "pyproject.toml")) runtimes.push({ name: "Python", version: null });
  const goFile = files.find(file => file.path === "go.mod");
  if (goFile) runtimes.push({ name: "Go", version: goFile.content.match(/^go\s+([0-9.]+)/m)?.[1] || null });
  if (files.some(file => file.path === "Cargo.toml")) runtimes.push({ name: "Rust", version: null });
  const buildScripts = Object.fromEntries(["build", "compile", "test", "test:ci", "check", "lint", "typecheck"]
    .filter(name => typeof pkg.scripts?.[name] === "string")
    .map(name => [name, pkg.scripts[name]]));
  return { frameworks: [...new Set(frameworks)].sort(), runtimes, build_metadata: { system: packageFile ? "package scripts" : goFile ? "Go modules" : files.some(file => file.path === "Cargo.toml") ? "Cargo" : null, scripts: buildScripts } };
}

function environmentConfigurationPaths(filePath) {
  const value = filePath.toLowerCase();
  return /(^|\/)(?:dockerfile(?:\.[^/]*)?|(?:compose|docker-compose)(?:\.[^/]*)?\.ya?ml|procfile|railway\.toml|fly\.toml|render\.ya?ml|vercel\.json|serverless\.ya?ml|terraform\.tf|pulumi\.[^/]+)$/.test(value) || /(^|\/)(?:infra|infrastructure|terraform|deploy|deployment)\//.test(value);
}

function isPlatformMigration(file) {
  return /(^|\/)(?:supabase\/)?migrations?\//i.test(file.path) && /\bfeltus_(?:applications?|models?|model_columns|model_relationships|application_blueprints|builds?|artifacts?|deployments?|observed_application_states|application_state_deltas|organizations?|project_memberships)\b/i.test(file.content);
}

export async function createPortableApplicationExport({ repoRoot, commit, application, blueprint = null, artifact = null, schemaVersion = null }) {
  await assertExactGitRoot(repoRoot);
  if (!/^[0-9a-f]{7,64}$/i.test(String(commit || ""))) throw Object.assign(new Error("Choose an approved source checkpoint."), { code: "INVALID_SOURCE_CHECKPOINT" });
  const resolved = (await runGit(repoRoot, ["rev-parse", `${commit}^{commit}`], null, 2048)).toString("utf8").trim();
  const tree = parseTree(await runGit(repoRoot, ["ls-tree", "-rz", "--full-tree", resolved]));
  const sourceFiles = tree.filter(item => {
    const path = item.path.replaceAll("\\", "/");
    if (path.split("/").some(segment => SKIPPED_DIRECTORIES.has(segment))) return false;
    try { return !isSensitivePath(path) && normalizeRelativePath(path) === path; }
    catch { return false; }
  });
  const blobData = sourceFiles.length
    ? await runGit(repoRoot, ["cat-file", "--batch"], Buffer.from(`${sourceFiles.map(file => file.oid).join("\n")}\n`))
    : Buffer.alloc(0);
  const blobs = readBatch(blobData, sourceFiles.map(file => file.oid));
  const files = [];
  const redactedFiles = [];
  const databaseFiles = [];
  const infrastructureFiles = [];
  for (const entry of sourceFiles) {
    const raw = blobs.get(entry.oid);
    const textContent = raw.toString("utf8");
    const isText = !textContent.includes("\u0000");
    const safeContent = isText ? redactSecrets(textContent) : raw;
    if (isText && safeContent !== textContent) redactedFiles.push(entry.path);
    const file = { path: entry.path, content: safeContent, mode: entry.mode };
    if (isPlatformMigration({ ...file, content: isText ? safeContent : "" })) {
      continue;
    }
    files.push(file);
    if (/(^|\/)(?:migrations?|schema)\/.*\.sql$/i.test(entry.path) || /(^|\/)[^/]+\.sql$/i.test(entry.path) && /(^|\/)(?:database|db)\//i.test(entry.path)) {
      databaseFiles.push(file);
    }
    if (environmentConfigurationPaths(entry.path)) infrastructureFiles.push(file);
  }

  const envNames = environmentNames(files.filter(file => typeof file.content === "string"));
  const dependencies = dependencyManifest(files.filter(file => typeof file.content === "string"));
  const stack = runtimeMetadata(files.filter(file => typeof file.content === "string"));
  const languages = [...new Set(files.map(file => {
    const ext = file.path.split(".").pop()?.toLowerCase();
    return ({ js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript", py: "Python", go: "Go", rs: "Rust", java: "Java", sql: "SQL", rb: "Ruby", php: "PHP", cs: "C#", swift: "Swift" })[ext] || null;
  }).filter(Boolean))].sort();
  const manifest = {
    export_format: "feltus.portable-application/v1",
    application_id: application?.id || null,
    application_name: application?.app_name || application?.name || null,
    blueprint_id: blueprint?.id || null,
    blueprint_version: blueprint?.version ?? null,
    desired_state_hash_v1: blueprint?.state_hash || null,
    source_commit: resolved,
    detected_languages: languages,
    detected_frameworks: stack.frameworks,
    detected_runtimes: stack.runtimes,
    build_metadata: stack.build_metadata,
    package_manager: dependencies.package_manager,
    external_dependencies: dependencies.dependencies,
    schema_migration_version: schemaVersion || databaseFiles.map(file => file.path).sort().at(-1) || null,
    environment_variable_names: envNames,
    artifact_digest: artifact?.artifact_digest || artifact?.digest || null,
    exported_at: new Date().toISOString(),
    source_file_count: files.length,
    database_file_count: databaseFiles.length,
    infrastructure_file_count: infrastructureFiles.length,
    redacted_files: redactedFiles.sort(),
    excluded_source_paths: sourceFiles.length - files.length
  };
  const readme = [
    `# ${manifest.application_name || "Application"}`,
    "",
    "This package was exported from an approved source checkpoint.",
    `Source commit: ${resolved}`,
    "",
    "Open the source directory and follow the project’s own dependency and build instructions.",
    "The manifest lists dependency names, required environment variable names, and export lineage. Secret values are not included."
  ].join("\n");
  const entries = [];
  const add = (archivePath, content, mode = 0o644) => entries.push(...tarFile(archivePath, content, mode));
  add("README.md", readme);
  add("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of files) {
    add(`source/${file.path}`, file.content, file.mode);
  }
  for (const file of databaseFiles) add(`database/${file.path}`, file.content, file.mode);
  for (const file of infrastructureFiles) add(`infrastructure/${file.path}`, file.content, file.mode);
  entries.push(Buffer.alloc(1024));
  const archive = Buffer.concat(entries);
  if (archive.length > MAX_ARCHIVE_BYTES) throw Object.assign(new Error("Portable export exceeds the configured size limit."), { code: "EXPORT_TOO_LARGE" });
  return { archive, manifest };
}

export const portableExportLimits = Object.freeze({ maxArchiveBytes: MAX_ARCHIVE_BYTES });
