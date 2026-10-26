-- ============================================================
-- FELTUS LABS
-- PHASE 5G-1A — PRIVATE DOCUMENT STORAGE FOUNDATION
-- ============================================================


-- ------------------------------------------------------------
-- DOCUMENT REGISTRY
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feltus_documents (

    id UUID
        PRIMARY KEY
        DEFAULT gen_random_uuid(),

    app_id UUID
        NOT NULL
        REFERENCES public.feltus_applications(id)
        ON DELETE CASCADE,

    owner_id UUID
        NOT NULL,

    original_name TEXT
        NOT NULL,

    stored_name TEXT
        NOT NULL,

    storage_key TEXT
        NOT NULL
        UNIQUE,

    mime_type TEXT
        NOT NULL
        DEFAULT 'application/octet-stream',

    size_bytes BIGINT
        NOT NULL
        CHECK (size_bytes >= 0),

    sha256 TEXT
        NOT NULL,

    processing_status TEXT
        NOT NULL
        DEFAULT 'stored',

    extraction_error TEXT,

    metadata JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT now(),

    processed_at TIMESTAMPTZ,

    CONSTRAINT feltus_documents_processing_status_check
        CHECK (
            processing_status IN (
                'stored',
                'processing',
                'ready',
                'failed'
            )
        )
);


CREATE INDEX IF NOT EXISTS
    feltus_documents_app_id_idx
ON public.feltus_documents(app_id);


CREATE INDEX IF NOT EXISTS
    feltus_documents_owner_id_idx
ON public.feltus_documents(owner_id);


CREATE INDEX IF NOT EXISTS
    feltus_documents_created_at_idx
ON public.feltus_documents(created_at DESC);


CREATE INDEX IF NOT EXISTS
    feltus_documents_sha256_idx
ON public.feltus_documents(sha256);


-- ------------------------------------------------------------
-- DOCUMENT CHUNKS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feltus_document_chunks (

    id UUID
        PRIMARY KEY
        DEFAULT gen_random_uuid(),

    document_id UUID
        NOT NULL
        REFERENCES public.feltus_documents(id)
        ON DELETE CASCADE,

    app_id UUID
        NOT NULL
        REFERENCES public.feltus_applications(id)
        ON DELETE CASCADE,

    owner_id UUID
        NOT NULL,

    chunk_index INTEGER
        NOT NULL
        CHECK (chunk_index >= 0),

    content TEXT
        NOT NULL,

    character_count INTEGER
        NOT NULL
        DEFAULT 0
        CHECK (character_count >= 0),

    metadata JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT now(),

    UNIQUE (
        document_id,
        chunk_index
    )
);


CREATE INDEX IF NOT EXISTS
    feltus_document_chunks_document_idx
ON public.feltus_document_chunks(document_id);


CREATE INDEX IF NOT EXISTS
    feltus_document_chunks_app_idx
ON public.feltus_document_chunks(app_id);


-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------

ALTER TABLE public.feltus_documents
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.feltus_document_chunks
ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS
    feltus_documents_owner_policy
ON public.feltus_documents;


CREATE POLICY feltus_documents_owner_policy
ON public.feltus_documents

FOR ALL

TO authenticated

USING (
    owner_id = auth.uid()
)

WITH CHECK (
    owner_id = auth.uid()
    AND EXISTS (
        SELECT 1
        FROM public.feltus_applications app
        WHERE app.id =
            feltus_documents.app_id
          AND app.owner_id =
            auth.uid()
    )
);


DROP POLICY IF EXISTS
    feltus_document_chunks_owner_policy
ON public.feltus_document_chunks;


CREATE POLICY feltus_document_chunks_owner_policy
ON public.feltus_document_chunks

FOR ALL

TO authenticated

USING (
    owner_id = auth.uid()
)

WITH CHECK (
    owner_id = auth.uid()

    AND EXISTS (
        SELECT 1
        FROM public.feltus_documents document
        WHERE document.id =
            feltus_document_chunks.document_id
          AND document.app_id =
            feltus_document_chunks.app_id
          AND document.owner_id =
            auth.uid()
    )
);


-- ------------------------------------------------------------
-- PERMISSIONS
-- ------------------------------------------------------------

REVOKE ALL
ON public.feltus_documents
FROM anon;

REVOKE ALL
ON public.feltus_document_chunks
FROM anon;


GRANT
    SELECT,
    INSERT,
    UPDATE,
    DELETE
ON public.feltus_documents
TO authenticated;


GRANT
    SELECT,
    INSERT,
    UPDATE,
    DELETE
ON public.feltus_document_chunks
TO authenticated;


NOTIFY pgrst, 'reload schema';
