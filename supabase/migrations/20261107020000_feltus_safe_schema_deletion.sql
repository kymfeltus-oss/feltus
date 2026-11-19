-- FELTUS: scoped, confirmed field and relationship deletion.
-- Every destructive DDL operation and its registry mutation runs in one
-- PostgreSQL transaction. No operation uses CASCADE.

CREATE OR REPLACE FUNCTION public.feltus_model_field_deletion_impact(
    p_app_id UUID,
    p_model_id UUID,
    p_field_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_model RECORD;
    v_column RECORD;
    v_column_exists BOOLEAN;
    v_affected_rows BIGINT;
    v_dependencies JSONB;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    IF p_field_name IS NULL OR p_field_name !~ '^[a-z][a-z0-9_]{0,39}$' THEN
        RAISE EXCEPTION 'A valid custom field name is required' USING ERRCODE = '22023';
    END IF;

    IF p_field_name IN ('id', 'owner_id', 'created_at') THEN
        RAISE EXCEPTION 'FELTUS managed fields cannot be removed' USING ERRCODE = '22023';
    END IF;

    SELECT m.id, m.app_id, m.owner_id, m.logical_name, m.physical_table_name
      INTO v_model
      FROM public.feltus_models AS m
      JOIN public.feltus_applications AS a
        ON a.id = m.app_id
       AND a.owner_id = v_owner
     WHERE m.id = p_model_id
       AND m.app_id = p_app_id
       AND m.owner_id = v_owner;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Application or model unavailable to current identity' USING ERRCODE = '42501';
    END IF;

    SELECT c.id, c.column_name, c.data_type, c.is_nullable
      INTO v_column
      FROM public.feltus_model_columns AS c
     WHERE c.model_id = p_model_id
       AND c.owner_id = v_owner
       AND c.column_name = p_field_name;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Custom field not found for this application' USING ERRCODE = '42703';
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = v_model.physical_table_name
           AND column_name = p_field_name
    ) INTO v_column_exists;

    IF NOT v_column_exists THEN
        RAISE EXCEPTION 'Physical field is missing; no metadata was changed' USING ERRCODE = '42703';
    END IF;

    EXECUTE format(
        'SELECT count(*) FROM public.%I WHERE %I IS NOT NULL',
        v_model.physical_table_name,
        p_field_name
    ) INTO v_affected_rows;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', r.id,
        'source_model_id', r.source_model_id,
        'source_field', r.source_column,
        'target_model_id', r.target_model_id,
        'target_field', r.target_column
    ) ORDER BY r.id), '[]'::JSONB)
      INTO v_dependencies
      FROM public.feltus_model_relationships AS r
     WHERE r.app_id = p_app_id
       AND r.owner_id = v_owner
       AND ((r.source_model_id = p_model_id AND r.source_column = p_field_name)
         OR (r.target_model_id = p_model_id AND r.target_column = p_field_name));

    RETURN jsonb_build_object(
        'app_id', p_app_id,
        'model_id', p_model_id,
        'model_name', v_model.logical_name,
        'field_name', p_field_name,
        'physical_table', v_model.physical_table_name,
        'data_type', v_column.data_type,
        'affected_rows', v_affected_rows,
        'dependencies', v_dependencies,
        'can_delete', jsonb_array_length(v_dependencies) = 0,
        'reversible', FALSE,
        'data_loss', v_affected_rows > 0
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_delete_model_field(
    p_app_id UUID,
    p_model_id UUID,
    p_field_name TEXT,
    p_confirm BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_table TEXT;
    v_impact JSONB;
    v_deleted INTEGER;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_confirm IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Explicit confirmation is required' USING ERRCODE = '22023';
    END IF;

    SELECT m.physical_table_name
      INTO v_table
      FROM public.feltus_models AS m
      JOIN public.feltus_applications AS a ON a.id = m.app_id AND a.owner_id = v_owner
     WHERE m.id = p_model_id AND m.app_id = p_app_id AND m.owner_id = v_owner
     FOR UPDATE OF m;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Application or model unavailable to current identity' USING ERRCODE = '42501';
    END IF;

    PERFORM 1
      FROM public.feltus_model_columns AS c
     WHERE c.model_id = p_model_id AND c.owner_id = v_owner AND c.column_name = p_field_name
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Custom field not found for this application' USING ERRCODE = '42703';
    END IF;

    v_impact := public.feltus_model_field_deletion_impact(p_app_id, p_model_id, p_field_name);
    IF NOT COALESCE((v_impact ->> 'can_delete')::BOOLEAN, FALSE) THEN
        RAISE EXCEPTION 'Field has active relationship dependencies; remove them first' USING ERRCODE = '23503';
    END IF;

    -- PostgreSQL's default RESTRICT behavior protects any dependency not
    -- represented in FELTUS relationship metadata. Never use CASCADE here.
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN %I', v_table, p_field_name);

    DELETE FROM public.feltus_model_columns
     WHERE model_id = p_model_id
       AND owner_id = v_owner
       AND column_name = p_field_name;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted <> 1 THEN
        RAISE EXCEPTION 'Field registry did not match the physical field' USING ERRCODE = '40001';
    END IF;

    RETURN jsonb_build_object(
        'deleted', TRUE,
        'app_id', p_app_id,
        'model_id', p_model_id,
        'field_name', p_field_name,
        'impact', v_impact
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.feltus_relationship_deletion_impact(
    p_app_id UUID,
    p_relationship_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_rel RECORD;
    v_constraint_exists BOOLEAN;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT r.id, r.app_id, r.owner_id, r.source_model_id, r.source_column,
           r.target_model_id, r.target_column, r.constraint_name, r.on_delete_action,
           src.logical_name AS source_name, src.physical_table_name AS source_table,
           dst.logical_name AS target_name, dst.physical_table_name AS target_table
      INTO v_rel
      FROM public.feltus_model_relationships AS r
      JOIN public.feltus_applications AS a ON a.id = r.app_id AND a.owner_id = v_owner
      JOIN public.feltus_models AS src
        ON src.id = r.source_model_id AND src.app_id = r.app_id AND src.owner_id = v_owner
      JOIN public.feltus_models AS dst
        ON dst.id = r.target_model_id AND dst.app_id = r.app_id AND dst.owner_id = v_owner
     WHERE r.id = p_relationship_id
       AND r.app_id = p_app_id
       AND r.owner_id = v_owner;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Relationship unavailable or not owned by current identity' USING ERRCODE = '42501';
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM pg_constraint AS c
          JOIN pg_class AS src_rel ON src_rel.oid = c.conrelid
          JOIN pg_namespace AS src_ns ON src_ns.oid = src_rel.relnamespace
          JOIN pg_class AS dst_rel ON dst_rel.oid = c.confrelid
          JOIN pg_namespace AS dst_ns ON dst_ns.oid = dst_rel.relnamespace
          JOIN pg_attribute AS src_col ON src_col.attrelid = src_rel.oid AND src_col.attname = v_rel.source_column AND NOT src_col.attisdropped
          JOIN pg_attribute AS dst_col ON dst_col.attrelid = dst_rel.oid AND dst_col.attname = v_rel.target_column AND NOT dst_col.attisdropped
         WHERE c.contype = 'f'
           AND c.conname = v_rel.constraint_name
           AND src_ns.nspname = 'public'
           AND src_rel.relname = v_rel.source_table
           AND dst_ns.nspname = 'public'
           AND dst_rel.relname = v_rel.target_table
           AND c.conkey = ARRAY[src_col.attnum]::SMALLINT[]
           AND c.confkey = ARRAY[dst_col.attnum]::SMALLINT[]
    ) INTO v_constraint_exists;

    RETURN jsonb_build_object(
        'app_id', p_app_id,
        'relationship_id', p_relationship_id,
        'source_model', v_rel.source_name,
        'source_field', v_rel.source_column,
        'target_model', v_rel.target_name,
        'target_field', v_rel.target_column,
        'constraint_name', v_rel.constraint_name,
        'on_delete_action', v_rel.on_delete_action,
        'constraint_verified', v_constraint_exists,
        'can_delete', v_constraint_exists,
        'row_data_changed', FALSE,
        'reversible', TRUE
    );
END;
$$;

-- The old one-argument RPC cannot carry the explicit confirmation and app
-- scope required by this contract. Keep the HTTP route, but close direct use.
REVOKE ALL ON FUNCTION public.feltus_delete_relationship(UUID) FROM PUBLIC, authenticated;

CREATE OR REPLACE FUNCTION public.feltus_delete_relationship_confirmed(
    p_app_id UUID,
    p_relationship_id UUID,
    p_confirm BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_rel RECORD;
    v_impact JSONB;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_confirm IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Explicit confirmation is required' USING ERRCODE = '22023';
    END IF;

    SELECT r.id, r.app_id, r.source_model_id, r.source_column, r.target_model_id,
           r.target_column, r.constraint_name, src.physical_table_name AS source_table
      INTO v_rel
      FROM public.feltus_model_relationships AS r
      JOIN public.feltus_applications AS a ON a.id = r.app_id AND a.owner_id = v_owner
      JOIN public.feltus_models AS src
        ON src.id = r.source_model_id AND src.app_id = r.app_id AND src.owner_id = v_owner
      JOIN public.feltus_models AS dst
        ON dst.id = r.target_model_id AND dst.app_id = r.app_id AND dst.owner_id = v_owner
     WHERE r.id = p_relationship_id AND r.app_id = p_app_id AND r.owner_id = v_owner
     FOR UPDATE OF r;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Relationship unavailable or not owned by current identity' USING ERRCODE = '42501';
    END IF;

    -- Verify the exact table, target table, column pair, and FK name again at
    -- execution time. A stale or mismatched registry row fails closed.
    v_impact := public.feltus_relationship_deletion_impact(p_app_id, p_relationship_id);
    IF NOT COALESCE((v_impact ->> 'constraint_verified')::BOOLEAN, FALSE) THEN
        RAISE EXCEPTION 'The registered relationship constraint could not be verified' USING ERRCODE = '23503';
    END IF;

    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_rel.source_table, v_rel.constraint_name);

    DELETE FROM public.feltus_model_relationships
     WHERE id = p_relationship_id AND app_id = p_app_id AND owner_id = v_owner;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Relationship registry did not match the database constraint' USING ERRCODE = '40001';
    END IF;

    RETURN jsonb_build_object(
        'deleted', TRUE,
        'app_id', p_app_id,
        'relationship_id', p_relationship_id,
        'impact', v_impact
    );
END;
$$;

REVOKE ALL ON FUNCTION public.feltus_model_field_deletion_impact(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.feltus_delete_model_field(UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.feltus_relationship_deletion_impact(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.feltus_delete_relationship_confirmed(UUID, UUID, BOOLEAN) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.feltus_model_field_deletion_impact(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_delete_model_field(UUID, UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_relationship_deletion_impact(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_delete_relationship_confirmed(UUID, UUID, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';
