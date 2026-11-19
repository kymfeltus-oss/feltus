CREATE OR REPLACE FUNCTION public.feltus_update_model_schema(
    p_app_id UUID,
    p_model_id UUID,
    p_columns JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_model RECORD;
    v_column JSONB;
    v_column_name TEXT;
    v_column_type TEXT;
    v_sql_type TEXT;
    v_nullable BOOLEAN;
    v_existing_type TEXT;
    v_seen_names TEXT[] := ARRAY[]::TEXT[];
    v_ordinal INTEGER;
    v_has_rows BOOLEAN;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = '42501';
    END IF;

    SELECT m.id, m.app_id, m.owner_id, m.logical_name, m.physical_table_name, m.rls_enabled
      INTO v_model
      FROM public.feltus_models AS m
      JOIN public.feltus_applications AS a
        ON a.id = m.app_id
       AND a.owner_id = v_owner
     WHERE m.id = p_model_id
       AND m.app_id = p_app_id
       AND m.owner_id = v_owner
     FOR UPDATE OF m;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Application or model unavailable to current identity'
            USING ERRCODE = '42501';
    END IF;

    IF p_columns IS NULL
       OR jsonb_typeof(p_columns) <> 'array'
       OR jsonb_array_length(p_columns) > 50
    THEN
        RAISE EXCEPTION 'Columns must be an array with no more than 50 entries';
    END IF;

    SELECT COALESCE(MAX(c.ordinal_position), 0) + 1
      INTO v_ordinal
      FROM public.feltus_model_columns AS c
     WHERE c.model_id = p_model_id;

    FOR v_column IN SELECT value FROM jsonb_array_elements(p_columns)
    LOOP
        v_column_name := trim(v_column ->> 'name');
        v_column_type := lower(trim(v_column ->> 'type'));
        v_nullable := COALESCE((v_column ->> 'nullable')::BOOLEAN, TRUE);

        IF v_column_name IS NULL
           OR v_column_name !~ '^[a-z][a-z0-9_]{0,39}$'
           OR v_column_name IN ('id', 'owner_id', 'created_at')
        THEN
            RAISE EXCEPTION 'Invalid or reserved FELTUS field name: %', v_column_name;
        END IF;

        IF v_column_name = ANY(v_seen_names) THEN
            RAISE EXCEPTION 'The field name % is repeated', v_column_name;
        END IF;
        v_seen_names := array_append(v_seen_names, v_column_name);

        v_sql_type := CASE v_column_type
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
            RAISE EXCEPTION 'Unsupported FELTUS data type: %', v_column_type;
        END IF;

        SELECT c.data_type
          INTO v_existing_type
          FROM public.feltus_model_columns AS c
         WHERE c.model_id = p_model_id
           AND c.column_name = v_column_name
         FOR UPDATE;

        IF FOUND THEN
            IF v_existing_type <> v_column_type THEN
                RAISE EXCEPTION 'Changing the type of a saved field is not supported';
            END IF;

            EXECUTE format(
                'ALTER TABLE public.%I ALTER COLUMN %I %s',
                v_model.physical_table_name,
                v_column_name,
                CASE WHEN v_nullable THEN 'DROP NOT NULL' ELSE 'SET NOT NULL' END
            );

            UPDATE public.feltus_model_columns
               SET is_nullable = v_nullable
             WHERE model_id = p_model_id
               AND column_name = v_column_name;
        ELSE
            IF NOT v_nullable THEN
                EXECUTE format(
                    'SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)',
                    v_model.physical_table_name
                ) INTO v_has_rows;

                IF v_has_rows THEN
                    RAISE EXCEPTION 'New fields must be optional when this category already has saved rows';
                END IF;
            END IF;

            EXECUTE format(
                'ALTER TABLE public.%I ADD COLUMN %I %s %s',
                v_model.physical_table_name,
                v_column_name,
                v_sql_type,
                CASE WHEN v_nullable THEN '' ELSE 'NOT NULL' END
            );

            INSERT INTO public.feltus_model_columns (
                model_id,
                owner_id,
                column_name,
                data_type,
                is_nullable,
                ordinal_position
            ) VALUES (
                p_model_id,
                v_owner,
                v_column_name,
                v_column_type,
                v_nullable,
                v_ordinal
            );
            v_ordinal := v_ordinal + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'id', v_model.id,
        'app_id', v_model.app_id,
        'logical_name', v_model.logical_name,
        'physical_table_name', v_model.physical_table_name,
        'rls_enabled', v_model.rls_enabled
    );
END;
$$;

REVOKE ALL ON FUNCTION public.feltus_update_model_schema(UUID, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.feltus_update_model_schema(UUID, UUID, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
