import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./prepare-local-backup-vault.ps1', import.meta.url));
const source = readFileSync(script, 'utf8');
const windows = process.platform === 'win32';
const vault = 'E:\\AI_Tools\\Codex\\data\\medbox-backup-vault';
const options = { skip: !windows };
function run(args = []) {
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true });
}
function rejected(args, message) {
  const result = run(args);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr + result.stdout, message);
}
// Parse and invoke an isolated safety helper, without dot-sourcing the script's
// Apply body or creating fixtures, identity material, directories, or backups.
function helper(command) {
  const escaped = script.replaceAll("'", "''");
  const prelude = `$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$tokens,[ref]$errors); if($errors.Count){throw 'Parse failed'}; $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false) | ForEach-Object { . ([ScriptBlock]::Create($_.Extent.Text)) }; `;
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', prelude + command], { encoding: 'utf8', timeout: 15000 });
}

test('default Plan does not create a vault and describes protected current-user ACLs', options, () => {
  const before = existsSync(vault);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  assert.equal(plan.State, 'PLAN_ONLY');
  assert.equal(plan.VaultPath, vault);
  assert.equal(plan.Tools, 'REQUIRED_FOR_APPLY');
  assert.match(plan.AclPlan, /Protected inheritance; current user SID S-1-/);
  assert.match(plan.AclPlan, /only; FullControl/);
  assert.equal(plan.ApplyWillRefuseExistingVault, true);
  assert.equal(existsSync(vault), before);
  assert.doesNotMatch(result.stdout, /AGE-SECRET-KEY-/);
});

test('Apply rejects absent explicit tools before writing', options, () => {
  const before = existsSync(vault);
  rejected(['-Apply'], /Apply requires explicit paths/);
  assert.equal(existsSync(vault), before);
});

test('paths reject C drive, relative paths, UNC, traversal, and alternate streams', options, () => {
  for (const path of ['C:\\vault', 'vault', '\\\\server\\vault', 'E:\\..\\vault', 'E:\\vault:stream']) {
    rejected(['-VaultPath', path], /Only absolute E-drive paths/);
  }
});

test('even E-drive paths cannot redirect the approved vault or scratch root', options, () => {
  rejected(['-VaultPath', 'E:\\other-vault'], /exact owner-approved/);
  rejected(['-ScratchRoot', 'E:\\Claude_allow\\Download'], /exact owner-approved/);
});

test('tools require a complete pair, E-drive paths, correct names, and real files', options, () => {
  rejected(['-AgePath', 'E:\\missing\\age.exe'], /both age and age-keygen/);
  rejected(['-AgePath', 'C:\\tools\\age.exe', '-AgeKeygenPath', 'C:\\tools\\age-keygen.exe'], /Only absolute E-drive/);
  rejected(['-AgePath', script, '-AgeKeygenPath', script], /existing official age.exe/);
  rejected(['-AgePath', 'E:\\missing\\age.exe', '-AgeKeygenPath', 'E:\\missing\\age-keygen.exe'], /existing official age.exe/);
});

test('existing destinations are rejected by the actual no-overwrite helper', options, () => {
  const result = helper(`Assert-NewPath '${script.replaceAll("'", "''")}'`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Destination already exists/);
});

test('reparse ancestors are refused before an output or tool is opened', options, () => {
  const result = helper("function Test-Path { return $true }; function Get-Item { [PSCustomObject]@{Attributes=[IO.FileAttributes]::ReparsePoint} }; Assert-LocalEPath 'E:\\unsafe\\age.exe'");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reparse points are not allowed/);
});

test('new destination preflight is read-only', options, () => {
  const path = `E:\\Claude_allow\\Download\\medcial_box\\backup-vault-test-${process.pid}-absent`;
  assert.equal(existsSync(path), false);
  const result = helper(`Assert-NewPath '${path}'`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path), false);
});

test('ACL failure stops before identity generation and validation checks inherited grants', () => {
  assert.ok(source.indexOf('Protect-Directory $vault $sid') < source.indexOf('Invoke-QuietTool $AgeKeygenPath'));
  assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(source, /GetAccessRules\(\$true, \$true/);
  assert.match(source, /\$rules\.Count -ne 1/);
  assert.match(source, /no identity may be generated/);
});

test('synthetic verification preserves the paired files and requires ciphertext rejection', () => {
  assert.match(source, /@\('database.dump', 'photos.tar.gz', 'SHA256SUMS'\)/);
  assert.match(source, /\[IO.FileMode\]::CreateNew/);
  assert.match(source, /\$tamperExit -eq 0/);
  assert.match(source, /tamperedCiphertextRejected = \$true/);
  assert.match(source, /state = 'SYNTHETIC_ONLY'/);
  assert.match(source, /offDeviceRecovery = 'NOT_RUN'/);
  assert.doesNotMatch(source, /Remove-Item|Register-ScheduledTask|Invoke-WebRequest|ssh\s|scp\s/);
});
