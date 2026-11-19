-- Phase C: reversible archive and owner-requested, durable application cleanup.
-- Immutable Blueprint, state, build, artifact, deployment, and audit lineage is
-- retained behind a non-visible application tombstone. External resources are
-- only reported; this migration never calls a provider or deletes provider data.

ALTER TABLE public.feltus_applications
    ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS archive_previous_setup_status TEXT,
    ADD COLUMN IF NOT EXISTS lifecycle_request_id UUID,
    ADD COLUMN IF NOT EXISTS lifecycle_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS lifecycle_cleanup_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS lifecycle_retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.feltus_project_repositories
    ADD COLUMN IF NOT EXISTS detached_at TIMESTAMPTZ;

UPDATE public.feltus_applications
SET lifecycle_status = CASE WHEN setup_status = 'archived' THEN 'archived' ELSE 'active' END
WHERE lifecycle_status IS NULL OR lifecycle_status = 'active' AND setup_status = 'archived';

ALTER TABLE public.feltus_applications
    DROP CONSTRAINT IF EXISTS feltus_applications_lifecycle_status_check;
ALTER TABLE public.feltus_applications
    ADD CONSTRAINT feltus_applications_lifecycle_status_check
    CHECK (lifecycle_status IN (
        'active','archived','requested','validated','tombstoned',
        'cleanup_pending','cleanup_in_progress','cleanup_failed',
        'cleanup_blocked','cleanup_complete'
    ));
ALTER TABLE public.feltus_applications
    ADD CONSTRAINT feltus_applications_lifecycle_retry_count_check
    CHECK (lifecycle_retry_count >= 0);

CREATE INDEX IF NOT EXISTS feltus_applications_lifecycle_status_idx
    ON public.feltus_applications (owner_id, lifecycle_status, setup_updated_at DESC);

-- Archive is reversible. It changes no app-owned data or files.
CREATE OR REPLACE FUNCTION public.feltus_set_application_archive(
    p_app_id UUID,
    p_archived BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_app public.feltus_applications%ROWTYPE;
    v_previous TEXT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_app FROM public.feltus_applications
     WHERE id = p_app_id AND owner_id = auth.uid() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = '42501'; END IF;
    IF v_app.lifecycle_status IN ('requested','validated','tombstoned','cleanup_pending',
        'cleanup_in_progress','cleanup_failed','cleanup_blocked','cleanup_complete') THEN
        RAISE EXCEPTION 'Application deletion has started' USING ERRCODE = '55000';
    END IF;
    PERFORM set_config('feltus.lifecycle_internal', 'on', true);

    IF p_archived IS DISTINCT FROM TRUE THEN
        IF v_app.lifecycle_status = 'active' THEN
            RETURN jsonb_build_object('app_id', p_app_id, 'lifecycle_status', 'active', 'changed', false);
        END IF;
        v_previous := COALESCE(v_app.archive_previous_setup_status, 'active');
        UPDATE public.feltus_applications
           SET lifecycle_status = 'active',
               setup_status = CASE WHEN setup_status = 'archived' THEN v_previous ELSE setup_status END,
               archive_previous_setup_status = NULL,
               setup_updated_at = now()
         WHERE id = p_app_id;
        PERFORM public.feltus_application_lifecycle_audit(
            p_app_id, auth.uid(), 'application.restored',
            jsonb_build_object('lifecycle_status', 'archived'),
            jsonb_build_object('lifecycle_status', 'active')
        );
    ELSE
        IF v_app.lifecycle_status = 'archived' THEN
            RETURN jsonb_build_object('app_id', p_app_id, 'lifecycle_status', 'archived', 'changed', false);
        END IF;
        UPDATE public.feltus_applications
           SET lifecycle_status = 'archived',
               archive_previous_setup_status = CASE WHEN setup_status = 'archived' THEN archive_previous_setup_status ELSE setup_status END,
               setup_status = 'archived',
               setup_updated_at = now()
         WHERE id = p_app_id;
        PERFORM public.feltus_application_lifecycle_audit(
            p_app_id, auth.uid(), 'application.archived',
            jsonb_build_object('lifecycle_status', 'active'),
            jsonb_build_object('lifecycle_status', 'archived')
        );
    END IF;
    RETURN jsonb_build_object(
        'app_id', p_app_id,
        'lifecycle_status', CASE WHEN p_archived THEN 'archived' ELSE 'active' END,
        'changed', true
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_application_lifecycle_audit(
    p_app_id UUID,
    p_actor UUID,
    p_action TEXT,
    p_before JSONB,
    p_after JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_org_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id
      FROM public.feltus_applications WHERE id = p_app_id;
    IF v_org_id IS NULL THEN RETURN; END IF;
    INSERT INTO public.feltus_audit_events
        (organization_id, app_id, actor_user_id, actor_kind, action_key,
         entity_type, entity_id, before_data, after_data)
    VALUES (
        v_org_id, p_app_id, p_actor,
        CASE WHEN p_actor IS NULL THEN 'system' ELSE 'user' END,
        left(p_action, 120), 'application_lifecycle', p_app_id::TEXT,
        COALESCE(p_before, '{}'::jsonb), COALESCE(p_after, '{}'::jsonb)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_application_lifecycle_audit(UUID, UUID, TEXT, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.feltus_application_deletion_impact(p_app_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_app public.feltus_applications%ROWTYPE;
    v_model RECORD;
    v_model_rows BIGINT := 0;
    v_row_count BIGINT;
    v_models JSONB := '[]'::jsonb;
    v_blockers JSONB := '[]'::jsonb;
    v_relationship_count BIGINT := 0;
    v_document_count BIGINT := 0;
    v_document_bytes BIGINT := 0;
    v_assets BIGINT := 0;
    v_code_sessions BIGINT := 0;
    v_code_actions BIGINT := 0;
    v_code_checkpoints BIGINT := 0;
    v_environments BIGINT := 0;
    v_active_environments BIGINT := 0;
    v_repository_links BIGINT := 0;
    v_active_targets BIGINT := 0;
    v_conversations BIGINT := 0;
    v_messages BIGINT := 0;
    v_jobs BIGINT := 0;
    v_members BIGINT := 0;
    v_secrets BIGINT := 0;
    v_blueprints BIGINT := 0;
    v_builds BIGINT := 0;
    v_artifacts BIGINT := 0;
    v_deployments BIGINT := 0;
    v_observations BIGINT := 0;
    v_deltas BIGINT := 0;
    v_audit BIGINT := 0;
    v_activity BIGINT := 0;
    v_external_repositories JSONB := '[]'::jsonb;
    v_external_targets JSONB := '[]'::jsonb;
    v_external_domains JSONB := '[]'::jsonb;
    v_unregistered_fk BIGINT := 0;
    v_dependent_objects JSONB := '[]'::jsonb;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_app FROM public.feltus_applications
     WHERE id = p_app_id AND owner_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = '42501'; END IF;
    IF v_app.lifecycle_status NOT IN ('active','archived') THEN
        RAISE EXCEPTION 'Application deletion is already in progress' USING ERRCODE = '55000';
    END IF;

    FOR v_model IN
        SELECT id, logical_name, physical_table_name
          FROM public.feltus_models
         WHERE app_id = p_app_id AND owner_id = v_app.owner_id
         ORDER BY id
    LOOP
        IF v_model.logical_name !~ '^[a-z][a-z0-9_]{0,39}$'
           OR v_model.physical_table_name IS DISTINCT FROM
              ('fm_' || substring(replace(v_model.id::TEXT, '-', '') FROM 1 FOR 8) || '_' || v_model.logical_name)
        THEN
            v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
                'kind', 'model_mapping', 'model_id', v_model.id,
                'message', 'A model table could not be safely matched to this application.'
            ));
            CONTINUE;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = v_model.physical_table_name AND c.relkind = 'r'
        ) THEN
            v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
                'kind', 'model_table_missing', 'model_id', v_model.id,
                'message', 'A registered model table is missing or is not a regular table.'
            ));
            CONTINUE;
        END IF;
        EXECUTE format('SELECT count(*) FROM public.%I', v_model.physical_table_name) INTO v_row_count;
        v_model_rows := v_model_rows + v_row_count;
        v_models := v_models || jsonb_build_array(jsonb_build_object(
            'id', v_model.id, 'name', v_model.logical_name,
            'physical_table', v_model.physical_table_name,
            'field_count', (SELECT count(*) FROM public.feltus_model_columns c WHERE c.model_id = v_model.id),
            'record_count', v_row_count
        ));
    END LOOP;

    SELECT count(*) INTO v_relationship_count FROM public.feltus_model_relationships WHERE app_id = p_app_id;
    SELECT count(*), COALESCE(sum(size_bytes), 0) INTO v_document_count, v_document_bytes FROM public.feltus_documents WHERE app_id = p_app_id;
    SELECT count(*) INTO v_assets FROM public.user_assets WHERE app_id = p_app_id;
    SELECT count(*) INTO v_code_sessions FROM public.feltus_code_sessions WHERE app_id = p_app_id;
    SELECT count(*) INTO v_code_actions FROM public.feltus_code_actions WHERE app_id = p_app_id;
    SELECT count(*) INTO v_code_checkpoints FROM public.feltus_code_checkpoints WHERE app_id = p_app_id;
    SELECT count(*), count(*) FILTER (WHERE status = 'active')
      INTO v_environments, v_active_environments FROM public.feltus_environments WHERE app_id = p_app_id;
    SELECT count(*) INTO v_repository_links FROM public.feltus_project_repositories WHERE app_id = p_app_id AND detached_at IS NULL;
    SELECT count(*) INTO v_active_targets FROM public.feltus_deployment_targets WHERE app_id = p_app_id AND active;
    SELECT count(*) INTO v_conversations FROM public.feltus_ai_conversations WHERE app_id = p_app_id;
    SELECT count(*) INTO v_messages FROM public.feltus_ai_messages WHERE app_id = p_app_id;
    SELECT count(*) INTO v_jobs FROM public.feltus_jobs WHERE app_id = p_app_id AND job_type <> 'application.cleanup';
    SELECT count(*) INTO v_members FROM public.feltus_project_memberships WHERE app_id = p_app_id;
    SELECT
        (SELECT count(*) FROM public.feltus_project_secrets WHERE app_id = p_app_id) +
        (SELECT count(*) FROM public.feltus_environment_secrets WHERE app_id = p_app_id)
      INTO v_secrets;
    SELECT count(*) INTO v_blueprints FROM public.feltus_application_blueprints WHERE app_id = p_app_id;
    SELECT count(*) INTO v_builds FROM public.feltus_builds WHERE app_id = p_app_id;
    SELECT count(*) INTO v_artifacts FROM public.feltus_artifacts WHERE app_id = p_app_id;
    SELECT count(*) INTO v_deployments FROM public.feltus_deployments WHERE app_id = p_app_id;
    SELECT count(*) INTO v_observations FROM public.feltus_observed_application_states WHERE app_id = p_app_id;
    SELECT count(*) INTO v_deltas FROM public.feltus_application_state_deltas WHERE app_id = p_app_id;
    SELECT count(*) INTO v_audit FROM public.feltus_audit_events WHERE app_id = p_app_id;
    SELECT count(*) INTO v_activity FROM public.feltus_activity_log WHERE app_id = p_app_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'repository', repository.repository_name,
        'provider', connection.provider,
        'external_repository_id', repository.provider_repository_id
    ) ORDER BY repository.repository_name), '[]'::jsonb)
      INTO v_external_repositories
      FROM public.feltus_project_repositories link
      JOIN public.feltus_repositories repository ON repository.id = link.repository_id
      JOIN public.feltus_git_connections connection ON connection.id = repository.git_connection_id
     WHERE link.app_id = p_app_id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'provider', provider_key, 'resource_reference', provider_resource_reference,
        'active', active
    ) ORDER BY provider_key), '[]'::jsonb)
      INTO v_external_targets FROM public.feltus_deployment_targets WHERE app_id = p_app_id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'provider_reference', provider_reference, 'domain', domain_name
    ) ORDER BY domain_name), '[]'::jsonb)
      INTO v_external_domains FROM public.feltus_deployment_domains WHERE app_id = p_app_id;

    -- Relationships must exactly match the registered one-column foreign key.
    SELECT count(*) INTO v_unregistered_fk
      FROM public.feltus_models model
      JOIN pg_class model_table ON model_table.relname = model.physical_table_name
      JOIN pg_namespace model_schema ON model_schema.oid = model_table.relnamespace AND model_schema.nspname = 'public'
      JOIN pg_constraint fk ON fk.contype = 'f' AND (fk.conrelid = model_table.oid OR fk.confrelid = model_table.oid)
      LEFT JOIN public.feltus_models source_model ON source_model.physical_table_name = (SELECT relname FROM pg_class WHERE oid = fk.conrelid) AND source_model.app_id = p_app_id
      LEFT JOIN public.feltus_models target_model ON target_model.physical_table_name = (SELECT relname FROM pg_class WHERE oid = fk.confrelid) AND target_model.app_id = p_app_id
      LEFT JOIN public.feltus_model_relationships relation
        ON relation.app_id = p_app_id AND relation.constraint_name = fk.conname
       AND relation.source_model_id = source_model.id AND relation.target_model_id = target_model.id
     WHERE model.app_id = p_app_id AND relation.id IS NULL;
    IF v_unregistered_fk > 0 THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'kind', 'unregistered_relationship', 'count', v_unregistered_fk,
            'message', 'A database relationship could not be matched to this application.'
        ));
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'kind', CASE WHEN d.classid = 'pg_rewrite'::regclass THEN 'view_or_rule' ELSE 'routine' END,
        'description', pg_describe_object(d.classid, d.objid, d.objsubid)
    )), '[]'::jsonb) INTO v_dependent_objects
      FROM public.feltus_models model
      JOIN pg_class t ON t.relname = model.physical_table_name
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      JOIN pg_depend d ON d.refclassid = 'pg_class'::regclass AND d.refobjid = t.oid
       AND d.deptype = 'n' AND d.classid IN ('pg_rewrite'::regclass, 'pg_proc'::regclass)
     WHERE model.app_id = p_app_id;
    IF jsonb_array_length(v_dependent_objects) > 0 THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'kind', 'dependent_database_object', 'count', jsonb_array_length(v_dependent_objects),
            'message', 'A database object depends on an app data table.'
        ));
    END IF;
    IF EXISTS (SELECT 1 FROM public.feltus_builds WHERE app_id = p_app_id AND status IN ('claimed','running','building','verifying')) THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'kind', 'active_build', 'message', 'A build is still running. Wait for it to finish before deleting this application.'
        ));
    END IF;
    IF EXISTS (SELECT 1 FROM public.feltus_infrastructure_outbox WHERE app_id = p_app_id AND state = 'leased') THEN
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
            'kind', 'active_provider_operation', 'message', 'A provider operation is already in progress. Wait for it to finish before deleting this application.'
        ));
    END IF;

    RETURN jsonb_build_object(
        'application', jsonb_build_object('id', v_app.id, 'name', v_app.app_name, 'lifecycle_status', v_app.lifecycle_status),
        'will_be_deleted', jsonb_build_object(
            'models', v_models, 'model_rows', v_model_rows, 'relationships', v_relationship_count,
            'documents', v_document_count, 'document_bytes', v_document_bytes,
            'assets', v_assets,
            'knowledge_bases', (SELECT count(*) FROM public.feltus_knowledge_bases WHERE app_id = p_app_id),
            'knowledge_chunks', (SELECT count(*) FROM public.feltus_knowledge_chunks WHERE app_id = p_app_id),
            'conversations', v_conversations, 'messages', v_messages,
            'jobs', v_jobs, 'project_memberships', v_members,
            'secret_records', v_secrets,
            'tool_executions', (SELECT count(*) FROM public.feltus_tool_executions WHERE app_id = p_app_id),
            'usage_records', (SELECT count(*) FROM public.feltus_usage_records WHERE app_id = p_app_id),
            'code_sessions', v_code_sessions, 'code_actions', v_code_actions,
            'code_checkpoints', v_code_checkpoints,
            'private_code_workspace', 'app-scoped workspace and local documents are removed'
        ),
        'will_be_preserved', jsonb_build_object(
            'blueprints', v_blueprints, 'builds', v_builds, 'artifacts', v_artifacts,
            'deployments', v_deployments, 'observations', v_observations,
            'state_deltas', v_deltas, 'audit_events', v_audit, 'activity_events', v_activity,
            'environments', v_environments,
            'application_tombstone', true
        ),
        'will_be_detached', jsonb_build_object(
            'repository_links', v_repository_links,
            'deployment_targets_disabled', v_active_targets,
            'environments_suspended', v_active_environments
        ),
        'external_not_touched', jsonb_build_object(
            'repositories', v_external_repositories,
            'deployment_targets', v_external_targets,
            'domains', v_external_domains,
            'notice', 'Git, hosting, registry, domain, database, and other provider resources are not deleted.'
        ),
        'blockers', v_blockers,
        'can_delete', jsonb_array_length(v_blockers) = 0
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_application_deletion_status(p_app_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_app public.feltus_applications%ROWTYPE;
    v_job_status TEXT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_app FROM public.feltus_applications WHERE id = p_app_id AND owner_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = '42501'; END IF;
    IF v_app.lifecycle_status IN ('cleanup_pending','cleanup_in_progress') THEN
        SELECT status INTO v_job_status FROM public.feltus_jobs
         WHERE app_id=p_app_id AND job_type='application.cleanup'
           AND payload ->> 'request_id'=v_app.lifecycle_request_id::TEXT
         ORDER BY created_at DESC LIMIT 1;
        IF v_job_status IS NULL OR v_job_status IN ('FAILED','CANCELLED') THEN
            PERFORM set_config('feltus.lifecycle_internal','on',true);
            UPDATE public.feltus_applications
               SET lifecycle_status='cleanup_failed',
                   lifecycle_cleanup_progress=jsonb_set(COALESCE(lifecycle_cleanup_progress,'{}'::jsonb),
                       '{last_error_code}',to_jsonb('CLEANUP_JOB_STOPPED'::TEXT),true)
             WHERE id=p_app_id AND lifecycle_request_id=v_app.lifecycle_request_id;
            PERFORM public.feltus_application_lifecycle_audit(p_app_id,NULL,
                'application.deletion.cleanup_failed',
                jsonb_build_object('status',v_app.lifecycle_status),
                jsonb_build_object('status','cleanup_failed','error_code','CLEANUP_JOB_STOPPED'));
            SELECT * INTO v_app FROM public.feltus_applications WHERE id=p_app_id;
        END IF;
    END IF;
    RETURN jsonb_build_object(
        'app_id', v_app.id,
        'application_name', COALESCE(v_app.lifecycle_snapshot #>> '{application,name}', v_app.app_name),
        'status', v_app.lifecycle_status,
        'request_id', v_app.lifecycle_request_id,
        'progress', v_app.lifecycle_cleanup_progress,
        'impact', v_app.lifecycle_snapshot,
        'retry_count', v_app.lifecycle_retry_count,
        'last_error_code', v_app.lifecycle_cleanup_progress ->> 'last_error_code',
        'complete', v_app.lifecycle_status = 'cleanup_complete'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_request_application_deletion(
    p_app_id UUID,
    p_confirmation TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_app public.feltus_applications%ROWTYPE;
    v_impact JSONB;
    v_request UUID;
    v_job_id UUID;
    v_retry INTEGER;
    v_job_status TEXT;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
    PERFORM set_config('feltus.lifecycle_internal', 'on', true);
    SELECT * INTO v_app FROM public.feltus_applications
     WHERE id = p_app_id AND owner_id = auth.uid() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Application not found' USING ERRCODE = '42501'; END IF;
    IF p_confirmation IS DISTINCT FROM v_app.app_name THEN
        RAISE EXCEPTION 'Enter the exact application name to confirm permanent deletion.' USING ERRCODE = '22023';
    END IF;
    IF v_app.lifecycle_status = 'cleanup_complete' THEN
        RETURN jsonb_build_object('app_id',p_app_id,'request_id',v_app.lifecycle_request_id,
            'status',v_app.lifecycle_status,'idempotent',true);
    END IF;
    IF v_app.lifecycle_status IN ('cleanup_pending','cleanup_in_progress') THEN
        SELECT status INTO v_job_status FROM public.feltus_jobs
         WHERE app_id=p_app_id AND job_type='application.cleanup'
           AND payload ->> 'request_id'=v_app.lifecycle_request_id::TEXT
         ORDER BY created_at DESC LIMIT 1;
        IF v_job_status IN ('QUEUED','RUNNING') THEN
            RETURN jsonb_build_object('app_id',p_app_id,'request_id',v_app.lifecycle_request_id,
                'status',v_app.lifecycle_status,'idempotent',true);
        END IF;
        -- A worker can exhaust its lease or stop between attempts. Convert the
        -- orphaned request into a diagnosed failure so an owner can retry it.
        UPDATE public.feltus_applications
           SET lifecycle_status='cleanup_failed',
               lifecycle_cleanup_progress=jsonb_set(COALESCE(lifecycle_cleanup_progress,'{}'::jsonb),
                   '{last_error_code}',to_jsonb('CLEANUP_JOB_STOPPED'::TEXT),true)
         WHERE id=p_app_id;
        PERFORM public.feltus_application_lifecycle_audit(p_app_id,auth.uid(),
            'application.deletion.cleanup_failed',
            jsonb_build_object('status',v_app.lifecycle_status),
            jsonb_build_object('status','cleanup_failed','error_code','CLEANUP_JOB_STOPPED'));
        v_app.lifecycle_status := 'cleanup_failed';
    END IF;
    IF v_app.lifecycle_status IN ('cleanup_failed','cleanup_blocked') THEN
        v_request := v_app.lifecycle_request_id;
        v_retry := v_app.lifecycle_retry_count + 1;
        UPDATE public.feltus_applications
           SET lifecycle_status = 'cleanup_pending', lifecycle_retry_count = v_retry,
               lifecycle_cleanup_progress = jsonb_set(COALESCE(lifecycle_cleanup_progress,'{}'::jsonb), '{last_error_code}', 'null'::jsonb, true)
         WHERE id = p_app_id;
        PERFORM public.feltus_application_lifecycle_audit(p_app_id, auth.uid(), 'application.deletion.retry_requested',
            jsonb_build_object('status', v_app.lifecycle_status), jsonb_build_object('status','cleanup_pending','retry',v_retry));
        INSERT INTO public.feltus_jobs (app_id, owner_id, job_type, payload, max_attempts, idempotency_key)
        VALUES (p_app_id, auth.uid(), 'application.cleanup', jsonb_build_object('request_id',v_request), 5,
            'application-cleanup:' || v_request::text || ':' || v_retry::text)
        ON CONFLICT (app_id, owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id INTO v_job_id;
        RETURN jsonb_build_object('app_id',p_app_id,'request_id',v_request,'status','cleanup_pending','job_id',v_job_id,'idempotent',false);
    END IF;
    IF v_app.lifecycle_status NOT IN ('active','archived') THEN
        RAISE EXCEPTION 'Application lifecycle does not allow deletion.' USING ERRCODE = '55000';
    END IF;

    v_impact := public.feltus_application_deletion_impact(p_app_id);
    IF COALESCE((v_impact ->> 'can_delete')::BOOLEAN, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'Application deletion is blocked by work that must finish first.' USING ERRCODE = '23503', DETAIL = (v_impact -> 'blockers')::text;
    END IF;

    v_request := gen_random_uuid();
    v_retry := 0;
    PERFORM public.feltus_application_lifecycle_audit(p_app_id, auth.uid(), 'application.deletion.requested',
        '{}'::jsonb, jsonb_build_object('request_id',v_request,'impact',v_impact));
    UPDATE public.feltus_applications SET lifecycle_status='requested', lifecycle_request_id=v_request,
        lifecycle_snapshot=v_impact, lifecycle_cleanup_progress=jsonb_build_object('files_removed',false,'database_removed',false,'last_error_code',null),
        lifecycle_retry_count=v_retry WHERE id=p_app_id;
    PERFORM public.feltus_application_lifecycle_audit(p_app_id, auth.uid(), 'application.deletion.validated',
        jsonb_build_object('status','requested'), jsonb_build_object('status','validated'));
    UPDATE public.feltus_applications SET lifecycle_status='validated' WHERE id=p_app_id;
    UPDATE public.feltus_applications SET lifecycle_status='tombstoned' WHERE id=p_app_id;
    PERFORM public.feltus_application_lifecycle_audit(p_app_id, auth.uid(), 'application.deletion.tombstoned',
        jsonb_build_object('status','validated'), jsonb_build_object('status','tombstoned'));
    UPDATE public.feltus_applications SET lifecycle_status='cleanup_pending' WHERE id=p_app_id;
    PERFORM public.feltus_application_lifecycle_audit(p_app_id, auth.uid(), 'application.deletion.cleanup_pending',
        jsonb_build_object('status','tombstoned'), jsonb_build_object('status','cleanup_pending'));

    UPDATE public.feltus_jobs SET status='CANCELLED', cancellation_requested=true,
        completed_at=now(), updated_at=now(), last_error='Application deletion requested'
     WHERE app_id=p_app_id AND job_type <> 'application.cleanup' AND status='QUEUED';
    UPDATE public.feltus_jobs SET cancellation_requested=true, updated_at=now()
     WHERE app_id=p_app_id AND job_type <> 'application.cleanup' AND status='RUNNING';
    UPDATE public.feltus_builds SET status='cancelled', completed_at=now(), updated_at=now()
     WHERE app_id=p_app_id AND status='queued';
    UPDATE public.feltus_infrastructure_outbox SET state='cancelled', lease_owner=NULL, lease_token=NULL,
        lease_expires_at=NULL, last_error_code='APPLICATION_TOMBSTONED', completed_at=now(), updated_at=now()
     WHERE app_id=p_app_id AND state='pending';
    UPDATE public.feltus_deployment_targets SET active=false, updated_at=now() WHERE app_id=p_app_id AND active;
    UPDATE public.feltus_environments SET status='suspended', updated_at=now() WHERE app_id=p_app_id AND status='active';
    UPDATE public.feltus_project_repositories SET detached_at=now() WHERE app_id=p_app_id AND detached_at IS NULL;

    INSERT INTO public.feltus_jobs (app_id, owner_id, job_type, payload, max_attempts, idempotency_key)
    VALUES (p_app_id, auth.uid(), 'application.cleanup', jsonb_build_object('request_id',v_request), 5,
        'application-cleanup:' || v_request::text || ':0')
    RETURNING id INTO v_job_id;
    RETURN jsonb_build_object('app_id',p_app_id,'request_id',v_request,'status','cleanup_pending','job_id',v_job_id,'impact',v_impact);
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_start_application_cleanup(p_app_id UUID, p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$
DECLARE v_app public.feltus_applications%ROWTYPE;
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Service worker authorization required' USING ERRCODE='42501'; END IF;
    PERFORM set_config('feltus.lifecycle_internal','on',true);
    SELECT * INTO v_app FROM public.feltus_applications WHERE id=p_app_id AND lifecycle_request_id=p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deletion request not found' USING ERRCODE='P0002'; END IF;
    IF v_app.lifecycle_status='cleanup_complete' THEN
        RETURN jsonb_build_object('status','cleanup_complete','progress',v_app.lifecycle_cleanup_progress);
    END IF;
    IF v_app.lifecycle_status NOT IN ('cleanup_pending','cleanup_in_progress') THEN
        RAISE EXCEPTION 'Deletion request is not ready for cleanup' USING ERRCODE='55000';
    END IF;
    IF v_app.lifecycle_status='cleanup_pending' THEN
        UPDATE public.feltus_applications SET lifecycle_status='cleanup_in_progress' WHERE id=p_app_id;
        PERFORM public.feltus_application_lifecycle_audit(p_app_id,NULL,'application.deletion.cleanup_started',
            jsonb_build_object('status','cleanup_pending'),jsonb_build_object('status','cleanup_in_progress'));
    END IF;
    RETURN jsonb_build_object('status','cleanup_in_progress','progress',v_app.lifecycle_cleanup_progress);
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_mark_application_files_removed(p_app_id UUID, p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Service worker authorization required' USING ERRCODE='42501'; END IF;
    UPDATE public.feltus_applications
       SET lifecycle_cleanup_progress=jsonb_set(COALESCE(lifecycle_cleanup_progress,'{}'::jsonb),'{files_removed}','true'::jsonb,true)
     WHERE id=p_app_id AND lifecycle_request_id=p_request_id AND lifecycle_status='cleanup_in_progress';
    IF NOT FOUND THEN RAISE EXCEPTION 'Deletion request is not in progress' USING ERRCODE='55000'; END IF;
    RETURN jsonb_build_object('files_removed',true);
END;
$$;

-- Owner membership stays protected for normal operations. The internal cleanup
-- transaction may remove it only after the application is tombstoned.
CREATE OR REPLACE FUNCTION public.feltus_protect_project_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_owner_id UUID;
    v_lifecycle_status TEXT;
BEGIN
    SELECT owner_id, lifecycle_status
      INTO v_owner_id, v_lifecycle_status
      FROM public.feltus_applications
     WHERE id = OLD.app_id;
    IF OLD.user_id = v_owner_id AND OLD.role = 'owner' AND TG_OP = 'DELETE'
       AND v_lifecycle_status = 'cleanup_in_progress'
       AND current_setting('feltus.lifecycle_internal', true) = 'on'
       AND COALESCE(auth.role(), '') = 'service_role' THEN
        RETURN OLD;
    END IF;
    IF OLD.user_id = v_owner_id AND OLD.role = 'owner' AND TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'The project owner must retain active owner membership'
            USING ERRCODE = '23514';
    END IF;
    IF OLD.user_id = v_owner_id AND OLD.role = 'owner' AND TG_OP = 'UPDATE'
       AND (NEW.role <> 'owner' OR NEW.disabled_at IS NOT NULL) THEN
        RAISE EXCEPTION 'The project owner must retain active owner membership'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_complete_application_cleanup(p_app_id UUID, p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$
DECLARE
    v_app public.feltus_applications%ROWTYPE;
    v_model RECORD;
    v_relation RECORD;
    v_source public.feltus_models%ROWTYPE;
    v_target public.feltus_models%ROWTYPE;
    v_source_oid OID;
    v_target_oid OID;
    v_fk_oid OID;
    v_column_ok BOOLEAN;
    v_unexpected BIGINT;
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Service worker authorization required' USING ERRCODE='42501'; END IF;
    SELECT * INTO v_app FROM public.feltus_applications WHERE id=p_app_id AND lifecycle_request_id=p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deletion request not found' USING ERRCODE='P0002'; END IF;
    IF v_app.lifecycle_status='cleanup_complete' THEN RETURN jsonb_build_object('status','cleanup_complete','idempotent',true); END IF;
    IF v_app.lifecycle_status <> 'cleanup_in_progress' OR v_app.lifecycle_cleanup_progress ->> 'files_removed' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'Local app files must be removed before database cleanup.' USING ERRCODE='55000';
    END IF;
    IF EXISTS (SELECT 1 FROM public.feltus_jobs WHERE app_id=p_app_id AND job_type <> 'application.cleanup' AND status='RUNNING') THEN
        RAISE EXCEPTION 'An app job is still stopping; cleanup can retry safely.' USING ERRCODE='55P03';
    END IF;
    IF EXISTS (SELECT 1 FROM public.feltus_builds WHERE app_id=p_app_id AND status IN ('claimed','running','building','verifying'))
       OR EXISTS (SELECT 1 FROM public.feltus_infrastructure_outbox WHERE app_id=p_app_id AND state='leased') THEN
        RAISE EXCEPTION 'A build or provider operation is still active.' USING ERRCODE='55P03';
    END IF;

    LOCK TABLE public.feltus_models, public.feltus_model_relationships IN SHARE ROW EXCLUSIVE MODE;
    FOR v_model IN SELECT id,logical_name,physical_table_name FROM public.feltus_models WHERE app_id=p_app_id AND owner_id=v_app.owner_id ORDER BY id LOOP
        IF v_model.logical_name !~ '^[a-z][a-z0-9_]{0,39}$'
           OR v_model.physical_table_name IS DISTINCT FROM ('fm_' || substring(replace(v_model.id::TEXT,'-','') FROM 1 FOR 8) || '_' || v_model.logical_name)
        THEN RAISE EXCEPTION 'Registered app model identity is invalid.' USING ERRCODE='42501'; END IF;
        SELECT c.oid INTO v_source_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relname=v_model.physical_table_name AND c.relkind='r';
        IF v_source_oid IS NULL THEN RAISE EXCEPTION 'Registered app model table is unavailable.' USING ERRCODE='42P01'; END IF;
        EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',v_model.physical_table_name);
    END LOOP;

    -- Every FK touching a managed table must have an exact, same-app registry row.
    SELECT count(*) INTO v_unexpected
      FROM pg_constraint fk
      JOIN pg_class src ON src.oid=fk.conrelid
      JOIN pg_namespace src_ns ON src_ns.oid=src.relnamespace AND src_ns.nspname='public'
      JOIN pg_class dst ON dst.oid=fk.confrelid
      JOIN pg_namespace dst_ns ON dst_ns.oid=dst.relnamespace AND dst_ns.nspname='public'
      WHERE fk.contype='f'
        AND (src.relname IN (SELECT physical_table_name FROM public.feltus_models WHERE app_id=p_app_id)
          OR dst.relname IN (SELECT physical_table_name FROM public.feltus_models WHERE app_id=p_app_id))
        AND NOT EXISTS (
          SELECT 1 FROM public.feltus_model_relationships r
          JOIN public.feltus_models sm ON sm.id=r.source_model_id AND sm.app_id=p_app_id
          JOIN public.feltus_models tm ON tm.id=r.target_model_id AND tm.app_id=p_app_id
          JOIN pg_attribute sa ON sa.attrelid=src.oid AND sa.attname=r.source_column AND NOT sa.attisdropped
          JOIN pg_attribute ta ON ta.attrelid=dst.oid AND ta.attname=r.target_column AND NOT ta.attisdropped
          WHERE r.app_id=p_app_id AND r.constraint_name=fk.conname
            AND sm.physical_table_name=src.relname AND tm.physical_table_name=dst.relname
            AND cardinality(fk.conkey)=1 AND cardinality(fk.confkey)=1
            AND fk.conkey[1]=sa.attnum AND fk.confkey[1]=ta.attnum
        );
    IF v_unexpected > 0 THEN RAISE EXCEPTION 'An unregistered or cross-application data relationship blocks cleanup.' USING ERRCODE='23503'; END IF;

    IF EXISTS (
        SELECT 1 FROM public.feltus_models model
        JOIN pg_class t ON t.relname=model.physical_table_name
        JOIN pg_namespace n ON n.oid=t.relnamespace AND n.nspname='public'
        JOIN pg_depend d ON d.refclassid='pg_class'::regclass AND d.refobjid=t.oid AND d.deptype='n'
         AND d.classid IN ('pg_rewrite'::regclass,'pg_proc'::regclass)
        WHERE model.app_id=p_app_id
    ) THEN RAISE EXCEPTION 'A database object depends on an app data table.' USING ERRCODE='2BP01'; END IF;

    FOR v_relation IN SELECT * FROM public.feltus_model_relationships WHERE app_id=p_app_id ORDER BY id LOOP
        SELECT * INTO v_source FROM public.feltus_models WHERE id=v_relation.source_model_id AND app_id=p_app_id;
        SELECT * INTO v_target FROM public.feltus_models WHERE id=v_relation.target_model_id AND app_id=p_app_id;
        IF NOT FOUND OR v_source.id IS NULL OR v_target.id IS NULL THEN RAISE EXCEPTION 'Relationship registry is outside the application scope.' USING ERRCODE='42501'; END IF;
        SELECT c.oid, cardinality(c.conkey)=1 AND cardinality(c.confkey)=1
            AND c.conkey[1]=sa.attnum AND c.confkey[1]=ta.attnum
          INTO v_fk_oid,v_column_ok
          FROM pg_constraint c
          JOIN pg_class src ON src.oid=c.conrelid JOIN pg_class dst ON dst.oid=c.confrelid
          JOIN pg_attribute sa ON sa.attrelid=src.oid AND sa.attname=v_relation.source_column AND NOT sa.attisdropped
          JOIN pg_attribute ta ON ta.attrelid=dst.oid AND ta.attname=v_relation.target_column AND NOT ta.attisdropped
         WHERE c.contype='f' AND c.conname=v_relation.constraint_name
           AND src.relname=v_source.physical_table_name AND dst.relname=v_target.physical_table_name;
        IF v_fk_oid IS NULL OR v_column_ok IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Registered relationship does not match its exact database constraint.' USING ERRCODE='23503'; END IF;
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',v_source.physical_table_name,v_relation.constraint_name);
    END LOOP;
    DELETE FROM public.feltus_model_relationships WHERE app_id=p_app_id;
    FOR v_model IN SELECT physical_table_name FROM public.feltus_models WHERE app_id=p_app_id ORDER BY id LOOP
        EXECUTE format('DROP TABLE public.%I',v_model.physical_table_name);
    END LOOP;
    DELETE FROM public.feltus_models WHERE app_id=p_app_id AND owner_id=v_app.owner_id;

    DELETE FROM public.feltus_knowledge_chunks WHERE app_id=p_app_id;
    DELETE FROM public.feltus_knowledge_bases WHERE app_id=p_app_id;
    DELETE FROM public.feltus_document_chunks WHERE app_id=p_app_id;
    DELETE FROM public.feltus_documents WHERE app_id=p_app_id;
    DELETE FROM public.feltus_ai_messages WHERE app_id=p_app_id;
    DELETE FROM public.feltus_ai_conversations WHERE app_id=p_app_id;
    DELETE FROM public.feltus_code_checkpoints WHERE app_id=p_app_id;
    DELETE FROM public.feltus_code_actions WHERE app_id=p_app_id;
    DELETE FROM public.feltus_code_sessions WHERE app_id=p_app_id;
    DELETE FROM public.feltus_project_secrets WHERE app_id=p_app_id;
    DELETE FROM public.feltus_environment_secrets WHERE app_id=p_app_id;
    DELETE FROM public.feltus_tool_executions WHERE app_id=p_app_id;
    DELETE FROM public.feltus_usage_records WHERE app_id=p_app_id;
    DELETE FROM public.user_assets WHERE app_id=p_app_id;
    PERFORM set_config('feltus.lifecycle_internal','on',true);
    DELETE FROM public.feltus_project_memberships WHERE app_id=p_app_id;
    DELETE FROM public.feltus_jobs WHERE app_id=p_app_id AND job_type <> 'application.cleanup';

    UPDATE public.feltus_applications
       SET description='', setup_data='{}'::jsonb,
           lifecycle_cleanup_progress=jsonb_set(COALESCE(lifecycle_cleanup_progress,'{}'::jsonb),'{database_removed}','true'::jsonb,true),
           lifecycle_status='cleanup_complete', setup_updated_at=now()
     WHERE id=p_app_id AND lifecycle_request_id=p_request_id;
    PERFORM public.feltus_application_lifecycle_audit(p_app_id,NULL,'application.deletion.cleanup_complete',
        jsonb_build_object('status','cleanup_in_progress'),jsonb_build_object('status','cleanup_complete'));
    RETURN jsonb_build_object('status','cleanup_complete','deleted_app_rows',true,
        'preserved_blueprints', (SELECT count(*) FROM public.feltus_application_blueprints WHERE app_id=p_app_id),
        'preserved_audit_events', (SELECT count(*) FROM public.feltus_audit_events WHERE app_id=p_app_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_fail_application_cleanup(
    p_app_id UUID, p_request_id UUID, p_error_code TEXT, p_retryable BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$
DECLARE v_state TEXT;
DECLARE v_code TEXT := left(COALESCE(NULLIF(regexp_replace(upper(COALESCE(p_error_code,'')),'[^A-Z0-9_]','','g'),''),'APP_CLEANUP_FAILED'),64);
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Service worker authorization required' USING ERRCODE='42501'; END IF;
    UPDATE public.feltus_applications
       SET lifecycle_status=CASE WHEN p_retryable THEN 'cleanup_pending' ELSE 'cleanup_failed' END,
           lifecycle_cleanup_progress=jsonb_set(COALESCE(lifecycle_cleanup_progress,'{}'::jsonb),'{last_error_code}',to_jsonb(v_code),true)
     WHERE id=p_app_id AND lifecycle_request_id=p_request_id
       AND lifecycle_status IN ('cleanup_in_progress','cleanup_pending','cleanup_failed','cleanup_blocked')
     RETURNING lifecycle_status INTO v_state;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deletion request not found' USING ERRCODE='P0002'; END IF;
    PERFORM public.feltus_application_lifecycle_audit(p_app_id,NULL,'application.deletion.cleanup_failed',
        '{}'::jsonb,jsonb_build_object('status',v_state,'error_code',v_code));
    RETURN jsonb_build_object('status',v_state,'error_code',v_code);
END;
$$;

-- Close normal RLS access as soon as archive or tombstoning occurs. Archived
-- apps remain readable; all write permissions and all tombstoned access stop.
CREATE OR REPLACE FUNCTION public.feltus_user_can_access_app(
    p_app_id UUID, p_user_id UUID, p_permission TEXT DEFAULT 'read'
)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$
    SELECT p_user_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.feltus_applications app
        WHERE app.id=p_app_id
          AND CASE
              WHEN app.lifecycle_status IN ('requested','validated','tombstoned','cleanup_pending','cleanup_in_progress','cleanup_failed','cleanup_blocked','cleanup_complete') THEN false
              WHEN app.lifecycle_status='archived' THEN p_permission IN ('read','projects.read','audit.read','builds.read','artifacts.read','deployments.read','environments.read','git.read','secrets.read')
              ELSE true
          END
          AND (
              app.owner_id=p_user_id
              OR EXISTS (
                  SELECT 1 FROM public.feltus_organization_memberships om
                  JOIN public.feltus_roles role ON role.id=om.role_id
                  JOIN public.feltus_role_permissions permission ON permission.role_id=role.id
                  WHERE om.organization_id=app.organization_id AND om.user_id=p_user_id AND om.status='active'
                    AND role.scope_key='organization'
                    AND permission.permission_key=CASE p_permission
                      WHEN 'read' THEN 'projects.read' WHEN 'write' THEN 'projects.write'
                      WHEN 'admin' THEN 'projects.admin' ELSE p_permission END
              )
              OR EXISTS (
                  SELECT 1 FROM public.feltus_project_memberships member
                  JOIN public.feltus_organization_memberships om ON om.organization_id=app.organization_id
                    AND om.user_id=p_user_id AND om.status='active'
                  JOIN public.feltus_roles role ON role.id=member.role_id
                  LEFT JOIN public.feltus_role_permissions permission ON permission.role_id=role.id AND permission.permission_key=p_permission
                  WHERE member.app_id=app.id AND member.organization_id=app.organization_id
                    AND member.user_id=p_user_id AND member.disabled_at IS NULL
                    AND (permission.permission_key IS NOT NULL OR COALESCE((member.permissions ->> p_permission)::BOOLEAN,false))
              )
          )
    );
$$;

-- Definer RPCs and PostgREST writes both pass through this guard. Internal
-- service-role cleanup is the only exception; external records remain intact.
CREATE OR REPLACE FUNCTION public.feltus_reject_inactive_application_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE v_app_id UUID;
DECLARE v_status TEXT;
BEGIN
    IF COALESCE(auth.role(),'')='service_role'
       OR current_setting('feltus.lifecycle_internal',true)='on' THEN RETURN NEW; END IF;
    v_app_id := COALESCE(NEW.app_id, OLD.app_id);
    -- Serialize app-owned writes with the tombstone transaction. Without a
    -- row lock, a concurrent insert could pass this check before deletion
    -- commits and appear after cleanup has already swept its table.
    SELECT lifecycle_status INTO v_status
      FROM public.feltus_applications WHERE id=v_app_id FOR SHARE;
    IF v_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'Application is not active for changes' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_reject_application_lifecycle_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
    IF COALESCE(auth.role(),'')='service_role'
       OR current_setting('feltus.lifecycle_internal',true)='on' THEN RETURN NEW; END IF;
    IF OLD.lifecycle_status IS DISTINCT FROM 'active'
       OR NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status
       OR NEW.lifecycle_request_id IS DISTINCT FROM OLD.lifecycle_request_id
       OR NEW.archive_previous_setup_status IS DISTINCT FROM OLD.archive_previous_setup_status
       OR NEW.setup_status='archived' THEN
        RAISE EXCEPTION 'Application lifecycle changes must use the authorized lifecycle actions.' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_application_lifecycle_write_guard ON public.feltus_applications;
CREATE TRIGGER feltus_application_lifecycle_write_guard
BEFORE UPDATE ON public.feltus_applications
FOR EACH ROW EXECUTE FUNCTION public.feltus_reject_application_lifecycle_write();
DO $$
DECLARE v_table TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'user_assets','feltus_models','feltus_model_relationships','feltus_documents','feltus_document_chunks',
        'feltus_ai_conversations','feltus_ai_messages','feltus_jobs','feltus_tool_executions',
        'feltus_knowledge_bases','feltus_knowledge_chunks','feltus_usage_records','feltus_project_secrets',
        'feltus_deployments','feltus_environments','feltus_preview_environments','feltus_project_repositories',
        'feltus_repository_branches','feltus_builds','feltus_build_steps','feltus_artifacts',
        'feltus_deployment_targets','feltus_deployment_promotions','feltus_deployment_events',
        'feltus_deployment_health_checks','feltus_deployment_domains','feltus_environment_secrets',
        'feltus_infrastructure_outbox','feltus_code_sessions','feltus_code_actions','feltus_code_checkpoints'
    ] LOOP
        IF to_regclass('public.' || quote_ident(v_table)) IS NOT NULL
           AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=v_table AND column_name='app_id') THEN
            EXECUTE format('DROP TRIGGER IF EXISTS feltus_application_lifecycle_write_guard ON public.%I',v_table);
            EXECUTE format('CREATE TRIGGER feltus_application_lifecycle_write_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.feltus_reject_inactive_application_write()',v_table);
        END IF;
    END LOOP;
END;
$$;

-- Direct table access must not bypass the explicit archive/delete contracts.
REVOKE DELETE ON public.feltus_applications FROM authenticated;
REVOKE UPDATE ON public.feltus_applications FROM authenticated;
GRANT UPDATE (app_name, environment, description, app_type, app_icon, accent_color,
    setup_status, setup_current_step, setup_completed_steps, setup_data, setup_updated_at)
    ON public.feltus_applications TO authenticated;
REVOKE ALL ON FUNCTION public.feltus_set_application_archive(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_application_deletion_impact(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_application_deletion_status(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_request_application_deletion(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_start_application_cleanup(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feltus_mark_application_files_removed(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feltus_complete_application_cleanup(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feltus_fail_application_cleanup(UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feltus_reject_application_lifecycle_write() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_set_application_archive(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_application_deletion_impact(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_application_deletion_status(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_request_application_deletion(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_start_application_cleanup(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.feltus_mark_application_files_removed(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.feltus_complete_application_cleanup(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.feltus_fail_application_cleanup(UUID, UUID, TEXT, BOOLEAN) TO service_role;

-- Keep ordinary application jobs/builds/provider commands from being claimed
-- after archive or tombstoning. The one app.cleanup job remains claimable.
CREATE OR REPLACE FUNCTION public.feltus_claim_jobs(
    p_worker_id TEXT,
    p_limit INTEGER DEFAULT 1,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS SETOF public.feltus_jobs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Worker authentication required' USING ERRCODE='42501'; END IF;
    RETURN QUERY
    WITH candidates AS (
        SELECT job.id
          FROM public.feltus_jobs job
         WHERE job.status='QUEUED' AND NOT job.cancellation_requested
           AND (job.retry_at IS NULL OR job.retry_at <= now())
           AND (job.job_type='application.cleanup' OR EXISTS (
               SELECT 1 FROM public.feltus_applications app
                WHERE app.id=job.app_id AND app.lifecycle_status='active'
           ))
         ORDER BY job.created_at
         FOR UPDATE OF job SKIP LOCKED
         LIMIT LEAST(GREATEST(COALESCE(p_limit,1),1),20)
    )
    UPDATE public.feltus_jobs job
       SET status='RUNNING', attempts=job.attempts+1, worker_id=p_worker_id,
           lease_expires_at=now()+make_interval(secs=>LEAST(GREATEST(COALESCE(p_lease_seconds,120),15),3600)),
           started_at=COALESCE(job.started_at,now()), updated_at=now()
      FROM candidates WHERE job.id=candidates.id
    RETURNING job.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_claim_builds(
    p_worker_id TEXT, p_limit INTEGER DEFAULT 1, p_lease_seconds INTEGER DEFAULT 600
)
RETURNS SETOF public.feltus_builds
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Worker authentication required' USING ERRCODE='42501'; END IF;
    IF p_worker_id IS NULL OR char_length(trim(p_worker_id)) NOT BETWEEN 1 AND 120
       OR p_lease_seconds NOT BETWEEN 60 AND 3600 THEN
        RAISE EXCEPTION 'Invalid build lease request' USING ERRCODE='22023';
    END IF;
    RETURN QUERY
    WITH candidates AS (
        SELECT build.id FROM public.feltus_builds build
        JOIN public.feltus_applications app ON app.id=build.app_id
        WHERE build.status='queued' AND app.lifecycle_status='active'
        ORDER BY build.created_at FOR UPDATE OF build SKIP LOCKED
        LIMIT LEAST(GREATEST(COALESCE(p_limit,1),1),4)
    )
    UPDATE public.feltus_builds build
       SET status='claimed', attempt_count=build.attempt_count+1, worker_id=p_worker_id,
           lease_token=gen_random_uuid(), lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
           started_at=COALESCE(build.started_at,now()), updated_at=now()
      FROM candidates WHERE build.id=candidates.id
    RETURNING build.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_claim_infrastructure_outbox(
    p_worker_id TEXT,
    p_limit INTEGER DEFAULT 1,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS SETOF public.feltus_infrastructure_outbox
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Worker authentication required' USING ERRCODE='42501'; END IF;
    IF p_worker_id IS NULL OR char_length(trim(p_worker_id)) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'Invalid worker id' USING ERRCODE='22023';
    END IF;
    UPDATE public.feltus_infrastructure_outbox
       SET state='dead_letter', lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
           last_error_code='LEASE_EXPIRED_MAX_ATTEMPTS', updated_at=now(), completed_at=now()
     WHERE state='leased' AND lease_expires_at<=now() AND attempt_count>=max_attempts;
    UPDATE public.feltus_infrastructure_outbox
       SET state='pending', available_at=now(), lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
           last_error_code=COALESCE(last_error_code,'LEASE_EXPIRED'), updated_at=now()
     WHERE state='leased' AND lease_expires_at<=now() AND attempt_count<max_attempts;
    UPDATE public.feltus_infrastructure_outbox outbox
       SET state='cancelled', lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
           last_error_code='APPLICATION_NOT_ACTIVE', completed_at=now(), updated_at=now()
      FROM public.feltus_applications app
     WHERE app.id=outbox.app_id AND app.lifecycle_status<>'active' AND outbox.state='pending';
    UPDATE public.feltus_infrastructure_outbox outbox
       SET state='cancelled', lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
           last_error_code='DEPLOYMENT_TERMINAL', completed_at=now(), updated_at=now()
      FROM public.feltus_deployments deployment
     WHERE outbox.deployment_id=deployment.id AND outbox.state='pending'
       AND deployment.status IN ('FAILED','CANCELLED','ROLLED_BACK');
    UPDATE public.feltus_infrastructure_outbox outbox
       SET state='dead_letter', last_error_code='ARTIFACT_REVOKED_OR_TARGET_DISABLED',
           completed_at=now(), updated_at=now()
      FROM public.feltus_artifacts artifact, public.feltus_deployment_targets target
     WHERE outbox.state='pending' AND artifact.id=outbox.artifact_id AND target.id=outbox.target_id
       AND (artifact.verification_status<>'passed' OR NOT target.active);
    UPDATE public.feltus_deployments deployment
       SET status='FAILED', completed_at=now()
      FROM public.feltus_infrastructure_outbox outbox
     WHERE outbox.deployment_id=deployment.id AND outbox.state='dead_letter'
       AND outbox.last_error_code IN ('LEASE_EXPIRED_MAX_ATTEMPTS','ARTIFACT_REVOKED_OR_TARGET_DISABLED')
       AND deployment.status IN ('QUEUED','BUILDING','DEPLOYING');
    RETURN QUERY
    WITH candidates AS (
        SELECT outbox.id FROM public.feltus_infrastructure_outbox outbox
        JOIN public.feltus_applications app ON app.id=outbox.app_id AND app.lifecycle_status='active'
        WHERE outbox.state='pending' AND outbox.available_at<=now() AND outbox.attempt_count<outbox.max_attempts
        ORDER BY outbox.available_at,outbox.created_at FOR UPDATE OF outbox SKIP LOCKED
        LIMIT LEAST(GREATEST(COALESCE(p_limit,1),1),50)
    )
    UPDATE public.feltus_infrastructure_outbox outbox
       SET state='leased', attempt_count=outbox.attempt_count+1, lease_owner=p_worker_id,
           lease_token=gen_random_uuid(), lease_version=outbox.lease_version+1,
           lease_expires_at=now()+make_interval(secs=>LEAST(GREATEST(COALESCE(p_lease_seconds,120),10),3600)),
           updated_at=now()
      FROM candidates WHERE outbox.id=candidates.id
    RETURNING outbox.*;
END;
$$;

NOTIFY pgrst, 'reload schema';
