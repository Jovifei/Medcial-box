# Flutter history correction: scoped verification

Date: 2026-10-03. This closes the Flutter history correction UI gap from the v1 closeout C3 scope and the dual-client design section 6. It does not mark the whole project, deployment, Android device validation, or family trial complete.

## Scope and permission decision

- The existing history API already returns occurrence snapshots, ordered confirmation events, current status, and the superseded flag. The existing confirmation API appends `taken` / `skipped` events and prevents a fresh write to a superseded occurrence.
- The backend confirmation route currently requires `canView`, while Flutter `PlanDetail` describes `canManage=false` as read-only. This patch deliberately preserves the narrower Flutter UI contract: corrections require a successful current plan-detail read with `canManage=true`. A failed permission lookup leaves authorized history readable and hides correction controls. This is a UI restriction, not a new backend authorization rule.
- Only non-superseded records already marked taken or skipped offer a new correction. Unconfirmed occurrences continue through the schedule flow. Ended plans retain their historical records and management-gated correction entry.
- Each new correction needs an explicit dialog showing the original occurrence date/time, medicine and manually entered dose snapshot, previous status and chosen status. Cancel, back, and repeated dialog actions do not write twice.
- The client never edits original snapshots or previous events, infers a dose, deducts inventory, or adds a clinical rule. It reads the authoritative history again after acknowledgment.

## Shared operation prerequisite

Apply after the dose-confirmation retry patch. This patch imports its `DoseConfirmationOperations` helper and uses the narrow `ApiPlanRepository.confirmDose(onConfirmed:)` acknowledgment callback; neither owned source file is duplicated here.

- The helper retains an uncertain operation key in memory per API identity. Page remount and a read refresh do not replay or discard an uncertain write.
- A user-triggered retry keeps the original action and key. A different correction remains unavailable until the original operation resolves.
- A validated server acknowledgment clears the operation before downstream change-notification/synchronization callbacks. A failed dependent sync is therefore reported as saved with incomplete sync, never as an uncertain new write.
- The current server projection wins if another member changed the record after the original request. Retry responses are not assumed to match the requested action.
- Acknowledged writes followed by a failed history read expose refresh, not a write retry or stale correction controls.
- An explicitly denied or superseded occurrence stops offering further writes on the current page. The helper conservatively retains uncertain keys, rather than manufacturing a new operation after an error.
- A remounted page observes in-flight completion; any history read that overlaps a shared operation change is discarded and re-read. Old identity responses cannot restore old history or show a success notice.

## Files

- `apps/flutter/lib/features/plan/plan_history_page.dart`
- `apps/flutter/test/plan_history_correction_test.dart`
- `apps/flutter/test/plan_history_repository_regression_test.dart`
- This report

No API route, database migration, shared model, credential, real medication data, deployment configuration, or notification provider was changed.

## Executed verification

The isolated Linux Flutter workspace used the provisioned Flutter 3.47.6 / Dart 3.13.5 SDK and the verified existing font asset. All HTTP tests use synthetic identities/records and MockClient through the production ApiPlanRepository.

- RED: same final focused tests and shared-operation prerequisites, but the original read-only history page: 4 passed / 19 failed, exit 1. Failures are missing correction/permission behavior, not compilation errors.
- GREEN: 20 widget + 3 repository tests passed, exit 0.
- Initial combined Flutter suite with committed care-contract source/tests and the then-current retry prerequisites: 110 tests passed, exit 0.
- `flutter analyze --no-pub`: no issues, exit 0.

Widget coverage includes both correction choices/cancel; duplicate entry and confirmation callbacks; append-event success and original snapshot/event preservation; a later correction receiving a fresh key; read-only and failed permission reads; pending/superseded no-action states; API forbidden/superseded rejection; accepted-but-lost explicit retry; another member's newer state during replay; remount and in-flight navigation; stale overlapping reads; dialog back; identity changes; dependent sync failure after acknowledgment; failed history refresh after acknowledgment; 320-pixel layout with 2x text.

Repository coverage checks the exact occurrence/action/key payload, immutable snapshot and ordered-event round trip, and propagation of forbidden/superseded errors without acknowledgment or mutation notifications.

## Review and remaining validation

- The API `canView` versus UI `canManage` distinction remains intentional and visible; changing backend permissions needs separate contract review.
- Server append-only/idempotency guarantees are exercised here through deterministic HTTP fixtures, not a new live PostgreSQL proof. The API route itself is unchanged; existing strict integration gates remain required for the combined candidate.
- The earlier 110 count includes 76 baseline/care tests, 11 retry tests and 23 history tests. Final retry qualification subsequently added the deferred-token identity regression. Neither count is an APK/device/provider gate.
- History still uses the existing server default record limit. No new paging, automatic correction, background write replay, or broader product behavior was added.
- No APK build, real device, WeChat account, actual reminder delivery, or production deployment is claimed by this report.

## Independent final integration

Replayed only this four-file patch on the clean published retry commit `045d5c8b198a94b40ff7b3ca63bfb8f9f826fdb3`. Independent `flutter analyze --no-pub` completed without diagnostics and the full suite passed 111/111: 76 baseline/care, 12 final retry, and 23 history tests. Patch and whitespace checks passed. The unchanged mini-program/API/tooling source retains the parent's immediately preceding strict results (195/307/6, zero skips); it was not unnecessarily re-executed for this Flutter-only history change. Official mini compilation, APK and real-platform/device acceptance remain separate gates.
