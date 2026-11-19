import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MODEL_TABLE = /^fm_[0-9a-f]{8}_[a-z][a-z0-9_]{0,39}$/;
const ARCHIVE_FORMAT = "feltus.app-backup/v1";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_MODEL_ROWS = 100_000;

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code, safeForCustomer: true });
}

function safeCode(value, fallback = "APP_BACKUP_FAILED") {
  return /^[A-Z0-9_]{1,64}$/.test(String(value || "")) ? String(value) : fallback;
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 512 ||
      value.includes("\\") || value.startsWith("/") || /^[a-zA-Z]:/.test(value) ||
      /[\u0000-\u001f\u007f]/.test(value)) return false;
  const segments = value.split("/");
  return segments.every(segment =>
    segment && segment !== "." && segment !== ".." &&
    /^[A-Za-z0-9._-]{1,128}$/.test(segment)
  );
}

function ensureDirectory(directory) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
    throw fail(500, "APP_BACKUP_STORAGE_UNSAFE", "Private backup storage is unavailable.");
  }
  try { fs.chmodSync(absolute, 0o700); } catch { /* Windows does not support POSIX modes. */ }
  return absolute;
}

function ensureChildDirectory(root, name) {
  const absoluteRoot = ensureDirectory(root);
  if (!/^[0-9a-f-]{36}$/i.test(name)) {
    throw fail(400, "APP_BACKUP_INVALID_ID", "The application reference is invalid.");
  }
  const target = path.resolve(absoluteRoot, name);
  if (path.dirname(target) !== absoluteRoot) {
    throw fail(400, "APP_BACKUP_PATH_UNSAFE", "Private backup storage is unavailable.");
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(target) !== target) {
    throw fail(500, "APP_BACKUP_STORAGE_UNSAFE", "Private backup storage is unavailable.");
  }
  return target;
}

function backupDirectory(storageRoot, appId) {
  if (!UUID.test(String(appId || ""))) {
    throw fail(400, "APP_BACKUP_INVALID_ID", "The application reference is invalid.");
  }
  return ensureChildDirectory(path.join(path.resolve(storageRoot), "app-backups"), appId);
}

function archivePath(storageRoot, appId, backupId) {
  if (!UUID.test(String(backupId || ""))) {
    throw fail(400, "APP_BACKUP_INVALID_ID", "The backup reference is invalid.");
  }
  return path.join(backupDirectory(storageRoot, appId), `${backupId}.json`);
}

function archivePayload(manifest, snapshot) {
  const { checksum: ignoredChecksum, ...unsignedManifest } = manifest;
  return { format: ARCHIVE_FORMAT, manifest: unsignedManifest, snapshot };
}

function verifyArchive(archive, appId, backupId) {
  if (!plainObject(archive) || archive.format !== ARCHIVE_FORMAT ||
      !plainObject(archive.manifest) || !plainObject(archive.snapshot)) {
    throw fail(400, "APP_BACKUP_INVALID_ARCHIVE", "This backup is not valid and cannot be restored.");
  }
  const manifest = archive.manifest;
  if (manifest.version !== 1 || manifest.app_id !== appId || manifest.backup_id !== backupId ||
      !UUID.test(String(manifest.owner_id || "")) || !HASH.test(String(manifest.checksum || "")) ||
      !HASH.test(String(manifest.schema_sha256 || ""))) {
    throw fail(400, "APP_BACKUP_INVALID_ARCHIVE", "This backup is not valid and cannot be restored.");
  }
  const expected = sha256(JSON.stringify(canonical(archivePayload(manifest, archive.snapshot))));
  if (expected !== manifest.checksum) {
    throw fail(400, "APP_BACKUP_CHECKSUM_MISMATCH", "This backup failed its integrity check and cannot be restored.");
  }
  const files = archive.snapshot.files;
  const documents = archive.snapshot.documents;
  const models = archive.snapshot.models;
  const columns = archive.snapshot.columns;
  const relationships = archive.snapshot.relationships;
  const chunks = archive.snapshot.document_chunks;
  if (!Array.isArray(files) || !Array.isArray(documents) || !Array.isArray(models) ||
      !Array.isArray(columns) || !Array.isArray(relationships) || !Array.isArray(chunks)) {
    throw fail(400, "APP_BACKUP_INVALID_ARCHIVE", "This backup is not valid and cannot be restored.");
  }
  const seenPaths = new Set();
  const fileByPath = new Map();
  for (const file of files) {
    if (!plainObject(file) || !safeRelativePath(file.path) || seenPaths.has(file.path) ||
        !HASH.test(String(file.sha256 || "")) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(String(file.content_base64 || ""))) {
      throw fail(400, "APP_BACKUP_INVALID_ARCHIVE", "This backup is not valid and cannot be restored.");
    }
    seenPaths.add(file.path);
    const bytes = Buffer.from(file.content_base64, "base64");
    if (bytes.toString("base64") !== file.content_base64 || sha256(bytes) !== file.sha256) {
      throw fail(400, "APP_BACKUP_CHECKSUM_MISMATCH", "This backup failed its integrity check and cannot be restored.");
    }
    fileByPath.set(file.path, { sha256: file.sha256, size: bytes.length });
  }
  for (const document of documents) {
    if (!plainObject(document) || document.app_id !== appId ||
        !UUID.test(String(document.id || "")) || !safeRelativePath(document.storage_key) ||
        !document.storage_key.startsWith(`${appId}/`) || !HASH.test(String(document.sha256 || ""))) {
      throw fail(400, "APP_BACKUP_INVALID_ARCHIVE", "This backup is not valid and cannot be restored.");
    }
    const storedFile = fileByPath.get(document.storage_key.slice(appId.length + 1));
    if (!storedFile || storedFile.sha256 !== document.sha256 || storedFile.size !== Number(document.size_bytes)) {
      throw fail(400, "APP_BACKUP_CHECKSUM_MISMATCH", "This backup failed its integrity check and cannot be restored.");
    }
  }
  const documentIds = new Set(documents.map(document => document.id));
  if (chunks.some(chunk => !plainObject(chunk) || chunk.app_id !== appId ||
      !documentIds.has(chunk.document_id) || !UUID.test(String(chunk.id || "")))) {
    throw fail(400, "APP_BACKUP_INVALID_ARCHIVE", "This backup is not valid and cannot be restored.");
  }
  for (const model of models) {
    if (!plainObject(model) || !UUID.test(String(model.id || "")) ||
        !MODEL_TABLE.test(String(model.physical_table_name || "")) ||
        !Array.isArray(model.rows)) {
      throw fail(400, "APP_BACKUP_INVALID_ARCHIVE", "This backup is not valid and cannot be restored.");
    }
  }
  return archive;
}

function schemaFor(snapshot) {
  return {
    models: snapshot.models.map(({ rows: ignoredRows, ...model }) => model)
      .sort((left, right) => left.id.localeCompare(right.id)),
    columns: snapshot.columns.slice().sort((left, right) => left.id.localeCompare(right.id)),
    relationships: snapshot.relationships.slice().sort((left, right) => left.id.localeCompare(right.id))
  };
}

function schemaHash(snapshot) {
  return sha256(JSON.stringify(canonical(schemaFor(snapshot))));
}

export function createAppBackupArtifact({ storageRoot, appId, backupId, ownerId, organizationId = null, createdAt, snapshot }) {
  if (!UUID.test(String(appId || "")) || !UUID.test(String(backupId || "")) ||
      !UUID.test(String(ownerId || "")) || !plainObject(snapshot)) {
    throw fail(400, "APP_BACKUP_INVALID_INPUT", "The app backup could not be created.");
  }
  const manifest = {
    version: 1,
    backup_id: backupId,
    app_id: appId,
    owner_id: ownerId,
    organization_id: organizationId || null,
    created_at: createdAt || new Date().toISOString(),
    schema_sha256: schemaHash(snapshot)
  };
  manifest.checksum = sha256(JSON.stringify(canonical(archivePayload(manifest, snapshot))));
  const serialized = JSON.stringify({ format: ARCHIVE_FORMAT, manifest, snapshot });
  if (Buffer.byteLength(serialized, "utf8") > MAX_ARCHIVE_BYTES) {
    throw fail(413, "APP_BACKUP_TOO_LARGE", "This app is too large to back up with the current storage limit.");
  }
  const destination = archivePath(storageRoot, appId, backupId);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, serialized, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(temporary, destination); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* Preserve the original storage error. */ }
    throw error;
  }
  try { fs.chmodSync(destination, 0o600); } catch { /* Windows does not support POSIX modes. */ }
  return {
    archivePath: destination,
    storageReference: `app-backups/${appId}/${backupId}.json`,
    manifest,
    checksum: manifest.checksum
  };
}

export function loadAppBackupArtifact(storageRoot, appId, backupId) {
  const file = archivePath(storageRoot, appId, backupId);
  let info;
  try { info = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === "ENOENT") throw fail(404, "APP_BACKUP_ARTIFACT_MISSING", "This backup file is unavailable.");
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ARCHIVE_BYTES) {
    throw fail(400, "APP_BACKUP_INVALID_ARCHIVE", "This backup is not valid and cannot be restored.");
  }
  let archive;
  try { archive = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw fail(400, "APP_BACKUP_INVALID_ARCHIVE", "This backup is not valid and cannot be restored."); }
  return verifyArchive(archive, appId, backupId);
}

function assertSafeTree(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw fail(400, "APP_BACKUP_FILE_UNSAFE", "An app file could not be safely backed up.");
    }
    if (entry.isDirectory()) assertSafeTree(child);
    else if (!entry.isFile()) throw fail(400, "APP_BACKUP_FILE_UNSAFE", "An app file could not be safely backed up.");
  }
}

export function readAppPrivateFiles(documentStorageRoot, appId) {
  if (!UUID.test(String(appId || ""))) {
    throw fail(400, "APP_BACKUP_INVALID_ID", "The application reference is invalid.");
  }
  const root = ensureDirectory(documentStorageRoot);
  const appDirectory = path.resolve(root, appId);
  if (path.dirname(appDirectory) !== root) throw fail(400, "APP_BACKUP_PATH_UNSAFE", "App files could not be safely accessed.");
  if (!fs.existsSync(appDirectory)) return [];
  const appInfo = fs.lstatSync(appDirectory);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink() || fs.realpathSync(appDirectory) !== appDirectory) {
    throw fail(400, "APP_BACKUP_FILE_UNSAFE", "An app file could not be safely backed up.");
  }
  assertSafeTree(appDirectory);
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else {
        const relative = path.relative(appDirectory, absolute).split(path.sep).join("/");
        if (!safeRelativePath(relative)) throw fail(400, "APP_BACKUP_PATH_UNSAFE", "App files could not be safely accessed.");
        const bytes = fs.readFileSync(absolute);
        files.push({ path: relative, sha256: sha256(bytes), content_base64: bytes.toString("base64") });
      }
    }
  };
  visit(appDirectory);
  return files;
}

export function stageAppPrivateFiles(documentStorageRoot, appId, backupId, files) {
  if (!UUID.test(String(appId || "")) || !UUID.test(String(backupId || "")) || !Array.isArray(files)) {
    throw fail(400, "APP_BACKUP_INVALID_INPUT", "The app files could not be restored.");
  }
  const root = ensureDirectory(documentStorageRoot);
  const stagingName = `.restore-${appId}-${backupId}-${crypto.randomUUID()}`;
  const staging = path.resolve(root, stagingName);
  if (path.dirname(staging) !== root) throw fail(400, "APP_BACKUP_PATH_UNSAFE", "App files could not be safely restored.");
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    for (const file of files) {
      if (!plainObject(file) || !safeRelativePath(file.path) || !HASH.test(String(file.sha256 || ""))) {
        throw fail(400, "APP_BACKUP_INVALID_ARCHIVE", "This backup is not valid and cannot be restored.");
      }
      const bytes = Buffer.from(file.content_base64, "base64");
      if (bytes.toString("base64") !== file.content_base64 || sha256(bytes) !== file.sha256) {
        throw fail(400, "APP_BACKUP_CHECKSUM_MISMATCH", "This backup failed its integrity check and cannot be restored.");
      }
      const destination = path.resolve(staging, ...file.path.split("/"));
      if (!destination.startsWith(`${staging}${path.sep}`)) {
        throw fail(400, "APP_BACKUP_PATH_UNSAFE", "App files could not be safely restored.");
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return staging;
}

export function switchAppPrivateFiles(documentStorageRoot, appId, stagingDirectory) {
  const root = ensureDirectory(documentStorageRoot);
  const destination = path.resolve(root, appId);
  const staging = path.resolve(stagingDirectory);
  if (!UUID.test(String(appId || "")) || path.dirname(destination) !== root ||
      path.dirname(staging) !== root || !path.basename(staging).startsWith(`.restore-${appId}-`)) {
    throw fail(400, "APP_BACKUP_PATH_UNSAFE", "App files could not be safely restored.");
  }
  const oldDirectory = path.join(root, `.previous-${appId}-${crypto.randomUUID()}`);
  let movedOld = false;
  let movedNew = false;
  if (fs.existsSync(destination)) {
    const info = fs.lstatSync(destination);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(destination) !== destination) {
      throw fail(400, "APP_BACKUP_FILE_UNSAFE", "App files could not be safely restored.");
    }
    assertSafeTree(destination);
    fs.renameSync(destination, oldDirectory);
    movedOld = true;
  }
  try {
    fs.renameSync(staging, destination);
    movedNew = true;
  } catch (error) {
    if (movedOld) fs.renameSync(oldDirectory, destination);
    throw error;
  }
  return {
    rollback() {
      if (movedNew && fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: false });
      if (movedOld && fs.existsSync(oldDirectory)) fs.renameSync(oldDirectory, destination);
    },
    commit() {
      if (movedOld && fs.existsSync(oldDirectory)) fs.rmSync(oldDirectory, { recursive: true, force: false });
    }
  };
}

async function readAppSnapshot({ serviceRequest, documentStorageRoot, app }) {
  const result = await serviceRequest("/rest/v1/rpc/feltus_read_app_backup_snapshot", {
    method: "POST",
    body: { p_app_id: app.id, p_owner_id: app.owner_id }
  });
  if (result.status < 200 || result.status >= 300 || !plainObject(result.data) ||
      !Array.isArray(result.data.models) || !Array.isArray(result.data.columns) ||
      !Array.isArray(result.data.relationships) || !Array.isArray(result.data.documents) ||
      !Array.isArray(result.data.document_chunks)) {
    throw fail(502, "APP_BACKUP_DATABASE_UNAVAILABLE", "App data could not be safely read.");
  }
  const snapshot = result.data;
  const totalRows = snapshot.models.reduce((total, model) =>
    total + (Array.isArray(model.rows) ? model.rows.length : MAX_MODEL_ROWS + 1), 0);
  if (totalRows > MAX_MODEL_ROWS) {
    throw fail(413, "APP_BACKUP_TOO_LARGE", "This app has too much data for the current backup limit.");
  }
  for (const model of snapshot.models) {
    if (model.app_id !== app.id || model.owner_id !== app.owner_id ||
        !MODEL_TABLE.test(String(model.physical_table_name || "")) || !Array.isArray(model.rows)) {
      throw fail(409, "APP_BACKUP_MODEL_UNSUPPORTED", "A data model cannot be safely backed up.");
    }
    model.rows.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }
  for (const document of snapshot.documents) {
    if (document.app_id !== app.id || document.owner_id !== app.owner_id ||
        !safeRelativePath(document.storage_key) || !document.storage_key.startsWith(`${app.id}/`)) {
      throw fail(409, "APP_BACKUP_DOCUMENT_UNSUPPORTED", "An app file could not be safely backed up.");
    }
  }
  snapshot.files = readAppPrivateFiles(documentStorageRoot, app.id);
  return snapshot;
}

function modelDeleteOrder(snapshot) {
  const modelIds = new Set(snapshot.models.map(model => model.id));
  const outgoing = new Map([...modelIds].map(id => [id, new Set()]));
  const indegree = new Map([...modelIds].map(id => [id, 0]));
  for (const relation of snapshot.relationships) {
    if (!modelIds.has(relation.source_model_id) || !modelIds.has(relation.target_model_id)) {
      throw fail(409, "APP_BACKUP_RELATIONSHIP_INVALID", "This app’s data links changed. Refresh and try again.");
    }
    if (!outgoing.get(relation.source_model_id).has(relation.target_model_id)) {
      outgoing.get(relation.source_model_id).add(relation.target_model_id);
      indegree.set(relation.target_model_id, indegree.get(relation.target_model_id) + 1);
    }
  }
  const ready = [...modelIds].filter(id => indegree.get(id) === 0).sort();
  const ordered = [];
  while (ready.length) {
    const id = ready.shift();
    ordered.push(id);
    for (const target of outgoing.get(id)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }
  if (ordered.length !== modelIds.size) {
    throw fail(409, "APP_BACKUP_RELATIONSHIP_CYCLE", "This app’s data links cannot be safely restored.");
  }
  const byId = new Map(snapshot.models.map(model => [model.id, model]));
  return ordered.map(id => byId.get(id));
}

function publicRecord(record) {
  return {
    id: record.id,
    app_id: record.app_id,
    status: record.status,
    backup_kind: record.backup_kind,
    created_at: record.created_at,
    started_at: record.started_at,
    completed_at: record.completed_at,
    manifest_version: record.manifest_version,
    checksum: record.checksum,
    restore_eligible: record.restore_eligible === true,
    restore_status: record.restore_status || "not_started",
    restore_started_at: record.restore_started_at || null,
    restore_completed_at: record.restore_completed_at || null,
    restore_failure_code: record.restore_failure_code || null,
    restore_failure_message: record.restore_failure_message || null,
    failure_code: record.failure_code || null,
    failure_message: record.failure_message || null,
    safety_backup_id: record.safety_backup_id || null
  };
}

export function createAppBackupHandler({
  storageRoot,
  documentStorageRoot,
  serviceRequest,
  getUser,
  authorizeApp
}) {
  if (typeof serviceRequest !== "function" || typeof getUser !== "function" || typeof authorizeApp !== "function") {
    throw new TypeError("App backup handler dependencies are required.");
  }

  async function databaseCall(endpoint, options = {}) {
    const result = await serviceRequest(endpoint, options);
    if (result.status < 200 || result.status >= 300) {
      throw fail(502, "APP_BACKUP_DATABASE_UNAVAILABLE", "App backup history could not be updated.");
    }
    return result.data;
  }

  async function saveRecord(id, app, patch) {
    const query = new URLSearchParams({
      id: `eq.${id}`,
      app_id: `eq.${app.id}`,
      owner_id: `eq.${app.owner_id}`,
      select: "*"
    }).toString();
    const result = await databaseCall(`/rest/v1/feltus_app_backups?${query}`, {
      method: "PATCH",
      body: patch,
      prefer: "return=representation"
    });
    if (!Array.isArray(result) || !result[0]) {
      throw fail(502, "APP_BACKUP_DATABASE_UNAVAILABLE", "App backup history could not be updated.");
    }
    return result[0];
  }

  async function claimRestore(id, app) {
    const query = new URLSearchParams({
      id: `eq.${id}`,
      app_id: `eq.${app.id}`,
      owner_id: `eq.${app.owner_id}`,
      backup_kind: "eq.customer",
      status: "eq.available",
      restore_eligible: "eq.true",
      restore_status: "neq.restoring",
      select: "*"
    }).toString();
    const result = await databaseCall(`/rest/v1/feltus_app_backups?${query}`, {
      method: "PATCH",
      body: {
        restore_status: "restoring",
        restore_started_at: new Date().toISOString(),
        restore_completed_at: null,
        restore_failure_code: null,
        restore_failure_message: null,
        safety_backup_id: null
      },
      prefer: "return=representation"
    });
    if (!Array.isArray(result) || !result[0]) {
      throw fail(409, "APP_RESTORE_IN_PROGRESS", "A restore is already in progress for this backup.");
    }
    return result[0];
  }

  async function createBackup(app, user, backupKind = "customer") {
    const backupId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const reference = `app-backups/${app.id}/${backupId}.json`;
    const initial = {
      id: backupId,
      app_id: app.id,
      owner_id: app.owner_id,
      organization_id: app.organization_id || null,
      backup_kind: backupKind,
      status: "creating",
      storage_reference: reference,
      manifest_version: 1,
      manifest: {},
      checksum: null,
      created_by: user.id,
      created_at: startedAt,
      started_at: startedAt,
      restore_eligible: false
    };
    const created = await databaseCall("/rest/v1/feltus_app_backups?select=*", {
      method: "POST",
      body: initial,
      prefer: "return=representation"
    });
    if (!Array.isArray(created) || !created[0]) {
      throw fail(502, "APP_BACKUP_DATABASE_UNAVAILABLE", "App backup history could not be created.");
    }
    let artifact = null;
    try {
      const snapshot = await readAppSnapshot({ serviceRequest, documentStorageRoot, app });
      let restoreEligible = true;
      try { modelDeleteOrder(snapshot); }
      catch (error) {
        if (error?.code === "APP_BACKUP_RELATIONSHIP_CYCLE") restoreEligible = false;
        else throw error;
      }
      artifact = createAppBackupArtifact({
        storageRoot,
        appId: app.id,
        backupId,
        ownerId: app.owner_id,
        organizationId: app.organization_id || null,
        createdAt: startedAt,
        snapshot
      });
      const completedAt = new Date().toISOString();
      return await saveRecord(backupId, app, {
        status: "available",
        storage_reference: artifact.storageReference,
        manifest_version: artifact.manifest.version,
        manifest: artifact.manifest,
        checksum: artifact.checksum,
        completed_at: completedAt,
        restore_eligible: backupKind === "customer" && restoreEligible,
        failure_code: null,
        failure_message: null
      });
    } catch (error) {
      if (artifact?.archivePath) {
        try { fs.unlinkSync(artifact.archivePath); } catch { /* Keep the durable failure record. */ }
      }
      const failureCode = safeCode(error?.code, "APP_BACKUP_FAILED");
      try {
        await saveRecord(backupId, app, {
          status: "failed",
          completed_at: new Date().toISOString(),
          restore_eligible: false,
          failure_code: failureCode,
          failure_message: "FELTUS could not complete this backup."
        });
      } catch {
        throw fail(502, "APP_BACKUP_HISTORY_UPDATE_FAILED", "FELTUS could not record the backup result.");
      }
      const message = error?.safeForCustomer === true
        ? error.message
        : "FELTUS could not complete this backup.";
      throw fail(error?.status || 500, failureCode, message);
    }
  }

  async function applySnapshot(app, archive) {
    const snapshot = archive.snapshot;
    const models = modelDeleteOrder(snapshot);
    const staging = stageAppPrivateFiles(documentStorageRoot, app.id, archive.manifest.backup_id, snapshot.files);
    let switched;
    try {
      switched = switchAppPrivateFiles(documentStorageRoot, app.id, staging);
      await databaseCall("/rest/v1/rpc/feltus_restore_app_data_snapshot", {
        method: "POST",
        body: {
          p_app_id: app.id,
          p_owner_id: app.owner_id,
          p_models: models,
          p_documents: snapshot.documents,
          p_document_chunks: snapshot.document_chunks
        }
      });
      const validation = await readAppSnapshot({ serviceRequest, documentStorageRoot, app });
      if (schemaHash(validation) !== archive.manifest.schema_sha256 ||
          sha256(JSON.stringify(canonical(validation))) !== sha256(JSON.stringify(canonical(snapshot)))) {
        throw fail(502, "APP_RESTORE_VALIDATION_FAILED", "Restored app data could not be verified.");
      }
      switched.commit();
    } catch (error) {
      if (switched) {
        try { switched.rollback(); }
        catch { throw fail(500, "APP_RESTORE_RECOVERY_REQUIRED", "Restore did not complete. The safety backup is available."); }
      }
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: false });
      throw error;
    }
  }

  async function handle(req, res, url) {
    const match = /^\/api\/apps\/([0-9a-f-]{36})\/backups(?:\/([0-9a-f-]{36})(?:\/(restore))?)?$/i.exec(url.pathname);
    if (!match) return false;
    const [, appId, backupId, action] = match;
    const method = String(req.method || "GET").toUpperCase();
    const user = getUser();
    if (!user?.id) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Authentication required.", code: "AUTH_REQUIRED" }));
      return true;
    }
    if (!UUID.test(appId) || (backupId && !UUID.test(backupId))) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "A valid app and backup reference are required.", code: "APP_BACKUP_INVALID_ID" }));
      return true;
    }
    try {
      const app = await authorizeApp(appId);
      if (!app) throw fail(404, "APPLICATION_NOT_FOUND", "This app is unavailable.");
      if (app.owner_id !== user.id) throw fail(403, "APP_BACKUP_OWNER_REQUIRED", "Only the app owner can manage backups.");
      if (app.lifecycle_status && app.lifecycle_status !== "active") {
        throw fail(409, "APP_BACKUP_APP_INACTIVE", "Restore or backup is unavailable while this app is inactive.");
      }

      if (!backupId && method === "GET") {
        const query = new URLSearchParams({
          select: "id,app_id,status,backup_kind,created_at,started_at,completed_at,manifest_version,checksum,restore_eligible,restore_status,restore_started_at,restore_completed_at,restore_failure_code,restore_failure_message,failure_code,failure_message,safety_backup_id",
          app_id: `eq.${app.id}`,
          owner_id: `eq.${app.owner_id}`,
          backup_kind: "eq.customer",
          order: "created_at.desc",
          limit: "100"
        }).toString();
        const records = await databaseCall(`/rest/v1/feltus_app_backups?${query}`);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ backups: records.map(publicRecord) }));
        return true;
      }
      if (!backupId && method === "POST") {
        const record = await createBackup(app, user);
        res.writeHead(201, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ backup: publicRecord(record) }));
        return true;
      }

      const recordQuery = new URLSearchParams({
        select: "*",
        id: `eq.${backupId}`,
        app_id: `eq.${app.id}`,
        owner_id: `eq.${app.owner_id}`,
        backup_kind: "eq.customer",
        limit: "1"
      }).toString();
      const records = await databaseCall(`/rest/v1/feltus_app_backups?${recordQuery}`);
      const record = Array.isArray(records) ? records[0] : null;
      if (!record) throw fail(404, "APP_BACKUP_NOT_FOUND", "This backup is unavailable.");
      if (!action && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ backup: publicRecord(record) }));
        return true;
      }
      if (action !== "restore" || method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "GET, POST" });
        res.end(JSON.stringify({ error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" }));
        return true;
      }
      if (record.status !== "available" || record.manifest_version !== 1 || record.restore_eligible !== true) {
        throw fail(409, "APP_BACKUP_NOT_RESTORABLE", "This backup is not ready to restore.");
      }
      if (record.restore_status === "restoring") {
        throw fail(409, "APP_RESTORE_IN_PROGRESS", "A restore is already in progress.");
      }
      const archive = loadAppBackupArtifact(storageRoot, app.id, backupId);
      if (archive.manifest.owner_id !== app.owner_id || archive.manifest.organization_id !== (app.organization_id || null) ||
          archive.manifest.checksum !== record.checksum || archive.manifest.version !== record.manifest_version) {
        throw fail(400, "APP_BACKUP_CHECKSUM_MISMATCH", "This backup failed its integrity check and cannot be restored.");
      }
      const current = await readAppSnapshot({ serviceRequest, documentStorageRoot, app });
      if (schemaHash(current) !== archive.manifest.schema_sha256) {
        throw fail(409, "APP_BACKUP_SCHEMA_CHANGED", "This app’s data structure has changed. This backup cannot be restored safely.");
      }
      await claimRestore(backupId, app);
      let safety = null;
      let restoreApplied = false;
      try {
        safety = await createBackup(app, user, "safety_snapshot");
        await saveRecord(backupId, app, { safety_backup_id: safety.id });
        restoreApplied = true;
        await applySnapshot(app, archive);
        const completed = await saveRecord(backupId, app, {
          restore_status: "succeeded",
          restore_completed_at: new Date().toISOString(),
          restore_failure_code: null,
          restore_failure_message: null,
          safety_backup_id: safety.id
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ backup: publicRecord(completed), safety_backup_id: safety.id }));
      } catch (error) {
        let failureCode = safeCode(error?.code, "APP_RESTORE_FAILED");
        let failureMessage = "FELTUS could not verify the restored data. Your safety backup is available.";
        if (restoreApplied && safety) {
          try {
            const safetyArchive = loadAppBackupArtifact(storageRoot, app.id, safety.id);
            await applySnapshot(app, safetyArchive);
          } catch {
            failureCode = "APP_RESTORE_RECOVERY_REQUIRED";
            failureMessage = "Restore did not complete. The safety backup is available for recovery.";
          }
        }
        let failed;
        try {
          failed = await saveRecord(backupId, app, {
            restore_status: "failed",
            restore_completed_at: new Date().toISOString(),
            restore_failure_code: failureCode,
            restore_failure_message: failureMessage,
            safety_backup_id: safety?.id || null
          });
        } catch {
          throw fail(502, "APP_RESTORE_HISTORY_UPDATE_FAILED", "FELTUS could not record the restore result.");
        }
        res.writeHead(error?.status || 500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        const message = error?.safeForCustomer === true
          ? error.message
          : failureMessage;
        res.end(JSON.stringify({ error: message, code: failureCode, backup: publicRecord(failed), safety_backup_id: safety?.id || null }));
      }
      return true;
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        error: error?.safeForCustomer === true
          ? error.message
          : "FELTUS could not complete this backup action.",
        code: safeCode(error?.code, "APP_BACKUP_FAILED")
      }));
      return true;
    }
  }

  return handle;
}
