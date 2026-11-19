import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createFileTools } from "./file-tools.mjs";
import {
  assertNoSymlinkTraversal,
  isSensitivePath,
  normalizeRelativePath,
  redactSecrets,
  resolveInside
} from "./security.mjs";

const CHANGE_TYPES = new Set(["create", "update", "rename", "delete"]);
const BACKUP_FOLDER = ".feltus-code-backups";

function fail(message, code = "INVALID_CHANGE_SET") {
  return Object.assign(new Error(message), { code });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cleanPath(value) {
  const normalized = normalizeRelativePath(value);
  if (!normalized || normalized === "." || isSensitivePath(normalized) || normalized.startsWith(`${BACKUP_FOLDER}/`)) {
    throw fail("Change sets may include only non-sensitive project files.", "SENSITIVE_FILE_BLOCKED");
  }
  return normalized;
}

function normalizeOperation(operation, index) {
  const type = String(operation?.type || "");
  if (!CHANGE_TYPES.has(type)) throw fail("Change set contains an unsupported operation.");
  const id = String(operation.id || `change-${index + 1}`).slice(0, 100);
  const base = {
    id,
    type,
    reason: String(operation.reason || "Requested project change").slice(0, 1000),
    agent: ["app-architect", "project-agent", "code-agent", "devops-agent"].includes(operation.agent)
      ? operation.agent
      : "code-agent"
  };
  if (type === "rename") {
    return {
      ...base,
      from: cleanPath(operation.from),
      to: cleanPath(operation.to),
      before_sha256: String(operation.before_sha256 || "")
    };
  }
  return {
    ...base,
    path: cleanPath(operation.path),
    ...(type === "create" || type === "update" ? { content: String(operation.content ?? "") } : {}),
    ...(type === "update" || type === "delete" ? { before_sha256: String(operation.before_sha256 || "") } : {})
  };
}

export function normalizeChangeSet(changeSet, { selectedIds } = {}) {
  const source = Array.isArray(changeSet?.operations) ? changeSet.operations : [];
  if (source.length < 1 || source.length > 24) throw fail("A change set must contain between 1 and 24 file operations.");
  const allOperations = source.map(normalizeOperation);
  const allIds = new Set();
  for (const operation of allOperations) {
    if (allIds.has(operation.id)) throw fail("Change set operation IDs must be unique.");
    allIds.add(operation.id);
  }
  let selected = null;
  if (selectedIds !== undefined) {
    if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
      throw fail("Select at least one proposed change.");
    }
    selected = new Set(selectedIds.map(String));
    if (selected.size !== selectedIds.length || [...selected].some(id => !allIds.has(id))) {
      throw fail("Change selection contains duplicate or unknown operation IDs.");
    }
  }
  const operations = allOperations.filter(operation => !selected || selected.has(operation.id));
  if (!operations.length) throw fail("Select at least one proposed change.");
  const touched = new Set();
  for (const operation of operations) {
    const paths = operation.type === "rename" ? [operation.from, operation.to] : [operation.path];
    for (const filePath of paths) {
      if (touched.has(filePath)) throw fail(`A file may appear only once in a change set: ${filePath}`);
      touched.add(filePath);
    }
  }
  const normalized = {
    id: String(changeSet.id || crypto.randomUUID()),
    summary: String(changeSet.summary || "Project changes").slice(0, 2000),
    operations
  };
  if (changeSet?.feltus_design?.contract === "feltus.design-change/v1") {
    const metadata = JSON.parse(JSON.stringify(changeSet.feltus_design));
    if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 48000) throw fail("Design undo metadata exceeds the safe change-set limit.", "DESIGN_STATE_TOO_LARGE");
    normalized.feltus_design = metadata;
  }
  return normalized;
}

export function resolveChangeSetSelection(changeSet, selectedIds) {
  const normalized = normalizeChangeSet(changeSet, { selectedIds });
  return {
    changeSet: {
      ...changeSet,
      ...normalized,
      operations: normalized.operations
    },
    selectedIds: normalized.operations.map(operation => operation.id)
  };
}

async function inspectOptional(files, relativePath) {
  try {
    return await files.inspect(relativePath, { forAI: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function validateOperations(repoRoot, operations) {
  const files = createFileTools({ repoRoot });
  const validated = [];
  for (const operation of operations) {
    if (operation.type === "create") {
      if (await inspectOptional(files, operation.path)) throw fail(`Create target already exists: ${operation.path}`, "EDIT_CONFLICT");
      validated.push({ ...operation, before: null });
      continue;
    }
    const sourcePath = operation.type === "rename" ? operation.from : operation.path;
    const current = await inspectOptional(files, sourcePath);
    if (!current) throw fail(`Project file is unavailable: ${sourcePath}`, "EDIT_CONFLICT");
    if (!operation.before_sha256 || current.sha256 !== operation.before_sha256) {
      throw fail(`File changed since this proposal was created: ${sourcePath}`, "EDIT_CONFLICT");
    }
    if (operation.type === "rename" && await inspectOptional(files, operation.to)) {
      throw fail(`Rename destination already exists: ${operation.to}`, "EDIT_CONFLICT");
    }
    validated.push({ ...operation, before: current.content });
  }
  const plannedWrites = new Set();
  const plannedDeletes = new Set();
  for (const op of validated) {
    if (op.type === "create" || op.type === "update") plannedWrites.add(op.path);
    if (op.type === "rename") {
      plannedDeletes.add(op.from);
      plannedWrites.add(op.to);
    }
    if (op.type === "delete") plannedDeletes.add(op.path);
  }
  for (const op of validated) {
    if ((op.type !== "create" && op.type !== "update") || !/\.html?$/i.test(op.path)) continue;
    const baseDir = path.posix.dirname(op.path);
    const assetMatches = String(op.content || "").matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)=["']([^"'?#]+)["']/gi);
    for (const match of assetMatches) {
      const rawRef = match[1].trim();
      if (!rawRef || /^(?:[a-z]+:|\/\/|#)/i.test(rawRef)) continue;
      if (!/\.(?:css|m?js)$/i.test(rawRef)) continue;
      const resolvedRef = rawRef.startsWith("/")
        ? path.posix.normalize(rawRef.slice(1))
        : path.posix.normalize(baseDir === "." ? rawRef : `${baseDir}/${rawRef}`);
      if (resolvedRef.startsWith("..")) continue;
      if (plannedWrites.has(resolvedRef)) continue;
      if (plannedDeletes.has(resolvedRef) || !(await inspectOptional(files, resolvedRef))) {
        throw fail(`HTML file ${op.path} references missing local asset: ${resolvedRef}`, "MISSING_LOCAL_ASSET");
      }
    }
  }
  return validated;
}

async function backupPath(repoRoot, token) {
  await ensureBackupIgnored(repoRoot);
  const folder = resolveInside(repoRoot, BACKUP_FOLDER);
  await assertNoSymlinkTraversal(repoRoot, BACKUP_FOLDER);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  await assertNoSymlinkTraversal(repoRoot, BACKUP_FOLDER);
  return path.join(folder, `${token}.json`);
}

async function ensureBackupIgnored(repoRoot) {
  const gitDirectory = path.join(repoRoot, ".git");
  const gitStat = await fs.lstat(gitDirectory).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!gitStat?.isDirectory()) return;
  await assertNoSymlinkTraversal(repoRoot, ".git/info/exclude");
  const excludePath = path.join(gitDirectory, "info", "exclude");
  await fs.mkdir(path.dirname(excludePath), { recursive: true, mode: 0o700 });
  const current = await fs.readFile(excludePath, "utf8").catch(error => error?.code === "ENOENT" ? "" : Promise.reject(error));
  if (current.split(/\r?\n/).some(line => line.trim() === `/${BACKUP_FOLDER}/` || line.trim() === `${BACKUP_FOLDER}/`)) return;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await fs.appendFile(excludePath, `${prefix}/${BACKUP_FOLDER}/\n`, { encoding: "utf8", mode: 0o600 });
  await assertNoSymlinkTraversal(repoRoot, ".git/info/exclude");
}

async function writeBackup(repoRoot, changeSet, operations) {
  const token = crypto.randomUUID();
  const snapshot = {
    token,
    change_set_id: changeSet.id,
    summary: changeSet.summary,
    created_at: new Date().toISOString(),
    used_at: null,
    ...(changeSet.feltus_design ? { feltus_design: changeSet.feltus_design } : {}),
    operations: operations.map(operation => ({
      ...operation,
      after_sha256: operation.type === "delete"
        ? null
        : operation.type === "rename"
          ? sha256(operation.before)
          : sha256(operation.content)
    }))
  };
  const target = await backupPath(repoRoot, token);
  await fs.writeFile(target, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { token, target, snapshot };
}

async function applyValidated(repoRoot, operations, { beforeApplyOperation, onApplied } = {}) {
  const files = createFileTools({ repoRoot });
  const results = [];
  for (const operation of operations) {
    await beforeApplyOperation?.(operation);
    if (operation.type === "create") {
      results.push({ ...operation, result: await files.createFile(operation.path, operation.content) });
    } else if (operation.type === "update") {
      results.push({ ...operation, result: await files.write(operation.path, operation.content, { expectedSha256: operation.before_sha256 }) });
    } else if (operation.type === "rename") {
      results.push({ ...operation, result: await files.rename(operation.from, operation.to) });
    } else if (operation.type === "delete") {
      results.push({ ...operation, result: await files.remove(operation.path, { confirm: true }) });
    }
    await onApplied?.(operation);
  }
  return results;
}

async function restoreOperations(repoRoot, operations, { verifyAfter = false, beforeRestoreOperation } = {}) {
  const files = createFileTools({ repoRoot });
  for (const operation of [...operations].reverse()) {
    await beforeRestoreOperation?.(operation);
    const currentPath = operation.type === "rename" ? operation.to : operation.path;
    if (verifyAfter && operation.after_sha256) {
      const current = await inspectOptional(files, currentPath);
      if (!current || current.sha256 !== operation.after_sha256) {
        throw fail(`Cannot undo because this file changed after the change set: ${currentPath}`, "UNDO_CONFLICT");
      }
    }
    if (operation.type === "create") {
      await files.remove(operation.path, { confirm: true });
    } else if (operation.type === "update") {
      const current = await files.inspect(operation.path);
      await files.write(operation.path, operation.before, { expectedSha256: current.sha256 });
    } else if (operation.type === "rename") {
      await files.rename(operation.to, operation.from);
    } else if (operation.type === "delete") {
      if (verifyAfter && await inspectOptional(files, operation.path)) {
        throw fail(`Cannot undo because the deleted path now exists: ${operation.path}`, "UNDO_CONFLICT");
      }
      await files.createFile(operation.path, operation.before);
    }
  }
}

function operationRecoveryDetails(operation) {
  return {
    id: operation.id,
    type: operation.type,
    paths: operation.type === "rename" ? [operation.from, operation.to] : [operation.path]
  };
}

function errorDetails(error) {
  return {
    code: String(error?.code || "CHANGE_SET_OPERATION_FAILED").slice(0, 100),
    message: redactSecrets(String(error?.message || "Change set operation failed.")).slice(0, 1000)
  };
}

async function persistBackupSnapshot(target, snapshot) {
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(cleanupError => {
      error.cleanupError = cleanupError;
    });
    throw error;
  }
}

async function rollbackAppliedOperations(repoRoot, operations, { beforeRestoreOperation, onRestored } = {}) {
  const restored = [];
  const failures = [];
  const progressErrors = [];
  for (const operation of [...operations].reverse()) {
    try {
      await restoreOperations(repoRoot, [operation], { beforeRestoreOperation });
    } catch (error) {
      failures.push({ ...operationRecoveryDetails(operation), error: errorDetails(error) });
      continue;
    }
    restored.push(operation);
    try {
      await onRestored?.(operation);
    } catch (error) {
      progressErrors.push(errorDetails(error));
    }
  }
  return { restored, failures, progressErrors };
}

export async function reviewChangeSet({ repoRoot, changeSet, selectedIds }) {
  const normalized = normalizeChangeSet(changeSet, { selectedIds });
  const operations = await validateOperations(repoRoot, normalized.operations);
  return {
    ...normalized,
    operations: operations.map(({ before, ...operation }) => ({
      ...operation,
      before_content: before,
      destructive: operation.type === "delete" || operation.type === "rename"
    }))
  };
}

export async function applyChangeSet({
  repoRoot,
  changeSet,
  selectedIds,
  confirmDestructive = false,
  beforeApplyOperation,
  beforeRollbackOperation
}) {
  const normalized = normalizeChangeSet(changeSet, { selectedIds });
  if (!confirmDestructive && normalized.operations.some(operation => operation.type === "delete")) {
    throw fail("Explicit confirmation is required before applying file deletions.", "CONFIRMATION_REQUIRED");
  }
  const operations = await validateOperations(repoRoot, normalized.operations);
  const backup = await writeBackup(repoRoot, normalized, operations);
  const appliedOperations = [];
  backup.snapshot.recovery = {
    status: "applying",
    applied_operations: []
  };
  try {
    const applied = await applyValidated(repoRoot, operations, {
      beforeApplyOperation,
      onApplied: async operation => {
        appliedOperations.push(operation);
        backup.snapshot.recovery.applied_operations.push(operationRecoveryDetails(operation));
        await persistBackupSnapshot(backup.target, backup.snapshot);
      }
    });
    backup.snapshot.recovery.status = "applied";
    await persistBackupSnapshot(backup.target, backup.snapshot);
    return {
      change_set_id: normalized.id,
      summary: normalized.summary,
      applied: applied.map(({ before, ...operation }) => operation),
      undo_token: backup.token
    };
  } catch (error) {
    const recovery = {
      status: "rollback_in_progress",
      applied_operations: appliedOperations.map(operationRecoveryDetails),
      restored_operation_ids: [],
      uncertain_operations: [],
      apply_error: errorDetails(error),
      rollback_errors: []
    };
    backup.snapshot.recovery = recovery;
    try {
      await persistBackupSnapshot(backup.target, backup.snapshot);
    } catch (metadataError) {
      recovery.metadata_warnings = [errorDetails(metadataError)];
    }

    const rollback = await rollbackAppliedOperations(repoRoot, appliedOperations, {
      beforeRestoreOperation: beforeRollbackOperation,
      onRestored: async operation => {
        recovery.restored_operation_ids.push(operation.id);
        await persistBackupSnapshot(backup.target, backup.snapshot);
      }
    });
    recovery.rollback_errors = rollback.failures;
    if (rollback.progressErrors.length) {
      recovery.metadata_warnings = [...(recovery.metadata_warnings || []), ...rollback.progressErrors];
    }
    recovery.uncertain_operations = rollback.failures.map(({ error: _error, ...operation }) => operation);
    recovery.status = rollback.failures.length ? "rollback_failed" : "rollback_complete";
    let finalMetadataPersisted = false;
    try {
      await persistBackupSnapshot(backup.target, backup.snapshot);
      finalMetadataPersisted = true;
    } catch (metadataError) {
      recovery.metadata_error = errorDetails(metadataError);
    }

    if (rollback.failures.length || !finalMetadataPersisted) {
      recovery.recovery_token = backup.token;
      recovery.backup_retained = true;
      error.recovery = recovery;
      error.status = 500;
      console.error("[FELTUS CODE] Change set apply recovery incomplete.", {
        change_set_id: normalized.id,
        recovery_token: backup.token,
        apply_error: recovery.apply_error,
        rollback_errors: recovery.rollback_errors,
        uncertain_operations: recovery.uncertain_operations,
        metadata_error: recovery.metadata_error || null
      });
    } else {
      try {
        await fs.rm(backup.target, { force: true });
        error.recovery = {
          ...recovery,
          recovery_token: backup.token,
          backup_retained: false
        };
      } catch (cleanupError) {
        recovery.metadata_error = errorDetails(cleanupError);
        recovery.recovery_token = backup.token;
        recovery.backup_retained = true;
        error.recovery = recovery;
        error.status = 500;
        console.error("[FELTUS CODE] Change set rollback completed but recovery backup cleanup failed.", {
          change_set_id: normalized.id,
          recovery_token: backup.token,
          apply_error: recovery.apply_error,
          cleanup_error: recovery.metadata_error
        });
      }
    }
    throw error;
  }
}

export async function undoChangeSet({ repoRoot, token, confirm = false }) {
  if (!confirm) throw fail("Explicit confirmation is required before undoing a change set.", "CONFIRMATION_REQUIRED");
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ""))) throw fail("A valid undo reference is required.", "INVALID_UNDO_TOKEN");
  const target = await backupPath(repoRoot, token);
  const snapshot = JSON.parse(await fs.readFile(target, "utf8"));
  if (snapshot.token !== token || snapshot.used_at) throw fail("This undo reference is unavailable.", "UNDO_NOT_AVAILABLE");
  await verifyUndoSnapshot(repoRoot, snapshot);
  await restoreOperations(repoRoot, snapshot.operations, { verifyAfter: true });
  snapshot.used_at = new Date().toISOString();
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fs.rename(temporary, target);
  return {
    change_set_id: snapshot.change_set_id,
    summary: snapshot.summary,
    restored: snapshot.operations.map(operation => operation.type === "rename" ? operation.from : operation.path),
    ...(snapshot.feltus_design ? { feltus_design: snapshot.feltus_design } : {})
  };
}

async function verifyUndoSnapshot(repoRoot, snapshot) {
  const files = createFileTools({ repoRoot });
  for (const operation of snapshot.operations || []) {
    const currentPath = operation.type === "rename" ? operation.to : operation.path;
    const current = await inspectOptional(files, currentPath);
    if (operation.after_sha256) {
      if (!current || current.sha256 !== operation.after_sha256) throw fail(`Cannot undo because this file changed after the change set: ${currentPath}`, "UNDO_CONFLICT");
    } else if (current) {
      throw fail(`Cannot undo because the deleted path now exists: ${currentPath}`, "UNDO_CONFLICT");
    }
  }
}

export async function inspectChangeSetUndo({ repoRoot, token }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ""))) throw fail("A valid undo reference is required.", "INVALID_UNDO_TOKEN");
  const target = await backupPath(repoRoot, token);
  const snapshot = JSON.parse(await fs.readFile(target, "utf8"));
  if (snapshot.token !== token || snapshot.used_at) throw fail("This undo reference is unavailable.", "UNDO_NOT_AVAILABLE");
  await verifyUndoSnapshot(repoRoot, snapshot);
  return {
    change_set_id: snapshot.change_set_id,
    summary: snapshot.summary,
    paths: snapshot.operations.map(operation => operation.type === "rename" ? operation.from : operation.path),
    ...(snapshot.feltus_design ? { feltus_design: snapshot.feltus_design } : {})
  };
}

export async function updateDesignUndoMetadata({ repoRoot, token, metadata }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ""))) throw fail("A valid undo reference is required.", "INVALID_UNDO_TOKEN");
  if (metadata?.contract !== "feltus.design-change/v1" || !metadata.application_id || !metadata.before_state || !metadata.after_state) {
    throw fail("Updated undo metadata must contain a complete Design State transition.", "DESIGN_UNDO_STATE_MISMATCH");
  }
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 48000) throw fail("Design undo metadata exceeds the safe change-set limit.", "DESIGN_STATE_TOO_LARGE");
  const target = await backupPath(repoRoot, token);
  const snapshot = JSON.parse(await fs.readFile(target, "utf8"));
  const existing = snapshot.feltus_design;
  if (snapshot.token !== token || snapshot.used_at || existing?.contract !== metadata.contract || existing.application_id !== metadata.application_id || existing.before_state_hash !== metadata.before_state_hash) {
    throw fail("The undo reference does not match this Design State transition.", "DESIGN_UNDO_STATE_MISMATCH");
  }
  await verifyUndoSnapshot(repoRoot, snapshot);
  snapshot.feltus_design = JSON.parse(JSON.stringify(metadata));
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fs.rename(temporary, target);
}
