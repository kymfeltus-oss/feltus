import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isSensitivePath, normalizeRelativePath, redactSecrets } from "./security.mjs";

export const REPOSITORY_CLASSIFIER_VERSION = "feltus.repository-classifier/v2";
export const ENGINEERING_STANDARD_VERSION = "feltus.engineering-standard/v1";
export const CONTRACT_PROTECTION_VERSION = "feltus.contract-protection/v1";

const MAX_FILES = 2500;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_TOTAL_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_HASH_BYTES = 256 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  ".git", "node_modules", "vendor", ".next", "dist", "build", "coverage", ".cache",
  ".feltus-code-backups", ".feltus-runtime", ".feltus-storage", "__pycache__",
  ".venv", "venv", "target", "bin", "obj", ".terraform", ".serverless", ".vercel",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".gradle", ".idea", ".turbo",
  ".parcel-cache", "output", "tmp", "temp", "artifacts", "logs", "out",
  "storybook-static", "playwright-report", ".supabase", ".temp"
]);

const FRAMEWORK_PACKAGES = Object.freeze({
  next: "Next.js",
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  astro: "Astro",
  express: "Express",
  fastify: "Fastify",
  nestjs: "NestJS",
  "@nestjs/core": "NestJS",
  angular: "Angular",
  "@angular/core": "Angular",
  remix: "Remix",
  "@remix-run/react": "Remix",
  nuxt: "Nuxt",
  "@nuxt/kit": "Nuxt"
});

const DATABASE_PACKAGES = Object.freeze({
  pg: "PostgreSQL",
  postgres: "PostgreSQL",
  psycopg: "PostgreSQL",
  psycopg2: "PostgreSQL",
  asyncpg: "PostgreSQL",
  sqlalchemy: "SQLAlchemy",
  "@supabase/supabase-js": "Supabase",
  prisma: "Prisma",
  "@prisma/client": "Prisma",
  drizzle: "Drizzle",
  "drizzle-orm": "Drizzle",
  mongoose: "MongoDB",
  mongodb: "MongoDB",
  mysql2: "MySQL",
  pymysql: "MySQL",
  sqlite3: "SQLite",
  "better-sqlite3": "SQLite",
  django: "Django database backend",
  activerecord: "Active Record database backend"
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function repositorySnapshotHash(files) {
  return sha256([...files].sort((a, b) => a.path.localeCompare(b.path))
    .map(file => [file.path, file.kind || "file", file.size ?? Buffer.byteLength(file.content || ""), file.sha256 || "UNHASHED", file.skipped || ""].join("\0"))
    .join("\n"));
}

function unique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function packageJson(files) {
  const manifests = files.filter(item => path.posix.basename(item.path).toLowerCase() === "package.json");
  const parsed = manifests.flatMap(file => {
    try {
      const value = JSON.parse(file.content);
      return value && typeof value === "object" && !Array.isArray(value) ? [{ file, value }] : [];
    } catch {
      return [];
    }
  });
  if (!parsed.length) return null;
  const root = parsed.find(item => item.file.path.toLowerCase() === "package.json")?.value || parsed[0].value;
  const merge = key => Object.assign({}, ...parsed.map(item => item.value[key]).filter(value => value && typeof value === "object" && !Array.isArray(value)));
  return {
    ...root,
    dependencies: merge("dependencies"),
    devDependencies: merge("devDependencies"),
    peerDependencies: merge("peerDependencies"),
    optionalDependencies: merge("optionalDependencies"),
    scripts: merge("scripts"),
    engines: root.engines || parsed.map(item => item.value.engines).find(Boolean) || null,
    packageManager: root.packageManager || parsed.map(item => item.value.packageManager).find(Boolean) || null,
    manifest_paths: parsed.map(item => item.file.path)
  };
}

function pythonRequirements(files) {
  const names = [];
  for (const file of files.filter(item => /(^|\/)requirements(?:[-_.][^/]*)?\.txt$/i.test(item.path))) {
    for (const line of file.content.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z0-9_.-]+)\s*(?:[<>=!~;[\]]|$)/.exec(line);
      if (match) names.push(match[1].toLowerCase().replaceAll("_", "-"));
    }
  }
  return names;
}

function pythonProjectNames(files) {
  const pyproject = files.find(item => item.path === "pyproject.toml");
  const contents = `${pyproject?.content || ""}\n${pythonRequirements(files).join("\n")}`.toLowerCase();
  return contents;
}

function packageNames(pkg) {
  return new Set([
    ...Object.keys(pkg?.dependencies || {}),
    ...Object.keys(pkg?.devDependencies || {}),
    ...Object.keys(pkg?.peerDependencies || {}),
    ...Object.keys(pkg?.optionalDependencies || {})
  ]);
}

function hasPath(files, re) {
  return files.some(item => re.test(item.path));
}

function detectLanguages(files) {
  const counts = new Map();
  const extensionLanguage = new Map([
    [".js", "JavaScript"], [".mjs", "JavaScript"], [".cjs", "JavaScript"],
    [".jsx", "JavaScript"], [".ts", "TypeScript"], [".tsx", "TypeScript"],
    [".py", "Python"], [".go", "Go"], [".rs", "Rust"], [".sql", "SQL"],
    [".java", "Java"], [".kt", "Kotlin"], [".swift", "Swift"], [".rb", "Ruby"],
    [".php", "PHP"], [".cs", "C#"], [".cpp", "C++"], [".c", "C"],
    [".sh", "Shell"], [".yaml", "YAML"], [".yml", "YAML"], [".toml", "TOML"],
    [".html", "HTML"], [".css", "CSS"]
  ]);
  for (const file of files) {
    const language = extensionLanguage.get(path.extname(file.path).toLowerCase());
    if (language) counts.set(language, (counts.get(language) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, file_count]) => ({ name, file_count }));
}

function detectLanguageRoles(languages) {
  const configurationLanguages = new Set(["YAML", "TOML"]);
  const markupAndStyleLanguages = new Set(["HTML", "CSS"]);
  const sourceLanguages = languages.filter(item =>
    !configurationLanguages.has(item.name) && !markupAndStyleLanguages.has(item.name)
  );
  return {
    primary_language: sourceLanguages[0]?.name || languages.find(item => markupAndStyleLanguages.has(item.name))?.name || null,
    secondary_languages: sourceLanguages.slice(1).map(item => item.name),
    configuration_languages: languages.filter(item => configurationLanguages.has(item.name)).map(item => item.name),
    markup_style_languages: languages.filter(item => markupAndStyleLanguages.has(item.name)).map(item => item.name)
  };
}

function fileByPath(files, name) {
  const lowerName = name.toLowerCase();
  return files.find(item => item.path.toLowerCase() === lowerName) ||
    files.find(item => path.posix.basename(item.path).toLowerCase() === lowerName);
}

function detectTestLocations(files) {
  return unique(files.filter(file =>
    /(^|\/)(?:tests?|__tests__|spec)(\/|\.|$)/i.test(file.path) ||
    /\.(?:test|spec)\.[^.]+$/i.test(file.path) ||
    /_test\.go$/i.test(file.path) ||
    /\.bats$/i.test(file.path)
  ).map(file => file.path));
}

function detectPackageManagers(files, pkg = null) {
  const matches = [];
  const evidence = [
    ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"],
    ["bun.lock", "bun"], ["bun.lockb", "bun"],
    ["poetry.lock", "poetry"], ["uv.lock", "uv"], ["Pipfile.lock", "pipenv"],
    ["Pipfile", "pipenv"], ["requirements.txt", "pip"], ["Cargo.toml", "cargo"],
    ["go.mod", "go modules"], ["pom.xml", "Maven"], ["build.gradle", "Gradle"],
    ["build.gradle.kts", "Gradle"], ["composer.json", "Composer"], ["Gemfile", "Bundler"]
  ];
  for (const [file, name] of evidence) {
    const match = files.find(item => item.path.toLowerCase() === file.toLowerCase() || item.path.toLowerCase().endsWith("/" + file.toLowerCase()));
    if (match) matches.push({ name, evidence: match.path });
  }
  if (pkg?.packageManager) {
    const declared = String(pkg.packageManager).split("@")[0].toLowerCase();
    const normalized = ({ npm: "npm", pnpm: "pnpm", yarn: "yarn", bun: "bun" })[declared];
    if (normalized) matches.push({ name: normalized, evidence: "package.json#packageManager" });
  }
  const pyproject = fileByPath(files, "pyproject.toml");
  if (pyproject) {
    if (/\[tool\.poetry\]/i.test(pyproject.content) && !matches.some(item => item.name === "poetry")) matches.push({ name: "poetry", evidence: "pyproject.toml#tool.poetry" });
  }
  if (files.some(item => /\.csproj$/i.test(item.path) || /\.fsproj$/i.test(item.path)) && !matches.some(item => item.name === "NuGet")) {
    matches.push({ name: "NuGet", evidence: "dotnet project file" });
  }
  if (fileByPath(files, "Gemfile.lock") && !matches.some(item => item.name === "Bundler")) matches.push({ name: "Bundler", evidence: "Gemfile.lock" });
  const distinct = new Map();
  for (const item of matches) {
    const current = distinct.get(item.name);
    if (!current) distinct.set(item.name, { ...item, evidence_sources: [item.evidence] });
    else current.evidence_sources.push(item.evidence);
  }
  const conflictGroups = packageManagerConflictGroups([...distinct.values()]);
  return [...distinct.values()].map(item => ({
    ...item,
    evidence_sources: unique(item.evidence_sources),
    conflict: conflictGroups.some(group => group.managers.includes(item.name))
  }));
}

function detectFrameworks(pkg, files = []) {
  const names = packageNames(pkg);
  const found = [...names].filter(name => FRAMEWORK_PACKAGES[name]).map(name => FRAMEWORK_PACKAGES[name]);
  const textFor = pattern => files.filter(file => pattern.test(file.path)).map(file => file.content || "").join("\n").toLowerCase();
  const python = (pythonProjectNames(files) + "\n" + textFor(/\.py$/i)).toLowerCase();
  const java = textFor(/(?:pom\.xml|build\.gradle(?:\.kts)?|\.java|\.kt)$/i);
  const php = textFor(/(?:composer\.json|\.php)$/i);
  const ruby = textFor(/(?:Gemfile|\.rb)$/i);
  const dotnet = textFor(/(?:\.csproj|\.fsproj|\.cs)$/i);
  const go = textFor(/(?:go\.mod|\.go)$/i);
  if (["fastapi", "flask", "django"].some(name => python.includes(name))) {
    if (python.includes("fastapi")) found.push("FastAPI");
    if (python.includes("flask")) found.push("Flask");
    if (python.includes("django")) found.push("Django");
  }
  if (java.includes("spring-boot") || java.includes("org.springframework")) found.push("Spring");
  if (php.includes("laravel/framework") || php.includes("laravel\\")) found.push("Laravel");
  if (ruby.includes("rails")) found.push("Ruby on Rails");
  if (dotnet.includes("aspnetcore") || dotnet.includes("microsoft.net.sdk.web")) found.push("ASP.NET Core");
  if (go.includes("gin-gonic/gin")) found.push("Gin");
  if (go.includes("gofiber/fiber")) found.push("Fiber");
  if (go.includes("labstack/echo")) found.push("Echo");
  return unique(found);
}

function detectDatabases(pkg, files) {
  const names = packageNames(pkg);
  const found = [...names].filter(name => DATABASE_PACKAGES[name]).map(name => DATABASE_PACKAGES[name]);
  const python = pythonProjectNames(files);
  for (const [needle, label] of [
    ["psycopg", "PostgreSQL"], ["asyncpg", "PostgreSQL"], ["sqlalchemy", "SQLAlchemy"],
    ["pymysql", "MySQL"], ["mysqlclient", "MySQL"], ["sqlite", "SQLite"],
    ["pymongo", "MongoDB"]
  ]) if (python.includes(needle)) found.push(label);
  if (files.some(item => /(^|\/)supabase\/config\.toml$/i.test(item.path))) found.push("Supabase");
  if (hasPath(files, /(^|\/)(?:migrations?|db|database)\/.*\.sql$/i)) found.push("SQL database (migration evidence)");
  const prismaSchema = files.find(item => /(^|\/)schema\.prisma$/i.test(item.path));
  if (prismaSchema) {
    found.push("Prisma");
    const provider = prismaSchema.content.match(/provider\s*=\s*["'](postgresql|mysql|sqlite|mongodb|sqlserver)["']/i)?.[1]?.toLowerCase();
    const engines = { postgresql: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite", mongodb: "MongoDB", sqlserver: "SQL Server" };
    if (provider && engines[provider]) found.push(engines[provider]);
  }
  return unique(found);
}

function detectToolchain(files, pkg) {
  const names = packageNames(pkg);
  const scripts = Object.keys(pkg?.scripts || {});
  const python = pythonProjectNames(files);
  const formatters = [];
  const linters = [];
  const typeCheckers = [];
  const testRunners = [];
  const buildSystems = [];
  const migrationTools = [];

  if (names.has("prettier") || hasPath(files, /(^|\/)\.prettierrc(?:\.[^/]*)?$|(^|\/)prettier\.config\.[^/]+$/i)) formatters.push({ name: "Prettier", ecosystem: "JavaScript/TypeScript", evidence: names.has("prettier") ? "package.json dependency" : "Prettier configuration" });
  if (names.has("eslint") || hasPath(files, /(^|\/)eslint\.config\.[^/]+$|(^|\/)\.eslintrc(?:\.[^/]*)?$/i)) linters.push({ name: "ESLint", ecosystem: "JavaScript/TypeScript" });
  if (names.has("@biomejs/biome") || hasPath(files, /(^|\/)biome\.json(?:c)?$/i)) {
    formatters.push({ name: "Biome", ecosystem: "JavaScript/TypeScript" });
    linters.push({ name: "Biome", ecosystem: "JavaScript/TypeScript" });
  }
  if (names.has("typescript") || hasPath(files, /(^|\/)tsconfig\.json$/i)) typeCheckers.push({ name: "TypeScript", ecosystem: "JavaScript/TypeScript" });
  const scriptText = Object.values(pkg?.scripts || {}).join("\n");
  const jsRunner = [["vitest", "Vitest"], ["jest", "Jest"], ["mocha", "Mocha"], ["playwright", "Playwright"], ["cypress", "Cypress"], ["node --test", "Node test"]];
  for (const [needle, label] of jsRunner) {
    if (names.has(needle) || scriptText.toLowerCase().includes(needle)) testRunners.push({ name: label, ecosystem: "JavaScript/TypeScript" });
  }
  if (scripts.some(name => /^(build|bundle|compile)$/i.test(name)) || /\b(?:next|vite|webpack|rollup|esbuild)\s+build\b/i.test(scriptText)) buildSystems.push({ name: "package build script", ecosystem: "JavaScript/TypeScript" });
  for (const [name, label] of [["vite", "Vite"], ["webpack", "webpack"], ["rollup", "Rollup"], ["esbuild", "esbuild"]]) if (names.has(name)) buildSystems.push({ name: label, ecosystem: "JavaScript/TypeScript" });
  if (names.has("typescript") && hasPath(files, /(^|\/)tsconfig\.json$/i)) buildSystems.push({ name: "TypeScript compiler", ecosystem: "JavaScript/TypeScript" });
  if (names.has("prisma") || names.has("@prisma/client")) migrationTools.push({ name: "Prisma Migrate", ecosystem: "Node.js" });
  if (names.has("drizzle-orm") || names.has("drizzle-kit")) migrationTools.push({ name: "Drizzle Kit", ecosystem: "Node.js" });
  if (python.includes("ruff")) { formatters.push({ name: "Ruff format", ecosystem: "Python" }); linters.push({ name: "Ruff", ecosystem: "Python" }); }
  if (python.includes("black")) formatters.push({ name: "Black", ecosystem: "Python" });
  if (python.includes("flake8")) linters.push({ name: "Flake8", ecosystem: "Python" });
  if (python.includes("mypy")) typeCheckers.push({ name: "mypy", ecosystem: "Python" });
  if (python.includes("pyright")) typeCheckers.push({ name: "Pyright", ecosystem: "Python" });
  if (python.includes("pytest") || hasPath(files, /(^|\/)(?:pytest\.ini|tox\.ini)$/i)) testRunners.push({ name: "pytest", ecosystem: "Python" });
  if (files.some(file => /\.py$/i.test(file.path) && /\b(?:import unittest|from unittest)\b/.test(file.content))) testRunners.push({ name: "unittest", ecosystem: "Python" });
  if (hasPath(files, /(^|\/)alembic\.ini$/i)) migrationTools.push({ name: "Alembic", ecosystem: "Python" });
  if (hasPath(files, /(^|\/)manage\.py$/i) && python.includes("django")) migrationTools.push({ name: "Django migrations", ecosystem: "Python" });
  if (hasPath(files, /(^|\/)pyproject\.toml$/i) && /\[build-system\]/i.test(fileByPath(files, "pyproject.toml")?.content || "")) buildSystems.push({ name: "Python packaging", ecosystem: "Python" });
  if (files.some(item => item.path === "go.mod")) {
    formatters.push({ name: "gofmt", ecosystem: "Go" });
    testRunners.push({ name: "go test", ecosystem: "Go" });
    typeCheckers.push({ name: "Go compiler", ecosystem: "Go" });
    buildSystems.push({ name: "go build", ecosystem: "Go" });
  }
  if (hasPath(files, /(^|\/)\.?golangci\.ya?ml$/i) || python.includes("golangci-lint")) linters.push({ name: "golangci-lint", ecosystem: "Go" });
  if (files.some(item => item.path === "Cargo.toml")) {
    formatters.push({ name: "rustfmt", ecosystem: "Rust" });
    linters.push({ name: "Clippy", ecosystem: "Rust" });
    testRunners.push({ name: "cargo test", ecosystem: "Rust" });
    buildSystems.push({ name: "Cargo", ecosystem: "Rust" });
  }
  if (fileByPath(files, "pom.xml") || hasPath(files, /(^|\/)build\.gradle(?:\.kts)?$/i)) {
    const javaText = files.filter(file => /(?:pom\.xml|build\.gradle(?:\.kts)?)$/i.test(file.path)).map(file => file.content).join("\n").toLowerCase();
    typeCheckers.push({ name: "Java compiler", ecosystem: "Java" });
    buildSystems.push({ name: fileByPath(files, "pom.xml") ? "Maven" : "Gradle", ecosystem: "Java" });
    if (/junit|testng/.test(javaText)) testRunners.push({ name: /testng/.test(javaText) ? "TestNG" : "JUnit", ecosystem: "Java" });
    if (/checkstyle/.test(javaText) || hasPath(files, /(^|\/)checkstyle\.xml$/i)) linters.push({ name: "Checkstyle", ecosystem: "Java" });
    if (/spotbugs/.test(javaText)) linters.push({ name: "SpotBugs", ecosystem: "Java" });
  }
  if (files.some(file => /\.csproj$/i.test(file.path) || /\.fsproj$/i.test(file.path))) {
    buildSystems.push({ name: "dotnet", ecosystem: "C#" });
    typeCheckers.push({ name: "C# compiler", ecosystem: "C#" });
    if (files.some(file => /(?:xunit|nunit|mstest)/i.test(file.content))) testRunners.push({ name: /nunit/i.test(files.map(file => file.content).join("\n")) ? "NUnit" : "xUnit or MSTest", ecosystem: "C#" });
    if (hasPath(files, /(^|\/)\.editorconfig$/i)) formatters.push({ name: "dotnet format configuration", ecosystem: "C#" });
  }
  if (fileByPath(files, "composer.json")) {
    const composer = fileByPath(files, "composer.json").content.toLowerCase();
    buildSystems.push({ name: "Composer", ecosystem: "PHP" });
    if (composer.includes("phpunit/phpunit")) testRunners.push({ name: "PHPUnit", ecosystem: "PHP" });
    if (composer.includes("phpstan/phpstan")) linters.push({ name: "PHPStan", ecosystem: "PHP" });
    if (composer.includes("laravel/pint")) formatters.push({ name: "Laravel Pint", ecosystem: "PHP" });
  }
  if (fileByPath(files, "Gemfile")) {
    const gemfile = fileByPath(files, "Gemfile").content.toLowerCase();
    if (gemfile.includes("rubocop")) linters.push({ name: "RuboCop", ecosystem: "Ruby" });
    if (gemfile.includes("rspec")) testRunners.push({ name: "RSpec", ecosystem: "Ruby" });
    if (gemfile.includes("minitest")) testRunners.push({ name: "Minitest", ecosystem: "Ruby" });
    buildSystems.push({ name: "Bundler", ecosystem: "Ruby" });
  }
  const shellScripts = files.filter(file => /\.sh$/i.test(file.path));
  if (shellScripts.length) {
    const shellText = shellScripts.map(file => file.content).join("\n").toLowerCase();
    if (hasPath(files, /(^|\/)\.shellcheckrc$/i) || shellText.includes("shellcheck")) linters.push({ name: "ShellCheck", ecosystem: "Shell" });
    if (/\bshfmt\b/i.test(shellText)) formatters.push({ name: "shfmt", ecosystem: "Shell" });
    if (files.some(file => /\.bats$/i.test(file.path)) || hasPath(files, /(^|\/)bats\.config\./i)) testRunners.push({ name: "Bats", ecosystem: "Shell" });
  }
  if (fileByPath(files, "Makefile")) buildSystems.push({ name: "Make", ecosystem: "repository" });
  if (files.some(item => /(^|\/)Dockerfile(?:\.[^/]*)?$/i.test(item.path)) || hasPath(files, /(^|\/)(?:compose|docker-compose)(?:\.[^/]*)?\.ya?ml$/i)) {
    buildSystems.push({ name: "container build configuration", ecosystem: "container" });
  }
  if (hasPath(files, /(^|\/)(?:supabase|prisma|drizzle|alembic|migrations?)(\/|\.)/i)) migrationTools.push({ name: "repository migration assets", ecosystem: "database" });
  if (hasPath(files, /(^|\/)flyway\.conf$/i) || hasPath(files, /(^|\/)db\/migration\/V[0-9].*\.sql$/i)) migrationTools.push({ name: "Flyway", ecosystem: "database" });
  if (hasPath(files, /(^|\/)liquibase\.(?:properties|ya?ml)$/i) || hasPath(files, /(^|\/)changelog[^/]*\.xml$/i)) migrationTools.push({ name: "Liquibase", ecosystem: "database" });
  return { formatters, linters, type_checkers: typeCheckers, test_runners: testRunners, build_systems: buildSystems, migration_tools: migrationTools };
}

function detectRuntimes(files, pkg) {
  const runtimes = [];
  const nodeVersionFile = fileByPath(files, ".nvmrc") || fileByPath(files, ".node-version");
  const dockerFiles = files.filter(file => /(^|\/)Dockerfile(?:\.[^/]*)?$/i.test(file.path));
  const dockerNodeVersion = dockerFiles.map(file => file.content.match(/^\s*FROM\s+node:([^\s@]+)/im)?.[1]).find(Boolean);
  const nodeVersion = pkg?.engines?.node || nodeVersionFile?.content.trim() || dockerNodeVersion || null;
  if (fileByPath(files, "package.json") || nodeVersionFile || dockerNodeVersion) {
    runtimes.push({
      name: "Node.js",
      version: nodeVersion ? String(nodeVersion) : null,
      evidence: pkg?.engines?.node ? "package.json#engines.node" : nodeVersionFile?.path || (dockerNodeVersion ? "Dockerfile#FROM node" : "package.json")
    });
  }
  const pythonProject = files.some(file => /\.py$/i.test(file.path) || /(^|\/)(?:pyproject\.toml|requirements[^/]*\.txt|Pipfile)$/i.test(file.path));
  if (pythonProject) {
    const pyproject = fileByPath(files, "pyproject.toml");
    const requiresPython = pyproject?.content.match(/requires-python\s*=\s*["']([^"']+)["']/i)?.[1];
    const versionFile = fileByPath(files, ".python-version") || fileByPath(files, "runtime.txt");
    runtimes.push({ name: "Python", version: requiresPython || versionFile?.content.trim() || null, evidence: requiresPython ? "pyproject.toml#project.requires-python" : versionFile?.path || "Python source or dependency files" });
  }
  const goMod = fileByPath(files, "go.mod");
  if (goMod) runtimes.push({ name: "Go", version: goMod.content.match(/^go\s+([0-9.]+)/m)?.[1] || goMod.content.match(/^toolchain\s+(go[0-9.]+)/m)?.[1] || null, evidence: "go.mod" });
  const cargo = fileByPath(files, "Cargo.toml");
  if (cargo || files.some(file => path.extname(file.path).toLowerCase() === ".rs")) runtimes.push({ name: "Rust", version: null, evidence: cargo ? "Cargo.toml" : "Rust source" });
  const javaBuild = files.find(file => /(?:pom\.xml|build\.gradle(?:\.kts)?)$/i.test(file.path));
  if (javaBuild || files.some(file => path.extname(file.path).toLowerCase() === ".java")) {
    const version = javaBuild?.content.match(/(?:maven\.compiler\.(?:source|target)|<maven.compiler.release>|<java.version>)[^0-9]*([0-9][0-9.]*)/i)?.[1] || null;
    runtimes.push({ name: "JVM", version, evidence: javaBuild?.path || "Java source" });
  }
  const dotnetProject = files.find(file => /\.(?:csproj|fsproj)$/i.test(file.path));
  if (dotnetProject) runtimes.push({ name: ".NET", version: dotnetProject.content.match(/<TargetFrameworks?>([^<]+)</i)?.[1] || null, evidence: dotnetProject.path });
  const composer = fileByPath(files, "composer.json");
  if (composer) {
    let version = null;
    try { version = JSON.parse(composer.content).require?.php || null; } catch {}
    runtimes.push({ name: "PHP", version, evidence: "composer.json" });
  }
  const rubyVersion = fileByPath(files, ".ruby-version");
  if (rubyVersion || fileByPath(files, "Gemfile")) runtimes.push({ name: "Ruby", version: rubyVersion?.content.trim() || null, evidence: rubyVersion?.path || "Gemfile" });
  if (files.some(file => /\.sh$/i.test(file.path))) runtimes.push({ name: "Shell", version: null, evidence: "Shell script files" });
  if (dockerFiles.length) runtimes.push({ name: "Container runtime", version: null, evidence: "Dockerfile" });
  if (files.some(file => /\.html?$/i.test(file.path)) && !runtimes.some(item => ["Python", "Go", "JVM", ".NET", "PHP", "Ruby"].includes(item.name))) {
    runtimes.push({ name: "Browser", version: null, evidence: "HTML application files" });
  }
  return runtimes;
}

function detectProviderEvidence(files) {
  const providers = [
    ["Vercel", /(^|\/)vercel\.json$/i],
    ["Netlify", /(^|\/)netlify\.toml$/i],
    ["Serverless Framework", /(^|\/)serverless\.[^/]+$/i],
    ["Fly.io", /(^|\/)fly\.toml$/i],
    ["Render", /(^|\/)render\.ya?ml$/i],
    ["AWS SAM", /(^|\/)template\.(?:yaml|yml)$/i],
    ["AWS Amplify", /(^|\/)amplify\.ya?ml$/i],
    ["Cloudflare", /(^|\/)wrangler\.toml$/i],
    ["Heroku", /(^|\/)Procfile$/i],
    ["Coolify", /(^|\/)coolify\.(?:json|toml|yaml|yml)$/i],
    ["Railway", /(^|\/)railway\.json$/i]
  ];
  return providers.flatMap(([name, pattern]) => {
    const evidence = files.filter(file => pattern.test(file.path)).map(file => file.path);
    return evidence.length ? [{ name, evidence }] : [];
  });
}

function detectFrameworkEvidence(frameworks, files, pkg) {
  const dependencies = packageNames(pkg);
  return frameworks.map(name => {
    let evidence = [];
    const matchingPackages = Object.entries(FRAMEWORK_PACKAGES)
      .filter(([packageName, framework]) => framework === name && dependencies.has(packageName));
    if (matchingPackages.length) evidence = pkg?.manifest_paths || ["package.json"];
    const sourceEvidence = {
      FastAPI: { path: /(?:pyproject\.toml|requirements[^/]*\.txt|\.py)$/i, text: /fastapi/i },
      Flask: { path: /(?:pyproject\.toml|requirements[^/]*\.txt|\.py)$/i, text: /flask/i },
      Django: { path: /(?:pyproject\.toml|requirements[^/]*\.txt|\.py)$/i, text: /django/i },
      Spring: { path: /(?:pom\.xml|build\.gradle(?:\.kts)?|\.java|\.kt)$/i, text: /spring-boot|org\.springframework/i },
      Laravel: { path: /(?:composer\.json|\.php)$/i, text: /laravel/i },
      "Ruby on Rails": { path: /(?:Gemfile|\.rb)$/i, text: /rails/i },
      "ASP.NET Core": { path: /(?:\.csproj|\.fsproj|\.cs)$/i, text: /aspnetcore|microsoft\.net\.sdk\.web/i },
      Gin: { path: /(?:go\.mod|\.go)$/i, text: /gin-gonic\/gin/i },
      Fiber: { path: /(?:go\.mod|\.go)$/i, text: /gofiber\/fiber/i },
      Echo: { path: /(?:go\.mod|\.go)$/i, text: /labstack\/echo/i }
    }[name];
    if (!evidence.length && sourceEvidence) {
      evidence = files.filter(file => sourceEvidence.path.test(file.path) && sourceEvidence.text.test(file.content)).map(file => file.path).slice(0, 10);
    }
    if (!evidence.length && ["Next.js", "Vue", "Svelte", "SvelteKit", "Astro", "Nuxt", "Angular"].includes(name)) {
      const configPatterns = {
        "Next.js": /(^|\/)next\.config\.[^/]+$/i,
        Vue: /(^|\/)vue\.config\.[^/]+$/i,
        Svelte: /(^|\/)svelte\.config\.[^/]+$/i,
        SvelteKit: /(^|\/)svelte\.config\.[^/]+$/i,
        Astro: /(^|\/)astro\.config\.[^/]+$/i,
        Nuxt: /(^|\/)nuxt\.config\.[^/]+$/i,
        Angular: /(^|\/)angular\.json$/i
      };
      evidence = files.filter(file => configPatterns[name].test(file.path)).map(file => file.path);
    }
    return { name, evidence };
  });
}

function resolveKnownCommands(pkg, packageManagers, testRunners, files) {
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const jsPackageManager = packageManagers.find(item => ["npm", "pnpm", "yarn", "bun"].includes(item.name))?.name || null;
  const known = [];
  const scriptCandidates = [
    ["check", ["check"]],
    ["lint", ["lint", "lint:check"]],
    ["format", ["format:check", "format:check:ci", "prettier:check"]],
    ["typecheck", ["typecheck", "type-check", "check:types"]],
    ["tests", ["test:ci", "test", "test:unit"]],
    ["build", ["build", "compile"]]
  ];
  for (const [id, candidates] of scriptCandidates) {
    const script = candidates.find(name => typeof scripts[name] === "string" && scripts[name].trim());
    if (script) known.push({
      id,
      command: jsPackageManager,
      args: jsPackageManager ? ["run", script] : [],
      configured_script: script,
      evidence: "package.json#scripts." + script
    });
  }
  const testScript = known.find(item => item.id === "tests");
  const jsRunners = {
    "node test": ["node", ["--test"]],
    vitest: ["npx", ["vitest", "run"]],
    jest: ["npx", ["jest"]],
    mocha: ["npx", ["mocha"]],
    playwright: ["npx", ["playwright", "test"]],
    cypress: ["npx", ["cypress", "run"]]
  };
  const testCommands = [];
  for (const runner of testRunners) {
    const mapped = jsRunners[runner.name.toLowerCase()];
    if (mapped) {
      if (testScript?.command) testCommands.push({
        runner: runner.name, command: testScript.command, args: testScript.args, evidence: testScript.evidence
      });
      else if (runner.name.toLowerCase() === "node test") testCommands.push({
        runner: runner.name, command: mapped[0], args: mapped[1], evidence: "Node test runner"
      });
      else if (jsPackageManager) testCommands.push({
        runner: runner.name,
        command: jsPackageManager === "npm" ? "npx" : jsPackageManager === "pnpm" ? "pnpm" : jsPackageManager === "yarn" ? "yarn" : "bunx",
        args: jsPackageManager === "pnpm" ? ["exec", ...mapped[1]] : mapped[1],
        evidence: "package manager and repository-declared test runner"
      });
      else continue;
    } else if (runner.name === "go test") {
      testCommands.push({ runner: runner.name, command: "go", args: ["test", "./..."], evidence: "go.mod" });
    } else if (runner.name === "pytest") {
      testCommands.push({ runner: runner.name, command: "python", args: ["-m", "pytest", "-q"], evidence: "pytest configuration or dependency" });
    } else if (runner.name === "unittest") {
      testCommands.push({ runner: runner.name, command: "python", args: ["-m", "unittest"], evidence: "unittest source import" });
    } else if (runner.name === "JUnit" || runner.name === "TestNG") {
      testCommands.push({ runner: runner.name, command: fileByPath(files, "pom.xml") ? "mvn" : "gradle", args: ["test"], evidence: "Java build manifest" });
    } else if (runner.name === "PHPUnit") {
      testCommands.push({ runner: runner.name, command: "vendor/bin/phpunit", args: [], evidence: "composer.json" });
    } else if (runner.name === "RSpec") {
      testCommands.push({ runner: runner.name, command: "bundle", args: ["exec", "rspec"], evidence: "Gemfile" });
    }
  }
  return { configured_commands: known, test_commands: testCommands };
}

function detectInfrastructureConfiguration(files) {
  return unique(files.filter(file =>
    /(^|\/)(?:Dockerfile(?:\.[^/]*)?|(?:compose|docker-compose)(?:\.[^/]*)?\.ya?ml|vercel\.json|netlify\.toml|serverless\.[^/]+|fly\.toml|render\.ya?ml|Procfile|railway\.json|coolify\.(?:json|toml|ya?ml)|amplify\.ya?ml|wrangler\.toml|buildpack\.toml|nixpacks\.toml)$/i.test(file.path) ||
    /(^|\/)(?:terraform|infra|infrastructure)\/[^/]+\.tf$/i.test(file.path)
  ).map(file => file.path));
}

function packageManagerConflictGroups(managers) {
  const ecosystems = {
    npm: "JavaScript", pnpm: "JavaScript", yarn: "JavaScript", bun: "JavaScript",
    pip: "Python", poetry: "Python", uv: "Python", pipenv: "Python",
    Maven: "Java", Gradle: "Java"
  };
  const groups = new Map();
  for (const manager of managers) {
    const ecosystem = ecosystems[manager.name];
    if (!ecosystem) continue;
    const group = groups.get(ecosystem) || new Set();
    group.add(manager.name);
    groups.set(ecosystem, group);
  }
  return [...groups.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([ecosystem, names]) => ({ ecosystem, managers: [...names].sort() }));
}

async function hashFileContents(absolutePath) {
  const digest = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(absolutePath)) {
    size += chunk.length;
    digest.update(chunk);
  }
  return { sha256: digest.digest("hex"), size };
}

const SOURCE_TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs",
  ".java", ".kt", ".rb", ".php", ".cs", ".c", ".h", ".cpp", ".sql",
  ".html", ".css", ".json", ".xml", ".yaml", ".yml", ".toml", ".gradle",
  ".properties", ".sh", ".txt", ".md", ".proto"
]);

function isLikelySourceText(relativePath) {
  const lower = relativePath.toLowerCase();
  return SOURCE_TEXT_EXTENSIONS.has(path.extname(lower)) ||
    /(^|\/)(?:dockerfile(?:\.[^/]*)?|makefile|gemfile(?:\.lock)?|procfile|go\.mod|go\.sum|cargo\.toml|cargo\.lock|pom\.xml|composer\.json|package\.json|requirements[^/]*\.txt|pipfile(?:\.lock)?|pyproject\.toml|\.nvmrc|\.ruby-version|\.python-version)$/i.test(relativePath);
}

export async function scanRepository(repoRoot, {
  maxFiles = MAX_FILES,
  maxHashBytes = MAX_TOTAL_HASH_BYTES,
  maxTextBytes = MAX_TOTAL_TEXT_BYTES
} = {}) {
  const canonicalRoot = await fs.realpath(path.resolve(repoRoot));
  const files = [];
  const incompleteReasons = new Set();
  const incompleteFiles = new Map();
  const markIncomplete = (reason, filePath = null) => {
    incompleteReasons.add(reason);
    if (filePath) {
      const current = incompleteFiles.get(filePath) || [];
      current.push(reason);
      incompleteFiles.set(filePath, current);
    }
  };
  let hashedBytes = 0;
  let textBytes = 0;
  let truncated = false;

  async function walk(directory, relativeDirectory) {
    if (truncated) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) break;
      if (entry.isSymbolicLink()) continue;
      const lowerName = entry.name.toLowerCase();
      if (entry.isDirectory() && (
        IGNORED_DIRECTORIES.has(lowerName) ||
        lowerName.startsWith(".feltus-build-studio-") ||
        relativeDirectory.split("/").concat(entry.name).some(part => part.toLowerCase().startsWith(".phase"))
      )) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const ignoredLocalName = relativePath.split("/").some(part =>
        part.toLowerCase() === ".feltus-dev-auth.json" || part.toLowerCase().startsWith(".phase")
      );
      if (isSensitivePath(relativePath) || ignoredLocalName) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        if (files.length >= maxFiles) {
          truncated = true;
          markIncomplete("file_count_limit", relativePath);
          break;
        }
        const stat = await fs.stat(absolutePath);
        if (stat.size > maxHashBytes - hashedBytes) {
          files.push({ path: relativePath, size: stat.size, sha256: null, content: "", skipped: "hash byte limit" });
          markIncomplete("hash_byte_limit", relativePath);
          continue;
        }
        let content = "";
        let digest;
        if (stat.size <= MAX_EVIDENCE_BYTES && stat.size <= maxTextBytes - textBytes) {
          const buffer = await fs.readFile(absolutePath);
          hashedBytes += buffer.length;
          if (buffer.length !== stat.size) {
            markIncomplete("file_changed_during_scan", relativePath);
            files.push({ path: relativePath, size: stat.size, sha256: sha256(buffer), content: "", skipped: "file changed during scan" });
            continue;
          }
          digest = sha256(buffer);
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
            if (content.includes("\0")) content = "";
            else textBytes += buffer.length;
          } catch {
            content = "";
          }
        } else {
          const hashed = await hashFileContents(absolutePath);
          hashedBytes += hashed.size;
          digest = hashed.sha256;
          if (isLikelySourceText(relativePath)) markIncomplete(
            stat.size > MAX_EVIDENCE_BYTES ? "source_file_evidence_limit" : "total_text_evidence_limit",
            relativePath
          );
        }
        const currentStat = await fs.stat(absolutePath);
        if (currentStat.size !== stat.size || currentStat.mtimeMs !== stat.mtimeMs || currentStat.ctimeMs !== stat.ctimeMs) {
          markIncomplete("file_changed_during_scan", relativePath);
        }
        files.push({
          path: relativePath,
          size: stat.size,
          sha256: digest,
          content,
          ...(content ? {} : { skipped: stat.size > MAX_EVIDENCE_BYTES ? "file exceeds text evidence limit" : "binary or non-UTF-8 file" })
        });
      }
    }
  }

  await walk(canonicalRoot, "");
  const snapshotHash = repositorySnapshotHash(files);
  const reasons = [...incompleteReasons].sort();
  return {
    root: canonicalRoot,
    files,
    snapshot_sha256: snapshotHash,
    truncated,
    complete: reasons.length === 0,
    incomplete_reasons: reasons,
    incomplete_files: [...incompleteFiles.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([filePath, fileReasons]) => ({
      path: filePath,
      reasons: unique(fileReasons)
    })),
    hashed_bytes: hashedBytes,
    text_bytes: textBytes
  };
}

const BUILTIN_DETECTORS = Object.freeze([
  async ({ files }) => ({ languages: detectLanguages(files) }),
  async ({ files, pkg }) => ({
    package_managers: detectPackageManagers(files, pkg),
    frameworks: detectFrameworks(pkg, files),
    databases: detectDatabases(pkg, files),
    ...detectToolchain(files, pkg)
  })
]);

export async function classifyRepository(repoRoot, {
  applicationId = null,
  sourceWorkspaceId = applicationId,
  sourceBranch = null,
  sourceCommit = null,
  sourceCheckpointId = null,
  detectedAt = new Date().toISOString(),
  classifierVersion = REPOSITORY_CLASSIFIER_VERSION,
  detectors = BUILTIN_DETECTORS,
  snapshot = null
} = {}) {
  const canonicalRoot = await fs.realpath(path.resolve(repoRoot));
  const sourceSnapshot = snapshot || await scanRepository(canonicalRoot);
  if (sourceSnapshot.root) {
    const suppliedRoot = path.resolve(sourceSnapshot.root);
    const rootsMatch = process.platform === "win32"
      ? suppliedRoot.toLowerCase() === canonicalRoot.toLowerCase()
      : suppliedRoot === canonicalRoot;
    if (!rootsMatch) throw Object.assign(new Error("Classification snapshot does not match the authorized workspace."), { code: "SNAPSHOT_WORKSPACE_MISMATCH" });
  }
  const pkg = packageJson(sourceSnapshot.files);
  const languages = [];
  const base = {
    application_id: applicationId,
    source_workspace_id: sourceWorkspaceId,
    source_branch: sourceBranch,
    source_checkpoint_id: sourceCheckpointId,
    source_commit: sourceCommit,
    source_snapshot_sha256: sourceSnapshot.snapshot_sha256,
    classifier_version: classifierVersion,
    detected_at: new Date(detectedAt).toISOString(),
    truncated: sourceSnapshot.truncated,
    source_snapshot_complete: sourceSnapshot.complete !== false,
    incomplete_reasons: sourceSnapshot.incomplete_reasons || [],
    incomplete_files: sourceSnapshot.incomplete_files || [],
    evidence: sourceSnapshot.files.map(file => ({ path: file.path, sha256: file.sha256, size: file.size, skipped: file.skipped || null }))
  };
  const results = await Promise.all(detectors.map(detector => detector({ files: sourceSnapshot.files, package_json: pkg, pkg })));
  const merged = Object.assign({}, ...results.filter(value => value && typeof value === "object"));
  languages.push(...(merged.languages || []));
  const frameworks = unique(merged.frameworks || []);
  const packageManagers = merged.package_managers || [];
  const packageManagerConflicts = packageManagerConflictGroups(packageManagers);
  const sourceLanguageNames = languages
    .map(item => item.name)
    .filter(name => !["HTML", "CSS", "YAML", "TOML"].includes(name));
  const supportedLanguageNames = new Set(["JavaScript", "TypeScript", "Python", "Go", "Rust", "Java", "Kotlin", "Ruby", "PHP", "C#", "Shell", "SQL"]);
  const unsupportedLanguages = sourceLanguageNames.filter(name => !supportedLanguageNames.has(name));
  const supportedSourceLanguages = sourceLanguageNames.filter(name => supportedLanguageNames.has(name) && !["Shell", "SQL"].includes(name));
  const sourceEcosystems = unique(supportedSourceLanguages.map(name => ["JavaScript", "TypeScript"].includes(name) ? "JavaScript/TypeScript" : name));
  const serverFrameworks = new Set(["Next.js", "Remix", "Nuxt", "Express", "Fastify", "NestJS", "FastAPI", "Flask", "Django", "Spring", "ASP.NET Core", "Laravel", "Ruby on Rails", "Gin", "Fiber", "Echo"]);
  const staticApplication = languages.some(item => item.name === "HTML") &&
    !sourceLanguageNames.some(name => ["Python", "Go", "Rust", "Java", "Kotlin", "Ruby", "PHP", "C#", "C", "C++"].includes(name)) &&
    !frameworks.some(name => serverFrameworks.has(name));
  const classificationStatus = sourceSnapshot.complete === false
    ? "INCOMPLETE"
    : sourceEcosystems.length === 0 && !staticApplication ? "UNKNOWN"
      : unsupportedLanguages.length > 0 || sourceEcosystems.length > 1 ? "MIXED"
        : "CLASSIFIED";
  const testRunners = merged.test_runners || [];
  const knownCommands = resolveKnownCommands(pkg, packageManagers, testRunners, sourceSnapshot.files);
  const migrationEvidence = sourceSnapshot.files.filter(file =>
    /(^|\/)(?:migrations?|database\/migrations|db\/migration)(\/|$)/i.test(file.path) ||
    /(^|\/)(?:alembic\.ini|schema\.prisma|flyway\.conf|liquibase\.(?:properties|ya?ml))$/i.test(file.path)
  ).map(file => file.path);
  const migrationIdentifiers = migrationEvidence
    .filter(file => /(^|\/)(?:migrations?|migration)(\/|$)/i.test(file))
    .map(file => path.posix.basename(file));
  const providers = detectProviderEvidence(sourceSnapshot.files);
  const languageRoles = detectLanguageRoles(languages);
  const missingSourceIdentity = [];
  if (!sourceCommit) missingSourceIdentity.push("commit");
  if (!sourceCheckpointId) missingSourceIdentity.push("checkpoint");
  if (!sourceWorkspaceId) missingSourceIdentity.push("workspace");
  return {
    ...base,
    source_binding_complete: missingSourceIdentity.length === 0 && sourceSnapshot.complete !== false,
    source_binding_missing: missingSourceIdentity,
    classification_status: classificationStatus,
    productionization_safe: classificationStatus === "CLASSIFIED" && packageManagerConflicts.length === 0,
    unsupported_languages: unique(unsupportedLanguages),
    classification_message: classificationStatus === "UNKNOWN"
      ? "Repository classification incomplete; review repository evidence before applying stack-specific productionization."
      : classificationStatus === "INCOMPLETE"
        ? "Repository evidence exceeded a safe scan limit; do not treat this classification as authoritative."
        : null,
    languages,
    ...languageRoles,
    static_application: staticApplication,
    frameworks,
    framework_status: frameworks.length ? "IDENTIFIED" : staticApplication ? "NOT_APPLICABLE" : "UNKNOWN",
    framework_evidence: detectFrameworkEvidence(frameworks, sourceSnapshot.files, pkg),
    runtimes: detectRuntimes(sourceSnapshot.files, pkg),
    package_managers: packageManagers,
    package_manager_status: packageManagerConflicts.length ? "CONFLICT" : packageManagers.length ? "IDENTIFIED" : "UNKNOWN",
    package_manager_conflicts: packageManagerConflicts,
    build_systems: merged.build_systems || [],
    formatters: merged.formatters || [],
    linters: merged.linters || [],
    type_checkers: merged.type_checkers || [],
    test_runners: testRunners,
    test_commands: knownCommands.test_commands,
    configured_commands: knownCommands.configured_commands,
    test_locations: detectTestLocations(sourceSnapshot.files),
    databases: merged.databases || [],
    migration_tools: merged.migration_tools || [],
    migration_evidence: unique(migrationEvidence),
    migration_identifiers: unique(migrationIdentifiers),
    container_configuration: unique(sourceSnapshot.files.filter(file => /(^|\/)Dockerfile(?:\.[^/]*)?$|(^|\/)(?:compose|docker-compose)(?:\.[^/]*)?\.ya?ml$/i.test(file.path)).map(file => file.path)),
    infrastructure_configuration: detectInfrastructureConfiguration(sourceSnapshot.files),
    provider_evidence: providers,
    dependency_manifests: unique(sourceSnapshot.files.filter(file =>
      /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|requirements[^/]*\.txt|Pipfile(?:\.lock)?|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|Gemfile(?:\.lock)?|[^/]+\.(?:csproj|fsproj))$/i.test(file.path)
    ).map(file => file.path))
  };
}

function resolveStandardStatuses(classification) {
  const languages = new Set((classification?.languages || []).map(item => item.name));
  const unknown = ["UNKNOWN", "INCOMPLETE"].includes(classification?.classification_status);
  const standards = [];
  const ecosystems = [
    { name: "JavaScript/TypeScript", languages: ["JavaScript", "TypeScript"], recommended: { formatting: ["Prettier", "Biome"], linting: ["ESLint", "Biome"], type_checking: ["TypeScript"], tests: ["Node test", "Vitest"] } },
    { name: "Python", languages: ["Python"], recommended: { formatting: ["Ruff"], linting: ["Ruff"], type_checking: ["mypy", "Pyright"], tests: ["pytest"] } },
    { name: "Go", languages: ["Go"], recommended: { formatting: ["gofmt"], linting: ["golangci-lint"], type_checking: ["Go compiler"], tests: ["go test"] } },
    { name: "Rust", languages: ["Rust"], recommended: { formatting: ["rustfmt"], linting: ["Clippy"], type_checking: [], tests: ["cargo test"] } },
    { name: "Java", languages: ["Java", "Kotlin"], recommended: { formatting: ["google-java-format"], linting: ["Checkstyle"], type_checking: ["Java compiler"], tests: ["JUnit"] } },
    { name: "C#", languages: ["C#"], recommended: { formatting: ["dotnet format"], linting: ["Roslyn analyzers"], type_checking: ["C# compiler"], tests: ["xUnit"] } },
    { name: "PHP", languages: ["PHP"], recommended: { formatting: ["Laravel Pint"], linting: ["PHPStan"], type_checking: ["PHPStan"], tests: ["PHPUnit"] } },
    { name: "Ruby", languages: ["Ruby"], recommended: { formatting: ["RuboCop"], linting: ["RuboCop"], type_checking: [], tests: ["RSpec", "Minitest"] } },
    { name: "Shell", languages: ["Shell"], recommended: { formatting: ["shfmt"], linting: ["ShellCheck"], type_checking: [], tests: ["Bats"] } }
  ];
  const supported = ecosystems.filter(item => item.languages.some(language => languages.has(language)));
  const add = ({ id, name, ecosystem, recommended = [], configured = [], evidence = [], applicability = "RECOMMENDED", partial = false, notApplicable = false }) => {
    const status = unknown ? "UNKNOWN"
      : notApplicable ? "NOT_APPLICABLE"
        : configured.length ? (partial ? "PARTIAL" : "SATISFIED")
          : partial ? "PARTIAL" : "MISSING";
    standards.push({
      id, name, ecosystem, status, applicability, configured: configured.length > 0,
      configured_tools: configured, recommended_tools: recommended, evidence
    });
  };
  if (!supported.length) {
    add({
      id: "repository.classification", name: "Stack identification", ecosystem: "unknown",
      applicability: "UNKNOWN", recommended: ["Review repository evidence"],
      evidence: (classification?.evidence || []).map(item => item.path).slice(0, 20)
    });
  }
  for (const ecosystem of supported) {
    const configured = key => (classification?.[key] || [])
      .filter(item => item.ecosystem === ecosystem.name)
      .map(item => item.name);
    const locations = classification?.test_locations || [];
    const formatter = configured("formatters");
    const linter = configured("linters");
    const typeChecker = configured("type_checkers");
    const tests = configured("test_runners");
    const relevantEvidence = (classification?.evidence || []).map(item => item.path).filter(file =>
      ecosystem.languages.some(language => {
        const extensions = {
          JavaScript: [".js", ".mjs", ".cjs", ".jsx"], TypeScript: [".ts", ".tsx"],
          Python: [".py"], Go: [".go"], Rust: [".rs"], Java: [".java"],
          Kotlin: [".kt"], "C#": [".cs"], PHP: [".php"], Ruby: [".rb"], Shell: [".sh"]
        }[language] || [];
        return extensions.some(extension => file.toLowerCase().endsWith(extension));
      })
    ).slice(0, 20);
    add({ id: "formatting", name: "Formatting", ecosystem: ecosystem.name, recommended: ecosystem.recommended.formatting, configured: formatter, evidence: formatter.length ? formatter : relevantEvidence });
    add({ id: "linting", name: "Linting and static analysis", ecosystem: ecosystem.name, recommended: ecosystem.recommended.linting, configured: linter, evidence: linter.length ? linter : relevantEvidence });
    add({
      id: "type_checking", name: "Type checking", ecosystem: ecosystem.name,
      applicability: ecosystem.name === "JavaScript/TypeScript" && !languages.has("TypeScript")
        ? "OPTIONAL"
        : ecosystem.recommended.type_checking.length ? "RECOMMENDED" : "OPTIONAL",
      recommended: ecosystem.recommended.type_checking, configured: typeChecker,
      evidence: typeChecker.length ? typeChecker : relevantEvidence,
      notApplicable: !ecosystem.recommended.type_checking.length
    });
    add({
      id: "tests", name: "Automated tests", ecosystem: ecosystem.name,
      recommended: ecosystem.recommended.tests, configured: tests,
      evidence: tests.length ? tests.concat(locations.slice(0, 10)) : locations.slice(0, 10),
      partial: (tests.length > 0 && locations.length === 0) || (tests.length === 0 && locations.length > 0)
    });
  }
  const hasDatabase = (classification?.databases || []).length > 0;
  const migrations = classification?.migration_tools || [];
  add({
    id: "database.migrations", name: "Database migration safety", ecosystem: "database",
    applicability: hasDatabase ? "RECOMMENDED" : "NOT_APPLICABLE",
    recommended: hasDatabase ? ["Versioned, reviewed migrations"] : [],
    configured: migrations.map(item => item.name),
    evidence: classification?.migration_evidence || [],
    partial: hasDatabase && migrations.length === 0,
    notApplicable: !hasDatabase
  });
  const managers = classification?.package_managers || [];
  const packageConflict = classification?.package_manager_status === "CONFLICT";
  add({
    id: "dependencies.management", name: "Dependency management", ecosystem: "repository",
    recommended: ["One declared manager per ecosystem"],
    configured: packageConflict ? [] : managers.map(item => item.name),
    evidence: managers.map(item => item.evidence),
    partial: packageConflict || classification?.package_manager_status === "UNKNOWN"
  });
  const buildSystems = classification?.build_systems || [];
  add({
    id: "build.configuration", name: "Build configuration", ecosystem: "repository",
    applicability: supported.length ? "RECOMMENDED" : "UNKNOWN",
    recommended: supported.length ? ["Documented, reproducible build"] : [],
    configured: buildSystems.map(item => item.name),
    evidence: buildSystems.map(item => item.name),
    notApplicable: classification?.static_application === true && buildSystems.length === 0
  });
  return standards;
}

export function resolveEngineeringStandard(classification) {
  const checks = [];
  const standards = resolveStandardStatuses(classification);
  const add = (id, tool, reason, required = true) => checks.push({ id, tool, reason, classification: required ? "REQUIRED" : "OPTIONAL" });
  const languages = new Set((classification?.languages || []).map(item => item.name));
  if (languages.has("JavaScript") || languages.has("TypeScript")) {
    add("javascript.syntax", "node --check", "Node syntax validation is available for JavaScript source files.");
  }
  if (languages.has("Python")) add("python.syntax", "Python AST parse", "Python files can be parsed without installing project dependencies.");
  if (languages.has("Go")) add("go.format", "gofmt -d", "Go's native formatter is the repository formatting baseline.");
  if (languages.has("Rust")) add("rust.format", "cargo fmt --check", "Rust's native formatter is the repository formatting baseline.");
  for (const formatter of classification?.formatters || []) add(`format.${slug(formatter.name)}`, formatter.name, `Detected from repository evidence: ${formatter.ecosystem}.`);
  for (const linter of classification?.linters || []) add(`lint.${slug(linter.name)}`, linter.name, `Detected from repository evidence: ${linter.ecosystem}.`);
  for (const checker of classification?.type_checkers || []) add(`types.${slug(checker.name)}`, checker.name, `Detected from repository evidence: ${checker.ecosystem}.`);
  for (const runner of classification?.test_runners || []) add(`test.${slug(runner.name)}`, runner.name, `Detected from repository evidence: ${runner.ecosystem}.`);
  for (const builder of classification?.build_systems || []) add(`build.${slug(builder.name)}`, builder.name, `Detected from repository evidence: ${builder.ecosystem}.`);
  return {
    version: ENGINEERING_STANDARD_VERSION,
    ecosystems: unique([...(classification?.languages || []).map(item => item.name), ...(classification?.frameworks || [])]),
    classification_status: classification?.classification_status || "UNKNOWN",
    standards,
    summary: {
      satisfied: standards.filter(item => item.status === "SATISFIED").length,
      partial: standards.filter(item => item.status === "PARTIAL").length,
      missing: standards.filter(item => item.status === "MISSING").length,
      unknown: standards.filter(item => item.status === "UNKNOWN").length
    },
    checks: dedupeChecks(checks)
  };
}

function slug(value) {
  return String(value || "tool").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
}

function dedupeChecks(checks) {
  const seen = new Set();
  return checks.filter(item => {
    const key = `${item.id}\0${item.tool}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const CONTRACT_PATTERNS = Object.freeze([
  ["http_route", /(?:\/api\/[A-Za-z0-9_./:{}-]+)/g],
  ["http_route", /\.(?:get|post|put|patch|delete|all|use)\(\s*["'`]([^"'`]+)["'`]/gi],
  ["http_route", /@(?:app|router)\.(?:get|post|put|patch|delete)\(\s*["']([^"']+)["']/gi],
  ["database_identifier", /\b(?:feltus_[a-z0-9_]+|(?:public|auth|storage)\.[a-z][a-z0-9_]+)\b/gi],
  ["database_identifier", /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|REFERENCES|CREATE\s+OR\s+REPLACE\s+FUNCTION)\s+["'`]?([A-Za-z_][A-Za-z0-9_.]*)/gi],
  ["rpc_name", /\.(?:rpc|call)\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/gi],
  ["enum_identifier", /\b(?:CREATE\s+TYPE|enum)\s+["'`]?([A-Za-z_][A-Za-z0-9_.]*)/gi],
  ["provider_event", /\b(?:event\.type|event_name)\s*(?:===|==|=|:)\s*["'`]([A-Za-z][A-Za-z0-9_.:-]*)["'`]/gi],
  ["feltus_contract", /feltus\.application-state\/v1/g],
  ["serialized_key", /["'`](?:desired_state|observed_state|intelligence|state_hash|source_commit|source_snapshot_sha256|data_type|application|blueprint|execution|artifact_digest|commit_sha|environment_id)["'`]/g]
]);

const ENVIRONMENT_REFERENCE_PATTERNS = Object.freeze([
  /\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])/g,
  /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
  /\b(?:os\.getenv|os\.environ\.get)\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bos\.environ\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  /\bSystem\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bgetenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bENV\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  /\$_ENV\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  /\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)/g
]);

function extractContractMarkers(content = "", filePath = "") {
  const markers = [];
  for (const [kind, pattern] of CONTRACT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const value = (match[1] || match[0]).replace(/["']/g, "");
      markers.push({ kind, value });
    }
  }
  for (const pattern of ENVIRONMENT_REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const value = match.slice(1).find(Boolean);
      if (value) markers.push({ kind: "environment_variable", value });
    }
  }
  if (/(^|\/)(?:migrations?|database\/migrations|db\/migration)\//i.test(filePath)) {
    markers.push({ kind: "migration_identifier", value: path.posix.basename(filePath) });
  }
  if (/(^|\/)webhooks?(\/|\.|$)/i.test(filePath)) {
    markers.push({ kind: "webhook", value: path.posix.basename(filePath) });
  }
  return markers;
}

function fileRisk(file, content) {
  const value = file.toLowerCase();
  if (/(^|\/)(?:supabase\/)?migrations?\//.test(value) || /(^|\/)(?:schema|openapi|swagger|graphql|proto)(?:\/|\.|$)/.test(value) || /(^|\/)(?:generated|types?|sdk|webhooks?)(\/|\.|$)/.test(value)) {
    return { classification: "CONTRACT_PROTECTED", reason: "database, API schema, or generated contract path" };
  }
  if (/(^|\/)(?:\.env(?:\.[^/]*)?|.*\.pem|.*\.key|.*secret.*)$/i.test(value) || isSensitivePath(file)) {
    return { classification: "CONTRACT_PROTECTED", reason: "sensitive configuration path" };
  }
  if (/(^|\/)(?:package\.json|go\.mod|Cargo\.toml|pyproject\.toml|requirements[^/]*\.txt|Dockerfile(?:\.[^/]*)?|(?:compose|docker-compose).*\.ya?ml)$/i.test(value)) {
    return { classification: "MEDIUM_RISK_INTERNAL", reason: "dependency, build, or runtime manifest" };
  }
  const containsContractToken = extractContractMarkers(content, file).length > 0;
  if (/(^|\/)(?:routes?|api|controllers?|server|auth|security)(\/|\.|$)/i.test(value) || containsContractToken) {
    return { classification: "CONTRACT_PROTECTED", reason: "route, authorization, or serialized contract evidence" };
  }
  if (/(^|\/)(?:tests?|__tests__|spec)(\/|\.)/i.test(value)) {
    return { classification: "MEDIUM_RISK_INTERNAL", reason: "test behavior or shared test interface" };
  }
  return { classification: "LOW_RISK_INTERNAL", reason: "no contract marker detected" };
}

export async function buildContractProtectionMap(repoRoot, { snapshot = null } = {}) {
  const data = snapshot || await scanRepository(repoRoot);
  const protectedFiles = [];
  const lowRiskFiles = [];
  const mediumRiskFiles = [];
  const contracts = [];
  for (const file of data.files) {
    const risk = fileRisk(file.path, file.content);
    const row = { path: file.path, ...risk };
    if (risk.classification === "CONTRACT_PROTECTED") protectedFiles.push(row);
    else if (risk.classification === "MEDIUM_RISK_INTERNAL") mediumRiskFiles.push(row);
    else lowRiskFiles.push(row);
    for (const marker of extractContractMarkers(file.content, file.path)) contracts.push({ ...marker, path: file.path });
  }
  const uniqueContracts = [...new Map(contracts.map(item => [`${item.kind}\0${item.value}\0${item.path}`, item])).values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value) || a.path.localeCompare(b.path));
  return {
    version: CONTRACT_PROTECTION_VERSION,
    generated_at: new Date().toISOString(),
    source_snapshot_sha256: data.snapshot_sha256,
    source_snapshot_complete: data.complete !== false,
    low_risk_files: lowRiskFiles,
    medium_risk_files: mediumRiskFiles,
    protected_files: protectedFiles,
    contracts: uniqueContracts
  };
}

export function classifyChangeSetContracts(changeSet, contractMap, { beforeFiles = [], afterFiles = [] } = {}) {
  const riskByPath = new Map((contractMap?.protected_files || []).map(item => [item.path, item]));
  const mediumRiskByPath = new Map((contractMap?.medium_risk_files || []).map(item => [item.path, item]));
  const beforeByPath = new Map(beforeFiles.map(item => [item.path, item]));
  const afterByPath = new Map(afterFiles.map(item => [item.path, item]));
  const safe = [];
  const reviewRequired = [];
  const blocked = [];
  for (const operation of changeSet?.operations || []) {
    const relative = normalizeRelativePath(operation.type === "rename" ? operation.from : operation.path);
    const sourceRisk = riskByPath.get(relative) || mediumRiskByPath.get(relative) || fileRisk(relative, beforeByPath.get(relative)?.content || "");
    const targetPath = operation.type === "rename" ? normalizeRelativePath(operation.to) : relative;
    const targetRisk = riskByPath.get(targetPath) || mediumRiskByPath.get(targetPath) || fileRisk(targetPath, afterByPath.get(targetPath)?.content || "");
    const risk = sourceRisk.classification === "LOW_RISK_INTERNAL" ? targetRisk : sourceRisk;
    if (risk.classification === "LOW_RISK_INTERNAL") {
      safe.push({ ...operation, risk: risk.classification });
      continue;
    }
    const oldFile = beforeByPath.get(relative);
    const newFile = afterByPath.get(targetPath);
    const oldTokens = contractValues(oldFile?.content || "");
    const newTokens = contractValues(newFile?.content || "");
    const changed = symmetricDifference(oldTokens, newTokens);
    const finding = {
      operation_id: operation.id,
      path: relative,
      classification: risk.classification,
      reason: risk.reason,
      contract_changes: changed
    };
    if (risk.classification === "MEDIUM_RISK_INTERNAL") reviewRequired.push(finding);
    else blocked.push(finding);
  }
  return { safe_operations: safe, review_required_operations: reviewRequired, blocked_operations: blocked };
}

function contractValues(content) {
  const values = [];
  for (const [kind, pattern] of CONTRACT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) values.push(`${kind}:${match[0].replace(/["'`]/g, "")}`);
  }
  return new Set(values);
}

function symmetricDifference(left, right) {
  return unique([...left].filter(value => !right.has(value)).concat([...right].filter(value => !left.has(value))));
}

export function createProductionizationRun({ classification, engineeringStandard, contractMap, beforeCommit = null, runId = crypto.randomUUID() }) {
  return {
    run_id: runId,
    status: "CLASSIFIED",
    application_id: classification.application_id,
    source_workspace_id: classification.source_workspace_id,
    source_branch: classification.source_branch,
    source_checkpoint_id: classification.source_checkpoint_id,
    source_commit: beforeCommit || classification.source_commit,
    source_snapshot_sha256: classification.source_snapshot_sha256,
    source_snapshot_complete: classification.source_snapshot_complete,
    source_binding_complete: classification.source_binding_complete,
    classifier_version: classification.classifier_version,
    engineering_standard: engineeringStandard,
    contract_map_version: contractMap.version,
    started_at: new Date().toISOString(),
    checks: [],
    transformations: [],
    blocked_contract_changes: []
  };
}

const SCRIPT_CANDIDATES = Object.freeze({
  format: ["format:check", "format:check:ci", "prettier:check"],
  lint: ["lint", "lint:check"],
  typecheck: ["typecheck", "type-check", "check:types"],
  test: ["test:ci", "test", "test:unit", "test:core"],
  build: ["build", "compile"]
});

export function resolveRequiredReleaseChecks(classification, pkg = null) {
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const languages = new Set((classification?.languages || []).map(item => item.name));
  const checks = [];
  const jsPackageManager = (classification?.package_managers || []).find(item => ["npm", "pnpm", "yarn", "bun"].includes(item.name))?.name || null;
  const add = (key, tool, reason, command, args = [], required = true) => checks.push({
    id: key,
    tool,
    reason,
    required,
    available: Boolean(command),
    command: command || null,
    args
  });
  const scriptFor = key => SCRIPT_CANDIDATES[key].find(name => typeof scripts[name] === "string" && scripts[name].trim()) || null;

  if (classification?.productionization_safe === false ||
      ["UNKNOWN", "INCOMPLETE", "MIXED"].includes(classification?.classification_status) ||
      classification?.package_manager_status === "CONFLICT") {
    add(
      "source.classification",
      "Repository classification",
      classification?.classification_message || "Resolve unknown, incomplete, mixed, or conflicting repository evidence before applying stack-specific productionization.",
      null
    );
  }
  if (classification?.source_binding_complete === false) {
    add(
      "source.checkpoint",
      "Exact source checkpoint",
      "Classification must be tied to the authorized workspace, branch, commit, source checkpoint, and complete source snapshot.",
      null
    );
  }
  if (languages.has("JavaScript") || languages.has("TypeScript")) {
    const checkScript = typeof scripts.check === "string" && scripts.check.trim() ? "check" : null;
    add("source.check", "Node.js project check", checkScript ? "Runs the repository's declared check script." : "No project check script is configured.", checkScript && jsPackageManager ? jsPackageManager : null, checkScript && jsPackageManager ? ["run", checkScript] : [], Boolean(checkScript && jsPackageManager));
    if ((classification?.linters || []).length) {
      const lintScript = scriptFor("lint");
      add("source.lint", "Repository linter", lintScript ? "Runs the repository's declared lint script." : "A linter is detected but no lint script is configured.", lintScript && jsPackageManager ? jsPackageManager : null, lintScript && jsPackageManager ? ["run", lintScript] : [], Boolean(lintScript && jsPackageManager));
    }
    if ((classification?.formatters || []).length) {
      const formatScript = scriptFor("format");
      add("source.format", "Repository formatter", formatScript ? "Runs the repository's declared formatting check." : "A formatter is detected but no formatting check is configured.", formatScript && jsPackageManager ? jsPackageManager : null, formatScript && jsPackageManager ? ["run", formatScript] : [], Boolean(formatScript && jsPackageManager));
    }
    const typeScript = languages.has("TypeScript");
    const typeScriptScript = scriptFor("typecheck");
    if (typeScript) add("source.types", "TypeScript", typeScriptScript ? "Runs the repository's declared type-check script." : "No TypeScript check script is configured; type safety remains a review item.", typeScriptScript && jsPackageManager ? jsPackageManager : null, typeScriptScript && jsPackageManager ? ["run", typeScriptScript] : [], Boolean(typeScriptScript && jsPackageManager));
    const testScript = scriptFor("test");
    const hasNodeTestRunner = (classification?.test_runners || []).some(item => item.name === "Node test");
    const testCommand = testScript && jsPackageManager ? { command: jsPackageManager, args: ["run", testScript] }
      : hasNodeTestRunner ? { command: "node", args: ["--test"] } : null;
    add("source.tests", "Project test suite", testCommand ? "Runs the repository's detected test suite." : "No executable project test command was detected.", testCommand?.command || null, testCommand?.args || [], Boolean(testCommand));
    const buildScript = scriptFor("build");
    if (buildScript) add("source.build", "Project build", "Runs the repository's declared build script.", jsPackageManager, jsPackageManager ? ["run", buildScript] : [], Boolean(jsPackageManager));
  }
  if (languages.has("Python")) {
    const pyproject = Boolean(classification?.dependency_manifests?.some(file => file.toLowerCase().endsWith("pyproject.toml")));
    const testConfigured = new Set((classification?.test_runners || []).map(item => item.name.toLowerCase()));
    if (testConfigured.has("pytest")) add("source.tests", "pytest", "pytest is declared by repository evidence.", "python", ["-m", "pytest", "-q"]);
    else if (testConfigured.has("unittest")) add("source.tests", "unittest", "Runs the repository's standard-library test suite.", "python", ["-m", "unittest", "discover", "-s", "tests"]);
    else add("source.tests", "Python test suite", "No Python test runner was detected.", null, [], false);
    add("source.syntax", "Python AST parse", pyproject ? "Parses repository Python files without importing application code." : "Checks Python syntax without importing application code.", "python", ["-c", "import ast,pathlib; [ast.parse(p.read_text(encoding='utf-8'), filename=str(p)) for p in pathlib.Path('.').rglob('*.py') if not any(part in {'.git','node_modules','.venv','venv','__pycache__'} for part in p.parts)]"]);
  }
  if (languages.has("Go")) add("source.tests", "go test", "Go repositories are validated with the native Go test runner.", "go", ["test", "./..."]);
  if (languages.has("Rust")) {
    add("source.tests", "cargo test", "Rust repositories are validated with the native Cargo test runner.", "cargo", ["test", "--locked"]);
    add("source.format", "cargo fmt", "Rust formatting is checked with the native formatter.", "cargo", ["fmt", "--all", "--", "--check"]);
  }
  if (!checks.length) add("source.validation", "Repository validation", "No configured test or build evidence was detected.", null, [], false);
  const seen = new Set();
  return checks.map(check => {
    let id = check.id;
    if (seen.has(id)) id = `${id}.${slug(check.tool)}`;
    seen.add(id);
    return id === check.id ? check : { ...check, id };
  });
}

export function simulateChangeSetFiles(files, changeSet) {
  const result = new Map(files.map(file => [file.path, { ...file }]));
  for (const operation of changeSet?.operations || []) {
    if (operation.type === "create") {
      const pathName = normalizeRelativePath(operation.path);
      result.set(pathName, { path: pathName, content: operation.content, size: Buffer.byteLength(operation.content), sha256: sha256(operation.content) });
    } else if (operation.type === "update") {
      const current = result.get(normalizeRelativePath(operation.path));
      if (current) result.set(current.path, { ...current, content: operation.content, size: Buffer.byteLength(operation.content), sha256: sha256(operation.content) });
    } else if (operation.type === "delete") {
      result.delete(normalizeRelativePath(operation.path));
    } else if (operation.type === "rename") {
      const from = normalizeRelativePath(operation.from);
      const to = normalizeRelativePath(operation.to);
      const current = result.get(from);
      if (current) {
        result.delete(from);
        result.set(to, { ...current, path: to });
      }
    }
  }
  return [...result.values()];
}

export function normalizeLowRiskSource(files, contractMap, selectedPaths = []) {
  const selected = new Set(selectedPaths.map(normalizeRelativePath));
  const riskByPath = new Map((contractMap?.protected_files || []).map(item => [item.path, item]));
  const operations = [];
  for (const file of files) {
    if (!selected.has(file.path) || !file.path.toLowerCase().endsWith(".json") || isSensitivePath(file.path)) continue;
    const risk = riskByPath.get(file.path) || fileRisk(file.path, file.content);
    if (risk.classification !== "LOW_RISK_INTERNAL" || typeof file.content !== "string" || redactSecrets(file.content) !== file.content) continue;
    try {
      const normalized = `${JSON.stringify(JSON.parse(file.content), null, 2)}\n`;
      if (normalized === file.content) continue;
      operations.push({
        id: `normalize-${sha256(file.path).slice(0, 12)}`,
        type: "update",
        path: file.path,
        content: normalized,
        before_sha256: file.sha256 || sha256(file.content),
        reason: "Applied deterministic JSON formatting while preserving parsed values and key order.",
        agent: "code-agent"
      });
    } catch {
      // Invalid JSON is left untouched for a reviewed source proposal.
    }
  }
  return operations.length
    ? { id: crypto.randomUUID(), summary: "Normalized low-risk JSON formatting", operations }
    : null;
}

export function productionizationChangeSetFingerprint(changeSet) {
  const operations = (changeSet?.operations || []).map(operation => ({
    id: String(operation.id || ""),
    type: String(operation.type || ""),
    path: operation.path ? normalizeRelativePath(operation.path) : null,
    from: operation.from ? normalizeRelativePath(operation.from) : null,
    to: operation.to ? normalizeRelativePath(operation.to) : null,
    before_sha256: String(operation.before_sha256 || ""),
    after_sha256: operation.type === "delete" ? null : sha256(String(operation.content ?? ""))
  }));
  return sha256(JSON.stringify(operations));
}

export function validateDeterministicJsonChangeSet(changeSet, beforeFiles, contractMap) {
  if (changeSet?.productionization?.proposal_type !== "DETERMINISTIC") return null;
  const files = new Map(beforeFiles.map(file => [file.path, file]));
  const lowRisk = new Set((contractMap?.low_risk_files || []).map(item => item.path));
  const failures = [];
  const operations = changeSet.operations || [];
  if (!operations.length || operations.length > MAX_AUTOMATIC_CHANGES) failures.push("The deterministic plan has an invalid operation count.");
  for (const operation of operations) {
    const source = files.get(operation.path);
    if (operation.type !== "update" || !operation.path?.toLowerCase().endsWith(".json") || !lowRisk.has(operation.path)) {
      failures.push(`The deterministic plan contains a non-JSON or non-low-risk operation: ${operation.path || "unknown path"}.`);
      continue;
    }
    if (!source || source.sha256 !== operation.before_sha256) {
      failures.push(`The source hash does not match the deterministic plan for ${operation.path}.`);
      continue;
    }
    if (isSensitivePath(operation.path) || redactSecrets(source.content) !== source.content || redactSecrets(operation.content) !== operation.content) {
      failures.push(`The deterministic plan contains a sensitive or secret-bearing file: ${operation.path}.`);
      continue;
    }
    try {
      const beforeValue = JSON.parse(source.content);
      const afterValue = JSON.parse(operation.content);
      if (!isDeepStrictEqual(beforeValue, afterValue) || operation.content !== `${JSON.stringify(beforeValue, null, 2)}\n`) {
        failures.push(`The operation changes JSON values or does not use the deterministic formatter: ${operation.path}.`);
      }
    } catch {
      failures.push(`The source or proposed JSON is invalid: ${operation.path}.`);
    }
  }
  return {
    id: "productionization.json_semantics",
    tool: "Deterministic JSON value preservation",
    reason: "Checks that automatic formatting preserves parsed JSON values and only touches low-risk JSON files.",
    required: true,
    available: true,
    exit_code: failures.length ? 1 : 0,
    status: failures.length ? "FAILED" : "PASSED",
    output_summary: failures.join(" ") || `Verified ${operations.length} JSON formatting operation(s) without changing parsed values.`
  };
}

const MAX_AUTOMATIC_CHANGES = 24;
const MAX_AUTOMATIC_FILE_BYTES = 128 * 1024;
const MAX_AUTOMATIC_CHANGE_BYTES = 512 * 1024;

export function createProductionizationPlan({
  classification,
  engineeringStandard,
  contractMap,
  snapshot,
  baseline = null,
  sourceClean = false,
  runId = crypto.randomUUID()
}) {
  const blockers = [];
  if (!classification?.application_id) blockers.push("An application or project identity is required.");
  if (!classification?.source_workspace_id) blockers.push("An authorized workspace identity is required.");
  if (!classification?.source_branch) blockers.push("A source branch is required.");
  if (!classification?.source_commit || classification.source_commit !== classification.source_checkpoint_id) {
    blockers.push("The source commit and CODE checkpoint must match.");
  }
  if (!classification?.source_binding_complete || classification.source_snapshot_complete === false) {
    blockers.push("The Phase E classification must be complete and bound to the exact source snapshot.");
  }
  if (classification?.productionization_safe !== true || classification?.classification_status !== "CLASSIFIED") {
    blockers.push(classification?.classification_message || "Mixed, unknown, incomplete, or conflicting repositories require review before stack-specific changes.");
  }
  if (snapshot?.complete === false || contractMap?.source_snapshot_complete === false) {
    blockers.push("The source snapshot or contract map is incomplete.");
  }
  if (!snapshot?.snapshot_sha256 || snapshot.snapshot_sha256 !== classification?.source_snapshot_sha256 ||
      snapshot.snapshot_sha256 !== contractMap?.source_snapshot_sha256) {
    blockers.push("The classification, contract map, and source snapshot do not share the same hash.");
  }
  if (!sourceClean) blockers.push("Create a source checkpoint before preparing productionization changes.");

  const lowRiskPaths = new Set((contractMap?.low_risk_files || [])
    .filter(item => item.classification === "LOW_RISK_INTERNAL")
    .map(item => item.path));
  const candidates = (snapshot?.files || [])
    .filter(file => lowRiskPaths.has(file.path) && typeof file.content === "string" &&
      file.path.toLowerCase().endsWith(".json") && !isSensitivePath(file.path) && redactSecrets(file.content) === file.content &&
      Buffer.byteLength(file.content, "utf8") <= MAX_AUTOMATIC_FILE_BYTES)
    .sort((left, right) => left.path.localeCompare(right.path));
  const proposed = blockers.length ? null : normalizeLowRiskSource(candidates, contractMap, candidates.map(file => file.path));
  const selectedOperations = [];
  let proposedBytes = 0;
  for (const operation of proposed?.operations || []) {
    const bytes = Buffer.byteLength(operation.content, "utf8");
    if (selectedOperations.length >= MAX_AUTOMATIC_CHANGES || proposedBytes + bytes > MAX_AUTOMATIC_CHANGE_BYTES) continue;
    selectedOperations.push(operation);
    proposedBytes += bytes;
  }
  const changeSet = selectedOperations.length
    ? {
      id: crypto.randomUUID(),
      summary: "Apply deterministic formatting to low-risk JSON files",
      operations: selectedOperations
    }
    : null;
  const reviewRequired = (engineeringStandard?.standards || [])
    .filter(item => ["MISSING", "PARTIAL", "UNKNOWN"].includes(item.status))
    .map(standard => ({
      type: "engineering_standard",
      id: standard.id,
      name: standard.name,
      ecosystem: standard.ecosystem,
      status: standard.status,
      recommendation: standard.recommended_tools || [],
      reason: "Review repository policy and tool availability before adding or configuring tooling."
    }));
  const protectedFiles = (contractMap?.protected_files || []).map(item => ({ path: item.path, reason: item.reason }));
  const run = createProductionizationRun({
    classification,
    engineeringStandard,
    contractMap,
    beforeCommit: classification?.source_commit,
    runId
  });
  run.status = blockers.length ? "BLOCKED" : "READY_FOR_REVIEW";
  run.blocking_reasons = unique(blockers);
  run.behavioral_baseline = baseline;
  run.protected_files_skipped = protectedFiles.length;
  run.review_required_count = reviewRequired.length;
  run.transformations = selectedOperations.map(operation => ({
    id: operation.id,
    type: operation.type,
    path: operation.path,
    reason: operation.reason,
    before_sha256: operation.before_sha256,
    after_sha256: sha256(operation.content)
  }));
  const source = {
    application_id: classification?.application_id || null,
    workspace_id: classification?.source_workspace_id || null,
    branch: classification?.source_branch || null,
    commit: classification?.source_commit || null,
    checkpoint: classification?.source_checkpoint_id || null,
    snapshot_sha256: classification?.source_snapshot_sha256 || null,
    classifier_version: classification?.classifier_version || null
  };
  const changeSetSha256 = changeSet ? productionizationChangeSetFingerprint(changeSet) : null;
  const plan = {
    id: crypto.randomUUID(),
    run_id: run.run_id,
    status: run.status,
    source,
    engineering_standard_version: engineeringStandard?.version || null,
    contract_map_version: contractMap?.version || null,
    baseline,
    automatic_safe: selectedOperations,
    review_required: reviewRequired,
    protected_skipped: protectedFiles,
    unresolved: unique(blockers),
    change_set: changeSet,
    change_set_sha256: changeSetSha256,
    run
  };
  run.plan_id = plan.id;
  run.change_set_id = changeSet?.id || null;
  run.change_set_sha256 = changeSetSha256;
  run.after_source_snapshot_sha256 = changeSet
    ? repositorySnapshotHash(simulateChangeSetFiles(snapshot.files, changeSet))
    : snapshot?.snapshot_sha256 || null;
  run.source_checkpoint_clean = sourceClean;
  if (changeSet) {
    changeSet.productionization = {
      run_id: run.run_id,
      plan_id: plan.id,
      source_application_id: source.application_id,
      source_workspace_id: source.workspace_id,
      source_branch: source.branch,
      source_checkpoint: source.checkpoint,
      source_snapshot_sha256: source.snapshot_sha256,
      classifier_version: source.classifier_version,
      change_set_sha256: changeSetSha256,
      proposal_type: "DETERMINISTIC"
    };
  }
  return plan;
}

export function evaluateReleaseReadiness(checks) {
  const normalized = checks.map(check => ({
    ...check,
    status: !check.available || check.status === "UNAVAILABLE"
      ? "UNAVAILABLE"
      : check.exit_code === 0 ? "PASSED" : check.exit_code == null ? "NOT_RUN" : "FAILED",
    blocking: Boolean(check.required && (!check.available || check.status === "UNAVAILABLE" || check.exit_code !== 0))
  }));
  return {
    status: normalized.some(check => check.blocking) ? "BLOCKED" : "READY_FOR_RELEASE",
    ready_for_release: normalized.every(check => !check.blocking),
    checks: normalized
  };
}
