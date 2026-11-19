import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";
import {
  createAppBackupArtifact,
  createAppBackupHandler,
  loadAppBackupArtifact
} from "../src/lib/feltus-app-backup-restore.js";
import { removeApplicationLocalFiles } from "../src/lib/feltus-application-filesystem-cleanup.js";

dotenv.config();

function localConfig() {
  let gateway = process.env.FELTUS_GATEWAY_URL || "";
  let apiKey = process.env.FELTUS_PUBLISHABLE_KEY || process.env.FELTUS_API_KEY || "";
  let serviceKey = process.env.FELTUS_SERVICE_ROLE_KEY || "";
  if (!gateway || !apiKey || !serviceKey) {
    try {
      const environment = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      for (const line of environment.split(/\r?\n/)) {
        const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (!match) continue;
        const value = match[2].replace(/^["']|["']$/g, "");
        if (match[1] === "API_URL") gateway ||= value;
        if (match[1] === "ANON_KEY") apiKey ||= value;
        if (match[1] === "SERVICE_ROLE_KEY") serviceKey ||= value;
      }
    } catch { /* The explicit blocker below reports unavailable local services. */ }
  }
  return { gateway: gateway || "http://127.0.0.1:54321", apiKey, serviceKey };
}

function localQuery(sql) {
  const output = execFileSync("supabase", ["db", "query", "--local", "--output-format", "json", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const jsonStart = output.indexOf("{");
  if (jsonStart < 0) throw new Error("The isolated local database query returned no result.");
  const result = JSON.parse(output.slice(jsonStart));
  if (result.error) throw new Error("The isolated local database query failed.");
  return Array.isArray(result.rows) ? result.rows : [];
}

function check(name, callback) {
  try {
    callback();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const artifactAppId = "11111111-1111-4111-8111-111111111111";
const artifactBackupId = "22222222-2222-4222-8222-222222222222";
const artifactOwnerId = "33333333-3333-4333-8333-333333333333";
const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feltus-backup-artifact-"));
const emptySnapshot = { models: [], columns: [], relationships: [], documents: [], document_chunks: [], files: [] };
const localArtifact = createAppBackupArtifact({
  storageRoot: artifactRoot,
  appId: artifactAppId,
  backupId: artifactBackupId,
  ownerId: artifactOwnerId,
  snapshot: emptySnapshot
});
check("versioned app backup artifact round-trips with checksum", () => {
  const loaded = loadAppBackupArtifact(artifactRoot, artifactAppId, artifactBackupId);
  assert.equal(loaded.manifest.version, 1);
  assert.equal(loaded.manifest.app_id, artifactAppId);
  assert.equal(loaded.manifest.checksum, localArtifact.checksum);
});
check("corrupt backup artifact is rejected", () => {
  fs.writeFileSync(localArtifact.archivePath, '{"format":"feltus.app-backup/v1","manifest":{},"snapshot":{}}');
  assert.throws(() => loadAppBackupArtifact(artifactRoot, artifactAppId, artifactBackupId), error =>
    error.code === "APP_BACKUP_INVALID_ARCHIVE" || error.code === "APP_BACKUP_CHECKSUM_MISMATCH");
});
fs.rmSync(artifactRoot, { recursive: true, force: false });

const { gateway, apiKey, serviceKey } = localConfig();
let gatewayUrl;
try { gatewayUrl = new URL(gateway); }
catch {
  process.stderr.write("BLOCKED local app backup E2E: local database URL is invalid.\n");
  process.exitCode = 1;
}
if (!gatewayUrl || !["localhost", "127.0.0.1", "::1"].includes(gatewayUrl.hostname) || !apiKey || !serviceKey) {
  process.stderr.write("BLOCKED local app backup E2E: start the local Supabase stack and configure its local keys.\n");
  process.exitCode = 1;
} else {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feltus-app-backup-e2e-"));
  const storageRoot = path.join(testRoot, "storage");
  const documentStorageRoot = path.join(storageRoot, "documents");
  const backupStorageRoot = path.join(storageRoot, "app-backups");
  const codeWorkspaceRoot = path.join(storageRoot, "code-workspaces");
  const ownerEmail = `feltus-backup-${crypto.randomUUID()}@example.invalid`;
  const generatedEmail = `feltus-generated-${crypto.randomUUID()}@example.invalid`;
  const password = crypto.randomBytes(32).toString("base64url");
  const identities = [];
  const apps = [];
  let actor = null;
  let handler = null;
  let cleanupPassed = true;

  async function request(endpoint, { method = "GET", body, token = serviceKey, isService = true, prefer = "", withStatus = false } = {}) {
    const response = await fetch(new URL(endpoint, gatewayUrl), {
      method,
      headers: {
        apikey: isService ? serviceKey : apiKey,
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(prefer ? { Prefer: prefer } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const diagnostic = [data?.code, data?.message].filter(value => typeof value === "string" && value).join(": ");
      throw Object.assign(new Error(`${method} ${endpoint} failed with HTTP ${response.status}${diagnostic ? ` (${diagnostic})` : ""}.`), {
        status: response.status,
        data
      });
    }
    return withStatus ? { status: response.status, data } : data;
  }

  async function createIdentity(email, appMetadata = {}) {
    const user = await request("/auth/v1/admin/users", {
      method: "POST",
      body: { email, password, email_confirm: true, app_metadata: appMetadata }
    });
    identities.push(user.id);
    const session = await request("/auth/v1/token?grant_type=password", {
      method: "POST",
      isService: false,
      token: apiKey,
      body: { email, password }
    });
    return { id: user.id, token: session.access_token };
  }

  async function createApp(owner, name) {
    const appId = crypto.randomUUID();
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    const sql = `INSERT INTO public.feltus_applications (id, owner_id, app_name, app_type, setup_status, setup_current_step, setup_data, lifecycle_status) VALUES (${quote(appId)}::uuid, ${quote(owner.id)}::uuid, ${quote(name)}, 'other', 'active', 'basics', '{}'::jsonb, 'active') RETURNING id`;
    localQuery(sql);
    const app = {
      id: appId,
      owner_id: owner.id,
      app_name: name
    };
    apps.push(app);
    const verified = await request(`/rest/v1/feltus_applications?select=id,owner_id,organization_id,app_name,lifecycle_status&id=eq.${appId}&limit=1`, {
      isService: false,
      token: owner.token
    });
    Object.assign(app, Array.isArray(verified) ? verified[0] : {});
    assert.ok(app?.id, "the isolated test app was created in local Postgres");
    return app;
  }

  async function invoke(pathname, method = "GET") {
    const result = { status: null, headers: {}, text: "" };
    const response = {
      writeHead(status, headers = {}) { result.status = status; result.headers = headers; },
      end(text) { result.text = String(text || ""); }
    };
    await handler({ method, headers: {} }, response, new URL(pathname, "http://feltus.test"));
    return {
      ...result,
      body: result.headers["Content-Type"]?.startsWith("application/json") ? JSON.parse(result.text) : null
    };
  }

  async function cleanupApp(owner, app) {
    const requested = await request("/rest/v1/rpc/feltus_request_application_deletion", {
      method: "POST",
      isService: false,
      token: owner.token,
      body: { p_app_id: app.id, p_confirmation: app.app_name }
    });
    const requestId = requested.request_id;
    if (!requestId) throw new Error("The isolated app cleanup request was not recorded.");
    await request("/rest/v1/rpc/feltus_start_application_cleanup", {
      method: "POST",
      body: { p_app_id: app.id, p_request_id: requestId }
    });
    removeApplicationLocalFiles({
      appId: app.id,
      documentStorageRoot,
      codeWorkspaceRoot,
      backupStorageRoot
    });
    await request("/rest/v1/rpc/feltus_mark_application_files_removed", {
      method: "POST",
      body: { p_app_id: app.id, p_request_id: requestId }
    });
    await request("/rest/v1/rpc/feltus_complete_application_cleanup", {
      method: "POST",
      body: { p_app_id: app.id, p_request_id: requestId }
    });
    const remaining = await request(`/rest/v1/feltus_app_backups?select=id&app_id=eq.${app.id}`);
    assert.equal(remaining.length, 0, "app cleanup removes durable backup history");
  }

  try {
    const owner = await createIdentity(ownerEmail);
    actor = owner;
    const health = await request("/rest/v1/feltus_applications?select=id&limit=1", {
      isService: false,
      token: owner.token
    });
    assert.ok(Array.isArray(health));
    const appA = await createApp(owner, `Backup E2E ${crypto.randomUUID()}`);
    const appB = await createApp(owner, `Backup E2E B ${crypto.randomUUID()}`);

    const model = await request("/rest/v1/rpc/feltus_create_model", {
      method: "POST",
      isService: false,
      token: owner.token,
      body: {
        p_app_id: appA.id,
        p_table_name: "customers",
        p_columns: [{ name: "name", type: "text", nullable: false }],
        p_enable_rls: true
      }
    });
    assert.ok(model?.id && model?.physical_table_name);
    assert.match(model.physical_table_name, /^fm_[0-9a-f]{8}_[a-z][a-z0-9_]{0,39}$/);
    const table = `public."${model.physical_table_name}"`;
    const originalRows = localQuery(`INSERT INTO ${table} (owner_id, name) VALUES ('${owner.id}'::uuid, 'Original customer') RETURNING id::text`);
    const originalRow = originalRows[0];
    assert.ok(originalRow?.id);

    const documentId = crypto.randomUUID();
    const storedName = `${documentId}.txt`;
    const fileContent = Buffer.from("Original private app file.");
    const fileDirectory = path.join(documentStorageRoot, appA.id);
    fs.mkdirSync(fileDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(fileDirectory, storedName), fileContent, { flag: "wx", mode: 0o600 });
    await request("/rest/v1/rpc/feltus_register_document", {
      method: "POST",
      isService: false,
      token: owner.token,
      body: {
        p_app_id: appA.id,
        p_original_name: "private.txt",
        p_stored_name: storedName,
        p_storage_key: `${appA.id}/${storedName}`,
        p_mime_type: "text/plain",
        p_size_bytes: fileContent.length,
        p_sha256: crypto.createHash("sha256").update(fileContent).digest("hex"),
        p_metadata: { storage: "feltus-local-private", extension: ".txt" }
      }
    });

    handler = createAppBackupHandler({
      storageRoot,
      documentStorageRoot,
      serviceRequest: (endpoint, options) => request(endpoint, { ...options, isService: true, withStatus: true }),
      getUser: () => actor,
      authorizeApp: async appId => {
        const rows = await request(`/rest/v1/feltus_applications?select=id,owner_id,organization_id,lifecycle_status&id=eq.${appId}&limit=1`, {
          isService: false,
          token: actor.token
        });
        return Array.isArray(rows) ? rows[0] || null : null;
      }
    });

    const sensitivePath = path.join(testRoot, "private", "service-role-key.txt");
    const errorHandler = createAppBackupHandler({
      storageRoot,
      documentStorageRoot,
      serviceRequest: async () => ({ status: 200, data: [] }),
      getUser: () => owner,
      authorizeApp: async () => { throw new Error(sensitivePath); }
    });
    const errorResponse = { status: null, text: "" };
    await errorHandler(
      { method: "GET", headers: {} },
      {
        writeHead(status) { errorResponse.status = status; },
        end(text) { errorResponse.text = String(text || ""); }
      },
      new URL(`/api/apps/${appA.id}/backups`, "http://feltus.test")
    );
    assert.equal(errorResponse.status, 500);
    assert.equal(JSON.parse(errorResponse.text).error, "FELTUS could not complete this backup action.");
    assert.equal(errorResponse.text.includes(testRoot), false, "unexpected errors must not expose private filesystem paths");
    process.stdout.write("PASS unexpected backup API errors do not expose private paths\n");

    const created = await invoke(`/api/apps/${appA.id}/backups`, "POST");
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.backup.status, "available");
    assert.equal(created.body.backup.restore_eligible, true);
    const backupId = created.body.backup.id;
    const listed = await invoke(`/api/apps/${appA.id}/backups`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.backups[0].id, backupId);
    const status = await invoke(`/api/apps/${appA.id}/backups/${backupId}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.backup.status, "available");
    process.stdout.write("PASS real local app backup is Available with durable history, model data, private files, and integrity manifest\n");

    actor = null;
    const unauthenticatedCreate = await invoke(`/api/apps/${appA.id}/backups`, "POST");
    const unauthenticatedRestore = await invoke(`/api/apps/${appA.id}/backups/${backupId}/restore`, "POST");
    assert.equal(unauthenticatedCreate.status, 401);
    assert.equal(unauthenticatedRestore.status, 401);
    actor = owner;
    process.stdout.write("PASS unauthenticated users cannot create or restore app backups\n");

    localQuery(`UPDATE ${table} SET name = 'Changed customer' WHERE id = '${originalRow.id}'::uuid RETURNING id`);
    fs.unlinkSync(path.join(fileDirectory, storedName));

    const crossApp = await invoke(`/api/apps/${appB.id}/backups/${backupId}/restore`, "POST");
    assert.equal(crossApp.status, 404, "App B cannot restore App A backup");

    const generated = await createIdentity(generatedEmail, {
      feltus_identity_type: "generated_app",
      feltus_app_id: appA.id
    });
    actor = generated;
    const generatedCreate = await invoke(`/api/apps/${appA.id}/backups`, "POST");
    const generatedRestore = await invoke(`/api/apps/${appA.id}/backups/${backupId}/restore`, "POST");
    assert.ok([403, 404].includes(generatedCreate.status));
    assert.ok([403, 404].includes(generatedRestore.status));
    actor = owner;

    const restoreAttempts = await Promise.all([
      invoke(`/api/apps/${appA.id}/backups/${backupId}/restore`, "POST"),
      invoke(`/api/apps/${appA.id}/backups/${backupId}/restore`, "POST")
    ]);
    const restored = restoreAttempts.find(result => result.status === 200);
    const concurrentRestore = restoreAttempts.find(result => result.status === 409);
    assert.ok(restored, "one concurrent restore request completes");
    assert.ok(concurrentRestore, "a concurrent restore request is rejected");
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.backup.restore_status, "succeeded");
    assert.ok(restored.body.safety_backup_id);
    const safety = await request(`/rest/v1/feltus_app_backups?select=id,status,backup_kind&app_id=eq.${appA.id}&id=eq.${restored.body.safety_backup_id}`);
    assert.equal(safety[0]?.status, "available");
    assert.equal(safety[0]?.backup_kind, "safety_snapshot");
    const restoredRows = localQuery(`SELECT id::text, name FROM ${table} WHERE id = '${originalRow.id}'::uuid`);
    assert.equal(restoredRows[0]?.name, "Original customer");
    assert.equal(fs.readFileSync(path.join(fileDirectory, storedName), "utf8"), fileContent.toString("utf8"));
    process.stdout.write("PASS real local restore returned original data and private file after creating a safety snapshot\n");

    const archivePath = path.join(backupStorageRoot, appA.id, `${backupId}.json`);
    const corrupted = JSON.parse(fs.readFileSync(archivePath, "utf8"));
    corrupted.snapshot.files[0].content_base64 = Buffer.from("corrupted private data").toString("base64");
    fs.writeFileSync(archivePath, JSON.stringify(corrupted));
    const corruptRestore = await invoke(`/api/apps/${appA.id}/backups/${backupId}/restore`, "POST");
    assert.equal(corruptRestore.status, 400);
    assert.equal(corruptRestore.body.code, "APP_BACKUP_CHECKSUM_MISMATCH");
    process.stdout.write("PASS corrupt backup is rejected before restore\n");
    process.stdout.write("PASS App B and generated-app user are denied\n");
  } catch (error) {
    process.stderr.write(`FAIL real local app backup E2E: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    actor = actor && identities.length ? actor : null;
    if (apps.length && identities.length) {
      const ownerSession = await request("/auth/v1/token?grant_type=password", {
        method: "POST",
        isService: false,
        token: apiKey,
        body: { email: ownerEmail, password }
      }).catch(() => null);
      const owner = ownerSession?.access_token
        ? { id: identities[0], token: ownerSession.access_token }
        : null;
      if (!owner) {
        cleanupPassed = false;
        process.stderr.write("BLOCKED cleanup: could not renew the isolated test owner session.\n");
      } else {
        for (const app of apps) {
          try { await cleanupApp(owner, app); }
          catch (error) {
            cleanupPassed = false;
            process.stderr.write(`FAIL isolated app cleanup: ${error.message}\n`);
          }
        }
      }
    }
    for (const userId of identities) {
      try { await request(`/auth/v1/admin/users/${userId}`, { method: "DELETE" }); }
      catch {
        cleanupPassed = false;
        process.stderr.write("FAIL isolated test identity cleanup.\n");
      }
    }
    if (fs.existsSync(testRoot)) {
      const resolved = fs.realpathSync(testRoot);
      const temporaryRoot = path.resolve(os.tmpdir());
      if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith("feltus-app-backup-e2e-")) {
        cleanupPassed = false;
        process.stderr.write("FAIL isolated test file cleanup refused an unexpected path.\n");
      } else {
        fs.rmSync(resolved, { recursive: true, force: false });
      }
    }
    if (cleanupPassed) process.stdout.write("PASS isolated app, backup records, files, and test identities cleaned up\n");
    else process.exitCode = 1;
  }
}
