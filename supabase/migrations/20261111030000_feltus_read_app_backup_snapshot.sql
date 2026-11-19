CREATE OR REPLACE FUNCTION public.feltus_read_app_backup_snapshot(
    p_app_id UUID,
    p_owner_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET row_security = off
AS $$
DECLARE
    v_app_owner UUID;
    v_model RECORD;
    v_rows JSONB;
    v_models JSONB := '[]'::jsonb;
    v_columns JSONB;
    v_relationships JSONB;
    v_documents JSONB;
    v_document_chunks JSONB;
BEGIN
    IF p_app_id IS NULL OR p_owner_id IS NULL THEN
        RAISE EXCEPTION 'Invalid app backup scope' USING ERRCODE = '22023';
    END IF;

    SELECT owner_id INTO v_app_owner
      FROM public.feltus_applications
     WHERE id = p_app_id
       AND lifecycle_status = 'active';
    IF NOT FOUND OR v_app_owner <> p_owner_id THEN
        RAISE EXCEPTION 'Application owner mismatch' USING ERRCODE = '42501';
    END IF;

    FOR v_model IN
        SELECT id, app_id, owner_id, logical_name, physical_table_name, rls_enabled, created_at
          FROM public.feltus_models
         WHERE app_id = p_app_id
           AND owner_id = p_owner_id
         ORDER BY id
    LOOP
        IF v_model.physical_table_name !~ '^fm_[0-9a-f]{8}_[a-z][a-z0-9_]{0,39}$' THEN
            RAISE EXCEPTION 'Unsupported app model table' USING ERRCODE = '22023';
        END IF;
        EXECUTE format(
            'SELECT COALESCE(jsonb_agg(to_jsonb(model_row) ORDER BY model_row.id), ''[]''::jsonb) FROM public.%I AS model_row',
            v_model.physical_table_name
        ) INTO v_rows;
        v_models := v_models || jsonb_build_array(jsonb_build_object(
            'id', v_model.id,
            'app_id', v_model.app_id,
            'owner_id', v_model.owner_id,
            'logical_name', v_model.logical_name,
            'physical_table_name', v_model.physical_table_name,
            'rls_enabled', v_model.rls_enabled,
            'created_at', v_model.created_at,
            'rows', COALESCE(v_rows, '[]'::jsonb)
        ));
    END LOOP;

    SELECT COALESCE(jsonb_agg(to_jsonb(model_column) ORDER BY model_column.model_id, model_column.ordinal_position), '[]'::jsonb)
      INTO v_columns
      FROM public.feltus_model_columns AS model_column
     WHERE model_column.owner_id = p_owner_id
       AND model_column.model_id IN (
           SELECT id FROM public.feltus_models
            WHERE app_id = p_app_id AND owner_id = p_owner_id
       );

    SELECT COALESCE(jsonb_agg(to_jsonb(model_relationship) ORDER BY model_relationship.id), '[]'::jsonb)
      INTO v_relationships
      FROM public.feltus_model_relationships AS model_relationship
     WHERE model_relationship.app_id = p_app_id
       AND model_relationship.owner_id = p_owner_id;

    SELECT COALESCE(jsonb_agg(to_jsonb(document) ORDER BY document.id), '[]'::jsonb)
      INTO v_documents
      FROM public.feltus_documents AS document
     WHERE document.app_id = p_app_id
       AND document.owner_id = p_owner_id;

    SELECT COALESCE(jsonb_agg(to_jsonb(document_chunk) ORDER BY document_chunk.document_id, document_chunk.chunk_index), '[]'::jsonb)
      INTO v_document_chunks
      FROM public.feltus_document_chunks AS document_chunk
     WHERE document_chunk.app_id = p_app_id
       AND document_chunk.owner_id = p_owner_id;

    RETURN jsonb_build_object(
        'models', v_models,
        'columns', COALESCE(v_columns, '[]'::jsonb),
        'relationships', COALESCE(v_relationships, '[]'::jsonb),
        'documents', COALESCE(v_documents, '[]'::jsonb),
        'document_chunks', COALESCE(v_document_chunks, '[]'::jsonb)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.feltus_read_app_backup_snapshot(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_read_app_backup_snapshot(UUID, UUID)
    TO service_role;

NOTIFY pgrst, 'reload schema';
