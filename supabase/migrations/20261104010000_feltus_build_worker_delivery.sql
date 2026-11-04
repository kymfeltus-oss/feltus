-- FELTUS isolated build-worker execution and structured delivery lifecycle.
ALTER TABLE public.feltus_builds
    ADD COLUMN IF NOT EXISTS exit_code INTEGER;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_build_exit_code_check') THEN
        ALTER TABLE public.feltus_builds
            ADD CONSTRAINT feltus_build_exit_code_check CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND 255);
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.feltus_audit_build_queued()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, actor_user_id, actor_kind, blueprint_id, commit_sha, build_id,
        event_category, event_severity, action_key, entity_type, entity_id, summary, after_data
    ) VALUES (
        NEW.organization_id, NEW.app_id, NEW.requested_by,
        CASE WHEN NEW.requested_by IS NULL THEN 'system' ELSE 'user' END,
        NEW.blueprint_id, NEW.commit_sha, NEW.id, 'build', 'info', 'build.queued', 'application_build',
        NEW.id::text, 'Build queued',
        jsonb_build_object('repository_id', NEW.repository_id, 'branch', NEW.source_branch, 'commit_sha', NEW.commit_sha)
    );
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS feltus_build_queued_audit ON public.feltus_builds;
CREATE TRIGGER feltus_build_queued_audit
AFTER INSERT ON public.feltus_builds
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_build_queued();

CREATE OR REPLACE FUNCTION public.feltus_cancel_build(p_app_id UUID, p_build_id UUID, p_actor_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_build public.feltus_builds%ROWTYPE;
BEGIN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
        RAISE EXCEPTION 'Server authorization required' USING ERRCODE = '42501';
    END IF;
    IF NOT public.feltus_user_can_access_app(p_app_id, p_actor_id, 'builds.trigger') THEN
        RAISE EXCEPTION 'Build actor is not authorized for this application' USING ERRCODE = '42501';
    END IF;
    UPDATE public.feltus_builds SET status = 'cancelled', completed_at = now(),
        worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = p_build_id AND app_id = p_app_id
      AND status IN ('queued','claimed','running','building','verifying')
    RETURNING * INTO v_build;
    IF NOT FOUND THEN RETURN false; END IF;
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, actor_user_id, actor_kind, blueprint_id, commit_sha, build_id,
        event_category, event_severity, action_key, entity_type, entity_id, summary, after_data
    ) VALUES (
        v_build.organization_id, v_build.app_id, p_actor_id, 'user', v_build.blueprint_id,
        v_build.commit_sha, v_build.id, 'build', 'info', 'build.cancelled',
        'application_build', v_build.id::text, 'Build cancelled',
        jsonb_build_object('exit_code', v_build.exit_code)
    );
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_cancel_build(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_cancel_build(UUID, UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_start_application_build(p_build_id UUID, p_lease_token UUID)
RETURNS public.feltus_builds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_build public.feltus_builds%ROWTYPE;
BEGIN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
        RAISE EXCEPTION 'Worker authentication required' USING ERRCODE = '42501';
    END IF;
    UPDATE public.feltus_builds
    SET status = 'running', updated_at = now()
    WHERE id = p_build_id AND lease_token = p_lease_token AND status = 'claimed'
      AND lease_expires_at > now()
    RETURNING * INTO v_build;
    IF NOT FOUND THEN RAISE EXCEPTION 'Build lease is stale or build is no longer claimable' USING ERRCODE = '40001'; END IF;
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, actor_kind, blueprint_id, commit_sha, build_id,
        event_category, event_severity, action_key, entity_type, entity_id, summary, after_data
    ) VALUES (
        v_build.organization_id, v_build.app_id, 'service', v_build.blueprint_id, v_build.commit_sha,
        v_build.id, 'build', 'info', 'build.started', 'application_build', v_build.id::text,
        'Build started', jsonb_build_object('repository_id', v_build.repository_id, 'branch', v_build.source_branch)
    );
    RETURN v_build;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_start_application_build(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_start_application_build(UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_recover_stale_builds()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
        RAISE EXCEPTION 'Worker authentication required' USING ERRCODE = '42501';
    END IF;
    WITH expired AS (
        UPDATE public.feltus_builds
        SET status = 'failed', failure_code = 'BUILD_LEASE_EXPIRED', exit_code = COALESCE(exit_code, 1),
            completed_at = now(), worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE status IN ('claimed','running','building','verifying') AND lease_expires_at < now()
        RETURNING *
    )
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, actor_kind, blueprint_id, commit_sha, build_id,
        event_category, event_severity, action_key, entity_type, entity_id, summary, after_data
    )
    SELECT organization_id, app_id, 'service', blueprint_id, commit_sha, id,
        'build', 'error', 'build.failed', 'application_build', id::text,
        'Build worker lease expired',
        jsonb_build_object('failure_code', 'BUILD_LEASE_EXPIRED', 'exit_code', COALESCE(exit_code, 1))
    FROM expired;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_recover_stale_builds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_recover_stale_builds() TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_fail_application_build(
    p_build_id UUID, p_lease_token UUID, p_failure_code TEXT, p_exit_code INTEGER
)
RETURNS public.feltus_builds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_build public.feltus_builds%ROWTYPE;
BEGIN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
        RAISE EXCEPTION 'Worker authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_failure_code IS NULL OR p_failure_code !~ '^[A-Z0-9_]{1,64}$'
       OR p_exit_code IS NULL OR p_exit_code NOT BETWEEN 0 AND 255 THEN
        RAISE EXCEPTION 'Invalid build failure record' USING ERRCODE = '22023';
    END IF;
    UPDATE public.feltus_builds
    SET status = 'failed', failure_code = p_failure_code, exit_code = p_exit_code,
        completed_at = now(), worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = p_build_id AND lease_token = p_lease_token
      AND status IN ('running','building','verifying') AND lease_expires_at > now()
    RETURNING * INTO v_build;
    IF NOT FOUND THEN RAISE EXCEPTION 'Build lease is stale or failure transition is invalid' USING ERRCODE = '40001'; END IF;
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, actor_kind, blueprint_id, commit_sha, build_id,
        event_category, event_severity, action_key, entity_type, entity_id, summary, after_data
    ) VALUES (
        v_build.organization_id, v_build.app_id, 'service', v_build.blueprint_id, v_build.commit_sha,
        v_build.id, 'build', 'error', 'build.failed', 'application_build', v_build.id::text,
        'Build failed', jsonb_build_object('failure_code', p_failure_code, 'exit_code', p_exit_code)
    );
    RETURN v_build;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_fail_application_build(UUID, UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_fail_application_build(UUID, UUID, TEXT, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_finish_application_build(
    p_build_id UUID, p_lease_token UUID, p_registry_image TEXT, p_digest TEXT, p_provenance JSONB
)
RETURNS public.feltus_artifacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_build public.feltus_builds%ROWTYPE;
    v_artifact public.feltus_artifacts%ROWTYPE;
BEGIN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
        RAISE EXCEPTION 'Worker authentication required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_build FROM public.feltus_builds
    WHERE id = p_build_id AND lease_token = p_lease_token
      AND status = 'verifying' AND lease_expires_at > now() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Build lease is stale or build is not verifying' USING ERRCODE = '40001'; END IF;
    UPDATE public.feltus_builds SET exit_code = 0, updated_at = now()
    WHERE id = v_build.id AND lease_token = p_lease_token;
    v_artifact := public.feltus_finish_build_with_artifact(
        p_build_id, p_lease_token, p_registry_image, p_digest, p_provenance
    );
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, actor_kind, blueprint_id, commit_sha, build_id, artifact_id,
        event_category, event_severity, action_key, entity_type, entity_id, summary, after_data
    ) VALUES (
        v_build.organization_id, v_build.app_id, 'service', v_build.blueprint_id, v_build.commit_sha,
        v_build.id, v_artifact.id, 'build', 'info', 'build.succeeded', 'application_build', v_build.id::text,
        'Build succeeded', jsonb_build_object('artifact_id', v_artifact.id, 'artifact_digest', p_digest)
    );
    RETURN v_artifact;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_finish_application_build(UUID, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_finish_application_build(UUID, UUID, TEXT, TEXT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_audit_artifact_deployment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_action TEXT;
    v_summary TEXT;
    v_severity TEXT := 'info';
BEGIN
    IF TG_OP = 'INSERT' AND NEW.artifact_id IS NOT NULL THEN
        v_action := 'deployment.requested';
        v_summary := initcap(NEW.environment) || ' deployment requested';
    ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'DEPLOYING' THEN
        v_action := 'deployment.started';
        v_summary := initcap(NEW.environment) || ' deployment started';
    ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'HEALTHY' THEN
        v_action := 'deployment.succeeded';
        v_summary := initcap(NEW.environment) || ' deployment completed';
    ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'FAILED' THEN
        v_action := 'deployment.failed';
        v_summary := initcap(NEW.environment) || ' deployment failed';
        v_severity := 'error';
    ELSE
        RETURN NEW;
    END IF;
    IF NEW.artifact_id IS NULL THEN RETURN NEW; END IF;
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, environment_id, actor_user_id, actor_kind, blueprint_id,
        commit_sha, artifact_id, deployment_id, event_category, event_severity, action_key,
        entity_type, entity_id, summary, after_data
    ) VALUES (
        NEW.organization_id, NEW.app_id, NEW.environment_id,
        CASE WHEN TG_OP = 'INSERT' THEN NEW.requested_by ELSE NULL END,
        CASE WHEN TG_OP = 'INSERT' AND NEW.requested_by IS NOT NULL THEN 'user' ELSE 'service' END,
        NEW.blueprint_id, NEW.commit_sha, NEW.artifact_id, NEW.id, 'deployment', v_severity,
        v_action, 'application_deployment', NEW.id::text, v_summary,
        jsonb_build_object('environment', NEW.environment, 'status', NEW.status,
            'artifact_digest', NEW.artifact_digest, 'provider', NEW.provider,
            'provider_deployment_id', NEW.provider_reference)
    );
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS feltus_deployment_lifecycle_audit ON public.feltus_deployments;
CREATE TRIGGER feltus_deployment_lifecycle_audit
AFTER INSERT OR UPDATE ON public.feltus_deployments
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_artifact_deployment();

CREATE OR REPLACE FUNCTION public.feltus_audit_observed_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, environment_id, actor_kind, blueprint_id, commit_sha,
        artifact_id, deployment_id, event_category, event_severity, action_key, entity_type,
        entity_id, summary, after_data
    ) VALUES (
        NEW.organization_id, NEW.app_id, NEW.environment_id, 'service', NEW.blueprint_id, NEW.commit_sha,
        NEW.artifact_id, NEW.deployment_id, 'deployment', 'info', 'health.observed',
        'observed_application_state', NEW.id::text,
        initcap(NEW.environment) || CASE WHEN NEW.health = 'healthy' THEN ' health verified' ELSE ' health observed' END,
        jsonb_build_object('environment', NEW.environment, 'provider', NEW.provider,
            'provider_deployment_id', NEW.provider_deployment_id, 'artifact_digest', NEW.artifact_digest,
            'health', NEW.health, 'observed_at', NEW.observed_at)
    );
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, environment_id, actor_kind, blueprint_id, commit_sha,
        artifact_id, deployment_id, event_category, event_severity, action_key, entity_type,
        entity_id, summary, after_data
    ) VALUES (
        NEW.organization_id, NEW.app_id, NEW.environment_id, 'service', NEW.blueprint_id, NEW.commit_sha,
        NEW.artifact_id, NEW.deployment_id, 'deployment', 'info', 'state.reconciled',
        'observed_application_state', NEW.id::text, initcap(NEW.environment) || ' state reconciled',
        jsonb_build_object('state_hash', NEW.state_hash, 'health', NEW.health,
            'environment', NEW.environment, 'artifact_digest', NEW.artifact_digest)
    );
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS feltus_observed_state_lifecycle_audit ON public.feltus_observed_application_states;
CREATE TRIGGER feltus_observed_state_lifecycle_audit
AFTER INSERT ON public.feltus_observed_application_states
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_observed_state();
