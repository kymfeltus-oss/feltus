#!/usr/bin/env sh
set -eu
umask 077

stamp=${FELTUS_BACKUP_TIMESTAMP:?FELTUS_BACKUP_TIMESTAMP is required}
case "$stamp" in
  *[!A-Za-z0-9._-]*)
    printf '%s\n' 'Invalid backup timestamp.' >&2
    exit 1
    ;;
esac

for entry in documents object-storage; do
  source="/data/$entry"
  target="/backups/$stamp/feltus-$entry.tar.gz"
  if [ -e "$target" ]; then
    printf 'Storage archive already exists: %s\n' "$(basename "$target")" >&2
    exit 1
  fi
  tar -czf "$target" -C "$source" .
  tar -tzf "$target" >/dev/null
  printf 'Verified storage archive: %s\n' "$(basename "$target")"
done
