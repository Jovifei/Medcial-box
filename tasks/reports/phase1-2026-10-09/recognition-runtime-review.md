# R3 recognition and production runtime independent audit

Baseline 85bfe729f2089db2ee48040b450293511e8ce9c7 (product f675416). Inspection date 2026-10-09 Asia/Shanghai. No business source writes, provider/network calls, credentials, photos, database/port/process changes.

## Source-confirmed findings (runtime pending)

- F01 privacy disclosure ambiguity, P1: medicine-edit.wxml:32 says unsaved drafts are only local; medicine-edit.ts:1266 sends imageBase64 for recognition before save; provider medicine-recognition.ts:121-132/166-174 can forward externally. This confirms mismatched wording/transport semantics, not illegality or an actual private-photo upload. Maps A:CAP-01, A:RELEASE-03, B:REL-07.
- F02 category-specific remediation discarded, P1: medicine-edit.ts:1353-1354 replaces all RECOGNITION_UNAVAILABLE messages with generic text. routes/recognitions.ts:45 correctly sends reason-specific messages. Actual-page synthetic error driver still needed (A:UI-04, B:REG-07).
- F03 image pixel/decode validation gap, P1 candidate: routes/recognitions.ts:9-17 only examines envelope; :36-40 validates bytes and forwards original. Actual model resource effect NOT_RUN; a bad synthetic envelope passing the route is not proof a valid giant image decodes or recognition succeeds. A:IMG-04/07, B:API-06.
- F04 full upstream responses read before bounds, P1: medicine-recognition.ts:26 reads full text then slices; :139/:181 full response.json. Output draft field truncation protects output only. A:MODEL-10.
- F05 production onClose not connected to SIGTERM/SIGINT, P1 candidate: server.ts:27-32 registers cleanup; no app.close/signal handler in production entry. Simulator script:59-64 has both. Actual production Linux SIGTERM/PG teardown remains NOT_RUN (A:OPS-06).
- F06 launcher existing-service reuse only checks mode string, P1 candidate: start-local-trials.mjs:18; fixed DB14, ports16, model20. Marker dev-simulator-server.mjs:51-54 returns PID/mode only, no query; launcher readiness does not prove DB health. Existing-process identity/model/build/version are not checked. Actual launcher NOT_RUN to protect Owner services (A:OPS-01/04/05/08).
- F07 413 remapping, P1 candidate: app.ts:44-48 only keeps400/415; recognitions.ts:21 route6MiB. Synthetic Fastify inject driver prepared. Real HTTP not run under no-network scope (B:API-07).

## Rejected finding

medicine-edit.ts:1298 writes leafletText unconditionally, but WXML161 renders read-only selectable text. Do not count a synthetic direct onFieldInput('leafletText') call as a reachable manual-input defect. Summary fields do have untouched guards.

## Evidence plan

probe.mjs imports only actual checkout dist, uses existing fake pool/login and bounded stub providers. PHASE1_ROOT selects frozen freshly built checkout. All writes go to this external folder. Probe includes oversize HTTP body, 128-byte extreme-dimension non-decodable PNG envelope, exact 4MiB JPEG envelope lengths, real Response streams with >2MiB stub error/success bodies, body AbortError classification. Node-only/no sockets. Full source case statuses must stay incomplete: this is subset coverage, not full A/B parent-case PASS.


## Executed runtime evidence, 2026-10-09

Fresh frozen checkout provided by parent: E:\Claude_allow\Download\medcial_box\phase1-20261008\checkout, HEAD85bfe729f2089db2ee48040b450293511e8ce9c7. Parent reported npm ci --offline/build0; this agent ran Node actual dist probes after that signal.

Commands:
1. PHASE1_ROOT=<checkout> node recognition-runtime/probe.mjs: exit0, results.json (11 controlled observations). Exit0 means the reproduction driver ran; it does not mean product assertions PASS.
2. node --test apps/api/test/recognitions.test.mjs in checkout: exit0, 13 tests /13PASS /0FAIL /0SKIP. Existing mocked route/provider tests; no provider network/PG/device.
3. node recognition-runtime/regex-repro.mjs: exit0, regex-results.json, exact compiled-production regex1MiB accepts;4MiB-1/4MiB/+1 all RangeError.
4. node recognition-runtime/valid-image-probe.mjs: exit0, valid-image-results.json, logs filtered to error type/message only.

### Confirmed runtime defects

P1 R3-BASE64-STACK: routes/recognitions.ts:29-30 uses a repeated capturing-free group inside the base64 regex. At exact4194303/4194304/4194305 raw bytes, regex throws RangeError Maximum call stack size exceeded before decoded byte validation. Actual app logs confirm RangeError and HTTP500, provider0. A valid generated1x1 PNG at128bytes returns200/provider1. Larger generated1x1 PNGs have legal tEXt padding, correct CRC32 per chunk and independently inflated IDAT asserted to the expected RGBA scanline; no actual photograph. This defeats within4MiB acceptance and graceful4MiB+1 rejection. Maps A:IMG-02 assertions1/2 and B:API-07. Model/resource testing remains separate.

P1 F07 HTTP body limit remapping: JSON body above6MiB returns HTTP500 INTERNAL_ERROR, provider0. Fastify rejection is mapped by app.ts:44-48 (does not preserve413). Maps B:API-07 HTTP limit subassertion and B:REL-04 partial. Node inject proof only; real socket HTTP NOT_RUN.

P1 F04 upstream response read budget: both actual provider implementations fully consumed2,097,164byte synthetic503 error body, despite8192 slicing; both accepted >2MiB successful upstream JSON (2,097,219 Ollama /2,097,233 Dashscope) then output cleaned draft. There is no explicit network-read cap. This is controlled finite response evidence, not actual OOM or proof of unbounded real network. A:MODEL-10 large-response subassertion FAIL.

P2 F04 body-phase abort classification: actual Response readable stream aborts with AbortError after fetch resolves; both provider implementations report reason invalid_json instead of timeout/provider_unavailable. Existing requestFailure classifies identical AbortError thrown by fetch as timeout, but broad JSON catch loses it at medicine-recognition.ts:138-145/180-186. This confirms categorization inconsistency; a body abort is not necessarily a real elapsed timeout. A:MODEL-10断流 subassertion and A:MODEL-09/B:API-12 partial; elapsed actual timer/total-budget subvariants NOT_RUN.

F03 envelope-only is observed: a128byte non-decodable fakePNG with IHDR2147483647×2147483647 reaches stub provider and returns200. This proves no route decode/pixel gating; it does NOT prove real provider accepts/decodes/allocates this image. A:IMG-04/07 and B:API-06 stay PARTIAL/NOT_RUN for real decoder/model consequences, rather than whole-caseFAIL from a permissive stub.

### Not executed / missing drivers

F01 UI/network informed-consent trace, F02 actual-page category-specific failure driver, valid high-pixel decodable image/model resources, real HTTP body-limit path, runtime timers and actual upstream stalls, production LinuxSIGTERM with dedicatedPG+active-job cleanup, existing-server identity and launcher persistent ready test. All remain scoped NOT_RUN/BLOCKED(TEST_AUTOMATION_MISSING) as applicable; no excuse to transfer missing automation to Jovi as manual testing.

No business sources changed. No real provider/model/credential/private-photo/network/Owner-system changes. Driver files only in external recognition-runtime directory. Parent owns final plan/Hub reporting; these are my agent-local evidence.

## Authorized follow-up: owned loopback and actual-page F02

Parent authorized new own ephemeral127.0.0.1:0 HTTP listener with synthetic dependencies only. http-probe.mjs created/listened/closed that exact Fastify instance in finally. No existing ports/services contacted.

F07 real socket confirmed: node http-probe.mjs exit0; Content-Length6291501 JSON bytes ->500 INTERNAL_ERROR, provider0. http-results.json. First fetch-based attempt exited1 with TypeError fetch failed / read ECONNRESET; exact own server closed in finally. Switched driver to node:http request, which captured actual500 response; do not discard the earlier transport failure or claim undici returned500. No retry against an existing service.

F02 actual page confirmed: node page-error-probe.mjs exit0. Loaded real baseline page via existing TypeScript VM harness and real ApiError constructor; only auth/API/provider and wx filesystem/photo boundaries are synthetic. Four category messages context_limit, invalid_json, timeout, model_missing each reached real page method and were replaced with identical generic hint. Every variant loadingStopped=true, photoDraftPreserved=true, manualname retained. This is actual-page error handling proof with stub API, not integrated HTTP-to-wx or device/IDE proof. Exact source medicine-edit.ts:1353-1354. Maps B:REG-07 classified actions FAIL; A:UI-04 partial. Loading/draft/name preservation subassertions PASS.

This supersedes earlier NOT_RUN for F02 actual-page driver and F07 real socket subvariant. Other missing drivers remain. Controlled network now includes only own ephemeral loopback, with zero real upstream calls.
