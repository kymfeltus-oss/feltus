import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--test-only")) {
  process.stderr.write(
    "This browser fixture is test-only. Start it with npm run test:certification:browser-fixture.\n"
  );
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appId = "99999999-9999-4999-8999-999999999999";
const ownerId = "88888888-8888-4888-8888-888888888888";
const app = {
  id: appId,
  owner_id: ownerId,
  app_name: "Synthetic Repository Fixture",
  app_type: "web_application",
  environment: "development",
  lifecycle_status: "active",
  setup_status: "active",
  setup_current_step: "basics",
  setup_completed_steps: [],
  setup_data: { product_path: "existing_application" },
  created_at: "2026-01-01T00:00:00.000Z"
};
const fixtureRepository = {
  provider_repository_id: "synthetic-repository-1",
  name: "fixture/customer-portal",
  default_branch: "main",
  branches: [{
    branch_name: "main",
    is_default: true,
    latest_commit_sha: "a".repeat(40)
  }],
  webhook_status: "inactive"
};
const allowedModes = new Set(["empty", "github-unavailable", "github-configured", "github-connected"]);
let selectedRepository = false;
let createdApp = false;

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

function modeFromRequest(req) {
  const cookie = String(req.headers.cookie || "").split(";")
    .map(value => value.trim())
    .find(value => value.startsWith("feltus_certification="));
  const mode = cookie?.slice("feltus_certification=".length);
  return allowedModes.has(mode) ? mode : "empty";
}

function fixtureAppList() {
  return createdApp ? [app] : [];
}

function githubStatus(mode) {
  if (mode === "github-unavailable") {
    return {
      configured: false,
      connected: false,
      configuration_reason: "GitHub connection is unavailable in this isolated test fixture.",
      repositories: []
    };
  }
  if (mode === "github-connected") {
    return {
      configured: true,
      connected: true,
      repositories: selectedRepository ? [fixtureRepository] : [],
      webhook_setup_available: false
    };
  }
  return {
    configured: true,
    connected: false,
    repositories: []
  };
}

function indexHtml() {
  return readFileSync(path.join(root, "index.html"));
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const mode = modeFromRequest(req);

  if (req.method === "GET" && ["/", "/index.html"].includes(url.pathname)) {
    const requestedMode = url.searchParams.get("certification") || "empty";
    if (!allowedModes.has(requestedMode)) {
      res.writeHead(400);
      return res.end("Unknown certification fixture.");
    }
    if (url.searchParams.has("certification")) {
      selectedRepository = false;
      createdApp = false;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `feltus_certification=${requestedMode}; Path=/; SameSite=Lax`
    });
    return res.end(indexHtml());
  }

  const assets = {
    "/app-wizard.js": ["src/app-wizard/app.js", "text/javascript; charset=utf-8"],
    "/app-wizard.css": ["src/app-wizard/app.css", "text/css; charset=utf-8"],
    "/app-wizard-lib.js": ["src/lib/feltus-app-wizard-shared.js", "text/javascript; charset=utf-8"],
    "/app-wizard-capabilities.js": ["src/app-wizard/capabilities.js", "text/javascript; charset=utf-8"]
  };
  const brandAssets = {
    "/brand/feltus-logo-horizontal.png": "feltus-logo-horizontal.png",
    "/brand/feltus-logo-stacked.png": "feltus-logo-stacked.png"
  };
  if (req.method === "GET" && brandAssets[url.pathname]) {
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return res.end(readFileSync(path.join(root, "src/assets/brand/logo", brandAssets[url.pathname])));
  }
  if (req.method === "GET" && assets[url.pathname]) {
    const [relativePath, contentType] = assets[url.pathname];
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    return res.end(readFileSync(path.join(root, relativePath)));
  }

  if (req.method === "GET" && url.pathname === "/api/auth/session") {
    return json(res, 200, { authenticated: true, mode: "local-development", features: { teams: false } });
  }
  if (req.method === "GET" && url.pathname === "/api/github/status") {
    return json(res, 200, { configured: mode !== "github-unavailable" });
  }
  if (req.method === "GET" && url.pathname === "/api/apps") return json(res, 200, fixtureAppList());
  if (req.method === "GET" && url.pathname === "/api/apps/deletions") return json(res, 200, []);
  if (req.method === "GET" && url.pathname.startsWith("/api/activity")) return json(res, 200, []);
  if (req.method === "GET" && url.pathname === "/api/system-health") {
    return json(res, 200, { services: { runtime: { status: "unknown" }, database: { status: "unknown" }, ai: { status: "unknown" } } });
  }

  if (req.method === "GET" && url.pathname === `/api/apps/${appId}`) return json(res, 200, { app });
  if (req.method === "GET" && url.pathname === `/api/apps/${appId}/github`) return json(res, 200, githubStatus(mode));
  if (req.method === "GET" && url.pathname === `/api/apps/${appId}/github/repositories`) {
    return json(res, 200, mode === "github-connected" ? [fixtureRepository] : []);
  }
  if (req.method === "POST" && url.pathname === `/api/apps/${appId}/github/repository`) {
    if (mode !== "github-connected") return json(res, 409, { error: "The test GitHub connection is unavailable." });
    selectedRepository = true;
    return json(res, 200, { connected: true, repository: fixtureRepository });
  }
  if (req.method === "GET" && url.pathname === `/api/code/workspace`) {
    return json(res, 200, { initialized: true, clean: true, branch: "main" });
  }
  if (req.method === "GET" && url.pathname === `/api/code/capabilities`) {
    return json(res, 200, { capabilities: {} });
  }
  if (req.method === "GET" && url.pathname === `/api/code/git/status`) {
    return json(res, 200, { stdout: "## main\n", code: 0 });
  }
  if (req.method === "GET" && url.pathname === `/api/apps/${appId}/events`) return json(res, 200, { events: [] });
  if (req.method === "POST" && url.pathname === "/api/apps") {
    createdApp = true;
    return json(res, 201, { app });
  }

  if (req.method === "GET" && url.pathname === `/api/apps/${appId}/github/connect`) {
    res.writeHead(302, { Location: "/__fixture/github-authorization", "Cache-Control": "no-store" });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/__fixture/github-authorization") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end("<!doctype html><meta charset=utf-8><title>Mock GitHub authorization</title><h1>Isolated authorization-flow fixture</h1><p>No credentials or remote repositories are used.</p>");
  }

  if (req.method === "GET" && (
    ["/apps", "/apps/new", "/apps/new/basics", "/apps/import", "/services", "/services/use", "/domains", "/activity", "/usage", "/settings"].includes(url.pathname) ||
    /^\/apps\/[0-9a-f-]{36}(?:\/.*)?$/i.test(url.pathname)
  )) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `feltus_certification=${mode}; Path=/; SameSite=Lax`
    });
    return res.end(indexHtml());
  }

  return json(res, 404, { error: "No certification fixture route is configured for this request." });
});

server.listen(Number(process.env.FELTUS_CERTIFICATION_PORT || 0), "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`Certification browser fixture: http://127.0.0.1:${address.port}/?certification=empty\n`);
  process.stdout.write("Modes: empty, github-unavailable, github-configured, github-connected\n");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
