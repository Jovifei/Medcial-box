# Definitive family/session notification cleanup

## Scope

This separate Flutter closure builds on the generic receive-only Android reminder projection and the owned export-temporary-file cleanup closure. Exact parent: `e073761bea5a4193209c3bdfed2005df7ba41e6b` (published export cleanup); its parent is `abec40aa13f55dbe139ebc79f61360dbffff0818` (receive-only reminders). It does not change API authorization, replay writes, send external notifications, or claim Android device release readiness.

Authoritative membership loss now follows the existing authenticated family setup flow while retaining the current login. The cleanup boundary accepts only a current authenticated 404 `FAMILY_NOT_FOUND`, or a current successful `/auth/me` response with a nonblank user identity, explicit boolean `hasFamily: false`, and explicit `family: null`. Missing, malformed, contradictory, unsuccessful and stale responses are not treated as membership loss.

## Changes

- `ApiClient`: exact family-loss callback; post-await identity-epoch recheck on the response token lookup (401 and family loss); full overlapping-cleanup barrier that drains newly added work; bounded explicit retry after cleanup failure; serialized auth/family acceptance transitions
- `ApiAuthRepository`: validate current membership shape before changing local state; reject old successful profile responses; serialize create/join with login/logout; wait for preceding cleanup
- `AppServices`: invalidate pending reminder refreshes, drop inventory memory and private family storage, cancel all old stock/dose alarms and run the owned-export identity cleanup hook; family loss preserves the access token
- Router: family-unavailable routes to `/family-choice`; actual session invalidation retains precedence and routes to `/connect`; explicit create/join resets the family routing signal
- Logout: global completion signal preserves login routing even when the original screen is disposed; current 401 still attempts credential deletion when unrelated native cleanup fails
- Boot gate: relies on the guarded cleanup owner rather than directly deleting a token on a stale 401 or clearing storage from an unvalidated default value
- Reminder refresh: a failed passive read preserves the valid saved projection; an acknowledged write clears only the originating identity’s dose projection before refresh; a successful empty projection removes revoked dose alarms without deleting current family stock/cache
- Navigation prerequisite: the cabinet and plans floating action buttons have distinct stable Hero tags; no broader layout or animation changes

## Evidence

All probes use the actual Flutter AppServices, API client and repositories with synthetic HTTP, notification-channel and in-memory storage adapters. They do not access real users, credentials, records or devices.

On original published base `293a5c7dec159b191e707c4393b15c48e61b175c`, the independent compatible red probe has three assertion failures: old stock alarms survive definitive `FAMILY_NOT_FOUND`; old alarms survive explicit successful no-family profile; a delayed second token lookup permits an old 401 to invoke cleanup after an epoch change. Four negative controls pass.

The full real-app home → family-choice → explicit create → home probe also found duplicate default floating-action-button Hero tags. Before the two-tag repair it failed with actual Flutter Hero assertions; the unchanged real routing topology passes after the repair.

Focused coverage includes current family/session loss, token preservation, explicit create/join recovery, old 401/404 response and second-token-read races after same-token family acceptance, current and malformed auth/me responses, old successful auth/me responses, shared auth/family serialization, cleanup cancellation ordering, valid transient reminders, successful care-grant-only dose removal, and BootGate stale-401/new-token preservation.

Independent review additionally reproduced malformed profile mutation, rejected cleanup barriers, missed overlapping/late-added cleanup work, stale alarms after acknowledged dose writes, and slow-logout routing. Those exact probes are retained alongside persistent failure/retry, initialization retry, storage retry, same-process token-deletion failure and owned-export cleanup integration tests.

## Final qualification receipts — 2026-10-03 UTC

- Focused: `flutter test --no-pub --reporter expanded test/family_cleanup_failure_test.dart test/family_notification_cleanup_test.dart` — **44 passed, 0 failed**
- Full Flutter suite on the combined generic-reminder + owned-export + family-cleanup source: `flutter test --no-pub --reporter expanded` — **227 passed, 0 failed**
- `flutter analyze --no-pub` — **No issues found**
- Independent reviewer’s separate nine adversarial probes — **9 passed, 0 failed**
- `git diff --check` — **passed**

Toolchain: Flutter 3.47.6 / Dart 3.13.5. Patch and per-file hashes are also recorded in the accompanying handoff manifest.

## Limits

These are source, unit and widget integration checks. Native notification delivery, OS alarm cancellation behavior, secure storage, process death/restart, physical-device background launch and two-device membership changes remain device acceptance work. The export cleanup retains its separately documented ownership and native-handoff limits. If both server revocation and secure-storage token deletion fail, the in-process route stays signed out; a retained credential across a later process restart remains a pre-existing separate limitation. No APK/WeChat production release, push, merge or deployment was performed by this closure.
