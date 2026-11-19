CREATE TABLE IF NOT EXISTS public.feltus_app_backups (
    id UUID PRIMARY KEY,
    app_id UUID NOT NULL REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL,
    organization_id UUID,
    backup_kind TEXT NOT NULL DEFAULT 'customer'
        CHECK (backup_kind IN ('customer', 'safety_snapshot')),
    status TEXT NOT NULL DEFAULT 'creating'
        CHECK (status IN ('creating', 'available', 'failed')),
    storage_reference TEXT,
    manifest_version INTEGER,
    manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    checksum TEXT,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    restore_eligible BOOLEAN NOT NULL DEFAULT false,
    restore_status TEXT NOT NULL DEFAULT 'not_started'
        CHECK (restore_status IN ('not_started', 'restoring', 'succeeded', 'failed')),
    restore_started_at TIMESTAMPTZ,
    restore_completed_at TIMESTAMPTZ,
    restore_failure_code TEXT,
    restore_failure_message TEXT,
    safety_backup_id UUID REFERENCES public.feltus_app_backups(id) ON DELETE CASCADE,
    failure_code TEXT,
    failure_message TEXT,
    CONSTRAINT feltus_app_backups_manifest_version_check
        CHECK (manifest_version IS NULL OR manifest_version = 1),
    CONSTRAINT feltus_app_backups_checksum_check
        CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$'),
    CONSTRAINT feltus_app_backups_failure_code_check
        CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{1,64}$'),
    CONSTRAINT feltus_app_backups_restore_failure_code_check
        CHECK (restore_failure_code IS NULL OR restore_failure_code ~ '^[A-Z0-9_]{1,64}$')
);

CREATE INDEX IF NOT EXISTS feltus_app_backups_history_idx
    ON public.feltus_app_backups(app_id, owner_id, backup_kind, created_at DESC);

ALTER TABLE public.feltus_app_backups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feltus_app_backups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feltus_app_backups TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_restore_app_data_snapshot(
    p_app_id UUID,
    p_owner_id UUID,
    p_models JSONB,
    p_documents JSONB,
    p_document_chunks JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET row_security = off
AS $$
DECLARE
    v_app_owner UUID;
    v_model JSONB;
    v_row JSONB;
    v_table_name TEXT;
    v_model_count INTEGER;
    v_seen_count INTEGER := 0;
    v_expected_columns INTEGER;
    v_row_columns INTEGER;
    v_index INTEGER;
    v_document JSONB;
BEGIN
    IF p_app_id IS NULL OR p_owner_id IS NULL
       OR jsonb_typeof(p_models) <> 'array'
       OR jsonb_typeof(p_documents) <> 'array'
       OR jsonb_typeof(p_document_chunks) <> 'array' THEN
        RAISE EXCEPTION 'Invalid app data snapshot' USING ERRCODE = '22023';
    END IF;

    SELECT owner_id INTO v_app_owner
      FROM public.feltus_applications
     WHERE id = p_app_id
       AND lifecycle_status = 'active'
     FOR UPDATE;
    IF NOT FOUND OR v_app_owner <> p_owner_id THEN
        RAISE EXCEPTION 'Application owner mismatch' USING ERRCODE = '42501';
    END IF;

    SELECT count(*) INTO v_model_count
      FROM public.feltus_models
     WHERE app_id = p_app_id AND owner_id = p_owner_id;
    IF jsonb_array_length(p_models) <> v_model_count THEN
        RAISE EXCEPTION 'Application model set changed' USING ERRCODE = '55000';
    END IF;

    FOR v_model IN SELECT value FROM jsonb_array_elements(p_models)
    LOOP
        v_table_name := v_model->>'physical_table_name';
        IF jsonb_typeof(v_model) <> 'object'
           OR jsonb_typeof(v_model->'rows') <> 'array'
           OR v_table_name !~ '^fm_[0-9a-f]{8}_[a-z][a-z0-9_]{0,39}$'
           OR NOT EXISTS (
               SELECT 1 FROM public.feltus_models
                WHERE id = (v_model->>'id')::UUID
                  AND app_id = p_app_id
                  AND owner_id = p_owner_id
                  AND physical_table_name = v_table_name
           ) THEN
            RAISE EXCEPTION 'Application model snapshot is invalid' USING ERRCODE = '55000';
        END IF;
        v_seen_count := v_seen_count + 1;
        IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_models)) <> v_seen_count THEN
            RAISE EXCEPTION 'Application model snapshot is duplicated' USING ERRCODE = '55000';
        END IF;

        SELECT count(*) INTO v_expected_columns
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = v_table_name;
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_model->'rows')
        LOOP
            IF jsonb_typeof(v_row) <> 'object'
               OR NOT (v_row ? 'id')
               OR NOT (v_row ? 'owner_id')
               OR (SELECT count(*) FROM jsonb_object_keys(v_row)) <> v_expected_columns THEN
                RAISE EXCEPTION 'Application model row is invalid' USING ERRCODE = '22023';
            END IF;
            SELECT count(*) INTO v_row_columns
              FROM jsonb_object_keys(v_row) AS row_keys(key_name)
              JOIN information_schema.columns column_info
                ON column_info.table_schema = 'public'
               AND column_info.table_name = v_table_name
               AND column_info.column_name = key_name;
            IF v_row_columns <> v_expected_columns THEN
                RAISE EXCEPTION 'Application model row schema changed' USING ERRCODE = '55000';
            END IF;
        END LOOP;
    END LOOP;

    FOR v_document IN SELECT value FROM jsonb_array_elements(p_documents)
    LOOP
        IF (v_document->>'app_id')::UUID <> p_app_id
           OR (v_document->>'owner_id')::UUID <> p_owner_id
           OR v_document->>'storage_key' <> (p_app_id::TEXT || '/' || (v_document->>'stored_name'))
           OR v_document->>'stored_name' !~ '^[0-9a-fA-F-]{36}\.[a-z0-9]{1,10}$'
           OR v_document->>'sha256' !~ '^[0-9a-f]{64}$' THEN
            RAISE EXCEPTION 'Application document snapshot is invalid' USING ERRCODE = '22023';
        END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_documents)) <> jsonb_array_length(p_documents)
       OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_document_chunks) AS chunk(value)
            WHERE (chunk.value->>'app_id')::UUID <> p_app_id
               OR (chunk.value->>'owner_id')::UUID <> p_owner_id
               OR NOT EXISTS (
                   SELECT 1 FROM jsonb_array_elements(p_documents) AS document(value)
                    WHERE document.value->>'id' = chunk.value->>'document_id'
               )
       ) THEN
        RAISE EXCEPTION 'Application document snapshot is invalid' USING ERRCODE = '22023';
    END IF;

    LOCK TABLE public.feltus_document_chunks, public.feltus_documents IN SHARE ROW EXCLUSIVE MODE;
    FOR v_table_name IN
        SELECT value->>'physical_table_name'
          FROM jsonb_array_elements(p_models)
         ORDER BY value->>'physical_table_name'
    LOOP
        EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE', v_table_name);
    END LOOP;

    DELETE FROM public.feltus_document_chunks WHERE app_id = p_app_id AND owner_id = p_owner_id;
    DELETE FROM public.feltus_documents WHERE app_id = p_app_id AND owner_id = p_owner_id;

    FOR v_model IN SELECT value FROM jsonb_array_elements(p_models)
    LOOP
        v_table_name := v_model->>'physical_table_name';
        EXECUTE format('DELETE FROM public.%I WHERE id IS NOT NULL', v_table_name);
    END LOOP;

    INSERT INTO public.feltus_documents
    SELECT * FROM jsonb_populate_recordset(NULL::public.feltus_documents, p_documents);

    INSERT INTO public.feltus_document_chunks
    SELECT * FROM jsonb_populate_recordset(NULL::public.feltus_document_chunks, p_document_chunks);

    IF jsonb_array_length(p_models) > 0 THEN
        FOR v_index IN REVERSE jsonb_array_length(p_models) - 1 .. 0
        LOOP
            v_model := p_models->v_index;
            v_table_name := v_model->>'physical_table_name';
            EXECUTE format(
                'INSERT INTO public.%I SELECT * FROM jsonb_populate_recordset(NULL::public.%I, $1)',
                v_table_name,
                v_table_name
            ) USING v_model->'rows';
        END LOOP;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.feltus_restore_app_data_snapshot(UUID, UUID, JSONB, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_restore_app_data_snapshot(UUID, UUID, JSONB, JSONB, JSONB)
    TO service_role;

CREATE OR REPLACE FUNCTION public.feltus_remove_app_backups_after_cleanup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
    IF OLD.lifecycle_status IS DISTINCT FROM 'cleanup_complete'
       AND NEW.lifecycle_status = 'cleanup_complete'
       AND current_setting('feltus.lifecycle_internal', true) = 'on'
       AND COALESCE(auth.role(), '') = 'service_role' THEN
        DELETE FROM public.feltus_app_backups WHERE app_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_remove_app_backups_after_cleanup
    ON public.feltus_applications;
CREATE TRIGGER feltus_remove_app_backups_after_cleanup
    AFTER UPDATE OF lifecycle_status ON public.feltus_applications
    FOR EACH ROW
    EXECUTE FUNCTION public.feltus_remove_app_backups_after_cleanup();

NOTIFY pgrst, 'reload schema';
