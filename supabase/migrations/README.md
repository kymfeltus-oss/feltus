# Database migrations

Use the Supabase CLI to create timestamped migrations:

```powershell
supabase migration new <descriptive_name>
```

Commit each migration with the application code. Treat an applied migration as
immutable; make later changes in a new migration. Use these migrations for
FeltusBase-owned tables, functions, grants, and row-level security policies.
Let the local Supabase-compatible database provision its own platform roles,
schemas, and extensions rather than recreating those in an application
migration.

Keep migration files free of credentials. The local Supabase CLI tracks its
migrations in `supabase_migrations.schema_migrations`. Production Compose runs
`scripts/migrate.sh`, which applies the same files in filename order and tracks
them in `feltus_internal.schema_migrations`. Each production migration runs in
a transaction; treat an applied migration as immutable.
