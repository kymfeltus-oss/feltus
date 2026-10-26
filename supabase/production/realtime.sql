-- Initialize the private Realtime tenant schema in the self-hosted database.
-- Mirrors the minimal upstream Supabase initialization migration.
\set pguser `echo "$POSTGRES_USER"`

CREATE SCHEMA IF NOT EXISTS _realtime;
ALTER SCHEMA _realtime OWNER TO :pguser;
