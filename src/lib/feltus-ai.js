export class FeltusAI {
  constructor({
    baseUrl =
      process.env.FELTUS_AI_ENDPOINT ||
      process.env.FELTUS_AI_BASE_URL ||
      process.env.FELTUS_OLLAMA_URL ||
      (process.env.FELTUS_ENV === "production"
        ? ""
        : "http://127.0.0.1:11434"),

    model =
      process.env.FELTUS_AI_MODEL ||
      "llama3:8b",

    timeoutMs = 600000
  } = {}) {
    this.baseUrl =
      String(baseUrl || "").replace(/\/+$/, "");

    this.model = model;
    this.timeoutMs = timeoutMs;
  }


  async request(
    path,
    {
      method = "GET",
      body = null
    } = {}
  ) {
    if (!this.baseUrl) {
      throw new Error("AI endpoint is not configured.");
    }

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        this.timeoutMs
      );

    try {
      const response =
        await fetch(
          `${this.baseUrl}${path}`,
          {
            method,

            headers: {
              Accept:
                "application/json",

              ...(body
                ? {
                    "Content-Type":
                      "application/json"
                  }
                : {})
            },

            body:
              body
                ? JSON.stringify(body)
                : undefined,

            // AI trust is bound to this configured origin. Never follow a
            // redirect that could move prompts or stored context elsewhere.
            redirect: "manual",

            signal:
              controller.signal
          }
        );


      const text =
        await response.text();

      if (response.status >= 300 && response.status < 400) {
        throw new Error("AI endpoint redirects are not allowed.");
      }

      let data;

      try {
        data =
          JSON.parse(text);
      } catch {
        data = {
          raw: text
        };
      }


      if (!response.ok) {
        throw new Error(
          data.error ||
          data.message ||
          `Ollama request failed with HTTP ${response.status}`
        );
      }


      return data;

    } finally {
      clearTimeout(timeout);
    }
  }


  async listModels() {
    const result =
      await this.request(
        "/api/tags"
      );

    return Array.isArray(
      result.models
    )
      ? result.models
      : [];
  }


  async generate(
    prompt,
    {
      model = this.model,
      temperature = 0,
      numPredict = 256,
      keepAlive = "10m"
    } = {}
  ) {
    if (
      typeof prompt !== "string" ||
      !prompt.trim()
    ) {
      throw new Error(
        "AI prompt is required."
      );
    }


    const result =
      await this.request(
        "/api/generate",
        {
          method: "POST",

          body: {
            model,
            prompt: prompt.trim(),
            stream: false,

            keep_alive:
              keepAlive,

            options: {
              temperature,

              num_predict:
                numPredict
            }
          }
        }
      );


    if (
      result.done !== true
    ) {
      throw new Error(
        "Local AI inference did not complete."
      );
    }


    return result;
  }


  async *generateStream(
    prompt,
    {
      model = this.model,
      temperature = 0,
      numPredict = 256,
      keepAlive = "10m"
    } = {}
  ) {
    if (!this.baseUrl) {
      throw new Error("AI endpoint is not configured.");
    }

    if (
      typeof prompt !== "string" ||
      !prompt.trim()
    ) {
      throw new Error(
        "AI prompt is required."
      );
    }


    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        this.timeoutMs
      );


    try {
      const response =
        await fetch(
          `${this.baseUrl}/api/generate`,
          {
            method: "POST",

            headers: {
              Accept:
                "application/x-ndjson",

              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                model,

                prompt:
                  prompt.trim(),

                stream:
                  true,

                keep_alive:
                  keepAlive,

                options: {
                  temperature,

                  num_predict:
                    numPredict
                }
              }),

            redirect: "manual",

            signal:
              controller.signal
          }
        );


      if (response.status >= 300 && response.status < 400) {
        throw new Error("AI endpoint redirects are not allowed.");
      }

      if (!response.ok) {
        const errorText =
          await response.text();

        throw new Error(
          errorText ||
          `Ollama streaming request failed with HTTP ${response.status}`
        );
      }


      if (!response.body) {
        throw new Error(
          "Ollama returned no response stream."
        );
      }


      const reader =
        response.body.getReader();

      const decoder =
        new TextDecoder();

      let buffer = "";


      while (true) {
        const {
          done,
          value
        } =
          await reader.read();


        if (done) {
          break;
        }


        buffer +=
          decoder.decode(
            value,
            {
              stream: true
            }
          );


        let newlineIndex;


        while (
          (
            newlineIndex =
              buffer.indexOf("\n")
          ) >= 0
        ) {
          const line =
            buffer
              .slice(
                0,
                newlineIndex
              )
              .trim();

          buffer =
            buffer.slice(
              newlineIndex + 1
            );


          if (!line) {
            continue;
          }


          const event =
            JSON.parse(line);

          yield event;
        }
      }


      buffer +=
        decoder.decode();


      if (buffer.trim()) {
        yield JSON.parse(
          buffer.trim()
        );
      }

    } finally {
      clearTimeout(timeout);
    }
  }
}


export default FeltusAI;
