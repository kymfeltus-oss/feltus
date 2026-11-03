-- Forward-only repair for environments where the deployment-control-plane
-- migration was already recorded before its pgcrypto function path was fixed.
CREATE OR REPLACE FUNCTION public.feltus_validate_deployment_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, extensions, public
AS $$
DECLARE
    v_org_id UUID;
    v_environment_id UUID;
    v_artifact_status TEXT;
    v_promotion RECORD;
BEGIN
    IF TG_OP = 'UPDATE' AND
       (NEW.app_id, NEW.organization_id, NEW.environment, NEW.environment_id, NEW.artifact_id,
        NEW.owner_id, NEW.requested_by, NEW.branch, NEW.commit_sha, NEW.provider,
        NEW.idempotency_key, NEW.promotion_id)
       IS DISTINCT FROM
       (OLD.app_id, OLD.organization_id, OLD.environment, OLD.environment_id, OLD.artifact_id,
        OLD.owner_id, OLD.requested_by, OLD.branch, OLD.commit_sha, OLD.provider,
        OLD.idempotency_key, OLD.promotion_id) THEN
        RAISE EXCEPTION 'Deployment source, target, actor, and artifact are immutable after creation'
            USING ERRCODE = '23514';
    END IF;

    SELECT organization_id INTO v_org_id
    FROM public.feltus_applications WHERE id = NEW.app_id;
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'Project is unavailable' USING ERRCODE = '23503';
    END IF;
    IF NEW.organization_id IS NOT NULL AND NEW.organization_id <> v_org_id THEN
        RAISE EXCEPTION 'Deployment organization does not match project' USING ERRCODE = '23514';
    END IF;
    NEW.organization_id := v_org_id;

    IF NEW.environment_id IS NULL THEN
        SELECT id INTO v_environment_id
        FROM public.feltus_environments
        WHERE app_id = NEW.app_id AND kind = lower(NEW.environment)
        ORDER BY created_at LIMIT 1;
        NEW.environment_id := v_environment_id;
    END IF;
    IF NEW.environment_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.feltus_environments env
        WHERE env.id = NEW.environment_id AND env.app_id = NEW.app_id
          AND env.organization_id = v_org_id AND env.kind = lower(NEW.environment)
    ) THEN
        RAISE EXCEPTION 'Deployment environment does not match project' USING ERRCODE = '23514';
    END IF;

    NEW.requested_by := COALESCE(NEW.requested_by, NEW.owner_id);
    IF NEW.artifact_id IS NOT NULL THEN
        IF NOT public.feltus_user_can_access_app(NEW.app_id, NEW.requested_by, 'deployments.create') THEN
            RAISE EXCEPTION 'Deployment actor is not authorized for this project'
                USING ERRCODE = '42501';
        END IF;
        SELECT verification_status INTO v_artifact_status
        FROM public.feltus_artifacts
        WHERE id = NEW.artifact_id AND app_id = NEW.app_id AND organization_id = v_org_id;
        IF v_artifact_status IS DISTINCT FROM 'passed' THEN
            RAISE EXCEPTION 'Only a verified artifact from this project can be deployed'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.idempotency_key IS NULL OR char_length(trim(NEW.idempotency_key)) NOT BETWEEN 1 AND 200 THEN
            RAISE EXCEPTION 'Artifact deployments require an idempotency key'
                USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.feltus_deployment_targets target
            WHERE target.environment_id = NEW.environment_id
              AND target.app_id = NEW.app_id
              AND target.organization_id = v_org_id
              AND target.provider_key = NEW.provider
              AND target.active
        ) THEN
            RAISE EXCEPTION 'No active deployment target is configured for this environment'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.promotion_id IS NOT NULL THEN
            SELECT promotion.* INTO v_promotion
            FROM public.feltus_deployment_promotions promotion
            WHERE promotion.id = NEW.promotion_id
              AND promotion.app_id = NEW.app_id
              AND promotion.organization_id = v_org_id;
            IF NOT FOUND OR v_promotion.target_environment_id <> NEW.environment_id
               OR v_promotion.artifact_id <> NEW.artifact_id THEN
                RAISE EXCEPTION 'Promotion must deploy its approved artifact to its target environment'
                    USING ERRCODE = '23514';
            END IF;
        END IF;
        NEW.request_fingerprint := encode(digest(
            NEW.app_id::TEXT || ':' || NEW.environment_id::TEXT || ':' || NEW.artifact_id::TEXT,
            'sha256'
        ), 'hex');
    END IF;
    RETURN NEW;
END;
$$;
