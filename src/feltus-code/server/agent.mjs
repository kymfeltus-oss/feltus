import { buildRepoMap } from "./repo-map.mjs";

export function createCodeAgent({ repoRoot, aiGateway, fileTools }) {
  if (!aiGateway?.complete) {
    throw new Error("FELTUS AI Gateway adapter with complete() is required.");
  }

  async function plan({ prompt, model, signal, onToken }) {
    const repoMap = (await buildRepoMap(repoRoot)).slice(0, 40000);

    const messages = [
      {
        role: "system",
        content:
          "You are FELTUS CODE. Produce a concise implementation plan. " +
          "Use the repository map, existing FELTUS patterns, and the smallest safe patch."
      },
      {
        role: "user",
        content: `Repository map:\n${repoMap}\n\nTask:\n${prompt}`
      }
    ];
    if (onToken && typeof aiGateway.completeStream === "function") {
      let content = "";
      let modelUsed = model || null;
      let usage = { input_tokens: 0, output_tokens: 0 };
      for await (const event of aiGateway.completeStream({
        messages,
        model,
        temperature: 0.1,
        maxTokens: 2500,
        signal
      })) {
        if (event.delta) {
          content += event.delta;
          await onToken(event.delta);
        }
        if (event.model) modelUsed = event.model;
        if (event.usage) usage = event.usage;
      }
      return { content, model: modelUsed, usage };
    }

    return aiGateway.complete({
      messages,
      model,
      temperature: 0.1,
      maxTokens: 2500,
      signal
    });
  }

  async function proposeEdit({ prompt, paths = [], model, signal }) {
    const selected = [];

    const selectedPaths = [...new Set(paths)].slice(0, 12);
    for (const relativePath of selectedPaths) {
      selected.push({
        path: relativePath,
        content: await fileTools.readForAI(relativePath),
        before_sha256: await fileTools.hash(relativePath)
      });
    }

    const completion = await aiGateway.complete({
      messages: [
        {
          role: "system",
          content:
            'You are FELTUS CODE. Return ONLY valid JSON shaped as ' +
            '{"summary":"...","files":[{"path":"relative/path","content":"complete replacement text"}]}. ' +
            "Never use absolute paths."
        },
        {
          role: "user",
          content:
            `Task:\n${prompt}\n\nSelected files:\n` +
            selected.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n")
        }
      ],
      model,
      temperature: 0.1,
      maxTokens: 8000,
      signal
    });

    const raw = String(completion?.content || completion?.response || "").trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    let proposal;
    try {
      proposal = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("AI returned an invalid edit proposal."), { code: "AI_EDIT_INVALID_RESPONSE" });
    }
    if (!Array.isArray(proposal.files) || proposal.files.length < 1 || proposal.files.length > selected.length) {
      throw Object.assign(new Error("AI edit proposal did not match the selected files."), { code: "AI_EDIT_INVALID_RESPONSE" });
    }
    const beforeHashes = new Map(selected.map(item => [item.path, item.before_sha256]));
    const files = proposal.files.map(item => {
      if (
        typeof item?.path !== "string" ||
        !beforeHashes.has(item.path) ||
        typeof item.content !== "string"
      ) {
        throw Object.assign(new Error("AI edit proposal referenced an unselected file."), { code: "AI_EDIT_INVALID_RESPONSE" });
      }
      return {
        path: item.path,
        content: item.content,
        before_sha256: beforeHashes.get(item.path)
      };
    });
    return {
      summary: String(proposal.summary || "Proposed code changes").slice(0, 2000),
      files,
      allowedPaths: selectedPaths,
      model: completion?.model || model || null,
      usage: completion?.usage || null
    };
  }

  return { plan, proposeEdit };
}
