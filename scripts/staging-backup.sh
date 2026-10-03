#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
env_file="${1:-deploy/.env.staging}"
backup_dir="${2:-.local-data/backups}"
[[ -f "$env_file" ]] || { printf '%s\n' 'Staging env file is missing.' >&2; exit 1; }
if docker compose version >/dev/null 2>&1; then compose=(docker compose); else compose=(docker-compose); fi
compose+=(--env-file "$env_file" -f deploy/docker-compose.staging.yml)

fail() { printf '%s\n' "$1" >&2; exit 1; }
api_id="$("${compose[@]}" ps --all --quiet api)"
[[ "$api_id" =~ ^[a-f0-9]{12,64}$ ]] || fail 'Expected one existing staging API container; stop and verify the stack before backup.'
metadata_format='{{.State.Status}}|{{.Image}}|{{range .Mounts}}{{if eq .Destination "/var/lib/medbox/private-uploads"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}'
metadata="$(docker inspect --format "$metadata_format" "$api_id")"
IFS='|' read -r api_state api_image mount_type photo_volume mount_write extra <<< "$metadata"
[[ "$api_state" == exited || "$api_state" == created ]] || fail 'Backup requires the API and its background jobs to be stopped for an exclusive maintenance window.'
[[ "$api_image" =~ ^sha256:[a-f0-9]{64}$ && "$mount_type" == volume && "$photo_volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && "$mount_write" == true && -z "$extra" ]] || fail 'Cannot verify the existing API image and named private-photo volume.'

# Checks detect observed state changes; the operator must prevent any restart or
# external writer throughout the window. They are not an atomic Docker lock.
verify_maintenance() {
  [[ "$("${compose[@]}" ps --all --quiet api)" == "$api_id" ]] || fail 'API container identity changed during backup.'
  local current state image type volume writable remainder consumers consumer
  current="$(docker inspect --format "$metadata_format" "$api_id")"
  IFS='|' read -r state image type volume writable remainder <<< "$current"
  [[ "$state" == exited || "$state" == created ]] || fail 'API restarted or is not stopped; backup will not be published.'
  [[ "$image" == "$api_image" && "$type" == volume && "$volume" == "$photo_volume" && "$writable" == true && -z "$remainder" ]] || fail 'API image or photo volume changed during backup.'
  consumers="$(docker ps --all --quiet --filter "volume=$photo_volume")"
  while IFS= read -r consumer; do
    [[ -z "$consumer" ]] && continue
    [[ "$consumer" =~ ^[a-f0-9]{12,64}$ ]] || fail 'Cannot verify photo-volume consumers.'
    state="$(docker inspect --format '{{.State.Status}}' "$consumer")"
    [[ "$state" == exited || "$state" == created ]] || fail 'A photo-volume consumer is active; stop all writers before backup.'
  done <<< "$consumers"
}
verify_maintenance
mkdir -p "$backup_dir"
target="$backup_dir/medbox-$(date -u +%Y%m%dT%H%M%SZ)-$$"
[[ ! -e "$target" && ! -L "$target" ]] || fail 'Backup target already exists.'
work_dir="$(mktemp -d "$backup_dir/.medbox-backup-XXXXXXXX")"
cleanup() {
  if [[ -n "$work_dir" ]]; then
    # Only this invocation's newly created staging directory and known files.
    rm -f -- "$work_dir/database.dump" "$work_dir/photos.tar.gz" "$work_dir/SHA256SUMS"
    rmdir -- "$work_dir" || printf '%s\n' 'Incomplete backup directory retained for inspection.' >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${compose[@]}" exec -T db \
  sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$work_dir/database.dump"
[[ -s "$work_dir/database.dump" ]] || fail 'Backup was empty.'
verify_maintenance
# Reuse the already installed application image; no pulls, dependencies,
# application entrypoint, network, writable photo mount, or server environment.
docker run --pull=never --rm --network none --read-only \
  --mount "type=volume,src=$photo_volume,dst=/backup-photos,readonly" \
  --entrypoint tar "$api_image" -czf - -C /backup-photos . > "$work_dir/photos.tar.gz"
[[ -s "$work_dir/photos.tar.gz" ]] || fail 'Private photo backup was empty.'
verify_maintenance
(cd "$work_dir" && sha256sum database.dump photos.tar.gz > SHA256SUMS)
# Publish both files and their checksums together with one same-filesystem
# directory rename. Never overwrite an existing backup directory.
mv --no-clobber --no-target-directory -- "$work_dir" "$target"
[[ ! -d "$work_dir" ]] || fail 'Backup destination appeared concurrently; existing backup was preserved.'
work_dir=''
printf 'Database backup created: %s/database.dump\n' "$target"
printf 'Private photo backup created: %s/photos.tar.gz\n' "$target"
printf 'Verify checksums from the backup directory: sha256sum -c SHA256SUMS\n'
