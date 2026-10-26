-- ====================================================================
-- FELTUS LABS: SYSTEM LEVEL MULTI-TENANT BASELINE RUNNER
-- MANDATE: Enforce strict app segmentation, isolation, and data privacy
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.feltus_applications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    owner_id UUID NOT NULL,
    app_name TEXT NOT NULL UNIQUE,
    environment TEXT NOT NULL DEFAULT 'development',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_assets (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    app_id UUID REFERENCES public.feltus_applications(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    asset_name TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.feltus_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_assets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.feltus_applications FROM anon;
REVOKE ALL ON public.user_assets FROM anon;

CREATE POLICY app_owner_isolation_policy ON public.feltus_applications
    FOR ALL TO authenticated USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

CREATE POLICY asset_user_isolation_policy ON public.user_assets
    FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_feltus_apps_owner ON public.feltus_applications(owner_id);
CREATE INDEX IF NOT EXISTS idx_user_assets_lookup ON public.user_assets(user_id, app_id);