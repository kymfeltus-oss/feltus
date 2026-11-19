import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { handleDataModelApiRoute } from "../src/lib/feltus-data-model-api.js";

const appId = randomUUID();
const otherAppId = randomUUID();
const modelId = randomUUID();
const siblingModelId = randomUUID();
const otherAppModelId = randomUUID();
const physicalName = id => `fm_${id.replaceAll("-", "").slice(0, 8)}_records`;
const models = [
  { id: modelId, app_id: appId, logical_name: "records", physical_table_name: physicalName(modelId), rls_enabled: true },
  { id: siblingModelId, app_id: appId, logical_name: "notes", physical_table_name: physicalName(siblingModelId), rls_enabled: true },
  { id: otherAppModelId, app_id: otherAppId, logical_name: "records", physical_table_name: physicalName(otherAppModelId), rls_enabled: true }
];
const columns = [
  { id: randomUUID(), model_id: modelId, column_name: "label", data_type: "text", is_nullable: false, ordinal_position: 1 },
  { id: randomUUID(), model_id: modelId, column_name: "notes", data_type: "text", is_nullable: true, ordinal_position: 2 },
  { id: randomUUID(), model_id: siblingModelId, column_name: "body", data_type: "text", is_nullable: true, ordinal_position: 1 },
  { id: randomUUID(), model_id: otherAppModelId, column_name: "body", data_type: "text", is_nullable: true, ordinal_position: 1 }
];
const physicalTables = new Set(models.map(model => model.physical_table_name));
const relationships = [];
const rpcCalls = [];
const blueprint = Object.freeze({ id: randomUUID(), state_hash: "saved-blueprint-hash", state: Object.freeze({ version: 1 }) });
let failPhysicalDrop = false;
let failStateRead = false;

function currentState(forAppId) {
  const stateModels = models.filter(model => model.app_id === forAppId).map(model => ({
    id: model.id,
    name: model.logical_name,
    fields: columns.filter(column => column.model_id === model.id).map(column => ({
      id: column.id,
      name: column.column_name,
      data_type: column.data_type,
      nullable: column.is_nullable
    }))
  }));
  const state = { desired_state: { data: { models: stateModels } } };
  return {
    state_hash: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
    state
  };
}

function impactFor(app, target) {
  const related = relationships.filter(item => item.app_id === app &&
    (item.source_model_id === target.id || item.target_model_id === target.id));
  const inbound = related.filter(item => item.target_model_id === target.id);
  const outbound = related.filter(item => item.source_model_id === target.id);
  const blockers = related.length ? [{ kind: "relationships", count: related.length, message: "Remove the linked relationships first." }] : [];
  return {
    app_id: app,
    model_id: target.id,
    model_name: target.logical_name,
    physical_table: target.physical_table_name,
    registered_fields: columns.filter(item => item.model_id === target.id).map(item => ({
      name: item.column_name, data_type: item.data_type, nullable: item.is_nullable
    })),
    field_count: columns.filter(item => item.model_id === target.id).length,
    row_count: 2,
    inbound_relationships: inbound,
    outbound_relationships: outbound,
    foreign_key_constraints: related.map(item => ({ constraint_name: item.constraint_name, registered: true })),
    dependent_models: related.map(item => ({ model_id: item.source_model_id === target.id ? item.target_model_id : item.source_model_id })),
    dependent_database_objects: [],
    registry_mismatch: false,
    can_delete: blockers.length === 0,
    blockers,
    canonical_state_impact: { model_removed_from_current_state: true, saved_blueprints_mutated: false }
  };
}

async function rpcRequest(name, body) {
  rpcCalls.push({ name, body });
  if (![appId, otherAppId].includes(body.p_app_id)) return { status: 403, data: { code: "42501", message: "Application unavailable." } };
  if (name === "feltus_model_deletion_impact" || name === "feltus_delete_model") {
    const target = models.find(item => item.id === body.p_model_id && item.app_id === body.p_app_id);
    if (!target) return { status: 403, data: { code: "42501", message: "Application or model unavailable." } };
    if (target.physical_table_name !== physicalName(target.id)) {
      return { status: 403, data: { code: "42501", message: "Registered model does not map to its FELTUS-owned table." } };
    }
    if (name === "feltus_model_deletion_impact") return { status: 200, data: impactFor(body.p_app_id, target) };
    if (body.p_confirm !== true) return { status: 400, data: { code: "22023", message: "Explicit confirmation is required." } };
    const impact = impactFor(body.p_app_id, target);
    if (!impact.can_delete) return { status: 409, data: { code: "23503", message: "This category still has relationship dependencies." } };
    if (failPhysicalDrop) return { status: 409, data: { code: "2BP01", message: "A database object depends on this category." } };
    physicalTables.delete(target.physical_table_name);
    models.splice(models.indexOf(target), 1);
    for (let index = columns.length - 1; index >= 0; index -= 1) {
      if (columns[index].model_id === target.id) columns.splice(index, 1);
    }
    return { status: 200, data: {
      deleted: true,
      app_id: body.p_app_id,
      model_id: target.id,
      model_name: target.logical_name,
      deleted_fields: impact.field_count,
      deleted_rows: impact.row_count,
      impact
    } };
  }
  throw new Error(`Unexpected RPC ${name}`);
}

function makeResponse() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(value) { this.body = value ? JSON.parse(String(value)) : null; }
  };
}

async function invoke(method, pathname, body = {}) {
  const res = makeResponse();
  const handled = await handleDataModelApiRoute({
    req: { method },
    url: new URL(`http://model-delete.test${pathname}`),
    res,
    send(target, status, value) { target.writeHead(status); target.end(JSON.stringify(value)); },
    readBody: async () => body,
    modelRequest: async app => ({ status: 200, data: models.filter(model => model.app_id === app) }),
    stateRequest: async app => failStateRead
      ? { status: 503, data: { error: "State unavailable." } }
      : { status: 200, data: currentState(app) },
    rpcRequest
  });
  return { handled, status: res.status, body: res.body };
}

const beforeState = currentState(appId);
const preview = await invoke("GET", `/api/models/deletion-impact?app_id=${appId}&model_id=${modelId}`);
assert.equal(preview.status, 200);
assert.equal(preview.body.can_delete, true);
assert.equal(preview.body.model_name, "records");
assert.equal(preview.body.physical_table, physicalName(modelId));
assert.equal(preview.body.field_count, 2);
assert.deepEqual(preview.body.registered_fields.map(field => field.name), ["label", "notes"]);
assert.equal(preview.body.row_count, 2);
assert.equal(preview.body.canonical_state_impact.current_state_hash, beforeState.state_hash);
assert.equal(preview.body.canonical_state_impact.model_count_before, 2);
assert.equal(preview.body.canonical_state_impact.model_count_after, 1);
assert.equal(preview.body.canonical_state_impact.saved_blueprints_mutated, false);
assert.equal(rpcCalls.at(-1).name, "feltus_model_deletion_impact");

const invalidCalls = rpcCalls.length;
assert.equal((await invoke("GET", "/api/models/deletion-impact?app_id=bad&model_id=bad")).status, 400);
assert.equal((await invoke("POST", `/api/models/deletion-impact?app_id=${appId}&model_id=${modelId}`)).status, 405);
assert.equal(rpcCalls.length, invalidCalls, "malformed input and unsupported methods fail before the database call");
assert.equal((await invoke("GET", `/api/models/deletion-impact?app_id=${otherAppId}&model_id=${modelId}`)).status, 403,
  "an app cannot preview a model owned by another app");

const missingConfirmation = await invoke("DELETE", "/api/models", { app_id: appId, model_id: modelId });
assert.equal(missingConfirmation.status, 400);
assert.equal(models.some(model => model.id === modelId), true);

relationships.push({
  id: randomUUID(), app_id: appId, source_model_id: siblingModelId, source_model: "notes",
  source_field: "record_id", target_model_id: modelId, target_model: "records",
  target_field: "id", constraint_name: `feltus_fk_${randomUUID().replaceAll("-", "").slice(0, 12)}`
});
relationships.push({
  id: randomUUID(), app_id: appId, source_model_id: modelId, source_model: "records",
  source_field: "note_id", target_model_id: siblingModelId, target_model: "notes",
  target_field: "id", constraint_name: `feltus_fk_${randomUUID().replaceAll("-", "").slice(0, 12)}`
});
const blockedImpact = await invoke("GET", `/api/models/deletion-impact?app_id=${appId}&model_id=${modelId}`);
assert.equal(blockedImpact.status, 200);
assert.equal(blockedImpact.body.can_delete, false);
assert.equal(blockedImpact.body.inbound_relationships.length, 1);
assert.equal(blockedImpact.body.outbound_relationships.length, 1);
assert.equal(blockedImpact.body.dependent_models.length, 2);
const blockedDelete = await invoke("DELETE", "/api/models", { app_id: appId, model_id: modelId, confirm: true });
assert.equal(blockedDelete.status, 409);
assert.equal(physicalTables.has(physicalName(modelId)), true);
assert.equal(models.some(model => model.id === modelId), true);

relationships.length = 0; // Relationship removal is a separate Phase A operation.
const originalPhysicalName = models.find(model => model.id === modelId).physical_table_name;
models.find(model => model.id === modelId).physical_table_name = "fm_unrelated_table";
assert.equal((await invoke("GET", `/api/models/deletion-impact?app_id=${appId}&model_id=${modelId}`)).status, 403,
  "a tampered table mapping fails closed");
models.find(model => model.id === modelId).physical_table_name = originalPhysicalName;

failPhysicalDrop = true;
const beforeFailedDrop = currentState(appId);
const failedDrop = await invoke("DELETE", "/api/models", { app_id: appId, model_id: modelId, confirm: true });
assert.equal(failedDrop.status, 409);
assert.equal(physicalTables.has(physicalName(modelId)), true);
assert.equal(models.some(model => model.id === modelId), true);
assert.equal(columns.filter(column => column.model_id === modelId).length, 2);
assert.equal(currentState(appId).state_hash, beforeFailedDrop.state_hash,
  "a failed physical deletion leaves registry and canonical state unchanged");
failPhysicalDrop = false;

failStateRead = true;
assert.equal((await invoke("GET", `/api/models/deletion-impact?app_id=${appId}&model_id=${modelId}`)).status, 502,
  "an incomplete canonical impact preview fails closed");
failStateRead = false;

const savedBlueprintBefore = JSON.stringify(blueprint);
const stateBeforeDelete = currentState(appId);
const deleted = await invoke("DELETE", "/api/models", { app_id: appId, model_id: modelId, confirm: true });
assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
assert.equal(deleted.body.persisted, true);
assert.ok(deleted.body.state_hash);
assert.notEqual(deleted.body.state_hash, stateBeforeDelete.state_hash);
assert.equal(physicalTables.has(physicalName(modelId)), false);
assert.equal(models.some(model => model.id === modelId), false);
assert.equal(columns.some(column => column.model_id === modelId), false);
assert.equal(deleted.body.state.desired_state.data.models.some(model => model.id === modelId), false);
assert.equal(JSON.stringify(blueprint), savedBlueprintBefore, "saved Blueprints are not rewritten");
assert.equal(physicalTables.has(physicalName(siblingModelId)), true, "an unrelated category table remains intact");
assert.equal(models.some(model => model.id === siblingModelId), true, "an unrelated same-app model remains intact");
assert.equal(physicalTables.has(physicalName(otherAppModelId)), true, "another app's table remains intact");
assert.equal(models.some(model => model.id === otherAppModelId), true, "another app's model remains intact");
const duplicateDelete = await invoke("DELETE", "/api/models", { app_id: appId, model_id: modelId, confirm: true });
assert.equal(duplicateDelete.status, 403, "a repeated deletion fails safely after the model is gone");

const migration = readFileSync(new URL("../supabase/migrations/20261107030000_feltus_safe_model_deletion.sql", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
assert.match(migration, /feltus_model_deletion_impact/);
assert.match(migration, /feltus_delete_model/);
assert.match(migration, /auth\.uid\(\)/);
assert.match(migration, /a\.owner_id = v_owner/);
assert.match(migration, /DROP TABLE public\.%I/);
assert.doesNotMatch(migration, /DROP TABLE[^;]*CASCADE/i, "model deletion never uses CASCADE");
assert.match(serverSource, /model\.deleted/);
assert.match(serverSource, /model\.deletion_failed/);

process.stdout.write("PASS app-scoped model deletion preview, dependency blocking, confirmation, atomic failure handling, canonical state/hash refresh, Blueprint immutability, isolation, and audit mapping\n");
