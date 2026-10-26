-- ============================================================
-- FELTUS LABS
-- PHASE 5E-1: OPERATIONAL ACTIVITY LOG
-- Immutable project-scoped operational telemetry
-- ============================================================

CREATE TABLE IF NOT EXISTS public.feltus_activity_log (
    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    app_id UUID NULL
        REFERENCES public.feltus_applications(id)
        ON DELETE SET NULL,

    owner_id UUID NOT NULL,

    event_type TEXT NOT NULL,

    event_source TEXT NOT NULL,

    severity TEXT NOT NULL
        DEFAULT 'info'
        CHECK (
            severity IN (
                'info',
                'success',
                'warning',
                'error'
            )
        ),

    resource_type TEXT NULL,

    resource_id TEXT NULL,

    message TEXT NOT NULL,

    metadata JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    request_id UUID NULL,

    duration_ms INTEGER NULL
        CHECK (
            duration_ms IS NULL
            OR duration_ms >= 0
        ),

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT now()
);


CREATE INDEX IF NOT EXISTS
idx_feltus_activity_log_owner_created
ON public.feltus_activity_log(
    owner_id,
    created_at DESC
);


CREATE INDEX IF NOT EXISTS
idx_feltus_activity_log_app_created
ON public.feltus_activity_log(
    app_id,
    created_at DESC
);


CREATE INDEX IF NOT EXISTS
idx_feltus_activity_log_event_type
ON public.feltus_activity_log(
    event_type,
    created_at DESC
);


ALTER TABLE public.feltus_activity_log
ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS
feltus_activity_log_select_policy
ON public.feltus_activity_log;


CREATE POLICY
feltus_activity_log_select_policy
ON public.feltus_activity_log
FOR SELECT
TO authenticated
USING (
    auth.uid() = owner_id
);


-- Logs are append-only.
-- Authenticated clients may read their logs,
-- but cannot directly INSERT / UPDATE / DELETE them.

REVOKE ALL
ON public.feltus_activity_log
FROM anon;


REVOKE INSERT, UPDATE, DELETE
ON public.feltus_activity_log
FROM authenticated;


GRANT SELECT
ON public.feltus_activity_log
TO authenticated;


-- ============================================================
-- CONTROLLED EVENT WRITER
-- ============================================================

CREATE OR REPLACE FUNCTION
public.feltus_log_event(
    p_event_type TEXT,
    p_event_source TEXT,
    p_message TEXT,
    p_app_id UUID DEFAULT NULL,
    p_severity TEXT DEFAULT 'info',
    p_resource_type TEXT DEFAULT NULL,
    p_resource_id TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb,
    p_request_id UUID DEFAULT NULL,
    p_duration_ms INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID;
    v_id UUID;
    v_severity TEXT;
BEGIN

    v_owner := auth.uid();


    IF v_owner IS NULL THEN
        RAISE EXCEPTION
            'Authentication required'
            USING ERRCODE = '42501';
    END IF;


    IF p_event_type IS NULL
       OR length(trim(p_event_type)) = 0
       OR length(p_event_type) > 80
    THEN
        RAISE EXCEPTION
            'Invalid event type';
    END IF;


    IF p_event_source IS NULL
       OR length(trim(p_event_source)) = 0
       OR length(p_event_source) > 80
    THEN
        RAISE EXCEPTION
            'Invalid event source';
    END IF;


    IF p_message IS NULL
       OR length(trim(p_message)) = 0
       OR length(p_message) > 1000
    THEN
        RAISE EXCEPTION
            'Invalid log message';
    END IF;


    v_severity :=
        lower(
            trim(
                COALESCE(
                    p_severity,
                    'info'
                )
            )
        );


    IF v_severity NOT IN (
        'info',
        'success',
        'warning',
        'error'
    ) THEN
        RAISE EXCEPTION
            'Invalid severity';
    END IF;


    IF p_duration_ms IS NOT NULL
       AND p_duration_ms < 0
    THEN
        RAISE EXCEPTION
            'Duration cannot be negative';
    END IF;


    IF p_app_id IS NOT NULL THEN

        IF NOT EXISTS (
            SELECT 1
            FROM public.feltus_applications
            WHERE id = p_app_id
              AND owner_id = v_owner
        ) THEN
            RAISE EXCEPTION
                'Application unavailable or not owned by current identity'
                USING ERRCODE = '42501';
        END IF;

    END IF;


    v_id :=
        gen_random_uuid();


    INSERT INTO public.feltus_activity_log (
        id,
        app_id,
        owner_id,
        event_type,
        event_source,
        severity,
        resource_type,
        resource_id,
        message,
        metadata,
        request_id,
        duration_ms
    )
    VALUES (
        v_id,
        p_app_id,
        v_owner,
        trim(p_event_type),
        trim(p_event_source),
        v_severity,
        NULLIF(trim(p_resource_type), ''),
        NULLIF(trim(p_resource_id), ''),
        trim(p_message),
        COALESCE(
            p_metadata,
            '{}'::jsonb
        ),
        p_request_id,
        p_duration_ms
    );


    RETURN jsonb_build_object(
        'id',
        v_id,
        'logged',
        TRUE
    );

END;
$$;


REVOKE ALL
ON FUNCTION public.feltus_log_event(
    TEXT,
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    JSONB,
    UUID,
    INTEGER
)
FROM PUBLIC;


GRANT EXECUTE
ON FUNCTION public.feltus_log_event(
    TEXT,
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    JSONB,
    UUID,
    INTEGER
)
TO authenticated;


NOTIFY pgrst, 'reload schema';
