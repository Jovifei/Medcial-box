#!/usr/bin/env bash
set -euo pipefail
backup="${1:?Usage: verify-backup.sh /absolute/path/to/backup.dump}"
[[ -s "$backup" ]] || { printf '%s\n' 'Backup is missing or empty.' >&2; exit 1; }
name="medbox-restore-$(date -u +%Y%m%d%H%M%S)-$$"
created=0
cleanup() { if [[ "$created" == 1 ]]; then docker rm -f "$name" >/dev/null; fi; }
trap cleanup EXIT
password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
# No published port, no network, no persistent volume. Cleanup targets only
# the container successfully created by this invocation.
docker run -d --name "$name" --network none --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_USER=restore_user -e POSTGRES_DB=medbox_restore \
  -e POSTGRES_PASSWORD="$password" postgres:17-alpine >/dev/null
created=1
ready=0
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U restore_user -d medbox_restore >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { printf '%s\n' 'Restore database did not become ready.' >&2; exit 1; }
docker exec -i "$name" pg_restore -U restore_user -d medbox_restore \
  --exit-on-error --single-transaction --no-owner --no-privileges < "$backup"
docker exec "$name" psql -U restore_user -d medbox_restore -v ON_ERROR_STOP=1 -c \
  "SELECT 'medicines' AS entity, count(*) FROM medicines UNION ALL SELECT 'medicine_batches', count(*) FROM medicine_batches UNION ALL SELECT 'families', count(*) FROM families;"
printf '%s\n' 'Backup restored successfully into an isolated disposable database.'
