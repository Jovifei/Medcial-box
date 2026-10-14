<!-- BEGIN:codex-project-hub:medcial-box:v1 -->
## Local project hub reporting (owner-authorized)
- Hub project_id: `medcial-box`. Registered root: `E:\project\medcial_box`. These are hub identities; do not change the project's own binding, goals, roadmap or gates.
- After a plan changes, a significant stage ends, tests finish, a blocker appears, and before stopping: report a short structured update. Do not report every chat message.
- Use `E:\project\codex-project-hub\integration\bound_report.py` (deterministic wrapper around the existing report.py CLI). Pass `--project medcial-box --worktree "ACTUAL-WORKTREE-ROOT"`; use the registered root only when actually working there. Branch is read from that worktree; detached HEAD and non-Git UNVERSIONED are explicit. Never reuse another worktree's identity/revision.
- Read the revision first: `python E:\project\codex-project-hub\integration\bound_report.py --project medcial-box --worktree "ACTUAL-WORKTREE-ROOT" revision`.
- Generate a new event: same prefix plus `template --agent "ACTUAL-AGENT-ID" --run "ACTUAL-RUN-ID" --revision N`; save stdout as UTF-8 to `E:\project\codex-project-hub\reports\medcial-box-EVENT-ID.json`. Fill current/next/blockers, stage_id and version/test/artifact references using the returned definition; then call the same prefix plus `send "ABSOLUTE-REPORT-FILE"`.
- Only claim tests you actually ran; label inherited/source-document claims and imports with source revision/date and importer role. Never claim another Agent called the CLI. Preserve pending planning (including PENDING_REMOTE_PLANNING); old connection warnings require current confirmation.
- Status reporting cannot change final goals/routes or grant approval. No owner.py apply from ordinary Agent reporting; claimed completion is not verified acceptance. No HTML edits, credentials, private photos, account data, raw sensitive logs or chat transcripts in reports.
- On failure keep the pending JSON, clearly report the error and path, and stop automatic retries. Retry an unchanged event_id/content after connectivity recovers; on 409 inspect latest revision and manually reconcile into a new event. Never silently overwrite or claim success without a successful CLI result.
- Full contract/commands: `E:\project\codex-project-hub\reports\medcial-box-INTEGRATION.md`. Reporting does not expand the project's execution permissions or start/continue another Agent session.
- This block applies after the Agent actually reads this file; old sessions are not assumed to reload it. Independent worktree copies must be checked separately.
<!-- END:codex-project-hub:medcial-box:v1 -->

## 提交与版本管理（Jovi，2026-10-15）
- 新提交标题使用中文，或中文在前、英文在后；不改写已发布历史提交。
- 用户版本以根目录 VERSION.json 为基准；微信 APP_VERSION、Flutter pubspec 和版本说明必须一致，Android build number 单调递增。
- 每个候选记录固定 Git SHA、源码树、CI、镜像/包摘要、API 地址和迁移清单；源码、部署和手机验收分别记录。
- 未通过真实服务、数据保全、签名和设备门槛时仅标候选，不创建正式发布或声称上线。保留原部署及额外实验的安全阻断。
