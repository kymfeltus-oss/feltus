-- FELTUS team-account foundation.
-- Reuses the existing organizations as workspaces and organization memberships
-- as workspace members. This migration is additive and does not alter build,
-- artifact, Blueprint, deployment, GHCR, or Coolify records.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --------------------------------------------------------------------------
-- Complete the workspace permission catalog without changing any existing
-- deployment RPC. The new production permission is reserved for future team
-- authorization checks and is not consumed by the Phase 3 delivery engine.
-- --------------------------------------------------------------------------

INSERT INTO public.feltus_rbac_permissions (permission_key, description) VALUES
    ('billing.manage', 'Manage workspace billing.'),
    ('ownership.transfer', 'Transfer workspace ownership.'),
    ('workspace.delete', 'Delete a workspace through an explicit workflow.'),
    ('deployments.production', 'Request a production deployment when the project workflow allows it.')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO public.feltus_role_permissions (role_id, permission_key)
SELECT role.id, permission.permission_key
FROM public.feltus_roles role
CROSS JOIN unnest(ARRAY[
    'billing.manage', 'ownership.transfer', 'workspace.delete', 'deployments.production'
]::TEXT[]) AS permission(permission_key)
WHERE role.scope_key = 'organization' AND role.role_key = 'org_owner'
ON CONFLICT DO NOTHING;

INSERT INTO public.feltus_role_permissions (role_id, permission_key)
SELECT role.id, 'deployments.production'
FROM public.feltus_roles role
WHERE (role.scope_key = 'organization' AND role.role_key = 'org_admin')
   OR (role.scope_key = 'project' AND role.role_key IN ('owner', 'admin'))
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------------------------
-- Invitation records store only a SHA-256 token hash. The one-time plaintext
-- token is returned by the server to the authorized inviter and is never
-- persisted in PostgreSQL.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feltus_workspace_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.feltus_organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL CHECK (
        email = lower(trim(email))
        AND char_length(email) BETWEEN 3 AND 320
        AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
    role_id UUID NOT NULL,
    scope_key TEXT NOT NULL DEFAULT 'organization' CHECK (scope_key = 'organization'),
    invited_by_user_id UUID NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    accepted_by_user_id UUID,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (role_id, scope_key) REFERENCES public.feltus_roles(id, scope_key),
    CHECK (accepted_at IS NULL OR revoked_at IS NULL),
    CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS feltus_workspace_invitations_active_email_uq
    ON public.feltus_workspace_invitations (organization_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS feltus_workspace_invitations_expiry_idx
    ON public.feltus_workspace_invitations (expires_at)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Every existing authenticated account receives a personal default workspace.
-- Existing app owners were already backfilled by the deployment-control-plane
-- migration; this expands the same idempotent helper to accounts without apps.
DO $$
DECLARE
    v_user_id UUID;
BEGIN
    FOR v_user_id IN SELECT id FROM auth.users
    LOOP
        PERFORM public.feltus_ensure_personal_organization(v_user_id);
    END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.feltus_create_default_workspace_for_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM public.feltus_ensure_personal_organization(NEW.id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_auth_user_default_workspace ON auth.users;
CREATE TRIGGER feltus_auth_user_default_workspace
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.feltus_create_default_workspace_for_user();

-- --------------------------------------------------------------------------
-- Central, authoritative workspace/application authorization helpers.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.feltus_user_has_workspace_permission(
    p_organization_id UUID,
    p_user_id UUID,
    p_permission TEXT
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
        FROM public.feltus_organization_memberships membership
        JOIN public.feltus_roles role ON role.id = membership.role_id
        JOIN public.feltus_role_permissions permission ON permission.role_id = role.id
        WHERE membership.organization_id = p_organization_id
          AND membership.user_id = p_user_id
          AND membership.status = 'active'
          AND role.scope_key = 'organization'
          AND permission.permission_key = p_permission
    )
$$;

CREATE OR REPLACE FUNCTION public.feltus_can_manage_workspace(p_organization_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$ SELECT public.feltus_user_has_workspace_permission(p_organization_id, auth.uid(), 'organization.manage') $$;

CREATE OR REPLACE FUNCTION public.feltus_can_manage_people(p_organization_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$ SELECT public.feltus_user_has_workspace_permission(p_organization_id, auth.uid(), 'members.manage') $$;

CREATE OR REPLACE FUNCTION public.feltus_can_create_app(p_organization_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$ SELECT public.feltus_user_has_workspace_permission(p_organization_id, auth.uid(), 'projects.write') $$;

CREATE OR REPLACE FUNCTION public.feltus_can_edit_app(p_app_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$ SELECT public.feltus_user_can_access_app(p_app_id, auth.uid(), 'write') $$;

CREATE OR REPLACE FUNCTION public.feltus_can_deploy_staging(p_app_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$ SELECT public.feltus_user_can_access_app(p_app_id, auth.uid(), 'deployments.create') $$;

CREATE OR REPLACE FUNCTION public.feltus_can_deploy_production(p_app_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$ SELECT public.feltus_user_can_access_app(p_app_id, auth.uid(), 'deployments.production') $$;

CREATE OR REPLACE FUNCTION public.feltus_can_view_resource(p_app_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$ SELECT public.feltus_user_can_access_app(p_app_id, auth.uid(), 'read') $$;

CREATE OR REPLACE FUNCTION public.feltus_can_edit_resource(p_app_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public SET row_security = off
AS $$ SELECT public.feltus_user_can_access_app(p_app_id, auth.uid(), 'write') $$;

-- Direct membership DML may never assign or mutate an owner. Owner changes go
-- through feltus_transfer_workspace_ownership so they are explicit and audited.
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
       AND public.feltus_user_has_workspace_permission(
            p_organization_id, auth.uid(), 'members.manage'
       )
       AND EXISTS (
           SELECT 1
           FROM public.feltus_roles target_role
           WHERE target_role.id = p_role_id
             AND target_role.scope_key = 'organization'
             AND target_role.role_key IN ('org_admin', 'org_member', 'org_viewer')
       )
       AND NOT EXISTS (
           SELECT 1
           FROM public.feltus_organization_memberships target_membership
           JOIN public.feltus_roles existing_role ON existing_role.id = target_membership.role_id
           WHERE target_membership.organization_id = p_organization_id
             AND target_membership.user_id = p_target_user_id
             AND target_membership.status = 'active'
             AND existing_role.role_key = 'org_owner'
       )
$$;

-- Workspace-aware policies preserve current owner access while allowing only
-- explicitly authorized workspace/project members to read or change an app.
DROP POLICY IF EXISTS app_owner_isolation_policy ON public.feltus_applications;
DROP POLICY IF EXISTS app_member_read_policy ON public.feltus_applications;
DROP POLICY IF EXISTS feltus_applications_workspace_read ON public.feltus_applications;
CREATE POLICY feltus_applications_workspace_read ON public.feltus_applications
FOR SELECT TO authenticated USING (public.feltus_can_view_resource(id));
DROP POLICY IF EXISTS feltus_applications_workspace_insert ON public.feltus_applications;
CREATE POLICY feltus_applications_workspace_insert ON public.feltus_applications
FOR INSERT TO authenticated WITH CHECK (
    owner_id = auth.uid() AND public.feltus_can_create_app(organization_id)
);
DROP POLICY IF EXISTS feltus_applications_workspace_update ON public.feltus_applications;
CREATE POLICY feltus_applications_workspace_update ON public.feltus_applications
FOR UPDATE TO authenticated
USING (public.feltus_can_edit_app(id))
WITH CHECK (public.feltus_can_edit_app(id));
DROP POLICY IF EXISTS feltus_applications_workspace_delete ON public.feltus_applications;
CREATE POLICY feltus_applications_workspace_delete ON public.feltus_applications
FOR DELETE TO authenticated USING (public.feltus_can_access_app(id, 'admin'));

ALTER TABLE public.feltus_workspace_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feltus_workspace_invitations_manage_read ON public.feltus_workspace_invitations;
CREATE POLICY feltus_workspace_invitations_manage_read ON public.feltus_workspace_invitations
FOR SELECT TO authenticated USING (public.feltus_can_manage_people(organization_id));

-- --------------------------------------------------------------------------
-- Auditable invitation lifecycle.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.feltus_audit_workspace_invitation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_action TEXT;
    v_actor UUID;
BEGIN
    v_actor := COALESCE(auth.uid(), NEW.invited_by_user_id);
    v_action := CASE
        WHEN TG_OP = 'INSERT' THEN 'member.invited'
        WHEN OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN 'invitation.accepted'
        WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN 'invitation.revoked'
        ELSE 'invitation.updated'
    END;
    INSERT INTO public.feltus_audit_events (
        organization_id, actor_user_id, actor_kind, action_key,
        entity_type, entity_id, before_data, after_data
    ) VALUES (
        NEW.organization_id,
        v_actor,
        CASE WHEN v_actor IS NULL THEN 'system' ELSE 'user' END,
        v_action,
        'workspace_invitation',
        NEW.id::TEXT,
        CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object(
            'accepted_at', OLD.accepted_at, 'revoked_at', OLD.revoked_at
        ) ELSE '{}'::jsonb END,
        jsonb_build_object(
            'email_sha256', encode(digest(lower(NEW.email), 'sha256'), 'hex'),
            'role_id', NEW.role_id,
            'expires_at', NEW.expires_at,
            'accepted_at', NEW.accepted_at,
            'revoked_at', NEW.revoked_at
        )
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_workspace_invitation_audit ON public.feltus_workspace_invitations;
CREATE TRIGGER feltus_workspace_invitation_audit
AFTER INSERT OR UPDATE ON public.feltus_workspace_invitations
FOR EACH ROW EXECUTE FUNCTION public.feltus_audit_workspace_invitation();

-- Use precise team action names in the existing append-only audit stream.
CREATE OR REPLACE FUNCTION public.feltus_audit_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_row JSONB;
    v_old JSONB := '{}'::jsonb;
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
        v_action := 'member.removed';
    ELSE
        v_row := to_jsonb(NEW);
        IF TG_OP = 'INSERT' THEN
            v_action := 'member.added';
        ELSE
            v_old := jsonb_build_object(
                'role_id', to_jsonb(OLD) -> 'role_id',
                'status', COALESCE(to_jsonb(OLD) ->> 'status', CASE WHEN to_jsonb(OLD) ->> 'disabled_at' IS NULL THEN 'active' ELSE 'disabled' END)
            );
            v_action := CASE
                WHEN NEW.role_id IS DISTINCT FROM OLD.role_id THEN 'member.role_changed'
                WHEN COALESCE(to_jsonb(NEW) ->> 'status', to_jsonb(NEW) ->> 'disabled_at')
                     IS DISTINCT FROM COALESCE(to_jsonb(OLD) ->> 'status', to_jsonb(OLD) ->> 'disabled_at')
                    THEN 'member.status_changed'
                ELSE 'membership.updated'
            END;
        END IF;
    END IF;
    v_org_id := NULLIF(v_row ->> 'organization_id','')::UUID;
    v_app_id := NULLIF(v_row ->> 'app_id','')::UUID;
    v_user_id := NULLIF(v_row ->> 'user_id','')::UUID;
    v_role_id := NULLIF(v_row ->> 'role_id','')::UUID;
    v_actor := COALESCE(v_actor, NULLIF(v_row ->> 'invited_by','')::UUID);
    INSERT INTO public.feltus_audit_events (
        organization_id, app_id, actor_user_id, actor_kind, action_key,
        entity_type, entity_id, before_data, after_data
    ) VALUES (
        v_org_id, v_app_id, v_actor,
        CASE WHEN v_actor IS NULL THEN 'service' ELSE 'user' END,
        v_action,
        CASE WHEN v_app_id IS NOT NULL THEN 'project_member' ELSE 'organization_member' END,
        v_org_id::TEXT || ':' || COALESCE(v_app_id::TEXT || ':', '') || v_user_id::TEXT,
        v_old,
        jsonb_build_object(
            'role_id', v_role_id,
            'status', COALESCE(v_row ->> 'status', CASE WHEN v_row ->> 'disabled_at' IS NULL THEN 'active' ELSE 'disabled' END)
        )
    );
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

-- --------------------------------------------------------------------------
-- Invitation and member-management RPCs. Each function rechecks permissions
-- inside PostgreSQL; the browser/API cannot authorize these operations alone.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.feltus_create_workspace_invitation(
    p_organization_id UUID,
    p_email TEXT,
    p_role_key TEXT,
    p_token_hash TEXT,
    p_expires_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_actor UUID := auth.uid();
    v_email TEXT := lower(trim(COALESCE(p_email, '')));
    v_role_id UUID;
    v_invitation public.feltus_workspace_invitations;
BEGIN
    IF v_actor IS NULL OR NOT public.feltus_user_has_workspace_permission(
        p_organization_id, v_actor, 'members.manage'
    ) THEN
        RAISE EXCEPTION 'You do not have permission to invite workspace members' USING ERRCODE = '42501';
    END IF;
    IF v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR char_length(v_email) > 320 THEN
        RAISE EXCEPTION 'Enter a valid email address' USING ERRCODE = '22023';
    END IF;
    IF p_token_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Invitation token hash is invalid' USING ERRCODE = '22023';
    END IF;
    IF p_expires_at <= now() OR p_expires_at > now() + interval '30 days' THEN
        RAISE EXCEPTION 'Invitation expiry must be within 30 days' USING ERRCODE = '22023';
    END IF;
    SELECT id INTO v_role_id
    FROM public.feltus_roles
    WHERE scope_key = 'organization'
      AND role_key = p_role_key
      AND role_key IN ('org_admin', 'org_member', 'org_viewer');
    IF v_role_id IS NULL THEN
        RAISE EXCEPTION 'Owner invitations require the ownership-transfer workflow' USING ERRCODE = '42501';
    END IF;

    UPDATE public.feltus_workspace_invitations
    SET revoked_at = now(), updated_at = now()
    WHERE organization_id = p_organization_id
      AND email = v_email
      AND accepted_at IS NULL
      AND revoked_at IS NULL
      AND expires_at <= now();

    INSERT INTO public.feltus_workspace_invitations (
        organization_id, email, role_id, invited_by_user_id, token_hash, expires_at
    ) VALUES (
        p_organization_id, v_email, v_role_id, v_actor, p_token_hash, p_expires_at
    ) RETURNING * INTO v_invitation;

    RETURN jsonb_build_object(
        'id', v_invitation.id,
        'workspace_id', v_invitation.organization_id,
        'email', v_invitation.email,
        'role', replace(p_role_key, 'org_', ''),
        'expires_at', v_invitation.expires_at,
        'created_at', v_invitation.created_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_accept_workspace_invitation(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_user UUID := auth.uid();
    v_email TEXT := lower(COALESCE(auth.jwt() ->> 'email', ''));
    v_invitation public.feltus_workspace_invitations;
    v_existing_role TEXT;
    v_membership public.feltus_organization_memberships;
BEGIN
    IF v_user IS NULL OR v_email = '' THEN
        RAISE EXCEPTION 'Please sign in with the invited email address' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_invitation
    FROM public.feltus_workspace_invitations
    WHERE token_hash = p_token_hash
      AND accepted_at IS NULL
      AND revoked_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'This invitation is invalid or has already been used' USING ERRCODE = '22023';
    END IF;
    IF v_invitation.expires_at <= now() THEN
        RAISE EXCEPTION 'This invitation has expired' USING ERRCODE = '22023';
    END IF;
    IF v_invitation.email <> v_email THEN
        RAISE EXCEPTION 'Sign in with the email address that received this invitation' USING ERRCODE = '42501';
    END IF;

    SELECT role.role_key INTO v_existing_role
    FROM public.feltus_organization_memberships membership
    JOIN public.feltus_roles role ON role.id = membership.role_id
    WHERE membership.organization_id = v_invitation.organization_id
      AND membership.user_id = v_user
      AND membership.status = 'active';
    IF v_existing_role = 'org_owner' THEN
        RAISE EXCEPTION 'An owner role cannot be changed through an invitation' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.feltus_organization_memberships (
        organization_id, user_id, role_id, status, invited_by, joined_at
    ) VALUES (
        v_invitation.organization_id, v_user, v_invitation.role_id,
        'active', v_invitation.invited_by_user_id, now()
    )
    ON CONFLICT (organization_id, user_id) DO UPDATE
       SET role_id = EXCLUDED.role_id,
           status = 'active',
           invited_by = EXCLUDED.invited_by,
           joined_at = COALESCE(public.feltus_organization_memberships.joined_at, now()),
           updated_at = now()
    RETURNING * INTO v_membership;

    UPDATE public.feltus_workspace_invitations
    SET accepted_at = now(), accepted_by_user_id = v_user, updated_at = now()
    WHERE id = v_invitation.id
      AND accepted_at IS NULL
      AND revoked_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'This invitation has already been used' USING ERRCODE = '22023';
    END IF;

    RETURN jsonb_build_object(
        'workspace_id', v_membership.organization_id,
        'user_id', v_membership.user_id,
        'status', v_membership.status,
        'joined_at', v_membership.joined_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_revoke_workspace_invitation(
    p_organization_id UUID,
    p_invitation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_actor UUID := auth.uid();
    v_invitation public.feltus_workspace_invitations;
BEGIN
    IF v_actor IS NULL OR NOT public.feltus_user_has_workspace_permission(
        p_organization_id, v_actor, 'members.manage'
    ) THEN
        RAISE EXCEPTION 'You do not have permission to revoke invitations' USING ERRCODE = '42501';
    END IF;
    UPDATE public.feltus_workspace_invitations
    SET revoked_at = now(), updated_at = now()
    WHERE id = p_invitation_id
      AND organization_id = p_organization_id
      AND accepted_at IS NULL
      AND revoked_at IS NULL
    RETURNING * INTO v_invitation;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The invitation is unavailable' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('id', v_invitation.id, 'revoked_at', v_invitation.revoked_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_set_workspace_member_role(
    p_organization_id UUID,
    p_user_id UUID,
    p_role_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_actor UUID := auth.uid();
    v_role_id UUID;
    v_current_role TEXT;
    v_membership public.feltus_organization_memberships;
BEGIN
    IF v_actor IS NULL OR NOT public.feltus_user_has_workspace_permission(
        p_organization_id, v_actor, 'members.manage'
    ) THEN
        RAISE EXCEPTION 'You do not have permission to change member roles' USING ERRCODE = '42501';
    END IF;
    SELECT role.role_key INTO v_current_role
    FROM public.feltus_organization_memberships membership
    JOIN public.feltus_roles role ON role.id = membership.role_id
    WHERE membership.organization_id = p_organization_id
      AND membership.user_id = p_user_id
      AND membership.status = 'active'
    FOR UPDATE OF membership;
    IF v_current_role IS NULL THEN
        RAISE EXCEPTION 'Workspace member not found' USING ERRCODE = '22023';
    END IF;
    IF v_current_role = 'org_owner' THEN
        RAISE EXCEPTION 'Owner changes require the ownership-transfer workflow' USING ERRCODE = '42501';
    END IF;
    SELECT id INTO v_role_id FROM public.feltus_roles
    WHERE scope_key = 'organization'
      AND role_key = p_role_key
      AND role_key IN ('org_admin', 'org_member', 'org_viewer');
    IF v_role_id IS NULL THEN
        RAISE EXCEPTION 'Choose Admin, Member, or Viewer' USING ERRCODE = '22023';
    END IF;
    UPDATE public.feltus_organization_memberships
    SET role_id = v_role_id, updated_at = now()
    WHERE organization_id = p_organization_id AND user_id = p_user_id
    RETURNING * INTO v_membership;
    RETURN jsonb_build_object(
        'workspace_id', v_membership.organization_id,
        'user_id', v_membership.user_id,
        'role', replace(p_role_key, 'org_', ''),
        'status', v_membership.status
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_remove_workspace_member(
    p_organization_id UUID,
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_actor UUID := auth.uid();
    v_current_role TEXT;
BEGIN
    IF v_actor IS NULL OR NOT public.feltus_user_has_workspace_permission(
        p_organization_id, v_actor, 'members.manage'
    ) THEN
        RAISE EXCEPTION 'You do not have permission to remove workspace members' USING ERRCODE = '42501';
    END IF;
    SELECT role.role_key INTO v_current_role
    FROM public.feltus_organization_memberships membership
    JOIN public.feltus_roles role ON role.id = membership.role_id
    WHERE membership.organization_id = p_organization_id
      AND membership.user_id = p_user_id
      AND membership.status = 'active'
    FOR UPDATE OF membership;
    IF v_current_role IS NULL THEN
        RAISE EXCEPTION 'Workspace member not found' USING ERRCODE = '22023';
    END IF;
    IF v_current_role = 'org_owner' THEN
        RAISE EXCEPTION 'An owner cannot be removed; transfer ownership first' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.feltus_organization_memberships
    WHERE organization_id = p_organization_id AND user_id = p_user_id;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_transfer_workspace_ownership(
    p_organization_id UUID,
    p_new_owner_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_actor UUID := auth.uid();
    v_owner_role_id UUID;
    v_admin_role_id UUID;
BEGIN
    IF v_actor IS NULL OR v_actor = p_new_owner_user_id THEN
        RAISE EXCEPTION 'Choose another active workspace member' USING ERRCODE = '22023';
    END IF;
    IF NOT public.feltus_user_has_workspace_permission(
        p_organization_id, v_actor, 'ownership.transfer'
    ) THEN
        RAISE EXCEPTION 'Only a workspace owner can transfer ownership' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::TEXT, 0));
    IF NOT EXISTS (
        SELECT 1 FROM public.feltus_organization_memberships
        WHERE organization_id = p_organization_id
          AND user_id = p_new_owner_user_id
          AND status = 'active'
    ) THEN
        RAISE EXCEPTION 'The new owner must be an active workspace member' USING ERRCODE = '22023';
    END IF;
    SELECT id INTO STRICT v_owner_role_id FROM public.feltus_roles
    WHERE scope_key = 'organization' AND role_key = 'org_owner';
    SELECT id INTO STRICT v_admin_role_id FROM public.feltus_roles
    WHERE scope_key = 'organization' AND role_key = 'org_admin';

    UPDATE public.feltus_organization_memberships
    SET role_id = v_owner_role_id, updated_at = now()
    WHERE organization_id = p_organization_id AND user_id = p_new_owner_user_id;
    UPDATE public.feltus_organization_memberships
    SET role_id = v_admin_role_id, updated_at = now()
    WHERE organization_id = p_organization_id AND user_id = v_actor;
    UPDATE public.feltus_organizations
    SET personal_owner_id = NULL, updated_at = now()
    WHERE id = p_organization_id;

    INSERT INTO public.feltus_audit_events (
        organization_id, actor_user_id, actor_kind, action_key,
        entity_type, entity_id, before_data, after_data
    ) VALUES (
        p_organization_id, v_actor, 'user', 'ownership.transferred',
        'workspace', p_organization_id::TEXT,
        jsonb_build_object('owner_user_id', v_actor),
        jsonb_build_object('owner_user_id', p_new_owner_user_id)
    );
    RETURN jsonb_build_object(
        'id', p_organization_id,
        'owner_user_id', p_new_owner_user_id,
        'previous_owner_user_id', v_actor
    );
END;
$$;

-- Team tables are readable only through RLS and mutable only through audited
-- RPCs. Encrypted infrastructure and deployment tables are unchanged.
REVOKE ALL ON public.feltus_workspace_invitations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.feltus_workspace_invitations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feltus_workspace_invitations TO service_role;

REVOKE ALL ON FUNCTION public.feltus_user_has_workspace_permission(UUID,UUID,TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_create_default_workspace_for_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.feltus_can_manage_workspace(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_can_manage_people(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_can_create_app(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_can_edit_app(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_can_deploy_staging(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_can_deploy_production(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_can_view_resource(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_can_edit_resource(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feltus_user_has_workspace_permission(UUID,UUID,TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_manage_workspace(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_manage_people(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_create_app(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_edit_app(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_deploy_staging(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_deploy_production(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_view_resource(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.feltus_can_edit_resource(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.feltus_create_workspace_invitation(UUID,TEXT,TEXT,TEXT,TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_accept_workspace_invitation(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_revoke_workspace_invitation(UUID,UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_set_workspace_member_role(UUID,UUID,TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_remove_workspace_member(UUID,UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_transfer_workspace_ownership(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feltus_create_workspace_invitation(UUID,TEXT,TEXT,TEXT,TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_accept_workspace_invitation(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_revoke_workspace_invitation(UUID,UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_set_workspace_member_role(UUID,UUID,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_remove_workspace_member(UUID,UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_transfer_workspace_ownership(UUID,UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
