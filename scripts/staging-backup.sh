#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
env_file="${1:?Usage: staging-backup.sh ENV_FILE BACKUP_DIR REVIEWED_BINDING}"
backup_dir="${2:?An explicit backup directory is required}"
binding_file="${3:?An independently reviewed existing-deployment binding is required}"
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ "$#" == 3 && -f "$env_file" && -f "$binding_file" ]] || fail 'Expected one env-file, backup directory and reviewed binding.'
env_file="$(realpath -- "$env_file")"
binding_file="$(realpath -- "$binding_file")"
check_identity() { node scripts/deployment-guard.mjs backup-check --binding "$binding_file" --env-file "$env_file"; }
identity="$(check_identity)"
IFS='|' read -r api_id db_id api_image photo_volume binding_sha endpoint database_fingerprint extra <<< "$identity"
[[ "$api_id" =~ ^[a-f0-9]{64}$ && "$db_id" =~ ^[a-f0-9]{64}$ && "$api_image" =~ ^sha256:[a-f0-9]{64}$ && "$photo_volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && "$binding_sha" =~ ^[a-f0-9]{64}$ && "$endpoint" =~ ^unix:/// && "$database_fingerprint" =~ ^[a-f0-9]{64}$ && -z "$extra" ]] || fail 'Invalid identity-check result.'
# Only the bound local daemon and DB container may be used. No ambient Compose
# project/context/config or service-name lookup can redirect the dump.
docker_bound() { env -i PATH="$PATH" DOCKER_HOST="$endpoint" DOCKER_CONFIG="$work_dir/docker-config" docker --host "$endpoint" "$@"; }
verify_maintenance() { [[ "$(check_identity)" == "$identity" ]] || fail 'Deployment identity changed; backup will not be published.'; }
mkdir -p "$backup_dir"
target="$backup_dir/medbox-$(date -u +%Y%m%dT%H%M%SZ)-$$"
[[ ! -e "$target" && ! -L "$target" ]] || fail 'Backup target already exists.'
work_dir="$(mktemp -d "$backup_dir/.medbox-backup-XXXXXXXX")"
cleanup() {
  if [[ -n "$work_dir" ]]; then
    # Only this invocation's newly created staging directory and known files.
    rm -f -- "$work_dir/database.dump" "$work_dir/photos.tar.gz" "$work_dir/SHA256SUMS" "$work_dir/deployment-identity.json"
    rmdir -- "$work_dir/docker-config" 2>/dev/null || true
    rmdir -- "$work_dir" || printf '%s\n' 'Incomplete backup directory retained for inspection.' >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$work_dir/docker-config"
docker_bound exec "$db_id" \
  sh -c 'exec env -i PATH="$PATH" PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$work_dir/database.dump"
[[ -s "$work_dir/database.dump" ]] || fail 'Backup was empty.'
verify_maintenance
# Reuse the already installed application image; no pulls, dependencies,
# application entrypoint, network, writable photo mount, or server environment.
docker_bound run --pull=never --rm --network none --read-only \
  --mount "type=volume,src=$photo_volume,dst=/backup-photos,readonly" \
  --entrypoint tar "$api_image" -czf - -C /backup-photos . > "$work_dir/photos.tar.gz"
[[ -s "$work_dir/photos.tar.gz" ]] || fail 'Private photo backup was empty.'
verify_maintenance
printf '{"schemaVersion":1,"kind":"MEDBOX_BOUND_BACKUP","bindingSha256":"%s","apiId":"%s","dbId":"%s","apiImage":"%s","photoVolume":"%s","databaseFingerprint":"%s"}\n' "$binding_sha" "$api_id" "$db_id" "$api_image" "$photo_volume" "$database_fingerprint" > "$work_dir/deployment-identity.json"
rmdir -- "$work_dir/docker-config"
(cd "$work_dir" && sha256sum database.dump photos.tar.gz deployment-identity.json > SHA256SUMS)
# Publish both files and their checksums together with one same-filesystem
# directory rename. Never overwrite an existing backup directory.
mv --no-clobber --no-target-directory -- "$work_dir" "$target"
[[ ! -d "$work_dir" ]] || fail 'Backup destination appeared concurrently; existing backup was preserved.'
work_dir=''
printf 'Database backup created: %s/database.dump\n' "$target"
printf 'Private photo backup created: %s/photos.tar.gz\n' "$target"
printf 'Verify checksums from the backup directory: sha256sum -c SHA256SUMS\n'
