# 2026-10-13 layout update review

Disposition: CHANGES_REQUIRED. Reviewed the uncommitted working-tree update over c1d8c64e3cc597346309bcc2971bb8166cca25e5, including eleven API/mini source files. No reviewed source was edited, no real family data used, and no deployment or installation performed.

## Findings

1. P1 — Automatic purpose inference misclassifies negated text and retains stale labels after a name change. services/medicine-tags.ts:49 onward uses unqualified substring matches; medicine-edit.ts:888 only infers when the current tag list is empty. Actual synthetic product-page probe: entering 感冒 sets fever/感冒咳嗽, replacing it with an unrelated synthetic name retains both. A negative statement saying not for fever/cough and warning of ibuprofen allergy yields fever/pain/cough/allergy. These auto-filled fields have no separate pending-confirmation provenance. Recompute only untouched auto suggestions and require clear confirmation; do not treat contraindication text or generic substrings as verified purpose.

2. P1 — Composite catalog hides actual provider failure as a successful empty result. medicine-catalog.ts:186–234 catches local and external errors; a real synthetic unavailable exception returns candidates=[] and a no-match warning. Distinguish unavailable/not-configured/no-match. The fallback also promises local GPU recognition regardless of the actual provider configuration.

3. P2 — Business footer is horizontal but not persistently at the viewport bottom. business-nav.wxss:1 is ordinary document flow with no positioning; long forms put it below the fold. medicine-edit.wxss:248 pins the save bar to bottom:0 at z-index85, while the navigation has no corresponding reserved viewport arrangement, so it can be covered at the end of the form. Preserve draft guards and button accessibility semantics when arranging both bars; current template replaced buttons with views without disabled/ARIA semantics.

4. P2 — Detail text asserts an unsupported comparison. medicine-detail.ts:127 labels source=opened as early relative to packaging even when packaging expiry is unknown. Actual domain function returns opened as source when the package date is null, which is valid but does not prove an earlier-than-packaging comparison. Use the recorded opening deadline wording and show the comparison only when both known dates support it.

5. P2 — Readability/cross-client completion is not established. app.wxss:46/158 keeps helper text at22rpx. Calculated white-background contrast is3.10 for#8a958d and3.77 for#7c867e, below the usual small-text4.5 criterion. Critical deadline text is also22rpx. Flutter has no corresponding working-tree edits; device/system-large-font/keyboard/native rendering were not exercised. Do not label this a verified two-client typography/accessibility update.

## Actual checks

- Workspace typechecks PASS.
- Root lint/JSON syntax PASS.
- API build PASS.
- Mini product tests410PASS,0SKIP.
- Focused catalog/inventory API tests16PASS,0SKIP; no PostgreSQL suite or blocked additional race experiment executed.
- Additional synthetic review probes reproduced findings1/2, confirmed the unknown-package domain source in finding4, and calculated contrast for finding5.
- Latest generated mini-staging-94f4cf3b-88b8-44dd-9e7b-3621d0e7ae19 has HTTPS medbox.joviluma.com and urlCheck=true. Hash comparison for app.wxss, business-nav.wxml and medicine-edit.ts matches the working tree.
- Public HTTPS health/ready HTTP200, statusok, databaseconnected. Current simulator wx.request/native layout and real phone acceptance NOT_RUN.

Existing source API_BASE remains the intentional development loopback; this is separate from the correctly configured generated staging project. Do not run/upload the raw source project as the staging application.

Synthetic logs and the exact working patch are retained in E:\Claude_allow\Download\medcial-box-ui-review-20261013-*. No private records, photos or credentials are included.
