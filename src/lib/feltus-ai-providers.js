import { FeltusAI } from "./feltus-ai.js";

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function providerError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export class OpenAICompatibleAI {
  constructor({
    baseUrl,
    apiKey = "",
    model = "",
    timeoutMs = 600000
  } = {}) {
    this.baseUrl = cleanBaseUrl(baseUrl);
    this.apiKey = String(apiKey || "");
    this.model = String(model || "");
    this.timeoutMs = timeoutMs;
    this.provider = "openai_compatible";
  }

  headers() {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
    };
  }

  async request(path, { method = "GET", body = null, signal = null } = {}) {
    if (!this.baseUrl) throw providerError("FELTUS_AI_NOT_CONFIGURED", "AI endpoint is not configured.");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: signal || AbortSignal.timeout(this.timeoutMs)
    });
    if (response.status >= 300 && response.status < 400) {
      throw providerError("FELTUS_AI_REDIRECT_BLOCKED", "AI endpoint redirects are not allowed.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw providerError(
        "FELTUS_AI_UPSTREAM_ERROR",
        data?.error?.message || data?.error || data?.message || `AI request failed with HTTP ${response.status}`
      );
    }
    return data;
  }

  async listModels() {
    const result = await this.request("/v1/models");
    return Array.isArray(result.data)
      ? result.data.map(item => ({
          name: item.id,
          model: item.id,
          details: { owned_by: item.owned_by || null }
        }))
      : [];
  }

  async generate(prompt, {
    model = this.model,
    temperature = 0.2,
    numPredict = 2048,
    systemPrompt = "",
    signal = null
  } = {}) {
    const messages = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      { role: "user", content: String(prompt || "").trim() }
    ];
    const result = await this.request("/v1/chat/completions", {
      method: "POST",
      body: { model, messages, temperature, max_tokens: numPredict, stream: false },
      signal
    });
    return {
      done: true,
      response: result.choices?.[0]?.message?.content || "",
      prompt_eval_count: result.usage?.prompt_tokens || 0,
      eval_count: result.usage?.completion_tokens || 0,
      model,
      raw: result
    };
  }

  async *generateStream(prompt, {
    model = this.model,
    temperature = 0.2,
    numPredict = 2048,
    systemPrompt = "",
    signal = null
  } = {}) {
    const messages = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      { role: "user", content: String(prompt || "").trim() }
    ];
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: numPredict,
        stream: true,
        stream_options: { include_usage: true }
      }),
      redirect: "manual",
      signal: signal || AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok || !response.body) {
      throw providerError("FELTUS_AI_UPSTREAM_ERROR", `AI streaming request failed with HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastUsage = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") {
            if (payload === "[DONE]") {
              yield {
                done: true,
                response: "",
                model,
                usage: lastUsage,
                prompt_eval_count: lastUsage?.prompt_tokens || 0,
                eval_count: lastUsage?.completion_tokens || 0
              };
            }
            continue;
          }
          const event = JSON.parse(payload);
          if (event.usage) lastUsage = event.usage;
          yield {
            done: false,
            response: event.choices?.[0]?.delta?.content || "",
            model,
            usage: event.usage || null
          };
        }
      }
    }
  }

  async embeddings(input, { model = this.model, signal = null } = {}) {
    const result = await this.request("/v1/embeddings", {
      method: "POST",
      body: { model, input },
      signal
    });
    return {
      model: result.model || model,
      embeddings: Array.isArray(result.data)
        ? result.data.map(item => item.embedding)
        : [],
      usage: result.usage || null
    };
  }
}

export function createAIProvider(environment = process.env) {
  const provider = String(environment.FELTUS_AI_PROVIDER || "ollama").trim().toLowerCase();
  const baseUrl =
    environment.FELTUS_AI_ENDPOINT ||
    environment.FELTUS_AI_BASE_URL ||
    environment.FELTUS_OLLAMA_URL ||
    "";
  const options = {
    baseUrl,
    model: environment.FELTUS_AI_MODEL || "llama3:8b",
    timeoutMs: Number(environment.FELTUS_AI_TIMEOUT_MS || 600000)
  };
  if (provider === "ollama") {
    const runtime = new FeltusAI(options);
    runtime.provider = "ollama";
    return runtime;
  }
  if (new Set(["openai_compatible", "vllm", "llama_cpp"]).has(provider)) {
    const runtime = new OpenAICompatibleAI({
      ...options,
      apiKey: environment.FELTUS_AI_RUNTIME_KEY || ""
    });
    runtime.provider = provider;
    return runtime;
  }
  throw providerError("FELTUS_AI_PROVIDER_UNSUPPORTED", `Unsupported AI provider: ${provider}`);
}

export function publicRuntimeMetadata(ai) {
  return {
    provider: ai.provider || "ollama",
    default_model: ai.model,
    configured: Boolean(ai.baseUrl)
  };
}
