import { createHash, randomUUID } from "node:crypto";

export const APPLICATION_STATE_CONTRACT = "feltus.application-state/v1";
export const BLUEPRINT_STATUSES = Object.freeze(["draft", "ready", "building", "deployed", "superseded", "archived"]);
export const DELTA_STATUSES = Object.freeze(["changed", "added", "removed", "unknown"]);
export const ENVIRONMENT_ORDER = Object.freeze(["development", "preview", "staging", "production"]);
export const APPLICATION_LIFECYCLE_STATUSES = Object.freeze(["draft", "configuring", "active", "archived"]);

const SENSITIVE_KEY = /(secret|password|credential|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token)/i;

function requireText(value, path) {
  if (typeof value !== "string" || !value.length) throw new TypeError(`${path} must be a non-empty string.`);
  return value.normalize("NFC");
}

function nullableText(value) {
  return value === null || value === undefined || value === "" ? null : String(value).normalize("NFC");
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("Timestamp fields must use a valid ISO 8601 date.");
  return parsed.toISOString();
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return value.normalize("NFC");
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    throw new TypeError("Application state must contain JSON values only.");
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (SENSITIVE_KEY.test(key) && !/^max[_-]?tokens$/i.test(key)) continue;
    result[key.normalize("NFC")] = scrub(value[key]);
  }
  return result;
}

function recordKey(value) {
  if (value?.id) return String(value.id);
  return [value?.source_model_id, value?.source_field, value?.target_model_id, value?.target_field].map(item => item || "").join("\u0000");
}

function sortRecords(values, compare = (a, b) => recordKey(a).localeCompare(recordKey(b))) {
  if (!Array.isArray(values)) throw new TypeError("State collections must be arrays.");
  return values.map(scrub).sort(compare);
}

function normalizeDesiredState(value = {}) {
  const data = value.data || {};
  const knowledge = value.knowledge || {};
  const ai = value.ai || {};
  const code = value.code || {};
  const environmentRank = new Map(ENVIRONMENT_ORDER.map((name, index) => [name, index]));
  const environments = sortRecords(value.environments || [], (a, b) =>
    (environmentRank.get(a.kind) ?? ENVIRONMENT_ORDER.length) - (environmentRank.get(b.kind) ?? ENVIRONMENT_ORDER.length) || recordKey(a).localeCompare(recordKey(b))
  );
  const models = sortRecords(data.models || [], (a, b) => String(a.id || a.name || "").localeCompare(String(b.id || b.name || "")));
  for (const model of models) {
    if (Array.isArray(model.fields)) {
      model.fields = sortRecords(model.fields, (a, b) =>
        Number(a.ordinal_position || 0) - Number(b.ordinal_position || 0) || String(a.name || "").localeCompare(String(b.name || ""))
      );
    }
  }
  return scrub({
    data: {
      models,
      relationships: sortRecords(data.relationships || [], (a, b) => recordKey(a).localeCompare(recordKey(b)))
    },
    knowledge: { documents: sortRecords(knowledge.documents || [], (a, b) =>
      String(a.id || "").localeCompare(String(b.id || "")) || Number(a.version || 0) - Number(b.version || 0)
    ) },
    ai: scrub(ai),
    code: scrub(code),
    environments
  });
}

function normalizeExecution(value = {}) {
  const sortById = (a, b) => recordKey(a).localeCompare(recordKey(b));
  return scrub({
    builds: sortRecords(value.builds || [], sortById),
    artifacts: sortRecords(value.artifacts || [], sortById),
    deployments: sortRecords(value.deployments || [], sortById)
  });
}

function normalizeObservedState(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return sortRecords(value, (a, b) =>
    String(a.observed_at || "").localeCompare(String(b.observed_at || "")) || recordKey(a).localeCompare(recordKey(b))
  );
  return scrub(value);
}

export function normalizeApplicationState(input, { verifyStateHash = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Application state must be an object.");
  if (input.contract && input.contract !== APPLICATION_STATE_CONTRACT) throw new TypeError(`Unsupported state contract: ${input.contract}.`);
  const app = input.application || {};
  const blueprint = input.blueprint || {};
  const status = nullableText(blueprint.status) || "draft";
  if (!BLUEPRINT_STATUSES.includes(status)) throw new TypeError(`Unsupported blueprint status: ${status}.`);
  const lifecycleStatus = requireText(app.lifecycle_status, "application.lifecycle_status");
  if (!APPLICATION_LIFECYCLE_STATUSES.includes(lifecycleStatus)) throw new TypeError(`Unsupported application lifecycle status: ${lifecycleStatus}.`);
  const version = blueprint.version === null || blueprint.version === undefined ? null : Number(blueprint.version);
  const parentVersion = blueprint.parent_version === null || blueprint.parent_version === undefined ? null : Number(blueprint.parent_version);
  if (version !== null && (!Number.isInteger(version) || version < 1)) throw new TypeError("Blueprint version must be a positive integer or null.");
  if (parentVersion !== null && (!Number.isInteger(parentVersion) || parentVersion < 1 || (version !== null && parentVersion >= version))) {
    throw new TypeError("Parent blueprint version must be a positive integer lower than its child version.");
  }

  const state = {
    contract: APPLICATION_STATE_CONTRACT,
    application: {
      id: requireText(app.id, "application.id"),
      name: requireText(app.name, "application.name"),
      type: requireText(app.type, "application.type"),
      lifecycle_status: lifecycleStatus
    },
    blueprint: {
      id: nullableText(blueprint.id),
      version,
      parent_id: nullableText(blueprint.parent_id),
      parent_version: parentVersion,
      status,
      created_by: nullableText(blueprint.created_by),
      created_at: normalizeTimestamp(blueprint.created_at),
      state_hash: nullableText(blueprint.state_hash),
      source_commit: nullableText(blueprint.source_commit)
    },
    desired_state: normalizeDesiredState(input.desired_state || {}),
    execution: normalizeExecution(input.execution || {}),
    observed_state: normalizeObservedState(input.observed_state)
  };
  const expectedHash = createHash("sha256").update(canonicalJson({
    contract: state.contract,
    application: state.application,
    desired_state: state.desired_state
  }), "utf8").digest("hex");
  if (verifyStateHash && state.blueprint.state_hash && !/^[0-9a-f]{64}$/.test(state.blueprint.state_hash)) {
    throw new TypeError("Blueprint state hash must be a 64-character lowercase SHA-256 value.");
  }
  if (verifyStateHash && state.blueprint.state_hash && state.blueprint.state_hash !== expectedHash) {
    throw new TypeError("Blueprint state hash does not match its canonical desired state.");
  }
  return scrub(state);
}

export function canonicalJson(value) {
  return JSON.stringify(scrub(value));
}

export function applicationStateIdentity(state) {
  const normalized = normalizeApplicationState(state, { verifyStateHash: false });
  return scrub({
    contract: normalized.contract,
    application: normalized.application,
    desired_state: normalized.desired_state
  });
}

export function applicationStateHash(state) {
  return createHash("sha256").update(canonicalJson(applicationStateIdentity(state)), "utf8").digest("hex");
}

export function createBlueprintRevision({ state, parent = null, blueprintId = randomUUID(), createdBy = null, createdAt = new Date().toISOString(), status = "ready" }) {
  const normalized = normalizeApplicationState(state, { verifyStateHash: false });
  const parentRecord = parent?.blueprint || parent;
  const parentAppId = parent?.application?.id || parent?.app_id;
  if (parent && parentAppId !== normalized.application.id) throw new TypeError("Parent blueprint belongs to another application.");
  if (parent && !Number.isInteger(Number(parentRecord?.version))) throw new TypeError("Parent blueprint version is invalid.");
  if (!BLUEPRINT_STATUSES.includes(status)) throw new TypeError(`Unsupported blueprint status: ${status}.`);
  const stateHash = applicationStateHash(normalized);
  if (parent && parentRecord.state_hash === stateHash) {
    return normalizeApplicationState({
      ...normalized,
      blueprint: {
        ...normalized.blueprint,
        id: parentRecord.id,
        version: Number(parentRecord.version),
        parent_id: parentRecord.parent_id || parentRecord.parent_blueprint_id || null,
        parent_version: parentRecord.parent_version ?? null,
        status: parentRecord.status || "ready",
        created_by: parentRecord.created_by || null,
        created_at: parentRecord.created_at || null,
        state_hash: parentRecord.state_hash,
        source_commit: parentRecord.source_commit || null
      }
    });
  }
  const version = parent ? Number(parentRecord.version) + 1 : 1;
  const parentId = parentRecord?.id || null;
  const parentVersion = parent ? Number(parentRecord.version) : null;
  const revisionState = normalizeApplicationState({
    ...normalized,
    blueprint: {
      ...normalized.blueprint,
      id: blueprintId,
      version,
      parent_id: parentId,
      parent_version: parentVersion,
      status,
      created_by: createdBy,
      created_at: createdAt,
      state_hash: null
    }
  });
  revisionState.blueprint.state_hash = stateHash;
  return revisionState;
}

export function assertImmutableBlueprintUpdate(previous, next) {
  const immutableFields = ["id", "application", "version", "parent_id", "parent_version", "created_by", "created_at", "state_hash", "source_commit"];
  for (const field of immutableFields) {
    if (canonicalJson(previous?.[field] ?? null) !== canonicalJson(next?.[field] ?? null)) {
      throw new TypeError(`Blueprint field “${field}” is immutable.`);
    }
  }
  if (canonicalJson(previous?.desired_state) !== canonicalJson(next?.desired_state)) throw new TypeError("Blueprint desired state is immutable.");
  if (canonicalJson(previous?.execution) !== canonicalJson(next?.execution)) throw new TypeError("Blueprint execution lineage is immutable.");
  return true;
}

export function validateBlueprintLineage(blueprints) {
  if (!Array.isArray(blueprints)) throw new TypeError("Blueprint history must be an array.");
  const byId = new Map();
  const versions = new Set();
  for (const blueprint of blueprints) {
    const normalized = normalizeApplicationState(blueprint);
    if (!normalized.blueprint.id) throw new TypeError("Persisted blueprints require a stable ID.");
    const appId = normalized.application.id;
    const key = `${appId}:${normalized.blueprint.version}`;
    if (versions.has(key)) throw new TypeError("Blueprint versions must be unique per application.");
    versions.add(key);
    if (byId.has(normalized.blueprint.id)) throw new TypeError("Blueprint IDs must be unique.");
    byId.set(normalized.blueprint.id, normalized);
  }
  for (const blueprint of byId.values()) {
    const { id, version, parent_id: parentId, parent_version: parentVersion } = blueprint.blueprint;
    if (version === null) throw new TypeError("Persisted blueprints require a version.");
    if (version === 1 && (parentId !== null || parentVersion !== null)) throw new TypeError("The first blueprint cannot have a parent.");
    if (version > 1) {
      const parent = byId.get(parentId);
      if (!parent || parent.application.id !== blueprint.application.id || parent.blueprint.version !== parentVersion || parentVersion !== version - 1) {
        throw new TypeError(`Blueprint ${id} has invalid parent lineage.`);
      }
    }
  }
  return true;
}

function yamlKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

function yamlScalar(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  throw new TypeError("YAML scalar values must be strings, numbers, booleans, or null.");
}

function yamlPair(key, value, indent, prefix = "") {
  const head = `${" ".repeat(indent)}${prefix}${yamlKey(key)}:`;
  if (Array.isArray(value) || (value && typeof value === "object")) {
    if (!Object.keys(value).length) return `${head} ${Array.isArray(value) ? "[]" : "{}"}`;
    return `${head}\n${yamlBlock(value, indent + (prefix ? 4 : 2))}`;
  }
  return `${head} ${yamlScalar(value)}`;
}

function yamlBlock(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value.map(item => {
      if (Array.isArray(item)) return `${pad}-\n${yamlBlock(item, indent + 2)}`;
      if (item && typeof item === "object") {
        const entries = Object.entries(item);
        if (!entries.length) return `${pad}- {}`;
        const [firstKey, firstValue] = entries[0];
        const first = yamlPair(firstKey, firstValue, indent, "- ");
        const rest = entries.slice(1).map(([key, child]) => yamlPair(key, child, indent + 2));
        return [first, ...rest].join("\n");
      }
      return `${pad}- ${yamlScalar(item)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return `${pad}{}`;
    return entries.map(([key, child]) => yamlPair(key, child, indent)).join("\n");
  }
  return `${pad}${yamlScalar(value)}`;
}

function splitYamlPair(text) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ":" && !quoted) {
      const rawKey = text.slice(0, index).trim();
      const key = rawKey.startsWith('"') ? JSON.parse(rawKey) : rawKey;
      return [key, text.slice(index + 1).trim()];
    }
  }
  throw new TypeError("Invalid application Blueprint YAML mapping.");
}

function parseYamlScalar(value) {
  if (value === "{}") return {};
  if (value === "[]") return [];
  if (value.startsWith('"')) return JSON.parse(value);
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseYamlBlock(lines, cursor, indent) {
  const isSequence = lines[cursor]?.indent === indent && lines[cursor].text.startsWith("- ");
  if (isSequence) {
    const result = [];
    while (cursor < lines.length && lines[cursor].indent === indent && lines[cursor].text.startsWith("- ")) {
      const body = lines[cursor].text.slice(2).trim();
      cursor += 1;
      if (!body) {
        const [value, next] = parseYamlBlock(lines, cursor, lines[cursor].indent);
        result.push(value); cursor = next; continue;
      }
      if (body === "{}" || body === "[]" || !/^[^"].*?:/.test(body)) {
        result.push(parseYamlScalar(body));
        continue;
      }
      const [key, rawValue] = splitYamlPair(body);
      const item = {};
      if (rawValue) item[key] = parseYamlScalar(rawValue);
      else if (lines[cursor]?.indent > indent + 2) {
        const [child, next] = parseYamlBlock(lines, cursor, lines[cursor].indent);
        item[key] = child; cursor = next;
      } else item[key] = {};
      while (cursor < lines.length && lines[cursor].indent === indent + 2 && !lines[cursor].text.startsWith("- ")) {
        const [nextKey, nextRaw] = splitYamlPair(lines[cursor].text);
        cursor += 1;
        if (nextRaw) item[nextKey] = parseYamlScalar(nextRaw);
        else if (lines[cursor]?.indent > indent + 2) {
          const [child, next] = parseYamlBlock(lines, cursor, lines[cursor].indent);
          item[nextKey] = child; cursor = next;
        } else item[nextKey] = {};
      }
      result.push(item);
    }
    return [result, cursor];
  }
  const result = {};
  while (cursor < lines.length && lines[cursor].indent === indent && !lines[cursor].text.startsWith("- ")) {
    const [key, rawValue] = splitYamlPair(lines[cursor].text);
    cursor += 1;
    if (rawValue) result[key] = parseYamlScalar(rawValue);
    else if (lines[cursor]?.indent > indent) {
      const [child, next] = parseYamlBlock(lines, cursor, lines[cursor].indent);
      result[key] = child; cursor = next;
    } else result[key] = {};
  }
  return [result, cursor];
}

export function serializeApplicationBlueprint(state) {
  const normalized = normalizeApplicationState(state);
  const yamlView = Object.fromEntries([
    "contract", "application", "blueprint", "desired_state", "execution", "observed_state"
  ].map(key => [key, normalized[key]]));
  return `---\n${yamlBlock(yamlView)}\n`;
}

export function parseApplicationBlueprint(serialized) {
  if (typeof serialized !== "string") throw new TypeError("Blueprint YAML must be text.");
  const lines = serialized.replace(/^---\s*\r?\n/, "").split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => ({ indent: line.length - line.trimStart().length, text: line.trimStart() }));
  if (!lines.length) throw new TypeError("Blueprint YAML is empty.");
  const [parsed, cursor] = parseYamlBlock(lines, 0, lines[0].indent);
  if (cursor !== lines.length) throw new TypeError("Blueprint YAML contains unsupported syntax.");
  return normalizeApplicationState(parsed);
}

export function compareDesiredAndObserved(desired, observed) {
  if (!observed) return [{ key: "deployment.missing", path: "deployment", status: "added", desired: { expected: true }, observed: null }];
  const deltas = [];
  const expectedBlueprint = desired?.blueprint?.version ?? null;
  const actualBlueprint = observed.blueprint_version ?? null;
  if (expectedBlueprint === null || actualBlueprint === null) {
    deltas.push({ key: "blueprint.version", path: "blueprint.version", status: "unknown", desired: expectedBlueprint, observed: actualBlueprint });
  } else if (expectedBlueprint !== actualBlueprint) {
    deltas.push({ key: "blueprint.version", path: "blueprint.version", status: "changed", desired: expectedBlueprint, observed: actualBlueprint });
  }
  const expectedEnvironment = desired?.desired_state?.environments?.find(item => item.kind === observed.environment)?.kind || null;
  if (!expectedEnvironment || !observed.environment) {
    deltas.push({ key: "environment", path: "environment", status: "unknown", desired: expectedEnvironment, observed: observed.environment || null });
  } else if (expectedEnvironment !== observed.environment) {
    deltas.push({ key: "environment", path: "environment", status: "changed", desired: expectedEnvironment, observed: observed.environment });
  }
  if (!desired?.artifact_digest || !observed.artifact_digest) {
    deltas.push({ key: "artifact.digest", path: "artifact.digest", status: "unknown", desired: desired?.artifact_digest || null, observed: observed.artifact_digest || null });
  } else if (desired.artifact_digest !== observed.artifact_digest) {
    deltas.push({ key: "artifact.digest", path: "artifact.digest", status: "changed", desired: desired.artifact_digest, observed: observed.artifact_digest });
  }
  const health = String(observed.health || "unknown").toLowerCase();
  if (health !== "healthy") deltas.push({ key: "health", path: "health", status: health === "unknown" || health === "pending" ? "unknown" : "changed", desired: "healthy", observed: health });
  return deltas;
}
