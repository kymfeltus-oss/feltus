-- ============================================================
-- FELTUS LABS
-- PHASE 5G-2 — DOCUMENT PARSING + CHUNK PERSISTENCE
-- ============================================================


CREATE OR REPLACE FUNCTION public.feltus_replace_document_chunks(
    p_document_id UUID,
    p_chunks JSONB,
    p_document_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID;
    v_document public.feltus_documents%ROWTYPE;
    v_count INTEGER := 0;
BEGIN

    v_owner := auth.uid();

    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
        USING ERRCODE = '42501';
    END IF;


    SELECT *
    INTO v_document
    FROM public.feltus_documents
    WHERE id = p_document_id
      AND owner_id = v_owner;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Document unavailable or not owned by current identity'
        USING ERRCODE = '42501';
    END IF;


    IF jsonb_typeof(p_chunks) <> 'array' THEN
        RAISE EXCEPTION
            'Document chunks must be a JSON array'
        USING ERRCODE = '22023';
    END IF;


    UPDATE public.feltus_documents
    SET
        processing_status = 'processing',
        extraction_error = NULL
    WHERE id = p_document_id
      AND owner_id = v_owner;


    DELETE FROM public.feltus_document_chunks
    WHERE document_id = p_document_id
      AND owner_id = v_owner;


    INSERT INTO public.feltus_document_chunks (
        document_id,
        app_id,
        owner_id,
        chunk_index,
        content,
        character_count,
        metadata
    )
    SELECT
        v_document.id,
        v_document.app_id,
        v_owner,
        (entry.ordinality - 1)::INTEGER,
        entry.value ->> 'content',
        char_length(
            entry.value ->> 'content'
        ),
        coalesce(
            entry.value -> 'metadata',
            '{}'::jsonb
        )
    FROM jsonb_array_elements(
        p_chunks
    ) WITH ORDINALITY
        AS entry(value, ordinality)
    WHERE coalesce(
        trim(
            entry.value ->> 'content'
        ),
        ''
    ) <> '';


    GET DIAGNOSTICS
        v_count = ROW_COUNT;


    IF v_count = 0 THEN
        RAISE EXCEPTION
            'No valid document chunks supplied'
        USING ERRCODE = '22023';
    END IF;


    UPDATE public.feltus_documents
    SET
        processing_status = 'ready',
        extraction_error = NULL,
        processed_at = now(),
        metadata =
            metadata ||
            coalesce(
                p_document_metadata,
                '{}'::jsonb
            )
    WHERE id = p_document_id
      AND owner_id = v_owner;


    RETURN jsonb_build_object(
        'id',
        v_document.id,

        'app_id',
        v_document.app_id,

        'processing_status',
        'ready',

        'chunk_count',
        v_count,

        'processed_at',
        now()
    );

END;
$$;



CREATE OR REPLACE FUNCTION public.feltus_fail_document_processing(
    p_document_id UUID,
    p_error TEXT,
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


    SELECT *
    INTO v_document
    FROM public.feltus_documents
    WHERE id = p_document_id
      AND owner_id = v_owner;


    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Document unavailable or not owned by current identity'
        USING ERRCODE = '42501';
    END IF;


    UPDATE public.feltus_documents
    SET
        processing_status = 'failed',
        extraction_error =
            left(
                coalesce(
                    p_error,
                    'Document processing failed.'
                ),
                1000
            ),
        metadata =
            metadata ||
            coalesce(
                p_metadata,
                '{}'::jsonb
            )
    WHERE id = p_document_id
      AND owner_id = v_owner;


    RETURN jsonb_build_object(
        'id',
        v_document.id,

        'app_id',
        v_document.app_id,

        'processing_status',
        'failed'
    );

END;
$$;


REVOKE ALL
ON FUNCTION public.feltus_replace_document_chunks(
    UUID,
    JSONB,
    JSONB
)
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.feltus_fail_document_processing(
    UUID,
    TEXT,
    JSONB
)
FROM PUBLIC;


GRANT EXECUTE
ON FUNCTION public.feltus_replace_document_chunks(
    UUID,
    JSONB,
    JSONB
)
TO authenticated;

GRANT EXECUTE
ON FUNCTION public.feltus_fail_document_processing(
    UUID,
    TEXT,
    JSONB
)
TO authenticated;


NOTIFY pgrst, 'reload schema';
