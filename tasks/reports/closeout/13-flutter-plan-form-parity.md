# Flutter plan form: weekdays, inventory identity and ordinary drafts

Date: 2026-10-03 UTC. Exact implementation base: `736d7623435e2a38e3ebb51859574d43dffa0120` on `codex/flutter-ui-prototype`. This is a bounded C3/C1 implementation package, not a declaration of complete project or physical-device acceptance.

## Reproduced gaps and delivered behavior

The original production form deliberately omitted weekday editing, had no inventory selector or durable ordinary form, and enabled edit fields even when the detail response returned `canManage: false`. Three baseline-compatible production-widget regressions reproduced these failures before implementation.

The existing `AppCard`, `showAppSheet`, `choiceTile`, text fields and buttons are retained. There is no new screen flow, medical recommendation, dose/time inference, automatic inventory change or notification sending.

- Weekdays use the actual server `mon`…`sun` tokens. The short sheet supports daily or a calendar-ordered selection, requires at least one custom day, and commits only on Apply; cancellation leaves input unchanged. Fixed-time entry rejects duplicates and retains the existing six-slot maximum
- The initial date uses the server's Shanghai calendar timezone (UTC+8), rather than the device's local timezone. UTC midnight, year/month boundaries and leap day are tested. Existing explicit calendar dates are preserved, including historical dates outside the picker range; opening a picker clamps only its initial viewport. This does not synchronize a wrong device clock with the server
- Inventory selection reads the current authorized `/medicines` response without falling back to an unrelated/offline shared snapshot. It displays name, available specification/manufacturer and stable record identity, then binds ID/name only. Editing the name deliberately detaches the ID. Cancel and stale async results do not change input
- Edit drafts separately retain whether binding was explicitly changed. An unrelated dose/time edit omits `medicineId`, preserving an existing historical link even after that medicine is soft-deleted. Explicit null unlinks; a deliberate selection sends the selected ID and must still exist in current inventory. Restored explicit detachment keeps that intent
- Only manageable care profiles are selectable. Detail management permission and ended status lock edits; current profile management is re-read before a write, and the server remains the authority. Receive-only/view-only profiles cannot gain management through the form. Edit care-profile identity is immutable
- Page/repository/session/family identity, current route, draft ownership and busy state guard delayed bootstrap, pickers, reads, storage, final token lookup, submission and navigation. A newer route never receives an old form's completion navigation or failure snackbar

## Ordinary draft contract

`PlanFormDrafts` is shared with `PlanCreationOperations` through the existing `ApiPlanRepository`/`AppServices` lifetime. A local record is scoped by API URL, verified user ID, family ID and form entity (new plan or specific edit plan), with opaque owner and revision identifiers. It contains ordinary user-entered form data, never a token.

Restoration and discard require explicit choices. Autosaves are serialized, copied at invocation and fenced by owner/generation/identity. Already accepted saves can finish during ordinary navigation; identity cleanup invalidates them and the existing `IdentityLocalStore` barrier drains/removes in-flight writes. A stale or superseded page cannot save, discard, submit or clear another page's draft. Corrupt records and failed storage are surfaced and do not dispatch a protected write. Semantic decoding rejects impossible dates, invalid fixed times, duplicate/unknown weekdays and malformed field types while allowing incomplete ordinary input.

Back/system-back offers continue editing, retain draft and leave, or discard and leave. Failed retention keeps the page open. Immediate navigation, recreation and explicit restore are covered. The form's input card has stable widget identity so inserting a failed-autosave message does not sever the active text-input connection.

The existing original-operation owner remains the only creation submission path:

1. A pending original payload/key or opaque recovery marker takes precedence over ordinary editable input. Opening it never dispatches a write
2. Before a first submission, the owner freezes and drains accepted local form writes and captures their exact persisted revision
3. The original payload/key and ordinary-draft association are persisted before HTTP. Associated records use storage schema v2; v1 legacy original-operation records remain readable. An older v1-only client fails closed rather than ignoring the new association
4. After a valid immutable ACK, only the associated ordinary revision is cleared before the original key is released. Ordinary deletion/read failure retains the original operation and key, so reopening cannot restore a saved plan as a fresh-key creation
5. Late ACK and cross-page cleanup retain ownership checks. No automatic write replay is introduced; uncertain creation still needs explicit same-key retry. Existing opaque-marker inspection plus separate new-intent warning remains unchanged

A valid edit ACK likewise remains success if local cleanup or passive refresh fails. If an edit completes while covered by another route, returning shows a completed locked form with an explicit return button, rather than accepting input against a frozen stale version. A retained edit draft continues to carry the old optimistic version, so it cannot silently overwrite a newer server plan.

Edit conflicts preserve input and draft, stop blind resubmission and offer a current authorized plan inspection. Cancel changes nothing. Separately choosing current content or explicitly retaining reviewed input adopts the inspected version; only another Save writes it. Restoring an older-version edit draft starts this same review requirement. A snapshot belonging to a different care-profile identity is not applied to the current edit.

### Explicit remaining offline dependency

A transient offline failure during normal app-style recreation does not delete the saved draft. Protected writes stay disabled, and explicit restoration works after current `/auth/me` identity is verified again. Existing authentication persists only an opaque token and cached family, not a generation-matched verified API/user/family binding. Consequently this patch does **not** claim offline draft reading/editing immediately after process restart. That needs the separately queued trusted restart-identity contract; draft fields or token text are not treated as proof of ownership. A parallel identity cache, general token restart fence and export journal were intentionally not added.

## Necessary narrow API repair

`PUT /api/v1/medication-plans/:planId` previously ignored `medicineId`. The form could not truthfully detach a renamed medicine or persist a different selected record.

The existing column now has a backward-compatible optional update contract: omitted preserves the binding, null unlinks it, and a supplied nonempty UUID requires a live medicine in the current family. Validation and row locking happen inside the update transaction. Current family/membership, care-profile privacy and management grants are rechecked and held through commit, closing the stale-preflight authorization window while waiting on locks. No migration is added. Existing version conflicts, historical occurrence snapshots, and future-only invalidation semantics remain intact.

Tests verify deleted existing bindings can still be preserved by omission during a dose/time edit, cannot be explicitly rebound after deletion, and can be explicitly unlinked. They also verify same-name inventory identity, cross-family rejection, stale versions, private profiles, and actual concurrent permission/deletion contention.

Deploy the compatible API before relying on Flutter binding edits. An older API may silently ignore the new optional field; this package is not evidence of a deployed API or production migration.

## Regression and independent review

All accounts, HTTP, local storage, notification hooks and PostgreSQL records are synthetic. The real-PG runner uses isolated schemas with PostgreSQL17.10, `REQUIRE_POSTGRES_TESTS=1`, and server/tests enclosed in the same provided loopback wrapper. No owner computer, real credentials, private user files or actual notifications were used.

RED evidence:

- Original production-widget source: three behavioral failures (weekdays, inventory choice, forbidden edit controls)
- API unit: 10 initial cases, 9 failed before repair; the initial new real-PG group failed all 10 cases, including four missing-lock timeout probes. These counts are evidence cases, not ten distinct product bugs
- Independent review reproduced two interrupted UI failures introduced during implementation: a stale medicine-load flag after repository replacement, and a covered-page edit ACK returning to editable fields backed by a frozen handle. Both fixes have permanent production-widget tests
- A production-widget local-storage-failure regression additionally exposed loss of the active text-input connection when an error card was inserted. Stable field-card identity fixes it; the unchanged retry interaction now passes

Independent read-only final review passes focused Flutter79/79 (including three separately written widget probes), API11/11 and strict real-PG lifecycle23/23, with no remaining blocking finding in the reviewed source. Its copied production sources match the final worktree, and analyzer/diff checks pass. Final candidate gates and independent replay results are recorded below. No commit, push, merge, deployment or remote CI execution is claimed by this package. The independently replayable patch and per-file base/result SHA-256 manifest accompany the handoff.

## Final gates

- Flutter production form parity: 25/25; ordinary draft repository/operation integration: 28/28
- Full Flutter: 321/321, exit0; analyzer: no issues, exit0
- Root lint/typecheck/build: exit0
- Full Node: mini220/220, API382/382, tooling6/6; no skips
- Strict PostgreSQL: 12 suites,150/150; no skips
- Focused API: unit11/11; real-PG lifecycle23/23
- Diff whitespace: pass
- Official WeChat compiler: SKIPPED, developer tools unavailable; wrapper exit0 is not an official compiler pass
- Local Android debug APK: exit1, `No Android SDK found`; no APK produced and no configured/signed release or device test is implied

Executed commands: `flutter analyze --no-pub`; `flutter test --no-pub --reporter expanded`; focused `test/plan_form_parity_test.dart`, `test/plan_form_drafts_test.dart` and existing `plan_creation_*` tests; `flutter build apk --debug --no-pub`; root `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, strict `npm run test:integration`; `npm run check:miniprogram`; `git diff --check`.

## Limits and status

Source/repository/widget evidence only. Physical Android keyboard/storage/process-kill/update behavior, real notification permission/delivery, official WeChat compilation, two-account/two-device trial, independent HTTPS deployment and configured/signed candidate acceptance remain external gates. SharedPreferences accepted writes and tested failures do not prove hardware durability or secure erasure. The project remains PARTIAL; the offline restart-identity dependency above must remain visible in subsequent closeout work.
