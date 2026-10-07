# Disposable medicine-page QA fixture

This harness is **synthetic memory-flow QA only**. It does not test native WeChat storage,
native filesystem persistence, real account switching, camera/gallery behavior, authentic
photo rendering, local HTTP, or cross-WeChat restart. Never enter real health information.
No server, upload, publication, credentials, real storage, or device connection is required.
“Zero native network” below refers only to product-controlled calls and rendered resources.
It does not assert that the WeChat IDE/platform sends no telemetry or background traffic.

A second IDE project path with the same account/AppID is **not** storage isolation.

## Generate and inspect

From the repository root (Node 22+, dependencies already installed):

```sh
npm run test:mini:qa
npm run prepare:mini:qa -- --source-sha 9de6d99137262e21142025a941094b7764209228 --run-id review-001
```

Only `.local-data/qa-review-001/project` is the importable project. It uses `touristappid`.
`review-source` is a review-only source snapshot; its project config is renamed so it is not
an importable production-bound project. The generator refuses existing output destinations.
Production files and their AppID/base URL are never written. Source comes from `git show`
of the exact supplied commit, not dirty working files. Do not change `touristappid` to make
an IDE error disappear. Report a tourist-mode limitation instead.

Inspect these sibling files before opening the generated project:

- `manifest.json`: exact source SHA, source/output SHA-256 hashes, actual wx/file-system
  API inventory per module (including cast aliases), and view-layer changes
- `generated.diff`: complete binary-capable source → fixture transform diff
- `project/QA-DO-NOT-UPLOAD.json`: build mark and scope restrictions

Repeated generation with the same source and run ID produces identical project hashes
and normalized-path diff bytes. The generator accepts only explicitly reviewed mini-program Git trees: baseline
`3ed0f8e6e410daf7fce1277d0e363caa52be3214`, frozen owned-photo writer tree
`abdef7419cb4abf00c54112456897ae05ebcbaba`, and the 2026-10-07 integrated tree
`7a37461f3b3e3245151a91f3e02e8151d6c849e0`. A different commit with the identical reviewed
mini-program tree is allowed; a changed tree requires fresh review. This is trusted frozen-
source instrumentation, **not a general malicious-JavaScript sandbox**. Reflection/constructor
escape expressions are also explicitly rejected during inventory. There is no native fallback.

The follow-on adapter covers pure `base64ToArrayBuffer` and memory open/write/close for the
frozen writer source tree `abdef7419cb4abf00c54112456897ae05ebcbaba`.
Its helper receives a manager via options/lease properties, so the generator also requires
`services/photo-file-lifecycle.ts` SHA-256
`8ff79310b1474d1ac459f08ca6b5d0118c4e61fb786339a8e8d8a0c198bbb3ab` and explicitly inventories
those reviewed fs paths. The integrated helper only extends the owned-photo purpose whitelist to
`leaflet`; its filesystem call inventory remains unchanged. Any other helper source change,
including options.fs/lease.fs injections, is rejected before product output is written.

The QA transform also permits exactly two reviewed local components: `medicine-date-field` and
`medicine-time-field`, at their exact repository-relative paths. Unknown component tags, plugin
URLs, arbitrary `usingComponents`, or `Component(...)` calls outside those component source files
remain fail-closed.

## Isolation and bootstrap

`app.js` is CommonJS: it installs and verifies the fixture before requiring the product app.
Every generated product/dependency module first obtains immutable lexical wx/App/Page
bindings from the installed guard, before its own dependency requires. Direct loading of a
page before bootstrap fails. No global wx mutation or successful host monkey-patching is
assumed. Source runtime imports must resolve to generated relative modules; ambient global
escapes, unreviewed code files/components/entrypoints and dynamic wx/fs indexing are rejected.

Native `getSystemInfoSync`/`getAccountInfoSync` are used only for a read-only bootstrap gate:
official IDE `devtools`, `touristappid`, `develop`. If a native probe, UI method or hook cannot
be verified, the product app is not loaded. Unknown wx/fs/cloud access latches a fatal stop.
The only native delegates are a small reviewed set of modal/toast/navigation/unload-alert/
refresh/share-menu-hiding UI methods. No native storage/network/files/camera/auth/share
original is captured or called. The tests install throwing/counting original sentinels.

All sync/async single and batch storage APIs, info and clear methods use the current runtime's
Map. Reopening a product page retains that Map. Recompile/new JS runtime starts empty. This
is deliberate and must never be reported as persistent-storage or cross-WeChat restart proof.

Requests validate exact `http://127.0.0.1:43187` origin, verb and normalized route **before**
in-process mock dispatch. That URL is only a contract label: there is **zero native network**
and no listening server. Percent escapes, dot segments, double slashes, other queries,
credentials, fragments, alternate origins and unknown routes fail closed. Redirect responses
are refused; the harness does not claim control over native wx.request automatic redirects.
Upload, socket, cloud, clipboard and real share APIs are blocked. `downloadFile` can synthesize
only allowlisted mock photo routes. Login/checkSession, chooseMedia and scanCode are synthetic.

The memory file model accepts only its generated root and explicit string/base64 encodings.
Its open/write/close methods expose a documented *synthetic* exclusive-create/descriptor
contract: open accepts only `wx`; write accepts ArrayBuffer with explicit offset/length/position,
no sparse writes, and reports modeled bytes written; close releases the memory descriptor.
The pure base64 codec is implemented locally with Uint8Array, without wx/Node/browser helpers.
The reported SDKVersion 2.16.1 is a synthetic capability label, not the actual IDE SDK version.
These methods are not native flag/atomicity/persistence evidence. The baseline product uses
readFile/writeFile/unlink. Unknown filesystem methods remain blocked.

Every page has a red QA banner. Every WXML image src is a bundled synthetic placeholder,
including dynamic thumbnails; the renderer cannot bypass wx guards to fetch a URL or actual
photo. Share buttons are disabled, share callbacks removed, and page onShow hides the share
menu. Non-photo features that call unimplemented mock routes stop the fixture intentionally.
The release package gate rejects tourist/QA names, QA paths and build marks; runtime gate
also rejects real AppIDs, non-develop builds and real devices. Do not upload this project.

## Official IDE manual matrix (not executed by this harness)

Import only the generated `project` directory in the official IDE simulator. If tourist
mode does not expose the gate fields as expected, stop and record the exact IDE/base-library
version and error. Do not weaken the gate or use production AppID as a workaround.

1. Confirm red banner and QA title. Log in via the real login page; it receives synthetic A
2. Open medicine entry, select camera or gallery: both return the same synthetic PNG
3. Edit fields, leave/cancel/reenter the page, check draft recovery in the *same JS runtime*
4. Recompile and verify drafts are empty, recording this as Map reset, not persistence
5. Test synthetic B through logout → console `getApp().qa.setActor('B')` → login again
6. Inspect `getApp().qa.summary()` for exact source, actor, held operations and synthetic paths

The scope is login, cabinet list, medicine create/edit/detail and synthetic photo draft/
recognition/upload/cover flow. Other product routes may fail closed because this is not a
full backend implementation. All generated JS/wxml content remains available for review.

## Deterministic faults/interruption

Use only synthetic controls in the IDE console, with the banner visible:

```js
getApp().qa.failNext('fs.writeFile')
getApp().qa.failNext('fs.unlink')
getApp().qa.failNext('setStorageSync')
getApp().qa.hold('request POST /api/v1/recognitions/medicine')
getApp().qa.summary()
getApp().qa.release('request POST /api/v1/recognitions/medicine')
```

`hold` queues that operation until `release`; `failNext` affects one operation. Use separate
page actions to reproduce cancellation, late recognition, retry and cleanup. Synthetic
session switches do not log into another actual WeChat account. A latched safety stop
requires recompile; do not catch it and replace the failed guard.

Automated tests load **generated real page/service modules**, use the existing runtime's
`makePageContext`, and verify same-runtime draft reentry, fresh-runtime empty storage,
write/close fault injection, blocked paths/routes/redirects, boot ordering, release rejection,
and delayed recognition across synthetic A/B sessions. These tests are Node VM evidence,
not an official IDE compilation or device result. Run full lint/typecheck/test separately.

## Frozen writer integration verification

The committed source must have the exact reviewed mini-program tree. The tests use current
committed HEAD automatically when it contains the writer; an explicit source SHA can pin
another commit with the same reviewed tree. Dirty working files are never the source.
For a disposable local review snapshot, use its exact committed SHA:

```sh
QA_INTEGRATION_SOURCE_SHA=<40-hex-local-source-commit> npm run test:mini:qa
npm run prepare:mini:qa -- --source-sha <40-hex-local-source-commit> --run-id writer-review-001
```

Without `QA_INTEGRATION_SOURCE_SHA`, writer-specific tests run against committed HEAD when
it includes the writer; they skip only if HEAD has no writer. CI on this committed candidate
must have zero skipped fixture cases. Tests cover reviewed helper provenance, reserved
→ ready state, memory FD closure, write failure/partial write/close failure with explicit
cleanup retry, and a delayed write across synthetic A/B sessions. `getApp().qa.partialNextWrite(1)`
models a one-byte partial write. The summary exposes only synthetic descriptor IDs, not native
handles. A dangling existing output symlink is rejected, and final output reservation uses
exclusive directory creation to avoid silently adopting an existing destination.

## Revision 6 source and evidence boundary

The current writer source is based on `9de6d99137262e21142025a941094b7764209228`.
Its mini-program tree is `abdef7419cb4abf00c54112456897ae05ebcbaba`. R1/R2/R3/R4/R5
archives are historical evidence only and must not be imported for this revision. The
final delivery manifest binds the generated output to its exact published commit; a local
source snapshot is not a published commit or an official IDE/device acceptance result.

Revision 6 keeps independently acknowledged queue/form baselines, rebases each ordinary
write onto the newest durable queue, preserves exact-path photo receipts and unacknowledged
local field edits, and confirms deletion against the newest durable target. Batch fields
merge only across matching stable server/local batch identities; ambiguous legacy identities
or structural conflicts retain the local form and stop. Unrelated cleanup does not replace
objects owned by an in-flight submission. Local batch keys never enter the API payload. Generated-page tests cover
passive reentry after delayed write/OCR and both unlink success/failure while a later draft
is added. Earlier writer, lease, late deletion and denied-capability tests remain enabled.

CI's verify checkout fetches full repository history so the historical baseline is available.
CI uses read-only repository permissions and does not retain checkout credentials. The
fixture itself never fetches source or makes network requests. Native persistence, actual
photo rendering, real accounts and device acceptance remain separate, not-run layers.
