import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const container = process.env.FELTUS_CP_TEST_DB_CONTAINER || "feltus-cp-test-db";
const image = "postgres:17-alpine";
const database = process.env.FELTUS_CP_TEST_DB_NAME || "postgres";
const databaseUser = process.env.FELTUS_CP_TEST_DB_USER || "postgres";
let started = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options
  });
  if (result.error) throw result.error;
  return result;
}

function docker(args, options = {}) {
  const result = run("docker", args, options);
  if (result.status !== 0) {
    throw new Error(result.stderr || `docker ${args[0]} failed with exit code ${result.status}.`);
  }
  return result.stdout.trim();
}

function applySql(sql, label) {
  const result = run("docker", [
    "exec", "-i", container, "psql",
    "-v", "ON_ERROR_STOP=1",
    "-U", databaseUser,
    "-d", database
  ], { input: sql });
  if (result.status !== 0) {
    throw new Error(`${label} failed.\n${result.stderr || result.stdout}`);
  }
}

function inspectSafeContainer() {
  const raw = docker(["inspect", container]);
  const [details] = JSON.parse(raw);
  const networks = Object.keys(details.NetworkSettings?.Networks || {});
  const ports = Object.values(details.HostConfig?.PortBindings || {}).some(value => value?.length);
  const mounts = (details.Mounts || []).filter(mount => mount.Type !== "tmpfs");
  assert.equal(details.Config?.Image, image, "the certification container must use the pinned local Postgres test image");
  assert.equal(details.HostConfig?.NetworkMode, "none", "the certification container must have no network");
  assert.ok(networks.length === 0 || networks.every(name => name === "none"),
    "the certification container must not join a network");
  assert.equal(ports, false, "the certification container must publish no ports");
  assert.equal(mounts.length, 0, "the certification container must mount no host data");
  assert.equal(details.HostConfig?.AutoRemove, true, "the certification container must be disposable");
  return details.State?.Running === true;
}

try {
  const existing = run("docker", ["inspect", container]);
  assert.notEqual(existing.status, 0, `Refusing to reuse an existing container named ${container}.`);

  const imageExists = run("docker", ["image", "inspect", image]);
  assert.equal(imageExists.status, 0, `${image} must already be present locally; this harness does not pull images.`);

  docker([
    "run", "--detach", "--rm",
    "--name", container,
    "--network", "none",
    "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g",
    "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
    image
  ]);
  started = true;
  assert.equal(inspectSafeContainer(), true, "the new test container must pass isolation checks");

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = run("docker", [
      "exec", container, "pg_isready", "-U", databaseUser, "-d", database
    ]);
    if (result.status === 0) {
      ready = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(ready, true, "disposable PostgreSQL did not become ready");

  applySql(String.raw`
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
    END IF;
END
$$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY,
    aud text,
    role text,
    email text,
    encrypted_password text,
    confirmed_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz,
    raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
    raw_user_meta_data jsonb DEFAULT '{}'::jsonb
);
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')
$$;
`, "test-only Supabase role and auth bootstrap");

  const migrationsDirectory = path.join(root, "supabase", "migrations");
  const migrations = readdirSync(migrationsDirectory)
    .filter(name => /^\d+_.+\.sql$/.test(name))
    .sort();
  assert.ok(migrations.length > 0, "repository migrations are required to construct the test schema");
  for (const migration of migrations) {
    applySql(readFileSync(path.join(migrationsDirectory, migration), "utf8"), `Migration ${migration}`);
    process.stdout.write(`PASS isolated test schema: ${migration}\n`);
  }

  applySql(
    readFileSync(path.join(root, "scripts", "application-lifecycle-postgres-tests.sql"), "utf8"),
    "Rollback-only application lifecycle assertions"
  );
  process.stdout.write("PASS rollback-only application lifecycle PostgreSQL assertions\n");

  applySql(
    readFileSync(path.join(root, "scripts", "deployment-control-plane-test-fixture.sql"), "utf8"),
    "Synthetic deployment-control fixture"
  );
  process.stdout.write("PASS synthetic deployment-control fixtures loaded\n");

  const test = run(process.execPath, [
    path.join(root, "scripts", "deployment-control-plane-tests.mjs")
  ], {
    env: {
      ...process.env,
      FELTUS_CP_TEST_DB_CONTAINER: container,
      FELTUS_CP_TEST_DB_NAME: database,
      FELTUS_CP_TEST_DB_USER: databaseUser
    }
  });
  if (test.stdout) process.stdout.write(test.stdout);
  if (test.stderr) process.stderr.write(test.stderr);
  assert.equal(test.status, 0, "deployment-control PostgreSQL assertions failed");
} finally {
  if (started) {
    const stop = run("docker", ["stop", container]);
    if (stop.status !== 0) {
      process.stderr.write(`Could not stop the disposable test container ${container}.\n`);
      process.exitCode = 1;
    }
  }
}
