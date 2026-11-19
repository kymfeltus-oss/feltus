import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createDockerPreviewLauncher } from "../src/feltus-code/server/docker-preview-runner.mjs";
import { createPreviewManager } from "../src/feltus-code/server/preview-manager.mjs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const fixtureRoot = path.join(repoRoot, `.feltus-preview-docker-integration-${process.pid}`);
const workspaceRoot = path.join(fixtureRoot, "workspaces");
const appId = "11111111-1111-4111-8111-111111111111";
const siblingAppId = "22222222-2222-4222-8222-222222222222";
const projectRoot = path.join(workspaceRoot, appId);
const siblingProjectRoot = path.join(workspaceRoot, siblingAppId);
const scratchRoot = path.join(workspaceRoot, ".preview-sandboxes");
let launchDetails = null;
let preview = null;

try {
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(siblingProjectRoot, { recursive: true });
  await fs.writeFile(path.join(siblingProjectRoot, "private.txt"), "other app workspace marker");
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ scripts: { dev: "node server.mjs" } }));
  await fs.writeFile(path.join(projectRoot, "index.html"), "<!doctype html><html><body><h1>Isolated Preview Works</h1></body></html>");
  await fs.writeFile(path.join(projectRoot, "server.mjs"), `import http from "node:http";
import fs from "node:fs";
const port = Number(process.env.PORT);
http.createServer(async (request, response) => {
  if (request.url === "/runtime-failure") {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("controlled runtime failure");
    return;
  }
  if (request.url === "/security-check") {
    let network = "egress-blocked";
    try {
      await fetch("https://example.com", { signal: AbortSignal.timeout(3000) });
      network = "egress-open";
    } catch {}
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      network,
      dockerSocket: fs.existsSync("/var/run/docker.sock"),
      siblingWorkspace: fs.existsSync("/workspace/../22222222-2222-4222-8222-222222222222"),
      sensitiveEnvironment: Object.keys(process.env).filter(key => /SERVICE_ROLE|SECRET|OPENAI|GITHUB|COOLIFY|GHCR|DATABASE_URL/i.test(key))
    }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><html><head></head><body><h1>Isolated Preview Works</h1></body></html>");
}).listen(port, "0.0.0.0");
`);

  const dockerLauncher = createDockerPreviewLauncher({ workspaceRoot, scratchRoot, appId });
  preview = createPreviewManager({
    repoRoot: projectRoot,
    launchIsolatedPreview: async options => {
      launchDetails = await dockerLauncher(options);
      return launchDetails;
    },
    idleTimeoutMs: 0,
    readyTimeoutMs: 45000
  });

  const started = await preview.start();
  assert.equal(started.status, "running");
  assert.equal(started.available, true);
  assert.ok(started.url.startsWith("http://127.0.0.1:"));

  const page = await preview.proxy(appId, "/");
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /Isolated Preview Works/);
  assert.match(page.body.toString(), /feltus-preview-ready/);

  const failedResponse = await preview.proxy(appId, "/runtime-failure");
  assert.equal(failedResponse.status, 500);
  assert.match(failedResponse.body.toString(), /controlled runtime failure/);

  const securityResponse = await preview.proxy(appId, "/security-check");
  const isolation = JSON.parse(securityResponse.body.toString());
  assert.equal(isolation.network, "egress-blocked", "the app container must not reach the public network");
  assert.equal(isolation.dockerSocket, false, "the app container must not see a Docker socket");
  assert.equal(isolation.siblingWorkspace, false, "the app container must not see another workspace");
  assert.deepEqual(isolation.sensitiveEnvironment, [], "server secrets must not enter the app container");

  await preview.stop();
  assert.equal(preview.status().status, "stopped");
  assert.ok(launchDetails?.containerName);
  assert.ok(launchDetails?.networkName);
  assert.equal(await fs.stat(launchDetails.snapshot).then(() => true, () => false), false, "stopped preview must remove its private snapshot");
  console.log("PASS real Docker Preview renders the selected app, blocks egress and secret/socket access, reports runtime failure, and cleans up");
} finally {
  if (preview) await preview.dispose().catch(() => {});
  const resolvedFixture = path.resolve(fixtureRoot);
  if (path.dirname(resolvedFixture) !== repoRoot || !path.basename(resolvedFixture).startsWith(".feltus-preview-docker-integration-")) {
    throw new Error("Refusing to remove an unexpected Preview integration fixture path.");
  }
  await fs.rm(resolvedFixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
