import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { assertNoSymlinkTraversal, isSensitivePath, normalizeRelativePath, redactSecrets } from "./security.mjs";

const DEFAULT_IMAGE = "node:22-alpine";
const IMAGE_PATTERN = /^node:22(?:\.[0-9]+)?-alpine[\w.-]*(?:@sha256:[a-f0-9]{64})?$/i;
const APP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCKER_COMMAND_TIMEOUT_MS = 15000;
const IMAGE_PULL_TIMEOUT_MS = 180000;
const MAX_SNAPSHOT_FILES = 15000;
const MAX_SNAPSHOT_BYTES = 250 * 1024 * 1024;

const PREVIEW_PROXY_SCRIPT = `
const http = require("node:http");
const host = process.env.FELTUS_UPSTREAM_HOST;
const upstreamPort = Number(process.env.FELTUS_UPSTREAM_PORT);
const port = Number(process.env.PORT);
const allowedRequestHeaders = new Set(["accept", "accept-language", "content-type", "content-length", "range", "if-none-match", "if-modified-since"]);
const allowedResponseHeaders = new Set(["content-type", "content-length", "content-encoding", "cache-control", "etag", "last-modified", "location", "accept-ranges"]);

const server = http.createServer((incoming, outgoing) => {
  const method = String(incoming.method || "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    incoming.resume();
    outgoing.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end("Preview accepts read-only requests.");
    return;
  }

  let target;
  try {
    target = new URL(incoming.url || "/", "http://preview.local");
  } catch {
    outgoing.writeHead(400);
    outgoing.end();
    return;
  }

  const headers = {};
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (allowedRequestHeaders.has(key.toLowerCase()) && typeof value === "string") {
      headers[key] = value;
    }
  }

  const request = http.request({
    hostname: host,
    port: upstreamPort,
    path: target.pathname + target.search,
    method,
    headers
  }, response => {
    const responseHeaders = {};

    for (const [key, value] of Object.entries(response.headers)) {
      if (allowedResponseHeaders.has(key.toLowerCase()) && value !== undefined) {
        responseHeaders[key] = value;
      }
    }

    outgoing.writeHead(response.statusCode || 502, responseHeaders);
    response.pipe(outgoing);
  });

  request.once("error", () => {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    outgoing.end("Preview is starting or has stopped.");
  });

  request.end();
});

server.on("upgrade", (_request, socket) => {
  socket.end("HTTP/1.1 501 Not Implemented\\r\\nConnection: close\\r\\n\\r\\n");
});

server.listen(port, "0.0.0.0");
`;

const STATIC_PREVIEW_SCRIPT = `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const workspace = "/workspace";
const configuredRoot = process.env.FELTUS_STATIC_ROOT || ".";
const root = path.resolve(workspace, configuredRoot);
const port = Number(process.env.PORT);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function inside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
     relative !== ".." &&
     !path.isAbsolute(relative));
}

http.createServer((req, res) => {
  const method = String(req.method || "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    req.resume();
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Preview accepts read-only requests.");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(req.url || "/", "http://preview.local").pathname
    );
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  if (pathname === "/") pathname = "/index.html";

  let target = path.resolve(root, "." + pathname);

  if (!inside(root, target)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {}

  if (stat?.isDirectory()) {
    target = path.join(target, "index.html");
    try { stat = fs.statSync(target); } catch { stat = null; }
  }

  if (!stat?.isFile()) {
    const fallback = path.join(root, "index.html");
    try {
      const fallbackStat = fs.statSync(fallback);
      if (fallbackStat.isFile()) {
        target = fallback;
        stat = fallbackStat;
      }
    } catch {}
  }

  if (!stat?.isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  res.writeHead(200, {
    "content-type": mime[path.extname(target).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });

  if (method === "HEAD") {
    res.end();
    return;
  }

  fs.createReadStream(target).pipe(res);
}).listen(port, "0.0.0.0");
`;

function runnerError(message, code = "PREVIEW_RUNNER_UNAVAILABLE", status = 503) {
  return Object.assign(new Error(message), { code, status });
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function trimOutput(value) {
  return redactSecrets(String(value || "")).slice(-4000);
}

function runDocker(command, args, { spawnImpl, timeoutMs = DOCKER_COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    try {
      child = spawnImpl(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish(runnerError(`Docker could not start: ${redactSecrets(error.message)}`));
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(runnerError("Docker did not respond before the runner limit."));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", chunk => { stdout = `${stdout}${chunk}`.slice(-12000); });
    child.stderr?.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-12000); });
    child.once("error", error => finish(runnerError(`Docker could not start: ${redactSecrets(error.message)}`)));
    child.once("close", code => finish(null, { code, stdout: trimOutput(stdout), stderr: trimOutput(stderr) }));
  });
}

function assertAllowedCommand(request) {
  const { command, args = [], port } = request;
  const scriptName = request.scriptName || request.script;
  const expectedPort = String(port);
  if (command === "feltus-static" && scriptName === "static") {
    const staticRoot = request.staticRoot === "src" ? "src" : request.staticRoot === "." ? "." : null;
    if (!staticRoot) {
      throw runnerError("Static Preview root is invalid.", "PREVIEW_COMMAND_UNSAFE", 409);
    }
    return {
      command: "node",
      args: ["-e", STATIC_PREVIEW_SCRIPT],
      staticRoot
    };
  }

  const npmScripts = new Map([
    ["dev", ["--host", "0.0.0.0", "--port", expectedPort, "--strictPort"]],
    ["preview", ["--host", "0.0.0.0", "--port", expectedPort, "--strictPort"]],
    ["start", ["--hostname", "0.0.0.0", "--port", expectedPort]],
  ]);
  if (command === "npm" && npmScripts.has(scriptName)) {
    const expected = ["run", scriptName, "--ignore-scripts", "--", ...npmScripts.get(scriptName)];
    if (JSON.stringify(args) === JSON.stringify(expected)) return { command, args: expected };
  }
  if (command === "node" && scriptName === "dev" && args.length === 1) {
    let entry;
    try {
      entry = normalizeRelativePath(args[0]);
    } catch {
      throw runnerError("Preview entry must stay inside this project.", "PREVIEW_COMMAND_UNSAFE", 409);
    }
    if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:js|mjs|cjs)$/i.test(entry)) {
      throw runnerError("Preview supports only a project JavaScript entry file.", "PREVIEW_COMMAND_UNSUPPORTED", 409);
    }
    return { command, args: [entry] };
  }
  throw runnerError("This project's preview command is not on the safe list.", "PREVIEW_COMMAND_UNSUPPORTED", 409);
}

async function assertSnapshotScript(snapshot, request, runSpec) {
  if (runSpec.staticRoot) {
    const indexPath =
      runSpec.staticRoot === "."
        ? "index.html"
        : `${runSpec.staticRoot}/index.html`;

    await assertNoSymlinkTraversal(snapshot, indexPath);
    const indexStat = await fs.stat(path.join(snapshot, indexPath)).catch(() => null);

    if (!indexStat?.isFile()) {
      throw runnerError(
        "Static Preview index.html is missing from the safe project copy.",
        "PREVIEW_ENTRY_UNAVAILABLE",
        409
      );
    }

    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(snapshot, "package.json"), "utf8"));
  } catch {
    throw runnerError("Preview needs a valid package.json in this project.", "PREVIEW_PACKAGE_UNAVAILABLE", 409);
  }
  const scriptName = request.scriptName || request.script;
  const scriptValue = String(manifest?.scripts?.[scriptName] || "").trim().replace(/\s+/g, " ");
  const port = String(request.port);
  const expectedNpmArgs = value => ["run", scriptName, "--ignore-scripts", "--", ...value];
  let valid = false;
  if (runSpec.command === "node") {
    valid = scriptValue === `node ${runSpec.args[0]}`;
  } else if (scriptName === "dev" && scriptValue === "vite") {
    valid = JSON.stringify(runSpec.args) === JSON.stringify(expectedNpmArgs(["--host", "0.0.0.0", "--port", port, "--strictPort"]));
  } else if (scriptName === "preview" && scriptValue === "vite preview") {
    valid = JSON.stringify(runSpec.args) === JSON.stringify(expectedNpmArgs(["--host", "0.0.0.0", "--port", port, "--strictPort"]));
  } else if (scriptName === "dev" && scriptValue === "next dev") {
    valid = JSON.stringify(runSpec.args) === JSON.stringify(expectedNpmArgs(["--hostname", "0.0.0.0", "--port", port]));
  } else if (scriptName === "start" && scriptValue === "next start") {
    valid = JSON.stringify(runSpec.args) === JSON.stringify(expectedNpmArgs(["--hostname", "0.0.0.0", "--port", port]));
  }
  if (!valid) throw runnerError("This project's preview command is not on the safe list.", "PREVIEW_COMMAND_UNSUPPORTED", 409);
  if (runSpec.command === "node") {
    const entryStat = await fs.stat(path.join(snapshot, runSpec.args[0])).catch(() => null);
    if (!entryStat?.isFile()) throw runnerError("Preview entry file is missing from the safe project copy.", "PREVIEW_ENTRY_UNAVAILABLE", 409);
  }
}

async function validateWorkspace({ workspaceRoot, appId, repoRoot }) {
  if (!APP_ID_PATTERN.test(String(appId || ""))) {
    throw runnerError("Preview requires a valid project ID.", "INVALID_PROJECT_ID", 400);
  }
  const base = path.resolve(workspaceRoot || "");
  const expected = path.resolve(base, appId);
  if (!workspaceRoot || comparable(repoRoot) !== comparable(expected)) {
    throw runnerError("Preview workspace is outside this project.", "PREVIEW_WORKSPACE_UNSAFE", 409);
  }
  await assertNoSymlinkTraversal(base, appId);
  const realRoot = await fs.realpath(repoRoot).catch(() => {
    throw runnerError("This project's workspace is missing.", "PREVIEW_WORKSPACE_UNAVAILABLE", 409);
  });
  if (comparable(realRoot) !== comparable(expected)) {
    throw runnerError("Preview workspace cannot use a linked folder.", "PREVIEW_WORKSPACE_UNSAFE", 409);
  }
  const stat = await fs.stat(realRoot);
  if (!stat.isDirectory()) throw runnerError("This project's workspace is unavailable.", "PREVIEW_WORKSPACE_UNAVAILABLE", 409);
  return realRoot;
}

async function createWorkspaceSnapshot({ repoRoot, workspaceRoot, scratchRoot, token }) {
  const safeScratchRoot = path.resolve(scratchRoot || "");
  if (!scratchRoot || !isInside(workspaceRoot, safeScratchRoot) || safeScratchRoot === path.resolve(workspaceRoot)) {
    throw runnerError("Preview scratch folder is invalid.", "PREVIEW_WORKSPACE_UNSAFE", 409);
  }
  await fs.mkdir(safeScratchRoot, { recursive: true, mode: 0o700 });
  const realScratchRoot = await fs.realpath(safeScratchRoot);
  if (comparable(realScratchRoot) !== comparable(safeScratchRoot)) {
    throw runnerError("Preview scratch folder cannot use a linked directory.", "PREVIEW_WORKSPACE_UNSAFE", 409);
  }
  const snapshot = path.join(realScratchRoot, `preview-${token}`);
  if (path.dirname(snapshot) !== realScratchRoot) throw runnerError("Preview snapshot path is invalid.", "PREVIEW_WORKSPACE_UNSAFE", 409);
  await fs.mkdir(snapshot, { mode: 0o700 });
  let fileCount = 0;
  let byteCount = 0;

  async function copyDirectory(sourceDir, targetDir, relativeDir = "") {
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (isSensitivePath(relative)) continue;
      const source = path.join(sourceDir, entry.name);
      const target = path.join(targetDir, entry.name);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) {
        const linkTarget = await fs.readlink(source);
        if (path.isAbsolute(linkTarget) || /^[a-z]:[\\/]/i.test(linkTarget)) {
          throw runnerError("Preview cannot include a link that points outside the project.", "PREVIEW_SYMLINK_UNSAFE", 409);
        }
        const realLinkTarget = await fs.realpath(source).catch(() => null);
        if (!realLinkTarget || !isInside(repoRoot, realLinkTarget)) {
          throw runnerError("Preview cannot include a link that points outside the project.", "PREVIEW_SYMLINK_UNSAFE", 409);
        }
        const linkType = process.platform === "win32" ? ((await fs.stat(source)).isDirectory() ? "junction" : "file") : undefined;
        await fs.symlink(linkTarget, target, linkType);
        continue;
      }
      if (stat.isDirectory()) {
        await fs.mkdir(target, { mode: 0o700 });
        await copyDirectory(source, target, relative);
        continue;
      }
      if (!stat.isFile()) throw runnerError("Preview found an unsupported file type in this project.", "PREVIEW_FILE_UNSUPPORTED", 409);
      fileCount += 1;
      byteCount += stat.size;
      if (fileCount > MAX_SNAPSHOT_FILES || byteCount > MAX_SNAPSHOT_BYTES) {
        throw runnerError("This project is too large to copy into a safe preview.", "PREVIEW_WORKSPACE_TOO_LARGE", 413);
      }
      await fs.copyFile(source, target);
    }
  }

  try {
    await copyDirectory(repoRoot, snapshot);
    return snapshot;
  } catch (error) {
    await fs.rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

async function removeWorkspaceSnapshot(snapshot, scratchRoot) {
  if (!snapshot || path.dirname(path.resolve(snapshot)) !== path.resolve(scratchRoot) || !path.basename(snapshot).startsWith("preview-")) return;
  await fs.rm(snapshot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
}

function cleanupNetwork(networkName, { dockerCommand, spawnImpl }) {
  const attempt = async remaining => {
    const result = await runDocker(dockerCommand, ["network", "rm", networkName], { spawnImpl, timeoutMs: DOCKER_COMMAND_TIMEOUT_MS }).catch(() => null);
    if (result?.code === 0 || remaining <= 0) return;
    await new Promise(resolve => setTimeout(resolve, 200));
    return attempt(remaining - 1);
  };
  return attempt(4);
}

class PreviewMonitor extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.closeResult = null;
    this.savedError = null;
  }

  once(event, listener) {
    if (event === "close" && this.closeResult) {
      queueMicrotask(() => listener(...this.closeResult));
      return this;
    }
    if (event === "error" && this.savedError) {
      queueMicrotask(() => listener(this.savedError));
      return this;
    }
    return super.once(event, listener);
  }

  reportError(error) {
    this.savedError = error;
    if (this.listenerCount("error")) super.emit("error", error);
  }

  reportClose(code, signal = null) {
    if (this.closeResult) return;
    this.closeResult = [code, signal];
    this.stdout.end();
    this.stderr.end();
    super.emit("close", code, signal);
  }
}

async function cleanupPreviewResources({ appName, proxyName, networkName, proxyNetworkName, snapshot, scratchRoot, dockerCommand, spawnImpl }) {
  await Promise.all([
    runDocker(dockerCommand, ["rm", "--force", appName], { spawnImpl }).catch(() => null),
    runDocker(dockerCommand, ["rm", "--force", proxyName], { spawnImpl }).catch(() => null)
  ]);
  await Promise.all([
    cleanupNetwork(networkName, { dockerCommand, spawnImpl }),
    cleanupNetwork(proxyNetworkName, { dockerCommand, spawnImpl })
  ]);
  await removeWorkspaceSnapshot(snapshot, scratchRoot);
}

function createPreviewMonitor({ appName, proxyName, networkName, proxyNetworkName, snapshot, scratchRoot, dockerCommand, spawnImpl }) {
  const monitor = new PreviewMonitor();
  const logs = spawnImpl(dockerCommand, ["logs", "--follow", "--tail", "200", appName], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const waitProcess = spawnImpl(dockerCommand, ["wait", appName], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let exitOutput = "";
  let waitError = "";
  let cleanupPromise = null;
  const cleanup = () => {
    if (!cleanupPromise) {
      cleanupPromise = cleanupPreviewResources({ appName, proxyName, networkName, proxyNetworkName, snapshot, scratchRoot, dockerCommand, spawnImpl });
    }
    return cleanupPromise;
  };
  logs.stdout?.on("data", chunk => monitor.stdout.write(chunk));
  logs.stderr?.on("data", chunk => monitor.stderr.write(chunk));
  logs.once("error", error => {
    monitor.reportError(runnerError(`Preview output could not be read: ${redactSecrets(error.message)}`));
    void cleanup().finally(() => monitor.reportClose(1));
  });
  waitProcess.stdout?.on("data", chunk => { exitOutput = `${exitOutput}${chunk}`.slice(-100); });
  waitProcess.stderr?.on("data", chunk => { waitError = `${waitError}${chunk}`.slice(-4000); });
  waitProcess.once("error", error => {
    monitor.reportError(runnerError(`Preview runtime status could not be read: ${redactSecrets(error.message)}`));
    void cleanup().finally(() => monitor.reportClose(1));
  });
  waitProcess.once("close", code => {
    const parsedExitCode = Number(exitOutput.trim());
    const exitCode = code === 0 && Number.isInteger(parsedExitCode) ? parsedExitCode : 1;
    if (code !== 0 && waitError.trim()) monitor.stderr.write(trimOutput(waitError));
    void cleanup().finally(() => {
      logs.kill?.("SIGTERM");
      monitor.reportClose(exitCode);
    });
  });
  monitor.kill = signal => {
    const force = signal === "SIGKILL";
    const stop = force
      ? runDocker(dockerCommand, ["rm", "--force", appName], { spawnImpl, timeoutMs: 5000 })
      : runDocker(dockerCommand, ["stop", "--time", "2", appName], { spawnImpl, timeoutMs: 5000 });
    void stop.then(result => {
      if (result.code !== 0 || force) return runDocker(dockerCommand, ["rm", "--force", appName], { spawnImpl, timeoutMs: 5000 });
      return null;
    }).catch(() => null).finally(() => {
      if (force) void cleanup();
    });
    return true;
  };
  return monitor;
}

export function createDockerPreviewLauncher({
  workspaceRoot,
  scratchRoot = workspaceRoot ? path.join(path.resolve(workspaceRoot), ".preview-sandboxes") : null,
  appId,
  dockerCommand = "docker",
  image = DEFAULT_IMAGE,
  spawnImpl = spawn
} = {}) {
  if (!workspaceRoot || !appId) throw new TypeError("Docker preview runner requires a workspace root and project ID.");
  if (!IMAGE_PATTERN.test(image)) throw new TypeError("Preview image must be an official Node 22 Alpine image reference.");

  let imageReady = null;
  async function ensureImage() {
    if (!imageReady) {
      imageReady = (async () => {
        const inspect = await runDocker(dockerCommand, ["image", "inspect", image], { spawnImpl });
        if (inspect.code === 0) return;
        const pull = await runDocker(dockerCommand, ["pull", image], { spawnImpl, timeoutMs: IMAGE_PULL_TIMEOUT_MS });
        if (pull.code !== 0) throw runnerError(`The isolated preview image could not be prepared. ${pull.stderr || pull.stdout}`);
      })().catch(error => {
        imageReady = null;
        throw error;
      });
    }
    return imageReady;
  }

  return async function launchIsolatedPreview(request) {
    const repoRoot = await validateWorkspace({ workspaceRoot, appId, repoRoot: request?.repoRoot || request?.cwd });
    const runSpec = assertAllowedCommand(request || {});
    if (!Number.isInteger(request.port) || request.port < 1024 || request.port > 65535) {
      throw runnerError("Preview port is invalid.", "PREVIEW_PORT_INVALID", 409);
    }
    const entry = runSpec.command === "node" && !runSpec.staticRoot ? runSpec.args[0] : null;
    if (entry) {
      await assertNoSymlinkTraversal(repoRoot, entry);
      const entryStat = await fs.stat(path.join(repoRoot, entry)).catch(() => null);
      if (!entryStat?.isFile()) throw runnerError("Preview entry file is missing.", "PREVIEW_ENTRY_UNAVAILABLE", 409);
    }
    await ensureImage();
    const token = randomUUID().replaceAll("-", "");
    const containerName = `feltus-preview-app-${token}`;
    const proxyName = `feltus-preview-proxy-${token}`;
    const networkName = `feltus-preview-net-${token}`;
    const proxyNetworkName = `feltus-preview-front-${token}`;
    const snapshot = await createWorkspaceSnapshot({ repoRoot, workspaceRoot, scratchRoot, token });
    try {
      await assertSnapshotScript(snapshot, request, runSpec);
    } catch (error) {
      await removeWorkspaceSnapshot(snapshot, scratchRoot);
      throw error;
    }
    const label = "com.feltus.preview.managed=true";
    const env = {
      HOME: "/tmp/feltus-preview-home",
      NODE_ENV: "development",
      CI: "1",
      NO_COLOR: "1",
      HOST: "0.0.0.0",
      PORT: String(request.port),
      BROWSER: "none",
      FELTUS_PREVIEW: "1",
      FELTUS_STATIC_ROOT: runSpec.staticRoot || "",
      TMPDIR: "/tmp",
      TEMP: "/tmp",
      NPM_CONFIG_USERCONFIG: "/dev/null",
      NPM_CONFIG_GLOBALCONFIG: "/dev/null",
      NPM_CONFIG_CACHE: "/tmp/npm-cache",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false"
    };
    try {
      const internalNetwork = await runDocker(dockerCommand, [
        "network", "create", "--internal", "--label", label, "--label", `com.feltus.preview.app-id=${appId}`, networkName
      ], { spawnImpl });
      if (internalNetwork.code !== 0) throw runnerError(`An isolated app network could not be created. ${internalNetwork.stderr || internalNetwork.stdout}`);
      const frontNetwork = await runDocker(dockerCommand, [
        "network", "create", "--driver", "bridge", "--label", label, "--label", `com.feltus.preview.app-id=${appId}`, proxyNetworkName
      ], { spawnImpl });
      if (frontNetwork.code !== 0) throw runnerError(`The local Preview connection could not be created. ${frontNetwork.stderr || frontNetwork.stdout}`);

      const appArgs = [
        "run", "--detach", "--init", "--name", containerName,
        "--label", label,
        "--label", `com.feltus.preview.app-id=${appId}`,
        "--label", "com.feltus.preview.role=app",
        "--network", networkName,
        "--cpus", "1",
        "--memory", "512m",
        "--memory-swap", "512m",
        "--pids-limit", "128",
        "--security-opt", "no-new-privileges:true",
        "--cap-drop", "ALL",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=128m",
        "--user", "1000:1000",
        "--workdir", "/workspace",
        "--mount", `type=bind,source=${snapshot},target=/workspace`
      ];
      for (const [key, value] of Object.entries(env)) appArgs.push("--env", `${key}=${value}`);
      appArgs.push(image, runSpec.command, ...runSpec.args);
      const appContainer = await runDocker(dockerCommand, appArgs, { spawnImpl });
      if (appContainer.code !== 0) throw runnerError(`The isolated project container could not start. ${appContainer.stderr || appContainer.stdout}`);

      const proxyArgs = [
        "run", "--detach", "--init", "--name", proxyName,
        "--label", label,
        "--label", `com.feltus.preview.app-id=${appId}`,
        "--label", "com.feltus.preview.role=connection",
        "--network", proxyNetworkName,
        "--cpus", "0.25",
        "--memory", "128m",
        "--memory-swap", "128m",
        "--pids-limit", "32",
        "--security-opt", "no-new-privileges:true",
        "--cap-drop", "ALL",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
        "--user", "1000:1000",
        "--publish", `127.0.0.1:${request.port}:${request.port}/tcp`,
        "--env", `PORT=${request.port}`,
        "--env", `FELTUS_UPSTREAM_HOST=${containerName}`,
        "--env", `FELTUS_UPSTREAM_PORT=${request.port}`,
        image, "node", "-e", PREVIEW_PROXY_SCRIPT
      ];
      const proxyContainer = await runDocker(dockerCommand, proxyArgs, { spawnImpl });
      if (proxyContainer.code !== 0) throw runnerError(`The local Preview connection could not start. ${proxyContainer.stderr || proxyContainer.stdout}`);
      const joined = await runDocker(dockerCommand, ["network", "connect", networkName, proxyName], { spawnImpl });
      if (joined.code !== 0) throw runnerError(`The local Preview connection could not join the isolated app network. ${joined.stderr || joined.stdout}`);

      const child = createPreviewMonitor({
        appName: containerName,
        proxyName,
        networkName,
        proxyNetworkName,
        snapshot,
        scratchRoot,
        dockerCommand,
        spawnImpl
      });
      return { child, port: request.port, isolated: true, containerName, proxyName, networkName, proxyNetworkName, snapshot };
    } catch (error) {
      await cleanupPreviewResources({ appName: containerName, proxyName, networkName, proxyNetworkName, snapshot, scratchRoot, dockerCommand, spawnImpl });
      throw error?.code ? error : runnerError(`The isolated preview could not start: ${redactSecrets(error.message)}`);
    }
  };
}

export const previewRunnerDefaults = Object.freeze({ image: DEFAULT_IMAGE, memory: "512m", cpu: "1", processLimit: 128 });
