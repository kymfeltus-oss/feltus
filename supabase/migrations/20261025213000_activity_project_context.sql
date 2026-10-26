-- ============================================================
-- FELTUS LABS
-- PHASE 5E TELEMETRY PROJECT CONTEXT HARDENING
-- ============================================================

-- Backfill historical model RLS events with their project ID.

UPDATE public.feltus_activity_log AS log
SET app_id = model.app_id
FROM public.feltus_models AS model
WHERE log.event_type = 'model.rls_changed'
  AND log.app_id IS NULL
  AND log.resource_id ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
  AND model.id = log.resource_id::uuid;


-- Return app_id when a relationship is deleted so telemetry
-- can retain project ownership after the registry row is gone.

CREATE OR REPLACE FUNCTION public.feltus_delete_relationship(
    p_relationship_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID;
    v_app_id UUID;
    v_source_table TEXT;
    v_constraint_name TEXT;
BEGIN

    v_owner := auth.uid();


    IF v_owner IS NULL THEN
        RAISE EXCEPTION
            'Authentication required'
            USING ERRCODE = '42501';
    END IF;


    SELECT
        fr.app_id,
        fm.physical_table_name,
        fr.constraint_name

    INTO
        v_app_id,
        v_source_table,
        v_constraint_name

    FROM public.feltus_model_relationships fr

    JOIN public.feltus_models fm
      ON fm.id = fr.source_model_id

    WHERE fr.id = p_relationship_id
      AND fr.owner_id = v_owner;


    IF v_source_table IS NULL THEN
        RAISE EXCEPTION
            'Relationship unavailable or not owned by current identity'
            USING ERRCODE = '42501';
    END IF;


    EXECUTE format(
        'ALTER TABLE public.%I
         DROP CONSTRAINT IF EXISTS %I',
        v_source_table,
        v_constraint_name
    );


    DELETE FROM public.feltus_model_relationships
    WHERE id = p_relationship_id
      AND owner_id = v_owner;


    RETURN jsonb_build_object(
        'id',
        p_relationship_id,

        'app_id',
        v_app_id,

        'deleted',
        TRUE
    );

END;
$$;


REVOKE ALL
ON FUNCTION public.feltus_delete_relationship(UUID)
FROM PUBLIC;


GRANT EXECUTE
ON FUNCTION public.feltus_delete_relationship(UUID)
TO authenticated;


NOTIFY pgrst, 'reload schema';
