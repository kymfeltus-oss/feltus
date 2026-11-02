import assert from "node:assert/strict";
import { OpenAICompatibleAI, createAIProvider } from "../src/lib/feltus-ai-providers.js";
import { executeBuiltInTool, toolByKey } from "../src/lib/feltus-tools.js";
import { createFeltusCodeAIGateway } from "../src/feltus-code/server/ai-gateway.mjs";

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

try {
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "qwen-local", owned_by: "feltus" }] });
    }
    if (target.endsWith("/v1/embeddings")) {
      assert.equal(JSON.parse(options.body).input, "document text");
      return Response.json({ model: "embed-local", data: [{ embedding: [0.1, 0.2] }] });
    }
    if (target.endsWith("/v1/chat/completions") && JSON.parse(options.body).stream === false) {
      const body = JSON.parse(options.body);
      assert.equal(body.model, "qwen-local");
      assert.equal(body.messages[0].role, "system");
      return Response.json({
        choices: [{ message: { content: "private response" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 }
      });
    }
    if (target.endsWith("/v1/chat/completions")) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`Unexpected provider request: ${target}`);
  };

  const provider = new OpenAICompatibleAI({
    baseUrl: "http://runtime.internal",
    apiKey: "runtime-secret",
    model: "qwen-local"
  });
  assert.deepEqual((await provider.listModels()).map(item => item.name), ["qwen-local"]);
  const generated = await provider.generate("hello", { systemPrompt: "private system prompt" });
  assert.equal(generated.response, "private response");
  assert.equal(generated.prompt_eval_count, 3);
  const streamed = [];
  for await (const event of provider.generateStream("hello")) streamed.push(event);
  assert.equal(streamed.map(event => event.response).join(""), "hello world");
  assert.equal(streamed.at(-1).eval_count, 2);
  const embeddings = await provider.embeddings("document text");
  assert.deepEqual(embeddings.embeddings, [[0.1, 0.2]]);

  const configured = createAIProvider({
    FELTUS_AI_PROVIDER: "vllm",
    FELTUS_AI_ENDPOINT: "http://runtime.internal",
    FELTUS_AI_RUNTIME_KEY: "runtime-secret",
    FELTUS_AI_MODEL: "qwen-local"
  });
  assert.equal(configured.provider, "vllm");

  const abortController = new AbortController();
  let gatewayInput;
  const gateway = createFeltusCodeAIGateway({
    model: "fallback-model",
    async generate(prompt, options) {
      gatewayInput = { prompt, options };
      return {
        response: "planned safely",
        model: options.model,
        prompt_eval_count: 17,
        eval_count: 9
      };
    }
  });
  const gatewayResult = await gateway.complete({
    messages: [
      { role: "system", content: "System policy" },
      { role: "user", content: "Selected source context" },
      { role: "assistant", content: "A previous approved step" }
    ],
    model: "selected-local-model",
    temperature: 0.15,
    maxTokens: 4096,
    signal: abortController.signal
  });
  assert.equal(gatewayInput.options.model, "selected-local-model");
  assert.equal(gatewayInput.options.systemPrompt, "System policy");
  assert.equal(gatewayInput.options.numPredict, 4096);
  assert.equal(gatewayInput.options.signal, abortController.signal);
  assert.match(gatewayInput.prompt, /Selected source context/);
  assert.match(gatewayInput.prompt, /A previous approved step/);
  assert.deepEqual(gatewayResult.usage, { input_tokens: 17, output_tokens: 9 });
  assert.equal(gatewayResult.content, "planned safely");
  const streamedGateway = createFeltusCodeAIGateway({
    model: "stream-model",
    async generate() { throw new Error("Streaming path should use the runtime stream API."); },
    async *generateStream(prompt, options) {
      assert.match(prompt, /selected repository map/);
      assert.equal(options.model, "stream-model");
      yield { response: "A plan", done: false, model: options.model };
      yield { response: " streamed", done: false, model: options.model };
      yield { done: true, prompt_eval_count: 11, eval_count: 5, model: options.model };
    }
  });
  const streamedGatewayEvents = [];
  for await (const event of streamedGateway.completeStream({
    messages: [{ role: "user", content: "selected repository map" }]
  })) streamedGatewayEvents.push(event);
  assert.equal(streamedGatewayEvents.filter(event => !event.done).map(event => event.delta).join(""), "A plan streamed");
  assert.deepEqual(streamedGatewayEvents.at(-1).usage, { input_tokens: 11, output_tokens: 5 });
  assert.equal(toolByKey("project.documents")?.requiredPermission, "read");

  const calls = [];
  const toolResult = await executeBuiltInTool("project.assets", { limit: 2 }, {
    appId: "00000000-0000-0000-0000-000000000001",
    tableRequest: async (table, method, options) => {
      calls.push({ table, method, query: options.query });
      return { status: 200, data: [{ id: "asset-id", asset_name: "Logo" }] };
    },
    runtimeStatus: async () => ({ status: "healthy" })
  });
  assert.equal(toolResult.items[0].asset_name, "Logo");
  assert.match(calls[0].query, /limit=2/);
  process.stdout.write("PASS core platform provider, FELTUS CODE AI Gateway adapter, and tool tests\n");
} finally {
  globalThis.fetch = originalFetch;
}
