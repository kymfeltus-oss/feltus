-- ============================================================
-- FELTUS LABS
-- PHASE 5G-1B — DOCUMENT REGISTRATION RPC
-- ============================================================

CREATE OR REPLACE FUNCTION public.feltus_register_document(
    p_app_id UUID,
    p_original_name TEXT,
    p_stored_name TEXT,
    p_storage_key TEXT,
    p_mime_type TEXT,
    p_size_bytes BIGINT,
    p_sha256 TEXT,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID;
    v_document public.feltus_documents%ROWTYPE;
BEGIN

    v_owner := auth.uid();

    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
        USING ERRCODE = '42501';
    END IF;


    IF NOT EXISTS (
        SELECT 1
        FROM public.feltus_applications
        WHERE id = p_app_id
          AND owner_id = v_owner
    ) THEN
        RAISE EXCEPTION 'Project unavailable or not owned by current identity'
        USING ERRCODE = '42501';
    END IF;


    IF coalesce(trim(p_original_name), '') = '' THEN
        RAISE EXCEPTION 'Document name required'
        USING ERRCODE = '22023';
    END IF;


    IF p_size_bytes < 1 THEN
        RAISE EXCEPTION 'Document must contain data'
        USING ERRCODE = '22023';
    END IF;


    INSERT INTO public.feltus_documents (
        app_id,
        owner_id,
        original_name,
        stored_name,
        storage_key,
        mime_type,
        size_bytes,
        sha256,
        processing_status,
        metadata
    )
    VALUES (
        p_app_id,
        v_owner,
        p_original_name,
        p_stored_name,
        p_storage_key,
        coalesce(
            nullif(trim(p_mime_type), ''),
            'application/octet-stream'
        ),
        p_size_bytes,
        p_sha256,
        'stored',
        coalesce(
            p_metadata,
            '{}'::jsonb
        )
    )
    RETURNING *
    INTO v_document;


    RETURN jsonb_build_object(
        'id', v_document.id,
        'app_id', v_document.app_id,
        'original_name', v_document.original_name,
        'mime_type', v_document.mime_type,
        'size_bytes', v_document.size_bytes,
        'sha256', v_document.sha256,
        'processing_status', v_document.processing_status,
        'metadata', v_document.metadata,
        'created_at', v_document.created_at,
        'processed_at', v_document.processed_at
    );

END;
$$;


REVOKE ALL
ON FUNCTION public.feltus_register_document(
    UUID,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    BIGINT,
    TEXT,
    JSONB
)
FROM PUBLIC;


GRANT EXECUTE
ON FUNCTION public.feltus_register_document(
    UUID,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    BIGINT,
    TEXT,
    JSONB
)
TO authenticated;


NOTIFY pgrst, 'reload schema';
