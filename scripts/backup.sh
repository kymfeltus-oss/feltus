#!/usr/bin/env sh
set -eu

project=${COMPOSE_PROJECT_NAME:-feltus}
env_file=${FELTUS_ENV_FILE:-.env}
compose_file=${FELTUS_COMPOSE_FILE:-compose.production.yaml}

if [ ! -f "$env_file" ]; then
  printf 'Environment file not found: %s\n' "$env_file" >&2
  exit 1
fi
backup_dir=${FELTUS_BACKUP_DIR:-}
if [ -z "$backup_dir" ]; then
  backup_dir=$(sed -n 's/^[[:space:]]*FELTUS_BACKUP_DIR[[:space:]]*=[[:space:]]*//p' "$env_file" | tail -n 1)
  backup_dir=${backup_dir#\"}
  backup_dir=${backup_dir%\"}
  backup_dir=${backup_dir#\'}
  backup_dir=${backup_dir%\'}
fi
backup_dir=${backup_dir:-/srv/backups/feltus}
if [ ! -d "$backup_dir" ]; then
  printf 'Create the backup directory first: %s\n' "$backup_dir" >&2
  exit 1
fi

umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
target="$backup_dir/feltus-postgres-$timestamp.dump"
temporary="$target.partial"
if [ -e "$target" ] || [ -e "$temporary" ]; then
  printf '%s\n' 'A backup with this timestamp already exists.' >&2
  exit 1
fi
trap 'rm -f "$temporary"' EXIT HUP INT TERM

compose() {
  docker compose --project-name "$project" --env-file "$env_file" \
    --file "$compose_file" "$@"
}

compose exec -T db pg_dump -U postgres -d postgres -Fc > "$temporary"
compose exec -T db pg_restore --list - < "$temporary" >/dev/null
mv "$temporary" "$target"
chmod 600 "$target"
printf 'Verified database archive: %s\n' "$(basename "$target")"

compose run --rm -e FELTUS_BACKUP_TIMESTAMP="$timestamp" backup-storage
