import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const container = process.env.FELTUS_CP_TEST_DB_CONTAINER || "feltus-cp-test-db";

const sql = String.raw`
BEGIN;

DO $$
DECLARE
  v_org_id uuid;
  v_deployment_id uuid := gen_random_uuid();
  v_complete_deployment_id uuid := gen_random_uuid();
  v_exclusive_deployment_id uuid := gen_random_uuid();
  v_outbox_id uuid;
  v_complete_outbox_id uuid;
  v_lease_token uuid;
  v_complete_lease_token uuid;
  v_idempotency text := 'cp-test-' || gen_random_uuid()::text;
  v_complete_idempotency text := 'cp-complete-' || gen_random_uuid()::text;
  v_exclusive_idempotency text := 'cp-exclusive-' || gen_random_uuid()::text;
  v_count integer;
  v_ok boolean;
  v_audit_id bigint;
BEGIN
  SELECT organization_id
  INTO v_org_id
  FROM public.feltus_applications
  WHERE id = '10000000-0000-0000-0000-000000000001';

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Validation fixture project is missing';
  END IF;

  -- Verified artifact deployment + transactional outbox.
  INSERT INTO public.feltus_deployments (
    id,
    app_id,
    owner_id,
    environment,
    status,
    provider,
    organization_id,
    environment_id,
    artifact_id,
    requested_by,
    idempotency_key
  )
  VALUES (
    v_deployment_id,
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'development',
    'QUEUED',
    'coolify',
    v_org_id,
    '44347f33-6bf9-45e2-8047-7c4f62b3d105',
    '60000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001',
    v_idempotency
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.feltus_deployments
    WHERE id = v_deployment_id
      AND status = 'QUEUED'
      AND request_fingerprint ~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'Verified deployment or fingerprint validation failed';
  END IF;

  SELECT id
  INTO v_outbox_id
  FROM public.feltus_infrastructure_outbox
  WHERE deployment_id = v_deployment_id
    AND command_type = 'deploy_artifact'
    AND state = 'pending';

  IF v_outbox_id IS NULL THEN
    RAISE EXCEPTION 'Transactional deployment outbox creation failed';
  END IF;

  -- Deployment immutability.
  BEGIN
    UPDATE public.feltus_deployments
    SET environment = 'staging'
    WHERE id = v_deployment_id;

    RAISE EXCEPTION 'Deployment immutability failed';
  EXCEPTION
    WHEN OTHERS THEN
      IF position('immutable' in SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  -- Duplicate idempotency.
  BEGIN
    INSERT INTO public.feltus_deployments (
      id, app_id, owner_id, environment, status, provider,
      organization_id, environment_id, artifact_id,
      requested_by, idempotency_key
    )
    VALUES (
      gen_random_uuid(),
      '10000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001',
      'development',
      'QUEUED',
      'coolify',
      v_org_id,
      '44347f33-6bf9-45e2-8047-7c4f62b3d105',
      '60000000-0000-0000-0000-000000000002',
      '20000000-0000-0000-0000-000000000001',
      v_idempotency
    );

    RAISE EXCEPTION 'Duplicate idempotency key was allowed';
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;

  -- Revoked artifact cannot deploy.
  BEGIN
    INSERT INTO public.feltus_deployments (
      id, app_id, owner_id, environment, status, provider,
      organization_id, environment_id, artifact_id,
      requested_by, idempotency_key
    )
    VALUES (
      gen_random_uuid(),
      '10000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001',
      'development',
      'QUEUED',
      'coolify',
      v_org_id,
      '44347f33-6bf9-45e2-8047-7c4f62b3d105',
      '60000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001',
      'cp-revoked-' || gen_random_uuid()::text
    );

    RAISE EXCEPTION 'Revoked artifact deployment was allowed';
  EXCEPTION
    WHEN OTHERS THEN
      IF position('Only a verified artifact' in SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  -- Artifact deployment requires idempotency.
  BEGIN
    INSERT INTO public.feltus_deployments (
      id, app_id, owner_id, environment, status, provider,
      organization_id, environment_id, artifact_id, requested_by
    )
    VALUES (
      gen_random_uuid(),
      '10000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001',
      'development',
      'QUEUED',
      'coolify',
      v_org_id,
      '44347f33-6bf9-45e2-8047-7c4f62b3d105',
      '60000000-0000-0000-0000-000000000002',
      '20000000-0000-0000-0000-000000000001'
    );

    RAISE EXCEPTION 'Missing deployment idempotency was allowed';
  EXCEPTION
    WHEN OTHERS THEN
      IF position('require an idempotency key' in SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  -- Sensitive payload keys must be rejected.
  BEGIN
    UPDATE public.feltus_infrastructure_outbox
    SET command_payload = '{"token":"must-fail"}'::jsonb
    WHERE id = v_outbox_id;

    RAISE EXCEPTION 'Sensitive outbox payload key was allowed';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  -- Force this task to the front of the disposable queue.
  UPDATE public.feltus_infrastructure_outbox
  SET available_at = '2000-01-01 UTC'
  WHERE id = v_outbox_id;

  SELECT id, lease_token
  INTO v_outbox_id, v_lease_token
  FROM public.feltus_claim_infrastructure_outbox(
    'permanent-validation-worker',
    1,
    300
  );

  IF v_lease_token IS NULL THEN
    RAISE EXCEPTION 'Outbox claim failed';
  END IF;

  SELECT public.feltus_heartbeat_infrastructure_outbox(
    v_outbox_id,
    gen_random_uuid(),
    300
  )
  INTO v_ok;

  IF v_ok THEN
    RAISE EXCEPTION 'Wrong lease token heartbeat succeeded';
  END IF;

  SELECT public.feltus_complete_infrastructure_outbox(
    v_outbox_id,
    gen_random_uuid(),
    'must-not-complete'
  )
  INTO v_ok;

  IF v_ok THEN
    RAISE EXCEPTION 'Wrong lease token completion succeeded';
  END IF;

  SELECT public.feltus_heartbeat_infrastructure_outbox(
    v_outbox_id,
    v_lease_token,
    300
  )
  INTO v_ok;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'Valid heartbeat failed';
  END IF;

  SELECT public.feltus_retry_infrastructure_outbox(
    v_outbox_id,
    v_lease_token,
    'VALIDATION_RETRY',
    true
  )
  INTO v_ok;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'Retry transition failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.feltus_infrastructure_outbox
    WHERE id = v_outbox_id
      AND state = 'pending'
      AND attempt_count = 1
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND last_error_code = 'VALIDATION_RETRY'
  ) THEN
    RAISE EXCEPTION 'Retry state validation failed';
  END IF;

  UPDATE public.feltus_infrastructure_outbox
  SET available_at = '2000-01-01 UTC'
  WHERE id = v_outbox_id;

  SELECT id, lease_token
  INTO v_outbox_id, v_lease_token
  FROM public.feltus_claim_infrastructure_outbox(
    'permanent-validation-worker',
    1,
    300
  );

  SELECT public.feltus_retry_infrastructure_outbox(
    v_outbox_id,
    v_lease_token,
    'VALIDATION_FATAL',
    false
  )
  INTO v_ok;

  IF NOT v_ok OR NOT EXISTS (
    SELECT 1
    FROM public.feltus_infrastructure_outbox
    WHERE id = v_outbox_id
      AND state = 'dead_letter'
      AND attempt_count = 2
      AND last_error_code = 'VALIDATION_FATAL'
  ) THEN
    RAISE EXCEPTION 'Dead-letter validation failed';
  END IF;

  -- Completion path.
  INSERT INTO public.feltus_deployments (
    id, app_id, owner_id, environment, status, provider,
    organization_id, environment_id, artifact_id,
    requested_by, idempotency_key
  )
  VALUES (
    v_complete_deployment_id,
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'development',
    'QUEUED',
    'coolify',
    v_org_id,
    '44347f33-6bf9-45e2-8047-7c4f62b3d105',
    '60000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001',
    v_complete_idempotency
  );

  SELECT id
  INTO v_complete_outbox_id
  FROM public.feltus_infrastructure_outbox
  WHERE deployment_id = v_complete_deployment_id;

  UPDATE public.feltus_infrastructure_outbox
  SET available_at = '1999-01-01 UTC'
  WHERE id = v_complete_outbox_id;

  SELECT id, lease_token
  INTO v_complete_outbox_id, v_complete_lease_token
  FROM public.feltus_claim_infrastructure_outbox(
    'permanent-complete-worker',
    1,
    300
  );

  SELECT public.feltus_complete_infrastructure_outbox(
    v_complete_outbox_id,
    v_complete_lease_token,
    'validation-op-permanent'
  )
  INTO v_ok;

  IF NOT v_ok OR NOT EXISTS (
    SELECT 1
    FROM public.feltus_infrastructure_outbox
    WHERE id = v_complete_outbox_id
      AND state = 'delivered'
      AND lease_owner IS NULL
      AND lease_token IS NULL
      AND provider_operation_id = 'validation-op-permanent'
      AND completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Outbox completion validation failed';
  END IF;

  -- Worker exclusivity.
  INSERT INTO public.feltus_deployments (
    id, app_id, owner_id, environment, status, provider,
    organization_id, environment_id, artifact_id,
    requested_by, idempotency_key
  )
  VALUES (
    v_exclusive_deployment_id,
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'development',
    'QUEUED',
    'coolify',
    v_org_id,
    '44347f33-6bf9-45e2-8047-7c4f62b3d105',
    '60000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001',
    v_exclusive_idempotency
  );

  UPDATE public.feltus_infrastructure_outbox
  SET available_at = '1998-01-01 UTC'
  WHERE deployment_id = v_exclusive_deployment_id;

  PERFORM *
  FROM public.feltus_claim_infrastructure_outbox(
    'permanent-worker-A',
    1,
    300
  );

  SELECT count(*)
  INTO v_count
  FROM public.feltus_claim_infrastructure_outbox(
    'permanent-worker-B',
    1,
    300
  );

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Second worker claimed an already leased task';
  END IF;

  -- Audit creation + append-only enforcement.
  SELECT id
  INTO v_audit_id
  FROM public.feltus_audit_events
  WHERE entity_id = v_deployment_id::text
    AND action_key = 'deployment.created'
  ORDER BY id
  LIMIT 1;

  IF v_audit_id IS NULL THEN
    RAISE EXCEPTION 'Deployment audit event was not created';
  END IF;

  BEGIN
    UPDATE public.feltus_audit_events
    SET action_key = 'tampered'
    WHERE id = v_audit_id;

    RAISE EXCEPTION 'Audit UPDATE was allowed';
  EXCEPTION
    WHEN OTHERS THEN
      IF position('append-only' in SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  BEGIN
    DELETE FROM public.feltus_audit_events
    WHERE id = v_audit_id;

    RAISE EXCEPTION 'Audit DELETE was allowed';
  EXCEPTION
    WHEN OTHERS THEN
      IF position('append-only' in SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  -- Grant boundaries.
  IF has_table_privilege(
    'service_role',
    'public.feltus_infrastructure_outbox',
    'SELECT,INSERT,UPDATE,DELETE'
  ) THEN
    RAISE EXCEPTION 'service_role has forbidden direct outbox table privileges';
  END IF;

  IF has_table_privilege(
    'authenticated',
    'public.feltus_infrastructure_outbox',
    'SELECT,INSERT,UPDATE,DELETE'
  ) THEN
    RAISE EXCEPTION 'authenticated has forbidden direct outbox table privileges';
  END IF;

  IF has_table_privilege(
    'authenticated',
    'public.feltus_deployments',
    'INSERT,UPDATE,DELETE'
  ) THEN
    RAISE EXCEPTION 'authenticated has forbidden direct deployment write privileges';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.feltus_claim_infrastructure_outbox(text,integer,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role cannot execute controlled outbox worker function';
  END IF;

  RAISE NOTICE 'PASS_DEPLOYMENT_CONTROL_PLANE';
END
$$;

ROLLBACK;
`;

const result = spawnSync(
  "docker",
  [
    "exec",
    "-i",
    container,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "postgres"
  ],
  {
    input: sql,
    encoding: "utf8"
  }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

assert.equal(
  result.status,
  0,
  `Deployment control plane PostgreSQL validation failed with exit code ${result.status}`
);

assert.match(
  `${result.stdout}\n${result.stderr}`,
  /PASS_DEPLOYMENT_CONTROL_PLANE/
);

process.stdout.write(
  "PASS deployment control plane PostgreSQL integration tests\n"
);
