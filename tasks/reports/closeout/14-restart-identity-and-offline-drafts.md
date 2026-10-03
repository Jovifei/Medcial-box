# Restart identity fence and verified offline draft ownership

Date: 2026-10-03 UTC. Qualified local base: `e053162a445dcbb0df674e97aeb2b7d84c16c5aa`. This is a local verification commit, not a published GitHub commit. It layers the report13 form patch (SHA-256 `0329dfdb8f2df2340ae481728d78b2e0193e7245359239c74593007703d36e5a`) over published `736d7623435e2a38e3ebb51859574d43dffa0120`. This report covers client C1 identity persistence and the dependent C3 ordinary offline form contract. It does not implement the separate export ownership journal or claim product/device/release completion.

## Reproduced failures

Three unchanged production-AppServices regressions fail on exact local base e053162: a retained credential reaches a protected endpoint after offline logout plus failed secure deletion and service recreation; a delayed start-link publishes a usable result after logout; a delayed approved poll writes a new accepted credential after logout intent. Baseline: **0 passed / 3 failed**, assertions rather than compile failures. Fixtures use only synthetic HTTP, storage, platform paths and notification adapters.

Independent adversarial review also found and retained regressions for an old successful response arriving while a 401's fence write is blocked; interrupted migration followed by logout before owner validation; truncated modern-envelope bytes wrongly classified as legacy; a protected initial route bypassing BootGate with another family's cache; direct current-family reads rebinding without cleanup; family-loss routing losing priority to the new cache gate; and a stale failed family-persistence cleanup barrier blocking explicit reconnect even after storage recovered. These are fixed in the candidate, not listed as unresolved product successes.

## Acceptance and persistence contract

- `SessionIdentityState` is the single credential authority for AppServices and ApiAuthRepository. The auth repository requires a fenced API client; there is no raw-token fallback. Protected requests fail locally when the gate is closed. Initialization completes before services/routes/notification consumers are exposed.
- Tokens remain exclusively in the existing secure store as a bounded versioned envelope. A nonsecret file stores accepted/signed-out state, random 192-bit generation, the normalized full API base (including a configured path), and optional verified user/family IDs. Both records must match before a credential can be read. Draft fields and token contents are never decoded to infer ownership.
- The locked Android secure-storage plugin acknowledges SharedPreferences `apply()`; its ACK is not proof of persisted token replacement/deletion. New acceptance first commits a closed fence, writes the new secure envelope, then commits acceptance of the same fresh generation. A lost secure write cannot revive the previous envelope under the new acceptance. Ambiguous failed acceptance/owner commits attempt a separate signed-out seal; all-write failure remains explicitly unconfirmed.
- Logout closes memory and invalidates API/login intents synchronously. Signed-out persistence starts before the transition queue or network. Revocation is bounded and uses only the captured outgoing token; its response cannot clean a replacement session. Credential/poll deletion, existing identity cleanup and server revocation are independent attempts. Stale poll, start, token read, 401 and logout work cannot accept/delete a newer same-service session.
- Pending poll intents are deliberately not resumed after process recreation; the connection page obtains a fresh code.
- Current 401 invalidates the API epoch before waiting for persistence. Current family loss retains valid login, but immediately removes the family binding and passes existing form/inventory/reminder/export cleanup barriers. Both auth/me and the current-family endpoint clean a changed family before rebinding. Same-token create/join only accepts the resulting family after current cleanup and server acceptance.
- Persistence and revocation warnings outlive the disposed logout page. The connection screen listens to retained warning state; uncertain local sign-out exposes an explicit retry. A network or persistence ACK is not described as a real-device verification.

### Reusable private file utility

`PrivateAtomicState` has `read(): Future<String?>` and `write(String): Future<void>`. `FilePrivateAtomicState` uses the existing path_provider application-support directory and a dedicated `medicine-private-state` child, with independent exact filenames per consumer. Auth uses `session-identity.v1.json`; no export metadata is stored there. Data is strict UTF-8, bounded to64 KiB. Operations serialize across same-file instances in the isolate, create an exclusive sibling temporary file, write/flush/close it and rename in the same directory. No delete-first/copy fallback, orphan-temp promotion, broad scanning or recursive cleanup occurs. Unsafe roots/files, symlinks, directories, malformed UTF-8 and oversized state fail closed. Only the exact committed name is authoritative.

The guarantee is ordinary process restart under the platform's normal private-filesystem contract. Dart exposes no directory-fsync operation here; power loss, a hostile same-UID process, concurrent independent OS processes, and physical Android kill/restart behavior are not established by these tests. Incomplete bounded temporary state files may remain; they are never promoted or swept.

## Verified offline form contract

A strictly validated current server profile supplies owner metadata bound to the accepted secure generation and exact API base. Family loss clears its family, while retaining login. Missing/malformed context, another origin/base path, or mismatched secure envelope cannot unlock local forms. Startup also quarantines missing/mismatched unscoped family-cache data; it never relabels old inventory as the newly validated family. Already-proved exact-scope plan records remain available when an unrelated cache-family key is missing.

`PlanCreationSession.offlineReadOnly` permits explicit ordinary local draft restore/edit/autosave under the established exact owner. Only a network exception permits the verified-owner fallback. It does not infer care-profile management permission. The session remains restricted even if connectivity returns; explicit reload revalidates current identity, profile permission and edit version before submission. Repository and UI guards block remote create/retry/recovery/edit writes from restricted sessions. There is no automatic replay. Original operation payload/key priority, opaque recovery markers, selective revision ACK cleanup and privacy invalidation from report13 remain intact.

Normal matching new-format login restores; matching-owner cached home and cold notification navigation remain functional. Notification payloads are still hints, with fresh protected reads before private details. Signed-out/corrupt contexts and protected initial routes cannot bypass startup or reveal another family's cache.

## Forward-only legacy migration matrix

The prior client stored only an opaque secure token and a cached family; it did **not** store trusted API-origin provenance. Therefore no automatic raw-token validation at the currently configured host is safe. This is a disclosed compatibility limit, not invented historical evidence.

| Existing state | Behavior |
| --- | --- |
| Matching accepted new-format fence/envelope | Restore valid login; offline owner requires valid matching metadata |
| Genuine legacy token, missing fence | Recognize only the actual API's64-lowercase-hex legacy format; never transmit it automatically, even to the same configured host. Explain reconnect and preservation |
| Legacy state offline, different host or different API base path | No credential transmission or offline ownership inference; explicit reconnect required |
| Missing/corrupt modern fence/envelope, truncated JSON or unknown token format | Fail closed; preserve unknown bytes, without minting legacy restoration eligibility |
| Explicit fresh device-link approval after eligible legacy upgrade | Checked quarantine completes before new acceptance. Current server-verified API/user/family scope may adopt only matching plan-form/original-operation records; their normal explicit restore/retry choices still apply |
| New user/family/API does not match a quarantined plan scope | Keep bytes quarantined and inaccessible; never derive authority from those bytes |
| Unscoped legacy medicine drafts, inventory and cached family | Preserve in quarantine; the old format cannot prove their owner, so they are not automatically restored or relabeled |
| Recorded explicit logout or family cleanup | Durable nonsecret restoration exclusions prevent those invalidated scopes from reviving after same-owner login; unknown-owner logout conservatively blocks all legacy adoption |

Quarantine uses a separate private preference namespace outside normal draft cleanup. Copy/readback confirmation precedes source removal; partial/false writes/removes, conflicting copies and retries preserve bytes or fail closed. Only exact eligible plan keys move into the current family lifecycle. Quarantine is neither a backup/export facility nor a claim of secure erasure. Existing unknown bytes are not silently deleted. Scope exclusions are bounded; exhausting that bound conservatively disables legacy adoption rather than dropping an invalidation. A recorded logout/family-loss leftover is never reclassified as a legitimate upgrade just to recover a draft.

## Qualification and evidence

All accounts, credentials, medication/cache/form bytes, platform notifications, file paths and network responses are synthetic. Tests execute production services/repositories/widgets and real temporary file IO with targeted injected failures. No real credentials, user files, notifications, owner computer, signing, security-setting changes, external deployment or remote repository writes were used.

Focused groups:
- Private atomic state:24/24
- Quarantine/preservation:33/33
- Offline form ownership:20/20; existing focused form/draft/create/ACK:90/90
- Restart state and production API integration:64 tests in the full suite (the final affected identity/boot/family recovery batch passes125/125), including the3 baseline-compatible failures now passing
- Production boot/navigation/warning/notification:17/17
- Existing direct auth identity/device-link regressions:7/7

Final frozen-source aggregate receipts:
- `flutter analyze --no-pub`: no issues, exit0
- `flutter test --no-pub --reporter expanded`: **479/479**, exit0
- Final affected identity/boot/family recovery batch:125/125, exit0
- `flutter build apk --debug --no-pub`: exit1, **No Android SDK found**; no APK was produced or installed. This environment blocker was observed before the final small cleanup-retry fix and remains unchanged
- `git diff --check`: pass
- Independent review: no remaining blocking security-correctness finding in reviewed source; the final bounded stale-barrier fix was separately reviewed by the integrating parent

Existing normal-session fixtures now explicitly establish matching secure generation, server owner and family cache; care-permission response fixtures include the name/role fields the real API returns. Their cleanup/privacy/consent assertions were preserved. Legacy missing-state, mismatched-owner and corrupted-storage behavior have separate production tests. The two last added guards reject credential-bearing/ambiguous API-base metadata and prove explicit logout recovery after failed family-fence persistence.

Exact per-file base/result SHA-256 values and the independently replayable delta are recorded in the handoff manifest. Source/test bytes are frozen after these gates. No Node/API/SQL implementation changed in this delta, so earlier mini220/API382/tooling6/strictPG150 are prerequisite evidence, not rerun claims.

## Remaining acceptance boundaries

No source or widget check proves Android secure-storage/native notification behavior, power-loss durability, real-device process killing, physical keyboard/storage/update behavior, two-account/two-device trial, official WeChat compilation, configured/signed release or production readiness. A local APK command cannot succeed without Android SDK; its actual result is recorded with final gates. If every persistence attempt fails, a durable logout guarantee is impossible: the current process stays closed and the UI warns/retries. The overall project remains PARTIAL. Publication is separately blocked; this is a local-only delta after the report13 patch.
