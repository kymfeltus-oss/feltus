-- 1. Grant complete access privileges to the API consumer roles
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets TO service_role;

-- 2. Fully bypass Row Level Security for local development testing
ALTER TABLE public.assets DISABLE ROW LEVEL SECURITY;

-- 3. Clear out the schema cache layer instantly
NOTIFY pgrst, 'reload schema';
