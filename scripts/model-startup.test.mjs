import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('./install-private-model-startup.ps1', import.meta.url));
const windows = process.platform === 'win32';
const quote = value => `'${value.replaceAll("'", "''")}'`;
function run(script) {
  const code = `. ${quote(installer)}\n${script}`;
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 25_000, windowsHide: true });
}
function passed(script) {
  const result = run(script);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}
const noMutation = `
function Register-ScheduledTask { throw 'UNEXPECTED_REGISTRATION' }
function Start-ScheduledTask { throw 'UNEXPECTED_START' }
function Stop-Process { throw 'UNEXPECTED_STOP' }
function New-ScheduledTaskAction { throw 'UNEXPECTED_TASK_CONSTRUCTION' }
`;

test('default plan and inspect use fixed public identity without mutation', { skip: !windows }, () => {
  for (const mode of ['', '-Inspect']) {
    const output = passed(`${noMutation}
function Get-ScheduledTask { @() }
function Test-StartupFiles { }
Invoke-MedboxStartup ${mode}`);
    const plan = JSON.parse(output);
    assert.equal(plan.mode, mode ? 'INSPECT' : 'PLAN');
    assert.equal(plan.directory, 'E:\\AI_Tools\\Codex\\data\\medbox-model-channel');
    assert.equal(plan.hostAlias, 'aliyun-etf');
    assert.equal(plan.socket, '/home/etfdeploy/medbox-deploy-1867792/tunnel/ollama.sock');
    assert.equal(plan.started, false);
    assert.equal(plan.executionTimeLimit, 'PT0S');
    assert.match(plan.userId, /^S-1-/);
    assert.equal(plan.hashes['private-model-channel.mjs'], 'f84fa3c513e126689c835289f0278e7d6b14415a55eb150d5a927cbf76a54c4a');
    assert.equal(plan.hashes['private_model_socket_lease.py'], 'a75341264ffb19762b837ba4fbc89ce7f863bf1523d661948bf9a2ddc7a326ef');
    assert.ok(!/password|private.key|token|credential/i.test(output));
  }
});

test('Apply rejects non-E paths and every alternate location before reading task state', { skip: !windows }, () => {
  for (const directory of ['C:\\temp\\medbox', 'E:\\Claude_allow\\Download\\medbox', 'E:\\AI_Tools\\Codex\\data\\other', '\\\\host\\share', 'E:\\AI_Tools\\Codex\\data\\x\\..\\medbox-model-channel']) {
    passed(`${noMutation}
function Get-ScheduledTask { throw 'SCHEDULER_MUST_NOT_BE_READ' }
try { Invoke-MedboxStartup -Apply -InstallDirectory ${quote(directory)}; throw 'EXPECTED_REJECTION' }
catch { if ($_.Exception.Message -ne 'INSTALL_DIRECTORY_NOT_FIXED_E_PATH') { throw }; 'REJECTED' }`);
  }
});

test('scheduler lookup errors cannot be treated as absent tasks', { skip: !windows }, () => {
  passed(`${noMutation}
function Get-ScheduledTask { throw 'SCHEDULER_UNAVAILABLE' }
try { Invoke-MedboxStartup -Apply; throw 'EXPECTED_REJECTION' }
catch { if ($_.Exception.Message -ne 'SCHEDULER_UNAVAILABLE') { throw }; 'REJECTED' }`);
});

const taskFixture = `
$expected = [pscustomobject]@{ Description = 'owned-config-hash'; Executable = 'powershell.exe'; Arguments = 'fixed'; Directory = 'E:\\fixed'; UserId = 'S-1-5-21-test'; AccountName = 'SYNTHETIC\\test' }
$task = [pscustomobject]@{ TaskPath = '\\'; Description = $expected.Description
  Actions = @([pscustomobject]@{ Execute = $expected.Executable; Arguments = $expected.Arguments; WorkingDirectory = $expected.Directory })
  Principal = [pscustomobject]@{ UserId = $expected.UserId; LogonType = 'Interactive'; RunLevel = 'Limited' }
  Triggers = @([pscustomobject]@{ UserId = $expected.UserId; Enabled = $true; CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' } })
  Settings = [pscustomobject]@{ Hidden = $true; Enabled = $true; ExecutionTimeLimit = 'PT0S'; MultipleInstances = 'IgnoreNew' }
}
`;

test('existing task must match owner, action, trigger and least privilege settings', { skip: !windows }, () => {
  passed(`${taskFixture} Assert-StartupTask $task $expected; 'MATCH'`);
  passed(`${taskFixture}
$task.Principal.UserId = $expected.AccountName
$task.Triggers[0].UserId = $expected.AccountName
Assert-StartupTask $task $expected; 'MATCH'`);
  const changes = [
    "$task.TaskPath = '\\Other\\'", "$task.Description = 'foreign'", "$task.Actions[0].Execute = 'cmd.exe'",
    "$task.Actions[0].Arguments = 'different'", "$task.Actions[0].WorkingDirectory = 'C:\\other'",
    "$task.Principal.UserId = 'SYSTEM'", "$task.Principal.LogonType = 'Password'", "$task.Principal.RunLevel = 'Highest'",
    "$task.Triggers[0].UserId = 'other'", "$task.Triggers[0].CimClass.CimClassName = 'MSFT_TaskBootTrigger'",
    '$task.Triggers[0].Enabled = $false', '$task.Settings.Hidden = $false', '$task.Settings.Enabled = $false',
    "$task.Settings.ExecutionTimeLimit = 'PT72H'", "$task.Settings.MultipleInstances = 'Parallel'",
    '$task.Actions += $task.Actions[0]', '$task.Triggers += $task.Triggers[0]',
  ];
  // Test every conflict in one isolated process, rebuilding its object before each mutation.
  passed(`function Test-Conflict($change) {
${taskFixture}
& $change
try { Assert-StartupTask $task $expected; throw 'EXPECTED_REJECTION' }
catch { if ($_.Exception.Message -ne 'TASK_NAME_CONFLICT') { throw } }
}
${changes.map(change => `Test-Conflict { ${change} }`).join('\n')}`);
});

test('real scheduler definition uses qualified current account, accepts returned name or SID, and never registers', { skip: !windows }, () => {
  passed(`function Register-ScheduledTask { throw 'UNEXPECTED_REGISTRATION' }
function Start-ScheduledTask { throw 'UNEXPECTED_START' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$expected = [pscustomobject]@{ Description = 'synthetic-definition-only'; Executable = (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe')
  Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "E:\\synthetic.ps1"'; Directory = 'E:\\'
  UserId = $identity.User.Value; AccountName = $identity.Name }
$definition = New-StartupTaskDefinition $expected
if ($definition.Triggers[0].UserId -cne $identity.Name -or $definition.Principal.UserId -cne $identity.Name) { throw 'QUALIFIED_ACCOUNT_REQUIRED' }
foreach ($candidate in @($identity.Name, $identity.User.Value, ($identity.Name -split '\\\\')[-1])) {
  if (-not (Test-StartupIdentity $candidate $expected)) { throw 'CURRENT_IDENTITY_NOT_RECOGNIZED' }
}
if (Test-StartupIdentity 'NT AUTHORITY\\SYSTEM' $expected) { throw 'FOREIGN_IDENTITY_ACCEPTED' }
$returned = [pscustomobject]@{ TaskPath = '\\'; Description = $definition.Description
  Actions = $definition.Actions; Principal = $definition.Principal; Triggers = $definition.Triggers; Settings = $definition.Settings }
Assert-StartupTask $returned $expected
'DEFINITION_VERIFIED'`);
});

test('Apply stops on a foreign same-name task before any install mutation', { skip: !windows }, () => {
  passed(`${noMutation}
function Get-ScheduledTask { [pscustomobject]@{ TaskName = 'MedboxPrivateModel'; TaskPath = '\\'; Description = 'foreign'; Actions = @(); Triggers = @() } }
try { Invoke-MedboxStartup -Apply; throw 'EXPECTED_REJECTION' }
catch { if ($_.Exception.Message -ne 'TASK_NAME_CONFLICT') { throw }; 'REJECTED' }`);
});

test('actual existing foreign bytes and foreign files are refused without overwrite', { skip: !windows }, () => {
  const base = resolve('E:/Claude_allow/Download');
  const fixture = mkdtempSync(join(base, 'medbox-startup-test-'));
  assert.ok(resolve(fixture).startsWith(base + '\\'));
  const source = join(fixture, 'private-model-channel.mjs');
  const foreign = join(fixture, 'foreign.txt');
  try {
    writeFileSync(source, 'original-owner-bytes');
    passed(`$files = [ordered]@{ 'private-model-channel.mjs' = [Text.Encoding]::UTF8.GetBytes('reviewed-bytes') }
try { Test-StartupFiles ${quote(fixture)} $files; throw 'EXPECTED_REJECTION' }
catch { if ($_.Exception.Message -ne 'INSTALL_FILE_CONFLICT') { throw }; 'REJECTED' }`);
    assert.equal(readFileSync(source, 'utf8'), 'original-owner-bytes');
    unlinkSync(source);
    writeFileSync(foreign, 'foreign');
    passed(`$files = [ordered]@{ 'private-model-channel.mjs' = [Text.Encoding]::UTF8.GetBytes('reviewed-bytes') }
try { Test-StartupFiles ${quote(fixture)} $files; throw 'EXPECTED_REJECTION' }
catch { if ($_.Exception.Message -ne 'INSTALL_FILE_CONFLICT') { throw }; 'REJECTED' }`);
    assert.equal(readFileSync(foreign, 'utf8'), 'foreign');
  } finally {
    // Only remove the exact synthetic files created here; never recursively remove a path.
    for (const name of readdirSync(fixture)) {
      assert.ok(['private-model-channel.mjs', 'foreign.txt'].includes(name));
      unlinkSync(join(fixture, name));
    }
    rmdirSync(fixture);
  }
});

test('installer keeps exclusive writes and does not start or stop processes', () => {
  const text = readFileSync(installer, 'utf8');
  const executable = text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  assert.match(executable, /FileMode\]::CreateNew/);
  assert.ok(!/ExecutionPolicy\s+Bypass|Start-ScheduledTask|Stop-Process|Start-Process|Register-ScheduledTask[^\n]*-Force/.test(executable));
  assert.match(executable, /-LogonType Interactive -RunLevel Limited/);
  assert.match(executable, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(executable, /-NoProfile -NonInteractive -WindowStyle Hidden/);
});

test('new runtime ACL isolates current user and SYSTEM without changing its parent; unowned state is refused', { skip: !windows }, () => {
  const base = resolve('E:/Claude_allow/Download');
  const fixture = mkdtempSync(join(base, 'medbox-startup-acl-test-'));
  assert.ok(resolve(fixture).startsWith(base + '\\'));
  try {
    passed(`$parent = ${quote(fixture)}
$before = [IO.Directory]::GetAccessControl($parent).Sddl
$runtime = Join-Path $parent 'runtime'
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
try {
  New-StartupDirectory $runtime $userId
  Assert-StartupAcl $runtime $userId
  if ([IO.Directory]::GetAccessControl($parent).Sddl -ne $before) { throw 'PARENT_ACL_CHANGED' }
  $manifest = [Text.Encoding]::UTF8.GetBytes('owned-manifest')
  $files = [ordered]@{ 'installation.json' = $manifest }
  $state = Join-Path $runtime 'state'
  [void][IO.Directory]::CreateDirectory($state)
  $status = Join-Path $state 'status.json'
  [IO.File]::WriteAllText($status, 'original-status')
  try { Test-StartupFiles $runtime $files; throw 'EXPECTED_REJECTION' }
  catch { if ($_.Exception.Message -ne 'UNOWNED_STATE_DIRECTORY') { throw } }
  if ([IO.File]::ReadAllText($status) -ne 'original-status') { throw 'STATE_OVERWRITTEN' }
  $manifestPath = Join-Path $runtime 'installation.json'
  [IO.File]::WriteAllBytes($manifestPath, $manifest)
  Test-StartupFiles $runtime $files
  $foreign = Join-Path $state 'foreign.txt'
  [IO.File]::WriteAllText($foreign, 'foreign')
  try { Test-StartupFiles $runtime $files; throw 'EXPECTED_REJECTION' }
  catch { if ($_.Exception.Message -ne 'STATE_FILE_CONFLICT') { throw } }
  [IO.File]::Delete($foreign)
  $acl = [IO.File]::GetAccessControl($manifestPath)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Write', 'Allow'))
  [IO.File]::SetAccessControl($manifestPath, $acl)
  try { Test-StartupFiles $runtime $files; throw 'EXPECTED_REJECTION' }
  catch { if ($_.Exception.Message -ne 'INSTALL_CHILD_ACL_CONFLICT') { throw } }
  'VERIFIED'
} finally {
  foreach ($path in @((Join-Path $runtime 'installation.json'), (Join-Path $runtime 'state/status.json'), (Join-Path $runtime 'state/foreign.txt'))) {
    if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
  }
  if ([IO.Directory]::Exists((Join-Path $runtime 'state'))) { [IO.Directory]::Delete((Join-Path $runtime 'state')) }
  if ([IO.Directory]::Exists($runtime)) { [IO.Directory]::Delete($runtime) }
}`);
  } finally { rmdirSync(fixture); }
});
