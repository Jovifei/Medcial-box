# Receive-only Android reminder contract closure

Date: 2026-10-03 UTC. Exact reviewed base: `293a5c7dec159b191e707c4393b15c48e61b175c` on `codex/flutter-ui-prototype`.

## Documented decision

The 2026-10-02 project-closeout plan C1 requires current membership/care authorization. C3 explicitly separates view/manage permissions from receiving reminders, requires explicit channel opt-in, authoritative future-seven-day instances, and authenticated notification taps. The 2026-10-01 dual-client plan sections III.3 and III.5 require private linked profiles, independent reception, and generic notifications.

The existing normal schedule is correctly view-protected. It must not be loosened for a receive-only caregiver. The existing WeChat `recipientIdsFor` and Android `receivesAndroidDose` rules already allow the effective responsible person or a separate receive grant. This change closes Android scheduling's dependency on full-detail access without changing those permissions.

## Minimal contract and permission matrix

`GET /api/v1/medication-plans/reminder-schedule` accepts no query parameters. The server owns the seven Shanghai calendar dates, today through today + 6, and returns only still-future, active, pending authoritative occurrences.

Exact top-level keys: `startDate`, `endDate`, `timezone`, `entries`. Exact entry keys: `occurrenceId`, `date`, `time`, `label`. The only label is `有一项用药安排待确认`. No plan/profile identifier, patient name, medicine name, dosage, status history, or confirmation events are projected. Responses use `Cache-Control: no-store`.

Every row requires a current membership in the exact family and explicit `android` notification channel selection:

| Profile/account relationship | Generic reminder projection | Full schedule/detail/history |
|---|---|---|
| Linked private profile's own account | Yes, after channel opt-in | Existing own-account authorization |
| Any other account, including family owner, for linked private profile | No, even if a malformed historical grant exists | No |
| Unlinked profile's effective responsible person (`managed_by` else `created_by`) | Yes, after channel opt-in | Existing responsible-person authorization |
| Receive-only grant (`receiveDoseReminders=true`, view/manage=false) | Yes, after channel opt-in | No |
| View-only or delegated manage grant, reception=false | No | Existing read/manage authorization unchanged |
| View/manage and reception grant | Yes, after channel opt-in | Existing read/manage authorization unchanged |
| No current membership, other family, missing/disabled Android channel | No | Existing authorization unchanged |

Generation reuses `materializeDoseOccurrencesForDate` with an optional Android recipient scope. The existing unscoped scheduler call remains unchanged. Both generation and the final SELECT check recipient eligibility; the final SELECT also checks current profile/plan/slot lifecycle, date/weekday/time, supersession, and confirmation state. Deterministic real-PG probes revoke the grant, withdraw the channel, or remove membership after authentication/materialization but immediately before this final read and require an empty response.

## Flutter and navigation

The repository fetches this single bounded projection. A dedicated `DoseReminderEntry` contains only occurrence/date/time; local notification titles and bodies stay generic (`用药安排提醒`, never wording that tells a caregiver to take medicine). Alarm payloads contain a version, date, and opaque occurrence ID, never a plan ID or private text.

The app router owns notification callbacks, replacing the My-tab-owned callback. On a tap, the normal synchronization callback refreshes current reminder eligibility, then a fresh protected date schedule resolves the occurrence, and a fresh protected detail request rechecks view authorization before navigating. Receive-only, revoked, missing, malformed, and legacy plan-ID payloads fail closed to an authenticated generic screen. Expired credentials and missing-family responses use their existing authentication/family routes. Identity epochs, latest-tap sequencing, disposal, buffered cold starts, and reset-time launch callbacks prevent stale navigation.

A current care-reception revocation empties dose alarms while retaining unchanged stock alarms. No view/manage grant is written or widened. No recurrence or dose rule is computed on the client.

## Actual verification

All data and notification adapters are synthetic; PostgreSQL uses a fresh owned test schema and loopback PostgreSQL 17.10, never production records or real external notifications.

- RED on clean exact base: API projection tests fail on the absent endpoint; the real-PG matrix fails on the absent endpoint; the corrected UTF-8 repository fixture fails because the old repository reads the full schedule and expects its date shape
- Additional RED: reset-time cold-launch callback reached a bound handler with an old payload; GREEN suppresses callbacks only during identity cleanup
- GREEN root lint, typecheck, build
- GREEN root tests under strict PostgreSQL: mini 195, API 317, tooling 6; no skipped tests
- GREEN strict PostgreSQL integration: all 11 suites, 108 tests, zero skipped
- GREEN Flutter analyze and 127 Flutter tests
- `git diff --check` passes
- Official mini compiler check: SKIPPED because WeChat DevTools is absent, despite wrapper exit code 0
- `flutter build apk --debug`: BLOCKED, exit 1, Android SDK absent

## Remaining external limits and integration notes

This is a tested source candidate, not an APK or release approval. Android device permission, cold launch/background/lock-screen delivery, reboot recovery, and two-account/two-device flows still need real device evidence. Real WeChat templates/providers, deployment, and production platform validation remain outside this change. Offline phones still use their last synchronized alarms; remote revocation cannot instantly reach an offline phone.

Deploy the new API contract before the corresponding Flutter client. A failed refresh retains no newly unauthorized dose projection; there is no fallback to the private full schedule for local scheduling.

The pre-existing broader family-loss path clears dose schedules but can retain stock alarms; that issue was reported separately for independent cleanup. This patch does not edit `AppServices` or broaden family/stock behavior. The separate export/family-cleanup patches must preserve this app-level tap binding and the minimal reminder DTO.

No push, merge, deploy, new navigation tab, migration, dependency, production account access, or actual notification transmission was performed.
