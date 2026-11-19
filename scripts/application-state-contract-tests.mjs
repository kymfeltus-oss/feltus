import assert from "node:assert/strict";
import {
  APPLICATION_STATE_CONTRACT,
  applicationStateHash,
  assertImmutableBlueprintUpdate,
  createBlueprintRevision,
  normalizeApplicationState,
  parseApplicationBlueprint,
  serializeApplicationBlueprint,
  validateBlueprintLineage
} from "../src/lib/feltus-application-state.js";

function sampleState() {
  return {
    application: { id: "app-1", name: "Customer Portal", type: "web_application", lifecycle_status: "configuring" },
    desired_state: {
      data: {
        models: [
          { id: "model-b", name: "tickets", fields: [{ name: "subject", type: "text", ordinal_position: 2 }, { name: "id", type: "uuid", ordinal_position: 1 }] },
          { id: "model-a", name: "customers", fields: [{ name: "email", type: "text", ordinal_position: 1 }] }
        ],
        relationships: [{ id: "rel-1", source_model_id: "model-b", source_field: "customer_id", target_model_id: "model-a", target_field: "id", on_delete: "SET NULL" }]
      },
      knowledge: { documents: [{ id: "doc-1", version: 1, sha256: "abc" }] },
      ai: { model: "local-model", context_permissions: { documents: false, app_data: true, conversation_history: false } },
      intelligence: {
        classification: {
          application_type: "web_application",
          label: "operations workspace",
          confidence: 0.87,
          archetypes: ["workflow-led", "data-backed"],
          business_models: ["subscription"],
          audiences: ["workspace members"],
          workflow_patterns: ["intake-review"]
        },
        capabilities: { data_models: true, ai_assistant: true },
        permissions: { ai_context: { app_data: true, documents: false } },
        repository: { source: "local", branch: "main" },
        environment_provider_state: [{ kind: "development", provider: null, status: "active" }]
      },
      code: { repository_id: "repo-1", branch: "main", commit_sha: "0123456789abcdef0123456789abcdef01234567" },
      environments: [
        { id: "env-prod", kind: "production", configured: false },
        { id: "env-dev", kind: "development", configured: true }
      ]
    },
    execution: { builds: [], artifacts: [], deployments: [] }
  };
}

function check(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

check("equivalent state normalizes object and unordered collection order", () => {
  const original = sampleState();
  const reordered = sampleState();
  reordered.application = Object.fromEntries(Object.entries(reordered.application).reverse());
  reordered.desired_state.data.models.reverse();
  reordered.desired_state.data.models[0].fields.reverse();
  reordered.desired_state.environments.reverse();
  assert.deepEqual(normalizeApplicationState(original), normalizeApplicationState(reordered));
});

check("equivalent state produces the same SHA-256 state identity", () => {
  const left = sampleState();
  const right = sampleState();
  right.desired_state.data.models.reverse();
  assert.equal(applicationStateHash(left), applicationStateHash(right));
  assert.match(applicationStateHash(left), /^[0-9a-f]{64}$/);
});

check("execution and observation changes do not rewrite desired blueprint identity", () => {
  const before = sampleState();
  const after = sampleState();
  after.execution.builds.push({ id: "build-1", commit_sha: "a".repeat(40) });
  after.observed_state = { health: "healthy", observed_at: "2026-01-01T00:00:00Z" };
  assert.equal(applicationStateHash(before), applicationStateHash(after));
});

check("changed meaningful configuration produces a different state identity", () => {
  const before = sampleState();
  const after = sampleState();
  after.desired_state.data.models[0].fields[0].type = "numeric";
  assert.notEqual(applicationStateHash(before), applicationStateHash(after));
});

check("deterministic YAML serialization is stable and round-trips the contract", () => {
  const revision = createBlueprintRevision({ state: sampleState(), blueprintId: "blueprint-1", createdBy: "user-1", createdAt: "2026-11-03T10:00:00Z" });
  const first = serializeApplicationBlueprint(revision);
  const second = serializeApplicationBlueprint(revision);
  assert.equal(first, second);
  assert.ok(first.startsWith("---\n"));
  assert.match(first, /^---\ncontract: "feltus\.application-state\/v1"/);
  assert.doesNotMatch(first, /^\{\s*"contract"/);
  assert.deepEqual(parseApplicationBlueprint(first), revision);
  assert.deepEqual(parseApplicationBlueprint(first).desired_state.intelligence, revision.desired_state.intelligence);
});

check("intelligence classification participates in canonical identity and normalizes taxonomy lists", () => {
  const state = sampleState();
  state.desired_state.intelligence.classification.archetypes = ["workflow-led", "data-backed", "workflow-led"];
  state.desired_state.intelligence.environment_provider_state.push(
    { kind: "production", provider: null, status: "not_configured" },
    { kind: "preview", provider: "local", status: "active" }
  );
  const normalized = normalizeApplicationState(state);
  assert.deepEqual(normalized.desired_state.intelligence.classification.archetypes, ["data-backed", "workflow-led"]);
  assert.deepEqual(normalized.desired_state.intelligence.environment_provider_state.map(item => item.kind), ["development", "preview", "production"]);
  const changed = structuredClone(state);
  changed.desired_state.intelligence.classification.audiences = ["external partners"];
  assert.notEqual(applicationStateHash(state), applicationStateHash(changed));
  assert.throws(() => normalizeApplicationState({
    ...state,
    desired_state: { ...state.desired_state, intelligence: [] }
  }), /intelligence must be an object/);
  const invalidConfidence = structuredClone(state);
  invalidConfidence.desired_state.intelligence.classification.confidence = 1.1;
  assert.throws(() => normalizeApplicationState(invalidConfidence), /confidence must be between 0 and 1/);
});

check("legacy v1 state without intelligence keeps its original canonical shape", () => {
  const state = sampleState();
  delete state.desired_state.intelligence;
  const legacyHash = applicationStateHash(state);
  const legacyRevision = createBlueprintRevision({ state, blueprintId: "legacy-blueprint", createdBy: "user-1", createdAt: "2026-11-03T10:00:00Z" });
  assert.equal(Object.hasOwn(normalizeApplicationState(state).desired_state, "intelligence"), false);
  assert.equal(legacyRevision.blueprint.state_hash, legacyHash, "new v1 normalization keeps legacy Blueprint hashes verifiable");
  assert.deepEqual(parseApplicationBlueprint(serializeApplicationBlueprint(legacyRevision)), legacyRevision);
});

check("secret values never enter canonical state", () => {
  const state = sampleState();
  state.desired_state.code.access_token = "do-not-persist";
  state.desired_state.intelligence.permissions.api_key = "do-not-persist-either";
  state.desired_state.ai.max_tokens = 2048;
  const normalized = normalizeApplicationState(state);
  assert.equal("access_token" in normalized.desired_state.code, false);
  assert.equal("api_key" in normalized.desired_state.intelligence.permissions, false);
  assert.equal(normalized.desired_state.ai.max_tokens, 2048);
});

check("saved blueprint hash must match its canonical desired state", () => {
  const revision = createBlueprintRevision({ state: sampleState(), blueprintId: "blueprint-hash", createdBy: "user-1", createdAt: "2026-11-03T10:00:00Z" });
  const changed = structuredClone(revision);
  changed.desired_state.ai.model = "tampered-model";
  assert.notEqual(applicationStateHash(changed), revision.blueprint.state_hash);
  assert.throws(() => normalizeApplicationState(changed), /does not match/);
});

check("blueprint version increments and retains its immediate parent", () => {
  const first = createBlueprintRevision({ state: sampleState(), blueprintId: "blueprint-1", createdBy: "user-1", createdAt: "2026-11-03T10:00:00Z" });
  const changed = sampleState();
  changed.desired_state.ai.model = "next-model";
  const second = createBlueprintRevision({ state: changed, parent: { id: first.blueprint.id, app_id: first.application.id, application: first.application, version: first.blueprint.version }, blueprintId: "blueprint-2", createdBy: "user-1", createdAt: "2026-11-03T11:00:00Z" });
  assert.equal(first.blueprint.version, 1);
  assert.equal(second.blueprint.version, 2);
  assert.equal(second.blueprint.parent_id, first.blueprint.id);
  assert.equal(second.blueprint.parent_version, first.blueprint.version);
  assert.equal(validateBlueprintLineage([second, first]), true);
});

check("unchanged desired state reuses its prior blueprint revision", () => {
  const first = createBlueprintRevision({ state: sampleState(), blueprintId: "blueprint-1", createdBy: "user-1", createdAt: "2026-11-03T10:00:00Z" });
  const same = createBlueprintRevision({ state: sampleState(), parent: first, blueprintId: "blueprint-2", createdBy: "user-1", createdAt: "2026-11-03T11:00:00Z" });
  assert.equal(same.blueprint.id, first.blueprint.id);
  assert.equal(same.blueprint.version, first.blueprint.version);
});

check("returning to an older semantic state creates a new chronological revision", () => {
  const originalState = sampleState();
  const first = createBlueprintRevision({ state: originalState, blueprintId: "blueprint-1", createdBy: "user-1", createdAt: "2026-11-03T10:00:00Z" });
  const changedState = sampleState();
  changedState.desired_state.ai.model = "changed-model";
  const second = createBlueprintRevision({ state: changedState, parent: first, blueprintId: "blueprint-2", createdBy: "user-1", createdAt: "2026-11-03T11:00:00Z" });
  const restored = createBlueprintRevision({ state: originalState, parent: second, blueprintId: "blueprint-3", createdBy: "user-1", createdAt: "2026-11-03T12:00:00Z" });
  assert.equal(restored.blueprint.version, 3);
  assert.equal(restored.blueprint.parent_id, second.blueprint.id);
  assert.equal(restored.blueprint.state_hash, first.blueprint.state_hash);
  assert.notEqual(restored.blueprint.id, first.blueprint.id);
  assert.equal(validateBlueprintLineage([first, second, restored]), true);
});

check("blueprint history rejects mutation of identity and state", () => {
  const first = createBlueprintRevision({ state: sampleState(), blueprintId: "blueprint-1", createdBy: "user-1", createdAt: "2026-11-03T10:00:00Z" });
  const mutated = structuredClone(first);
  mutated.desired_state.ai.model = "mutated-model";
  assert.throws(() => assertImmutableBlueprintUpdate(first, mutated), /immutable/);
});

check("lineage rejects missing or non-immediate parent", () => {
  const first = createBlueprintRevision({ state: sampleState(), blueprintId: "blueprint-1", createdBy: "user-1", createdAt: "2026-11-03T10:00:00Z" });
  const changed = sampleState();
  changed.desired_state.ai.model = "next-model";
  const second = createBlueprintRevision({ state: changed, parent: { id: first.blueprint.id, application: first.application, version: 1 }, blueprintId: "blueprint-2", createdBy: "user-1", createdAt: "2026-11-03T11:00:00Z" });
  const broken = structuredClone(second);
  broken.blueprint.parent_version = null;
  assert.throws(() => validateBlueprintLineage([first, broken]), /parent lineage/);
});

assert.equal(APPLICATION_STATE_CONTRACT, "feltus.application-state/v1");
