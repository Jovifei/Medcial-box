# C4 forward-only export ownership journal: bounded local recovery

Date: 2026-10-03 UTC. Exact final integration prerequisite: `e602bb2c4786075a3d01845d3c554290c374532e` (qualified restart identity, Flutter479). Standalone development and RED base: `e053162a445dcbb0df674e97aeb2b7d84c16c5aa`. This is a separate local, unpublished 17-file export delta. The independently replayable patch and per-file base/result SHA-256 manifest accompany the handoff. Neither prior source tree is modified.

## Scope and deliberate limit

This package carries exact generated ownership metadata across ordinary process recreation. It does **not** claim full abrupt-write cleanup or complete C4 delivery. Only an unchanged empty registered original or a completed original matching committed ownership evidence can be recovered automatically. An interrupted changed/partial file, or complete bytes whose ready commit did not finish, remains registered and preserved as ambiguous. It must not be adopted or deleted by filename prefix, content guess, file age, or a mutable access-time marker.

No FFI, native inode bridge, hardlink witness, atime markers, chmod, platform permissions, imported restore-file deletion, plugin-cache cleanup, external recipient recall, or broad recursive cleanup is added. Private content stays in the platform app temporary directory. The separate application-support file `medicine-private-state/export-ownership.v1.json` contains a bounded version, generated process/entry IDs, generated relative components, conservative ownership fingerprints, and the completed-file SHA-256 digest. No credentials, user/family/medicine IDs, medication content or absolute paths are persisted there.

The file-backed state helper is the frozen identity package's `PrivateAtomicState` prerequisite (SHA-256 `f4dade5db6e0a12d70e3dee4b179271e8b7b73c5f8c1d94cbf1812db4d83f975`). It was copied into the standalone checkout only for compilation and is supplied unchanged by the final identity base; it is not an export-owned patch file. Its sibling-temp/flush/rename commit targets ordinary process restart, without a directory-fsync or universal power-loss promise.

## Behavior

- One default application UI-isolate process coordinator owns all stores' live writes, identity epoch and native handoff lease. Store/service recreation cannot trigger death recovery of a live write, release a still-pending native share, or admit overlapping native shares
- Each export gets an exclusively-created random directory, random basename, empty original and nonsecret marker. The exact ownership record commits before the private-byte writer is invoked. Failed or uncertain registration never falls back to an unregistered content write
- A successfully settled writer validates the actual bytes against the requested payload and commits completed-file stat and SHA-256 evidence before returning an export. Same-process partial failures drain and clean their known original, while failures with changed directory-entry evidence retain/report the ambiguity
- During the awaited writer, a directory modified/change-time snapshot detects ordinary basename replacement and unexpected directory-entry changes. Such objects are never promoted to ready ownership. This is conservative portable evidence, not immutable inode identity or protection against a compromised same-UID process forging metadata
- Recovery validates bounded canonical JSON and strict schema/types/generated components before deriving anything beneath the current trusted temporary root. Unknown keys, versions, duplicate records/JSON keys, traversal, absolute paths, noncanonical JSON, unsafe entity types and changed marker/file evidence fail closed
- Cleanup touches only the registered original and marker. It rejects substituted files/directories/links, preserves unexpected siblings, and only removes an owned directory nonrecursively when empty. A failed delete/unregister retains retryable ownership; missing exact paths make a later unregister idempotent
- Native preflight checks ready-file stat, streaming SHA-256 digest and marker evidence. After all preflight awaits it repeats membership, identity, page-current and active-lease guards, then dispatches without another await. A completed selection/cancellation/unavailable native result is preserved when local cleanup fails, with cleanup reported separately
- Only a live in-memory native lease can pin an original. No persisted sharing flag can keep an ended process's completed original forever

## Dependency and attribution

`crypto: 3.0.7` is promoted from an already-locked transitive package to an exact direct pin, solely for the standard streaming SHA-256 implementation. Offline resolution changes only the lock entry's dependency classification; no package version, archive digest or other dependency changes. The unchanged archive SHA-256 is `c8ea0233063ba03258fbcf2ca4d6dadfefe14f02fab57702265467a19f27fadf`.

Upstream: Dart project authors, `https://github.com/dart-lang/core/tree/main/pkgs/crypto`, BSD-3-Clause (copyright 2015, the Dart project authors). The package-managed upstream LICENSE and attribution remain intact; no cryptographic implementation is copied or invented. The digest is integrity evidence, not encryption, an inode identifier, or a defense against compromised same-UID code. It is never logged alongside private bytes.

## Startup and identity integration contract

`initialize()` completes before a new export's preparation and is shared within one coordinator. It attempts all safely recoverable old entries and returns typed issues for the remainder: ambiguous ownership, failed cleanup/unregister, unavailable/corrupt journal, or unavailable root. A successful recovery runs once; a failed one is retryable and never overwrites unreadable/corrupt metadata.

`create()` and `handoff()` await shared initialization and refuse new file export/sharing while unresolved issues remain. `resetForIdentity()` synchronously advances the live identity epoch and drains only this process's known-live files; it does not adopt or silently claim removal of older ambiguous objects.

AppServices now starts the one shared `recoverForStartup()` attempt in all configured, demo and configuration-error branches without awaiting it in the authentication gate. Its immediate background error handler stores typed export-only issues and prevents unhandled errors. The exposed `exportRecovery` Future means only that the attempt settled; `exportRecoveryIssues` must be checked before describing cleanup as successful. A recreated store/service shares the same coordinator and startup Future. An explicit later export retries initialization; a successful retry clears the issues.

Old ambiguous objects therefore cannot trap login or safe non-export work. They remain registered, preserved and specifically reported when a new export is attempted. Existing export-page error handling displays the typed explanation, and another explicit export action is the bounded retry. No broad deletion or unsupported manual-cache remedy is suggested. Known-live write and deletion failures continue through the original awaited identity-cleanup barrier and still block replacement-credential acceptance. No export-startup issue is silently treated as successful cleanup or substituted for an authentication failure.

Existing filesystem fixtures now inject their own process coordinator and synthetic journal. The prior symlink-deletion expectation is strengthened to retention; the native dispatch-order fixture now asserts that a same-turn identity reset during asynchronous evidence preflight prevents dispatch. The final adapter-level synchronous guard remains covered. Interrupted widget writes pump the widget clock before waiting for real IO; a separate real-async production AppServices test verifies logout drains the write without a cleanup cycle.

## Final qualification receipts

All filesystem roots, accounts, payloads and failures are synthetic. No actual user files, tokens, OS share UI, notifications, recipients or devices were accessed.

- Behavioral RED on the qualified pre-journal store: abandoned original remains after fresh-store/process simulation; a second live store accepts an overlapping native share. Two assertions fail, as expected for defect reproduction
- Combined new production-store and independent review regressions: **87/87 PASS** (53 main cases and 34 independently authored review cases); includes file-backed metadata, register-before-write, interrupted/ready windows, live cross-store leases, identity reset, ready commit/delete/unregister failures, missing paths, repeated shares, bounded capacity, corruption, traversal/substitutions and preservation
- Independent review identified and reproduced live-writer replacement adoption and ready-path substitution before native dispatch. Both were repaired; the final independent digest/ownership review has no remaining defect within the declared scope and all 34 independent probes pass
- Genuine separate Flutter test processes: ready original recovered; ended-process native lease recovered; interrupted partial original preserved with an explicit recovery error. Each scenario runs a seed process and a distinct recovery process, using only the runner-created synthetic fixture
- Standalone focused Dart analyzer: **PASS**. After qualified identity integration and the final three independent startup probes, full `flutter test --no-pub --reporter expanded`: **588/588 PASS**, exit0; full `flutter analyze --no-pub`: **PASS**, no diagnostics, exit0; all new export/startup focused tests: **109/109 PASS**, exit0; existing export/family plus main startup group: **112/112 PASS**; `git diff --check`: **PASS**
- Independent integration review: **10/10 PASS** in addition to the 34 standalone review probes. It verifies slow/ambiguous/unreadable/missing-root/unlink-failed recovery, real mocked login acceptance and normal authenticated reads, duplicate-startup prevention, discarded background Futures, retry, and live write/delete acceptance barriers. No remaining source defect was found within the declared scope
- The final production source also passes all **3 subprocess scenarios / 6 separate Flutter invocations**, including ready recovery, ended-handoff recovery and explicit partial retention. These driver invocations are separate from the 588 automatically discovered tests

Useful commands (from `apps/flutter`, with the qualified Flutter SDK on PATH):

```sh
flutter test --no-pub test/export_restart_recovery_test.dart test/export_restart_safety_review_test.dart test/export_startup_integration_test.dart test/export_startup_review_test.dart --reporter expanded
bash test/run_export_process_boundary.sh
flutter test --no-pub --reporter expanded
flutter analyze --no-pub
```

## Remaining acceptance

- Final delta targets exactly `e602bb2c4786075a3d01845d3c554290c374532e`; the final combined gates above include the qualified identity source and all new export/startup tests. This does not change the remaining physical-device and interrupted-file limits
- Parallel exporters in different Dart isolates or OS processes are not implemented; production exports use the single UI-isolate coordinator. Physical Android process kill/restart, real filesystem timestamp semantics, native share consumption, Android APK/device acceptance and universal power-loss durability are not established by these host tests. Android SDK is absent; no native/device/APK PASS is claimed
- Completed-file timestamp fingerprints plus content digests have identity/substitution limits; they are not inode proof. No promise is made against concurrent compromised same-UID code modifying app-private storage
- Ambiguous interrupted originals and old unregistered legacy files remain a disclosed limitation. This implementation cannot authorize deleting them merely because their paths resemble app files
- API, mini-program, PostgreSQL, contracts and notification logic are unchanged. Their earlier counts are not rerun or relabeled here
- No publication, push, merge or deployment is attempted

Overall status remains **PARTIAL**.
