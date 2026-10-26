-- ============================================================
-- FELTUS LABS
-- PHASE 5F-3 — CONTROLLED PROJECT DEPLOYMENT STATE
-- ============================================================

ALTER TABLE public.feltus_applications
ADD COLUMN IF NOT EXISTS deployment_state TEXT
NOT NULL
DEFAULT 'draft';

ALTER TABLE public.feltus_applications
ADD COLUMN IF NOT EXISTS deployed_at TIMESTAMPTZ;


DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'feltus_applications_deployment_state_check'
    ) THEN

        ALTER TABLE public.feltus_applications
        ADD CONSTRAINT
            feltus_applications_deployment_state_check
        CHECK (
            deployment_state IN (
                'draft',
                'deployed'
            )
        );

    END IF;
END
$$;


CREATE OR REPLACE FUNCTION public.feltus_set_deployment_state(
    p_app_id UUID,
    p_state TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID;
    v_state TEXT;
    v_result public.feltus_applications%ROWTYPE;
BEGIN

    v_owner := auth.uid();

    IF v_owner IS NULL THEN
        RAISE EXCEPTION
            'Authentication required'
            USING ERRCODE = '42501';
    END IF;


    v_state :=
        lower(
            trim(
                coalesce(
                    p_state,
                    ''
                )
            )
        );


    IF v_state NOT IN (
        'draft',
        'deployed'
    ) THEN

        RAISE EXCEPTION
            'Invalid deployment state'
            USING ERRCODE = '22023';

    END IF;


    UPDATE public.feltus_applications

    SET
        deployment_state =
            v_state,

        deployed_at =
            CASE
                WHEN v_state = 'deployed'
                    THEN now()
                ELSE NULL
            END

    WHERE id = p_app_id
      AND owner_id = v_owner

    RETURNING *
    INTO v_result;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Project unavailable or not owned by current identity'
            USING ERRCODE = '42501';
    END IF;


    RETURN jsonb_build_object(
        'id',
        v_result.id,

        'app_name',
        v_result.app_name,

        'environment',
        v_result.environment,

        'deployment_state',
        v_result.deployment_state,

        'deployed_at',
        v_result.deployed_at
    );

END;
$$;


REVOKE ALL
ON FUNCTION public.feltus_set_deployment_state(UUID, TEXT)
FROM PUBLIC;


GRANT EXECUTE
ON FUNCTION public.feltus_set_deployment_state(UUID, TEXT)
TO authenticated;


NOTIFY pgrst, 'reload schema';
