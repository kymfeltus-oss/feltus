-- ============================================================
-- FELTUS LABS
-- PHASE 5E-1 HARDENING
-- Activity log must be read-only to authenticated clients.
-- Writes occur only through feltus_log_event().
-- ============================================================

REVOKE ALL
ON public.feltus_activity_log
FROM anon;

REVOKE ALL
ON public.feltus_activity_log
FROM authenticated;

GRANT SELECT
ON public.feltus_activity_log
TO authenticated;


-- Preserve controlled RPC access.

REVOKE ALL
ON FUNCTION public.feltus_log_event(
    TEXT,
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    JSONB,
    UUID,
    INTEGER
)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.feltus_log_event(
    TEXT,
    TEXT,
    TEXT,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    JSONB,
    UUID,
    INTEGER
)
TO authenticated;


NOTIFY pgrst, 'reload schema';
