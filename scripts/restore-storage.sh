#!/usr/bin/env sh
set -eu

stamp=${FELTUS_BACKUP_TIMESTAMP:?FELTUS_BACKUP_TIMESTAMP is required}
case "$stamp" in
  *[!A-Za-z0-9._-]*)
    printf '%s\n' 'Invalid backup timestamp.' >&2
    exit 1
    ;;
esac

for entry in documents object-storage; do
  archive="/backups/$stamp/feltus-$entry.tar.gz"
  destination="/data/$entry"
  if [ ! -f "$archive" ]; then
    printf 'Storage archive not found: %s\n' "$(basename "$archive")" >&2
    exit 1
  fi
  tar -tzf "$archive" >/dev/null
  tar -xzf "$archive" -C "$destination"
  printf 'Restored storage archive: %s\n' "$(basename "$archive")"
done
