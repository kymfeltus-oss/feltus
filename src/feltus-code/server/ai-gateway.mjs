export function createFeltusCodeAIGateway(ai) {
  if (!ai || typeof ai.generate !== "function") {
    throw new Error("Configured FELTUS AI provider is unavailable.");
  }

  function flatten(messages = []) {
    const systemPrompt = messages
      .filter(item => item?.role === "system")
      .map(item => String(item.content || ""))
      .join("\n\n");
    const prompt = messages
      .filter(item => item?.role !== "system")
      .map(item => `${String(item?.role || "user").toUpperCase()}:\n${String(item?.content || "")}`)
      .join("\n\n");
    return { systemPrompt, prompt };
  }

  const normalizedResult = (result, model) => ({
    content: String(result.response || ""),
    model: result.model || model || ai.model,
    usage: {
      input_tokens: Number(result.prompt_eval_count || 0),
      output_tokens: Number(result.eval_count || 0)
    }
  });

  return {
    async complete({ messages = [], model, temperature = 0.1, maxTokens = 2500, signal } = {}) {
      const { systemPrompt, prompt } = flatten(messages);
      const result = await ai.generate(prompt, {
        model: model || ai.model,
        temperature,
        numPredict: Math.min(Math.max(Number(maxTokens) || 2500, 32), 8192),
        systemPrompt,
        signal
      });
      return normalizedResult(result, model);
    },

    async *completeStream({ messages = [], model, temperature = 0.1, maxTokens = 2500, signal } = {}) {
      const { systemPrompt, prompt } = flatten(messages);
      const selectedModel = model || ai.model;
      const options = {
        model: selectedModel,
        temperature,
        numPredict: Math.min(Math.max(Number(maxTokens) || 2500, 32), 8192),
        systemPrompt,
        signal
      };
      if (typeof ai.generateStream !== "function") {
        const result = normalizedResult(await ai.generate(prompt, options), selectedModel);
        yield { delta: result.content, done: false, model: result.model };
        yield { delta: "", done: true, model: result.model, usage: result.usage };
        return;
      }

      let completed = false;
      for await (const event of ai.generateStream(prompt, options)) {
        const delta = String(event?.response || "");
        if (delta) yield { delta, done: false, model: event.model || selectedModel };
        if (event?.done === true) {
          completed = true;
          yield {
            delta: "",
            done: true,
            model: event.model || selectedModel,
            usage: {
              input_tokens: Number(event.prompt_eval_count || event.usage?.prompt_tokens || 0),
              output_tokens: Number(event.eval_count || event.usage?.completion_tokens || 0)
            }
          };
        }
      }
      if (!completed) yield { delta: "", done: true, model: selectedModel, usage: { input_tokens: 0, output_tokens: 0 } };
    }
  };
}
