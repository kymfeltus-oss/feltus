const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED_COLUMN_NAMES = new Set(["id", "owner_id", "created_at"]);
const ALLOWED_COLUMN_TYPES = new Set([
  "text",
  "integer",
  "bigint",
  "numeric",
  "boolean",
  "date",
  "timestamptz",
  "uuid",
  "jsonb"
]);

function normalizeColumnType(value) {
  if (typeof value !== "string") return value;
  return value.trim().toLowerCase();
}

function normalizeColumns(columns) {
  if (!Array.isArray(columns)) return columns;
  return columns.map(column => column && typeof column === "object"
    ? { ...column, type: normalizeColumnType(column.type) }
    : column
  );
}

function validateColumns(columns) {
  if (!Array.isArray(columns) || columns.length > 50) {
    return "Columns must be an array with no more than 50 entries.";
  }

  const seen = new Set();
  for (const column of columns) {
    if (
      !column ||
      typeof column.name !== "string" ||
      !MODEL_NAME_PATTERN.test(column.name) ||
      !ALLOWED_COLUMN_TYPES.has(column.type) ||
      (column.nullable !== undefined && typeof column.nullable !== "boolean") ||
      RESERVED_COLUMN_NAMES.has(column.name)
    ) {
      return "Invalid column definition.";
    }
    if (seen.has(column.name)) return `The field name “${column.name}” is repeated.`;
    seen.add(column.name);
  }
  return null;
}

export async function handleDataModelApiRoute({ req, url, res, send, readBody, modelRequest, modelColumnsRequest, stateRequest, rpcRequest }) {
  if (url.pathname === "/api/models/field-impact" || url.pathname === "/api/models/deletion-impact") {
    if (req.method !== "GET") {
      send(res, 405, { error: "Method not allowed." });
      return true;
    }
    const appId = url.searchParams.get("app_id");
    const modelId = url.searchParams.get("model_id");
    if (!UUID_PATTERN.test(appId || "") || !UUID_PATTERN.test(modelId || "")) {
      send(res, 400, { error: "Valid application and model IDs required." });
      return true;
    }
    if (url.pathname === "/api/models/deletion-impact") {
      const result = await rpcRequest("feltus_model_deletion_impact", {
        p_app_id: appId,
        p_model_id: modelId
      });
      if (result.status < 200 || result.status >= 300) {
        const databaseCode = result.data?.code;
        const status = databaseCode === "42501" ? 403 : ["42P01", "23503", "2BP01"].includes(databaseCode) ? 409 : result.status;
        send(res, status, {
          error: databaseCode === "42501"
            ? "This category is unavailable or managed by FELTUS."
            : databaseCode === "42P01"
              ? "FELTUS could not verify this category’s saved structure. Refresh and try again."
              : "FELTUS could not check this category. Refresh and try again.",
          code: databaseCode || null
        });
        return true;
      }
      if (typeof stateRequest !== "function") {
        send(res, 502, { error: "The saved app state could not be checked." });
        return true;
      }
      const stateResult = await stateRequest(appId);
      const currentState = stateResult?.data?.state ? stateResult.data : stateResult?.data;
      const currentModels = currentState?.state?.desired_state?.data?.models;
      const currentStateHash = currentState?.state_hash;
      if (
        stateResult?.status < 200 || stateResult?.status >= 300 ||
        !Array.isArray(currentModels) || !currentStateHash
      ) {
        send(res, 502, { error: "FELTUS could not rebuild the saved app state for this preview." });
        return true;
      }
      if (!currentModels.some(model => model.id === modelId)) {
        send(res, 409, { error: "This category is not present in the saved app state." });
        return true;
      }
      send(res, result.status, {
        ...result.data,
        canonical_state_impact: {
          ...(result.data?.canonical_state_impact || {}),
          current_state_hash: currentStateHash,
          model_count_before: currentModels.length,
          model_count_after: currentModels.length - 1,
          model_removed_from_current_state: true,
          saved_blueprints_mutated: false
        }
      });
      return true;
    }

    const fieldName = url.searchParams.get("field_name");
    if (!fieldName || !MODEL_NAME_PATTERN.test(fieldName)) {
      send(res, 400, { error: "Valid field name required." });
      return true;
    }
    if (RESERVED_COLUMN_NAMES.has(fieldName)) {
      send(res, 400, { error: "FELTUS managed fields cannot be removed." });
      return true;
    }
    const result = await rpcRequest("feltus_model_field_deletion_impact", {
      p_app_id: appId,
      p_model_id: modelId,
      p_field_name: fieldName
    });
    if (result.status < 200 || result.status >= 300) {
      const databaseCode = result.data?.code;
      send(res, databaseCode === "42501" ? 403 : result.status, {
        error: result.data?.message || "FELTUS could not check this field.",
        code: databaseCode || null
      });
    } else {
      send(res, result.status, result.data);
    }
    return true;
  }

  if (url.pathname !== "/api/models") return false;

  if (req.method === "GET") {
    const appId = url.searchParams.get("app_id");
    if (!appId || !UUID_PATTERN.test(appId)) {
      send(res, 400, { error: "Valid application ID required." });
      return true;
    }
    const result = await modelRequest(appId);
    send(res, result.status, result.data);
    return true;
  }

  if (req.method === "POST" || req.method === "PATCH") {
    const body = await readBody(req);
    const appId = body.app_id;
    if (typeof appId !== "string" || !UUID_PATTERN.test(appId)) {
      send(res, 400, { error: "Valid application ID required." });
      return true;
    }

    const columns = normalizeColumns(body.columns);
    const columnError = validateColumns(columns);
    if (columnError) {
      send(res, 400, { error: columnError });
      return true;
    }

    if (req.method === "POST") {
      if (typeof body.table_name !== "string" || !MODEL_NAME_PATTERN.test(body.table_name)) {
        send(res, 400, { error: "Invalid table name." });
        return true;
      }
      const result = await rpcRequest("feltus_create_model", {
        p_app_id: appId,
        p_table_name: body.table_name,
        p_columns: columns,
        p_enable_rls: body.enable_rls !== false
      });
      send(res, result.status, result.data);
      return true;
    }

    if (typeof body.model_id !== "string" || !UUID_PATTERN.test(body.model_id)) {
      send(res, 400, { error: "Valid model ID required." });
      return true;
    }
    const result = await rpcRequest("feltus_update_model_schema", {
      p_app_id: appId,
      p_model_id: body.model_id,
      p_columns: columns
    });
    send(res, result.status, result.data);
    return true;
  }

  if (req.method === "DELETE") {
    const body = await readBody(req);
    const { app_id: appId, model_id: modelId, field_name: fieldName } = body || {};
    if (!UUID_PATTERN.test(appId || "") || !UUID_PATTERN.test(modelId || "")) {
      send(res, 400, { error: "Valid application and model IDs required." });
      return true;
    }
    if (!Object.hasOwn(body || {}, "field_name")) {
      if (body.confirm !== true) {
        send(res, 400, { error: "Confirm that you want to remove this category and its saved records." });
        return true;
      }
      const result = await rpcRequest("feltus_delete_model", {
        p_app_id: appId,
        p_model_id: modelId,
        p_confirm: true
      });
      if (result.status < 200 || result.status >= 300) {
        const databaseCode = result.data?.code;
        const status = databaseCode === "42501" ? 403 :
          ["23503", "2BP01", "42P01", "55000"].includes(databaseCode) ? 409 :
            databaseCode === "22023" ? 400 : result.status;
        send(res, status, {
          error: databaseCode === "42501"
            ? "This category is unavailable or managed by FELTUS."
            : ["23503", "2BP01"].includes(databaseCode)
              ? "This category still has a relationship or database dependency. Remove it first."
              : ["42P01", "55000"].includes(databaseCode)
                ? "FELTUS could not verify this category’s saved structure. Refresh and try again."
                : databaseCode === "22023"
                  ? "Please confirm before removing this category."
                  : "The category could not be removed. Please try again.",
          code: databaseCode || null
        });
        return true;
      }

      const [modelsResult, stateResult] = await Promise.all([
        modelRequest(appId),
        typeof stateRequest === "function"
          ? stateRequest(appId)
          : Promise.resolve({ status: 500, data: { error: "Application state could not be rebuilt." } })
      ]);
      const modelRows = Array.isArray(modelsResult?.data)
        ? modelsResult.data
        : Array.isArray(modelsResult?.data?.models) ? modelsResult.data.models : [];
      const currentState = stateResult.data;
      const currentModels = currentState?.state?.desired_state?.data?.models;
      if (
        modelsResult.status < 200 || modelsResult.status >= 300 ||
        stateResult.status < 200 || stateResult.status >= 300 ||
        modelRows.some(model => model.id === modelId) ||
        !Array.isArray(currentModels) || currentModels.some(model => model.id === modelId) ||
        !currentState?.state_hash
      ) {
        send(res, 502, {
          error: "The category was removed, but FELTUS could not confirm the refreshed app state. Refresh before continuing.",
          committed: true
        });
        return true;
      }
      send(res, 200, {
        ...result.data,
        state_hash: currentState.state_hash,
        state: currentState.state,
        persisted: true
      });
      return true;
    }
    if (typeof fieldName !== "string" || !MODEL_NAME_PATTERN.test(fieldName)) {
      send(res, 400, { error: "Valid custom field name required." });
      return true;
    }
    if (RESERVED_COLUMN_NAMES.has(fieldName)) {
      send(res, 400, { error: "FELTUS managed fields cannot be removed." });
      return true;
    }
    if (body.confirm !== true) {
      send(res, 400, { error: "Confirm that you want to remove this field." });
      return true;
    }

    const result = await rpcRequest("feltus_delete_model_field", {
      p_app_id: appId,
      p_model_id: modelId,
      p_field_name: fieldName,
      p_confirm: true
    });
    if (result.status < 200 || result.status >= 300) {
      const databaseCode = result.data?.code;
      const status = databaseCode === "42501" ? 403 : ["23503", "2BP01"].includes(databaseCode) ? 409 : result.status;
      send(res, status, {
        error: result.data?.message || "The field could not be removed.",
        code: databaseCode || null
      });
      return true;
    }

    const [modelsResult, columnsResult, stateResult] = await Promise.all([
      modelRequest(appId),
      typeof modelColumnsRequest === "function"
        ? modelColumnsRequest(modelId)
        : Promise.resolve({ status: 500, data: { error: "Model fields could not be reloaded." } }),
      typeof stateRequest === "function"
        ? stateRequest(appId)
        : Promise.resolve({ status: 500, data: { error: "Application state could not be rebuilt." } })
    ]);
    const modelRows = Array.isArray(modelsResult?.data)
      ? modelsResult.data
      : Array.isArray(modelsResult?.data?.models) ? modelsResult.data.models : [];
    const model = modelRows.find(item => item.id === modelId);
    const columns = Array.isArray(columnsResult?.data)
      ? columnsResult.data
      : Array.isArray(columnsResult?.data?.columns) ? columnsResult.data.columns : [];
    if (
      modelsResult.status < 200 || modelsResult.status >= 300 ||
      columnsResult.status < 200 || columnsResult.status >= 300 ||
      stateResult.status < 200 || stateResult.status >= 300 ||
      !model || columns.some(column => column.column_name === fieldName)
    ) {
      send(res, 502, {
        error: "The field was removed, but FELTUS could not confirm the refreshed application state. Refresh before continuing.",
        committed: true
      });
      return true;
    }
    const currentState = stateResult.data?.state ? stateResult.data : stateResult;
    send(res, 200, {
      deleted: true,
      model: { ...model, columns },
      impact: result.data?.impact || null,
      state_hash: currentState.state_hash || currentState.state?.blueprint?.state_hash || null,
      state: currentState.state || null,
      persisted: true
    });
    return true;
  }

  send(res, 405, { error: "Method not allowed." });
  return true;
}

export async function handleRelationshipDeletionApiRoute({ req, url, res, send, readBody, rpcRequest, tableRequest, stateRequest }) {
  if (!new Set(["/api/relationships/delete", "/api/relationships/deletion-impact"]).has(url.pathname)) return false;
  if (url.pathname.endsWith("deletion-impact")) {
    if (req.method !== "GET") {
      send(res, 405, { error: "Method not allowed." });
      return true;
    }
    const appId = url.searchParams.get("app_id");
    const relationshipId = url.searchParams.get("relationship_id");
    if (!UUID_PATTERN.test(appId || "") || !UUID_PATTERN.test(relationshipId || "")) {
      send(res, 400, { error: "Valid application and relationship IDs required." });
      return true;
    }
    const result = await rpcRequest("feltus_relationship_deletion_impact", {
      p_app_id: appId,
      p_relationship_id: relationshipId
    });
    if (result.status < 200 || result.status >= 300) {
      const databaseCode = result.data?.code;
      send(res, databaseCode === "42501" ? 403 : result.status, {
        error: result.data?.message || "FELTUS could not check this relationship.",
        code: databaseCode || null
      });
    } else {
      send(res, result.status, result.data);
    }
    return true;
  }

  if (req.method !== "POST") {
    send(res, 405, { error: "Method not allowed." });
    return true;
  }
  const body = await readBody(req);
  const appId = body?.app_id;
  const relationshipId = body?.relationship_id;
  if (!UUID_PATTERN.test(appId || "") || !UUID_PATTERN.test(relationshipId || "")) {
    send(res, 400, { error: "Valid application and relationship IDs required." });
    return true;
  }
  if (body.confirm !== true) {
    send(res, 400, { error: "Confirm that you want to remove this relationship." });
    return true;
  }

  const result = await rpcRequest("feltus_delete_relationship_confirmed", {
    p_app_id: appId,
    p_relationship_id: relationshipId,
    p_confirm: true
  });
  if (result.status < 200 || result.status >= 300) {
    const databaseCode = result.data?.code;
    const status = databaseCode === "42501" ? 403 : ["23503", "2BP01"].includes(databaseCode) ? 409 : result.status;
    send(res, status, {
      error: result.data?.message || "The relationship could not be removed.",
      code: databaseCode || null
    });
    return true;
  }

  const [registryResult, stateResult] = await Promise.all([
    tableRequest("feltus_model_relationships", "GET", {
      query: "?select=id&app_id=eq." + encodeURIComponent(appId) +
        "&id=eq." + encodeURIComponent(relationshipId) + "&limit=1"
    }),
    stateRequest(appId)
  ]);
  if (
    registryResult.status < 200 || registryResult.status >= 300 ||
    !Array.isArray(registryResult.data) || registryResult.data.some(row => row.id === relationshipId) ||
    stateResult.status < 200 || stateResult.status >= 300 || !stateResult.data?.state_hash
  ) {
    send(res, 502, {
      error: "The relationship was removed, but FELTUS could not confirm the refreshed application state. Refresh before continuing.",
      committed: true
    });
    return true;
  }
  send(res, 200, {
    ...result.data,
    state_hash: stateResult.data.state_hash,
    state: stateResult.data.state,
    persisted: true
  });
  return true;
}
