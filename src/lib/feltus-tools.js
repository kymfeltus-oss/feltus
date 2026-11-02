export const BUILT_IN_TOOLS = Object.freeze([
  {
    key: "project.documents",
    name: "Project documents",
    description: "List authorized project document metadata.",
    requiredPermission: "read",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } }
    }
  },
  {
    key: "project.assets",
    name: "Project assets",
    description: "List authorized project asset metadata.",
    requiredPermission: "read",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } }
    }
  },
  {
    key: "runtime.status",
    name: "AI runtime status",
    description: "Inspect model runtime health without exposing runtime credentials.",
    requiredPermission: "read",
    inputSchema: { type: "object", properties: {} }
  }
]);

export function toolByKey(key) {
  return BUILT_IN_TOOLS.find(tool => tool.key === String(key || "").trim()) || null;
}

function safeLimit(input) {
  const value = Number(input?.limit || 25);
  return Number.isInteger(value) ? Math.min(Math.max(value, 1), 100) : 25;
}

export async function executeBuiltInTool(toolKey, input, {
  appId,
  tableRequest,
  runtimeStatus
}) {
  const tool = toolByKey(toolKey);
  if (!tool) {
    const error = new Error("Tool is not registered or enabled.");
    error.code = "FELTUS_TOOL_NOT_FOUND";
    throw error;
  }
  if (tool.key === "project.documents") {
    const result = await tableRequest("feltus_documents", "GET", {
      query:
        "?select=id,original_name,mime_type,size_bytes,processing_status,created_at" +
        "&app_id=eq." + encodeURIComponent(appId) +
        "&order=created_at.desc&limit=" + safeLimit(input)
    });
    if (result.status < 200 || result.status >= 300) throw new Error("Document query failed.");
    return { items: Array.isArray(result.data) ? result.data : [] };
  }
  if (tool.key === "project.assets") {
    const result = await tableRequest("user_assets", "GET", {
      query:
        "?select=id,asset_name,payload,created_at" +
        "&app_id=eq." + encodeURIComponent(appId) +
        "&order=created_at.desc&limit=" + safeLimit(input)
    });
    if (result.status < 200 || result.status >= 300) throw new Error("Asset query failed.");
    return { items: Array.isArray(result.data) ? result.data : [] };
  }
  if (tool.key === "runtime.status") {
    return runtimeStatus();
  }
  throw new Error("Tool handler is unavailable.");
}
