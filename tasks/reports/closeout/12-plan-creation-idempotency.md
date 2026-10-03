# Plan creation: explicit retry identity and immutable acknowledgements

Date: 2026-10-03 UTC. Exact implementation base: `517dbf2d9369d781c5b86736a0266eafb99abaf0` on `codex/flutter-ui-prototype`. The later parent `895cdf521ae7cc46a9c46d8bc4f2a17775b7bd85` changes project evidence only, not this implementation base. This report covers the bounded C1 creation-reliability gap; weekday/inventory/durable ordinary-form UX remains a separate work package.

## Defect and contract

An accepted plan-create POST could lose its response. Both clients previously omitted an operation key, so an explicit retry created another plan. Flutter additionally waited for notification refresh and a detail GET after the POST; failure in either could be reported as a failed creation.

`POST /api/v1/medication-plans` now accepts optional body `idempotencyKey`, matching the existing medicine-create compatibility pattern `[A-Za-z0-9_-]{16,128}`. Omission preserves legacy independent creation. An intentionally new plan uses a new key, even if its content is identical.

Migration `028_medication_plan_create_receipts.sql` adds a `(family_id, user_id, request_key)` primary key, payload SHA-256, immutable JSON response and timestamp. No earlier migration is edited. A namespaced transaction advisory lock serializes same-scope attempts. Plan, all slots and receipt commit or roll back together.

Hashing uses the accepted meaning: explicit fields, trimmed text/date/IDs, lowercase UUID text, equivalent absent/blank optional values, calendar-ordered unique weekdays, default full week and sorted times. The key and ignored fields are excluded. A reused key with changed accepted content returns HTTP409 `VERSION_CONFLICT` without a second write.

Identical replay returns the complete original HTTP201 body `{planId, careProfileId, status: "active", version: 1}`. Current family membership and active profile management/private-profile permissions are rechecked inside the transaction before either creation or replay. Their rows/grants are locked through commit. A new creation also requires its bound medicine to exist in the same family and not be deleted. A committed receipt is still replayable after that medicine is later soft-deleted: replay acknowledges the original operation and does not make a new medicine binding. Revoked profile management remains denied.

The frozen response is a creation receipt, never current plan detail. Later edits, pauses and versions are obtained through normal authorized reads; neither client synthesizes a current plan from the old payload.

## Mini-program

- A separate user/family-scoped operation record stores the original payload/key before dispatch. Failure to store prevents the POST. Normal form drafts, cancellation, explicit discard, unload and remount cannot replace this record
- An explicit same-form submit or “重试原提交” retries the exact original operation. Changed form input cannot silently create a new request while the old result is unresolved. Retry without an operation does not create one. No background/offline replay is introduced
- Page lifetime, visibility, API identity generation and family scope are checked after login, reads and HTTP completion. Old or hidden pages cannot dispatch or navigate; resuming a hidden page permits an explicit retry
- An immutable valid ACK remains a known success despite ordinary draft/operation cleanup errors. The acknowledged operation remains until its associated ordinary draft is cleaned, so a saved draft cannot reappear with a fresh key. Ownership checks prevent a late ACK from deleting/replacing a newer pending operation or draft
- Existing update-save draft guards use the same operation path. Guard cleanup is ownership-aware so an old page cannot clear a newer page's guard
- Records use the existing scoped mini-program local-storage convention. This does not claim secure erasure or physical-device crash/recovery guarantees

## Flutter

The production repository/form uses a dedicated `PlanCreationOperations` owner shared through `AppServices`, rather than treating a mutable form draft as a retry identifier. The operation scope includes API URL, authenticated user and family. Pending creation restoration is read-only; explicit retry retains the original key/payload. First-attempt definitive validation rejection can release an intent; a rejection after an uncertain attempt cannot prove the earlier write absent.

Private operation payload follows the existing family/session cleanup. Only an opaque scope/key marker may survive that boundary. It contains no medicine, dose or profile payload. If the original payload is gone, the old action cannot be replayed. Recovery requires a current successful all-status plan-list inspection followed by a separate warning/confirmation that the earlier request may already have saved or may still finish later. Cancellation/reopening preserves the marker; an in-flight local request cannot be retired. Confirming recovery authorizes a deliberate new intent and abandons retry correlation; it is not a guarantee against duplicates. Original-payload retry remains the default whenever available.

The repository preserves the acknowledged-mutation hook and family-cleanup identity semantics. Notification refresh runs after acknowledgement without holding the form in a saving state; notification/detail refresh failures do not reverse an acknowledged creation or issue another create. The form also checks page/repository/session/family identity around awaited token/storage/HTTP work and suppresses stale navigation.

SharedPreferences reported `false` and thrown write failures are treated as storage failures before dispatch. This is a tested adapter contract, not proof of hardware durability, arbitrary process-kill recovery or OS storage guarantees. Storage corruption and unreadable original intent fail closed.

## Evidence and review

All accounts, HTTP, local storage, notification adapters and PostgreSQL records are synthetic. PostgreSQL uses owned isolated test schemas and the loopback PostgreSQL17.10 wrapper, with server/tests executed in one network namespace and `REQUIRE_POSTGRES_TESTS=1`. No credentials, production data or actual notifications were used.

RED evidence:

- On the exact original backend: 11 unit cases, 2 pass/9 fail; PG26 reported failures include direct duplicate/conflict/permission failures, missing migration and contention checks that cannot succeed without the new locks. These are not 26 distinct product bugs
- On the exact original mini page: 13 new behavior probes fail, including missing retry entrypoint, absent key, stale dispatch and lost-operation persistence
- Independent review reproduced selective ordinary-draft deletion failure after receipt deletion: ACK → remount → restore produced a second key. The formal regression now retains ACK and produces only one POST
- Parent review identified the linked-medicine deletion replay risk; dedicated regression tests reproduced it. The dedicated unit and real-PG cases now replay the original result while rejecting a new creation
- On exact original Flutter production source, five baseline-compatible regressions fail for behavioral reasons: missing key, notification/detail failures reversing ACK, and real production forms remaining unsaved after ACK. Corrected viewport fixtures were used; an earlier harness-only failure is not counted as defect evidence

Final candidate qualification:

- Root lint, typecheck, build and tooling6 pass
- Mini-program: 220/220 pass
- API: 356/356 pass, no skips
- Strict PostgreSQL: 12 suites, 135/135 pass, no skips
- Focused backend: unit12/12 and real-PG27/27
- Flutter: new focused41/41; full268/268; analyze reports no issues, all exit0
- `git diff --check` passes
- Official WeChat compiler: SKIPPED, developer tools absent; wrapper exit0 is not an official compile pass
- `flutter build apk --debug --no-pub`: exit1, `No Android SDK found`; no APK produced

Independent read-only review passes API12/12, real-PG27/27, mini25/25, Flutter41/41 plus four separate adversarial probes, and Flutter analyze. It includes selective mini cleanup/remount, marker-read failures, partial storage/restart, and cancelled/stale recovery boundaries. Its reproduced defects are fixed and retained as regressions. Final exact-base replayable patch and changed-file base/result SHA-256 manifest accompany the handoff.

## Executed gates and follow-on integration

- Root: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:integration`, each with its own exit receipt. The full root tests and integration runner ran inside the supplied synthetic PostgreSQL wrapper, with no skipped PG cases
- Mini focused: `node --test apps/miniprogram/test/plan-create-idempotency.test.mjs` (25/25)
- API focused: `node --test apps/api/test/plan-create-retries.test.mjs` (12/12), and the corresponding `integration-pg-plan-create-retries.test.mjs` under the strict wrapper (27/27)
- Flutter: `flutter analyze --no-pub`; `flutter test --no-pub --reporter expanded`; four new focused `plan_creation_*_test.dart` files; `flutter build apk --debug --no-pub`
- Diff: `git diff --check`; official mini check: `npm run check:miniprogram` (explicitly SKIPPED)

The separately planned ordinary Flutter form draft must keep `PlanCreationOperations` as the shared operation owner. Pending original intent takes precedence over editable drafts and remains locked for explicit retry. Ordinary draft storage must not replace the original key/payload or opaque marker. After acknowledgement, clear or stamp an associated ordinary draft before allowing it to be restored as a fresh-key creation, preserving the selective-cleanup regression established on mini. This patch does not add general Flutter form drafts, weekday editing, or inventory selection.

## Rollout and limits

Apply migration028 and deploy the API before keyed clients. Older API versions do not promise keyed deduplication merely because a client sends the new field. No automatic retry queue, dose/stock automation, clinical advice, new provider integration or real notification sending is added.

This patch is source/test evidence only. Physical Android storage/notification behavior, arbitrary process death, real WeChat compilation, account/device trial, deployment and production migration remain separate acceptance. No push, merge or deployment was performed by this work package. The overall project remains PARTIAL.
