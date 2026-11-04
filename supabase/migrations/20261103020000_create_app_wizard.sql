-- Create App wizard metadata is stored on the existing FELTUS application row.
-- setup_data is reserved for non-secret setup choices; credentials belong in
-- the dedicated encrypted-secret tables.

ALTER TABLE public.feltus_applications
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS app_type TEXT NOT NULL DEFAULT 'other',
    ADD COLUMN IF NOT EXISTS app_icon TEXT NOT NULL DEFAULT '✦',
    ADD COLUMN IF NOT EXISTS accent_color TEXT NOT NULL DEFAULT '#62D6C9',
    ADD COLUMN IF NOT EXISTS setup_status TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS setup_current_step TEXT NOT NULL DEFAULT 'overview',
    ADD COLUMN IF NOT EXISTS setup_completed_steps TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS setup_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    ADD COLUMN IF NOT EXISTS setup_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'feltus_applications_app_type_check'
    ) THEN
        ALTER TABLE public.feltus_applications
            ADD CONSTRAINT feltus_applications_app_type_check
            CHECK (app_type IN ('web_application','internal_tool','api_backend','ai_application','data_application','other'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'feltus_applications_accent_color_check'
    ) THEN
        ALTER TABLE public.feltus_applications
            ADD CONSTRAINT feltus_applications_accent_color_check
            CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'feltus_applications_setup_status_check'
    ) THEN
        ALTER TABLE public.feltus_applications
            ADD CONSTRAINT feltus_applications_setup_status_check
            CHECK (setup_status IN ('draft','configuring','ready_for_build','building','active','archived'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'feltus_applications_setup_step_check'
    ) THEN
        ALTER TABLE public.feltus_applications
            ADD CONSTRAINT feltus_applications_setup_step_check
            CHECK (setup_current_step IN ('overview','basics','data','relationships','documents','ai','code','environment','review','build'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'feltus_applications_setup_data_object_check'
    ) THEN
        ALTER TABLE public.feltus_applications
            ADD CONSTRAINT feltus_applications_setup_data_object_check
            CHECK (jsonb_typeof(setup_data) = 'object');
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS feltus_applications_setup_owner_status_idx
    ON public.feltus_applications (owner_id, setup_status, setup_updated_at DESC);

CREATE OR REPLACE FUNCTION public.feltus_touch_app_setup_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF ROW(NEW.description, NEW.app_type, NEW.app_icon, NEW.accent_color,
           NEW.setup_status, NEW.setup_current_step, NEW.setup_completed_steps, NEW.setup_data)
       IS DISTINCT FROM
       ROW(OLD.description, OLD.app_type, OLD.app_icon, OLD.accent_color,
           OLD.setup_status, OLD.setup_current_step, OLD.setup_completed_steps, OLD.setup_data) THEN
        NEW.setup_updated_at := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feltus_applications_setup_updated_at ON public.feltus_applications;
CREATE TRIGGER feltus_applications_setup_updated_at
BEFORE UPDATE ON public.feltus_applications
FOR EACH ROW EXECUTE FUNCTION public.feltus_touch_app_setup_updated_at();

NOTIFY pgrst, 'reload schema';
