-- Generated-app identities reuse Supabase Auth but never receive a FELTUS
-- workspace. Membership is app-scoped and is the only generated-user grant.

CREATE TABLE IF NOT EXISTS public.feltus_app_user_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    auth_identifier TEXT NOT NULL UNIQUE CHECK (auth_identifier = lower(trim(auth_identifier))),
    normalized_identifier TEXT NOT NULL CHECK (
        normalized_identifier = lower(trim(normalized_identifier))
        AND char_length(normalized_identifier) BETWEEN 3 AND 320
    ),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    disabled_at TIMESTAMPTZ,
    UNIQUE (app_id, user_id),
    UNIQUE (app_id, normalized_identifier),
    CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

ALTER TABLE public.feltus_app_user_memberships
    ADD COLUMN IF NOT EXISTS auth_identifier TEXT;
UPDATE public.feltus_app_user_memberships
   SET auth_identifier = 'u-' || replace(user_id::TEXT, '-', '') || '@generated.feltus.invalid'
 WHERE auth_identifier IS NULL;
ALTER TABLE public.feltus_app_user_memberships
    ALTER COLUMN auth_identifier SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feltus_app_user_auth_identifier_uq
    ON public.feltus_app_user_memberships (auth_identifier);

CREATE TABLE IF NOT EXISTS public.feltus_generated_app_registration_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    auth_email TEXT NOT NULL UNIQUE CHECK (auth_email = lower(trim(auth_email))),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed')),
    auth_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at TIMESTAMPTZ,
    CHECK ((status = 'consumed') = (auth_user_id IS NOT NULL AND consumed_at IS NOT NULL))
);

ALTER TABLE public.feltus_app_user_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feltus_generated_app_registration_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feltus_app_user_memberships FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.feltus_generated_app_registration_intents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feltus_app_user_memberships TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feltus_generated_app_registration_intents TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_app_user_can_access_app(p_app_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.feltus_app_user_memberships membership
        JOIN public.feltus_applications app ON app.id = membership.app_id
        WHERE membership.app_id = p_app_id
          AND membership.user_id = auth.uid()
          AND membership.status = 'active'
          AND app.lifecycle_status = 'active'
          AND COALESCE(app.setup_data->'platform_services'->'selected_service_ids', '[]'::jsonb) ? 'data_sign_in'
    )
$$;

CREATE OR REPLACE FUNCTION public.feltus_app_data_owner_or_user(p_app_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1
        FROM public.feltus_applications app
        WHERE app.id = p_app_id
          AND app.lifecycle_status = 'active'
          AND (
              app.owner_id = auth.uid()
              OR public.feltus_app_user_can_access_app(p_app_id)
          )
    )
$$;

REVOKE ALL ON FUNCTION public.feltus_app_user_can_access_app(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.feltus_app_data_owner_or_user(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feltus_app_user_can_access_app(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_app_data_owner_or_user(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.feltus_create_default_workspace_for_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_app_id UUID;
    v_registration_intent UUID;
BEGIN
    UPDATE public.feltus_generated_app_registration_intents intent
       SET status = 'consumed', auth_user_id = NEW.id, consumed_at = now()
     WHERE intent.auth_email = lower(trim(NEW.email))
       AND intent.status = 'pending'
       AND intent.created_at >= now() - interval '10 minutes'
       AND EXISTS (
           SELECT 1 FROM public.feltus_applications app
           WHERE app.id = intent.app_id
             AND app.lifecycle_status = 'active'
             AND COALESCE(app.setup_data->'platform_services'->'selected_service_ids', '[]'::jsonb) ? 'data_sign_in'
       )
    RETURNING intent.id INTO v_registration_intent;
    IF v_registration_intent IS NOT NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.raw_app_meta_data->>'feltus_identity_type' = 'generated_app'
       AND (NEW.raw_app_meta_data->>'feltus_app_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        v_app_id := (NEW.raw_app_meta_data->>'feltus_app_id')::UUID;
        IF EXISTS (
            SELECT 1 FROM public.feltus_applications app
            WHERE app.id = v_app_id
              AND app.lifecycle_status = 'active'
              AND COALESCE(app.setup_data->'platform_services'->'selected_service_ids', '[]'::jsonb) ? 'data_sign_in'
        ) THEN
            RETURN NEW;
        END IF;
    END IF;
    PERFORM public.feltus_ensure_personal_organization(NEW.id);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_guard_generated_app_auth_model()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
    IF NEW.rls_enabled IS NOT TRUE AND EXISTS (
        SELECT 1 FROM public.feltus_applications app
        WHERE app.id = NEW.app_id
          AND COALESCE(app.setup_data->'platform_services'->'selected_service_ids', '[]'::jsonb) ? 'data_sign_in'
    ) THEN
        RAISE EXCEPTION 'Row-level security is required while generated-app authentication is enabled'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_guard_generated_app_auth_model ON public.feltus_models;
CREATE TRIGGER feltus_guard_generated_app_auth_model
BEFORE INSERT OR UPDATE OF app_id, rls_enabled ON public.feltus_models
FOR EACH ROW EXECUTE FUNCTION public.feltus_guard_generated_app_auth_model();

CREATE OR REPLACE FUNCTION public.feltus_attach_generated_app_auth_model(p_app_id UUID, p_model_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_model public.feltus_models%ROWTYPE;
    v_app public.feltus_applications%ROWTYPE;
    v_constraint_name TEXT;
BEGIN
    SELECT * INTO v_app FROM public.feltus_applications WHERE id = p_app_id;
    IF NOT FOUND OR v_app.lifecycle_status <> 'active'
       OR NOT (COALESCE(v_app.setup_data->'platform_services'->'selected_service_ids', '[]'::jsonb) ? 'data_sign_in') THEN
        RAISE EXCEPTION 'Data & Sign-In must be enabled for this application' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_model FROM public.feltus_models WHERE id = p_model_id AND app_id = p_app_id;
    IF NOT FOUND OR v_model.rls_enabled IS NOT TRUE THEN
        RAISE EXCEPTION 'Row-level security must be enabled for every application data model' USING ERRCODE = '42501';
    END IF;
    IF v_model.physical_table_name !~ '^fm_[0-9a-f]{8}_[a-z][a-z0-9_]{0,39}$' THEN
        RAISE EXCEPTION 'Application data table reference is invalid' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_attribute column_row
        WHERE column_row.attrelid = format('public.%I', v_model.physical_table_name)::regclass
          AND column_row.attname = '__feltus_app_id'
          AND column_row.attnotnull
        ) AND EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = format('public.%I', v_model.physical_table_name)::regclass
          AND constraint_row.conname = 'feltus_app_scope_check'
    ) AND EXISTS (
        SELECT 1
        FROM pg_policy policy_row
        WHERE policy_row.polrelid = format('public.%I', v_model.physical_table_name)::regclass
          AND policy_row.polname = 'feltus_owner_policy'
          AND pg_get_expr(policy_row.polqual, policy_row.polrelid) LIKE '%feltus_app_data_owner_or_user%'
          AND pg_get_expr(policy_row.polqual, policy_row.polrelid) NOT LIKE '%owner_id%'
        ) AND NOT EXISTS (
                SELECT 1 FROM pg_constraint constraint_row
                WHERE constraint_row.conrelid = format('public.%I', v_model.physical_table_name)::regclass
                    AND constraint_row.conname = 'feltus_app_scope_fk'
    ) THEN
        RETURN;
    END IF;

    v_constraint_name := 'feltus_app_scope_fk';
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS __feltus_app_id UUID', v_model.physical_table_name);
    EXECUTE format('UPDATE public.%I SET __feltus_app_id = $1 WHERE __feltus_app_id IS NULL', v_model.physical_table_name) USING p_app_id;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN __feltus_app_id SET DEFAULT %L::uuid', v_model.physical_table_name, p_app_id);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN __feltus_app_id SET NOT NULL', v_model.physical_table_name);
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', v_model.physical_table_name, v_constraint_name);
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = format('public.%I', v_model.physical_table_name)::regclass
          AND constraint_row.conname = 'feltus_app_scope_check'
    ) THEN
        EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT feltus_app_scope_check CHECK (__feltus_app_id = %L::uuid)', v_model.physical_table_name, p_app_id);
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_model.physical_table_name);
    EXECUTE format('DROP POLICY IF EXISTS feltus_owner_policy ON public.%I', v_model.physical_table_name);
    EXECUTE format(
        'CREATE POLICY feltus_owner_policy ON public.%I FOR ALL TO authenticated USING (public.feltus_app_data_owner_or_user(__feltus_app_id)) WITH CHECK (public.feltus_app_data_owner_or_user(__feltus_app_id))',
        v_model.physical_table_name
    );
END;
$$;

REVOKE ALL ON FUNCTION public.feltus_attach_generated_app_auth_model(UUID, UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.feltus_attach_generated_app_auth_after_model_create()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.feltus_applications app
        WHERE app.id = NEW.app_id
          AND COALESCE(app.setup_data->'platform_services'->'selected_service_ids', '[]'::jsonb) ? 'data_sign_in'
    ) THEN
        PERFORM public.feltus_attach_generated_app_auth_model(NEW.app_id, NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_attach_generated_app_auth_after_model_create ON public.feltus_models;
CREATE CONSTRAINT TRIGGER feltus_attach_generated_app_auth_after_model_create
AFTER INSERT ON public.feltus_models
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.feltus_attach_generated_app_auth_after_model_create();

CREATE OR REPLACE FUNCTION public.feltus_enable_generated_app_auth(p_app_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_model RECORD;
    v_count INTEGER := 0;
BEGIN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
        RAISE EXCEPTION 'Service authorization required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.feltus_applications app
        WHERE app.id = p_app_id AND app.lifecycle_status = 'active'
          AND COALESCE(app.setup_data->'platform_services'->'selected_service_ids', '[]'::jsonb) ? 'data_sign_in'
    ) THEN
        RAISE EXCEPTION 'Data & Sign-In must be enabled for this application' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.feltus_models WHERE app_id = p_app_id AND rls_enabled IS NOT TRUE) THEN
        RAISE EXCEPTION 'Enable privacy protection on every data model before enabling app sign-in' USING ERRCODE = '42501';
    END IF;
    FOR v_model IN SELECT id FROM public.feltus_models WHERE app_id = p_app_id LOOP
        PERFORM public.feltus_attach_generated_app_auth_model(p_app_id, v_model.id);
        v_count := v_count + 1;
    END LOOP;
    RETURN jsonb_build_object('configured', true, 'model_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.feltus_enable_generated_app_auth(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_enable_generated_app_auth(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_generated_app_auth_configuration(p_app_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
    v_app public.feltus_applications%ROWTYPE;
    v_models JSONB;
    v_models_ready BOOLEAN;
BEGIN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
        RAISE EXCEPTION 'Service authorization required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_app FROM public.feltus_applications WHERE id = p_app_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('application_id', p_app_id, 'active', false, 'enabled', false, 'models', '[]'::jsonb);
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', model.id,
        'logical_name', model.logical_name,
        'physical_table_name', model.physical_table_name,
        'rls_enabled', model.rls_enabled,
                'auth_scoped', model.rls_enabled IS TRUE
                        AND EXISTS (
                                SELECT 1 FROM pg_attribute column_row
                                WHERE column_row.attrelid = to_regclass(format('public.%I', model.physical_table_name))
                                    AND column_row.attname = '__feltus_app_id'
                                    AND column_row.attnotnull
                        )
                        AND EXISTS (
                                SELECT 1 FROM pg_constraint constraint_row
                                WHERE constraint_row.conrelid = to_regclass(format('public.%I', model.physical_table_name))
                                    AND constraint_row.conname = 'feltus_app_scope_check'
                        )
                        AND EXISTS (
                                SELECT 1 FROM pg_policy policy_row
                                WHERE policy_row.polrelid = to_regclass(format('public.%I', model.physical_table_name))
                                    AND policy_row.polname = 'feltus_owner_policy'
                                    AND pg_get_expr(policy_row.polqual, policy_row.polrelid) LIKE '%feltus_app_data_owner_or_user%'
                        ),
        'columns', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('column_name', field.column_name) ORDER BY field.ordinal_position)
            FROM public.feltus_model_columns field WHERE field.model_id = model.id
        ), '[]'::jsonb)
    ) ORDER BY model.created_at), '[]'::jsonb)
      INTO v_models
      FROM public.feltus_models model
     WHERE model.app_id = p_app_id;
        SELECT COALESCE(bool_and(model.rls_enabled IS TRUE
                AND EXISTS (
                        SELECT 1 FROM pg_attribute column_row
                        WHERE column_row.attrelid = to_regclass(format('public.%I', model.physical_table_name))
                            AND column_row.attname = '__feltus_app_id'
                            AND column_row.attnotnull
                )
                AND EXISTS (
                        SELECT 1 FROM pg_constraint constraint_row
                        WHERE constraint_row.conrelid = to_regclass(format('public.%I', model.physical_table_name))
                            AND constraint_row.conname = 'feltus_app_scope_check'
                )
                AND EXISTS (
                        SELECT 1 FROM pg_policy policy_row
                        WHERE policy_row.polrelid = to_regclass(format('public.%I', model.physical_table_name))
                            AND policy_row.polname = 'feltus_owner_policy'
                            AND pg_get_expr(policy_row.polqual, policy_row.polrelid) LIKE '%feltus_app_data_owner_or_user%'
                )), true)
            INTO v_models_ready
            FROM public.feltus_models model
         WHERE model.app_id = p_app_id;
    RETURN jsonb_build_object(
        'application_id', p_app_id,
        'active', v_app.lifecycle_status = 'active',
        'enabled', COALESCE(v_app.setup_data->'platform_services'->'selected_service_ids', '[]'::jsonb) ? 'data_sign_in',
                'models_ready', v_models_ready,
        'models', v_models
    );
END;
$$;

REVOKE ALL ON FUNCTION public.feltus_generated_app_auth_configuration(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_generated_app_auth_configuration(UUID) TO service_role;