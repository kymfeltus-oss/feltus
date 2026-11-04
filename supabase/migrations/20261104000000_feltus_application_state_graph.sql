-- FELTUS Phase 3: relational persistence for the feltus.application-state/v1
-- contract. The JSON contract is defined independently in docs/application-state-contract-v1.md.

-- The approved seven-step product flow calls the former Documents step Knowledge.
-- Keep old route names accepted in persisted rows so existing drafts remain resumable.
ALTER TABLE public.feltus_applications
    DROP CONSTRAINT IF EXISTS feltus_applications_setup_step_check;
ALTER TABLE public.feltus_applications
    ADD CONSTRAINT feltus_applications_setup_step_check
    CHECK (setup_current_step IN (
        'overview','basics','data','knowledge','relationships','documents',
        'ai','code','environment','review','build'
    ));

CREATE TABLE IF NOT EXISTS public.feltus_application_blueprints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    parent_blueprint_id UUID,
    parent_version INTEGER,
    contract_id TEXT NOT NULL DEFAULT 'feltus.application-state/v1'
        CHECK (contract_id = 'feltus.application-state/v1'),
    schema_version TEXT NOT NULL DEFAULT '1.0.0',
    state_hash TEXT NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
    source_wizard_state JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_wizard_state) = 'object'),
    source_commit TEXT CHECK (source_commit IS NULL OR source_commit ~ '^[0-9a-fA-F]{40,64}$'),
    status TEXT NOT NULL DEFAULT 'ready'
        CHECK (status IN ('draft','ready','building','deployed','superseded','archived')),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, app_id, organization_id),
    UNIQUE (app_id, version),
    FOREIGN KEY (app_id, organization_id)
        REFERENCES public.feltus_applications(id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_blueprint_id, app_id, organization_id)
        REFERENCES public.feltus_application_blueprints(id, app_id, organization_id) ON DELETE RESTRICT,
    CHECK ((version = 1 AND parent_blueprint_id IS NULL AND parent_version IS NULL)
        OR (version > 1 AND parent_blueprint_id IS NOT NULL AND parent_version = version - 1))
);

CREATE INDEX IF NOT EXISTS feltus_blueprints_app_version_idx
    ON public.feltus_application_blueprints(app_id, version DESC);
CREATE INDEX IF NOT EXISTS feltus_blueprints_app_state_hash_idx
    ON public.feltus_application_blueprints(app_id, state_hash, version DESC);

CREATE OR REPLACE FUNCTION public.feltus_protect_application_blueprint_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Blueprint history is immutable' USING ERRCODE = '23514';
    END IF;
    IF (NEW.id, NEW.organization_id, NEW.app_id, NEW.version, NEW.parent_blueprint_id,
        NEW.parent_version, NEW.contract_id, NEW.schema_version, NEW.state_hash,
        NEW.state, NEW.source_wizard_state, NEW.source_commit, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.organization_id, OLD.app_id, OLD.version, OLD.parent_blueprint_id,
        OLD.parent_version, OLD.contract_id, OLD.schema_version, OLD.state_hash,
        OLD.state, OLD.source_wizard_state, OLD.source_commit, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'Blueprint content and lineage are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'draft' AND NEW.status IN ('ready','archived')) OR
        (OLD.status = 'ready' AND NEW.status IN ('building','deployed','superseded','archived')) OR
        (OLD.status = 'building' AND NEW.status IN ('ready','deployed','superseded','archived')) OR
        (OLD.status = 'deployed' AND NEW.status IN ('superseded','archived')) OR
        (OLD.status = 'superseded' AND NEW.status = 'archived')
    ) THEN
        RAISE EXCEPTION 'Invalid blueprint status transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS feltus_blueprint_history_immutable ON public.feltus_application_blueprints;
CREATE TRIGGER feltus_blueprint_history_immutable
BEFORE UPDATE OR DELETE ON public.feltus_application_blueprints
FOR EACH ROW EXECUTE FUNCTION public.feltus_protect_application_blueprint_history();

ALTER TABLE public.feltus_builds ADD COLUMN IF NOT EXISTS blueprint_id UUID;
ALTER TABLE public.feltus_builds ADD COLUMN IF NOT EXISTS worker_id TEXT;
ALTER TABLE public.feltus_builds ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE public.feltus_builds ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE public.feltus_builds ADD COLUMN IF NOT EXISTS failure_code TEXT;
ALTER TABLE public.feltus_builds ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.feltus_builds DROP CONSTRAINT IF EXISTS feltus_builds_status_check;
ALTER TABLE public.feltus_builds ADD CONSTRAINT feltus_builds_status_check
    CHECK (status IN ('queued','claimed','running','building','verifying','succeeded','failed','cancelled'));
ALTER TABLE public.feltus_builds ADD CONSTRAINT feltus_builds_attempt_limit_check
    CHECK (max_attempts BETWEEN 1 AND 5);
ALTER TABLE public.feltus_artifacts ADD COLUMN IF NOT EXISTS blueprint_id UUID;
ALTER TABLE public.feltus_artifacts ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.feltus_artifacts ADD COLUMN IF NOT EXISTS environment_eligibility TEXT[] NOT NULL DEFAULT ARRAY['development','preview','staging']::TEXT[];
ALTER TABLE public.feltus_artifacts ALTER COLUMN environment_eligibility SET DEFAULT ARRAY['development','preview','staging','production']::TEXT[];
ALTER TABLE public.feltus_deployments ADD COLUMN IF NOT EXISTS blueprint_id UUID;
ALTER TABLE public.feltus_deployments ADD COLUMN IF NOT EXISTS artifact_digest TEXT;
ALTER TABLE public.feltus_deployments ADD COLUMN IF NOT EXISTS rollback_reason TEXT;
ALTER TABLE public.feltus_build_steps ADD COLUMN IF NOT EXISTS log_text TEXT NOT NULL DEFAULT '';
ALTER TABLE public.feltus_repositories ADD COLUMN IF NOT EXISTS webhook_id TEXT;
ALTER TABLE public.feltus_repositories ADD COLUMN IF NOT EXISTS webhook_secret_ciphertext BYTEA;
ALTER TABLE public.feltus_repositories ADD COLUMN IF NOT EXISTS webhook_secret_key_version TEXT;
ALTER TABLE public.feltus_repository_branches ADD COLUMN IF NOT EXISTS latest_commit_sha TEXT;
ALTER TABLE public.feltus_repository_branches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Encrypted webhook secrets are only available to the server worker. The old
-- table-wide SELECT grant is narrowed after adding the protected columns.
REVOKE SELECT ON public.feltus_repositories FROM anon, authenticated;
GRANT SELECT (id, organization_id, git_connection_id, provider_repository_id,
    repository_name, clone_url, default_branch, archived_at, created_at, updated_at)
    ON public.feltus_repositories TO authenticated;

ALTER TABLE public.feltus_build_steps ADD CONSTRAINT feltus_build_steps_log_size_check
    CHECK (char_length(log_text) <= 50000);
ALTER TABLE public.feltus_builds ADD CONSTRAINT feltus_builds_failure_code_check
    CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$');
ALTER TABLE public.feltus_artifacts ADD CONSTRAINT feltus_artifact_environment_eligibility_check
    CHECK (environment_eligibility <@ ARRAY['development','preview','staging','production']::TEXT[]);
ALTER TABLE public.feltus_deployments ADD CONSTRAINT feltus_deployment_rollback_reason_check
    CHECK (rollback_reason IS NULL OR char_length(trim(rollback_reason)) BETWEEN 1 AND 500);
ALTER TABLE public.feltus_deployments ADD CONSTRAINT feltus_deployment_artifact_digest_check
    CHECK (artifact_digest IS NULL OR artifact_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE public.feltus_repository_branches ADD CONSTRAINT feltus_repository_branch_latest_commit_check
    CHECK (latest_commit_sha IS NULL OR latest_commit_sha ~ '^[0-9a-fA-F]{40,64}$');

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_builds_blueprint_scope_fkey') THEN
        ALTER TABLE public.feltus_builds ADD CONSTRAINT feltus_builds_blueprint_scope_fkey
            FOREIGN KEY (blueprint_id, app_id, organization_id)
            REFERENCES public.feltus_application_blueprints(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_artifacts_blueprint_scope_fkey') THEN
        ALTER TABLE public.feltus_artifacts ADD CONSTRAINT feltus_artifacts_blueprint_scope_fkey
            FOREIGN KEY (blueprint_id, app_id, organization_id)
            REFERENCES public.feltus_application_blueprints(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_deployments_blueprint_scope_fkey') THEN
        ALTER TABLE public.feltus_deployments ADD CONSTRAINT feltus_deployments_blueprint_scope_fkey
            FOREIGN KEY (blueprint_id, app_id, organization_id)
            REFERENCES public.feltus_application_blueprints(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.feltus_keep_verified_artifact_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF OLD.verification_status IN ('passed','revoked')
       AND (NEW.app_id, NEW.organization_id, NEW.build_id, NEW.blueprint_id,
            NEW.registry_image, NEW.artifact_digest, NEW.provenance, NEW.environment_eligibility)
           IS DISTINCT FROM
           (OLD.app_id, OLD.organization_id, OLD.build_id, OLD.blueprint_id,
            OLD.registry_image, OLD.artifact_digest, OLD.provenance, OLD.environment_eligibility) THEN
        RAISE EXCEPTION 'Verified artifact identity and provenance are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.verification_status = 'passed' AND NEW.verification_status NOT IN ('passed','revoked') THEN
        RAISE EXCEPTION 'Verified artifact cannot return to an unverified state' USING ERRCODE = '23514';
    END IF;
    IF OLD.verification_status = 'revoked' AND NEW.verification_status <> 'revoked' THEN
        RAISE EXCEPTION 'Revoked artifacts cannot be re-verified in place' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_validate_deployment_blueprint_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_artifact public.feltus_artifacts%ROWTYPE;
    v_build public.feltus_builds%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.artifact_id, NEW.blueprint_id, NEW.artifact_digest, NEW.commit_sha)
       IS DISTINCT FROM (OLD.artifact_id, OLD.blueprint_id, OLD.artifact_digest, OLD.commit_sha) THEN
        RAISE EXCEPTION 'Deployment artifact, blueprint, digest, and commit are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.artifact_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO v_artifact FROM public.feltus_artifacts
    WHERE id = NEW.artifact_id AND app_id = NEW.app_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deployment artifact is unavailable' USING ERRCODE = '23503'; END IF;
    IF TG_OP = 'UPDATE' AND v_artifact.blueprint_id IS NULL AND OLD.blueprint_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF v_artifact.blueprint_id IS NULL OR v_artifact.blueprint_id IS DISTINCT FROM NEW.blueprint_id THEN
        RAISE EXCEPTION 'Deployment blueprint does not match its artifact' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_build FROM public.feltus_builds
    WHERE id = v_artifact.build_id AND app_id = NEW.app_id;
    IF NOT FOUND OR v_build.blueprint_id IS DISTINCT FROM v_artifact.blueprint_id THEN
        RAISE EXCEPTION 'Deployment build lineage is incomplete' USING ERRCODE = '23514';
    END IF;
    IF NEW.commit_sha IS NULL THEN
        NEW.commit_sha := v_build.commit_sha;
    ELSIF lower(NEW.commit_sha) <> lower(v_build.commit_sha) THEN
        RAISE EXCEPTION 'Deployment commit does not match artifact source' USING ERRCODE = '23514';
    END IF;
    IF NEW.artifact_digest IS NULL THEN
        NEW.artifact_digest := v_artifact.artifact_digest;
    ELSIF NEW.artifact_digest <> v_artifact.artifact_digest THEN
        RAISE EXCEPTION 'Deployment digest does not match artifact' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS feltus_deployment_blueprint_lineage ON public.feltus_deployments;
CREATE TRIGGER feltus_deployment_blueprint_lineage
BEFORE INSERT OR UPDATE ON public.feltus_deployments
FOR EACH ROW EXECUTE FUNCTION public.feltus_validate_deployment_blueprint_lineage();

UPDATE public.feltus_artifacts artifact
SET blueprint_id = build.blueprint_id
FROM public.feltus_builds build
WHERE artifact.build_id = build.id AND artifact.app_id = build.app_id
  AND artifact.blueprint_id IS NULL AND build.blueprint_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.feltus_protect_blueprint_execution_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.blueprint_id IS DISTINCT FROM OLD.blueprint_id THEN
        RAISE EXCEPTION 'Execution blueprint lineage is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS feltus_build_blueprint_immutable ON public.feltus_builds;
CREATE TRIGGER feltus_build_blueprint_immutable BEFORE UPDATE ON public.feltus_builds
FOR EACH ROW EXECUTE FUNCTION public.feltus_protect_blueprint_execution_lineage();
DROP TRIGGER IF EXISTS feltus_artifact_blueprint_immutable ON public.feltus_artifacts;
CREATE TRIGGER feltus_artifact_blueprint_immutable BEFORE UPDATE ON public.feltus_artifacts
FOR EACH ROW EXECUTE FUNCTION public.feltus_protect_blueprint_execution_lineage();
DROP TRIGGER IF EXISTS feltus_deployment_blueprint_immutable ON public.feltus_deployments;
CREATE TRIGGER feltus_deployment_blueprint_immutable BEFORE UPDATE ON public.feltus_deployments
FOR EACH ROW EXECUTE FUNCTION public.feltus_protect_blueprint_execution_lineage();

CREATE TABLE IF NOT EXISTS public.feltus_observed_application_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    environment_id UUID NOT NULL,
    deployment_id UUID NOT NULL,
    blueprint_id UUID,
    artifact_id UUID,
    provider TEXT NOT NULL,
    provider_deployment_id TEXT,
    environment TEXT NOT NULL CHECK (environment IN ('development','preview','staging','production')),
    blueprint_version INTEGER,
    commit_sha TEXT CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-fA-F]{40,64}$'),
    artifact_digest TEXT CHECK (artifact_digest IS NULL OR artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('healthy','unhealthy','pending','unknown')),
    observed_state JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(observed_state) = 'object'),
    state_hash TEXT NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, app_id, organization_id),
    UNIQUE (deployment_id, state_hash),
    FOREIGN KEY (app_id, organization_id)
        REFERENCES public.feltus_applications(id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (environment_id, app_id, organization_id)
        REFERENCES public.feltus_environments(id, app_id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (deployment_id, app_id, organization_id)
        REFERENCES public.feltus_deployments(id, app_id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (blueprint_id, app_id, organization_id)
        REFERENCES public.feltus_application_blueprints(id, app_id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (artifact_id, app_id, organization_id)
        REFERENCES public.feltus_artifacts(id, app_id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS feltus_observed_states_app_env_idx
    ON public.feltus_observed_application_states(app_id, environment_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS public.feltus_application_state_deltas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    observed_state_id UUID NOT NULL,
    blueprint_id UUID,
    delta_key TEXT NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('changed','added','removed','unknown')),
    desired_value JSONB,
    observed_value JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (observed_state_id, delta_key),
    FOREIGN KEY (app_id, organization_id)
        REFERENCES public.feltus_applications(id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (observed_state_id, app_id, organization_id)
        REFERENCES public.feltus_observed_application_states(id, app_id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (blueprint_id, app_id, organization_id)
        REFERENCES public.feltus_application_blueprints(id, app_id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS feltus_state_deltas_app_created_idx
    ON public.feltus_application_state_deltas(app_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS feltus_deployments_scope_reference_uq
    ON public.feltus_deployments(id, app_id, organization_id);

-- Reuse the existing append-only audit log as the application-wide event
-- source. Typed lineage columns let the UI traverse Blueprint → Commit → Build
-- → Artifact → Deployment without parsing text or duplicating audit records.
ALTER TABLE public.feltus_audit_events
    ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'user'
        CHECK (actor_kind IN ('user','system','service')),
    ADD COLUMN IF NOT EXISTS blueprint_id UUID,
    ADD COLUMN IF NOT EXISTS commit_sha TEXT
        CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-fA-F]{7,64}$'),
    ADD COLUMN IF NOT EXISTS build_id UUID,
    ADD COLUMN IF NOT EXISTS artifact_id UUID,
    ADD COLUMN IF NOT EXISTS deployment_id UUID,
    ADD COLUMN IF NOT EXISTS event_category TEXT
        CHECK (event_category IS NULL OR event_category IN ('application','data','knowledge','AI','code','build','deployment','system')),
    ADD COLUMN IF NOT EXISTS event_severity TEXT
        CHECK (event_severity IS NULL OR event_severity IN ('info','warning','error','critical')),
    ADD COLUMN IF NOT EXISTS summary TEXT;
CREATE INDEX IF NOT EXISTS feltus_audit_app_lineage_idx
    ON public.feltus_audit_events(app_id, blueprint_id, build_id, deployment_id) WHERE app_id IS NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_audit_lineage_app_required') THEN
        ALTER TABLE public.feltus_audit_events
            ADD CONSTRAINT feltus_audit_lineage_app_required
            CHECK (blueprint_id IS NULL AND build_id IS NULL AND artifact_id IS NULL AND deployment_id IS NULL
                OR app_id IS NOT NULL);
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_audit_blueprint_scope_fkey') THEN
        ALTER TABLE public.feltus_audit_events ADD CONSTRAINT feltus_audit_blueprint_scope_fkey
            FOREIGN KEY (blueprint_id, app_id, organization_id)
            REFERENCES public.feltus_application_blueprints(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_audit_build_scope_fkey') THEN
        ALTER TABLE public.feltus_audit_events ADD CONSTRAINT feltus_audit_build_scope_fkey
            FOREIGN KEY (build_id, app_id, organization_id)
            REFERENCES public.feltus_builds(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_audit_artifact_scope_fkey') THEN
        ALTER TABLE public.feltus_audit_events ADD CONSTRAINT feltus_audit_artifact_scope_fkey
            FOREIGN KEY (artifact_id, app_id, organization_id)
            REFERENCES public.feltus_artifacts(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_audit_deployment_scope_fkey') THEN
        ALTER TABLE public.feltus_audit_events ADD CONSTRAINT feltus_audit_deployment_scope_fkey
            FOREIGN KEY (deployment_id, app_id, organization_id)
            REFERENCES public.feltus_deployments(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_audit_environment_scope_fkey') THEN
        ALTER TABLE public.feltus_audit_events ADD CONSTRAINT feltus_audit_environment_scope_fkey
            FOREIGN KEY (environment_id, app_id, organization_id)
            REFERENCES public.feltus_environments(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.feltus_protect_state_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'State evidence is append-only' USING ERRCODE = '23514';
    END IF;
    IF to_jsonb(NEW) - 'observed_at' IS DISTINCT FROM to_jsonb(OLD) - 'observed_at' THEN
        RAISE EXCEPTION 'State evidence is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS feltus_observed_state_immutable ON public.feltus_observed_application_states;
CREATE TRIGGER feltus_observed_state_immutable BEFORE UPDATE OR DELETE ON public.feltus_observed_application_states
FOR EACH ROW EXECUTE FUNCTION public.feltus_protect_state_evidence();
DROP TRIGGER IF EXISTS feltus_state_delta_immutable ON public.feltus_application_state_deltas;
CREATE TRIGGER feltus_state_delta_immutable BEFORE UPDATE OR DELETE ON public.feltus_application_state_deltas
FOR EACH ROW EXECUTE FUNCTION public.feltus_protect_state_evidence();

ALTER TABLE public.feltus_application_blueprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_observed_application_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_application_state_deltas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feltus_blueprints_read ON public.feltus_application_blueprints;
CREATE POLICY feltus_blueprints_read ON public.feltus_application_blueprints
    FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'deployments.read'));
DROP POLICY IF EXISTS feltus_observed_states_read ON public.feltus_observed_application_states;
CREATE POLICY feltus_observed_states_read ON public.feltus_observed_application_states
    FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'deployments.read'));
DROP POLICY IF EXISTS feltus_state_deltas_read ON public.feltus_application_state_deltas;
CREATE POLICY feltus_state_deltas_read ON public.feltus_application_state_deltas
    FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'deployments.read'));
REVOKE ALL ON public.feltus_application_blueprints, public.feltus_observed_application_states,
    public.feltus_application_state_deltas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.feltus_application_blueprints, public.feltus_observed_application_states,
    public.feltus_application_state_deltas TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feltus_application_blueprints,
    public.feltus_observed_application_states, public.feltus_application_state_deltas TO service_role;

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
    IF encode(digest(convert_to(p_identity_json, 'UTF8'), 'sha256'), 'hex') <> p_state_hash
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
REVOKE ALL ON FUNCTION public.feltus_create_application_blueprint(UUID, JSONB, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feltus_create_application_blueprint(UUID, JSONB, TEXT, TEXT, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.feltus_record_application_event(p_app_id UUID, p_event JSONB)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor UUID := auth.uid();
    v_is_service BOOLEAN := auth.role() = 'service_role';
    v_app public.feltus_applications%ROWTYPE;
    v_id BIGINT;
    v_category TEXT := COALESCE(p_event->>'category', 'system');
    v_severity TEXT := COALESCE(p_event->>'severity', 'info');
    v_summary TEXT := left(trim(COALESCE(p_event->>'summary', 'Application event')), 300);
BEGIN
    IF v_actor IS NULL AND NOT v_is_service THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_app FROM public.feltus_applications
    WHERE id = p_app_id AND (owner_id = v_actor OR v_is_service);
    IF NOT FOUND THEN RAISE EXCEPTION 'Application unavailable' USING ERRCODE = '42501'; END IF;
    IF v_category NOT IN ('application','data','knowledge','AI','code','build','deployment','system')
       OR v_severity NOT IN ('info','warning','error','critical') OR v_summary = ''
       OR octet_length(COALESCE(p_event->'metadata','{}'::jsonb)::text) > 16384
       OR public.feltus_json_contains_sensitive_key(COALESCE(p_event->'metadata','{}'::jsonb)) THEN
        RAISE EXCEPTION 'Invalid application event' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, actor_user_id, actor_kind, request_id, blueprint_id, commit_sha,
        build_id, artifact_id, deployment_id, environment_id, event_category, event_severity,
        action_key, entity_type, entity_id, summary, after_data
    ) VALUES (
        v_app.organization_id, p_app_id,
        CASE WHEN v_is_service THEN NULLIF(p_event->>'actor_id','')::uuid ELSE v_actor END,
        CASE WHEN NOT v_is_service THEN 'user'
             WHEN p_event->>'actor_kind' = 'system' THEN 'system'
             WHEN p_event->>'actor_kind' = 'user' THEN 'user'
             ELSE 'service' END,
        left(p_event->>'request_id', 200),
        NULLIF(p_event->>'blueprint_id','')::uuid, left(p_event->>'commit_sha',64),
        NULLIF(p_event->>'build_id','')::uuid, NULLIF(p_event->>'artifact_id','')::uuid,
        NULLIF(p_event->>'deployment_id','')::uuid, NULLIF(p_event->>'environment_id','')::uuid,
        v_category, v_severity, left(COALESCE(p_event->>'event_key','application.activity'), 100),
        left(COALESCE(p_event->>'entity_type', v_category), 100),
        left(COALESCE(p_event->>'entity_id', p_app_id::text), 200),
        v_summary, COALESCE(p_event->'metadata','{}'::jsonb)
    ) RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_record_application_event(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feltus_record_application_event(UUID, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.feltus_record_observed_application_state(p_app_id UUID, p_observed JSONB)
RETURNS public.feltus_observed_application_states
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor UUID := auth.uid();
    v_is_service BOOLEAN := COALESCE(auth.role(),'') = 'service_role';
    v_app public.feltus_applications%ROWTYPE;
    v_deployment public.feltus_deployments%ROWTYPE;
    v_blueprint public.feltus_application_blueprints%ROWTYPE;
    v_artifact public.feltus_artifacts%ROWTYPE;
    v_observation public.feltus_observed_application_states%ROWTYPE;
    v_environment public.feltus_environments%ROWTYPE;
    v_hash TEXT := p_observed->>'state_hash';
BEGIN
    IF v_actor IS NULL AND NOT v_is_service THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_app FROM public.feltus_applications
    WHERE id = p_app_id AND (owner_id = v_actor OR v_is_service);
    IF NOT FOUND THEN RAISE EXCEPTION 'Application unavailable' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_deployment FROM public.feltus_deployments
    WHERE id = NULLIF(p_observed->>'deployment_id','')::uuid AND app_id = p_app_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Deployment unavailable' USING ERRCODE = '23503'; END IF;
    SELECT * INTO v_environment FROM public.feltus_environments
    WHERE id = v_deployment.environment_id AND app_id = p_app_id;
    SELECT * INTO v_blueprint FROM public.feltus_application_blueprints
    WHERE id = v_deployment.blueprint_id AND app_id = p_app_id;
    IF v_deployment.artifact_id IS NOT NULL THEN
        SELECT * INTO v_artifact FROM public.feltus_artifacts
        WHERE id = v_deployment.artifact_id AND app_id = p_app_id
          AND verification_status = 'passed';
        IF NOT FOUND OR v_artifact.blueprint_id IS DISTINCT FROM v_deployment.blueprint_id
           OR v_artifact.artifact_digest IS DISTINCT FROM p_observed->>'artifact_digest'
           OR v_deployment.artifact_digest IS DISTINCT FROM p_observed->>'artifact_digest'
           OR (p_observed->>'commit_sha' IS NOT NULL AND lower(p_observed->>'commit_sha') <> lower(v_deployment.commit_sha)) THEN
            RAISE EXCEPTION 'Observed deployment source does not match its verified artifact' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$'
       OR COALESCE(p_observed->>'health','unknown') NOT IN ('healthy','unhealthy','pending','unknown') THEN
        RAISE EXCEPTION 'Invalid observed state' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.feltus_observed_application_states (
        organization_id, app_id, environment_id, deployment_id, blueprint_id, artifact_id,
        provider, provider_deployment_id, environment, blueprint_version, commit_sha,
        artifact_digest, health, observed_state, state_hash
    ) VALUES (
        v_app.organization_id, p_app_id, v_environment.id, v_deployment.id, v_deployment.blueprint_id,
        v_deployment.artifact_id, v_deployment.provider, v_deployment.provider_reference,
        v_environment.kind, v_blueprint.version, v_deployment.commit_sha,
        p_observed->>'artifact_digest', COALESCE(p_observed->>'health','unknown'),
        COALESCE(p_observed,'{}'::jsonb), v_hash
    ) ON CONFLICT (deployment_id, state_hash) DO NOTHING;
    SELECT * INTO v_observation FROM public.feltus_observed_application_states
    WHERE deployment_id = v_deployment.id AND state_hash = v_hash;
    RETURN v_observation;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_record_observed_application_state(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_record_observed_application_state(UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_record_application_state_deltas(p_app_id UUID, p_observed_state_id UUID, p_deltas JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor UUID := auth.uid();
    v_state public.feltus_observed_application_states%ROWTYPE;
    v_delta JSONB;
    v_count INTEGER := 0;
BEGIN
    IF v_actor IS NULL AND COALESCE(auth.role(),'') <> 'service_role' THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(p_deltas) <> 'array' OR jsonb_array_length(p_deltas) > 100 THEN
        RAISE EXCEPTION 'Invalid state delta list' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_state FROM public.feltus_observed_application_states
    WHERE id = p_observed_state_id AND app_id = p_app_id;
    IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM public.feltus_applications
        WHERE id = p_app_id AND (owner_id = v_actor OR COALESCE(auth.role(),'') = 'service_role')
    ) THEN RAISE EXCEPTION 'Observed state unavailable' USING ERRCODE = '42501'; END IF;
    FOR v_delta IN SELECT value FROM jsonb_array_elements(p_deltas) LOOP
        IF COALESCE(v_delta->>'status','') NOT IN ('changed','added','removed','unknown') THEN
            RAISE EXCEPTION 'Invalid delta status' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.feltus_application_state_deltas (
            organization_id, app_id, observed_state_id, blueprint_id, delta_key,
            path, status, desired_value, observed_value
        ) VALUES (
            v_state.organization_id, p_app_id, v_state.id, v_state.blueprint_id,
            left(COALESCE(v_delta->>'key',v_delta->>'path','state'), 200),
            left(COALESCE(v_delta->>'path','state'), 300), v_delta->>'status',
            v_delta->'desired', v_delta->'observed'
        ) ON CONFLICT (observed_state_id, delta_key) DO NOTHING;
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_record_application_state_deltas(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_record_application_state_deltas(UUID, UUID, JSONB) TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS feltus_artifacts_build_unique_idx
    ON public.feltus_artifacts(build_id);

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
        encode(digest(convert_to(p_app_id::text || ':' || p_repository_id::text || ':' || p_blueprint_id::text || ':' || p_source_branch || ':' || lower(p_commit_sha), 'UTF8'), 'sha256'), 'hex'),
        p_blueprint_id, 3
    ) RETURNING * INTO v_build;
    RETURN v_build;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_queue_application_build(UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_queue_application_build(UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_claim_builds(p_worker_id TEXT, p_limit INTEGER DEFAULT 1, p_lease_seconds INTEGER DEFAULT 600)
RETURNS SETOF public.feltus_builds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Worker authentication required' USING ERRCODE = '42501'; END IF;
    IF p_worker_id IS NULL OR char_length(trim(p_worker_id)) NOT BETWEEN 1 AND 120
       OR p_lease_seconds NOT BETWEEN 60 AND 3600 THEN
        RAISE EXCEPTION 'Invalid build lease request' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    WITH candidates AS (
        SELECT id FROM public.feltus_builds
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT LEAST(GREATEST(p_limit,1),4)
    )
    UPDATE public.feltus_builds build
    SET status = 'claimed', attempt_count = attempt_count + 1,
        worker_id = p_worker_id, lease_token = gen_random_uuid(),
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        started_at = COALESCE(started_at, now()), updated_at = now()
    FROM candidates
    WHERE build.id = candidates.id
    RETURNING build.*;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_claim_builds(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_claim_builds(TEXT, INTEGER, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_heartbeat_build(p_build_id UUID, p_lease_token UUID, p_lease_seconds INTEGER DEFAULT 600)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Worker authentication required' USING ERRCODE = '42501'; END IF;
    IF p_lease_seconds NOT BETWEEN 60 AND 3600 THEN RAISE EXCEPTION 'Invalid build lease' USING ERRCODE = '22023'; END IF;
    UPDATE public.feltus_builds SET lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
    WHERE id = p_build_id AND lease_token = p_lease_token
      AND status IN ('claimed','running','building','verifying')
      AND lease_expires_at > now();
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_heartbeat_build(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_heartbeat_build(UUID, UUID, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_update_build_status(p_build_id UUID, p_lease_token UUID, p_status TEXT, p_failure_code TEXT DEFAULT NULL)
RETURNS public.feltus_builds
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_build public.feltus_builds%ROWTYPE;
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Worker authentication required' USING ERRCODE = '42501'; END IF;
    IF p_status NOT IN ('running','building','verifying','failed')
       OR (p_failure_code IS NOT NULL AND p_failure_code !~ '^[A-Z0-9_]{1,64}$') THEN
        RAISE EXCEPTION 'Invalid build transition' USING ERRCODE = '22023';
    END IF;
    UPDATE public.feltus_builds SET status = p_status, failure_code = p_failure_code,
        completed_at = CASE WHEN p_status = 'failed' THEN now() ELSE completed_at END,
        worker_id = CASE WHEN p_status = 'failed' THEN NULL ELSE worker_id END,
        lease_token = CASE WHEN p_status = 'failed' THEN NULL ELSE lease_token END,
        lease_expires_at = CASE WHEN p_status = 'failed' THEN NULL ELSE now() + interval '10 minutes' END,
        updated_at = now()
    WHERE id = p_build_id AND lease_token = p_lease_token
      AND lease_expires_at > now()
      AND (p_status = 'failed' OR (status, p_status) IN (
          ('claimed','running'),('running','building'),('building','verifying'),('verifying','verifying')
      ))
    RETURNING * INTO v_build;
    IF NOT FOUND THEN RAISE EXCEPTION 'Build lease is stale or transition is invalid' USING ERRCODE = '40001'; END IF;
    RETURN v_build;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_update_build_status(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_update_build_status(UUID, UUID, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_cancel_build(p_app_id UUID, p_build_id UUID, p_actor_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Server authorization required' USING ERRCODE = '42501'; END IF;
    IF NOT public.feltus_user_can_access_app(p_app_id, p_actor_id, 'builds.trigger') THEN
        RAISE EXCEPTION 'Build actor is not authorized for this application' USING ERRCODE = '42501';
    END IF;
    UPDATE public.feltus_builds SET status = 'cancelled', completed_at = now(), worker_id = NULL,
        lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = p_build_id AND app_id = p_app_id AND status IN ('queued','claimed','running','building','verifying');
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_cancel_build(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_cancel_build(UUID, UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_recover_stale_builds()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_count INTEGER;
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Worker authentication required' USING ERRCODE = '42501'; END IF;
    UPDATE public.feltus_builds SET status = 'failed', failure_code = 'BUILD_LEASE_EXPIRED',
        completed_at = now(), worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE status IN ('claimed','running','building','verifying') AND lease_expires_at < now();
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_recover_stale_builds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_recover_stale_builds() TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_finish_build_with_artifact(
    p_build_id UUID,
    p_lease_token UUID,
    p_registry_image TEXT,
    p_digest TEXT,
    p_provenance JSONB
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
    IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Worker authentication required' USING ERRCODE = '42501'; END IF;
    IF p_registry_image IS NULL OR p_registry_image !~ '^[a-z0-9][a-z0-9._:/-]{2,254}$'
       OR p_registry_image ~ '[@[:space:]]'
       OR p_digest !~ '^sha256:[0-9a-f]{64}$'
       OR jsonb_typeof(p_provenance) <> 'object'
       OR public.feltus_json_contains_sensitive_key(p_provenance) THEN
        RAISE EXCEPTION 'Invalid immutable artifact description' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_build FROM public.feltus_builds
    WHERE id = p_build_id AND lease_token = p_lease_token AND status = 'verifying' AND lease_expires_at > now()
    FOR UPDATE;
    IF NOT FOUND OR v_build.blueprint_id IS NULL THEN RAISE EXCEPTION 'Build lineage is missing or stale' USING ERRCODE = '40001'; END IF;
    IF p_provenance->>'commit_sha' IS DISTINCT FROM v_build.commit_sha
       OR p_provenance->>'blueprint_id' IS DISTINCT FROM v_build.blueprint_id::text THEN
        RAISE EXCEPTION 'Artifact provenance does not match the exact build source' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.feltus_artifacts (
        organization_id, app_id, build_id, blueprint_id, registry_image, artifact_digest,
        verification_status, provenance, environment_eligibility
    ) VALUES (
        v_build.organization_id, v_build.app_id, v_build.id, v_build.blueprint_id,
        p_registry_image, p_digest, 'pending', p_provenance,
        ARRAY['development','preview','staging','production']::TEXT[]
    ) RETURNING * INTO v_artifact;
    UPDATE public.feltus_builds SET status = 'succeeded', completed_at = now(),
        worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE id = v_build.id AND lease_token = p_lease_token;
    UPDATE public.feltus_artifacts SET verification_status = 'passed', verified_at = now()
    WHERE id = v_artifact.id RETURNING * INTO v_artifact;
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, actor_kind, blueprint_id, commit_sha, build_id,
        artifact_id, event_category, event_severity, action_key, entity_type, entity_id, summary, after_data
    ) VALUES (
        v_build.organization_id, v_build.app_id, 'service', v_build.blueprint_id,
        v_build.commit_sha, v_build.id, v_artifact.id, 'build', 'info',
        'artifact.verified', 'build_artifact', v_artifact.id::text, 'Build artifact verified',
        jsonb_build_object('digest', p_digest, 'image', p_registry_image)
    );
    RETURN v_artifact;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_finish_build_with_artifact(UUID, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_finish_build_with_artifact(UUID, UUID, TEXT, TEXT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_set_environment_target(
    p_app_id UUID,
    p_environment_kind TEXT,
    p_resource_reference TEXT,
    p_actor_id UUID,
    p_production_enabled BOOLEAN DEFAULT false
)
RETURNS public.feltus_deployment_targets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_app public.feltus_applications%ROWTYPE;
    v_environment public.feltus_environments%ROWTYPE;
    v_target public.feltus_deployment_targets%ROWTYPE;
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Server authorization required' USING ERRCODE = '42501'; END IF;
    IF p_environment_kind NOT IN ('development','preview','staging','production')
       OR p_resource_reference !~ '^[A-Za-z0-9-]{3,80}$' THEN
        RAISE EXCEPTION 'Invalid environment target' USING ERRCODE = '22023';
    END IF;
    IF p_environment_kind = 'production' AND NOT p_production_enabled THEN
        RAISE EXCEPTION 'Production target setup is disabled' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_app FROM public.feltus_applications WHERE id = p_app_id;
    IF NOT FOUND OR NOT public.feltus_user_can_access_app(p_app_id, p_actor_id, 'deployments.create') THEN
        RAISE EXCEPTION 'Actor cannot configure this application target' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_environment FROM public.feltus_environments
    WHERE app_id = p_app_id AND kind = p_environment_kind AND status = 'active' LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Environment is unavailable' USING ERRCODE = '23503'; END IF;
    INSERT INTO public.feltus_deployment_targets (
        organization_id, app_id, environment_id, provider_key,
        provider_resource_reference, active, created_by
    ) VALUES (
        v_app.organization_id, p_app_id, v_environment.id, 'coolify',
        p_resource_reference, true, p_actor_id
    ) ON CONFLICT (environment_id, provider_key) DO UPDATE
    SET provider_resource_reference = EXCLUDED.provider_resource_reference,
        active = true, updated_at = now()
    RETURNING * INTO v_target;
    RETURN v_target;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_set_environment_target(UUID, TEXT, TEXT, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_set_environment_target(UUID, TEXT, TEXT, UUID, BOOLEAN) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_request_artifact_deployment(
    p_app_id UUID,
    p_environment_kind TEXT,
    p_artifact_id UUID,
    p_actor_id UUID,
    p_idempotency_key TEXT,
    p_production_enabled BOOLEAN DEFAULT false
)
RETURNS public.feltus_deployments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_app public.feltus_applications%ROWTYPE;
    v_environment public.feltus_environments%ROWTYPE;
    v_target public.feltus_deployment_targets%ROWTYPE;
    v_artifact public.feltus_artifacts%ROWTYPE;
    v_build public.feltus_builds%ROWTYPE;
    v_blueprint public.feltus_application_blueprints%ROWTYPE;
    v_deployment public.feltus_deployments%ROWTYPE;
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Server authorization required' USING ERRCODE = '42501'; END IF;
    IF p_environment_kind NOT IN ('development','preview','staging','production')
       OR p_idempotency_key IS NULL OR char_length(trim(p_idempotency_key)) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'Invalid deployment request' USING ERRCODE = '22023';
    END IF;
    IF p_environment_kind = 'production' AND NOT p_production_enabled THEN
        RAISE EXCEPTION 'Production deployment is disabled' USING ERRCODE = '42501';
    END IF;
    IF NOT public.feltus_user_can_access_app(p_app_id, p_actor_id, 'deployments.create') THEN
        RAISE EXCEPTION 'Deployment actor is not authorized' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_app FROM public.feltus_applications WHERE id = p_app_id;
    SELECT * INTO v_environment FROM public.feltus_environments
    WHERE app_id = p_app_id AND kind = p_environment_kind AND status = 'active' LIMIT 1;
    SELECT * INTO v_artifact FROM public.feltus_artifacts
    WHERE id = p_artifact_id AND app_id = p_app_id AND verification_status = 'passed';
    IF v_app.id IS NULL OR v_environment.id IS NULL OR v_artifact.id IS NULL THEN
        RAISE EXCEPTION 'Application, environment, or verified artifact is unavailable' USING ERRCODE = '23503';
    END IF;
    IF v_artifact.artifact_digest !~ '^sha256:[0-9a-f]{64}$'
       OR v_artifact.blueprint_id IS NULL
       OR NOT (p_environment_kind = ANY(v_artifact.environment_eligibility)) THEN
        RAISE EXCEPTION 'Artifact is not structurally valid for this environment' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_build FROM public.feltus_builds WHERE id = v_artifact.build_id AND app_id = p_app_id;
    SELECT * INTO v_blueprint FROM public.feltus_application_blueprints
    WHERE id = v_artifact.blueprint_id AND app_id = p_app_id;
    IF v_build.status <> 'succeeded' OR v_build.blueprint_id <> v_artifact.blueprint_id
       OR v_blueprint.id IS NULL OR v_build.commit_sha !~ '^[0-9a-fA-F]{40,64}$' THEN
        RAISE EXCEPTION 'Artifact build lineage is incomplete or incompatible' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_target FROM public.feltus_deployment_targets
    WHERE app_id = p_app_id AND environment_id = v_environment.id AND provider_key = 'coolify' AND active;
    IF v_target.id IS NULL THEN RAISE EXCEPTION 'No active deployment target is configured' USING ERRCODE = '23514'; END IF;
    SELECT * INTO v_deployment FROM public.feltus_deployments
    WHERE app_id = p_app_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_deployment; END IF;
    INSERT INTO public.feltus_deployments (
        app_id, owner_id, environment, branch, commit_sha, status, provider,
        organization_id, environment_id, artifact_id, requested_by,
        idempotency_key, blueprint_id, metadata
    ) VALUES (
        p_app_id, p_actor_id, p_environment_kind, v_build.source_branch, v_build.commit_sha,
        'QUEUED', 'coolify', v_app.organization_id, v_environment.id,
        v_artifact.id, p_actor_id, p_idempotency_key, v_artifact.blueprint_id,
        jsonb_build_object('requested_via','feltus_application_state_v1')
    ) RETURNING * INTO v_deployment;
    RETURN v_deployment;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_request_artifact_deployment(UUID, TEXT, UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_request_artifact_deployment(UUID, TEXT, UUID, UUID, TEXT, BOOLEAN) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_request_artifact_promotion(
    p_app_id UUID,
    p_staging_deployment_id UUID,
    p_actor_id UUID,
    p_idempotency_key TEXT,
    p_production_enabled BOOLEAN DEFAULT false
)
RETURNS public.feltus_deployments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_source public.feltus_deployments%ROWTYPE;
    v_app public.feltus_applications%ROWTYPE;
    v_target_env public.feltus_environments%ROWTYPE;
    v_target public.feltus_deployment_targets%ROWTYPE;
    v_artifact public.feltus_artifacts%ROWTYPE;
    v_promotion public.feltus_deployment_promotions%ROWTYPE;
    v_deployment public.feltus_deployments%ROWTYPE;
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Server authorization required' USING ERRCODE = '42501'; END IF;
    IF NOT p_production_enabled THEN RAISE EXCEPTION 'Production promotion is disabled' USING ERRCODE = '42501'; END IF;
    IF p_idempotency_key IS NULL OR char_length(trim(p_idempotency_key)) NOT BETWEEN 1 AND 200
       OR NOT public.feltus_user_can_access_app(p_app_id, p_actor_id, 'deployments.create') THEN
        RAISE EXCEPTION 'Promotion request is invalid or unauthorized' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_app FROM public.feltus_applications WHERE id = p_app_id;
    SELECT * INTO v_source FROM public.feltus_deployments
    WHERE id = p_staging_deployment_id AND app_id = p_app_id AND environment = 'staging' AND status = 'HEALTHY';
    SELECT * INTO v_target_env FROM public.feltus_environments
    WHERE app_id = p_app_id AND kind = 'production' AND status = 'active' LIMIT 1;
    IF v_app.id IS NULL OR v_source.id IS NULL OR v_target_env.id IS NULL THEN
        RAISE EXCEPTION 'Promotion requires a healthy Staging deployment and configured Production environment' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_artifact FROM public.feltus_artifacts
    WHERE id = v_source.artifact_id AND app_id = p_app_id AND verification_status = 'passed'
      AND blueprint_id = v_source.blueprint_id;
    SELECT * INTO v_target FROM public.feltus_deployment_targets
    WHERE app_id = p_app_id AND environment_id = v_target_env.id AND provider_key = 'coolify' AND active;
    IF v_artifact.id IS NULL OR NOT ('production' = ANY(v_artifact.environment_eligibility)) OR v_target.id IS NULL THEN
        RAISE EXCEPTION 'The Staging artifact or Production target is not eligible' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_promotion FROM public.feltus_deployment_promotions
    WHERE app_id = p_app_id AND idempotency_key = p_idempotency_key;
    IF FOUND AND v_promotion.target_deployment_id IS NOT NULL THEN
        SELECT * INTO v_deployment FROM public.feltus_deployments WHERE id = v_promotion.target_deployment_id;
        RETURN v_deployment;
    END IF;
    IF NOT FOUND THEN
        INSERT INTO public.feltus_deployment_promotions (
            organization_id, app_id, source_deployment_id, target_environment_id,
            artifact_id, requested_by, idempotency_key, status
        ) VALUES (
            v_app.organization_id, p_app_id, v_source.id, v_target_env.id,
            v_artifact.id, p_actor_id, p_idempotency_key, 'requested'
        ) RETURNING * INTO v_promotion;
    END IF;
    INSERT INTO public.feltus_deployments (
        app_id, owner_id, environment, branch, commit_sha, status, provider,
        organization_id, environment_id, artifact_id, requested_by,
        idempotency_key, promotion_id, blueprint_id, metadata
    ) VALUES (
        p_app_id, p_actor_id, 'production', v_source.branch, v_source.commit_sha,
        'QUEUED', v_source.provider, v_app.organization_id, v_target_env.id,
        v_artifact.id, p_actor_id, p_idempotency_key, v_promotion.id,
        v_artifact.blueprint_id, jsonb_build_object('requested_via','manual_staging_promotion')
    ) RETURNING * INTO v_deployment;
    UPDATE public.feltus_deployment_promotions SET target_deployment_id = v_deployment.id, status = 'deploying'
    WHERE id = v_promotion.id;
    RETURN v_deployment;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_request_artifact_promotion(UUID, UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_request_artifact_promotion(UUID, UUID, UUID, TEXT, BOOLEAN) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_request_deployment_rollback(
    p_app_id UUID,
    p_current_deployment_id UUID,
    p_known_good_deployment_id UUID,
    p_actor_id UUID,
    p_reason TEXT,
    p_idempotency_key TEXT,
    p_production_enabled BOOLEAN DEFAULT false
)
RETURNS public.feltus_deployments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_current public.feltus_deployments%ROWTYPE;
    v_previous public.feltus_deployments%ROWTYPE;
    v_app public.feltus_applications%ROWTYPE;
    v_target public.feltus_deployment_targets%ROWTYPE;
    v_artifact public.feltus_artifacts%ROWTYPE;
    v_result public.feltus_deployments%ROWTYPE;
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN RAISE EXCEPTION 'Server authorization required' USING ERRCODE = '42501'; END IF;
    IF p_reason IS NULL OR char_length(trim(p_reason)) NOT BETWEEN 1 AND 500
       OR p_idempotency_key IS NULL OR char_length(trim(p_idempotency_key)) NOT BETWEEN 1 AND 200
       OR NOT public.feltus_user_can_access_app(p_app_id, p_actor_id, 'deployments.create') THEN
        RAISE EXCEPTION 'Rollback request is invalid or unauthorized' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_current FROM public.feltus_deployments
    WHERE id = p_current_deployment_id AND app_id = p_app_id;
    SELECT * INTO v_previous FROM public.feltus_deployments
    WHERE id = p_known_good_deployment_id AND app_id = p_app_id AND status = 'HEALTHY';
    IF v_current.id IS NULL OR v_previous.id IS NULL OR v_current.id = v_previous.id
       OR v_current.environment_id <> v_previous.environment_id
       OR (v_current.environment = 'production' AND NOT p_production_enabled) THEN
        RAISE EXCEPTION 'Rollback requires a previous healthy deployment in the same enabled environment' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_artifact FROM public.feltus_artifacts
    WHERE id = v_previous.artifact_id AND app_id = p_app_id AND verification_status = 'passed'
      AND blueprint_id = v_previous.blueprint_id;
    SELECT * INTO v_target FROM public.feltus_deployment_targets
    WHERE environment_id = v_current.environment_id AND app_id = p_app_id AND provider_key = 'coolify' AND active;
    SELECT * INTO v_app FROM public.feltus_applications WHERE id = p_app_id;
    IF v_artifact.id IS NULL OR v_target.id IS NULL OR v_app.id IS NULL THEN
        RAISE EXCEPTION 'Previous artifact or environment target is unavailable' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO v_result FROM public.feltus_deployments
    WHERE app_id = p_app_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN RETURN v_result; END IF;
    INSERT INTO public.feltus_deployments (
        app_id, owner_id, environment, branch, commit_sha, status, provider,
        organization_id, environment_id, artifact_id, requested_by,
        idempotency_key, rollback_of, blueprint_id, rollback_reason, metadata
    ) VALUES (
        p_app_id, p_actor_id, v_current.environment, v_previous.branch, v_previous.commit_sha,
        'QUEUED', v_previous.provider, v_app.organization_id, v_current.environment_id,
        v_artifact.id, p_actor_id, p_idempotency_key, v_current.id, v_artifact.blueprint_id,
        trim(p_reason), jsonb_build_object('requested_via','manual_rollback','restores_deployment_id',v_previous.id)
    ) RETURNING * INTO v_result;
    RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_request_deployment_rollback(UUID, UUID, UUID, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_request_deployment_rollback(UUID, UUID, UUID, UUID, TEXT, TEXT, BOOLEAN) TO service_role;

-- A Preview row is configuration metadata only. Its absence/presence never
-- provisions infrastructure or a deployment target.
INSERT INTO public.feltus_environments (organization_id, app_id, name, kind, created_by)
SELECT app.organization_id, app.id, 'preview', 'preview', app.owner_id
FROM public.feltus_applications app
ON CONFLICT (app_id, name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.feltus_create_default_environments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO public.feltus_environments (organization_id, app_id, name, kind, created_by)
    VALUES
        (NEW.organization_id, NEW.id, 'development', 'development', NEW.owner_id),
        (NEW.organization_id, NEW.id, 'preview', 'preview', NEW.owner_id),
        (NEW.organization_id, NEW.id, 'staging', 'staging', NEW.owner_id),
        (NEW.organization_id, NEW.id, 'production', 'production', NEW.owner_id)
    ON CONFLICT (app_id, name) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_record_github_webhook_event(p_repository_id UUID, p_delivery_id TEXT, p_event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_repository public.feltus_repositories%ROWTYPE;
    v_event public.feltus_git_webhook_events%ROWTYPE;
    v_branch TEXT := NULLIF(p_event->>'branch_name','');
    v_sha TEXT := NULLIF(lower(p_event->>'commit_sha'),'');
    v_event_name TEXT := lower(COALESCE(p_event->>'event_name',''));
    v_action TEXT := NULLIF(lower(p_event->>'action_name'),'');
    v_pr_number INTEGER := NULLIF(p_event->>'pull_request_number','')::INTEGER;
    v_branch_count INTEGER := 0;
BEGIN
    IF COALESCE(auth.role(),'') <> 'service_role' THEN
        RAISE EXCEPTION 'Webhook service authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_repository_id IS NULL OR p_delivery_id !~ '^[A-Za-z0-9-]{1,200}$'
       OR v_event_name !~ '^[a-z_]{1,64}$'
       OR COALESCE(p_event->>'signature_verified','false') <> 'true'
       OR COALESCE(p_event->>'payload_sha256','') !~ '^[0-9a-f]{64}$'
       OR (v_branch IS NOT NULL AND char_length(v_branch) NOT BETWEEN 1 AND 255)
       OR (v_sha IS NOT NULL AND v_sha !~ '^[0-9a-f]{40,64}$')
       OR (v_pr_number IS NOT NULL AND v_pr_number < 1) THEN
        RAISE EXCEPTION 'Invalid verified GitHub webhook event' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_repository FROM public.feltus_repositories
    WHERE id = p_repository_id AND archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Repository unavailable' USING ERRCODE = '23503'; END IF;

    INSERT INTO public.feltus_git_webhook_events (
        organization_id, repository_id, delivery_id, event_name, action_name,
        branch_name, commit_sha, pull_request_number, payload_sha256,
        signature_verified, status, processed_at
    ) VALUES (
        v_repository.organization_id, p_repository_id, p_delivery_id, v_event_name, v_action,
        v_branch, v_sha, v_pr_number, p_event->>'payload_sha256',
        true, 'processed', now()
    ) ON CONFLICT (repository_id, delivery_id) DO NOTHING
    RETURNING * INTO v_event;

    IF NOT FOUND THEN
        SELECT * INTO v_event FROM public.feltus_git_webhook_events
        WHERE repository_id = p_repository_id AND delivery_id = p_delivery_id;
        RETURN jsonb_build_object('duplicate', true, 'event_id', v_event.id, 'status', v_event.status);
    END IF;

    IF v_branch IS NOT NULL AND v_event_name IN ('push','pull_request') THEN
        INSERT INTO public.feltus_repository_branches (
            organization_id, app_id, repository_id, environment_id,
            branch_name, is_default, latest_commit_sha, updated_at
        )
        SELECT link.organization_id, link.app_id, link.repository_id, environment.id,
               v_branch, v_branch = v_repository.default_branch, v_sha, now()
        FROM public.feltus_project_repositories link
        JOIN public.feltus_environments environment
          ON environment.app_id = link.app_id
         AND environment.organization_id = link.organization_id
         AND environment.kind = 'development'
        WHERE link.repository_id = p_repository_id
          AND link.organization_id = v_repository.organization_id
        ON CONFLICT (repository_id, branch_name, environment_id) DO UPDATE
          SET latest_commit_sha = EXCLUDED.latest_commit_sha,
              is_default = EXCLUDED.is_default,
              updated_at = now();
        GET DIAGNOSTICS v_branch_count = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object(
        'duplicate', false,
        'event_id', v_event.id,
        'status', v_event.status,
        'branch_records_updated', v_branch_count
    );
END;
$$;
REVOKE ALL ON FUNCTION public.feltus_record_github_webhook_event(UUID,TEXT,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_record_github_webhook_event(UUID,TEXT,JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';
