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
[[ ! -e "$target" && ! -e "$partial" ]] || { printf '%s\n' 'Backup target already exists.' >&2; exit 1; }
if docker compose version >/dev/null 2>&1; then compose=(docker compose); else compose=(docker-compose); fi
trap 'rm -f -- "$partial"' EXIT
"${compose[@]}" --env-file "$env_file" -f deploy/docker-compose.staging.yml exec -T db \
  sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$partial"
[[ -s "$partial" ]] || { printf '%s\n' 'Backup was empty.' >&2; exit 1; }
mv -- "$partial" "$target"
sha256sum "$target" > "$target.sha256"
printf 'Backup created: %s\n' "$target"
