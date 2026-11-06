-- Correct pgcrypto schema qualification for SECURITY DEFINER functions.
-- pgcrypto is installed in the extensions schema in FELTUS.

CREATE OR REPLACE FUNCTION public.feltus_create_application_blueprint(
    p_app_id UUID,
    p_state JSONB,
    p_state_hash TEXT,
    p_identity_json TEXT,
    p_source_wizard_state JSONB DEFAULT '{}'::jsonb
)
RETURNS public.feltus_application_blueprints
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor UUID := auth.uid();
    v_app public.feltus_applications%ROWTYPE;
    v_parent public.feltus_application_blueprints%ROWTYPE;
    v_blueprint public.feltus_application_blueprints%ROWTYPE;
    v_state JSONB;
    v_id UUID := gen_random_uuid();
    v_version INTEGER;
    v_created_at TIMESTAMPTZ := now();
BEGIN
    IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
    IF p_state IS NULL OR jsonb_typeof(p_state) <> 'object' OR p_state_hash IS NULL
       OR p_state->>'contract' <> 'feltus.application-state/v1'
       OR p_state->'application'->>'id' <> p_app_id::text
       OR octet_length(p_state::text) > 524288
       OR p_identity_json IS NULL OR octet_length(p_identity_json) > 524288
       OR p_state_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Invalid application state snapshot' USING ERRCODE = '22023';
    END IF;
    IF encode(extensions.digest(convert_to(p_identity_json, 'UTF8'), 'sha256'), 'hex') <> p_state_hash
       OR p_identity_json::jsonb IS DISTINCT FROM jsonb_build_object(
            'contract', p_state->'contract',
            'application', p_state->'application',
            'desired_state', p_state->'desired_state'
       ) THEN
        RAISE EXCEPTION 'Canonical state hash does not match the requested snapshot' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_app FROM public.feltus_applications
    WHERE id = p_app_id AND owner_id = v_actor FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Application unavailable' USING ERRCODE = '42501'; END IF;

    SELECT * INTO v_parent FROM public.feltus_application_blueprints
    WHERE app_id = p_app_id ORDER BY version DESC LIMIT 1;
    IF v_parent.id IS NOT NULL AND v_parent.state_hash = p_state_hash THEN
        IF v_parent.state->'contract' IS DISTINCT FROM p_state->'contract'
           OR v_parent.state->'application' IS DISTINCT FROM p_state->'application'
           OR v_parent.state->'desired_state' IS DISTINCT FROM p_state->'desired_state' THEN
            RAISE EXCEPTION 'State hash collision detected' USING ERRCODE = '23514';
        END IF;
        RETURN v_parent;
    END IF;

    v_version := COALESCE(v_parent.version, 0) + 1;
    IF v_parent.id IS NOT NULL AND v_parent.status = 'ready' THEN
        UPDATE public.feltus_application_blueprints SET status = 'superseded' WHERE id = v_parent.id;
    END IF;
    v_state := jsonb_set(COALESCE(p_state, '{}'::jsonb), '{blueprint}',
        COALESCE(p_state->'blueprint', '{}'::jsonb), true);
    v_state := jsonb_set(v_state, '{blueprint,id}', to_jsonb(v_id), true);
    v_state := jsonb_set(v_state, '{blueprint,version}', to_jsonb(v_version), true);
    v_state := jsonb_set(v_state, '{blueprint,parent_id}', COALESCE(to_jsonb(v_parent.id), 'null'::jsonb), true);
    v_state := jsonb_set(v_state, '{blueprint,parent_version}', COALESCE(to_jsonb(v_parent.version), 'null'::jsonb), true);
    v_state := jsonb_set(v_state, '{blueprint,status}', to_jsonb('ready'::TEXT), true);
    v_state := jsonb_set(v_state, '{blueprint,created_by}', to_jsonb(v_actor), true);
    v_state := jsonb_set(v_state, '{blueprint,created_at}', to_jsonb(v_created_at), true);
    v_state := jsonb_set(v_state, '{blueprint,state_hash}', to_jsonb(p_state_hash), true);
    INSERT INTO public.feltus_application_blueprints (
        id, organization_id, app_id, version, parent_blueprint_id, parent_version,
        state_hash, state, source_wizard_state, source_commit, status, created_by, created_at
    ) VALUES (
        v_id, v_app.organization_id, p_app_id, v_version,
        v_parent.id, v_parent.version, p_state_hash, v_state,
        COALESCE(p_source_wizard_state, '{}'::jsonb), v_state->'blueprint'->>'source_commit',
        'ready', v_actor, v_created_at
    ) RETURNING * INTO v_blueprint;

    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, actor_user_id, actor_kind, blueprint_id,
        event_category, event_severity, action_key, entity_type, entity_id, summary, after_data
    ) VALUES (
        v_app.organization_id, p_app_id, v_actor, 'user', v_blueprint.id,
        'application', 'info', 'blueprint.created', 'application_blueprint', v_blueprint.id::text, 'Application blueprint saved',
        jsonb_build_object('version', v_blueprint.version, 'state_hash', v_blueprint.state_hash)
    );
    RETURN v_blueprint;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_queue_application_build(
    p_app_id UUID,
    p_repository_id UUID,
    p_blueprint_id UUID,
    p_source_branch TEXT,
    p_commit_sha TEXT,
    p_actor_id UUID,
    p_idempotency_key TEXT
)
RETURNS public.feltus_builds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_app public.feltus_applications%ROWTYPE;
    v_repository public.feltus_repositories%ROWTYPE;
    v_blueprint public.feltus_application_blueprints%ROWTYPE;
    v_existing public.feltus_builds%ROWTYPE;
    v_build public.feltus_builds%ROWTYPE;
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN
        RAISE EXCEPTION 'Server authorization required' USING ERRCODE = '42501';
    END IF;
    IF p_source_branch IS NULL OR char_length(p_source_branch) NOT BETWEEN 1 AND 255
       OR p_source_branch !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$'
       OR p_source_branch LIKE '%..%' OR p_source_branch LIKE '%@{%' OR p_source_branch LIKE '%//%'
       OR p_commit_sha IS NULL OR p_commit_sha !~ '^[0-9a-fA-F]{40,64}$'
       OR p_idempotency_key IS NULL OR char_length(trim(p_idempotency_key)) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'Invalid source build request' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_app FROM public.feltus_applications WHERE id = p_app_id;
    IF NOT FOUND OR NOT public.feltus_user_can_access_app(p_app_id, p_actor_id, 'builds.trigger') THEN
        RAISE EXCEPTION 'Build actor is not authorized' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_repository FROM public.feltus_repositories
    WHERE id = p_repository_id AND organization_id = v_app.organization_id AND archived_at IS NULL;
    IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM public.feltus_project_repositories
        WHERE app_id = p_app_id AND organization_id = v_app.organization_id AND repository_id = p_repository_id
    ) THEN
        RAISE EXCEPTION 'Repository is not connected to this application' USING ERRCODE = '23503';
    END IF;
    IF p_source_branch <> v_repository.default_branch AND NOT EXISTS (
        SELECT 1 FROM public.feltus_repository_branches
        WHERE app_id = p_app_id AND repository_id = p_repository_id AND branch_name = p_source_branch
    ) THEN
        RAISE EXCEPTION 'The selected branch is not registered for this application' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_blueprint FROM public.feltus_application_blueprints
    WHERE id = p_blueprint_id AND app_id = p_app_id
      AND status NOT IN ('draft','archived');
    IF NOT FOUND OR (v_blueprint.state->'desired_state'->'code'->>'repository_id' IS NOT NULL
        AND v_blueprint.state->'desired_state'->'code'->>'repository_id' <> p_repository_id::text) THEN
        RAISE EXCEPTION 'Build blueprint is missing or references another repository' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_existing FROM public.feltus_builds
    WHERE app_id = p_app_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_existing.repository_id <> p_repository_id OR v_existing.blueprint_id <> p_blueprint_id
           OR v_existing.source_branch <> p_source_branch OR lower(v_existing.commit_sha) <> lower(p_commit_sha) THEN
            RAISE EXCEPTION 'Build idempotency key was reused for a different source' USING ERRCODE = '23505';
        END IF;
        RETURN v_existing;
    END IF;
    INSERT INTO public.feltus_builds (
        organization_id, app_id, repository_id, requested_by, source_branch, commit_sha,
        status, build_provider, idempotency_key, request_fingerprint, blueprint_id, max_attempts
    ) VALUES (
        v_app.organization_id, p_app_id, p_repository_id, p_actor_id, p_source_branch, lower(p_commit_sha),
        'queued', 'docker', p_idempotency_key,
        encode(extensions.digest(convert_to(p_app_id::text || ':' || p_repository_id::text || ':' || p_blueprint_id::text || ':' || p_source_branch || ':' || lower(p_commit_sha), 'UTF8'), 'sha256'), 'hex'),
        p_blueprint_id, 3
    ) RETURNING * INTO v_build;
    RETURN v_build;
END;
$$;

NOTIFY pgrst, 'reload schema';
