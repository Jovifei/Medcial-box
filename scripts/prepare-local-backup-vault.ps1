# Prepares a local receiver only. No server access, production import, task,
# retention deletion, installation, or off-device recovery is performed.
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$VaultPath = 'E:\AI_Tools\Codex\data\medbox-backup-vault',
    [string]$ScratchRoot = 'E:\Claude_allow\Download\medcial_box',
    [string]$AgePath = '',
    [string]$AgeKeygenPath = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-LocalEPath([string]$Path) {
    if ($Path -notmatch '^[Ee]:[\\/]' -or $Path -match '(^|[\\/])\.\.?([\\/]|$)' -or $Path.Substring(2).Contains(':')) {
        throw 'Only absolute E-drive paths without traversal or alternate streams are allowed.'
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $current = $full
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -Force -LiteralPath $current).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Reparse points are not allowed in the destination or tool path.'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
    return $full
}

function Assert-NewPath([string]$Path) {
    if (Test-Path -LiteralPath $Path) { throw 'Destination already exists; existing identities and backups must be preserved.' }
}

function Assert-Tool([string]$Path, [string]$Name) {
    $full = Assert-LocalEPath $Path
    if ([IO.Path]::GetFileName($full) -ine $Name -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        throw "Supply an existing official $Name executable by its absolute E-drive path."
    }
    return $full
}

function Write-NewBytes([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length) } finally { $stream.Dispose() }
}

function Invoke-QuietTool([string]$File, [string[]]$Arguments, [switch]$AllowFailure) {
    # Tool diagnostics are deliberately withheld: key material must never enter logs.
    $ErrorActionPreference = 'Continue' # Windows PowerShell represents native stderr as ErrorRecord.
    & $File @Arguments 2>&1 | Out-Null
    if ($AllowFailure) { return $LASTEXITCODE }
    if ($LASTEXITCODE -ne 0) { throw 'A local backup verification tool failed; retained files require inspection.' }
}

function Protect-Directory([string]$Path, [Security.Principal.SecurityIdentifier]$Sid) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($Sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($Sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
    $actual = Get-Acl -LiteralPath $Path
    $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $Sid.Value -or
        $rules.Count -ne 1 -or $rules[0].IsInherited -or
        $rules[0].IdentityReference.Value -ne $Sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or
        $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rules[0].InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit') -or
        $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw 'The new directory ACL could not be verified; no identity may be generated.'
    }
}

if ($env:OS -ne 'Windows_NT') { throw 'Windows with NTFS user ACL support is required.' }
$vault = Assert-LocalEPath $VaultPath
$scratch = Assert-LocalEPath $ScratchRoot
if ($vault -ine 'E:\AI_Tools\Codex\data\medbox-backup-vault' -or $scratch -ine 'E:\Claude_allow\Download\medcial_box') {
    throw 'Destination must match the exact owner-approved vault and scratch roots.'
}
if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($vault)) -PathType Container) -or
    -not (Test-Path -LiteralPath $scratch -PathType Container)) {
    throw 'The approved parent directories must already exist; this script does not create tool or download roots.'
}
if ([bool]$AgePath -ne [bool]$AgeKeygenPath) { throw 'Supply both age and age-keygen paths together.' }
if ($AgePath) {
    $AgePath = Assert-Tool $AgePath 'age.exe'
    $AgeKeygenPath = Assert-Tool $AgeKeygenPath 'age-keygen.exe'
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$identity = Join-Path $vault 'identities\local.agekey'
$recovery = Join-Path $vault 'recovery\RECOVERY.json'
$incoming = Join-Path $vault 'encrypted-backups'
if (-not $Apply) {
    [ordered]@{
        State = 'PLAN_ONLY'; VaultPath = $vault; IdentityPath = $identity; RecoveryPath = $recovery
        EncryptedBackupsPath = $incoming; ScratchRoot = $scratch
        VaultExists = (Test-Path -LiteralPath $vault); ApplyWillRefuseExistingVault = $true
        AclPlan = "Protected inheritance; current user SID $($sid.Value) only; FullControl on directories and files"
        Tools = $(if ($AgePath) { 'EXPLICIT_PATHS_VALIDATED_NOT_EXECUTED' } else { 'REQUIRED_FOR_APPLY' })
        Provenance = 'Operator must verify official age release provenance before Apply'
    } | ConvertTo-Json
    exit 0
}
if (-not $AgePath) { throw 'Apply requires explicit paths to operator-verified official age.exe and age-keygen.exe.' }
Assert-NewPath $vault
$run = Join-Path $scratch ('backup-vault-synthetic-' + [Guid]::NewGuid().ToString('N'))
Assert-NewPath $run
# Empty directories may initially inherit ACLs; secrets are created only after
# both final ACLs have been applied and verified. No existing ACL is modified.
New-Item -ItemType Directory -Path $vault | Out-Null
Protect-Directory $vault $sid
New-Item -ItemType Directory -Path $run | Out-Null
Protect-Directory $run $sid
foreach ($directory in @((Join-Path $vault 'identities'), (Join-Path $vault 'recovery'), $incoming)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
}
Invoke-QuietTool $AgeKeygenPath @('-o', $identity)
# -y reads the newly generated identity and returns public information only.
$recipientOutput = @(& $AgeKeygenPath '-y' $identity 2>$null)
if ($LASTEXITCODE -ne 0 -or $recipientOutput.Count -ne 1 -or $recipientOutput[0] -cnotmatch '^age1[0-9a-z]{58}$') {
    throw 'Cannot verify the new public recipient; retained identity must not be overwritten.'
}
$recipient = [string]$recipientOutput[0]
$record = [ordered]@{
    state = 'SYNTHETIC_ONLY'; recipient = $recipient; identityPath = $identity; encryptedBackupsPath = $incoming
    createdUtc = [DateTime]::UtcNow.ToString('o'); recoveryCopy = 'OWNER_ACTION_REQUIRED'
    instructions = @(
        'Retain this identity; losing it makes encrypted backups unrecoverable.',
        'Owner must separately arrange and verify an offline identity recovery copy; none was made here.',
        'Decrypt with official age -d -i IDENTITY -o NEW.zip BACKUP.age, then extract and verify SHA256SUMS.',
        'A real backup must pair database.dump and photos.tar.gz with the same SHA256SUMS.',
        'This preparation does not prove PostgreSQL restore, photo restore, production backup, or off-device recovery.'
    )
}
Write-NewBytes $recovery ([Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 3)))
$source = Join-Path $run 'source'
$restored = Join-Path $run 'restored'
New-Item -ItemType Directory -Path $source | Out-Null
# Deliberately artificial fixtures, not a PostgreSQL dump or photo archive.
Write-NewBytes (Join-Path $source 'database.dump') ([Text.Encoding]::UTF8.GetBytes("SYNTHETIC_ONLY database fixture`n"))
Write-NewBytes (Join-Path $source 'photos.tar.gz') ([byte[]](0, 1, 2, 3, 255, 254, 128, 0))
$sums = @('database.dump', 'photos.tar.gz') | ForEach-Object {
    ((Get-FileHash -LiteralPath (Join-Path $source $_) -Algorithm SHA256).Hash.ToLowerInvariant()) + '  ' + $_
}
Write-NewBytes (Join-Path $source 'SHA256SUMS') ([Text.Encoding]::ASCII.GetBytes(($sums -join "`n") + "`n"))
Add-Type -AssemblyName System.IO.Compression.FileSystem
$package = Join-Path $run 'synthetic-pair.zip'
$encrypted = Join-Path $run 'synthetic-pair.zip.age'
$decrypted = Join-Path $run 'decrypted.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($source, $package)
Invoke-QuietTool $AgePath @('-r', $recipient, '-o', $encrypted, $package)
Invoke-QuietTool $AgePath @('-d', '-i', $identity, '-o', $decrypted, $encrypted)
if ((Get-FileHash -LiteralPath $package).Hash -ne (Get-FileHash -LiteralPath $decrypted).Hash) { throw 'Package byte comparison failed.' }
[IO.Compression.ZipFile]::ExtractToDirectory($decrypted, $restored)
foreach ($name in @('database.dump', 'photos.tar.gz', 'SHA256SUMS')) {
    if ((Get-FileHash -LiteralPath (Join-Path $source $name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $restored $name)).Hash) {
        throw 'Synthetic paired-file byte comparison failed.'
    }
}
$tampered = Join-Path $run 'tampered.zip.age'
$bytes = [IO.File]::ReadAllBytes($encrypted)
$bytes[$bytes.Length - 1] = $bytes[$bytes.Length - 1] -bxor 1
Write-NewBytes $tampered $bytes
$tamperExit = Invoke-QuietTool $AgePath @('-d', '-i', $identity, '-o', (Join-Path $run 'tampered-output.zip'), $tampered) -AllowFailure
if ($tamperExit -eq 0) { throw 'Tampered ciphertext was accepted; synthetic verification failed.' }
$verification = Join-Path $run 'VERIFICATION.json'
$evidence = [ordered]@{
    state = 'SYNTHETIC_ONLY'; pairedFiles = @('database.dump', 'photos.tar.gz', 'SHA256SUMS')
    packageBytesEqual = $true; pairedFileBytesEqual = $true; tamperedCiphertextRejected = $true
    productionBackup = 'NOT_RUN'; realRestore = 'NOT_RUN'; offDeviceRecovery = 'NOT_RUN'
}
Write-NewBytes $verification ([Text.Encoding]::UTF8.GetBytes(($evidence | ConvertTo-Json)))
[ordered]@{
    State = 'SYNTHETIC_ONLY'; Recipient = $recipient; VaultPath = $vault; IdentityPath = $identity
    RecoveryPath = $recovery; EncryptedBackupsPath = $incoming; SyntheticEvidencePath = $verification
} | ConvertTo-Json
