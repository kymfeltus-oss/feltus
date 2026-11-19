-- Disposable PostgreSQL runtime validation for Phase C.
-- Run only against an isolated test database with psql -v ON_ERROR_STOP=1 -f.
-- The transaction rolls back every synthetic user, app, and model table.
BEGIN;

DO $$
DECLARE
    v_owner_a UUID := gen_random_uuid();
    v_owner_b UUID := gen_random_uuid();
    v_org_a UUID;
    v_org_b UUID;
    v_app_a UUID := gen_random_uuid();
    v_app_b UUID := gen_random_uuid();
    v_model_a UUID := gen_random_uuid();
    v_model_b UUID := gen_random_uuid();
    v_table_a TEXT;
    v_table_b TEXT;
    v_environment UUID;
    v_blueprint UUID;
    v_git_connection UUID;
    v_repository UUID;
    v_artifact UUID;
    v_deployment UUID;
    v_request UUID;
    v_result JSONB;
    v_impact JSONB;
    v_denied BOOLEAN;
    v_status TEXT;
    v_setup_status TEXT;
    v_description TEXT;
    v_count BIGINT;
    v_before BIGINT;
    v_after BIGINT;
BEGIN
    IF NOT has_function_privilege('authenticated', 'public.feltus_set_application_archive(uuid,boolean)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.feltus_request_application_deletion(uuid,text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.feltus_request_application_deletion(uuid,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Lifecycle RPC grants are not scoped to authenticated users';
    END IF;

    INSERT INTO auth.users (id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
    VALUES
        (v_owner_a, 'authenticated', 'authenticated', v_owner_a::TEXT || '@phase-c.invalid', '', now(), now(), now()),
        (v_owner_b, 'authenticated', 'authenticated', v_owner_b::TEXT || '@phase-c.invalid', '', now(), now(), now());

    SELECT id INTO STRICT v_org_a FROM public.feltus_organizations WHERE personal_owner_id = v_owner_a;
    SELECT id INTO STRICT v_org_b FROM public.feltus_organizations WHERE personal_owner_id = v_owner_b;

    INSERT INTO public.feltus_applications (id, owner_id, app_name, organization_id, description, setup_data)
    VALUES
        (v_app_a, v_owner_a, 'Synthetic Lifecycle App A', v_org_a, 'retained until cleanup', '{"safe":true}'::jsonb),
        (v_app_b, v_owner_b, 'Synthetic Lifecycle App B', v_org_b, 'must remain untouched', '{"safe":true}'::jsonb);

    v_table_a := 'fm_' || substring(replace(v_model_a::TEXT, '-', '') FROM 1 FOR 8) || '_records';
    v_table_b := 'fm_' || substring(replace(v_model_b::TEXT, '-', '') FROM 1 FOR 8) || '_records';
    EXECUTE format('CREATE TABLE public.%I (id UUID PRIMARY KEY, value TEXT NOT NULL)', v_table_a);
    EXECUTE format('CREATE TABLE public.%I (id UUID PRIMARY KEY, value TEXT NOT NULL)', v_table_b);
    INSERT INTO public.feltus_models (id, app_id, owner_id, logical_name, physical_table_name)
    VALUES (v_model_a, v_app_a, v_owner_a, 'records', v_table_a),
           (v_model_b, v_app_b, v_owner_b, 'records', v_table_b);
    EXECUTE format('INSERT INTO public.%I (id, value) VALUES ($1, $2)', v_table_a)
        USING gen_random_uuid(), 'app A record';
    EXECUTE format('INSERT INTO public.%I (id, value) VALUES ($1, $2)', v_table_b)
        USING gen_random_uuid(), 'app B record';
    INSERT INTO public.feltus_documents
        (app_id, owner_id, original_name, stored_name, storage_key, size_bytes, sha256)
    VALUES (v_app_a, v_owner_a, 'note.txt', 'note.txt', v_app_a::TEXT || '/note.txt', 12, repeat('a', 64));

    SELECT id INTO STRICT v_environment FROM public.feltus_environments
     WHERE app_id = v_app_a AND kind = 'development' LIMIT 1;
    INSERT INTO public.feltus_deployment_targets
        (organization_id, app_id, environment_id, provider_key, provider_resource_reference, created_by)
    VALUES (v_org_a, v_app_a, v_environment, 'coolify', 'synthetic-provider-resource', v_owner_a);
    INSERT INTO public.feltus_deployment_domains
        (organization_id, app_id, environment_id, domain_name, provider_reference, created_by)
    VALUES (v_org_a, v_app_a, v_environment, 'synthetic.phase-c.invalid', 'synthetic-domain-ref', v_owner_a);

    INSERT INTO public.feltus_application_blueprints
        (organization_id, app_id, version, state_hash, state, created_by)
    VALUES (v_org_a, v_app_a, 1, repeat('b', 64), '{"contract":"feltus.application-state/v1"}'::jsonb, v_owner_a)
    RETURNING id INTO v_blueprint;

    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', v_owner_a::TEXT, true);

    INSERT INTO public.feltus_git_connections
        (organization_id, provider, account_label, credential_ciphertext, encryption_key_version, created_by)
    VALUES (v_org_a, 'github', 'Phase D synthetic connection', decode('01', 'hex'), 'phase-d-test', v_owner_a)
    RETURNING id INTO v_git_connection;
    INSERT INTO public.feltus_repositories
        (organization_id, git_connection_id, provider_repository_id, repository_name, clone_url, default_branch)
    VALUES (v_org_a, v_git_connection, 'phase-d-' || gen_random_uuid()::TEXT, 'phase-d-lifecycle-fixture',
            'https://example.invalid/phase-d-lifecycle-fixture.git', 'main')
    RETURNING id INTO v_repository;
    INSERT INTO public.feltus_project_repositories (organization_id, app_id, repository_id, attached_by)
    VALUES (v_org_a, v_app_a, v_repository, v_owner_a);
    INSERT INTO public.feltus_builds
        (organization_id, app_id, repository_id, requested_by, source_branch, commit_sha,
         status, build_provider, blueprint_id)
    VALUES (v_org_a, v_app_a, v_repository, v_owner_a, 'main', repeat('e', 40),
            'succeeded', 'synthetic', v_blueprint);
    INSERT INTO public.feltus_artifacts
        (organization_id, app_id, build_id, blueprint_id, registry_image, artifact_digest,
         verification_status, verified_at)
    SELECT v_org_a, v_app_a, build.id, v_blueprint, 'registry.invalid/phase-d-fixture',
           'sha256:' || repeat('a', 64), 'passed', now()
      FROM public.feltus_builds build
     WHERE build.app_id = v_app_a AND build.commit_sha = repeat('e', 40)
    RETURNING id INTO v_artifact;
    INSERT INTO public.feltus_deployments
        (app_id, owner_id, environment, status, provider, branch, commit_sha,
         organization_id, environment_id, artifact_id, blueprint_id, requested_by, idempotency_key)
    VALUES (v_app_a, v_owner_a, 'development', 'QUEUED', 'coolify', 'main', repeat('e', 40),
            v_org_a, v_environment, v_artifact, v_blueprint, v_owner_a, 'phase-d-' || gen_random_uuid()::TEXT)
    RETURNING id INTO v_deployment;
    INSERT INTO public.feltus_builds
        (organization_id, app_id, repository_id, requested_by, source_branch, commit_sha,
         status, build_provider, blueprint_id)
    VALUES (v_org_a, v_app_a, v_repository, v_owner_a, 'main', repeat('f', 40),
            'queued', 'synthetic', v_blueprint);

    v_denied := false;
    BEGIN
        DELETE FROM public.feltus_project_memberships
         WHERE app_id = v_app_a AND user_id = v_owner_a;
    EXCEPTION WHEN check_violation THEN v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Normal operations removed the project owner membership';
    END IF;

    v_impact := public.feltus_application_deletion_impact(v_app_a);
    IF v_impact ->> 'can_delete' IS DISTINCT FROM 'true'
       OR (v_impact #>> '{will_be_deleted,model_rows}')::BIGINT <> 1
       OR jsonb_array_length(v_impact #> '{external_not_touched,deployment_targets}') <> 1
       OR jsonb_array_length(v_impact #> '{external_not_touched,domains}') <> 1 THEN
        RAISE EXCEPTION 'Deletion impact preview did not match synthetic app resources: %', v_impact;
    END IF;

    PERFORM public.feltus_set_application_archive(v_app_a, true);
    PERFORM set_config('feltus.lifecycle_internal', 'off', true);
    SELECT lifecycle_status, setup_status INTO v_status, v_setup_status
      FROM public.feltus_applications WHERE id = v_app_a;
    EXECUTE format('SELECT count(*) FROM public.%I', v_table_a) INTO v_count;
    IF v_status <> 'archived' OR v_setup_status <> 'archived' OR v_count <> 1
       OR NOT EXISTS (SELECT 1 FROM public.feltus_documents WHERE app_id = v_app_a)
       OR NOT EXISTS (SELECT 1 FROM public.feltus_application_blueprints WHERE id = v_blueprint) THEN
        RAISE EXCEPTION 'Archive changed application data, models, documents, or Blueprints';
    END IF;
    PERFORM public.feltus_set_application_archive(v_app_a, false);
    PERFORM set_config('feltus.lifecycle_internal', 'off', true);
    IF NOT EXISTS (SELECT 1 FROM public.feltus_applications WHERE id = v_app_a AND lifecycle_status = 'active') THEN
        RAISE EXCEPTION 'Restore did not return the application to active state';
    END IF;

    -- A different authenticated owner cannot archive or request deletion for this app.
    PERFORM set_config('request.jwt.claim.sub', v_owner_b::TEXT, true);
    v_denied := false;
    BEGIN
        PERFORM public.feltus_set_application_archive(v_app_a, true);
    EXCEPTION WHEN SQLSTATE '42501' THEN v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'Cross-owner archive was not rejected'; END IF;
    v_denied := false;
    BEGIN
        PERFORM public.feltus_request_application_deletion(v_app_a, 'Synthetic Lifecycle App A');
    EXCEPTION WHEN SQLSTATE '42501' THEN v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'Cross-owner deletion was not rejected'; END IF;

    PERFORM set_config('request.jwt.claim.sub', v_owner_a::TEXT, true);
    v_denied := false;
    BEGIN
        PERFORM public.feltus_request_application_deletion(v_app_a, 'wrong confirmation');
    EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'Wrong deletion confirmation was not rejected'; END IF;

    v_result := public.feltus_request_application_deletion(v_app_a, 'Synthetic Lifecycle App A');
    PERFORM set_config('feltus.lifecycle_internal', 'off', true);
    v_request := (v_result ->> 'request_id')::UUID;
    IF v_result ->> 'status' <> 'cleanup_pending' OR v_request IS NULL THEN
        RAISE EXCEPTION 'Deletion request did not enter cleanup_pending: %', v_result;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.feltus_builds WHERE app_id = v_app_a AND commit_sha = repeat('f', 40) AND status = 'cancelled')
       OR NOT EXISTS (SELECT 1 FROM public.feltus_infrastructure_outbox WHERE app_id = v_app_a AND deployment_id = v_deployment AND state = 'cancelled') THEN
        RAISE EXCEPTION 'Tombstoning did not cancel the queued build and provider command';
    END IF;
    SELECT count(*) INTO v_before FROM public.feltus_jobs
     WHERE app_id = v_app_a AND job_type = 'application.cleanup';
    v_result := public.feltus_request_application_deletion(v_app_a, 'Synthetic Lifecycle App A');
    PERFORM set_config('feltus.lifecycle_internal', 'off', true);
    SELECT count(*) INTO v_after FROM public.feltus_jobs
     WHERE app_id = v_app_a AND job_type = 'application.cleanup';
    IF v_result ->> 'request_id' <> v_request::TEXT OR v_result ->> 'idempotent' <> 'true' OR v_before <> 1 OR v_after <> 1 THEN
        RAISE EXCEPTION 'Repeat deletion request was not idempotent: %', v_result;
    END IF;

    -- Simulate stale queued work from before tombstoning and prove the worker
    -- claims still enforce the lifecycle gate. Cleanup jobs remain claimable.
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    INSERT INTO public.feltus_builds
        (organization_id, app_id, repository_id, source_branch, commit_sha, build_provider, blueprint_id)
    VALUES (v_org_a, v_app_a, v_repository, 'main', repeat('c', 40), 'synthetic', v_blueprint);
    SELECT count(*) INTO v_count
      FROM public.feltus_claim_builds('phase-d-lifecycle-worker', 4, 600)
     WHERE app_id = v_app_a;
    IF v_count <> 0 THEN RAISE EXCEPTION 'Build worker claimed a tombstoned application build'; END IF;
    SELECT count(*) INTO v_count
      FROM public.feltus_claim_infrastructure_outbox('phase-d-lifecycle-worker', 50, 120)
     WHERE app_id = v_app_a;
    IF v_count <> 0 THEN RAISE EXCEPTION 'Provider worker claimed a tombstoned application command'; END IF;
    SELECT count(*) INTO v_count
      FROM public.feltus_claim_jobs('phase-d-lifecycle-worker', 20, 120)
     WHERE app_id = v_app_a AND job_type = 'application.cleanup' AND status = 'RUNNING';
    IF v_count <> 1 THEN RAISE EXCEPTION 'Cleanup worker could not claim the tombstoned application cleanup job'; END IF;

    -- Tombstoning rejects new ordinary app-owned data writes.
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    v_denied := false;
    BEGIN
        INSERT INTO public.feltus_documents
            (app_id, owner_id, original_name, stored_name, storage_key, size_bytes, sha256)
        VALUES (v_app_a, v_owner_a, 'late.txt', 'late.txt', v_app_a::TEXT || '/late.txt', 1, repeat('c', 64));
    EXCEPTION WHEN SQLSTATE '55000' THEN v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'Tombstoned app accepted a new document write'; END IF;

    v_denied := false;
    BEGIN
        INSERT INTO public.feltus_builds
            (organization_id, app_id, repository_id, source_branch, commit_sha, build_provider)
        VALUES (v_org_a, v_app_a, gen_random_uuid(), 'main', repeat('d', 40), 'docker');
    EXCEPTION WHEN SQLSTATE '55000' THEN v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'Tombstoned app accepted a new build'; END IF;

    v_denied := false;
    BEGIN
        INSERT INTO public.feltus_deployments
            (app_id, owner_id, environment, status, provider, organization_id, environment_id, requested_by, idempotency_key)
        VALUES (v_app_a, v_owner_a, 'development', 'QUEUED', 'coolify', v_org_a, v_environment, v_owner_a, 'phase-c-tombstone-test');
    EXCEPTION WHEN SQLSTATE '55000' THEN v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'Tombstoned app accepted a new deployment'; END IF;

    -- Simulate a worker failure, then retry. The request ID and partial state remain stable.
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM public.feltus_start_application_cleanup(v_app_a, v_request);
    PERFORM public.feltus_fail_application_cleanup(v_app_a, v_request, 'synthetic_transient_failure', false);
    UPDATE public.feltus_jobs
       SET status = 'FAILED', completed_at = now(), worker_id = NULL, lease_expires_at = NULL
     WHERE app_id = v_app_a AND job_type = 'application.cleanup' AND status = 'RUNNING';
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    v_result := public.feltus_request_application_deletion(v_app_a, 'Synthetic Lifecycle App A');
    IF v_result ->> 'request_id' <> v_request::TEXT OR v_result ->> 'status' <> 'cleanup_pending' THEN
        RAISE EXCEPTION 'Retry changed request identity or failed to queue: %', v_result;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.feltus_applications WHERE id = v_app_a AND lifecycle_retry_count = 1) THEN
        RAISE EXCEPTION 'Retry count did not advance';
    END IF;

    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    SELECT count(*) INTO v_count
      FROM public.feltus_claim_jobs('phase-d-lifecycle-worker', 20, 120)
     WHERE app_id = v_app_a AND job_type = 'application.cleanup' AND status = 'RUNNING';
    IF v_count <> 1 THEN RAISE EXCEPTION 'Cleanup retry was not claimable by the service worker'; END IF;
    PERFORM public.feltus_start_application_cleanup(v_app_a, v_request);
    PERFORM public.feltus_mark_application_files_removed(v_app_a, v_request);
    v_result := public.feltus_complete_application_cleanup(v_app_a, v_request);
    IF v_result ->> 'status' <> 'cleanup_complete' THEN RAISE EXCEPTION 'Cleanup did not complete: %', v_result; END IF;
    v_result := public.feltus_complete_application_cleanup(v_app_a, v_request);
    IF v_result ->> 'idempotent' <> 'true' THEN RAISE EXCEPTION 'Completed cleanup was not idempotent'; END IF;

    SELECT lifecycle_status, description, setup_data INTO v_status, v_description, v_impact
      FROM public.feltus_applications WHERE id = v_app_a;
    IF v_status <> 'cleanup_complete' OR v_description <> '' OR v_impact <> '{}'::jsonb THEN
        RAISE EXCEPTION 'Application tombstone was not retained in cleared terminal state';
    END IF;
    IF EXISTS (SELECT 1 FROM public.feltus_models WHERE app_id = v_app_a)
       OR EXISTS (SELECT 1 FROM public.feltus_documents WHERE app_id = v_app_a)
       OR EXISTS (SELECT 1 FROM public.feltus_project_memberships WHERE app_id = v_app_a)
       OR EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'fm_' || substring(replace(v_model_a::TEXT, '-', '') FROM 1 FOR 8) || '_records') THEN
        RAISE EXCEPTION 'Application-owned model or document data survived cleanup';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.feltus_application_blueprints WHERE id = v_blueprint AND app_id = v_app_a)
       OR NOT EXISTS (SELECT 1 FROM public.feltus_audit_events WHERE app_id = v_app_a AND action_key = 'application.deletion.cleanup_complete') THEN
        RAISE EXCEPTION 'Blueprint or lifecycle audit evidence was not preserved';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.feltus_builds WHERE app_id = v_app_a AND commit_sha = repeat('e', 40))
       OR NOT EXISTS (SELECT 1 FROM public.feltus_artifacts WHERE id = v_artifact AND app_id = v_app_a)
       OR NOT EXISTS (SELECT 1 FROM public.feltus_deployments WHERE id = v_deployment AND app_id = v_app_a)
       OR NOT EXISTS (SELECT 1 FROM public.feltus_project_repositories WHERE app_id = v_app_a AND repository_id = v_repository AND detached_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Build, artifact, deployment, or detached repository history was not preserved';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.feltus_deployment_targets WHERE app_id = v_app_a AND active = false AND provider_resource_reference = 'synthetic-provider-resource')
       OR NOT EXISTS (SELECT 1 FROM public.feltus_deployment_domains WHERE app_id = v_app_a AND provider_reference = 'synthetic-domain-ref')
       OR NOT EXISTS (SELECT 1 FROM public.feltus_environments WHERE app_id = v_app_a AND status = 'suspended') THEN
        RAISE EXCEPTION 'External references were removed or not safely detached';
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', 'fm_' || substring(replace(v_model_b::TEXT, '-', '') FROM 1 FOR 8) || '_records') INTO v_count;
    IF v_count <> 1 OR NOT EXISTS (SELECT 1 FROM public.feltus_models WHERE id = v_model_b AND app_id = v_app_b) THEN
        RAISE EXCEPTION 'Cleanup changed another application model';
    END IF;

    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    v_denied := false;
    BEGIN
        PERFORM public.feltus_application_deletion_impact(v_app_a);
    EXCEPTION WHEN SQLSTATE '42501' THEN v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'Anonymous impact request was not rejected'; END IF;

    RAISE NOTICE 'PASS isolated Phase C PostgreSQL runtime assertions';
END;
$$;

ROLLBACK;
