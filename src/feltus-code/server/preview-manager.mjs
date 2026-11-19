import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { assertNoSymlinkTraversal, normalizeRelativePath, redactSecrets, safeProjectEnvironment } from "./security.mjs";

const MAX_OUTPUT = 200000;
const MAX_PROXY_BYTES = 8 * 1024 * 1024;
const READY_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_TIMEOUT_MS = 120000;

function previewError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function previewCommand(scriptName, scriptValue, port) {
  const command = String(scriptValue || "").trim().replace(/\s+/g, " ");
  const npmRun = args => ({ command: "npm", args: ["run", scriptName, "--ignore-scripts", "--", ...args] });
  if (scriptName === "dev" && command === "vite") {
    return npmRun(["--host", "0.0.0.0", "--port", String(port), "--strictPort"]);
  }
  if (scriptName === "preview" && command === "vite preview") {
    return npmRun(["--host", "0.0.0.0", "--port", String(port), "--strictPort"]);
  }
  if (scriptName === "dev" && command === "next dev") {
    return npmRun(["--hostname", "0.0.0.0", "--port", String(port)]);
  }
  if (scriptName === "start" && command === "next start") {
    return npmRun(["--hostname", "0.0.0.0", "--port", String(port)]);
  }
  if (scriptName === "dev") {
    const match = command.match(/^node\s+((?:\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:js|mjs|cjs))$/i);
    if (match) {
      try {
        return { command: "node", args: [normalizeRelativePath(match[1])] };
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function readPreviewScript(repoRoot, port) {
  let manifest = null;

  await assertNoSymlinkTraversal(repoRoot, "package.json");
  try {
    manifest = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  } catch {}

  if (manifest) {
    for (const script of ["dev", "preview", "start"]) {
      const scriptValue = manifest?.scripts?.[script];
      if (typeof scriptValue !== "string" || !scriptValue.trim()) continue;
      const runnable = previewCommand(script, scriptValue, port);
      if (runnable) return { name: script, ...runnable };
    }
  }

  for (const candidate of ["index.html", "src/index.html"]) {
    await assertNoSymlinkTraversal(repoRoot, candidate);
    const stat = await fs.stat(path.join(repoRoot, candidate)).catch(() => null);
    if (!stat?.isFile()) continue;

    return {
      name: "static",
      command: "feltus-static",
      args: [],
      staticRoot: path.dirname(candidate) === "." ? "." : path.dirname(candidate)
    };
  }

  if (!manifest) {
    throw previewError(
      "Preview needs either a supported application runtime or a static index.html.",
      "PREVIEW_RUNTIME_UNAVAILABLE",
      409
    );
  }

  throw previewError(
    "Preview supports Vite, Next.js, a project JavaScript server, or a static index.html.",
    "PREVIEW_COMMAND_UNSUPPORTED",
    409
  );
}

function sanitizeErrorText(value, limit) {
  return redactSecrets(String(value || ""))
    .replace(/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n;,]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:bearer|basic)\s+[^\s]+/gi, "[REDACTED AUTH]")
    .replace(/(https?:\/\/[^\s?#]+)(?:\?[^\s#]*)?(?:#[^\s]*)?/gi, "$1")
    .slice(0, limit);
}

function appendOutput(current, chunk) {
  return sanitizeErrorText(`${current}${chunk}`, MAX_OUTPUT).slice(-MAX_OUTPUT);
}

function sanitizeSource(value) {
  const safe = sanitizeErrorText(value, 1000);
  try {
    return new URL(safe, "http://preview.local").pathname.slice(0, 1000);
  } catch {
    return safe.split(/[?#]/, 1)[0].slice(0, 1000);
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bridgeScript(appId) {
  const endpoint = `/api/code/preview/errors?app_id=${encodeURIComponent(appId)}`;
  return `<script>(function(){
    const endpoint=${JSON.stringify(endpoint)};
    const safeText=value=>String(value||"").replace(/\\b(?:authorization|cookie|set-cookie|password|token|secret|api[_-]?key)\\s*[:=]\\s*[^\\s,;]+/gi,"[REDACTED]").slice(0,2000);
    const safeSource=value=>{try{return new URL(String(value||""),location.href).pathname.slice(0,1000);}catch{return "";}};
    const send=(type,message,source)=>{try{fetch(endpoint,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({type,message:safeText(message),source:safeSource(source)})}).catch(()=>{});}catch{}};
    addEventListener("error",event=>send("uncaught",event.message,event.filename));
    addEventListener("unhandledrejection",event=>send("promise",event.reason?.message||"Unhandled promise rejection",location.href));
    const originalError=console.error.bind(console); console.error=(...args)=>{const safe=args.map(value=>typeof value==="string"?value:(value instanceof Error?value.name+": "+value.message:"[non-text console error]")).join(" "); send("console",safe,location.href); originalError(...args);};
    const originalFetch=window.fetch.bind(window); window.fetch=async(...args)=>{try{const response=await originalFetch(...args); if(!response.ok) send("network","Request failed ("+response.status+")",safeSource(args[0])); return response;}catch(error){send("network","Request failed",safeSource(args[0])); throw error;}};
    parent.postMessage({type:"feltus-preview-ready"},location.origin);
  })();</script>`;
}

function proxyBase(appId) {
  return `/api/code/preview/proxy/${encodeURIComponent(appId)}`;
}

function proxiedUrl(appId, value, resourcePath = "/") {
  if (!value || /^(?:[a-z]+:|#|data:|blob:|\/\/)/i.test(value)) return value;
  const resolved = new URL(value, `http://preview.local${resourcePath}`).pathname;
  return `${proxyBase(appId)}${resolved}`;
}

function rewritePreviewBody(buffer, contentType, appId, resourcePath) {
  if (!/text\/html|text\/css|javascript|ecmascript/i.test(contentType)) return buffer;
  let text = buffer.toString("utf8");
  if (/text\/html/i.test(contentType)) {
    text = text.replace(/\b(src|href|action)=(['"])([^'"]+)\2/gi, (_match, name, quote, value) =>
      `${name}=${quote}${proxiedUrl(appId, value, resourcePath)}${quote}`);
    const bridge = bridgeScript(appId);
    text = /<head[\s>]/i.test(text) ? text.replace(/<head([^>]*)>/i, `<head$1>${bridge}`) : `${bridge}${text}`;
  } else if (/text\/css/i.test(contentType)) {
    text = text.replace(/url\((['"]?)(\/[^)'"\s]+)\1\)/gi, (_match, quote, value) => `url(${quote}${proxyBase(appId)}${value}${quote})`);
  } else {
    text = text.replace(/(\bfrom\s*|\bimport\s*\()(['"])(\/[^'"]+)\2/g, (_match, lead, quote, value) =>
      `${lead}${quote}${proxyBase(appId)}${value}${quote}`);
  }
  return Buffer.from(text, "utf8");
}

export function createPreviewManager({
  repoRoot,
  launchIsolatedPreview = null,
  fetchImpl = globalThis.fetch,
  allocate = allocatePort,
  readyTimeoutMs = READY_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
} = {}) {
  if (!repoRoot) throw new TypeError("Preview manager requires repoRoot.");
  let processState = null;
  let idleTimer = null;
  const errors = [];

  function publicState() {
    if (!processState) return {
      status: typeof launchIsolatedPreview === "function" ? "stopped" : "unavailable",
      available: typeof launchIsolatedPreview === "function",
      reason: typeof launchIsolatedPreview === "function" ? null : "Secure preview is not available in this workspace yet.",
      script: null,
      port: null,
      url: null,
      stdout: "",
      stderr: "",
      errors: [...errors]
    };
    return {
      status: processState.status,
      available: true,
      reason: processState.failureReason || null,
      script: processState.script,
      port: processState.port,
      url: processState.port ? `http://127.0.0.1:${processState.port}` : null,
      started_at: processState.startedAt,
      exit_code: processState.exitCode,
      stdout: processState.stdout,
      stderr: processState.stderr,
      errors: [...errors]
    };
  }

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleIdleCleanup() {
    clearIdleTimer();
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || processState?.status !== "running") return;
    idleTimer = setTimeout(() => {
      if (processState?.status === "running") {
        processState.failureReason = "Preview stopped after the Studio session became inactive.";
        void stop();
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  async function waitForChildClose(child, timeoutMs) {
    if (processState?.child !== child || processState.childClosed) return true;
    let listener;
    const closed = new Promise(resolve => {
      listener = () => resolve(true);
      child.once("close", listener);
    });
    const completed = await Promise.race([closed, wait(timeoutMs).then(() => false)]);
    if (!completed) child.removeListener?.("close", listener);
    return completed;
  }

  async function reachable() {
    if (!processState?.port) return false;
    try {
      const response = await fetchImpl(`http://127.0.0.1:${processState.port}/`, { redirect: "manual", signal: AbortSignal.timeout(1000) });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  async function start() {
    if (processState && ["starting", "running"].includes(processState.status)) return publicState();
    if (processState?.child && !processState.childClosed && processState.status !== "stopped") await stop();
    if (typeof launchIsolatedPreview !== "function") {
      throw previewError("Secure preview is not available in this workspace yet.", "PREVIEW_ISOLATION_UNAVAILABLE", 503);
    }
    const port = await allocate();
    const script = await readPreviewScript(repoRoot, port);
    const launch = await launchIsolatedPreview({
      cwd: repoRoot,
      repoRoot,
      command: script.command,
      args: script.args,
      port,
      script: script.name,
      staticRoot: script.staticRoot || null,
      env: safeProjectEnvironment({ extra: {
        HOST: "0.0.0.0",
        PORT: String(port),
        BROWSER: "none",
        FELTUS_PREVIEW: "1"
      } })
    });
    if (!launch || launch.isolated !== true || launch.port !== port || !launch.child || typeof launch.child.kill !== "function") {
      launch?.child?.kill?.("SIGTERM");
      throw previewError("The configured preview runner did not confirm an isolated project container.", "PREVIEW_ISOLATION_UNAVAILABLE", 503);
    }
    const child = launch.child;
    processState = {
      child,
      port,
      script: script.name,
      status: "starting",
      startedAt: new Date().toISOString(),
      exitCode: null,
      stdout: "",
      stderr: "",
      failureReason: null,
      childClosed: false
    };
    child.stdout?.on("data", chunk => { if (processState?.child === child) processState.stdout = appendOutput(processState.stdout, chunk); });
    child.stderr?.on("data", chunk => { if (processState?.child === child) processState.stderr = appendOutput(processState.stderr, chunk); });
    child.once("error", error => {
      if (processState?.child === child) {
        processState.status = "failed";
        processState.failureReason = sanitizeErrorText(error.message, 2000);
        processState.stderr = appendOutput(processState.stderr, error.message);
      }
    });
    child.once("close", code => {
      if (processState?.child === child) {
        processState.childClosed = true;
        processState.exitCode = code;
        processState.status = processState.status === "stopping" ? "stopped" : code === 0 ? "stopped" : "failed";
        clearIdleTimer();
      }
    });
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline && processState?.child === child && processState.status === "starting") {
      if (await reachable()) {
        processState.status = "running";
        scheduleIdleCleanup();
        return publicState();
      }
      await wait(250);
    }
    if (processState?.status === "starting") {
      processState.status = "stopping";
      processState.failureReason = "Preview did not become ready before the startup limit.";
      child.kill("SIGTERM");
      const stopDeadline = Date.now() + 3000;
      while (Date.now() < stopDeadline && processState?.status === "stopping") await wait(50);
      if (processState?.status === "stopping") child.kill("SIGKILL");
      processState.status = "failed";
      throw previewError("Preview did not become ready before the startup limit.", "PREVIEW_START_TIMEOUT", 504);
    }
    throw previewError(processState?.failureReason || processState?.stderr || "Preview process stopped during startup.", "PREVIEW_START_FAILED", 409);
  }

  async function stop() {
    clearIdleTimer();
    const child = processState?.child;
    if (!child || processState.childClosed) return publicState();
    if (!["starting", "running", "stopping", "failed"].includes(processState.status)) return publicState();
    processState.status = "stopping";
    child.kill("SIGTERM");
    if (!await waitForChildClose(child, 3500)) {
      child.kill("SIGKILL");
      if (!await waitForChildClose(child, 15000)) {
        throw previewError("Preview cleanup did not finish before the stop limit.", "PREVIEW_STOP_TIMEOUT", 504);
      }
    }
    return publicState();
  }

  async function restart() {
    await stop();
    errors.splice(0, errors.length);
    return start();
  }

  function heartbeat() {
    if (processState?.status === "running") scheduleIdleCleanup();
    return publicState();
  }

  function recordError(error) {
    const knownTypes = new Set(["runtime", "compiler", "browser", "network", "uncaught", "promise", "console"]);
    const receivedType = String(error?.type || "runtime").slice(0, 40).toLowerCase();
    const entry = {
      type: knownTypes.has(receivedType) ? receivedType : "runtime",
      message: sanitizeErrorText(error?.message || "Unknown preview error", 2000),
      source: sanitizeSource(error?.source || ""),
      at: new Date().toISOString()
    };
    errors.push(entry);
    if (errors.length > 50) errors.splice(0, errors.length - 50);
    return entry;
  }

  async function proxy(appId, resourcePath = "/", search = "") {
    if (!processState || processState.status !== "running") {
      throw previewError("Start Preview before opening the app.", "PREVIEW_NOT_RUNNING", 409);
    }
    scheduleIdleCleanup();
    const normalizedPath = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
    const response = await fetchImpl(`http://127.0.0.1:${processState.port}${normalizedPath}${search}`, {
      redirect: "manual",
      headers: { Accept: "*/*" },
      signal: AbortSignal.timeout(10000)
    });
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_PROXY_BYTES) throw previewError("Preview response is too large to display safely.", "PREVIEW_RESPONSE_TOO_LARGE", 413);
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > MAX_PROXY_BYTES) throw previewError("Preview response is too large to display safely.", "PREVIEW_RESPONSE_TOO_LARGE", 413);
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    return {
      status: response.status,
      contentType,
      body: rewritePreviewBody(raw, contentType, appId, normalizedPath),
      location: response.headers.get("location")
    };
  }

  return { start, stop, restart, status: publicState, heartbeat, recordError, proxy, dispose: stop };
}
