import http from "node:http";
import dotenv from "dotenv";
import { createBuildWorker } from "./lib/feltus-build-worker.js";

dotenv.config();
const worker = createBuildWorker();
const port = Math.max(1, Number(process.env.FELTUS_BUILD_WORKER_PORT || 8082));
let shuttingDown = false;

const server = http.createServer((req, res) => {
  if (req.method !== "GET" || req.url !== "/health") {
    res.writeHead(404, { "Cache-Control": "no-store" }).end();
    return;
  }
  const health = worker.health();
  res.writeHead(health.status === "healthy" ? 200 : 503, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(health));
});

server.listen(port, "0.0.0.0");
worker.start().catch(() => {
  process.stderr.write("FELTUS build worker stopped unexpectedly.\n");
  process.exitCode = 1;
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await worker.stop();
    process.exit(0);
  });
}