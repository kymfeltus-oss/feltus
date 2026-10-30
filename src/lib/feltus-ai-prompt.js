export function composeAIPrompt({
  systemInstructions,
  projectContext = "",
  history = [],
  retrievedContext = "",
  currentPrompt
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
  sections.push(`CURRENT USER PROMPT\n${currentPrompt.trim()}`);
  return sections.filter(Boolean).join("\n\n");
}
