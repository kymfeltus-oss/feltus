#!/usr/bin/env sh
set -eu

env_file=${FELTUS_ENV_FILE:-.env}
compose_file=${FELTUS_COMPOSE_FILE:-compose.production.yaml}

if [ ! -f "$env_file" ]; then
  printf 'Environment file not found: %s\n' "$env_file" >&2
  exit 1
fi
project=${COMPOSE_PROJECT_NAME:-}
if [ -z "$project" ]; then
  project=$(sed -n 's/^[[:space:]]*COMPOSE_PROJECT_NAME[[:space:]]*=[[:space:]]*//p' "$env_file" | tail -n 1)
  project=${project#\"}
  project=${project%\"}
  project=${project#\'}
  project=${project%\'}
fi
project=${project:-feltus}
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
target_dir="$backup_dir/$timestamp"
if ! mkdir -m 700 "$target_dir"; then
  printf '%s\n' 'Could not create a private timestamped backup directory.' >&2
  exit 1
fi
target="$target_dir/postgres.dump"
temporary="$target.partial"
trap 'rm -f "$temporary"' EXIT HUP INT TERM

compose() {
  docker compose --project-name "$project" --env-file "$env_file" \
    --file "$compose_file" "$@"
}

cp "$env_file" "$target_dir/deployment.env"
chmod 600 "$target_dir/deployment.env"
compose exec -T db pg_dump -U postgres -d postgres -Fc > "$temporary"
compose exec -T db pg_restore --list - < "$temporary" >/dev/null
mv "$temporary" "$target"
chmod 600 "$target"
printf 'Verified database archive in backup %s\n' "$timestamp"

compose run --rm -e FELTUS_BACKUP_TIMESTAMP="$timestamp" backup-storage
