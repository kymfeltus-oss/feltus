ALTER TABLE public.feltus_git_connections
    ADD COLUMN IF NOT EXISTS provider_account_id TEXT;

CREATE INDEX IF NOT EXISTS feltus_git_connections_github_account_idx
    ON public.feltus_git_connections (organization_id, provider_account_id)
    WHERE provider = 'github' AND disabled_at IS NULL AND provider_account_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.feltus_save_github_oauth_connection(
    p_organization_id UUID,
    p_provider_account_id TEXT,
    p_account_label TEXT,
    p_credential_ciphertext BYTEA,
    p_encryption_key_version TEXT,
    p_created_by UUID,
    p_target_connection_id UUID DEFAULT NULL
)
RETURNS TABLE(id UUID, account_label TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_connection_id UUID;
    v_updated_rows INTEGER;
BEGIN
    IF p_organization_id IS NULL OR p_created_by IS NULL OR
       p_provider_account_id IS NULL OR p_account_label IS NULL OR
       p_provider_account_id !~ '^[0-9]{1,30}$' OR
       p_account_label !~ '^[A-Za-z0-9-]{1,39}$' OR
       p_credential_ciphertext IS NULL OR
       p_encryption_key_version IS DISTINCT FROM 'aes-256-gcm-hkdf-v1' THEN
        RAISE EXCEPTION 'GitHub connection details are invalid.';
    END IF;

    -- Serialize first-time callbacks for this organization and GitHub identity.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext(p_organization_id::TEXT),
        pg_catalog.hashtext(p_provider_account_id)
    );

    IF p_target_connection_id IS NOT NULL THEN
        UPDATE public.feltus_git_connections AS gc
        SET provider_account_id = p_provider_account_id,
            account_label = p_account_label,
            credential_ciphertext = p_credential_ciphertext,
            encryption_key_version = p_encryption_key_version,
            updated_at = pg_catalog.now()
        WHERE gc.id = p_target_connection_id
          AND gc.organization_id = p_organization_id
          AND gc.provider = 'github'
          AND gc.disabled_at IS NULL
          AND (gc.provider_account_id IS NULL OR
               gc.provider_account_id = p_provider_account_id)
        RETURNING gc.id INTO v_connection_id;

        IF v_connection_id IS NULL THEN
            RETURN;
        END IF;
    ELSE
        -- Upgrade every matching legacy duplicate in place so attached repositories
        -- keep their existing git_connection_id values.
        UPDATE public.feltus_git_connections AS gc
        SET provider_account_id = p_provider_account_id,
            account_label = p_account_label,
            credential_ciphertext = p_credential_ciphertext,
            encryption_key_version = p_encryption_key_version,
            updated_at = pg_catalog.now()
        WHERE gc.organization_id = p_organization_id
          AND gc.provider = 'github'
          AND gc.disabled_at IS NULL
          AND (gc.provider_account_id = p_provider_account_id OR
               (gc.provider_account_id IS NULL AND
                pg_catalog.lower(gc.account_label) = pg_catalog.lower(p_account_label)));

        GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
        IF v_updated_rows = 0 THEN
            INSERT INTO public.feltus_git_connections AS inserted (
                organization_id, provider, provider_account_id, account_label,
                credential_ciphertext, encryption_key_version, created_by
            ) VALUES (
                p_organization_id, 'github', p_provider_account_id, p_account_label,
                p_credential_ciphertext, p_encryption_key_version, p_created_by
            ) RETURNING inserted.id INTO v_connection_id;
        ELSE
            SELECT gc.id
            INTO v_connection_id
            FROM public.feltus_git_connections AS gc
            WHERE gc.organization_id = p_organization_id
              AND gc.provider = 'github'
              AND gc.disabled_at IS NULL
              AND gc.provider_account_id = p_provider_account_id
            ORDER BY gc.created_at ASC, gc.id ASC
            LIMIT 1;
        END IF;
    END IF;

    RETURN QUERY
    SELECT gc.id, gc.account_label, gc.created_at
    FROM public.feltus_git_connections AS gc
    WHERE gc.id = v_connection_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.feltus_save_github_oauth_connection(UUID,TEXT,TEXT,BYTEA,TEXT,UUID,UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feltus_save_github_oauth_connection(UUID,TEXT,TEXT,BYTEA,TEXT,UUID,UUID)
    TO service_role;
