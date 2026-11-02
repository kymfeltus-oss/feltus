export function composeAIPrompt({
  systemInstructions,
  projectContext = "",
  history = [],
  retrievedContext = "",
  currentPrompt,
  maxCharacters = 200000
}) {
  if (typeof currentPrompt !== "string" || !currentPrompt.trim()) {
    throw new Error("Current AI prompt is required.");
  }

  const sections = [String(systemInstructions || "").trim()];
  if (String(projectContext).trim()) {
    sections.push(`PROJECT CONTEXT\n${String(projectContext).trim()}`);
  }
  const recent = Array.isArray(history)
    ? history.slice(-20).filter(item =>
        (item?.role === "user" || item?.role === "assistant") &&
        typeof item?.content === "string" && item.content.trim()
      )
    : [];
  if (recent.length) {
    sections.push(
      "RECENT AUTHORIZED CONVERSATION\n" +
      recent.map(item => `${item.role.toUpperCase()}:\n${item.content}`).join("\n\n")
    );
  }
  if (String(retrievedContext).trim()) {
    sections.push(`RETRIEVED PROJECT/DOCUMENT CONTEXT\n${String(retrievedContext).trim()}`);
  }
  const currentSection = `CURRENT USER PROMPT\n${currentPrompt.trim()}`;
  sections.push(currentSection);
  const prompt = sections.filter(Boolean).join("\n\n");
  const budget = Number(maxCharacters);
  if (!Number.isInteger(budget) || budget < 1000 || prompt.length <= budget) {
    return prompt;
  }

  // Never truncate the current user instruction. Earlier context is optional
  // and is deliberately cut first when a per-conversation budget is reached.
  const prefixBudget = Math.max(0, budget - currentSection.length - 2);
  const prefix = sections.slice(0, -1).filter(Boolean).join("\n\n").slice(0, prefixBudget);
  return [prefix, currentSection].filter(Boolean).join("\n\n");
}
