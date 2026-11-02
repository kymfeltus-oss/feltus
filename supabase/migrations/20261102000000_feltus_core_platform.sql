-- FELTUS Core Platform: additive platform services.
-- Existing application, Auth, storage, realtime, modeler, and document tables remain authoritative.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.feltus_user_profiles (
    user_id UUID PRIMARY KEY,
    display_name TEXT,
    avatar_path TEXT,
    disabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feltus_project_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','developer','operator','viewer')),
    permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
    invited_by UUID,
    disabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, user_id)
);

INSERT INTO public.feltus_project_memberships (app_id, user_id, role, invited_by)
SELECT id, owner_id, 'owner', owner_id
FROM public.feltus_applications
ON CONFLICT (app_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.feltus_add_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.feltus_project_memberships (app_id, user_id, role, invited_by)
    VALUES (NEW.id, NEW.owner_id, 'owner', NEW.owner_id)
    ON CONFLICT (app_id, user_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_application_owner_membership ON public.feltus_applications;
CREATE TRIGGER feltus_application_owner_membership
AFTER INSERT ON public.feltus_applications
FOR EACH ROW EXECUTE FUNCTION public.feltus_add_owner_membership();

CREATE OR REPLACE FUNCTION public.feltus_can_access_app(
    p_app_id UUID,
    p_permission TEXT DEFAULT 'read'
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.feltus_applications app
        WHERE app.id = p_app_id
          AND app.owner_id = auth.uid()
    ) OR EXISTS (
        SELECT 1
        FROM public.feltus_project_memberships membership
        WHERE membership.app_id = p_app_id
          AND membership.user_id = auth.uid()
          AND membership.disabled_at IS NULL
          AND (
              p_permission = 'read'
              OR membership.role IN ('owner','admin','developer','operator')
              OR COALESCE((membership.permissions ->> p_permission)::boolean, false)
          )
    );
$$;

ALTER TABLE public.feltus_ai_conversations
    DROP CONSTRAINT IF EXISTS feltus_ai_conversations_app_id_owner_id_key;
ALTER TABLE public.feltus_ai_conversations
    ADD COLUMN IF NOT EXISTS system_prompt TEXT,
    ADD COLUMN IF NOT EXISTS selected_model TEXT,
    ADD COLUMN IF NOT EXISTS temperature NUMERIC(4,3) NOT NULL DEFAULT 0.2,
    ADD COLUMN IF NOT EXISTS max_tokens INTEGER NOT NULL DEFAULT 2048,
    ADD COLUMN IF NOT EXISTS context_budget INTEGER NOT NULL DEFAULT 16000,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE public.feltus_ai_messages
    ADD COLUMN IF NOT EXISTS parent_message_id UUID
        REFERENCES public.feltus_ai_messages(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS edited_from_id UUID
        REFERENCES public.feltus_ai_messages(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS generation_id UUID,
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete',
    ADD COLUMN IF NOT EXISTS input_tokens INTEGER,
    ADD COLUMN IF NOT EXISTS output_tokens INTEGER,
    ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS feltus_ai_conversations_project_updated_idx
    ON public.feltus_ai_conversations (app_id, owner_id, updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.feltus_ai_runtimes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('ollama','openai_compatible','vllm','llama_cpp')),
    base_url TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    is_default BOOLEAN NOT NULL DEFAULT false,
    timeout_ms INTEGER NOT NULL DEFAULT 600000,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_id, name)
);

CREATE TABLE IF NOT EXISTS public.feltus_ai_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    runtime_id UUID NOT NULL REFERENCES public.feltus_ai_runtimes(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    model_key TEXT NOT NULL,
    alias TEXT,
    capabilities TEXT[] NOT NULL DEFAULT ARRAY['TEXT']::TEXT[],
    context_limit INTEGER,
    enabled BOOLEAN NOT NULL DEFAULT true,
    is_default BOOLEAN NOT NULL DEFAULT false,
    fallback_model_id UUID REFERENCES public.feltus_ai_models(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    discovered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (runtime_id, model_key)
);

CREATE TABLE IF NOT EXISTS public.feltus_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    job_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    status TEXT NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    worker_id TEXT,
    lease_expires_at TIMESTAMPTZ,
    retry_at TIMESTAMPTZ,
    last_error TEXT,
    cancellation_requested BOOLEAN NOT NULL DEFAULT false,
    idempotency_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS feltus_jobs_idempotency_idx
    ON public.feltus_jobs (app_id, owner_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS feltus_jobs_claim_idx
    ON public.feltus_jobs (status, retry_at, created_at);

CREATE TABLE IF NOT EXISTS public.feltus_worker_heartbeats (
    worker_id TEXT PRIMARY KEY,
    worker_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'online',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feltus_tool_registry (
    tool_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    input_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
    required_permission TEXT NOT NULL DEFAULT 'read',
    enabled BOOLEAN NOT NULL DEFAULT true,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feltus_tool_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    tool_key TEXT NOT NULL REFERENCES public.feltus_tool_registry(tool_key),
    input JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    status TEXT NOT NULL DEFAULT 'RUNNING'
        CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
    error TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

INSERT INTO public.feltus_tool_registry
    (tool_key, name, description, input_schema, required_permission)
VALUES
    ('project.documents', 'Project documents', 'List authorized project document metadata.',
     '{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}}}'::jsonb, 'read'),
    ('project.assets', 'Project assets', 'List authorized project asset metadata.',
     '{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}}}'::jsonb, 'read'),
    ('runtime.status', 'AI runtime status', 'Inspect configured AI runtime and model health.',
     '{"type":"object","properties":{}}'::jsonb, 'read')
ON CONFLICT (tool_key) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    input_schema = EXCLUDED.input_schema,
    required_permission = EXCLUDED.required_permission,
    updated_at = now();

CREATE TABLE IF NOT EXISTS public.feltus_knowledge_bases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    name TEXT NOT NULL,
    embedding_model TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, owner_id, name)
);

CREATE TABLE IF NOT EXISTS public.feltus_knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    knowledge_base_id UUID NOT NULL REFERENCES public.feltus_knowledge_bases(id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    document_id UUID REFERENCES public.feltus_documents(id) ON DELETE CASCADE,
    source_chunk_id UUID REFERENCES public.feltus_document_chunks(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    embedding_json JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
        CREATE EXTENSION IF NOT EXISTS vector;
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema='public'
              AND table_name='feltus_knowledge_chunks'
              AND column_name='embedding'
        ) THEN
            EXECUTE 'ALTER TABLE public.feltus_knowledge_chunks ADD COLUMN embedding vector';
        END IF;
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.feltus_usage_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    application TEXT NOT NULL DEFAULT 'core',
    category TEXT NOT NULL,
    operation TEXT NOT NULL,
    model TEXT,
    request_id TEXT,
    input_units BIGINT NOT NULL DEFAULT 0,
    output_units BIGINT NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feltus_usage_scope_idx
    ON public.feltus_usage_records (owner_id, app_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.feltus_project_secrets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    name TEXT NOT NULL,
    encrypted_value BYTEA NOT NULL,
    value_fingerprint TEXT NOT NULL,
    updated_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, owner_id, name)
);

CREATE OR REPLACE VIEW public.feltus_project_secret_metadata
WITH (security_invoker = true)
AS
SELECT id, app_id, owner_id, name, value_fingerprint, updated_by, created_at, updated_at
FROM public.feltus_project_secrets;

CREATE OR REPLACE FUNCTION public.feltus_set_project_secret(
    p_app_id UUID,
    p_owner_id UUID,
    p_name TEXT,
    p_value TEXT,
    p_encryption_key TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_owner_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.feltus_applications
        WHERE id=p_app_id AND owner_id=p_owner_id
    ) THEN
        RAISE EXCEPTION 'Project authorization failed';
    END IF;
    IF char_length(trim(p_name)) < 1 OR char_length(p_value) < 1 OR char_length(p_encryption_key) < 32 THEN
        RAISE EXCEPTION 'Invalid secret input';
    END IF;
    INSERT INTO public.feltus_project_secrets
        (app_id, owner_id, name, encrypted_value, value_fingerprint, updated_by)
    VALUES (
        p_app_id, p_owner_id, upper(trim(p_name)),
        pgp_sym_encrypt(p_value, p_encryption_key, 'cipher-algo=aes256'),
        encode(digest(p_value, 'sha256'), 'hex'), p_owner_id
    )
    ON CONFLICT (app_id, owner_id, name) DO UPDATE SET
        encrypted_value=EXCLUDED.encrypted_value,
        value_fingerprint=EXCLUDED.value_fingerprint,
        updated_by=EXCLUDED.updated_by,
        updated_at=now()
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- Preserve the existing owner-only create/update policy while allowing an
-- invited member to discover a project they can read.
DROP POLICY IF EXISTS app_member_read_policy ON public.feltus_applications;
CREATE POLICY app_member_read_policy ON public.feltus_applications
FOR SELECT TO authenticated
USING (public.feltus_can_access_app(id, 'read'));

CREATE TABLE IF NOT EXISTS public.feltus_deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('development','staging','production')),
    branch TEXT,
    commit_sha TEXT,
    status TEXT NOT NULL CHECK (status IN ('QUEUED','BUILDING','DEPLOYING','HEALTHY','DEGRADED','FAILED','ROLLED_BACK','CANCELLED')),
    provider TEXT NOT NULL DEFAULT 'coolify',
    provider_reference TEXT,
    service_health JSONB NOT NULL DEFAULT '{}'::jsonb,
    rollback_of UUID REFERENCES public.feltus_deployments(id),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION public.feltus_claim_jobs(
    p_worker_id TEXT,
    p_limit INTEGER DEFAULT 1,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS SETOF public.feltus_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    WITH candidates AS (
        SELECT id
        FROM public.feltus_jobs
        WHERE status='QUEUED'
          AND cancellation_requested=false
          AND (retry_at IS NULL OR retry_at <= now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT LEAST(GREATEST(p_limit, 1), 20)
    )
    UPDATE public.feltus_jobs job
    SET status='RUNNING',
        attempts=attempts+1,
        worker_id=p_worker_id,
        lease_expires_at=now() + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 15), 3600)),
        started_at=COALESCE(started_at, now()),
        updated_at=now()
    FROM candidates
    WHERE job.id=candidates.id
    RETURNING job.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_recover_stale_jobs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    WITH recovered AS (
        UPDATE public.feltus_jobs
        SET status=CASE WHEN cancellation_requested THEN 'CANCELLED'
                        WHEN attempts >= max_attempts THEN 'FAILED'
                        ELSE 'QUEUED' END,
            worker_id=NULL,
            lease_expires_at=NULL,
            retry_at=CASE WHEN attempts >= max_attempts THEN NULL ELSE now() END,
            last_error=CASE WHEN attempts >= max_attempts
                            THEN COALESCE(last_error, 'Worker lease expired after maximum attempts')
                            ELSE last_error END,
            completed_at=CASE WHEN cancellation_requested OR attempts >= max_attempts THEN now() ELSE NULL END,
            updated_at=now()
        WHERE status='RUNNING' AND lease_expires_at < now()
        RETURNING 1
    )
    SELECT count(*) INTO v_count FROM recovered;
    RETURN v_count;
END;
$$;

ALTER TABLE public.feltus_user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_project_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_ai_runtimes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_tool_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_tool_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_project_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_deployments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feltus_user_profiles_self ON public.feltus_user_profiles;
CREATE POLICY feltus_user_profiles_self ON public.feltus_user_profiles
FOR ALL TO authenticated USING (user_id=auth.uid()) WITH CHECK (user_id=auth.uid());

DROP POLICY IF EXISTS feltus_memberships_visible ON public.feltus_project_memberships;
CREATE POLICY feltus_memberships_visible ON public.feltus_project_memberships
FOR SELECT TO authenticated
USING (user_id=auth.uid() OR public.feltus_can_access_app(app_id, 'admin'));

DROP POLICY IF EXISTS feltus_memberships_admin ON public.feltus_project_memberships;
CREATE POLICY feltus_memberships_admin ON public.feltus_project_memberships
FOR ALL TO authenticated
USING (public.feltus_can_access_app(app_id, 'admin'))
WITH CHECK (public.feltus_can_access_app(app_id, 'admin'));

DO $$
DECLARE
    table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'feltus_jobs','feltus_tool_executions','feltus_knowledge_bases',
        'feltus_knowledge_chunks','feltus_usage_records','feltus_deployments'
    ]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_scope', table_name);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (owner_id=auth.uid() AND public.feltus_can_access_app(app_id, ''read'')) WITH CHECK (owner_id=auth.uid() AND public.feltus_can_access_app(app_id, ''write''))',
            table_name || '_scope', table_name
        );
    END LOOP;
END
$$;

DROP POLICY IF EXISTS feltus_ai_runtimes_owner ON public.feltus_ai_runtimes;
CREATE POLICY feltus_ai_runtimes_owner ON public.feltus_ai_runtimes
FOR ALL TO authenticated USING (owner_id=auth.uid()) WITH CHECK (owner_id=auth.uid());
DROP POLICY IF EXISTS feltus_ai_models_owner ON public.feltus_ai_models;
CREATE POLICY feltus_ai_models_owner ON public.feltus_ai_models
FOR ALL TO authenticated USING (owner_id=auth.uid()) WITH CHECK (owner_id=auth.uid());
DROP POLICY IF EXISTS feltus_worker_heartbeats_read ON public.feltus_worker_heartbeats;
CREATE POLICY feltus_worker_heartbeats_read ON public.feltus_worker_heartbeats
FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS feltus_tool_registry_read ON public.feltus_tool_registry;
CREATE POLICY feltus_tool_registry_read ON public.feltus_tool_registry
FOR SELECT TO authenticated USING (enabled=true);
DROP POLICY IF EXISTS feltus_project_secrets_owner ON public.feltus_project_secrets;
CREATE POLICY feltus_project_secrets_owner ON public.feltus_project_secrets
FOR SELECT TO authenticated USING (owner_id=auth.uid() AND public.feltus_can_access_app(app_id, 'admin'));

REVOKE ALL ON public.feltus_project_secrets FROM anon, authenticated;
GRANT SELECT (id, app_id, owner_id, name, value_fingerprint, updated_by, created_at, updated_at)
    ON public.feltus_project_secrets TO authenticated;
REVOKE ALL ON FUNCTION public.feltus_set_project_secret(UUID,UUID,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_set_project_secret(UUID,UUID,TEXT,TEXT,TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.feltus_claim_jobs(TEXT,INTEGER,INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feltus_recover_stale_jobs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_claim_jobs(TEXT,INTEGER,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.feltus_recover_stale_jobs() TO service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_access_app(UUID,TEXT) TO authenticated;

GRANT SELECT, INSERT, UPDATE ON public.feltus_user_profiles TO authenticated;
GRANT SELECT ON public.feltus_project_memberships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feltus_ai_runtimes, public.feltus_ai_models TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.feltus_jobs TO authenticated;
GRANT SELECT ON public.feltus_worker_heartbeats, public.feltus_tool_registry TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.feltus_tool_executions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feltus_knowledge_bases, public.feltus_knowledge_chunks TO authenticated;
GRANT SELECT, INSERT ON public.feltus_usage_records TO authenticated;
GRANT SELECT ON public.feltus_project_secret_metadata TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.feltus_deployments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feltus_jobs, public.feltus_worker_heartbeats,
    public.feltus_tool_executions, public.feltus_usage_records,
    public.feltus_knowledge_chunks TO service_role;

DO $$
DECLARE
    table_name TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
        FOREACH table_name IN ARRAY ARRAY['feltus_ai_messages','feltus_jobs']
        LOOP
            IF NOT EXISTS (
                SELECT 1 FROM pg_publication_tables
                WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=table_name
            ) THEN
                EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', table_name);
            END IF;
        END LOOP;
    END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
