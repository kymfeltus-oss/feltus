#!/usr/bin/env sh
set -eu

: "${PGPASSWORD:=${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}}"
psql_cmd() {
  psql -h db -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"
}

psql_cmd <<'SQL'
CREATE SCHEMA IF NOT EXISTS feltus_internal;
REVOKE ALL ON SCHEMA feltus_internal FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS feltus_internal.schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE feltus_internal.schema_migrations FROM PUBLIC, anon, authenticated;
SQL

for migration in /migrations/*.sql; do
  [ -f "$migration" ] || continue
  name=${migration##*/}
  already_applied=$(psql -h db -U postgres -d postgres -At -v ON_ERROR_STOP=1 \
    -c "SELECT 1 FROM feltus_internal.schema_migrations WHERE name = '${name}' LIMIT 1")

  if [ "$already_applied" = "1" ]; then
    continue
  fi

  transaction_file=$(mktemp)
  cat "$migration" > "$transaction_file"
  printf "\nINSERT INTO feltus_internal.schema_migrations (name) VALUES ('%s');\n" \
    "$name" >> "$transaction_file"

  if ! psql -h db -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction \
    -f "$transaction_file" >/dev/null; then
    rm -f "$transaction_file"
    printf 'Migration failed: %s\n' "$name" >&2
    exit 1
  fi

  rm -f "$transaction_file"
  printf 'Applied migration: %s\n' "$name"
done
