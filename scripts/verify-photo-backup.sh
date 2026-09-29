#!/usr/bin/env bash
set -euo pipefail

archive="${1:?Usage: verify-photo-backup.sh /absolute/path/to/medbox-photos.tar.gz}"
[[ -s "$archive" ]] || { printf '%s\n' 'Photo archive is missing or empty.' >&2; exit 1; }
restore_dir="$(mktemp -d)"
trap 'rm -rf -- "$restore_dir"' EXIT

tar -tzf "$archive" > "$restore_dir/archive-list.txt"
while IFS= read -r entry; do
  case "$entry" in
    /*|../*|*/../*|*/..)
      printf 'Unsafe path in photo archive: %s\n' "$entry" >&2
      exit 1
      ;;
  esac
done < "$restore_dir/archive-list.txt"

tar -xzf "$archive" -C "$restore_dir" --no-same-owner --no-same-permissions
file_count="$(find "$restore_dir" -type f ! -name archive-list.txt | wc -l | tr -d ' ')"
printf 'Photo archive restored into an isolated temporary directory; files=%s\n' "$file_count"
