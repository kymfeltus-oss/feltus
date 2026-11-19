import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { removeApplicationDirectory, removeApplicationLocalFiles } from "../src/lib/feltus-application-filesystem-cleanup.js";
import { createApplicationCleanupClient } from "../src/lib/feltus-application-cleanup-worker.js";

const appId = randomUUID();
const siblingId = randomUUID();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "feltus-application-lifecycle-"));
const documents = path.join(root, "documents");
const code = path.join(root, "code");
const backups = path.join(root, "backups");
const outside = path.join(root, "outside");
for (const item of [documents, code, backups, outside]) fs.mkdirSync(item, { recursive: true });
fs.mkdirSync(path.join(documents, appId));
fs.mkdirSync(path.join(code, appId, "src"), { recursive: true });
fs.mkdirSync(path.join(backups, appId));
fs.mkdirSync(path.join(code, siblingId));
fs.writeFileSync(path.join(documents, appId, "private.txt"), "app data");
fs.writeFileSync(path.join(code, appId, "src", "main.js"), "export default 1;");
fs.writeFileSync(path.join(backups, appId, "backup.json"), "{}");
fs.writeFileSync(path.join(code, siblingId, "keep.txt"), "sibling");
fs.writeFileSync(path.join(outside, "keep.txt"), "outside");

try {
  const removed = removeApplicationLocalFiles({ appId, documentStorageRoot: documents, codeWorkspaceRoot: code, backupStorageRoot: backups });
  assert.equal(removed.documents.removed, true);
  assert.equal(removed.code_workspace.removed, true);
  assert.equal(removed.backups.removed, true);
  assert.equal(fs.existsSync(path.join(documents, appId)), false);
  assert.equal(fs.existsSync(path.join(code, appId)), false);
  assert.equal(fs.existsSync(path.join(backups, appId)), false);
  assert.equal(fs.readFileSync(path.join(code, siblingId, "keep.txt"), "utf8"), "sibling");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "outside");
  assert.deepEqual(removeApplicationLocalFiles({ appId, documentStorageRoot: documents, codeWorkspaceRoot: code }), {
    documents: { removed: false, missing: true }, code_workspace: { removed: false, missing: true }
  }, "repeat cleanup is idempotent");
  assert.throws(() => removeApplicationDirectory(code, "../" + appId), e => e.code === "APP_CLEANUP_INVALID_ID");

  const target = path.join(code, appId);
  try {
    fs.symlinkSync(outside, target, "junction");
    assert.throws(() => removeApplicationDirectory(code, appId), e => e.code === "APP_CLEANUP_PATH_UNSAFE");
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "outside");
    fs.unlinkSync(target);
    console.log("PASS symlink escape rejected");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error?.code)) throw error;
    console.log("SKIPPED target symlink test: junction creation unavailable (" + error.code + ")");
  }

  const nested = path.join(code, appId);
  fs.mkdirSync(nested);
  try {
    fs.symlinkSync(outside, path.join(nested, "external-link"), "junction");
    removeApplicationDirectory(code, appId);
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "outside");
    console.log("PASS nested link is unlinked without following it");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error?.code)) throw error;
    fs.rmSync(nested, { recursive: true, force: true });
    console.log("SKIPPED nested symlink test: junction creation unavailable (" + error.code + ")");
  }

  const migration = readFileSync(new URL("../supabase/migrations/20261108010000_feltus_application_lifecycle.sql", import.meta.url), "utf8");
  const buildCancellationMigration = readFileSync(new URL("../supabase/migrations/20261108020000_feltus_allow_lifecycle_build_cancellation.sql", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  const workerApi = readFileSync(new URL("../src/lib/feltus-application-cleanup-worker.js", import.meta.url), "utf8");
  const api = readFileSync(new URL("../src/lib/feltus-app-wizard.js", import.meta.url), "utf8");
  const postgresRegression = readFileSync(new URL("./application-lifecycle-postgres-tests.sql", import.meta.url), "utf8");
  const cleanup = migration.match(/CREATE OR REPLACE FUNCTION public\.feltus_complete_application_cleanup[\s\S]*?\n\$\$;/)?.[0] || "";
  const ownerMembershipGuard = migration.match(/CREATE OR REPLACE FUNCTION public\.feltus_protect_project_owner_membership[\s\S]*?\n\$\$;/)?.[0] || "";
  const impact = migration.match(/CREATE OR REPLACE FUNCTION public\.feltus_application_deletion_impact[\s\S]*?\n\$\$;/)?.[0] || "";
  const request = migration.match(/CREATE OR REPLACE FUNCTION public\.feltus_request_application_deletion[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.ok(cleanup);
  assert.ok(ownerMembershipGuard);
  assert.match(ownerMembershipGuard, /v_lifecycle_status = 'cleanup_in_progress'/);
  assert.match(ownerMembershipGuard, /current_setting\('feltus\.lifecycle_internal', true\) = 'on'/);
  assert.match(ownerMembershipGuard, /COALESCE\(auth\.role\(\), ''\) = 'service_role'/);
  assert.match(cleanup, /set_config\('feltus\.lifecycle_internal','on',true\)[\s\S]*DELETE FROM public\.feltus_project_memberships/);
  assert.doesNotMatch(cleanup, /\bCASCADE\b/i);
  assert.match(cleanup, /WHERE id=p_app_id AND lifecycle_request_id=p_request_id/);
  assert.match(cleanup, /preserved_blueprints/);
  for (const group of ["will_be_deleted", "will_be_preserved", "will_be_detached", "external_not_touched"]) assert.ok(impact.includes(group));
  assert.doesNotMatch(impact, /ciphertext|secret_value|secret_payload/i);
  assert.match(request, /auth\.uid\(\) IS NULL/);
  assert.match(request, /owner_id = auth\.uid\(\)/);
  assert.match(request, /p_confirmation IS DISTINCT FROM v_app\.app_name/);
  assert.match(request, /'application\.cleanup'/);
  assert.match(request, /ON CONFLICT \(app_id, owner_id, idempotency_key\)/);
  assert.match(migration, /WHEN app\.lifecycle_status IN \('requested','validated','tombstoned'/);
  assert.match(migration, /UPDATE public\.feltus_project_repositories SET detached_at=now\(\)/);
  assert.match(migration, /UPDATE public\.feltus_deployment_targets SET active=false/);
  assert.match(migration, /UPDATE public\.feltus_environments SET status='suspended'/);
  assert.doesNotMatch(migration, /DELETE FROM public\.feltus_(repositories|git_connections|deployment_targets|deployment_domains|artifacts)/);
  assert.doesNotMatch(migration, /\b(CREATE|DROP)\s+POLICY\b|\b(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY\b/i);
  const jobClaim = migration.match(/CREATE OR REPLACE FUNCTION public\.feltus_claim_jobs\([\s\S]*?\n\$\$;/)?.[0] || "";
  const buildClaim = migration.match(/CREATE OR REPLACE FUNCTION public\.feltus_claim_builds\([\s\S]*?\n\$\$;/)?.[0] || "";
  const providerClaim = migration.match(/CREATE OR REPLACE FUNCTION public\.feltus_claim_infrastructure_outbox\([\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(jobClaim, /job\.job_type='application\.cleanup' OR EXISTS/);
  assert.match(buildClaim, /app\.lifecycle_status='active'/);
  assert.match(providerClaim, /app\.lifecycle_status='active'/);
  assert.match(buildCancellationMigration, /OLD\.status = 'queued'[\s\S]*NEW\.status = 'cancelled'[\s\S]*feltus\.lifecycle_internal/);
  assert.match(buildCancellationMigration, /app\.lifecycle_status = 'cleanup_pending'[\s\S]*app\.lifecycle_request_id IS NOT NULL/);
  assert.match(buildCancellationMigration, /COALESCE\(auth\.role\(\), ''\) = 'service_role' OR auth\.uid\(\) = app\.owner_id/);
  assert.doesNotMatch(buildCancellationMigration, /\b(CREATE|DROP)\s+POLICY\b|\b(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY\b/i);
  assert.match(postgresRegression, /feltus_claim_jobs\('phase-d-lifecycle-worker'/);
  assert.match(postgresRegression, /feltus_claim_builds\('phase-d-lifecycle-worker'/);
  assert.match(postgresRegression, /feltus_claim_infrastructure_outbox\('phase-d-lifecycle-worker'/);
  assert.match(postgresRegression, /Normal operations removed the project owner membership/);
  assert.match(postgresRegression, /Application-owned model or document data survived cleanup/);
  assert.match(server, /removeApplicationLocalFiles\(\{[\s\S]{0,200}documentStorageRoot: DOCUMENT_STORAGE_ROOT,[\s\S]{0,150}codeWorkspaceRoot: CODE_WORKSPACE_ROOT/);
  assert.match(worker, /job\.job_type === "application\.cleanup"/);
  assert.match(worker, /createApplicationCleanupClient/);
  assert.match(workerApi, /\/api\/internal\/application-cleanup/);
  assert.match(api, /feltus_request_application_deletion/);
  console.log("PASS lifecycle authorization, state, audit-retention, and external-boundary contracts");

  const calls = [];
  const runCleanup = createApplicationCleanupClient({
    apiUrl: "http://app:8080/",
    serviceKey: "test-service-key",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ status: "cleanup_complete" }) };
    }
  });
  const requestId = randomUUID();
  assert.deepEqual(await runCleanup({ app_id: appId, payload: { request_id: requestId } }), { status: "cleanup_complete" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://app:8080/api/internal/application-cleanup");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-service-key");
  assert.deepEqual(JSON.parse(calls[0].options.body), { app_id: appId, request_id: requestId });
  await assert.rejects(runCleanup({ app_id: "../" + appId, payload: { request_id: requestId } }), error =>
    error.code === "APP_CLEANUP_INVALID_JOB" && error.retryable === false);
  assert.equal(calls.length, 1, "invalid app IDs fail before the cleanup route is called");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("Application lifecycle tests passed.");
