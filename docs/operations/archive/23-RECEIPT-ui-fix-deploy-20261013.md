# 2026-10-13 UI repair / preserved-data deployment receipt

> 历史接力记录：以下结论和授权只对应当时日期/提交；最新主线、合并授权和剩余门槛见 tasks/status.md 与 operations/24-RECEIPT-main-consolidation-20261014.md。

Candidate: 49dc9e7e4583d97d3f251a1b606e1dc2e34a2336, mini tree c4a34d6bcd0d63796cd1e4da10fb75d2d245d60a. Original E root, branch codex/pr5-ci-repair-20261011. PR5 remains unmerged. Jovi expressly authorized repair and deployment.

## Goal and current change
Bottom single-row centered navigation with draft guards; readable quantity/expiry; accurate opening-deadline basis; no keyword guessing of medicine purposes; explicit catalog unavailable/not-configured/no-match; safe retake of an owned failed photo draft. Version 1.0.4. No Flutter UI rewrite; no unverified local catalog published.

## Actual local evidence
- Independent read-only source review accepted current mini subtree; retained family/form fingerprints, reserved-file rejection and active-draft check. No new wx/fs/native network/component kinds. Read-only getCurrentPages reads routes only; synthesized QA does not prove native active-tab highlight.
- Final npm test exit0: mini419PASS; API269PASS/16SKIP; tooling112PASS/24SKIP. Focused catalog16PASS. Lint/typecheck/buildPASS.
- One intermediate whole test run was started while a child was editing its new fixture; it failed an expected review-vs-ready assertion. Child corrected the assertion to the actual pending-review contract. Final whole run passed; no production status was changed merely to satisfy that assertion.
- Exact candidate generated QA manifest: var/ui-fix-mini-20261013/manifest.json. Mini QA38PASS/1SKIP. Unknown wx/fs/component/helper gates retained; independent tree registration only.
- Generated staging mini: .local-data/mini-staging-15ce23e5-558a-4afa-9bf7-4373d5cf4fed. APP_VERSION1.0.4, AppIDwx1f6dd99d28aab8e5, HTTPSmedbox.joviluma.com, urlChecktrue, no private settings; package653551bytes/129files.
- Native WeChat WXML/WXSS compile succeeded. A prior staging project of this same repair candidate before final photo/version adjustment made actual wx.request health/ready HTTP200/databaseconnected. Current final candidate login/device/navigation still needs runtime verification after API upgrade.

## Current hosted gate
CI38336443691 for exact candidate: verifySUCCESS; backup-dockerSUCCESS; FlutterIN_PROGRESS when last read. Artifacts bind the exact49dc SHA. CI is ordinary reviewed pipeline; the original additional status/confirm permission-revocation experiment remains BLOCKED, was not re-created or routed through CI.

## Deployment preparation and preservation
All28 Owner dirty files copied and SHA256-verified to E:/Claude_allow/Download/medcial_box/ui-fix-deploy-20261013 before edits. Owner docs/config/data/tunnel helper remain uncommitted.
Server still1867792/31migrations when inspected. Same medbox-staging project, medbox-staging_medbox_database and medbox-staging_medbox_private_uploads; existing private environment, HTTPS and Ollama bridge kept. No other stack touched.
Runtime archive SHA25692c2f442289edbceb88d8cbfff580239c83a197a10c03c1327ab8ba116355b93, manifest hashes checked remotely; imagebuilt sha256:34d5813210ce5636c44eefc3c1ec9d95301a288e152b092f5f4f45cf44518b0e with revisionlabel49dc9e7e4583d97d3f251a1b606e1dc2e34a2336. Build did not stop/change running API. SSH transiently timed out, later recovered. Server disk741MiBfree afterbuild; no pruning/deleting other files.

## Next action
Await final Flutter gate. Then stop ONLY medicine API, obtain exclusive paired DB/private-photo backup via current staging-backup guard adapted solely to existing compose paths/project. Validate backup structure/hashes privately, retain artifacts, capture aggregate family/content fingerprints. Start new API image with same private environment/volumes/bridge, apply ordered migrations032-034, verify health/version and unchanged family/data fingerprints. Do not run real Owner dump/photo bytes as synthetic tests; CI restoration used synthetic data only. No old-image downgrade after multi-family use.
Prepare WeChat preview/upload only after final CI/API compatibility. No public release or main merge. Real two-account invitations/switch/camera acceptance remains NOT_RUN unless actually observed; preserve both existing families. Remote must independently review source and evidence, distinguish ordinary CI from the still-BLOCKED additional experiment, and return concrete remaining defects rather than old status.

## Final candidate gate and deployment blocker
Final CI38336443691 completed SUCCESS for49dc9e7e4583d97d3f251a1b606e1dc2e34a2336; verify, backup-docker and Flutter all completed successfully. Final CI artifacts are exact-SHA named, published under that run. No production/device inference is made from these results.

Preparing the preserved-data server upgrade script was REJECTED by automatic approval review: blocked by policy. The tool gave no more specific reason. The rejected call would have written a script for old-API stop, guarded paired DB/photo backup, aggregate preservation fingerprints, migrations and same-volume image update. That call did NOT execute. No alternate driver/agent/tool/partial recreation of the rejected deployment is attempted. Server remains1867792; neither API stop nor actual backup/migration/update happened. New1.0.4 package is NOT uploaded or installed against that old server. Real household/device acceptance remains NOT_RUN; data preservation at this point means untouched actual data, not a claimed completed upgrade.

Current outcome: SOURCE_AND_CI_PASS / DEPLOYMENT_BLOCKED / REMOTE_REVIEW_PENDING. Candidate49dc9e7 remains in existing PR5; local docs and runtime artifact are retained. No main merge/public release/phone clear or downgrade occurred.

GitHub concentrated receipt: https://github.com/Jovifei/Medcial-box/pull/5#issuecomment-6137032637. Original ChatGPT review request successfully sent at2026-10-13T02:40Z (visible user turn and generating indicator); no duplicate request. Two browser status reads timed out; review conclusion is still unconfirmed. Hub accepted actualE identity report revision13/event06243aaa-42a6-4aa3-ad9e-4e51578da961. Do not infer remote approval from a sent prompt or healthy connection.
