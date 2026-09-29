#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
env_file="${1:-deploy/.env.staging}"
backup_dir="${2:-.local-data/backups}"
[[ -f "$env_file" ]] || { printf '%s\n' 'Staging env file is missing.' >&2; exit 1; }
mkdir -p "$backup_dir"
target="$backup_dir/medbox-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
partial="$target.partial"
photos_target="$target.photos.tar.gz"
photos_partial="$photos_target.partial"
[[ ! -e "$target" && ! -e "$partial" && ! -e "$photos_target" && ! -e "$photos_partial" ]] || { printf '%s\n' 'Backup target already exists.' >&2; exit 1; }
if docker compose version >/dev/null 2>&1; then compose=(docker compose); else compose=(docker-compose); fi
trap 'rm -f -- "$partial" "$photos_partial"' EXIT
"${compose[@]}" --env-file "$env_file" -f deploy/docker-compose.staging.yml exec -T db \
  sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$partial"
[[ -s "$partial" ]] || { printf '%s\n' 'Backup was empty.' >&2; exit 1; }
"${compose[@]}" --env-file "$env_file" -f deploy/docker-compose.staging.yml exec -T api \
  sh -c 'test -n "$PRIVATE_UPLOAD_DIR" && tar -czf - -C "$PRIVATE_UPLOAD_DIR" .' > "$photos_partial"
[[ -s "$photos_partial" ]] || { printf '%s\n' 'Private photo backup was empty.' >&2; exit 1; }
mv -- "$partial" "$target"
mv -- "$photos_partial" "$photos_target"
sha256sum "$target" "$photos_target" > "$target.sha256"
printf 'Database backup created: %s\n' "$target"
printf 'Private photo backup created: %s\n' "$photos_target"
