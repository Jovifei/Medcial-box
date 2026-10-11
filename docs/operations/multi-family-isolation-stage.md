# Family pilot integration — remote execution 2026-10-11

Baseline: 0fdacc0138f5bac6bc8476eb3f1f54c88908385c, including PR4 work. No main merge/deployment/device operations.

Selection is scoped to sessions.active_family_id. A single-membership new session inherits that household; multiple memberships require explicit choice. Create and confirmed invitation acceptance select the target only for that session. Requests freeze x-family-id at dispatch and validate membership each time. Other devices keep their selection. No household count limit is introduced.

Legacy 032/033 filenames and checksums are retained because a synthetic upgrade may have applied them. 032_repair removes the UNIQUE constraint before the historical index drop; 034 retires the global flag, initializes unambiguous sessions and enforces unique (family,user). Rerun uses migration receipts. No household/health rows are moved or removed.

Invite consumption and acceptance lock the invitation and household in one transaction. Consumer retry returns its membership; an already-member acceptance never consumes a different unused code. Expired/consumed by another user is rejected. Leave/removal preserve other households; existing owner transfer and care handover rules remain.

Mini request epochs and household namespaces preserve drafts and fence delayed photo/recognition/401 results. All non-tab pages use shared document-flow navigation and existing dirty-draft save guard. Four native tabs remain. Invitation target takes priority over owner UI. Flutter selection reuses identity cleanup, cancels reminders/exports, clears current snapshots and retains household-keyed input.

Delivery integration reuses CI verify, strict isolated PostgreSQL, existing exact mini QA, lifecycle tests and test-staging-backup-docker. Artifact verification reads actual files/hashes, compares complete database content/ownership and restored photo bytes, and binds current SHA/root/mini trees and build image. Empty/missing/corrupt evidence fails. It qualifies SYNTHETIC only, never production restoration.

Execution so far: lint/typecheck/source gate and local Node/mini/tooling tests ran. PG/Flutter/Docker are CI gates, not local PASS claims. Windows bound_report.py was actually attempted and is NOT_RUN (path absent). No other agent identity or revision was used.

Remaining real environment gates: true OAuth/two accounts and devices; actual private photos/model accuracy; notifications, native capability/UI acceptance; formal signing/API compatibility and data-preserving install; production paired restoration. Plan-revocation race group remains BLOCKED/NOT_RUN and is not bypassed.

Independent implementation review: fixed obsolete global selection, targeted leave, composite uniqueness, modal identity guard, binary photo request scope, and full-file verifier failure cases. Final CI and exact receipt are recorded separately at the frozen PR SHA.
