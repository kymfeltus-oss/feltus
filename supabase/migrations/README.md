# Database migrations

Use the Supabase CLI to create timestamped migrations:

```powershell
supabase migration new <descriptive_name>
```

Commit each migration with the application code. Treat an applied migration as
immutable; make later changes in a new migration. Use these migrations for
FeltusBase-owned tables, functions, grants, and row-level security policies.
Let Supabase provision its own platform roles, schemas, and extensions rather
than recreating those in an application migration.

Keep migration files free of credentials. The CLI maintains migration history
in `supabase_migrations.schema_migrations` when migrations are applied.
