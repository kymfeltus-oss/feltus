import http from "node:http";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { createAIProvider } from "./lib/feltus-ai-providers.js";
import { resolveAIEndpointPolicy } from "./lib/feltus-ai-policy.js";

dotenv.config();

const GATEWAY = String(process.env.FELTUS_GATEWAY_URL || "").replace(/\/+$/, "");
const SERVICE_KEY = process.env.FELTUS_SERVICE_ROLE_KEY || "";
const WORKER_ID = process.env.FELTUS_WORKER_ID || `worker-${crypto.randomUUID()}`;
const PORT = Number(process.env.FELTUS_WORKER_PORT || 8081);
const POLL_MS = Math.max(250, Number(process.env.FELTUS_WORKER_POLL_MS || 1000));
const LEASE_SECONDS = Math.max(30, Number(process.env.FELTUS_JOB_LEASE_SECONDS || 180));
let running = true;
let lastLoopAt = null;
let lastError = null;

if (!GATEWAY || !SERVICE_KEY) {
  throw new Error("Worker requires FELTUS_GATEWAY_URL and FELTUS_SERVICE_ROLE_KEY.");
}

const aiPolicy = await resolveAIEndpointPolicy(process.env);
const ai = createAIProvider({ ...process.env, FELTUS_AI_ENDPOINT: aiPolicy.endpoint });

async function rest(path, { method = "GET", body = null, prefer = "" } = {}) {
  const response = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text.slice(0, 1000) };
    }
  }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Worker database request failed: ${response.status}`);
  }
  return data;
}

async function heartbeat(status = "online") {
  await rest("/rest/v1/feltus_worker_heartbeats?on_conflict=worker_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      worker_id: WORKER_ID,
      worker_type: "core",
      status,
      metadata: { provider: ai.provider || "ollama" },
      last_seen_at: new Date().toISOString()
    }
  });
}

async function patchJob(id, body) {
  return rest(`/rest/v1/feltus_jobs?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: { ...body, updated_at: new Date().toISOString() }
  });
}

async function cancelled(job) {
  const rows = await rest(
    `/rest/v1/feltus_jobs?select=status,cancellation_requested&id=eq.${encodeURIComponent(job.id)}&limit=1`
  );
  return !rows?.[0] || rows[0].status === "CANCELLED" || rows[0].cancellation_requested === true;
}

async function generateWithCancellation(job, prompt, options) {
  const controller = new AbortController();
  let checking = false;
  const monitor = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    cancelled(job)
      .then(isCancelled => {
        if (isCancelled) controller.abort();
      })
      .catch(() => {})
      .finally(() => { checking = false; });
  }, 1000);
  try {
    return await ai.generate(prompt, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && await cancelled(job)) {
      error.cancelled = true;
    }
    throw error;
  } finally {
    clearInterval(monitor);
  }
}

async function execute(job) {
  const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
  if (job.job_type === "system.noop") return { ok: true };
  if (job.job_type === "ai.generate") {
    const result = await generateWithCancellation(job, String(payload.prompt || ""), {
      model: String(payload.model || ai.model),
      temperature: Number(payload.temperature ?? 0.2),
      numPredict: Number(payload.max_tokens || 2048),
      systemPrompt: String(payload.system_prompt || "")
    });
    return {
      response: result.response || "",
      model: payload.model || ai.model,
      usage: {
        input_tokens: result.prompt_eval_count || 0,
        output_tokens: result.eval_count || 0
      }
    };
  }
  if (job.job_type === "knowledge.reindex") {
    const query =
      "?select=id,content,metadata" +
      "&app_id=eq." + encodeURIComponent(job.app_id) +
      "&owner_id=eq." + encodeURIComponent(job.owner_id) +
      (payload.knowledge_base_id
        ? "&knowledge_base_id=eq." + encodeURIComponent(payload.knowledge_base_id)
        : "") +
      "&limit=250";
    const chunks = await rest("/rest/v1/feltus_knowledge_chunks" + query);
    let completed = 0;
    for (const chunk of Array.isArray(chunks) ? chunks : []) {
      if (await cancelled(job)) throw Object.assign(new Error("Job cancelled."), { cancelled: true });
      const embedded = await ai.embeddings(chunk.content, {
        model: String(payload.embedding_model || ai.model)
      });
      await rest(`/rest/v1/feltus_knowledge_chunks?id=eq.${encodeURIComponent(chunk.id)}`, {
        method: "PATCH",
        prefer: "return=minimal",
        body: {
          embedding_json: embedded.embeddings?.[0] || null,
          metadata: {
            ...(chunk.metadata || {}),
            embedding_model: embedded.model,
            embedded_at: new Date().toISOString()
          }
        }
      });
      completed += 1;
      await patchJob(job.id, { progress: Math.round((completed / Math.max(chunks.length, 1)) * 100) });
    }
    return { indexed_chunks: completed };
  }
  throw new Error(`Unsupported job type: ${job.job_type}`);
}

async function processJob(job) {
  try {
    if (await cancelled(job)) {
      await patchJob(job.id, { status: "CANCELLED", completed_at: new Date().toISOString() });
      return;
    }
    const result = await execute(job);
    if (await cancelled(job)) {
      await patchJob(job.id, { status: "CANCELLED", completed_at: new Date().toISOString() });
      return;
    }
    await patchJob(job.id, {
      status: "SUCCEEDED",
      progress: 100,
      result,
      worker_id: WORKER_ID,
      lease_expires_at: null,
      completed_at: new Date().toISOString()
    });
  } catch (error) {
    if (error.cancelled) {
      await patchJob(job.id, { status: "CANCELLED", completed_at: new Date().toISOString() });
      return;
    }
    const terminal = Number(job.attempts || 0) >= Number(job.max_attempts || 3);
    const delaySeconds = Math.min(300, 2 ** Math.max(Number(job.attempts || 1) - 1, 0) * 5);
    await patchJob(job.id, {
      status: terminal ? "FAILED" : "QUEUED",
      worker_id: null,
      lease_expires_at: null,
      retry_at: terminal ? null : new Date(Date.now() + delaySeconds * 1000).toISOString(),
      last_error: String(error?.message || "Worker failure").slice(0, 1000),
      completed_at: terminal ? new Date().toISOString() : null
    });
  }
}

async function loop() {
  while (running) {
    try {
      lastLoopAt = new Date().toISOString();
      await heartbeat();
      await rest("/rest/v1/rpc/feltus_recover_stale_jobs", { method: "POST", body: {} });
      const jobs = await rest("/rest/v1/rpc/feltus_claim_jobs", {
        method: "POST",
        body: { p_worker_id: WORKER_ID, p_limit: 1, p_lease_seconds: LEASE_SECONDS }
      });
      if (Array.isArray(jobs) && jobs[0]) {
        await processJob(jobs[0]);
        lastError = null;
        continue;
      }
      lastError = null;
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 500);
      await new Promise(resolve => setTimeout(resolve, Math.max(POLL_MS, 2000)));
    }
  }
}

http.createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(lastError ? 503 : 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: lastError ? "degraded" : "healthy",
    worker_id: WORKER_ID,
    last_loop_at: lastLoopAt,
    last_error: lastError
  }));
}).listen(PORT, "0.0.0.0");

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    running = false;
    heartbeat("stopping").catch(() => {});
    setTimeout(() => process.exit(0), 250).unref();
  });
}

loop().catch(error => {
  process.stderr.write(`FELTUS worker failed: ${error.message}\n`);
  process.exitCode = 1;
});
