-- ============================================================
-- FELTUS LABS
-- FIX: Create feltus_models parent registry row before columns
-- ============================================================

CREATE OR REPLACE FUNCTION public.feltus_create_model(
    p_app_id UUID,
    p_table_name TEXT,
    p_columns JSONB DEFAULT '[]'::jsonb,
    p_enable_rls BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID;
    v_model_id UUID;
    v_physical_name TEXT;

    v_column JSONB;
    v_column_name TEXT;
    v_column_type TEXT;
    v_sql_type TEXT;
    v_nullable BOOLEAN;

    v_ordinal INTEGER := 1;
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
        RAISE EXCEPTION
            'Application unavailable or not owned by current identity'
            USING ERRCODE = '42501';
    END IF;


    IF p_table_name IS NULL
       OR p_table_name !~ '^[a-z][a-z0-9_]{0,39}$'
    THEN
        RAISE EXCEPTION
            'Invalid FELTUS table name';
    END IF;


    IF p_table_name IN (
        'assets',
        'user_assets',
        'feltus_applications',
        'feltus_models',
        'feltus_model_columns'
    ) THEN
        RAISE EXCEPTION
            'Reserved FELTUS table name';
    END IF;


    IF jsonb_typeof(p_columns) <> 'array' THEN
        RAISE EXCEPTION
            'Columns must be supplied as a JSON array';
    END IF;


    v_model_id := gen_random_uuid();

    v_physical_name :=
        'fm_' ||
        substring(
            replace(v_model_id::text, '-', '')
            FROM 1 FOR 8
        ) ||
        '_' ||
        p_table_name;


    -- Create physical table first
    EXECUTE format(
        'CREATE TABLE public.%I (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            owner_id UUID NOT NULL DEFAULT auth.uid(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT timezone(''utc''::text, now())
        )',
        v_physical_name
    );


    -- IMPORTANT:
    -- Parent registry row must exist before feltus_model_columns
    -- rows are inserted because model_id has a foreign key.
    INSERT INTO public.feltus_models (
        id,
        app_id,
        owner_id,
        logical_name,
        physical_table_name,
        rls_enabled
    )
    VALUES (
        v_model_id,
        p_app_id,
        v_owner,
        p_table_name,
        v_physical_name,
        p_enable_rls
    );


    FOR v_column IN
        SELECT value
        FROM jsonb_array_elements(p_columns)
    LOOP

        v_column_name :=
            trim(v_column ->> 'name');

        v_column_type :=
            lower(trim(v_column ->> 'type'));

        v_nullable :=
            COALESCE(
                (v_column ->> 'nullable')::boolean,
                TRUE
            );


        IF v_column_name IS NULL
           OR v_column_name !~ '^[a-z][a-z0-9_]{0,39}$'
        THEN
            RAISE EXCEPTION
                'Invalid column name: %',
                v_column_name;
        END IF;


        IF v_column_name IN (
            'id',
            'owner_id',
            'created_at'
        ) THEN
            RAISE EXCEPTION
                'Reserved FELTUS column name: %',
                v_column_name;
        END IF;


        v_sql_type :=
            CASE v_column_type
                WHEN 'text' THEN 'TEXT'
                WHEN 'integer' THEN 'INTEGER'
                WHEN 'bigint' THEN 'BIGINT'
                WHEN 'numeric' THEN 'NUMERIC'
                WHEN 'boolean' THEN 'BOOLEAN'
                WHEN 'date' THEN 'DATE'
                WHEN 'timestamptz' THEN 'TIMESTAMPTZ'
                WHEN 'uuid' THEN 'UUID'
                WHEN 'jsonb' THEN 'JSONB'
                ELSE NULL
            END;


        IF v_sql_type IS NULL THEN
            RAISE EXCEPTION
                'Unsupported FELTUS data type: %',
                v_column_type;
        END IF;


        EXECUTE format(
            'ALTER TABLE public.%I ADD COLUMN %I %s %s',
            v_physical_name,
            v_column_name,
            v_sql_type,
            CASE
                WHEN v_nullable THEN ''
                ELSE 'NOT NULL'
            END
        );


        INSERT INTO public.feltus_model_columns (
            model_id,
            owner_id,
            column_name,
            data_type,
            is_nullable,
            ordinal_position
        )
        VALUES (
            v_model_id,
            v_owner,
            v_column_name,
            v_column_type,
            v_nullable,
            v_ordinal
        );


        v_ordinal :=
            v_ordinal + 1;

    END LOOP;


    EXECUTE format(
        'REVOKE ALL ON TABLE public.%I FROM anon',
        v_physical_name
    );


    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated',
        v_physical_name
    );


    IF p_enable_rls THEN

        EXECUTE format(
            'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
            v_physical_name
        );


        EXECUTE format(
            'CREATE POLICY feltus_owner_policy
             ON public.%I
             FOR ALL
             TO authenticated
             USING (auth.uid() = owner_id)
             WITH CHECK (auth.uid() = owner_id)',
            v_physical_name
        );

    END IF;


    RETURN jsonb_build_object(
        'id', v_model_id,
        'app_id', p_app_id,
        'logical_name', p_table_name,
        'physical_table_name', v_physical_name,
        'rls_enabled', p_enable_rls
    );

END;
$$;

NOTIFY pgrst, 'reload schema';
