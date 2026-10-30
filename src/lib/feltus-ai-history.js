export async function loadAuthorizedAIHistory(
  tableRequest,
  { appId, conversationId, ownerId, maxMessages = 20 }
) {
  if (
    typeof appId !== "string" || !appId ||
    typeof conversationId !== "string" || !conversationId ||
    typeof ownerId !== "string" || !ownerId ||
    !Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 20
  ) {
    return { status: 400, messages: [] };
  }

  const conversationResult = await tableRequest(
    "feltus_ai_conversations",
    "GET",
    {
      query:
        "?select=id,app_id,owner_id,status" +
        "&id=eq." + encodeURIComponent(conversationId) +
        "&app_id=eq." + encodeURIComponent(appId) +
        "&owner_id=eq." + encodeURIComponent(ownerId) +
        "&status=eq.active&limit=1"
    }
  );
  if (conversationResult.status < 200 || conversationResult.status >= 300) {
    return { status: conversationResult.status, messages: [] };
  }

  const conversation = Array.isArray(conversationResult.data)
    ? conversationResult.data.find(item =>
        item?.id === conversationId &&
        item?.app_id === appId &&
        item?.owner_id === ownerId &&
        item?.status === "active"
      )
    : null;
  if (!conversation) return { status: 404, messages: [] };

  const messagesResult = await tableRequest(
    "feltus_ai_messages",
    "GET",
    {
      query:
        "?select=id,conversation_id,app_id,owner_id,role,content,created_at" +
        "&conversation_id=eq." + encodeURIComponent(conversationId) +
        "&app_id=eq." + encodeURIComponent(appId) +
        "&owner_id=eq." + encodeURIComponent(ownerId) +
        "&role=in.(user,assistant)&order=created_at.desc,id.desc&limit=" + maxMessages
    }
  );
  if (messagesResult.status < 200 || messagesResult.status >= 300) {
    return { status: messagesResult.status, messages: [] };
  }

  const messages = Array.isArray(messagesResult.data)
    ? messagesResult.data
        .filter(item =>
          item?.conversation_id === conversationId &&
          item?.app_id === appId &&
          item?.owner_id === ownerId &&
          (item?.role === "user" || item?.role === "assistant") &&
          typeof item?.content === "string" && item.content.trim()
        )
        .slice(0, maxMessages)
        .reverse()
        .map(item => ({
          role: item.role,
          content: item.content.slice(0, 12000)
        }))
    : [];

  return { status: 200, messages };
}
