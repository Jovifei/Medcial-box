# Default is a read-only plan. -Apply installs files and a logon task, but never starts it.
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$Inspect,
    [string]$InstallDirectory = 'E:\AI_Tools\Codex\data\medbox-model-channel'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:StartupRoot = 'E:\AI_Tools\Codex\data\medbox-model-channel'
$script:StartupSources = @{
    'private-model-channel.mjs' = 'f84fa3c513e126689c835289f0278e7d6b14415a55eb150d5a927cbf76a54c4a'
    'private_model_socket_lease.py' = 'a75341264ffb19762b837ba4fbc89ce7f863bf1523d661948bf9a2ddc7a326ef'
}

function Assert-StartupRoot([string]$Directory) {
    if ($Directory -notmatch '^[Ee]:[\\/]' -or
        [IO.Path]::GetFullPath($Directory).TrimEnd('\') -ine $script:StartupRoot -or
        $Directory -match '(^|[\\/])\.\.?([\\/]|$)') {
        throw 'INSTALL_DIRECTORY_NOT_FIXED_E_PATH'
    }
}

function Assert-NoReparsePoint([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'REPARSE_POINT_REFUSED'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor.TrimEnd('\'))
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Get-StartupHash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Assert-StartupAcl([string]$Directory, [string]$UserId) {
    if (-not (Test-Path -LiteralPath $Directory)) { return }
    $acl = [IO.Directory]::GetAccessControl($Directory)
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $UserId -or $rules.Count -ne 2) {
        throw 'INSTALL_DIRECTORY_ACL_CONFLICT'
    }
    foreach ($identity in @($UserId, 'S-1-5-18')) {
        $allowed = @($rules | Where-Object { $_.IdentityReference.Value -eq $identity -and
            $_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -eq 'FullControl' -and
            $_.InheritanceFlags -eq 'ContainerInherit, ObjectInherit' -and $_.PropagationFlags -eq 'None' -and -not $_.IsInherited })
        if ($allowed.Count -ne 1) { throw 'INSTALL_DIRECTORY_ACL_CONFLICT' }
    }
}

function New-StartupDirectory([string]$Directory, [string]$UserId) {
    $parent = [IO.Path]::GetDirectoryName($Directory)
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'INSTALL_PARENT_REQUIRED' }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $owner = [Security.Principal.SecurityIdentifier]::new($UserId)
    foreach ($identity in @($owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    # New-Item without Force refuses a concurrent/foreign directory. Apply the ACL before placing executable bytes.
    New-Item -ItemType Directory -Path $Directory -ErrorAction Stop | Out-Null
    [IO.Directory]::SetAccessControl($Directory, $acl)
    Assert-StartupAcl $Directory $UserId
}

function Assert-StartupChildAcl([string]$Path) {
    $userId = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = if ((Get-Item -LiteralPath $Path -Force).PSIsContainer) { [IO.Directory]::GetAccessControl($Path) } else { [IO.File]::GetAccessControl($Path) }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $userId) { throw 'INSTALL_CHILD_ACL_CONFLICT' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($userId, 'S-1-5-18')) {
            throw 'INSTALL_CHILD_ACL_CONFLICT'
        }
    }
}

function Test-StartupFiles([string]$Directory, [Collections.IDictionary]$Files) {
    Assert-NoReparsePoint $Directory
    if (-not (Test-Path -LiteralPath $Directory)) { return }
    if (-not (Get-Item -LiteralPath $Directory -Force).PSIsContainer) { throw 'INSTALL_DIRECTORY_CONFLICT' }
    $manifestPath = Join-Path $Directory 'installation.json'
    $owned = $false
    if ($Files.Contains('installation.json') -and (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        Assert-NoReparsePoint $manifestPath
        $owned = (Get-StartupHash ([IO.File]::ReadAllBytes($manifestPath))) -eq (Get-StartupHash $Files['installation.json'])
    }
    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($entry.Name -eq 'state' -and $entry.PSIsContainer) {
            Assert-NoReparsePoint $entry.FullName
            $children = @(Get-ChildItem -LiteralPath $entry.FullName -Force)
            if (-not $owned -and $children.Count) { throw 'UNOWNED_STATE_DIRECTORY' }
            Assert-StartupChildAcl $entry.FullName
            foreach ($child in $children) {
                Assert-NoReparsePoint $child.FullName
                if ($child.PSIsContainer -or $child.Name -notin @('status.json', 'control.json')) { throw 'STATE_FILE_CONFLICT' }
                Assert-StartupChildAcl $child.FullName
            }
            continue
        }
        if (-not $Files.Contains($entry.Name) -or $entry.PSIsContainer) { throw 'INSTALL_FILE_CONFLICT' }
        Assert-NoReparsePoint $entry.FullName
        if ((Get-StartupHash ([IO.File]::ReadAllBytes($entry.FullName))) -ine (Get-StartupHash $Files[$entry.Name])) {
            throw 'INSTALL_FILE_CONFLICT'
        }
        Assert-StartupChildAcl $entry.FullName
    }
}

function Test-StartupIdentity([string]$Identity, $Expected) {
    if ($Identity -ieq $Expected.UserId -or $Identity -ieq $Expected.AccountName) { return $true }
    # The scheduler can return an unqualified local account name for the same SID.
    if ($Identity -ine ($Expected.AccountName -split '\\')[-1]) { return $false }
    try { return [Security.Principal.NTAccount]::new($env:COMPUTERNAME, $Identity).Translate([Security.Principal.SecurityIdentifier]).Value -eq $Expected.UserId }
    catch { return $false }
}

function Assert-StartupTask($Task, $Expected) {
    if ($null -eq $Task) { return }
    $actions = @($Task.Actions)
    $triggers = @($Task.Triggers)
    if ($Task.TaskPath -ne '\' -or $Task.Description -cne $Expected.Description -or
        $actions.Count -ne 1 -or $actions[0].Execute -ine $Expected.Executable -or
        $actions[0].Arguments -cne $Expected.Arguments -or $actions[0].WorkingDirectory -ine $Expected.Directory -or
        -not (Test-StartupIdentity $Task.Principal.UserId $Expected) -or $Task.Principal.LogonType -ne 'Interactive' -or
        $Task.Principal.RunLevel -ne 'Limited' -or $triggers.Count -ne 1 -or
        $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or
        -not (Test-StartupIdentity $triggers[0].UserId $Expected) -or -not $triggers[0].Enabled -or
        -not $Task.Settings.Hidden -or -not $Task.Settings.Enabled -or
        $Task.Settings.ExecutionTimeLimit -ne 'PT0S' -or $Task.Settings.MultipleInstances -ne 'IgnoreNew') {
        throw 'TASK_NAME_CONFLICT'
    }
}

function New-StartupTaskDefinition($Expected) {
    $action = New-ScheduledTaskAction -Execute $Expected.Executable -Argument $Expected.Arguments -WorkingDirectory $Expected.Directory
    # LogonTrigger.UserId requires the qualified account name. Keep SID only for ACL/identity comparisons.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $Expected.AccountName
    $principal = New-ScheduledTaskPrincipal -UserId $Expected.AccountName -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $Expected.Description
}

function Invoke-MedboxStartup {
    [CmdletBinding()]
    param([switch]$Apply, [switch]$Inspect, [string]$InstallDirectory = $script:StartupRoot)
    if ($Apply -and $Inspect) { throw 'APPLY_AND_INSPECT_ARE_EXCLUSIVE' }
    if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'RUN_WITH_WINDOWS_POWERSHELL_EXE' }
    Assert-StartupRoot $InstallDirectory
    Assert-NoReparsePoint $InstallDirectory
    $directory = $script:StartupRoot
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $userId = $identity.User.Value
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    Assert-NoReparsePoint $node
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) { throw 'WINDOWS_POWERSHELL_REQUIRED' }
    $files = [ordered]@{}
    foreach ($name in ($script:StartupSources.Keys | Sort-Object)) {
        $source = Join-Path $PSScriptRoot $name
        Assert-NoReparsePoint $source
        $bytes = [IO.File]::ReadAllBytes($source)
        if ((Get-StartupHash $bytes) -cne $script:StartupSources[$name]) { throw 'REVIEWED_SOURCE_HASH_MISMATCH' }
        $files[$name] = $bytes
    }
    # The foreground Node child keeps the task alive. No password, environment dump or raw log is emitted.
    $launcher = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = 'E:\AI_Tools\Codex\data\medbox-model-channel'
foreach ($pair in @(
    @('private-model-channel.mjs', 'f84fa3c513e126689c835289f0278e7d6b14415a55eb150d5a927cbf76a54c4a'),
    @('private_model_socket_lease.py', 'a75341264ffb19762b837ba4fbc89ce7f863bf1523d661948bf9a2ddc7a326ef')
)) {
    $path = Join-Path $root $pair[0]
    if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REPARSE_POINT_REFUSED' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path)))).Replace('-', '') }
    finally { $sha.Dispose() }
    if ($hash -ine $pair[1]) { throw 'REVIEWED_SOURCE_HASH_MISMATCH' }
}
& '__NODE__' (Join-Path $root 'private-model-channel.mjs') --host aliyun-etf --socket /home/etfdeploy/medbox-deploy-1867792/tunnel/ollama.sock --state-dir (Join-Path $root 'state')
exit $LASTEXITCODE
'@
    $launcher = $launcher.Replace('__NODE__', $node.Replace("'", "''"))
    $files['launch-private-model.ps1'] = [Text.UTF8Encoding]::new($false).GetBytes($launcher)
    $manifest = [ordered]@{ schema = 1; userId = $userId; node = $node; hostAlias = 'aliyun-etf'
        socket = '/home/etfdeploy/medbox-deploy-1867792/tunnel/ollama.sock'; sources = $script:StartupSources
        launcherSha256 = Get-StartupHash $files['launch-private-model.ps1'] }
    $files['installation.json'] = [Text.UTF8Encoding]::new($false).GetBytes(($manifest | ConvertTo-Json -Depth 4))
    $expected = [pscustomobject]@{
        Description = 'medbox-private-model-v1:' + (Get-StartupHash $files['installation.json'])
        Executable = $powershell; Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + (Join-Path $directory 'launch-private-model.ps1') + '"'
        Directory = $directory; UserId = $userId; AccountName = $identity.Name
    }
    # Do not suppress scheduler errors: access/transport failures are not evidence that a task is absent.
    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object TaskName -eq 'MedboxPrivateModel')
    if ($tasks.Count -gt 1) { throw 'TASK_NAME_CONFLICT' }
    $task = if ($tasks.Count) { $tasks[0] } else { $null }
    Assert-StartupTask $task $expected
    Test-StartupFiles $directory $files
    Assert-StartupAcl $directory $userId
    $present = @($files.Keys | Where-Object { Test-Path -LiteralPath (Join-Path $directory $_) -PathType Leaf }).Count
    if ($task -and $present -ne $files.Count) { throw 'INSTALLED_TASK_FILES_MISSING' }
    $mode = if ($Inspect) { 'INSPECT' } elseif ($Apply) { 'APPLY' } else { 'PLAN' }
    $result = [ordered]@{ mode = $mode; taskName = 'MedboxPrivateModel'; directory = $directory
        userId = $userId; accountName = $identity.Name; logonType = 'Interactive'; runLevel = 'Limited'; trigger = 'AtLogOn'
        executionTimeLimit = 'PT0S'; node = $node; hostAlias = $manifest.hostAlias; socket = $manifest.socket
        hashes = [ordered]@{}; taskPresent = [bool]$task; filesPresent = $present; started = $false }
    foreach ($name in $files.Keys) { $result.hashes[$name] = Get-StartupHash $files[$name] }
    if ($Apply -and -not $task) {
        # Exclusive creation also rejects races after preflight; existing bytes are never overwritten.
        if (-not (Test-Path -LiteralPath $directory)) { New-StartupDirectory $directory $userId }
        Assert-NoReparsePoint $directory
        Assert-StartupAcl $directory $userId
        foreach ($name in $files.Keys) {
            $path = Join-Path $directory $name
            if (Test-Path -LiteralPath $path) { continue } # Exact bytes were checked above; recheck below.
            $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $stream.Write($files[$name], 0, $files[$name].Length); $stream.Flush($true) }
            finally { $stream.Dispose() }
        }
        Test-StartupFiles $directory $files
        $definition = New-StartupTaskDefinition $expected
        # No -Force, no Start-ScheduledTask, no Stop-Process: preserve existing tasks and manual owners.
        Register-ScheduledTask -TaskName MedboxPrivateModel -TaskPath '\' -InputObject $definition -ErrorAction Stop | Out-Null
        $result.taskPresent = $true
        $result.filesPresent = $files.Count
    }
    $result | ConvertTo-Json -Depth 5
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-MedboxStartup @PSBoundParameters }
