#!/usr/bin/env bash
# Independent VM/process checks; every path is created by this synthetic runner.
set -euo pipefail
cd "$(dirname "$0")/.."
fixture=''
trap 'if [[ -n "$fixture" ]]; then rm -r -- "$fixture"; fi' EXIT
for scenario in ready partial handoff; do
  fixture=$(mktemp -d "${TMPDIR:-/tmp}/medbox-export-process-synthetic-XXXXXX")
  printf synthetic-only > "$fixture/synthetic-fixture"
  target=recover-ready
  [[ "$scenario" != partial ]] || target=retain-partial
  for phase in "seed-$scenario" "$target"; do
    flutter test --no-pub test/export_restart_process_boundary_driver.dart \
      --dart-define="MEDBOX_EXPORT_FIXTURE=$fixture" \
      --dart-define="MEDBOX_EXPORT_PHASE=$phase" --reporter expanded
  done
  rm -r -- "$fixture"
  fixture=''
done
