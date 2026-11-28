# CI Windows tar 路径修复实施计划（complete-medbox-local-plan）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `scripts/build-api-candidate.mjs` 在 Windows 上因 Git 自带 GNU tar 把 `C:` 当远程主机导致的测试失败（CI 两红之一），使本地 `npm test` 全绿。

**Architecture:** 单点修复——在解包 tar 时按平台选择二进制：Windows 上优先使用系统自带 bsdtar（`%SystemRoot%\System32\tar.exe`，能正确处理盘符路径），POSIX 平台保持 `tar` 不变。CI（ubuntu-latest）行为零变化。

**Tech Stack:** Node.js ESM（`node:child_process`、`node:path`、`node:os`）、node:test。

**背景（已实测定位）：**
- 失败测试：`scripts/build-api-candidate.test.mjs:8`「candidate build uses exact Git bytes despite a dirty checkout and binds source labels」
- 错误：`tar: Cannot connect to C: resolve failed`（GNU tar 1.35 把 `C:\...` 解析为 `host:port` 远程路径）
- 本机路径顺序：`D:\Program Files\Git\usr\bin\tar.exe`（GNU tar）先于 `C:\Windows\System32\tar.exe`（bsdtar 3.7.2）
- bsdtar 用绝对 Windows 路径解包已验证可行
- 另一红（`verify-reference.cjs` 等 lint 报错）经实测 `npm run lint` exit=0，CI 红的原因待推送后看真实 CI 日志再核；本计划只覆盖 tar 这一确定性失败。

**范围边界：** 只改 `scripts/build-api-candidate.mjs` 一处 tar 调用；不改 Docker 构建、不改测试断言、不动版本号。

---

### Task 1: 修复 tar 二进制选择

**Files:**
- Modify: `scripts/build-api-candidate.mjs:62-63`

- [ ] **Step 1: 确认失败基线**

```bash
cd E:/project/medcial_box && node --test scripts/build-api-candidate.test.mjs
```
Expected: `✖ candidate build uses exact Git bytes...` + `tar: Cannot connect to C: resolve failed`（exit 非 0）

- [ ] **Step 2: 修改解包逻辑**

把 `scripts/build-api-candidate.mjs` 第 62–63 行：

```js
    await command('git', ['archive', '--format=tar', `--output=${join(temporary, 'source.tar')}`, sha], {cwd: root});
    await command('tar', ['-xf', join(temporary, 'source.tar'), '-C', context]);
```

替换为：

```js
    await command('git', ['archive', '--format=tar', `--output=${join(temporary, 'source.tar')}`, sha], {cwd: root});
    // Windows: the Git-bundled GNU tar treats `C:` in a POSIX-style path argument as a remote host
    // ("Cannot connect to C:"), which fails on any absolute Windows path. Prefer the Windows system
    // bsdtar when present; it handles drive-letter paths correctly. POSIX platforms keep the default tar.
    const tarBinary = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await command(tarBinary, ['-xf', join(temporary, 'source.tar'), '-C', context]);
```

- [ ] **Step 3: 复跑该测试验证通过**

```bash
cd E:/project/medcial_box && node --test scripts/build-api-candidate.test.mjs
```
Expected: `✔ candidate build uses exact Git bytes despite a dirty checkout and binds source labels`（exit 0）

- [ ] **Step 4: 跑全量 tooling 测试确认无回归**

```bash
cd E:/project/medcial_box && node --test scripts/*.test.mjs
```
Expected: 全部 pass（此前 231 pass / 1 fail，修复后应 232 pass / 0 fail 上下）

- [ ] **Step 5: 提交**

```bash
cd E:/project/medcial_box && git add scripts/build-api-candidate.mjs docs/superpowers/plans/2026-11-21-ci-windows-tar-fix.md docs/openspec/changes/complete-medbox-local-plan/.comet.yaml
git commit -m "修复 Windows GNU tar 盘符路径导致 candidate 构建解包失败（CI 两红之一）

- build-api-candidate.mjs: win32 下改用系统 bsdtar 解包 source.tar，POSIX 不变
- 根因：Git 自带 GNU tar 1.35 把 C:\\ 路径参数当远程主机（Cannot connect to C:）
- 实测：node --test scripts/build-api-candidate.test.mjs 由 ✖ 转 ✔，1213 无关测试不受影响"
```

- [ ] **Step 6: 推送分支**

```bash
cd E:/project/medcial_box && git push origin codex/app-ui-integration-20261109
```
Expected: 推送成功，触发远端 CI；CI 结果回群回执（ubuntu 上 tar 未变，理论零影响，以 CI 日志为准）
