-- FELTUS Deployment Control Plane v1.
-- Additive PostgreSQL schema for tenant isolation, RBAC, immutable artifacts,
-- deployment history, audit events, and transactional infrastructure commands.
-- Builds run outside Coolify; Coolify remains a deployment adapter only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --------------------------------------------------------------------------
-- Organizations and the fixed v1 RBAC catalog.
-- Existing feltus_applications rows are projects; existing
-- feltus_project_memberships rows remain the project's membership table.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feltus_organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
    slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    personal_owner_id UUID,
    created_by UUID NOT NULL,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS feltus_organizations_personal_owner_uq
    ON public.feltus_organizations (personal_owner_id)
    WHERE personal_owner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.feltus_rbac_permissions (
    permission_key TEXT PRIMARY KEY CHECK (permission_key ~ '^[a-z][a-z0-9_.]{0,95}$'),
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feltus_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_key TEXT NOT NULL CHECK (scope_key IN ('organization','project')),
    role_key TEXT NOT NULL CHECK (role_key ~ '^[a-z][a-z0-9_]{0,63}$'),
    display_name TEXT NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT true CHECK (is_system),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (scope_key, role_key),
    UNIQUE (id, scope_key)
);

CREATE TABLE IF NOT EXISTS public.feltus_role_permissions (
    role_id UUID NOT NULL REFERENCES public.feltus_roles(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL REFERENCES public.feltus_rbac_permissions(permission_key) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (role_id, permission_key)
);

INSERT INTO public.feltus_rbac_permissions (permission_key, description) VALUES
    ('read', 'Read project-scoped resources.'),
    ('write', 'Create or update project-scoped resources.'),
    ('admin', 'Administer project membership and settings.'),
    ('organization.read', 'Read organization details.'),
    ('organization.manage', 'Manage organization settings.'),
    ('members.read', 'Read organization membership.'),
    ('members.manage', 'Invite, disable, or change organization members.'),
    ('projects.read', 'Read projects in the organization.'),
    ('projects.write', 'Create or update projects in the organization.'),
    ('projects.admin', 'Administer all projects in the organization.'),
    ('environments.read', 'Read environment configuration metadata.'),
    ('environments.manage', 'Manage project environments.'),
    ('git.read', 'Read repository connection metadata.'),
    ('git.manage', 'Manage repository connections and webhooks.'),
    ('builds.read', 'Read build status and sanitized build step metadata.'),
    ('builds.trigger', 'Request a build.'),
    ('artifacts.read', 'Read artifact metadata.'),
    ('deployments.read', 'Read deployment history and health status.'),
    ('deployments.create', 'Request a deployment of a verified artifact.'),
    ('deployments.cancel', 'Cancel a deployment.'),
    ('deployments.rollback', 'Request rollback to a verified artifact.'),
    ('secrets.read', 'Read secret names and metadata, never plaintext.'),
    ('secrets.manage', 'Create, rotate, or remove environment secrets.'),
    ('audit.read', 'Read organization and project audit events.'),
    ('previews.manage', 'Manage isolated preview environments.')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO public.feltus_roles (scope_key, role_key, display_name) VALUES
    ('organization','org_owner','Organization owner'),
    ('organization','org_admin','Organization administrator'),
    ('organization','org_member','Organization member'),
    ('organization','org_viewer','Organization viewer'),
    ('project','owner','Project owner'),
    ('project','admin','Project administrator'),
    ('project','developer','Developer'),
    ('project','operator','Operator'),
    ('project','viewer','Project viewer')
ON CONFLICT (scope_key, role_key) DO NOTHING;

INSERT INTO public.feltus_role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM public.feltus_roles r
CROSS JOIN unnest(ARRAY[
    'read','write','admin','organization.read','organization.manage',
    'members.read','members.manage','projects.read','projects.write','projects.admin',
    'environments.read','environments.manage','git.read','git.manage',
    'builds.read','builds.trigger','artifacts.read','deployments.read',
    'deployments.create','deployments.cancel','deployments.rollback',
    'secrets.read','secrets.manage','audit.read','previews.manage'
]::TEXT[]) AS p(permission_key)
WHERE r.scope_key = 'organization' AND r.role_key IN ('org_owner','org_admin')
ON CONFLICT DO NOTHING;

INSERT INTO public.feltus_role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM public.feltus_roles r
CROSS JOIN unnest(ARRAY[
    'read','organization.read','members.read'
]::TEXT[]) AS p(permission_key)
WHERE r.scope_key = 'organization' AND r.role_key IN ('org_member','org_viewer')
ON CONFLICT DO NOTHING;

INSERT INTO public.feltus_role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM public.feltus_roles r
CROSS JOIN unnest(ARRAY[
    'read','write','admin','builds.read','builds.trigger','artifacts.read',
    'deployments.read','deployments.create','deployments.cancel','deployments.rollback',
    'environments.read','environments.manage','git.read','git.manage',
    'secrets.read','secrets.manage','audit.read','previews.manage'
]::TEXT[]) AS p(permission_key)
WHERE r.scope_key = 'project' AND r.role_key IN ('owner','admin')
ON CONFLICT DO NOTHING;

INSERT INTO public.feltus_role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM public.feltus_roles r
CROSS JOIN unnest(ARRAY[
    'read','write','builds.read','builds.trigger','artifacts.read',
    'deployments.read','environments.read','git.read'
]::TEXT[]) AS p(permission_key)
WHERE r.scope_key = 'project' AND r.role_key = 'developer'
ON CONFLICT DO NOTHING;

INSERT INTO public.feltus_role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM public.feltus_roles r
CROSS JOIN unnest(ARRAY[
    'read','write','deployments.read','deployments.create','deployments.cancel',
    'deployments.rollback','environments.read','builds.read','artifacts.read','audit.read'
]::TEXT[]) AS p(permission_key)
WHERE r.scope_key = 'project' AND r.role_key = 'operator'
ON CONFLICT DO NOTHING;

INSERT INTO public.feltus_role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM public.feltus_roles r
CROSS JOIN unnest(ARRAY[
    'read','builds.read','artifacts.read','deployments.read','environments.read','git.read'
]::TEXT[]) AS p(permission_key)
WHERE r.scope_key = 'project' AND r.role_key = 'viewer'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.feltus_organization_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.feltus_organizations(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL,
    role_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','suspended')),
    invited_by UUID,
    joined_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    scope_key TEXT NOT NULL DEFAULT 'organization' CHECK (scope_key = 'organization'),
    UNIQUE (organization_id, user_id),
    FOREIGN KEY (role_id, scope_key) REFERENCES public.feltus_roles(id, scope_key)
        DEFERRABLE INITIALLY DEFERRED
);

-- Add a concrete scope key to the existing project memberships so the role FK
-- prevents an organization role from being assigned to a project membership.
ALTER TABLE public.feltus_applications
    ADD COLUMN IF NOT EXISTS organization_id UUID;

ALTER TABLE public.feltus_project_memberships
    ADD COLUMN IF NOT EXISTS organization_id UUID,
    ADD COLUMN IF NOT EXISTS role_id UUID,
    ADD COLUMN IF NOT EXISTS scope_key TEXT NOT NULL DEFAULT 'project';

ALTER TABLE public.feltus_project_memberships
    DROP CONSTRAINT IF EXISTS feltus_project_memberships_scope_key_check;
ALTER TABLE public.feltus_project_memberships
    ADD CONSTRAINT feltus_project_memberships_scope_key_check CHECK (scope_key = 'project');

CREATE OR REPLACE FUNCTION public.feltus_ensure_personal_organization(p_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_org_id UUID;
    v_role_id UUID;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'Organization owner is required' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.feltus_organizations (name, slug, personal_owner_id, created_by)
    VALUES (
        'Personal workspace',
        'personal-' || replace(p_user_id::TEXT, '-', ''),
        p_user_id,
        p_user_id
    )
    ON CONFLICT (personal_owner_id) WHERE personal_owner_id IS NOT NULL
    DO UPDATE SET personal_owner_id = EXCLUDED.personal_owner_id
    RETURNING id INTO v_org_id;

    SELECT id INTO STRICT v_role_id
    FROM public.feltus_roles
    WHERE scope_key = 'organization' AND role_key = 'org_owner';

    INSERT INTO public.feltus_organization_memberships
        (organization_id, user_id, role_id, status, joined_at)
    VALUES (v_org_id, p_user_id, v_role_id, 'active', now())
    ON CONFLICT (organization_id, user_id) DO UPDATE
       SET role_id = EXCLUDED.role_id,
           status = 'active',
           joined_at = COALESCE(public.feltus_organization_memberships.joined_at, now()),
           updated_at = now();

    RETURN v_org_id;
END;
$$;

DO $$
DECLARE
    v_owner_id UUID;
BEGIN
    FOR v_owner_id IN
        SELECT DISTINCT owner_id FROM public.feltus_applications WHERE owner_id IS NOT NULL
    LOOP
        PERFORM public.feltus_ensure_personal_organization(v_owner_id);
    END LOOP;
END
$$;

UPDATE public.feltus_applications app
SET organization_id = org.id
FROM public.feltus_organizations org
WHERE org.personal_owner_id = app.owner_id
  AND app.organization_id IS NULL;

ALTER TABLE public.feltus_applications
    ALTER COLUMN organization_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_applications_org_id_fkey') THEN
        ALTER TABLE public.feltus_applications
            ADD CONSTRAINT feltus_applications_org_id_fkey
            FOREIGN KEY (organization_id) REFERENCES public.feltus_organizations(id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_applications_id_org_uq') THEN
        ALTER TABLE public.feltus_applications
            ADD CONSTRAINT feltus_applications_id_org_uq UNIQUE (id, organization_id);
    END IF;
END
$$;

UPDATE public.feltus_project_memberships membership
SET organization_id = app.organization_id,
    role_id = role.id
FROM public.feltus_applications app,
     public.feltus_roles role
WHERE app.id = membership.app_id
  AND role.scope_key = 'project'
  AND role.role_key = membership.role
  AND (membership.organization_id IS NULL OR membership.role_id IS NULL);

INSERT INTO public.feltus_organization_memberships
    (organization_id, user_id, role_id, status, invited_by, joined_at)
SELECT
    app.organization_id,
    membership.user_id,
    CASE WHEN org.personal_owner_id = membership.user_id
         THEN owner_role.id ELSE member_role.id END,
    CASE WHEN bool_or(membership.disabled_at IS NULL) THEN 'active' ELSE 'suspended' END,
    (array_agg(membership.invited_by ORDER BY membership.created_at))[1],
    CASE WHEN bool_or(membership.disabled_at IS NULL)
         THEN min(membership.created_at) FILTER (WHERE membership.disabled_at IS NULL)
         ELSE NULL END
FROM public.feltus_project_memberships membership
JOIN public.feltus_applications app ON app.id = membership.app_id
JOIN public.feltus_organizations org ON org.id = app.organization_id
JOIN public.feltus_roles owner_role ON owner_role.scope_key = 'organization' AND owner_role.role_key = 'org_owner'
JOIN public.feltus_roles member_role ON member_role.scope_key = 'organization' AND member_role.role_key = 'org_member'
GROUP BY app.organization_id, membership.user_id, org.personal_owner_id, owner_role.id, member_role.id
ON CONFLICT (organization_id, user_id) DO NOTHING;

ALTER TABLE public.feltus_project_memberships
    ALTER COLUMN organization_id SET NOT NULL,
    ALTER COLUMN role_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_project_memberships_app_org_fkey') THEN
        ALTER TABLE public.feltus_project_memberships
            ADD CONSTRAINT feltus_project_memberships_app_org_fkey
            FOREIGN KEY (app_id, organization_id)
            REFERENCES public.feltus_applications(id, organization_id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_project_memberships_role_scope_fkey') THEN
        ALTER TABLE public.feltus_project_memberships
            ADD CONSTRAINT feltus_project_memberships_role_scope_fkey
            FOREIGN KEY (role_id, scope_key)
            REFERENCES public.feltus_roles(id, scope_key);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS feltus_organization_memberships_user_idx
    ON public.feltus_organization_memberships (user_id, organization_id)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS feltus_project_memberships_org_user_idx
    ON public.feltus_project_memberships (organization_id, user_id)
    WHERE disabled_at IS NULL;

CREATE OR REPLACE FUNCTION public.feltus_sync_project_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_org_id UUID;
    v_role_id UUID;
BEGIN
    SELECT organization_id INTO v_org_id
    FROM public.feltus_applications WHERE id = NEW.app_id;
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'Project is unavailable' USING ERRCODE = '23503';
    END IF;
    IF NEW.organization_id IS NOT NULL AND NEW.organization_id <> v_org_id THEN
        RAISE EXCEPTION 'Project membership organization mismatch' USING ERRCODE = '23514';
    END IF;
    SELECT id INTO v_role_id
    FROM public.feltus_roles
    WHERE scope_key = 'project' AND role_key = NEW.role;
    IF v_role_id IS NULL THEN
        RAISE EXCEPTION 'Unknown project role' USING ERRCODE = '23514';
    END IF;
    NEW.organization_id := v_org_id;
    NEW.role_id := v_role_id;
    NEW.scope_key := 'project';
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_project_membership_sync ON public.feltus_project_memberships;
CREATE TRIGGER feltus_project_membership_sync
BEFORE INSERT OR UPDATE ON public.feltus_project_memberships
FOR EACH ROW EXECUTE FUNCTION public.feltus_sync_project_membership();

INSERT INTO public.feltus_project_memberships (app_id, user_id, role, invited_by)
SELECT app.id, app.owner_id, 'owner', app.owner_id
FROM public.feltus_applications app
ON CONFLICT (app_id, user_id) DO UPDATE
SET role = 'owner', disabled_at = NULL, updated_at = now();

CREATE OR REPLACE FUNCTION public.feltus_protect_project_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_owner_id UUID;
BEGIN
    SELECT owner_id INTO v_owner_id
    FROM public.feltus_applications WHERE id = OLD.app_id;
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

DROP TRIGGER IF EXISTS feltus_protect_project_owner_membership ON public.feltus_project_memberships;
CREATE TRIGGER feltus_protect_project_owner_membership
BEFORE UPDATE OR DELETE ON public.feltus_project_memberships
FOR EACH ROW EXECUTE FUNCTION public.feltus_protect_project_owner_membership();

CREATE OR REPLACE FUNCTION public.feltus_ensure_project_member_org_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_role_id UUID;
BEGIN
    IF NEW.disabled_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT id INTO v_role_id
    FROM public.feltus_roles
    WHERE scope_key = 'organization' AND role_key = 'org_member';
    INSERT INTO public.feltus_organization_memberships
        (organization_id, user_id, role_id, status, invited_by, joined_at)
    VALUES (NEW.organization_id, NEW.user_id, v_role_id, 'active', NEW.invited_by, now())
    ON CONFLICT (organization_id, user_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_project_membership_add_org_member ON public.feltus_project_memberships;
CREATE TRIGGER feltus_project_membership_add_org_member
AFTER INSERT OR UPDATE ON public.feltus_project_memberships
FOR EACH ROW EXECUTE FUNCTION public.feltus_ensure_project_member_org_membership();

CREATE OR REPLACE FUNCTION public.feltus_assign_application_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_org_id UUID;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
        RAISE EXCEPTION 'Project ownership changes require a dedicated audited transfer workflow'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.organization_id IS NULL THEN
        v_org_id := public.feltus_ensure_personal_organization(NEW.owner_id);
        NEW.organization_id := v_org_id;
    ELSIF NOT EXISTS (
        SELECT 1 FROM public.feltus_organization_memberships member
        WHERE member.organization_id = NEW.organization_id
          AND member.user_id = NEW.owner_id
          AND member.status = 'active'
    ) THEN
        RAISE EXCEPTION 'Project owner must be an active organization member'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_application_assign_organization ON public.feltus_applications;
CREATE TRIGGER feltus_application_assign_organization
BEFORE INSERT OR UPDATE ON public.feltus_applications
FOR EACH ROW EXECUTE FUNCTION public.feltus_assign_application_organization();

-- --------------------------------------------------------------------------
-- Project environments and isolated preview environments.
-- Preview secrets use the same environment-scoped secret table as other
-- environments; there is no copy-from-production path in the schema.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feltus_environments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
    kind TEXT NOT NULL CHECK (kind IN ('development','preview','staging','production')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','tearing_down','deleted')),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, app_id, organization_id),
    UNIQUE (app_id, name),
    FOREIGN KEY (app_id, organization_id)
        REFERENCES public.feltus_applications(id, organization_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS feltus_environments_fixed_kind_uq
    ON public.feltus_environments (app_id, kind)
    WHERE kind <> 'preview';
CREATE INDEX IF NOT EXISTS feltus_environments_org_app_idx
    ON public.feltus_environments (organization_id, app_id, kind);

CREATE TABLE IF NOT EXISTS public.feltus_preview_environments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    environment_id UUID NOT NULL UNIQUE,
    repository_id UUID,
    pull_request_number INTEGER CHECK (pull_request_number IS NULL OR pull_request_number > 0),
    source_branch TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    cleanup_status TEXT NOT NULL DEFAULT 'active'
        CHECK (cleanup_status IN ('active','queued','cleaning','cleaned','failed')),
    cpu_millicores INTEGER NOT NULL DEFAULT 500 CHECK (cpu_millicores BETWEEN 50 AND 64000),
    memory_mb INTEGER NOT NULL DEFAULT 512 CHECK (memory_mb BETWEEN 64 AND 262144),
    storage_mb INTEGER NOT NULL DEFAULT 2048 CHECK (storage_mb BETWEEN 64 AND 1048576),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (environment_id, app_id, organization_id)
        REFERENCES public.feltus_environments(id, app_id, organization_id) ON DELETE CASCADE,
    CHECK (char_length(source_branch) BETWEEN 1 AND 255)
);

CREATE INDEX IF NOT EXISTS feltus_preview_expiry_idx
    ON public.feltus_preview_environments (expires_at)
    WHERE cleanup_status IN ('active','queued','failed');
CREATE UNIQUE INDEX IF NOT EXISTS feltus_preview_pr_uq
    ON public.feltus_preview_environments (app_id, pull_request_number)
    WHERE pull_request_number IS NOT NULL AND cleanup_status <> 'cleaned';

ALTER TABLE public.feltus_deployments
    DROP CONSTRAINT IF EXISTS feltus_deployments_environment_check;
ALTER TABLE public.feltus_deployments
    ADD CONSTRAINT feltus_deployments_environment_check
    CHECK (environment IN ('development','preview','staging','production'));

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
        (NEW.organization_id, NEW.id, 'staging', 'staging', NEW.owner_id),
        (NEW.organization_id, NEW.id, 'production', 'production', NEW.owner_id)
    ON CONFLICT (app_id, name) DO NOTHING;
    RETURN NEW;
END;
$$;

INSERT INTO public.feltus_environments (organization_id, app_id, name, kind, created_by)
SELECT app.organization_id, app.id, env.kind, env.kind, app.owner_id
FROM public.feltus_applications app
CROSS JOIN (VALUES ('development'),('staging'),('production')) AS env(kind)
ON CONFLICT (app_id, name) DO NOTHING;

DROP TRIGGER IF EXISTS feltus_application_default_environments ON public.feltus_applications;
CREATE TRIGGER feltus_application_default_environments
AFTER INSERT ON public.feltus_applications
FOR EACH ROW EXECUTE FUNCTION public.feltus_create_default_environments();

-- --------------------------------------------------------------------------
-- Git connections, repositories, webhook receipts, builds, and OCI artifacts.
-- Credentials are ciphertext only; encryption keys remain outside PostgreSQL.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feltus_git_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.feltus_organizations(id) ON DELETE RESTRICT,
    provider TEXT NOT NULL CHECK (provider IN ('github','gitlab','bitbucket','generic_git')),
    account_label TEXT NOT NULL,
    credential_ciphertext BYTEA NOT NULL,
    encryption_key_version TEXT NOT NULL,
    created_by UUID NOT NULL,
    disabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, organization_id)
);

CREATE TABLE IF NOT EXISTS public.feltus_repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    git_connection_id UUID NOT NULL,
    provider_repository_id TEXT NOT NULL,
    repository_name TEXT NOT NULL,
    clone_url TEXT NOT NULL CHECK (clone_url !~* '://[^/]*@'),
    default_branch TEXT NOT NULL DEFAULT 'main',
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, organization_id),
    UNIQUE (git_connection_id, provider_repository_id),
    FOREIGN KEY (git_connection_id, organization_id)
        REFERENCES public.feltus_git_connections(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.feltus_project_repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    repository_id UUID NOT NULL,
    attached_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, repository_id),
    UNIQUE (repository_id, app_id, organization_id),
    FOREIGN KEY (app_id, organization_id)
        REFERENCES public.feltus_applications(id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (repository_id, organization_id)
        REFERENCES public.feltus_repositories(id, organization_id) ON DELETE CASCADE
);

ALTER TABLE public.feltus_preview_environments
    ADD CONSTRAINT feltus_preview_repository_scope_fkey
    FOREIGN KEY (repository_id, app_id, organization_id)
    REFERENCES public.feltus_project_repositories(repository_id, app_id, organization_id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS public.feltus_repository_branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    repository_id UUID NOT NULL,
    environment_id UUID NOT NULL,
    branch_name TEXT NOT NULL CHECK (char_length(branch_name) BETWEEN 1 AND 255),
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repository_id, branch_name, environment_id),
    FOREIGN KEY (repository_id, app_id, organization_id)
        REFERENCES public.feltus_project_repositories(repository_id, app_id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (environment_id, app_id, organization_id)
        REFERENCES public.feltus_environments(id, app_id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.feltus_git_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    repository_id UUID NOT NULL,
    delivery_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    action_name TEXT,
    branch_name TEXT,
    commit_sha TEXT CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-fA-F]{7,64}$'),
    pull_request_number INTEGER CHECK (pull_request_number IS NULL OR pull_request_number > 0),
    payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    signature_verified BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received','queued','processed','rejected','failed')),
    error_code TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    UNIQUE (repository_id, delivery_id),
    UNIQUE (id, organization_id, repository_id),
    FOREIGN KEY (repository_id, organization_id)
        REFERENCES public.feltus_repositories(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.feltus_builds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    repository_id UUID NOT NULL,
    webhook_event_id UUID,
    requested_by UUID,
    source_branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL CHECK (commit_sha ~ '^[0-9a-fA-F]{7,64}$'),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','claimed','building','verifying','succeeded','failed','cancelled')),
    build_provider TEXT NOT NULL,
    idempotency_key TEXT,
    request_fingerprint TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, app_id, organization_id),
    FOREIGN KEY (app_id, organization_id)
        REFERENCES public.feltus_applications(id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (repository_id, organization_id)
        REFERENCES public.feltus_repositories(id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (repository_id, app_id, organization_id)
        REFERENCES public.feltus_project_repositories(repository_id, app_id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (webhook_event_id, organization_id, repository_id)
        REFERENCES public.feltus_git_webhook_events(id, organization_id, repository_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS feltus_builds_idempotency_uq
    ON public.feltus_builds (app_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS feltus_builds_project_created_idx
    ON public.feltus_builds (organization_id, app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feltus_builds_claim_idx
    ON public.feltus_builds (status, created_at)
    WHERE status IN ('queued','claimed');

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
    IF NEW.requested_by IS NOT NULL AND NOT public.feltus_user_can_access_app(
        NEW.app_id, NEW.requested_by, 'builds.trigger'
    ) THEN
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

DROP TRIGGER IF EXISTS feltus_build_validate ON public.feltus_builds;
CREATE TRIGGER feltus_build_validate
BEFORE INSERT OR UPDATE ON public.feltus_builds
FOR EACH ROW EXECUTE FUNCTION public.feltus_validate_build_record();

CREATE TABLE IF NOT EXISTS public.feltus_build_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    build_id UUID NOT NULL,
    step_key TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','succeeded','failed','skipped')),
    exit_code INTEGER,
    log_storage_ref TEXT,
    error_code TEXT,
    safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (build_id, step_key, attempt),
    FOREIGN KEY (build_id, app_id, organization_id)
        REFERENCES public.feltus_builds(id, app_id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.feltus_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    build_id UUID NOT NULL,
    registry_image TEXT NOT NULL CHECK (registry_image !~ '[@[:space:]]' AND registry_image !~ '://'),
    artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    verification_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (verification_status IN ('pending','passed','failed','revoked')),
    verification_report_ref TEXT,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, app_id, organization_id),
    UNIQUE (app_id, artifact_digest),
    FOREIGN KEY (build_id, app_id, organization_id)
        REFERENCES public.feltus_builds(id, app_id, organization_id) ON DELETE RESTRICT,
    CHECK (verification_status <> 'passed' OR verified_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS feltus_artifacts_org_project_idx
    ON public.feltus_artifacts (organization_id, app_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.feltus_keep_verified_artifact_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF OLD.verification_status IN ('passed','revoked')
       AND (NEW.app_id, NEW.organization_id, NEW.build_id, NEW.registry_image, NEW.artifact_digest)
           IS DISTINCT FROM
           (OLD.app_id, OLD.organization_id, OLD.build_id, OLD.registry_image, OLD.artifact_digest) THEN
        RAISE EXCEPTION 'Verified artifact identity is immutable' USING ERRCODE = '23514';
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

DROP TRIGGER IF EXISTS feltus_artifact_immutable ON public.feltus_artifacts;
CREATE TRIGGER feltus_artifact_immutable
BEFORE UPDATE ON public.feltus_artifacts
FOR EACH ROW EXECUTE FUNCTION public.feltus_keep_verified_artifact_immutable();

CREATE OR REPLACE FUNCTION public.feltus_validate_artifact_build()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_build_status TEXT;
BEGIN
    IF NEW.verification_status = 'passed' THEN
        SELECT status INTO v_build_status
        FROM public.feltus_builds
        WHERE id = NEW.build_id AND app_id = NEW.app_id AND organization_id = NEW.organization_id;
        IF v_build_status IS DISTINCT FROM 'succeeded' THEN
            RAISE EXCEPTION 'Only an artifact from a succeeded build can pass verification'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_artifact_build_verified ON public.feltus_artifacts;
CREATE TRIGGER feltus_artifact_build_verified
BEFORE INSERT OR UPDATE ON public.feltus_artifacts
FOR EACH ROW EXECUTE FUNCTION public.feltus_validate_artifact_build();

-- --------------------------------------------------------------------------
-- Deployment targets, current deployment records, event history, promotion,
-- domains, health checks, and secret metadata.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feltus_deployment_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    environment_id UUID NOT NULL,
    provider_key TEXT NOT NULL CHECK (provider_key IN ('coolify')),
    provider_resource_reference TEXT NOT NULL,
    provider_server_reference TEXT,
    provider_project_reference TEXT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, app_id, organization_id, environment_id),
    UNIQUE (environment_id, provider_key),
    FOREIGN KEY (environment_id, app_id, organization_id)
        REFERENCES public.feltus_environments(id, app_id, organization_id) ON DELETE CASCADE
);

ALTER TABLE public.feltus_deployments
    ADD COLUMN IF NOT EXISTS organization_id UUID,
    ADD COLUMN IF NOT EXISTS environment_id UUID,
    ADD COLUMN IF NOT EXISTS artifact_id UUID,
    ADD COLUMN IF NOT EXISTS requested_by UUID,
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
    ADD COLUMN IF NOT EXISTS promotion_id UUID;

UPDATE public.feltus_deployments deployment
SET organization_id = app.organization_id,
    environment_id = (
        SELECT env.id FROM public.feltus_environments env
        WHERE env.app_id = app.id AND env.kind = lower(deployment.environment)
        ORDER BY env.created_at LIMIT 1
    ),
    requested_by = COALESCE(deployment.requested_by, deployment.owner_id)
FROM public.feltus_applications app
WHERE app.id = deployment.app_id
  AND (deployment.organization_id IS NULL OR deployment.environment_id IS NULL OR deployment.requested_by IS NULL);

ALTER TABLE public.feltus_deployments
    ALTER COLUMN organization_id SET NOT NULL,
    ALTER COLUMN environment_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_deployments_id_app_org_uq') THEN
        ALTER TABLE public.feltus_deployments
            ADD CONSTRAINT feltus_deployments_id_app_org_uq UNIQUE (id, app_id, organization_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_deployments_app_org_fkey') THEN
        ALTER TABLE public.feltus_deployments
            ADD CONSTRAINT feltus_deployments_app_org_fkey
            FOREIGN KEY (app_id, organization_id)
            REFERENCES public.feltus_applications(id, organization_id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_deployments_environment_scope_fkey') THEN
        ALTER TABLE public.feltus_deployments
            ADD CONSTRAINT feltus_deployments_environment_scope_fkey
            FOREIGN KEY (environment_id, app_id, organization_id)
            REFERENCES public.feltus_environments(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_deployments_artifact_scope_fkey') THEN
        ALTER TABLE public.feltus_deployments
            ADD CONSTRAINT feltus_deployments_artifact_scope_fkey
            FOREIGN KEY (artifact_id, app_id, organization_id)
            REFERENCES public.feltus_artifacts(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.feltus_deployment_promotions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    source_deployment_id UUID NOT NULL,
    target_environment_id UUID NOT NULL,
    artifact_id UUID NOT NULL,
    target_deployment_id UUID,
    requested_by UUID NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested','deploying','promoted','failed','cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    UNIQUE (app_id, idempotency_key),
    UNIQUE (id, app_id, organization_id),
    FOREIGN KEY (source_deployment_id, app_id, organization_id)
        REFERENCES public.feltus_deployments(id, app_id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (target_environment_id, app_id, organization_id)
        REFERENCES public.feltus_environments(id, app_id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (artifact_id, app_id, organization_id)
        REFERENCES public.feltus_artifacts(id, app_id, organization_id) ON DELETE RESTRICT
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_deployments_promotion_scope_fkey') THEN
        ALTER TABLE public.feltus_deployments
            ADD CONSTRAINT feltus_deployments_promotion_scope_fkey
            FOREIGN KEY (promotion_id, app_id, organization_id)
            REFERENCES public.feltus_deployment_promotions(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_promotions_target_deployment_scope_fkey') THEN
        ALTER TABLE public.feltus_deployment_promotions
            ADD CONSTRAINT feltus_promotions_target_deployment_scope_fkey
            FOREIGN KEY (target_deployment_id, app_id, organization_id)
            REFERENCES public.feltus_deployments(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feltus_deployments_rollback_scope_fkey') THEN
        ALTER TABLE public.feltus_deployments
            ADD CONSTRAINT feltus_deployments_rollback_scope_fkey
            FOREIGN KEY (rollback_of, app_id, organization_id)
            REFERENCES public.feltus_deployments(id, app_id, organization_id) ON DELETE RESTRICT;
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.feltus_validate_deployment_promotion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_source_status TEXT;
    v_source_artifact UUID;
    v_artifact_status TEXT;
    v_target_kind TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND
       (NEW.organization_id, NEW.app_id, NEW.source_deployment_id, NEW.target_environment_id,
        NEW.artifact_id, NEW.idempotency_key)
       IS DISTINCT FROM
       (OLD.organization_id, OLD.app_id, OLD.source_deployment_id, OLD.target_environment_id,
        OLD.artifact_id, OLD.idempotency_key) THEN
        RAISE EXCEPTION 'Promotion source, target, artifact, and idempotency key are immutable'
            USING ERRCODE = '23514';
    END IF;

    SELECT status, artifact_id INTO v_source_status, v_source_artifact
    FROM public.feltus_deployments
    WHERE id = NEW.source_deployment_id
      AND app_id = NEW.app_id AND organization_id = NEW.organization_id;
    IF v_source_status IS DISTINCT FROM 'HEALTHY' OR v_source_artifact IS DISTINCT FROM NEW.artifact_id THEN
        RAISE EXCEPTION 'Promotion requires the verified artifact from a healthy source deployment'
            USING ERRCODE = '23514';
    END IF;

    SELECT verification_status INTO v_artifact_status
    FROM public.feltus_artifacts
    WHERE id = NEW.artifact_id AND app_id = NEW.app_id AND organization_id = NEW.organization_id;
    IF v_artifact_status IS DISTINCT FROM 'passed' THEN
        RAISE EXCEPTION 'Promotion requires a currently verified artifact' USING ERRCODE = '23514';
    END IF;
    IF NOT public.feltus_user_can_access_app(NEW.app_id, NEW.requested_by, 'deployments.create') THEN
        RAISE EXCEPTION 'Promotion actor is not authorized for this project'
            USING ERRCODE = '42501';
    END IF;

    SELECT kind INTO v_target_kind
    FROM public.feltus_environments
    WHERE id = NEW.target_environment_id
      AND app_id = NEW.app_id AND organization_id = NEW.organization_id;
    IF v_target_kind IS NULL OR v_target_kind = 'preview' THEN
        RAISE EXCEPTION 'Promotion target must be a persistent project environment' USING ERRCODE = '23514';
    END IF;

    IF NEW.target_deployment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.feltus_deployments target
        WHERE target.id = NEW.target_deployment_id
          AND target.app_id = NEW.app_id
          AND target.organization_id = NEW.organization_id
          AND target.environment_id = NEW.target_environment_id
          AND target.artifact_id = NEW.artifact_id
    ) THEN
        RAISE EXCEPTION 'Promotion target deployment must use the same artifact and environment'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_deployment_promotion_validate ON public.feltus_deployment_promotions;
CREATE TRIGGER feltus_deployment_promotion_validate
BEFORE INSERT OR UPDATE ON public.feltus_deployment_promotions
FOR EACH ROW EXECUTE FUNCTION public.feltus_validate_deployment_promotion();

CREATE UNIQUE INDEX IF NOT EXISTS feltus_deployments_idempotency_uq
    ON public.feltus_deployments (app_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS feltus_deployments_org_project_created_idx
    ON public.feltus_deployments (organization_id, app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feltus_deployments_environment_created_idx
    ON public.feltus_deployments (environment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feltus_deployments_artifact_idx
    ON public.feltus_deployments (artifact_id)
    WHERE artifact_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.feltus_validate_deployment_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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
        NEW.request_fingerprint := encode(public.digest(
            NEW.app_id::TEXT || ':' || NEW.environment_id::TEXT || ':' || NEW.artifact_id::TEXT,
            'sha256'
        ), 'hex');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_deployment_validate ON public.feltus_deployments;
CREATE TRIGGER feltus_deployment_validate
BEFORE INSERT OR UPDATE ON public.feltus_deployments
FOR EACH ROW EXECUTE FUNCTION public.feltus_validate_deployment_record();

CREATE TABLE IF NOT EXISTS public.feltus_deployment_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    deployment_id UUID NOT NULL,
    environment_id UUID NOT NULL,
    actor_user_id UUID,
    event_type TEXT NOT NULL,
    previous_status TEXT,
    current_status TEXT NOT NULL,
    safe_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Preserve history if deployment or environment records are removed later.
    CHECK (deployment_id IS NOT NULL AND environment_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS feltus_deployment_events_history_idx
    ON public.feltus_deployment_events (deployment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.feltus_deployment_health_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    deployment_id UUID NOT NULL,
    environment_id UUID NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('healthy','degraded','unhealthy','unknown')),
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    safe_summary TEXT,
    safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    FOREIGN KEY (deployment_id, app_id, organization_id)
        REFERENCES public.feltus_deployments(id, app_id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (environment_id, app_id, organization_id)
        REFERENCES public.feltus_environments(id, app_id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS feltus_deployment_health_recent_idx
    ON public.feltus_deployment_health_checks (deployment_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS public.feltus_deployment_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    environment_id UUID NOT NULL,
    domain_name TEXT NOT NULL CHECK (
        char_length(domain_name) BETWEEN 4 AND 253
        AND domain_name = lower(domain_name)
        AND domain_name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
        AND domain_name !~ '\.\.'
    ),
    tls_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (tls_status IN ('pending','issuing','active','failed','disabled')),
    provider_reference TEXT,
    verified_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (domain_name),
    FOREIGN KEY (environment_id, app_id, organization_id)
        REFERENCES public.feltus_environments(id, app_id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.feltus_environment_secrets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    environment_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (name ~ '^[A-Z_][A-Z0-9_]{0,127}$'),
    ciphertext BYTEA NOT NULL,
    encryption_key_version TEXT NOT NULL,
    value_fingerprint TEXT,
    created_by UUID NOT NULL,
    updated_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (environment_id, name),
    FOREIGN KEY (environment_id, app_id, organization_id)
        REFERENCES public.feltus_environments(id, app_id, organization_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS feltus_environment_secrets_scope_idx
    ON public.feltus_environment_secrets (organization_id, app_id, environment_id);

CREATE OR REPLACE VIEW public.feltus_environment_secret_metadata
WITH (security_invoker = true)
AS
SELECT id, organization_id, app_id, environment_id, name, value_fingerprint,
       created_by, updated_by, created_at, updated_at
FROM public.feltus_environment_secrets;

-- Generic audit records are append-only. Event detail written by deployment
-- triggers contains only allowlisted identifiers and state, never request or
-- secret payloads.
CREATE TABLE IF NOT EXISTS public.feltus_audit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES public.feltus_organizations(id) ON DELETE RESTRICT,
    app_id UUID,
    environment_id UUID,
    actor_user_id UUID,
    actor_kind TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user','system','service')),
    action_key TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    after_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    request_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Keep historical identifiers even after project/environment cleanup.
    CHECK (app_id IS NOT NULL OR environment_id IS NULL)
);

CREATE INDEX IF NOT EXISTS feltus_audit_org_created_idx
    ON public.feltus_audit_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feltus_audit_project_created_idx
    ON public.feltus_audit_events (app_id, created_at DESC)
    WHERE app_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.feltus_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS feltus_audit_append_only ON public.feltus_audit_events;
CREATE TRIGGER feltus_audit_append_only
BEFORE UPDATE OR DELETE ON public.feltus_audit_events
FOR EACH ROW EXECUTE FUNCTION public.feltus_reject_audit_mutation();

CREATE OR REPLACE FUNCTION public.feltus_audit_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_row JSONB;
    v_old JSONB;
    v_org_id UUID;
    v_app_id UUID;
    v_user_id UUID;
    v_role_id UUID;
    v_actor UUID;
    v_action TEXT;
BEGIN
    v_actor := auth.uid();
    IF TG_OP = 'DELETE' THEN
        v_row := to_jsonb(OLD);
        v_old := jsonb_build_object(
            'role_id', v_row -> 'role_id',
            'status', COALESCE(v_row ->> 'status', CASE WHEN v_row ->> 'disabled_at' IS NULL THEN 'active' ELSE 'disabled' END)
        );
        v_org_id := NULLIF(v_row ->> 'organization_id','')::UUID;
        v_app_id := NULLIF(v_row ->> 'app_id','')::UUID;
        v_user_id := NULLIF(v_row ->> 'user_id','')::UUID;
        v_role_id := NULLIF(v_row ->> 'role_id','')::UUID;
        v_actor := COALESCE(v_actor, NULLIF(v_row ->> 'invited_by','')::UUID);
        v_action := 'membership.deleted';
    ELSE
        v_row := to_jsonb(NEW);
        v_org_id := NULLIF(v_row ->> 'organization_id','')::UUID;
        v_app_id := NULLIF(v_row ->> 'app_id','')::UUID;
        v_user_id := NULLIF(v_row ->> 'user_id','')::UUID;
        v_role_id := NULLIF(v_row ->> 'role_id','')::UUID;
        v_actor := COALESCE(v_actor, NULLIF(v_row ->> 'invited_by','')::UUID);
        v_action := CASE WHEN TG_OP = 'INSERT' THEN 'membership.created' ELSE 'membership.updated' END;
        IF TG_OP = 'UPDATE' THEN
            v_old := to_jsonb(OLD);
            v_old := jsonb_build_object(
                'role_id', v_old -> 'role_id',
                'status', COALESCE(v_old ->> 'status', CASE WHEN v_old ->> 'disabled_at' IS NULL THEN 'active' ELSE 'disabled' END)
            );
        END IF;
    END IF;

    INSERT INTO public.feltus_audit_events
        (organization_id, app_id, actor_user_id, actor_kind, action_key, entity_type, entity_id, before_data, after_data)
    VALUES (
        v_org_id, v_app_id, v_actor, CASE WHEN v_actor IS NULL THEN 'service' ELSE 'user' END,
        v_action,
        CASE WHEN v_app_id IS NOT NULL THEN 'project_member' ELSE 'organization_member' END,
        v_org_id::TEXT || ':' || COALESCE(v_app_id::TEXT || ':', '') || v_user_id::TEXT,
        COALESCE(v_old, '{}'::jsonb),
        jsonb_build_object('role_id', v_role_id, 'status', COALESCE(v_row ->> 'status', CASE WHEN v_row ->> 'disabled_at' IS NULL THEN 'active' ELSE 'disabled' END))
    );
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_org_membership_audit ON public.feltus_organization_memberships;
CREATE TRIGGER feltus_org_membership_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_organization_memberships
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_membership_change();

DROP TRIGGER IF EXISTS feltus_project_membership_audit ON public.feltus_project_memberships;
CREATE TRIGGER feltus_project_membership_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_project_memberships
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_membership_change();

CREATE OR REPLACE FUNCTION public.feltus_audit_environment_secret_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_row RECORD;
    v_action TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
    v_action := CASE TG_OP WHEN 'INSERT' THEN 'secret.created' WHEN 'UPDATE' THEN 'secret.rotated' ELSE 'secret.deleted' END;
    INSERT INTO public.feltus_audit_events
        (organization_id, app_id, environment_id, actor_user_id, actor_kind, action_key, entity_type, entity_id, after_data)
    VALUES (
        v_row.organization_id, v_row.app_id, v_row.environment_id,
        COALESCE(auth.uid(), CASE TG_OP WHEN 'DELETE' THEN OLD.updated_by ELSE NEW.updated_by END),
        CASE WHEN auth.uid() IS NULL THEN 'service' ELSE 'user' END, v_action, 'environment_secret', v_row.id::TEXT,
        jsonb_build_object('name', v_row.name, 'key_version', v_row.encryption_key_version)
    );
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_environment_secret_audit ON public.feltus_environment_secrets;
CREATE TRIGGER feltus_environment_secret_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_environment_secrets
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_environment_secret_change();

CREATE OR REPLACE FUNCTION public.feltus_audit_deployment_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_event_type TEXT;
    v_previous TEXT;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        v_event_type := 'deployment.created';
        v_previous := NULL;
    ELSE
        v_event_type := 'deployment.status_changed';
        v_previous := OLD.status;
    END IF;
    INSERT INTO public.feltus_deployment_events
        (organization_id, app_id, deployment_id, environment_id, actor_user_id,
         event_type, previous_status, current_status, safe_details)
    VALUES (
        NEW.organization_id, NEW.app_id, NEW.id, NEW.environment_id,
        COALESCE(auth.uid(), NEW.requested_by), v_event_type, v_previous, NEW.status,
        jsonb_build_object('artifact_id', NEW.artifact_id, 'provider', NEW.provider)
    );
    INSERT INTO public.feltus_audit_events
        (organization_id, app_id, environment_id, actor_user_id, actor_kind,
         action_key, entity_type, entity_id, before_data, after_data)
    VALUES (
        NEW.organization_id, NEW.app_id, NEW.environment_id,
        COALESCE(auth.uid(), NEW.requested_by),
        CASE WHEN auth.uid() IS NULL THEN 'service' ELSE 'user' END,
        v_event_type, 'deployment', NEW.id::TEXT,
        CASE WHEN v_previous IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('status', v_previous) END,
        jsonb_build_object('status', NEW.status, 'environment_id', NEW.environment_id, 'artifact_id', NEW.artifact_id)
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_deployment_events_audit ON public.feltus_deployments;
CREATE TRIGGER feltus_deployment_events_audit
AFTER INSERT OR UPDATE ON public.feltus_deployments
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_deployment_change();

-- --------------------------------------------------------------------------
-- Transactional infrastructure outbox. Only artifact-backed deployments
-- enqueue; legacy history records without an artifact remain record-only.
-- The trigger executes in the deployment INSERT transaction, before commit.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.feltus_json_contains_sensitive_key(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
    SELECT CASE jsonb_typeof(p_value)
        WHEN 'object' THEN EXISTS (
            SELECT 1 FROM jsonb_each(p_value) item
            WHERE item.key ~* '(password|secret|token|credential|private|authorization|api[_-]?key)'
               OR public.feltus_json_contains_sensitive_key(item.value)
        )
        WHEN 'array' THEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_value) item(value)
            WHERE public.feltus_json_contains_sensitive_key(item.value)
        )
        ELSE false
    END
$$;

CREATE TABLE IF NOT EXISTS public.feltus_infrastructure_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    app_id UUID NOT NULL,
    environment_id UUID NOT NULL,
    target_id UUID NOT NULL,
    artifact_id UUID NOT NULL,
    deployment_id UUID NOT NULL,
    provider_key TEXT NOT NULL CHECK (provider_key IN ('coolify')),
    command_type TEXT NOT NULL CHECK (
        command_type IN ('deploy_artifact','reconcile_deployment','configure_domain_tls','teardown_environment')
    ),
    idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
    payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version > 0),
    command_payload JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (NOT public.feltus_json_contains_sensitive_key(command_payload)),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','leased','delivered','dead_letter','cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_owner TEXT,
    lease_token UUID,
    lease_version BIGINT NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
    lease_expires_at TIMESTAMPTZ,
    provider_operation_id TEXT CHECK (provider_operation_id IS NULL OR provider_operation_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
    last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    UNIQUE (deployment_id, command_type),
    UNIQUE (app_id, idempotency_key),
    FOREIGN KEY (deployment_id, app_id, organization_id)
        REFERENCES public.feltus_deployments(id, app_id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (environment_id, app_id, organization_id)
        REFERENCES public.feltus_environments(id, app_id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (target_id, app_id, organization_id, environment_id)
        REFERENCES public.feltus_deployment_targets(id, app_id, organization_id, environment_id) ON DELETE RESTRICT,
    FOREIGN KEY (artifact_id, app_id, organization_id)
        REFERENCES public.feltus_artifacts(id, app_id, organization_id) ON DELETE RESTRICT,
    CHECK (
        (state = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (state <> 'leased' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state <> 'delivered' OR (provider_operation_id IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS feltus_outbox_claim_idx
    ON public.feltus_infrastructure_outbox (available_at, created_at)
    WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS feltus_outbox_expired_lease_idx
    ON public.feltus_infrastructure_outbox (lease_expires_at)
    WHERE state = 'leased';
CREATE INDEX IF NOT EXISTS feltus_outbox_project_history_idx
    ON public.feltus_infrastructure_outbox (organization_id, app_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.feltus_enqueue_deployment_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_artifact public.feltus_artifacts%ROWTYPE;
    v_target public.feltus_deployment_targets%ROWTYPE;
    v_key TEXT;
BEGIN
    IF NEW.artifact_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO STRICT v_artifact
    FROM public.feltus_artifacts
    WHERE id = NEW.artifact_id AND app_id = NEW.app_id AND organization_id = NEW.organization_id;
    SELECT * INTO STRICT v_target
    FROM public.feltus_deployment_targets
    WHERE environment_id = NEW.environment_id AND app_id = NEW.app_id
      AND organization_id = NEW.organization_id AND provider_key = NEW.provider AND active;
    v_key := NEW.idempotency_key;
    INSERT INTO public.feltus_infrastructure_outbox
        (organization_id, app_id, environment_id, target_id, artifact_id, deployment_id, provider_key,
         command_type, idempotency_key, command_payload)
    VALUES (
        NEW.organization_id, NEW.app_id, NEW.environment_id, v_target.id, v_artifact.id, NEW.id, v_target.provider_key,
        'deploy_artifact', v_key,
        jsonb_build_object(
            'deployment_id', NEW.id,
            'target_id', v_target.id,
            'target_reference', v_target.provider_resource_reference,
            'artifact_id', v_artifact.id,
            'registry_image', v_artifact.registry_image,
            'artifact_digest', v_artifact.artifact_digest
        )
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_deployment_enqueue_outbox ON public.feltus_deployments;
CREATE TRIGGER feltus_deployment_enqueue_outbox
AFTER INSERT ON public.feltus_deployments
FOR EACH ROW WHEN (NEW.artifact_id IS NOT NULL)
EXECUTE FUNCTION public.feltus_enqueue_deployment_outbox();

CREATE OR REPLACE FUNCTION public.feltus_claim_infrastructure_outbox(
    p_worker_id TEXT,
    p_limit INTEGER DEFAULT 1,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS SETOF public.feltus_infrastructure_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF p_worker_id IS NULL OR char_length(trim(p_worker_id)) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'Invalid worker id' USING ERRCODE = '22023';
    END IF;

    UPDATE public.feltus_infrastructure_outbox
    SET state = 'dead_letter',
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS',
        updated_at = now(), completed_at = now()
    WHERE state = 'leased' AND lease_expires_at <= now() AND attempt_count >= max_attempts;

    UPDATE public.feltus_infrastructure_outbox
    SET state = 'pending',
        available_at = now(),
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        last_error_code = COALESCE(last_error_code, 'LEASE_EXPIRED'),
        updated_at = now()
    WHERE state = 'leased' AND lease_expires_at <= now() AND attempt_count < max_attempts;

    UPDATE public.feltus_infrastructure_outbox outbox
    SET state = 'cancelled',
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        last_error_code = 'DEPLOYMENT_TERMINAL',
        completed_at = now(), updated_at = now()
    FROM public.feltus_deployments deployment
    WHERE outbox.deployment_id = deployment.id
      AND outbox.state = 'pending'
      AND deployment.status IN ('FAILED','CANCELLED','ROLLED_BACK');

    UPDATE public.feltus_infrastructure_outbox outbox
    SET state = 'dead_letter',
        last_error_code = 'ARTIFACT_REVOKED_OR_TARGET_DISABLED',
        completed_at = now(), updated_at = now()
    FROM public.feltus_artifacts artifact,
         public.feltus_deployment_targets target
    WHERE outbox.state = 'pending'
      AND artifact.id = outbox.artifact_id
      AND target.id = outbox.target_id
      AND (artifact.verification_status <> 'passed' OR NOT target.active);

    UPDATE public.feltus_deployments deployment
    SET status = 'FAILED', completed_at = now()
    FROM public.feltus_infrastructure_outbox outbox
    WHERE outbox.deployment_id = deployment.id
      AND outbox.state = 'dead_letter'
      AND outbox.last_error_code IN ('LEASE_EXPIRED_MAX_ATTEMPTS','ARTIFACT_REVOKED_OR_TARGET_DISABLED')
      AND deployment.status IN ('QUEUED','BUILDING','DEPLOYING');

    RETURN QUERY
    WITH candidates AS (
        SELECT outbox.id
        FROM public.feltus_infrastructure_outbox outbox
        WHERE outbox.state = 'pending'
          AND outbox.available_at <= now()
          AND outbox.attempt_count < outbox.max_attempts
        ORDER BY outbox.available_at, outbox.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 50)
    )
    UPDATE public.feltus_infrastructure_outbox outbox
    SET state = 'leased',
        attempt_count = outbox.attempt_count + 1,
        lease_owner = p_worker_id,
        lease_token = gen_random_uuid(),
        lease_version = outbox.lease_version + 1,
        lease_expires_at = now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 120), 10), 3600)),
        updated_at = now()
    FROM candidates
    WHERE outbox.id = candidates.id
    RETURNING outbox.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_heartbeat_infrastructure_outbox(
    p_outbox_id UUID,
    p_lease_token UUID,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
    WITH extended AS (
        UPDATE public.feltus_infrastructure_outbox
        SET lease_expires_at = now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 120), 10), 3600)),
            updated_at = now()
        WHERE id = p_outbox_id AND state = 'leased'
          AND lease_token = p_lease_token AND lease_expires_at > now()
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM extended)
$$;

CREATE OR REPLACE FUNCTION public.feltus_complete_infrastructure_outbox(
    p_outbox_id UUID,
    p_lease_token UUID,
    p_provider_operation_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_deployment_id UUID;
BEGIN
    IF p_provider_operation_id IS NULL OR char_length(trim(p_provider_operation_id)) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'Provider operation reference is required' USING ERRCODE = '22023';
    END IF;
    UPDATE public.feltus_infrastructure_outbox
    SET state = 'delivered',
        provider_operation_id = NULLIF(left(trim(COALESCE(p_provider_operation_id, '')), 200), ''),
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        last_error_code = NULL, completed_at = now(), updated_at = now()
    WHERE id = p_outbox_id AND state = 'leased'
      AND lease_token = p_lease_token AND lease_expires_at > now()
    RETURNING deployment_id INTO v_deployment_id;
    IF NOT FOUND THEN RETURN false; END IF;

    UPDATE public.feltus_deployments
    SET provider_reference = NULLIF(left(trim(COALESCE(p_provider_operation_id, '')), 200), ''),
        status = CASE WHEN status IN ('QUEUED','BUILDING') THEN 'DEPLOYING' ELSE status END,
        started_at = COALESCE(started_at, now())
    WHERE id = v_deployment_id;
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_retry_infrastructure_outbox(
    p_outbox_id UUID,
    p_lease_token UUID,
    p_error_code TEXT,
    p_retryable BOOLEAN DEFAULT true
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_deployment_id UUID;
    v_state TEXT;
    v_attempt INTEGER;
    v_max INTEGER;
BEGIN
    UPDATE public.feltus_infrastructure_outbox
    SET last_error_code = left(COALESCE(NULLIF(regexp_replace(upper(COALESCE(p_error_code, 'UNKNOWN')), '[^A-Z0-9_]', '', 'g'), ''), 'UNKNOWN'), 64),
        state = CASE WHEN NOT COALESCE(p_retryable, false) OR attempt_count >= max_attempts
                     THEN 'dead_letter' ELSE 'pending' END,
        available_at = CASE WHEN NOT COALESCE(p_retryable, false) OR attempt_count >= max_attempts
                            THEN available_at
                            ELSE now() + make_interval(secs => LEAST((2 ^ LEAST(attempt_count, 11))::INTEGER, 3600)) END,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        completed_at = CASE WHEN NOT COALESCE(p_retryable, false) OR attempt_count >= max_attempts THEN now() ELSE NULL END,
        updated_at = now()
    WHERE id = p_outbox_id AND state = 'leased'
      AND lease_token = p_lease_token AND lease_expires_at > now()
    RETURNING deployment_id, state, attempt_count, max_attempts
    INTO v_deployment_id, v_state, v_attempt, v_max;
    IF NOT FOUND THEN RETURN false; END IF;

    IF v_state = 'dead_letter' THEN
        UPDATE public.feltus_deployments
        SET status = 'FAILED', completed_at = now()
        WHERE id = v_deployment_id AND status NOT IN ('FAILED','CANCELLED','ROLLED_BACK');
    END IF;
    RETURN true;
END;
$$;

-- --------------------------------------------------------------------------
-- Tenant-aware access helpers. Existing policies already call
-- feltus_can_access_app; keep that API while making the normalized role tables
-- authoritative and retaining legacy explicit permission grants.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.feltus_user_can_access_app(
    p_app_id UUID,
    p_user_id UUID,
    p_permission TEXT DEFAULT 'read'
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
    SELECT p_user_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.feltus_applications app
        JOIN public.feltus_organization_memberships org_member
          ON org_member.organization_id = app.organization_id
         AND org_member.user_id = p_user_id
         AND org_member.status = 'active'
        JOIN public.feltus_roles org_role ON org_role.id = org_member.role_id
        JOIN public.feltus_role_permissions org_permission ON org_permission.role_id = org_role.id
        WHERE app.id = p_app_id
          AND org_role.scope_key = 'organization'
          AND org_permission.permission_key = CASE p_permission
                WHEN 'read' THEN 'projects.read'
                WHEN 'write' THEN 'projects.write'
                WHEN 'admin' THEN 'projects.admin'
                ELSE p_permission
              END
    ) OR p_user_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.feltus_applications app
        JOIN public.feltus_organization_memberships org_member
          ON org_member.organization_id = app.organization_id
         AND org_member.user_id = p_user_id
         AND org_member.status = 'active'
        JOIN public.feltus_project_memberships member
          ON member.app_id = app.id AND member.organization_id = app.organization_id
         AND member.user_id = p_user_id AND member.disabled_at IS NULL
        JOIN public.feltus_roles project_role ON project_role.id = member.role_id
        LEFT JOIN public.feltus_role_permissions permission
          ON permission.role_id = project_role.id AND permission.permission_key = p_permission
        WHERE app.id = p_app_id
          AND (permission.permission_key IS NOT NULL
               OR COALESCE((member.permissions ->> p_permission)::BOOLEAN, false))
    ) OR p_user_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.feltus_applications app
        JOIN public.feltus_organization_memberships org_member
          ON org_member.organization_id = app.organization_id
         AND org_member.user_id = p_user_id
         AND org_member.status = 'active'
        WHERE app.id = p_app_id AND app.owner_id = p_user_id
    );
$$;

CREATE OR REPLACE FUNCTION public.feltus_can_access_app(
    p_app_id UUID,
    p_permission TEXT DEFAULT 'read'
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
    SELECT public.feltus_user_can_access_app(p_app_id, auth.uid(), p_permission)
$$;

CREATE OR REPLACE FUNCTION public.feltus_can_access_org(
    p_organization_id UUID,
    p_permission TEXT DEFAULT 'organization.read'
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.feltus_organization_memberships membership
        JOIN public.feltus_roles role ON role.id = membership.role_id
        JOIN public.feltus_role_permissions permission ON permission.role_id = role.id
        WHERE membership.organization_id = p_organization_id
          AND membership.user_id = auth.uid()
          AND membership.status = 'active'
          AND role.scope_key = 'organization'
          AND permission.permission_key = p_permission
    )
$$;

CREATE OR REPLACE FUNCTION public.feltus_can_assign_org_role(
    p_organization_id UUID,
    p_role_id UUID,
    p_target_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
    SELECT auth.uid() IS NOT NULL
       AND EXISTS (
           SELECT 1
           FROM public.feltus_organization_memberships actor_membership
           JOIN public.feltus_roles actor_role ON actor_role.id = actor_membership.role_id
           JOIN public.feltus_role_permissions actor_permission ON actor_permission.role_id = actor_role.id
           WHERE actor_membership.organization_id = p_organization_id
             AND actor_membership.user_id = auth.uid()
             AND actor_membership.status = 'active'
             AND actor_role.scope_key = 'organization'
             AND actor_permission.permission_key = 'members.manage'
       )
       AND EXISTS (
           SELECT 1 FROM public.feltus_roles target_role
           WHERE target_role.id = p_role_id
             AND target_role.scope_key = 'organization'
             AND (
                 target_role.role_key NOT IN ('org_owner','org_admin')
                 OR EXISTS (
                     SELECT 1
                     FROM public.feltus_organization_memberships actor_membership
                     JOIN public.feltus_roles actor_role ON actor_role.id = actor_membership.role_id
                     WHERE actor_membership.organization_id = p_organization_id
                       AND actor_membership.user_id = auth.uid()
                       AND actor_membership.status = 'active'
                       AND actor_role.role_key = 'org_owner'
                 )
             )
       )
       AND (
           NOT EXISTS (
               SELECT 1
               FROM public.feltus_organization_memberships target_membership
               JOIN public.feltus_roles existing_role ON existing_role.id = target_membership.role_id
               WHERE target_membership.organization_id = p_organization_id
                 AND target_membership.user_id = p_target_user_id
                 AND target_membership.status = 'active'
                 AND existing_role.role_key IN ('org_owner','org_admin')
           )
           OR EXISTS (
               SELECT 1
               FROM public.feltus_organization_memberships actor_membership
               JOIN public.feltus_roles actor_role ON actor_role.id = actor_membership.role_id
               WHERE actor_membership.organization_id = p_organization_id
                 AND actor_membership.user_id = auth.uid()
                 AND actor_membership.status = 'active'
                 AND actor_role.role_key = 'org_owner'
           )
       )
$$;

CREATE OR REPLACE FUNCTION public.feltus_can_assign_project_role(
    p_app_id UUID,
    p_role_id UUID,
    p_target_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
    SELECT auth.uid() IS NOT NULL
       AND public.feltus_user_can_access_app(p_app_id, auth.uid(), 'admin')
       AND EXISTS (
           SELECT 1 FROM public.feltus_roles target_role
           WHERE target_role.id = p_role_id
             AND target_role.scope_key = 'project'
             AND (
                 target_role.role_key <> 'owner'
                 OR EXISTS (
                     SELECT 1 FROM public.feltus_applications app
                     JOIN public.feltus_organization_memberships member
                       ON member.organization_id = app.organization_id
                      AND member.user_id = auth.uid() AND member.status = 'active'
                     JOIN public.feltus_roles org_role ON org_role.id = member.role_id
                     WHERE app.id = p_app_id AND org_role.role_key = 'org_owner'
                 )
             )
       )
       AND (
           NOT EXISTS (
               SELECT 1
               FROM public.feltus_project_memberships target_membership
               JOIN public.feltus_roles existing_role ON existing_role.id = target_membership.role_id
               WHERE target_membership.app_id = p_app_id
                 AND target_membership.user_id = p_target_user_id
                 AND target_membership.disabled_at IS NULL
                 AND existing_role.role_key IN ('owner','admin')
           )
           OR EXISTS (
               SELECT 1
               FROM public.feltus_project_memberships actor_membership
               JOIN public.feltus_roles actor_role ON actor_role.id = actor_membership.role_id
               WHERE actor_membership.app_id = p_app_id
                 AND actor_membership.user_id = auth.uid()
                 AND actor_membership.disabled_at IS NULL
                 AND actor_role.role_key = 'owner'
           )
           OR EXISTS (
               SELECT 1
               FROM public.feltus_applications app
               JOIN public.feltus_organization_memberships actor_membership
                 ON actor_membership.organization_id = app.organization_id
                AND actor_membership.user_id = auth.uid()
                AND actor_membership.status = 'active'
               JOIN public.feltus_roles actor_role ON actor_role.id = actor_membership.role_id
               WHERE app.id = p_app_id AND actor_role.role_key = 'org_owner'
           )
       )
$$;

CREATE OR REPLACE FUNCTION public.feltus_protect_last_org_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_owner_role_id UUID;
    v_would_remove_owner BOOLEAN := false;
    v_other_owners INTEGER;
    v_org_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_org_id := OLD.organization_id;
        v_owner_role_id := OLD.role_id;
        v_would_remove_owner := OLD.status = 'active';
    ELSE
        v_org_id := OLD.organization_id;
        v_owner_role_id := OLD.role_id;
        v_would_remove_owner := OLD.status = 'active'
            AND (NEW.status <> 'active' OR NEW.role_id <> OLD.role_id);
    END IF;

    IF v_would_remove_owner AND EXISTS (
        SELECT 1 FROM public.feltus_roles role
        WHERE role.id = v_owner_role_id AND role.role_key = 'org_owner'
    ) THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(v_org_id::TEXT, 0));
        SELECT count(*) INTO v_other_owners
        FROM public.feltus_organization_memberships member
        JOIN public.feltus_roles role ON role.id = member.role_id
        WHERE member.organization_id = v_org_id
          AND member.status = 'active'
          AND role.role_key = 'org_owner'
          AND member.id <> OLD.id;
        IF v_other_owners = 0 THEN
            RAISE EXCEPTION 'An organization must retain at least one active owner'
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_protect_org_owner ON public.feltus_organization_memberships;
CREATE TRIGGER feltus_protect_org_owner
BEFORE UPDATE OR DELETE ON public.feltus_organization_memberships
FOR EACH ROW EXECUTE FUNCTION public.feltus_protect_last_org_owner();

CREATE OR REPLACE FUNCTION public.feltus_audit_trigger_safe()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_row JSONB;
    v_org UUID;
    v_app UUID;
    v_actor UUID;
    v_entity_id TEXT;
    v_action TEXT;
    v_entity_type TEXT;
    v_details JSONB;
BEGIN
    IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); ELSE v_row := to_jsonb(NEW); END IF;
    v_org := NULLIF(v_row ->> 'organization_id','')::UUID;
    v_app := COALESCE(NULLIF(v_row ->> 'app_id','')::UUID,
                      CASE WHEN TG_ARGV[0] = 'project' THEN NULLIF(v_row ->> 'id','')::UUID END);
    v_actor := COALESCE(
        auth.uid(), NULLIF(v_row ->> 'created_by','')::UUID,
        NULLIF(v_row ->> 'updated_by','')::UUID, NULLIF(v_row ->> 'requested_by','')::UUID,
        NULLIF(v_row ->> 'owner_id','')::UUID, NULLIF(v_row ->> 'attached_by','')::UUID
    );
    v_org := COALESCE(v_org, CASE WHEN TG_ARGV[0] = 'organization' THEN NULLIF(v_row ->> 'id','')::UUID END);
    v_entity_id := COALESCE(v_row ->> 'id', v_row ->> 'environment_id', 'unknown');
    v_entity_type := TG_ARGV[0];
    v_action := TG_ARGV[1] || CASE TG_OP WHEN 'INSERT' THEN '.created' WHEN 'UPDATE' THEN '.updated' ELSE '.deleted' END;
    v_details := CASE v_entity_type
        WHEN 'environment' THEN jsonb_build_object('name', v_row ->> 'name', 'kind', v_row ->> 'kind', 'status', v_row ->> 'status')
        WHEN 'organization' THEN jsonb_build_object('name', v_row ->> 'name', 'slug', v_row ->> 'slug')
        WHEN 'project' THEN jsonb_build_object('app_name', v_row ->> 'app_name', 'environment', v_row ->> 'environment')
        WHEN 'git_connection' THEN jsonb_build_object('provider', v_row ->> 'provider', 'account_label', v_row ->> 'account_label')
        WHEN 'project_repository' THEN jsonb_build_object('repository_id', v_row ->> 'repository_id')
        WHEN 'webhook_event' THEN jsonb_build_object('event_name', v_row ->> 'event_name', 'commit_sha', v_row ->> 'commit_sha', 'signature_verified', v_row ->> 'signature_verified', 'status', v_row ->> 'status')
        WHEN 'deployment_target' THEN jsonb_build_object('provider_key', v_row ->> 'provider_key', 'active', v_row ->> 'active')
        WHEN 'domain' THEN jsonb_build_object('domain_name', v_row ->> 'domain_name', 'tls_status', v_row ->> 'tls_status')
        WHEN 'preview' THEN jsonb_build_object('pull_request_number', v_row ->> 'pull_request_number', 'expires_at', v_row ->> 'expires_at', 'cleanup_status', v_row ->> 'cleanup_status')
        WHEN 'build' THEN jsonb_build_object('commit_sha', v_row ->> 'commit_sha', 'source_branch', v_row ->> 'source_branch', 'status', v_row ->> 'status')
        WHEN 'artifact' THEN jsonb_build_object('artifact_digest', v_row ->> 'artifact_digest', 'verification_status', v_row ->> 'verification_status')
        WHEN 'promotion' THEN jsonb_build_object('artifact_id', v_row ->> 'artifact_id', 'target_environment_id', v_row ->> 'target_environment_id', 'status', v_row ->> 'status')
        ELSE '{}'::jsonb
    END;
    INSERT INTO public.feltus_audit_events
        (organization_id, app_id, actor_user_id, actor_kind, action_key, entity_type, entity_id, after_data)
    VALUES (v_org, v_app, v_actor, CASE WHEN v_actor IS NULL THEN 'service' ELSE 'user' END,
            v_action, v_entity_type, v_entity_id, v_details);
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_environment_audit ON public.feltus_environments;
CREATE TRIGGER feltus_environment_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_environments
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('environment','environment');

DROP TRIGGER IF EXISTS feltus_organization_audit ON public.feltus_organizations;
CREATE TRIGGER feltus_organization_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_organizations
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('organization','organization');

DROP TRIGGER IF EXISTS feltus_project_audit ON public.feltus_applications;
CREATE TRIGGER feltus_project_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_applications
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('project','project');

DROP TRIGGER IF EXISTS feltus_git_connection_audit ON public.feltus_git_connections;
CREATE TRIGGER feltus_git_connection_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_git_connections
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('git_connection','git_connection');

DROP TRIGGER IF EXISTS feltus_project_repository_audit ON public.feltus_project_repositories;
CREATE TRIGGER feltus_project_repository_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_project_repositories
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('project_repository','repository_binding');

DROP TRIGGER IF EXISTS feltus_webhook_event_audit ON public.feltus_git_webhook_events;
CREATE TRIGGER feltus_webhook_event_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_git_webhook_events
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('webhook_event','git_webhook');

DROP TRIGGER IF EXISTS feltus_deployment_target_audit ON public.feltus_deployment_targets;
CREATE TRIGGER feltus_deployment_target_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_deployment_targets
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('deployment_target','deployment_target');

DROP TRIGGER IF EXISTS feltus_domain_audit ON public.feltus_deployment_domains;
CREATE TRIGGER feltus_domain_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_deployment_domains
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('domain','domain');

DROP TRIGGER IF EXISTS feltus_preview_audit ON public.feltus_preview_environments;
CREATE TRIGGER feltus_preview_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_preview_environments
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('preview','preview');

DROP TRIGGER IF EXISTS feltus_build_audit ON public.feltus_builds;
CREATE TRIGGER feltus_build_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_builds
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('build','build');

DROP TRIGGER IF EXISTS feltus_artifact_audit ON public.feltus_artifacts;
CREATE TRIGGER feltus_artifact_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_artifacts
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('artifact','artifact');

DROP TRIGGER IF EXISTS feltus_promotion_audit ON public.feltus_deployment_promotions;
CREATE TRIGGER feltus_promotion_audit
AFTER INSERT OR UPDATE OR DELETE ON public.feltus_deployment_promotions
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_trigger_safe('promotion','deployment_promotion');

-- --------------------------------------------------------------------------
-- RLS and grants. User-facing roles can read only authorized tenant metadata.
-- Ciphertext, worker queue rows, and infrastructure mutation remain behind
-- the trusted service role/functions.
-- --------------------------------------------------------------------------

ALTER TABLE public.feltus_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_rbac_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_preview_environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_git_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_project_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_repository_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_git_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_build_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_deployment_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_deployment_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_deployment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_deployment_health_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_deployment_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_environment_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_infrastructure_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feltus_organizations_member_read ON public.feltus_organizations;
CREATE POLICY feltus_organizations_member_read ON public.feltus_organizations
FOR SELECT TO authenticated USING (public.feltus_can_access_org(id, 'organization.read'));

DROP POLICY IF EXISTS feltus_rbac_permissions_read ON public.feltus_rbac_permissions;
CREATE POLICY feltus_rbac_permissions_read ON public.feltus_rbac_permissions
FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS feltus_roles_read ON public.feltus_roles;
CREATE POLICY feltus_roles_read ON public.feltus_roles
FOR SELECT TO authenticated USING (
    (scope_key = 'project' AND EXISTS (
        SELECT 1 FROM public.feltus_project_memberships membership
        WHERE membership.user_id = auth.uid() AND membership.role_id = public.feltus_roles.id AND membership.disabled_at IS NULL
    ))
    OR (scope_key = 'organization' AND EXISTS (
        SELECT 1 FROM public.feltus_organization_memberships membership
        WHERE membership.user_id = auth.uid() AND membership.role_id = public.feltus_roles.id AND membership.status = 'active'
    ))
    OR EXISTS (SELECT 1 FROM public.feltus_organization_memberships membership
               WHERE membership.user_id = auth.uid() AND membership.status = 'active')
);
DROP POLICY IF EXISTS feltus_role_permissions_read ON public.feltus_role_permissions;
CREATE POLICY feltus_role_permissions_read ON public.feltus_role_permissions
FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.feltus_roles role
    WHERE role.id = public.feltus_role_permissions.role_id AND (
        (role.scope_key = 'project' AND EXISTS (
            SELECT 1 FROM public.feltus_project_memberships membership
            WHERE membership.role_id = role.id AND membership.user_id = auth.uid() AND membership.disabled_at IS NULL
        ))
        OR (role.scope_key = 'organization' AND EXISTS (
            SELECT 1 FROM public.feltus_organization_memberships membership
            WHERE membership.role_id = role.id AND membership.user_id = auth.uid() AND membership.status = 'active'
        ))
        OR EXISTS (SELECT 1 FROM public.feltus_organization_memberships membership
                   WHERE membership.user_id = auth.uid() AND membership.status = 'active')
    )
));

DROP POLICY IF EXISTS feltus_organization_memberships_read ON public.feltus_organization_memberships;
CREATE POLICY feltus_organization_memberships_read ON public.feltus_organization_memberships
FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR public.feltus_can_access_org(organization_id, 'members.read')
);
DROP POLICY IF EXISTS feltus_organization_memberships_insert ON public.feltus_organization_memberships;
CREATE POLICY feltus_organization_memberships_insert ON public.feltus_organization_memberships
FOR INSERT TO authenticated
WITH CHECK (public.feltus_can_assign_org_role(organization_id, role_id, user_id));
DROP POLICY IF EXISTS feltus_organization_memberships_update ON public.feltus_organization_memberships;
CREATE POLICY feltus_organization_memberships_update ON public.feltus_organization_memberships
FOR UPDATE TO authenticated
USING (public.feltus_can_assign_org_role(organization_id, role_id, user_id))
WITH CHECK (public.feltus_can_assign_org_role(organization_id, role_id, user_id));
DROP POLICY IF EXISTS feltus_organization_memberships_delete ON public.feltus_organization_memberships;
CREATE POLICY feltus_organization_memberships_delete ON public.feltus_organization_memberships
FOR DELETE TO authenticated
USING (public.feltus_can_assign_org_role(organization_id, role_id, user_id));

DROP POLICY IF EXISTS feltus_memberships_admin ON public.feltus_project_memberships;
DROP POLICY IF EXISTS feltus_project_membership_insert ON public.feltus_project_memberships;
CREATE POLICY feltus_project_membership_insert ON public.feltus_project_memberships
FOR INSERT TO authenticated
WITH CHECK (public.feltus_can_assign_project_role(app_id, role_id, user_id));
DROP POLICY IF EXISTS feltus_project_membership_update ON public.feltus_project_memberships;
CREATE POLICY feltus_project_membership_update ON public.feltus_project_memberships
FOR UPDATE TO authenticated
USING (public.feltus_can_assign_project_role(app_id, role_id, user_id))
WITH CHECK (public.feltus_can_assign_project_role(app_id, role_id, user_id));
DROP POLICY IF EXISTS feltus_project_membership_delete ON public.feltus_project_memberships;
CREATE POLICY feltus_project_membership_delete ON public.feltus_project_memberships
FOR DELETE TO authenticated
USING (public.feltus_can_assign_project_role(app_id, role_id, user_id));

DROP POLICY IF EXISTS feltus_environments_read ON public.feltus_environments;
CREATE POLICY feltus_environments_read ON public.feltus_environments
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'environments.read'));
DROP POLICY IF EXISTS feltus_preview_environments_read ON public.feltus_preview_environments;
CREATE POLICY feltus_preview_environments_read ON public.feltus_preview_environments
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'environments.read'));

DROP POLICY IF EXISTS feltus_git_connections_read ON public.feltus_git_connections;
CREATE POLICY feltus_git_connections_read ON public.feltus_git_connections
FOR SELECT TO authenticated USING (public.feltus_can_access_org(organization_id, 'git.read'));
DROP POLICY IF EXISTS feltus_repositories_read ON public.feltus_repositories;
CREATE POLICY feltus_repositories_read ON public.feltus_repositories
FOR SELECT TO authenticated USING (public.feltus_can_access_org(organization_id, 'git.read'));
DROP POLICY IF EXISTS feltus_project_repositories_read ON public.feltus_project_repositories;
CREATE POLICY feltus_project_repositories_read ON public.feltus_project_repositories
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'git.read'));
DROP POLICY IF EXISTS feltus_repository_branches_read ON public.feltus_repository_branches;
CREATE POLICY feltus_repository_branches_read ON public.feltus_repository_branches
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'git.read'));
DROP POLICY IF EXISTS feltus_git_webhook_events_read ON public.feltus_git_webhook_events;
CREATE POLICY feltus_git_webhook_events_read ON public.feltus_git_webhook_events
FOR SELECT TO authenticated USING (public.feltus_can_access_org(organization_id, 'git.read'));

DROP POLICY IF EXISTS feltus_builds_read ON public.feltus_builds;
CREATE POLICY feltus_builds_read ON public.feltus_builds
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'builds.read'));
DROP POLICY IF EXISTS feltus_build_steps_read ON public.feltus_build_steps;
CREATE POLICY feltus_build_steps_read ON public.feltus_build_steps
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'builds.read'));
DROP POLICY IF EXISTS feltus_artifacts_read ON public.feltus_artifacts;
CREATE POLICY feltus_artifacts_read ON public.feltus_artifacts
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'artifacts.read'));

DROP POLICY IF EXISTS feltus_deployment_targets_read ON public.feltus_deployment_targets;
CREATE POLICY feltus_deployment_targets_read ON public.feltus_deployment_targets
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'deployments.read'));
DROP POLICY IF EXISTS feltus_deployments_read ON public.feltus_deployments;
CREATE POLICY feltus_deployments_read ON public.feltus_deployments
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'deployments.read'));
DROP POLICY IF EXISTS feltus_deployment_promotions_read ON public.feltus_deployment_promotions;
CREATE POLICY feltus_deployment_promotions_read ON public.feltus_deployment_promotions
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'deployments.read'));
DROP POLICY IF EXISTS feltus_deployment_events_read ON public.feltus_deployment_events;
CREATE POLICY feltus_deployment_events_read ON public.feltus_deployment_events
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'deployments.read'));
DROP POLICY IF EXISTS feltus_deployment_health_read ON public.feltus_deployment_health_checks;
CREATE POLICY feltus_deployment_health_read ON public.feltus_deployment_health_checks
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'deployments.read'));
DROP POLICY IF EXISTS feltus_deployment_domains_read ON public.feltus_deployment_domains;
CREATE POLICY feltus_deployment_domains_read ON public.feltus_deployment_domains
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'deployments.read'));

DROP POLICY IF EXISTS feltus_environment_secret_metadata_read ON public.feltus_environment_secrets;
CREATE POLICY feltus_environment_secret_metadata_read ON public.feltus_environment_secrets
FOR SELECT TO authenticated USING (public.feltus_can_access_app(app_id, 'secrets.read'));
DROP POLICY IF EXISTS feltus_audit_events_read ON public.feltus_audit_events;
CREATE POLICY feltus_audit_events_read ON public.feltus_audit_events
FOR SELECT TO authenticated USING (
    public.feltus_can_access_org(organization_id, 'audit.read')
    OR (app_id IS NOT NULL AND public.feltus_can_access_app(app_id, 'audit.read'))
);

-- No direct browser access to encrypted values, outbox commands, or audit writes.
REVOKE ALL ON public.feltus_organizations, public.feltus_rbac_permissions,
    public.feltus_roles, public.feltus_role_permissions,
    public.feltus_organization_memberships, public.feltus_environments,
    public.feltus_preview_environments, public.feltus_git_connections,
    public.feltus_repositories, public.feltus_project_repositories, public.feltus_repository_branches,
    public.feltus_git_webhook_events, public.feltus_builds, public.feltus_build_steps,
    public.feltus_artifacts, public.feltus_deployment_targets,
    public.feltus_deployment_promotions, public.feltus_deployment_events,
    public.feltus_deployment_health_checks, public.feltus_deployment_domains,
    public.feltus_environment_secrets, public.feltus_audit_events,
    public.feltus_infrastructure_outbox FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.feltus_git_connections, public.feltus_environment_secrets,
    public.feltus_infrastructure_outbox, public.feltus_audit_events,
    public.feltus_deployment_events FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, organization_id, provider, account_label, created_by, disabled_at, created_at, updated_at)
    ON public.feltus_git_connections TO authenticated;
GRANT SELECT (id, organization_id, app_id, environment_id, name, value_fingerprint,
    created_by, updated_by, created_at, updated_at)
    ON public.feltus_environment_secrets TO authenticated;
GRANT SELECT ON public.feltus_environment_secret_metadata TO authenticated;

GRANT SELECT ON public.feltus_rbac_permissions, public.feltus_roles, public.feltus_role_permissions,
    public.feltus_organizations, public.feltus_organization_memberships,
    public.feltus_environments, public.feltus_preview_environments,
    public.feltus_repositories, public.feltus_project_repositories, public.feltus_repository_branches, public.feltus_git_webhook_events,
    public.feltus_builds, public.feltus_build_steps, public.feltus_artifacts,
    public.feltus_deployment_targets, public.feltus_deployments,
    public.feltus_deployment_promotions, public.feltus_deployment_health_checks,
    public.feltus_deployment_domains, public.feltus_audit_events,
    public.feltus_deployment_events TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.feltus_organization_memberships
    FROM PUBLIC, anon, authenticated;
GRANT INSERT (organization_id, user_id, role_id, status, invited_by, joined_at),
    UPDATE (role_id, status, invited_by, joined_at), DELETE
    ON public.feltus_organization_memberships TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.feltus_project_memberships
    FROM PUBLIC, anon, authenticated;
GRANT INSERT (app_id, user_id, role, invited_by), UPDATE (role, disabled_at, invited_by), DELETE
    ON public.feltus_project_memberships TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.feltus_project_memberships TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.feltus_organizations,
    public.feltus_organization_memberships, public.feltus_environments,
    public.feltus_preview_environments, public.feltus_git_connections,
    public.feltus_repositories, public.feltus_project_repositories, public.feltus_repository_branches,
    public.feltus_git_webhook_events, public.feltus_builds, public.feltus_build_steps,
    public.feltus_artifacts, public.feltus_deployment_targets,
    public.feltus_deployments, public.feltus_deployment_promotions,
    public.feltus_deployment_health_checks, public.feltus_deployment_domains,
    public.feltus_environment_secrets TO service_role;
GRANT SELECT ON public.feltus_rbac_permissions, public.feltus_roles, public.feltus_role_permissions
    TO service_role;
GRANT SELECT ON public.feltus_audit_events, public.feltus_deployment_events
    TO service_role;
REVOKE ALL ON public.feltus_infrastructure_outbox FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.feltus_claim_infrastructure_outbox(TEXT,INTEGER,INTEGER)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feltus_complete_infrastructure_outbox(UUID,UUID,TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feltus_retry_infrastructure_outbox(UUID,UUID,TEXT,BOOLEAN)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feltus_heartbeat_infrastructure_outbox(UUID,UUID,INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_claim_infrastructure_outbox(TEXT,INTEGER,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.feltus_complete_infrastructure_outbox(UUID,UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.feltus_retry_infrastructure_outbox(UUID,UUID,TEXT,BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.feltus_heartbeat_infrastructure_outbox(UUID,UUID,INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.feltus_ensure_personal_organization(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feltus_user_can_access_app(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feltus_can_access_app(UUID,TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_can_access_org(UUID,TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_can_assign_org_role(UUID,UUID,UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_can_assign_project_role(UUID,UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feltus_user_can_access_app(UUID,UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_access_app(UUID,TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_access_org(UUID,TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_assign_org_role(UUID,UUID,UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_can_assign_project_role(UUID,UUID,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.feltus_create_organization(p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_user UUID := auth.uid();
    v_name TEXT := trim(COALESCE(p_name, ''));
    v_slug TEXT;
    v_org_id UUID;
    v_role_id UUID;
BEGIN
    IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
    IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Invalid organization name' USING ERRCODE = '22023'; END IF;
    v_slug := regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g');
    v_slug := COALESCE(NULLIF(trim(both '-' from left(v_slug, 48)), ''), 'org')
              || '-' || substr(replace(gen_random_uuid()::TEXT, '-', ''), 1, 8);
    INSERT INTO public.feltus_organizations (name, slug, created_by)
    VALUES (v_name, v_slug, v_user) RETURNING id INTO v_org_id;
    SELECT id INTO STRICT v_role_id FROM public.feltus_roles
    WHERE scope_key = 'organization' AND role_key = 'org_owner';
    INSERT INTO public.feltus_organization_memberships
        (organization_id, user_id, role_id, status, joined_at)
    VALUES (v_org_id, v_user, v_role_id, 'active', now());
    RETURN v_org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.feltus_create_organization(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feltus_create_organization(TEXT) TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.feltus_deployments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.feltus_deployments TO authenticated;

NOTIFY pgrst, 'reload schema';
