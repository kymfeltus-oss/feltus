-- FELTUS CODE persistence. Project membership permissions are inherited from
-- feltus_can_access_app; no anonymous or permissive fallback policies exist.

CREATE TABLE IF NOT EXISTS public.feltus_code_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    created_by UUID NOT NULL,
    title TEXT NOT NULL DEFAULT 'Code session',
    repo_ref TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feltus_code_sessions_project_updated_idx
    ON public.feltus_code_sessions (app_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS feltus_code_sessions_one_active_project_idx
    ON public.feltus_code_sessions (app_id, owner_id)
    WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS public.feltus_code_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.feltus_code_sessions(id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL,
    action_type TEXT NOT NULL,
    target_path TEXT,
    task_name TEXT,
    model TEXT,
    prompt TEXT,
    summary TEXT,
    result_status TEXT,
    request_id TEXT,
    usage JSONB NOT NULL DEFAULT '{}'::jsonb,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feltus_code_actions_project_created_idx
    ON public.feltus_code_actions (app_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.feltus_code_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.feltus_code_sessions(id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL,
    git_commit TEXT NOT NULL,
    label TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feltus_code_checkpoints_project_created_idx
    ON public.feltus_code_checkpoints (app_id, created_at DESC);

ALTER TABLE public.feltus_code_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_code_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_code_checkpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feltus_code_sessions_scope ON public.feltus_code_sessions;
DROP POLICY IF EXISTS feltus_code_sessions_read ON public.feltus_code_sessions;
DROP POLICY IF EXISTS feltus_code_sessions_insert ON public.feltus_code_sessions;
DROP POLICY IF EXISTS feltus_code_sessions_update ON public.feltus_code_sessions;
CREATE POLICY feltus_code_sessions_read ON public.feltus_code_sessions
FOR SELECT TO authenticated
USING (public.feltus_can_access_app(app_id, 'read'));
CREATE POLICY feltus_code_sessions_insert ON public.feltus_code_sessions
FOR INSERT TO authenticated
WITH CHECK (created_by = auth.uid() AND public.feltus_can_access_app(app_id, 'write'));
CREATE POLICY feltus_code_sessions_update ON public.feltus_code_sessions
FOR UPDATE TO authenticated
USING (public.feltus_can_access_app(app_id, 'write'))
WITH CHECK (public.feltus_can_access_app(app_id, 'write'));

DROP POLICY IF EXISTS feltus_code_actions_read ON public.feltus_code_actions;
CREATE POLICY feltus_code_actions_read ON public.feltus_code_actions
FOR SELECT TO authenticated
USING (public.feltus_can_access_app(app_id, 'read'));
DROP POLICY IF EXISTS feltus_code_actions_insert ON public.feltus_code_actions;
CREATE POLICY feltus_code_actions_insert ON public.feltus_code_actions
FOR INSERT TO authenticated
WITH CHECK (actor_id = auth.uid() AND public.feltus_can_access_app(app_id, 'write'));

DROP POLICY IF EXISTS feltus_code_checkpoints_read ON public.feltus_code_checkpoints;
CREATE POLICY feltus_code_checkpoints_read ON public.feltus_code_checkpoints
FOR SELECT TO authenticated
USING (public.feltus_can_access_app(app_id, 'read'));
DROP POLICY IF EXISTS feltus_code_checkpoints_insert ON public.feltus_code_checkpoints;
CREATE POLICY feltus_code_checkpoints_insert ON public.feltus_code_checkpoints
FOR INSERT TO authenticated
WITH CHECK (actor_id = auth.uid() AND public.feltus_can_access_app(app_id, 'write'));

REVOKE ALL ON public.feltus_code_sessions, public.feltus_code_actions, public.feltus_code_checkpoints FROM anon;
REVOKE UPDATE ON public.feltus_code_sessions FROM authenticated;
GRANT SELECT, INSERT ON public.feltus_code_sessions TO authenticated;
GRANT UPDATE (updated_at, model) ON public.feltus_code_sessions TO authenticated;
GRANT SELECT, INSERT ON public.feltus_code_actions, public.feltus_code_checkpoints TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.feltus_code_sessions TO service_role;
GRANT SELECT, INSERT ON public.feltus_code_actions, public.feltus_code_checkpoints TO service_role;

NOTIFY pgrst, 'reload schema';
