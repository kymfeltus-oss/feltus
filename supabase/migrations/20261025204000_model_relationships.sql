-- ============================================================
-- FELTUS LABS
-- PHASE 5D: RELATIONSHIPS & FOREIGN KEYS
-- Controlled project-scoped relational relationships
-- ============================================================

CREATE TABLE IF NOT EXISTS public.feltus_model_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    app_id UUID NOT NULL
        REFERENCES public.feltus_applications(id)
        ON DELETE CASCADE,

    owner_id UUID NOT NULL,

    source_model_id UUID NOT NULL
        REFERENCES public.feltus_models(id)
        ON DELETE CASCADE,

    source_column TEXT NOT NULL,

    target_model_id UUID NOT NULL
        REFERENCES public.feltus_models(id)
        ON DELETE CASCADE,

    target_column TEXT NOT NULL,

    constraint_name TEXT NOT NULL UNIQUE,

    on_delete_action TEXT NOT NULL
        DEFAULT 'RESTRICT'
        CHECK (
            on_delete_action IN (
                'RESTRICT',
                'CASCADE',
                'SET NULL',
                'NO ACTION'
            )
        ),

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT timezone('utc'::text, now()),

    UNIQUE (
        source_model_id,
        source_column,
        target_model_id,
        target_column
    )
);


CREATE INDEX IF NOT EXISTS idx_feltus_relationships_app
ON public.feltus_model_relationships(
    app_id,
    owner_id
);


ALTER TABLE public.feltus_model_relationships
ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS feltus_relationships_owner_policy
ON public.feltus_model_relationships;


CREATE POLICY feltus_relationships_owner_policy
ON public.feltus_model_relationships
FOR ALL
TO authenticated
USING (
    auth.uid() = owner_id
)
WITH CHECK (
    auth.uid() = owner_id
);


REVOKE ALL
ON public.feltus_model_relationships
FROM anon;


GRANT SELECT, INSERT, UPDATE, DELETE
ON public.feltus_model_relationships
TO authenticated;


-- ============================================================
-- CREATE RELATIONSHIP
-- ============================================================

CREATE OR REPLACE FUNCTION public.feltus_create_relationship(
    p_app_id UUID,
    p_source_model_id UUID,
    p_source_column TEXT,
    p_target_model_id UUID,
    p_target_column TEXT DEFAULT 'id',
    p_on_delete TEXT DEFAULT 'RESTRICT'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID;

    v_relationship_id UUID;

    v_source_table TEXT;
    v_target_table TEXT;

    v_source_type TEXT;
    v_target_type TEXT;

    v_source_nullable TEXT;

    v_target_unique BOOLEAN;

    v_constraint_name TEXT;

    v_on_delete TEXT;
BEGIN

    v_owner := auth.uid();

    IF v_owner IS NULL THEN
        RAISE EXCEPTION
            'Authentication required'
            USING ERRCODE = '42501';
    END IF;


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


    IF p_source_model_id = p_target_model_id THEN
        RAISE EXCEPTION
            'Self-referencing relationships are not enabled in this FELTUS phase';
    END IF;


    IF p_source_column IS NULL
       OR p_source_column !~ '^[a-z][a-z0-9_]{0,39}$'
    THEN
        RAISE EXCEPTION
            'Invalid source column';
    END IF;


    IF p_target_column IS NULL
       OR p_target_column !~ '^[a-z][a-z0-9_]{0,39}$'
    THEN
        RAISE EXCEPTION
            'Invalid target column';
    END IF;


    v_on_delete :=
        upper(
            trim(
                COALESCE(
                    p_on_delete,
                    'RESTRICT'
                )
            )
        );


    IF v_on_delete NOT IN (
        'RESTRICT',
        'CASCADE',
        'SET NULL',
        'NO ACTION'
    ) THEN
        RAISE EXCEPTION
            'Unsupported ON DELETE action';
    END IF;


    SELECT physical_table_name
    INTO v_source_table
    FROM public.feltus_models
    WHERE id = p_source_model_id
      AND app_id = p_app_id
      AND owner_id = v_owner;


    IF v_source_table IS NULL THEN
        RAISE EXCEPTION
            'Source model unavailable or does not belong to this project'
            USING ERRCODE = '42501';
    END IF;


    SELECT physical_table_name
    INTO v_target_table
    FROM public.feltus_models
    WHERE id = p_target_model_id
      AND app_id = p_app_id
      AND owner_id = v_owner;


    IF v_target_table IS NULL THEN
        RAISE EXCEPTION
            'Target model unavailable or does not belong to this project'
            USING ERRCODE = '42501';
    END IF;


    SELECT
        data_type,
        is_nullable
    INTO
        v_source_type,
        v_source_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = v_source_table
      AND column_name = p_source_column;


    IF v_source_type IS NULL THEN
        RAISE EXCEPTION
            'Source column does not exist';
    END IF;


    SELECT data_type
    INTO v_target_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = v_target_table
      AND column_name = p_target_column;


    IF v_target_type IS NULL THEN
        RAISE EXCEPTION
            'Target column does not exist';
    END IF;


    IF v_source_type <> v_target_type THEN
        RAISE EXCEPTION
            'Foreign-key column types do not match: % versus %',
            v_source_type,
            v_target_type;
    END IF;


    IF v_on_delete = 'SET NULL'
       AND v_source_nullable <> 'YES'
    THEN
        RAISE EXCEPTION
            'SET NULL requires a nullable source column';
    END IF;


    SELECT EXISTS (
        SELECT 1

        FROM pg_constraint con

        JOIN pg_class tbl
          ON tbl.oid = con.conrelid

        JOIN pg_namespace ns
          ON ns.oid = tbl.relnamespace

        JOIN pg_attribute att
          ON att.attrelid = tbl.oid
         AND att.attnum = con.conkey[1]

        WHERE ns.nspname = 'public'
          AND tbl.relname = v_target_table
          AND con.contype IN ('p', 'u')
          AND array_length(con.conkey, 1) = 1
          AND att.attname = p_target_column
    )
    INTO v_target_unique;


    IF NOT v_target_unique THEN
        RAISE EXCEPTION
            'Target column must be a primary key or unique column';
    END IF;


    IF EXISTS (
        SELECT 1
        FROM public.feltus_model_relationships
        WHERE owner_id = v_owner
          AND source_model_id = p_source_model_id
          AND source_column = p_source_column
          AND target_model_id = p_target_model_id
          AND target_column = p_target_column
    ) THEN
        RAISE EXCEPTION
            'Relationship already exists';
    END IF;


    v_relationship_id :=
        gen_random_uuid();


    v_constraint_name :=
        'feltus_fk_' ||
        substring(
            replace(
                v_relationship_id::text,
                '-',
                ''
            )
            FROM 1 FOR 12
        );


    EXECUTE format(
        'ALTER TABLE public.%I
         ADD CONSTRAINT %I
         FOREIGN KEY (%I)
         REFERENCES public.%I (%I)
         ON DELETE %s',
        v_source_table,
        v_constraint_name,
        p_source_column,
        v_target_table,
        p_target_column,
        v_on_delete
    );


    INSERT INTO public.feltus_model_relationships (
        id,
        app_id,
        owner_id,
        source_model_id,
        source_column,
        target_model_id,
        target_column,
        constraint_name,
        on_delete_action
    )
    VALUES (
        v_relationship_id,
        p_app_id,
        v_owner,
        p_source_model_id,
        p_source_column,
        p_target_model_id,
        p_target_column,
        v_constraint_name,
        v_on_delete
    );


    RETURN jsonb_build_object(
        'id',
        v_relationship_id,

        'app_id',
        p_app_id,

        'source_model_id',
        p_source_model_id,

        'source_table',
        v_source_table,

        'source_column',
        p_source_column,

        'target_model_id',
        p_target_model_id,

        'target_table',
        v_target_table,

        'target_column',
        p_target_column,

        'constraint_name',
        v_constraint_name,

        'on_delete_action',
        v_on_delete
    );

END;
$$;


-- ============================================================
-- DELETE RELATIONSHIP
-- ============================================================

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
        fm.physical_table_name,
        fr.constraint_name

    INTO
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

        'deleted',
        TRUE
    );

END;
$$;


REVOKE ALL
ON FUNCTION public.feltus_create_relationship(
    UUID,
    UUID,
    TEXT,
    UUID,
    TEXT,
    TEXT
)
FROM PUBLIC;


GRANT EXECUTE
ON FUNCTION public.feltus_create_relationship(
    UUID,
    UUID,
    TEXT,
    UUID,
    TEXT,
    TEXT
)
TO authenticated;


REVOKE ALL
ON FUNCTION public.feltus_delete_relationship(
    UUID
)
FROM PUBLIC;


GRANT EXECUTE
ON FUNCTION public.feltus_delete_relationship(
    UUID
)
TO authenticated;


NOTIFY pgrst, 'reload schema';
