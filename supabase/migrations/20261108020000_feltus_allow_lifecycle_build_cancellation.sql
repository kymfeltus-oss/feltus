-- Permit the deletion request to cancel a queued build after it tombstones
-- the application, without weakening normal build actor authorization.
CREATE OR REPLACE FUNCTION public.feltus_validate_build_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_signature_verified BOOLEAN;
    v_webhook_status TEXT;
    v_webhook_commit TEXT;
    v_webhook_branch TEXT;
    v_lifecycle_cancellation BOOLEAN := false;
BEGIN
    IF TG_OP = 'UPDATE' AND
       (NEW.organization_id, NEW.app_id, NEW.repository_id, NEW.source_branch,
        NEW.commit_sha, NEW.requested_by, NEW.build_provider, NEW.idempotency_key,
        NEW.request_fingerprint)
       IS DISTINCT FROM
       (OLD.organization_id, OLD.app_id, OLD.repository_id, OLD.source_branch,
        OLD.commit_sha, OLD.requested_by, OLD.build_provider, OLD.idempotency_key,
        OLD.request_fingerprint) THEN
        RAISE EXCEPTION 'Build source and request identity are immutable'
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status IN ('succeeded','failed','cancelled')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'Terminal build status is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.attempt_count < OLD.attempt_count THEN
        RAISE EXCEPTION 'Build attempt count cannot decrease' USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'UPDATE'
       AND OLD.status = 'queued'
       AND NEW.status = 'cancelled'
       AND current_setting('feltus.lifecycle_internal', true) = 'on' THEN
        SELECT EXISTS (
            SELECT 1 FROM public.feltus_applications app
             WHERE app.id = NEW.app_id
               AND app.lifecycle_status = 'cleanup_pending'
               AND app.lifecycle_request_id IS NOT NULL
               AND (COALESCE(auth.role(), '') = 'service_role' OR auth.uid() = app.owner_id)
        ) INTO v_lifecycle_cancellation;
    END IF;
    IF NEW.requested_by IS NOT NULL
       AND NOT public.feltus_user_can_access_app(NEW.app_id, NEW.requested_by, 'builds.trigger')
       AND NOT v_lifecycle_cancellation THEN
        RAISE EXCEPTION 'Build actor is not authorized for this project'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.webhook_event_id IS NOT NULL THEN
        SELECT signature_verified, status, commit_sha, branch_name
        INTO v_signature_verified, v_webhook_status, v_webhook_commit, v_webhook_branch
        FROM public.feltus_git_webhook_events
        WHERE id = NEW.webhook_event_id
          AND repository_id = NEW.repository_id
          AND organization_id = NEW.organization_id;
        IF NOT FOUND OR NOT v_signature_verified OR v_webhook_status NOT IN ('queued','processed') THEN
            RAISE EXCEPTION 'Build webhook must be signature-verified and accepted'
                USING ERRCODE = '42501';
        END IF;
        IF (v_webhook_commit IS NOT NULL AND lower(v_webhook_commit) <> lower(NEW.commit_sha))
           OR (v_webhook_branch IS NOT NULL AND v_webhook_branch <> NEW.source_branch) THEN
            RAISE EXCEPTION 'Build source does not match its accepted webhook'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
