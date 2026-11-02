import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileTools } from "./server/file-tools.mjs";
import { createGitTools } from "./server/git-tools.mjs";
import { createTaskRunner } from "./server/task-runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.join(__dirname, "web");
const repoRoot = path.resolve(process.env.FELTUS_CODE_REPO || __dirname);
const port = Number(process.env.PORT || 4173);

const files = createFileTools({ repoRoot });
const git = createGitTools({ repoRoot });
const tasks = createTaskRunner({
  repoRoot,
  tasks: {
    "npm-check": { command: "npm", args: ["test"] },
    "npm-test": { command: "npm", args: ["test"] }
  }
});

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2_000_000) throw new Error("Request too large.");
  }
  return body ? JSON.parse(body) : {};
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
  }[ext] || "application/octet-stream";
}

async function serveStatic(reqPath, res) {
  const relative = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
  const target = path.resolve(webRoot, relative);
  if (target !== webRoot && !target.startsWith(webRoot + path.sep)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, { "Content-Type": mimeFor(target), "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const p = url.pathname;

    if (req.method === "GET" && p === "/api/ai/models") {
      return sendJson(res, 200, {
        ok: true,
        models: [{ id: "mock-local", name: "Local Test Model" }]
      });
    }

    if (req.method === "GET" && p === "/api/code/tree") {
      return sendJson(res, 200, { ok: true, items: await files.list(url.searchParams.get("path") || ".") });
    }

    if (req.method === "GET" && p === "/api/code/file") {
      const filePath = url.searchParams.get("path");
      return sendJson(res, 200, { ok: true, path: filePath, content: await files.read(filePath) });
    }

    if (req.method === "PUT" && p === "/api/code/file") {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, ...(await files.write(body.path, body.content)) });
    }

    if (req.method === "GET" && p === "/api/code/search") {
      return sendJson(res, 200, {
        ok: true,
        results: await files.search(url.searchParams.get("q") || "", { limit: 50 })
      });
    }

    if (req.method === "GET" && p === "/api/code/git/status") {
      try {
        return sendJson(res, 200, { ok: true, ...(await git.status()) });
      } catch (error) {
        return sendJson(res, 200, {
          ok: true,
          unavailable: true,
          code: 1,
          stdout: "",
          stderr: error.message
        });
      }
    }

    if (req.method === "GET" && p === "/api/code/git/diff") {
      try {
        return sendJson(res, 200, { ok: true, ...(await git.diff()) });
      } catch (error) {
        return sendJson(res, 200, {
          ok: true,
          unavailable: true,
          code: 1,
          stdout: "",
          stderr: error.message
        });
      }
    }

    if (req.method === "POST" && p === "/api/code/task") {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, result: await tasks.run(body.task) });
    }

    if (req.method === "POST" && p === "/api/code/ai/plan") {
      const body = await readBody(req);
      return sendJson(res, 200, {
        ok: true,
        result:
`LOCAL TEST MODE

I received your request:
${String(body.prompt || "").slice(0, 1000)}

The standalone test server is working. In the integrated FELTUS version, this endpoint will route through your FELTUS AI Gateway and self-hosted coding model.`
      });
    }

    if (req.method === "POST" && p === "/api/code/ai/edit") {
      const body = await readBody(req);
      return sendJson(res, 200, {
        ok: true,
        result: {
          mock: true,
          summary: "Standalone test mode: no AI-generated file changes were applied.",
          requestedTask: body.prompt || "",
          selectedPaths: body.paths || []
        }
      });
    }

    return serveStatic(p, res);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error?.message || "Unknown error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log("");
  console.log("===========================================");
  console.log(" FELTUS CODE — LOCAL TEST MODE");
  console.log("===========================================");
  console.log(`Open: http://127.0.0.1:${port}`);
  console.log(`Repository under test: ${repoRoot}`);
  console.log("AI: mock-local (no paid API calls)");
  console.log("Bind: localhost only");
  console.log("");
  console.log("Press Ctrl+C to stop.");
});
