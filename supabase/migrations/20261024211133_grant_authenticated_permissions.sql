-- ====================================================================
-- FELTUS LABS: DATA PRIVILEGE MIGRATION PATCH
-- SCOPE: Grant operational read/write access contexts to authenticated application roles
-- ====================================================================

-- 1. Ensure the authenticated role has permissions to execute commands in the public schema
GRANT USAGE ON SCHEMA public TO authenticated;

-- 2. Grant table-specific structural manipulation permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feltus_applications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_assets TO authenticated;

-- 3. Grant sequence-advancement permissions if serial tracking parameters scale out later
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;