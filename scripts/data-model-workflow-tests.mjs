import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { handleDataModelApiRoute, handleRelationshipDeletionApiRoute } from "../src/lib/feltus-data-model-api.js";
import { createApplicationStateHandler } from "../src/lib/feltus-application-state-api.js";

const APP_ID = randomUUID();
const OTHER_APP_ID = randomUUID();
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHOPPERS_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRODUCTS_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RELATIONSHIP_ID = randomUUID();
const ownerApp = { id: APP_ID, owner_id: USER_ID, app_name: "RETAIL THERAPY", app_type: "web_application", environment: "development", setup_status: "configuring", setup_current_step: "data", setup_completed_steps: [], setup_data: {}, created_at: "2026-11-07T00:00:00.000Z" };
const models = [];
const modelColumns = [];
const relationships = [];
let rpcCalls = [];
let stateHandler = null;

const shoppers = [
  { name: "name", type: "text", nullable: true },
  { name: "email", type: "text", nullable: false },
  { name: "preferred_brands", type: "text", nullable: true },
  { name: "preferred_categories", type: "text", nullable: true },
  { name: "size_preferences", type: "text", nullable: true },
  { name: "budget_min", type: "numeric", nullable: true },
  { name: "budget_max", type: "numeric", nullable: true }
];
const products = [
  { name: "name", type: "text", nullable: false }, { name: "sku", type: "text", nullable: true },
  { name: "current_price", type: "numeric", nullable: false }, { name: "brand", type: "text", nullable: false },
  { name: "category", type: "text", nullable: true }, { name: "description", type: "text", nullable: true },
  { name: "retail_price", type: "numeric", nullable: true }, { name: "currency", type: "text", nullable: true },
  { name: "retailer", type: "text", nullable: false }, { name: "product_url", type: "text", nullable: false },
  { name: "image_url", type: "text", nullable: true }, { name: "availability", type: "text", nullable: true },
  { name: "color", type: "text", nullable: true }, { name: "size", type: "text", nullable: true },
  { name: "supplier_id", type: "uuid", nullable: true }
];

function columnsFromPayload(modelId, ownerId, columns) {
  return columns.map((column, index) => ({
    id: `${modelId.slice(0, 8)}-${String(index + 1).padStart(4, "0")}-4000-8000-${String(index + 1).padStart(12, "0")}`,
    model_id: modelId,
    owner_id: ownerId,
    column_name: column.name,
    data_type: column.type,
    is_nullable: column.nullable !== false,
    ordinal_position: index + 1
  }));
}

async function rpcRequest(name, body) {
  rpcCalls.push({ name, body });
  if (body.p_app_id !== APP_ID) return { status: 403, data: { message: "Application unavailable or not owned by current identity" } };
  if (name === "feltus_model_field_deletion_impact") {
    const model = models.find(item => item.id === body.p_model_id && item.app_id === body.p_app_id);
    const saved = modelColumns.find(item => item.model_id === body.p_model_id && item.column_name === body.p_field_name);
    if (!model || !saved) return { status: 403, data: { code: "42501", message: "Field unavailable" } };
    const dependencies = relationships.filter(item =>
      item.app_id === body.p_app_id && item.source_model_id === body.p_model_id && item.source_column === body.p_field_name
    ).map(item => ({ id: item.id, source_field: item.source_column, target_field: item.target_column }));
    return { status: 200, data: {
      app_id: body.p_app_id, model_id: model.id, model_name: model.logical_name,
      field_name: saved.column_name, physical_table: model.physical_table_name,
      affected_rows: 2, dependencies, can_delete: dependencies.length === 0,
      reversible: false, data_loss: true
    } };
  }
  if (name === "feltus_delete_model_field") {
    const model = models.find(item => item.id === body.p_model_id && item.app_id === body.p_app_id);
    const saved = modelColumns.find(item => item.model_id === body.p_model_id && item.column_name === body.p_field_name);
    if (!model || !saved) return { status: 403, data: { code: "42501", message: "Field unavailable" } };
    if (body.p_confirm !== true) return { status: 400, data: { code: "22023", message: "Confirmation required" } };
    if (relationships.some(item => item.app_id === body.p_app_id && item.source_model_id === body.p_model_id && item.source_column === body.p_field_name)) {
      return { status: 400, data: { code: "23503", message: "Remove relationship dependencies first" } };
    }
    modelColumns.splice(modelColumns.indexOf(saved), 1);
    return { status: 200, data: { deleted: true, impact: { field_name: body.p_field_name } } };
  }
  if (name === "feltus_relationship_deletion_impact") {
    const relationship = relationships.find(item => item.id === body.p_relationship_id && item.app_id === body.p_app_id);
    if (!relationship) return { status: 403, data: { code: "42501", message: "Relationship unavailable" } };
    return { status: 200, data: {
      app_id: body.p_app_id, relationship_id: relationship.id,
      source_model: "shoppers", source_field: relationship.source_column,
      target_model: "products", target_field: relationship.target_column,
      constraint_verified: true, can_delete: true, row_data_changed: false, reversible: true
    } };
  }
  if (name === "feltus_delete_relationship_confirmed") {
    const index = relationships.findIndex(item => item.id === body.p_relationship_id && item.app_id === body.p_app_id);
    if (index < 0) return { status: 403, data: { code: "42501", message: "Relationship unavailable" } };
    if (body.p_confirm !== true) return { status: 400, data: { code: "22023", message: "Confirmation required" } };
    relationships.splice(index, 1);
    return { status: 200, data: { deleted: true, app_id: body.p_app_id, relationship_id: body.p_relationship_id } };
  }
  if (name === "feltus_create_model") {
    const id = body.p_table_name === "shoppers" ? SHOPPERS_ID : PRODUCTS_ID;
    const model = { id, app_id: APP_ID, owner_id: USER_ID, logical_name: body.p_table_name, physical_table_name: `fm_${body.p_table_name}`, rls_enabled: body.p_enable_rls, created_at: "2026-11-07T00:01:00.000Z" };
    models.push(model);
    modelColumns.push(...columnsFromPayload(id, USER_ID, body.p_columns));
    return { status: 200, data: model };
  }
  if (name === "feltus_update_model_schema") {
    const model = models.find(item => item.id === body.p_model_id && item.app_id === body.p_app_id);
    if (!model) return { status: 403, data: { message: "Application or model unavailable to current identity" } };
    for (const column of body.p_columns) {
      const saved = modelColumns.find(item => item.model_id === model.id && item.column_name === column.name);
      if (saved) {
        if (saved.data_type !== column.type) return { status: 400, data: { message: "Changing the type of a saved field is not supported" } };
        saved.is_nullable = column.nullable !== false;
      } else {
        modelColumns.push(...columnsFromPayload(model.id, USER_ID, [column]).map((item, index) => ({ ...item, ordinal_position: modelColumns.filter(savedColumn => savedColumn.model_id === model.id).length + index + 1 })));
      }
    }
    return { status: 200, data: model };
  }
  throw new Error(`Unexpected database call ${name}`);
}

function response() {
  return {
    status: null,
    headers: {},
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(text) { this.body = text ? JSON.parse(String(text)) : null; }
  };
}

async function invoke(method, pathname, body = {}) {
  const res = response();
  const handled = await handleDataModelApiRoute({
    req: { method },
    url: new URL(`http://feltus.test${pathname}`),
    res,
    send: (target, status, payload) => {
      target.writeHead(status, { "Content-Type": "application/json" });
      target.end(JSON.stringify(payload));
    },
    readBody: async () => body,
    modelRequest: async appId => ({ status: 200, data: { models: models.filter(model => model.app_id === appId) } }),
    modelColumnsRequest: async modelId => ({ status: 200, data: modelColumns.filter(column => column.model_id === modelId) }),
    stateRequest: async appId => stateSnapshot(appId),
    rpcRequest
  });
  return { handled, status: res.status, body: res.body };
}

async function invokeRelationship(method, pathname, body = {}) {
  const res = response();
  const handled = await handleRelationshipDeletionApiRoute({
    req: { method },
    url: new URL(`http://feltus.test${pathname}`),
    res,
    send: (target, status, payload) => {
      target.writeHead(status, { "Content-Type": "application/json" });
      target.end(JSON.stringify(payload));
    },
    readBody: async () => body,
    rpcRequest,
    tableRequest: async (table, _method, options) => {
      if (table !== "feltus_model_relationships") throw new Error(`Unexpected table ${table}`);
      const app = new URLSearchParams(options.query.slice(1)).get("app_id")?.replace("eq.", "");
      const id = new URLSearchParams(options.query.slice(1)).get("id")?.replace("eq.", "");
      return { status: 200, data: relationships.filter(item => item.app_id === app && item.id === id).map(item => ({ id: item.id })) };
    },
    stateRequest: async appId => stateSnapshot(appId)
  });
  return { handled, status: res.status, body: res.body };
}

async function stateSnapshot(appId) {
  if (!stateHandler) return { status: 500, data: null };
  const result = response();
  await stateHandler({ method: "GET", headers: {} }, result, new URL(`http://feltus.test/api/apps/${appId}/state`));
  return { status: result.status, data: result.body };
}

assert.equal((await invoke("POST", "/api/models", { app_id: APP_ID, table_name: "shoppers", columns: shoppers, enable_rls: true })).status, 200);
assert.equal(rpcCalls[0].name, "feltus_create_model", "new categories use the existing authoritative create RPC");
assert.deepEqual(rpcCalls[0].body.p_columns, shoppers, "the valid field payload reaches the persistence operation unchanged");
assert.equal(models.length, 1, "the shoppers model persists");
assert.deepEqual(modelColumns.filter(column => column.model_id === SHOPPERS_ID).map(column => [column.column_name, column.data_type, column.is_nullable]), shoppers.map(column => [column.name, column.type, column.nullable]));

assert.equal((await invoke("POST", "/api/models", { app_id: APP_ID, table_name: "products", columns: products, enable_rls: true })).status, 200);
assert.equal(models.length, 2, "a second model persists alongside shoppers");
assert.deepEqual(models.map(model => model.logical_name), ["shoppers", "products"]);
assert.equal(modelColumns.filter(column => column.model_id === PRODUCTS_ID).length, products.length);

const edit = await invoke("PATCH", "/api/models", {
  app_id: APP_ID,
  model_id: SHOPPERS_ID,
  columns: [...shoppers, { name: "loyalty_note", type: "text", nullable: true }]
});
assert.equal(edit.status, 200, "the existing model edit route succeeds");
assert.equal(rpcCalls.at(-1).name, "feltus_update_model_schema", "edits use a scoped database schema operation");
assert.equal(modelColumns.filter(column => column.model_id === SHOPPERS_ID).length, shoppers.length + 1);
assert.deepEqual(modelColumns.filter(column => column.model_id === SHOPPERS_ID && column.column_name !== "loyalty_note").map(column => column.column_name), shoppers.map(column => column.name), "editing adds fields without removing saved fields");
const normalizedTypeEdit = await invoke("PATCH", "/api/models", {
  app_id: APP_ID,
  model_id: SHOPPERS_ID,
  columns: [...shoppers, { name: "loyalty_note", type: "text", nullable: true }, { name: "lifetime_value", type: " NUMERIC ", nullable: true }]
});
assert.equal(normalizedTypeEdit.status, 200);
assert.equal(rpcCalls.at(-1).body.p_columns.at(-1).type, "numeric", "write-side column types are explicitly cast to canonical strings");

const unauthorizedBefore = models.length;
const unauthorized = await invoke("POST", "/api/models", { app_id: OTHER_APP_ID, table_name: "shoppers", columns: shoppers });
assert.equal(unauthorized.status, 403, "writes for an app outside the current owner scope are rejected");
assert.equal(models.length, unauthorizedBefore, "unauthorized writes do not persist a model");

const callCountBeforeInvalid = rpcCalls.length;
assert.equal((await invoke("POST", "/api/models", { app_id: APP_ID, table_name: "invalid-name", columns: shoppers })).status, 400);
assert.equal((await invoke("POST", "/api/models", { app_id: APP_ID, table_name: "bad", columns: [{ name: "id", type: "uuid", nullable: false }] })).status, 400);
assert.equal((await invoke("POST", "/api/models", { app_id: APP_ID, table_name: "bad", columns: [{ name: "email", type: "text" }, { name: "email", type: "text" }] })).status, 400);
assert.equal(rpcCalls.length, callCountBeforeInvalid, "invalid inputs fail before the database write");

const supplierIdColumn = modelColumns.find(column => column.model_id === PRODUCTS_ID && column.column_name === "supplier_id");
supplierIdColumn.type = supplierIdColumn.data_type;
delete supplierIdColumn.data_type;
const currentPriceColumn = modelColumns.find(column => column.model_id === PRODUCTS_ID && column.column_name === "current_price");
currentPriceColumn.type = currentPriceColumn.data_type;
delete currentPriceColumn.data_type;
for (const [name, dataType] of [["retail_price", "decimal"], ["sku", "character varying"], ["currency", "varchar"]]) {
  modelColumns.find(column => column.model_id === PRODUCTS_ID && column.column_name === name).data_type = dataType;
}
const appRows = [ownerApp];
const tableRows = {
  feltus_applications: appRows,
  feltus_models: models,
  feltus_model_columns: modelColumns,
  feltus_model_relationships: relationships
};
stateHandler = createApplicationStateHandler({
  tableRequest: async table => ({ status: 200, data: tableRows[table] || [] }),
  serviceRequest: async () => ({ status: 200, data: [] }),
  readBody: async req => req.body || {},
  getUser: () => ({ id: USER_ID })
});
const stateResponse = response();
const stateHandled = await stateHandler({ method: "GET", headers: {} }, stateResponse, new URL(`http://feltus.test/api/apps/${APP_ID}/state`));
assert.equal(stateHandled, true);
assert.equal(stateResponse.status, 200);
const persistedModels = stateResponse.body.state.desired_state.data.models;
assert.deepEqual(persistedModels.map(model => model.name), ["shoppers", "products"], "application state contains the saved models");
assert.equal(persistedModels.find(model => model.name === "shoppers").fields.find(field => field.name === "loyalty_note").nullable, true, "state reflects a saved schema edit");
const productFields = persistedModels.find(model => model.name === "products").fields;
assert.equal(productFields.find(field => field.name === "current_price").data_type, "numeric", "numeric types survive blueprint reconstruction");
assert.equal(productFields.find(field => field.name === "retail_price").data_type, "decimal", "decimal types are retained during reconstruction");
assert.equal(productFields.find(field => field.name === "sku").data_type, "character varying", "character varying types are retained during reconstruction");
assert.equal(productFields.find(field => field.name === "currency").data_type, "varchar", "varchar types are retained during reconstruction");
assert.equal(productFields.find(field => field.name === "supplier_id").data_type, "uuid", "UUID types survive blueprint reconstruction");

const modelList = await invoke("GET", `/api/models?app_id=${APP_ID}`);
assert.deepEqual(modelList.body.models.map(model => model.logical_name), ["shoppers", "products"]);

const beforeDeleteState = await stateSnapshot(APP_ID);
const hashBeforeFieldDelete = beforeDeleteState.data.state_hash;
const protectedCallsBefore = rpcCalls.length;
assert.equal((await invoke("GET", `/api/models/field-impact?app_id=${APP_ID}&model_id=${SHOPPERS_ID}&field_name=id`)).status, 400,
  "platform-managed fields are rejected before the database operation");
assert.equal(rpcCalls.length, protectedCallsBefore, "protected-field rejection does not call the deletion RPC");
assert.equal((await invoke("DELETE", "/api/models", {
  app_id: APP_ID, model_id: SHOPPERS_ID, field_name: "owner_id", confirm: true
})).status, 400, "system fields cannot be deleted even when the caller confirms");

relationships.push({
  id: RELATIONSHIP_ID, app_id: APP_ID, owner_id: USER_ID,
  source_model_id: SHOPPERS_ID, source_column: "loyalty_note",
  target_model_id: PRODUCTS_ID, target_column: "id", constraint_name: `feltus_fk_${RELATIONSHIP_ID.replaceAll("-", "")}`
});
const linkedFieldImpact = await invoke("GET", `/api/models/field-impact?app_id=${APP_ID}&model_id=${SHOPPERS_ID}&field_name=loyalty_note`);
assert.equal(linkedFieldImpact.status, 200);
assert.equal(linkedFieldImpact.body.can_delete, false, "a custom field with an active relationship is blocked in the impact preview");
assert.equal(linkedFieldImpact.body.dependencies.length, 1);
const linkedFieldDelete = await invoke("DELETE", "/api/models", {
  app_id: APP_ID, model_id: SHOPPERS_ID, field_name: "loyalty_note", confirm: true
});
assert.equal(linkedFieldDelete.status, 409, "the database rechecks and rejects a field with a relationship dependency");
assert.ok(modelColumns.some(column => column.model_id === SHOPPERS_ID && column.column_name === "loyalty_note"),
  "a blocked physical deletion leaves field metadata intact");

const impactRelation = await invokeRelationship("GET", `/api/relationships/deletion-impact?app_id=${APP_ID}&relationship_id=${RELATIONSHIP_ID}`);
assert.equal(impactRelation.status, 200);
assert.equal(impactRelation.body.constraint_verified, true);
const missingConfirm = await invokeRelationship("POST", "/api/relationships/delete", {
  app_id: APP_ID, relationship_id: RELATIONSHIP_ID
});
assert.equal(missingConfirm.status, 400, "relationship deletion requires an explicit confirmation flag");
const unauthorizedRelationship = await invokeRelationship("POST", "/api/relationships/delete", {
  app_id: OTHER_APP_ID, relationship_id: RELATIONSHIP_ID, confirm: true
});
assert.equal(unauthorizedRelationship.status, 403, "cross-project relationship deletion is rejected");
const removedRelationship = await invokeRelationship("POST", "/api/relationships/delete", {
  app_id: APP_ID, relationship_id: RELATIONSHIP_ID, confirm: true
});
assert.equal(removedRelationship.status, 200);
assert.equal(removedRelationship.body.persisted, true);
assert.ok(removedRelationship.body.state_hash);
assert.equal(relationships.some(item => item.id === RELATIONSHIP_ID), false, "relationship registry is empty after confirmed removal");

const fieldPreview = await invoke("GET", `/api/models/field-impact?app_id=${APP_ID}&model_id=${SHOPPERS_ID}&field_name=loyalty_note`);
assert.equal(fieldPreview.status, 200);
assert.equal(fieldPreview.body.can_delete, true);
assert.equal(fieldPreview.body.affected_rows, 2);
assert.equal(fieldPreview.body.reversible, false, "field impact warns that field values are permanently lost");
const missingFieldConfirm = await invoke("DELETE", "/api/models", {
  app_id: APP_ID, model_id: SHOPPERS_ID, field_name: "loyalty_note"
});
assert.equal(missingFieldConfirm.status, 400, "field deletion requires explicit confirmation");
const crossProjectFieldDelete = await invoke("DELETE", "/api/models", {
  app_id: OTHER_APP_ID, model_id: SHOPPERS_ID, field_name: "loyalty_note", confirm: true
});
assert.equal(crossProjectFieldDelete.status, 403, "cross-project field deletion is rejected");
const fieldDelete = await invoke("DELETE", "/api/models", {
  app_id: APP_ID, model_id: SHOPPERS_ID, field_name: "loyalty_note", confirm: true
});
assert.equal(fieldDelete.status, 200);
assert.equal(fieldDelete.body.persisted, true, "field removal is verified by reloading the model columns");
assert.ok(fieldDelete.body.state_hash);
assert.notEqual(fieldDelete.body.state_hash, hashBeforeFieldDelete, "the canonical application-state hash changes after the saved schema changes");
assert.equal(fieldDelete.body.model.columns.some(column => column.column_name === "loyalty_note"), false,
  "the server reload confirms that the removed field is gone");
assert.equal(fieldDelete.body.state.desired_state.data.models.find(model => model.name === "shoppers").fields.some(field => field.name === "loyalty_note"), false,
  "canonical desired state no longer includes the removed field");
assert.equal(modelColumns.some(column => column.model_id === SHOPPERS_ID && column.column_name === "loyalty_note"), false,
  "field registry state matches the successful physical deletion");
assert.equal(rpcCalls.at(-1).name, "feltus_delete_model_field");
assert.equal(rpcCalls.at(-1).body.p_confirm, true);

const routeSource = readFileSync(new URL("../src/lib/feltus-data-model-api.js", import.meta.url), "utf8");
const createMigration = readFileSync(new URL("../supabase/migrations/20261025193000_fix_model_creation_order.sql", import.meta.url), "utf8");
const updateMigration = readFileSync(new URL("../supabase/migrations/20261107010000_feltus_update_model_schema.sql", import.meta.url), "utf8");
const deletionMigration = readFileSync(new URL("../supabase/migrations/20261107020000_feltus_safe_schema_deletion.sql", import.meta.url), "utf8");
assert.match(routeSource, /req\.method === "PATCH"/);
assert.match(routeSource, /feltus_update_model_schema/);
assert.match(createMigration, /auth\.uid\(\)/);
assert.match(createMigration, /owner_id = v_owner/);
assert.match(updateMigration, /a\.owner_id = v_owner/);
assert.match(updateMigration, /m\.app_id = p_app_id/);
assert.match(updateMigration, /m\.owner_id = v_owner/);
assert.match(updateMigration, /Changing the type of a saved field is not supported/);
assert.match(updateMigration, /New fields must be optional when this category already has saved rows/);
assert.doesNotMatch(updateMigration, /DROP COLUMN|TRUNCATE|DELETE FROM public\.feltus_model_columns/i);
assert.match(routeSource, /feltus_delete_model_field/);
assert.match(routeSource, /feltus_model_field_deletion_impact/);
assert.match(routeSource, /modelColumnsRequest\(modelId\)/);
assert.match(deletionMigration, /ALTER TABLE public\.%I DROP COLUMN %I/);
assert.match(deletionMigration, /p_confirm BOOLEAN/);
assert.match(deletionMigration, /a\.owner_id = v_owner/);
assert.match(deletionMigration, /DROP CONSTRAINT %I/);
assert.doesNotMatch(deletionMigration, /DROP COLUMN[^;]*CASCADE|DROP CONSTRAINT[^;]*CASCADE/i,
  "field and relationship deletion never use broad CASCADE behavior");

process.stdout.write("PASS Data page model create/edit/delete routes, app ownership, relationship safeguards, persisted state/hash reconstruction, multi-model saves, and fail-closed validation\n");
