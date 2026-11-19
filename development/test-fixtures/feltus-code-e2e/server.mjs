import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const root = path.resolve(".");
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("The preview port is invalid.");
}

const server = http.createServer(async (request, response) => {
  const method = String(request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    response.end("Only read-only preview requests are supported.");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || "/", "http://preview.local").pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  if (pathname.includes("\0") || pathname.split("/").some(part => part === "..")) {
    response.writeHead(400);
    response.end();
    return;
  }

  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    response.writeHead(404);
    response.end();
    return;
  }

  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("Not a file.");
    const content = await fs.readFile(target);
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream",
      "content-length": content.length,
      "x-content-type-options": "nosniff"
    });
    response.end(method === "HEAD" ? undefined : content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Preview file not found.");
  }
});

server.listen(port, "0.0.0.0");
