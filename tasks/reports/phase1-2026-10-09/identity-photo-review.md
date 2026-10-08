# R2/R4 Phase1 independent audit

Agent: /root/phase1_identity_photo. HEAD: 85bfe729f2089db2ee48040b450293511e8ce9c7. Product baseline f675416ced73b59144c1f3d327dcdc741608a84e.
Read-only product audit; no business edits. All probe writes are synthetic in-memory platform mocks. No PG/provider/private photos/device/devtools invoked.

## Findings

P1 IDENTITY-01: old family confirmation can act on newer identity.
apps/miniprogram/pages/family-settings/family-settings.ts:67-71 awaits modal without capturing session generation or verifying it before api.leaveFamily(). api.ts:192 captures identity only when request dispatches, so it faithfully authenticates the newer identity rather than fencing the original page intent. Reproduction: call real onLeaveFamily as member A; storeToken(B)/write scope B while modal unresolved; confirm modal; real API emits POST /api/v1/families/leave with Bearer B. On success it also relaunches B's navigation. Server endpoint has no old family ID to reject. Parent should inspect membership route to confirm actual authorized-member mutation; this probe does not execute server/PG. Related sibling onManageMember:60-64 and onIntervalChange:40-48 also lack original-intent fencing; those are STATIC_ONLY extensions, not independently reproduced. Specs A:AUTH-05, A:AUTH-07, B:AUTH-05, B:FILL-06. Test gap: existing session-boundary tests fence already-dispatched responses and logout pages but do not fence family confirmation before dispatch.

P1/P2 IDENTITY-02: persistent logout failure is swallowed and old identity reloads after restart.
apps/miniprogram/services/api.ts:113-125 removes persistent token but ignores failures; session-scope.ts:42-48 does same for persistent owner. A fresh runtime rereads token api.ts:101-107 and scope session-scope.ts:18-26. Reproduction: seed synthetic token+scope; inject removeStorageSync throws; clearToken => current memory empty; instantiate fresh service modules => old token+owner returned. This proves client persistence resurrection, not valid server authentication after successful server revocation. Risk becomes material when logout revocation also fails/offline or family-scope clearing fails independently: credentials/private draft identity can reappear; there is no durable tombstone or persistence warning. Existing test session-boundary.test.mjs:80-85 explicitly tests only this process. Specs A:AUTH-07, A:RACE-06, B:FILL-06; source restart subassertions need expansion. Flutter session_identity_state.dart has a separate persistence fence/warning and should not inherit this finding. Parent may rate P1 for private-data logout expectations or P2 conditioned on offline/storage-failure policy.

## Executed evidence

mock-tests.log: node --test session-boundary, entry-session-late-failure, medicine-entry-owner-boundary, and all photo*.test.mjs. 128 tests PASS, 0 fail/skipped, command exit 0. Production TS transpiled by existing runtime; wx/API boundaries mocked. Includes late 401/OCR success/error, logout/login generations, photo exclusive create/write/close/ready/delete, reserved-write recovery, durable cleanup and multi-page queue rebase. These are passing local subassertions, not entire A/B specs.
identity-probes.mjs + identity-probes.log: two added synthetic probes, exit 0, both REPRODUCED. Initial probe setup attempts failed on harness usage/syntax and were corrected; these were driver failures, not product findings. Current final driver executes real page/API/session modules and no external request.

## R4 review and gaps

Reviewed medicine-edit identity guards, touched-field and batch-shape OCR guards, currentPhotoDraftQueue, cleanup rebasing, session-scope, photo-file-lifecycle lease/exclusive create/durable reserved-before-bytes/ready-after-close paths. No additional confirmed defect in these reviewed mini photo writer/delete paths. Tested recovery creates a new page/runtime over mock storage; ordinary OS process death/native wx filesystem behavior remains NOT_RUN.
API auth/session membership lookup is per protected request; leaflet-photos scopes queries to family and locks quota/medicine before reservation, then cleans pending storage. This is STATIC_ONLY: no PG route mutation or quota/cleanup competition executed here. private-photo-store.test uses native OS tmpdir and was not run because child file outputs are restricted to the authorized audit directory and dist freshness was not established by this child.
Flutter session_identity_state, api_auth_repository, medicine_draft_queue and store serialization were inspected; explicit durable logout fence, generation/origin/verified owner, serialization and late read rechecks are present. Flutter runtime tests NOT_RUN in this child. Native photo symlink/restart, corrupted persistence, exact OS failure semantics, and actual server member revocation races remain integration gaps. Their existing tests/parent runs must be recorded separately with actual exits, never imported as this child's PASS.

## Verdict

R2 CHANGES_REQUIRED for reproduced pre-dispatch family identity leak and silently non-durable client invalidation. R4 tested mini subassertions PASS; full photo/private-storage/restart spec acceptance NOT_RUN, pending integration/native/human variants. Human gate NOT_RUN. No authorization expansion or business fix applied.

## Actual PostgreSQL logout control supplement (2026-10-09)

pg-logout-probe.mjs executed exit 0. The driver assertion PASS means the expected defect/control were observed; it is not product logout acceptance PASS. Exact HEAD85b and localhost database medbox_phase1 validated; Docker id aa5539db35e8f221a60ffe36a8ead89ff9e62b6a67021c04a91acf67d99c710a and owner/audit labels matched manifest. Only isolatedPostgres-generated unique schema was migrated and dropped; no other database touched. Credentials absent from driver/log/results.

Offline /auth/logout wx boundary failure + persistent removal throw: real auth.logout threw NETWORK_ERROR and cleared in-process token/scope; fresh real module instances reloaded the same token/owner; actual Fastify auth/me against PostgreSQL returned 200 with matching synthetic user. VALID_SESSION_RESURRECTION_REPRODUCED. This narrows IDENTITY-02 to a confirmed valid session resurrection under combined revoke-unavailable/storage-removal-failure conditions.

Successful real /auth/logout (200) + same persistent removal throw: fresh modules reloaded stale token/owner, but actual auth/me returned 401. REVOKED_TOKEN_REJECTED_CONTROL_PASS. Do not claim server-revoked token bypass.

pg-logout-results.json contains exact source/dist SHA256 for eleven relevant files. pg-logout.log records non-sensitive stdout. Cold restart uses fresh VM module instances over mock persisted storage, not native wx or OS process death. Product P1 remains CHANGES_REQUIRED; human NOT_RUN.
