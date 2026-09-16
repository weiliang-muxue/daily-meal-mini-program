[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$FunctionName,

  [ValidateRange(1024, 65535)]
  [int]$DeveloperToolsPort = 9430,

  [ValidateNotNullOrEmpty()]
  [string]$DeveloperToolsCliPath = 'D:\WeChatDevTools\cli.bat',

  [string]$ApprovedEnvironmentFingerprint,

  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$productionFunctions = @(
  'membership',
  'auth',
  'userData',
  'health',
  'privacy',
  'aiPlanner',
  'mealAiMaintenance'
)

# This exact, case-sensitive check is the release deployment boundary. It rejects
# bootstrap helpers, wildcards, paths, aliases and full-directory deployment.
if (-not ($productionFunctions -ccontains $FunctionName)) {
  throw 'DEPLOY_FUNCTION_NOT_ALLOWED'
}

if ($ValidateOnly) {
  Write-Output "DEPLOY_TARGET_VALID=$FunctionName"
  return
}

function Exit-DeployFailure([string]$Category, [string]$Stage) {
  $safeCategories = @('NETWORK', 'LOGIN', 'ENVIRONMENT', 'CLI_ERROR')
  $safeStages = @('PRECHECK', 'ENVIRONMENT_LOOKUP', 'FUNCTION_DEPLOY')
  if (-not ($safeCategories -ccontains $Category)) { $Category = 'CLI_ERROR' }
  if (-not ($safeStages -ccontains $Stage)) { $Stage = 'PRECHECK' }
  $remoteState = if ($Stage -ceq 'FUNCTION_DEPLOY') { 'UNKNOWN' } else { 'NOT_STARTED' }
  $retrySafe = if ($remoteState -ceq 'NOT_STARTED') { 'YES' } else { 'NO' }
  Write-Output "FUNCTION=$FunctionName"
  Write-Output "DEPLOY_STAGE=$Stage"
  Write-Output "DEPLOY_REMOTE_STATE=$remoteState"
  Write-Output "DEPLOY_RETRY_SAFE=$retrySafe"
  Write-Output 'DEPLOY_EXIT=1'
  Write-Output "DEPLOY_FAILURE=$Category"
  exit 1
}

if ([string]::IsNullOrWhiteSpace($ApprovedEnvironmentFingerprint) -or
    $ApprovedEnvironmentFingerprint -cnotmatch '^sha256-v1:[0-9a-f]{64}$') {
  Exit-DeployFailure 'ENVIRONMENT' 'PRECHECK'
}

function Get-EnvironmentFingerprint([string]$EnvironmentIdentifier) {
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $fingerprintInput = "meal-planner:production-environment:v1:$EnvironmentIdentifier"
    $bytes = [Text.Encoding]::UTF8.GetBytes($fingerprintInput)
    $digest = $sha256.ComputeHash($bytes)
    return 'sha256-v1:' + (($digest | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $sha256.Dispose()
  }
}

function Assert-ApprovedEnvironment([string]$EnvironmentIdentifier) {
  $actualFingerprint = Get-EnvironmentFingerprint $EnvironmentIdentifier
  if ($actualFingerprint -cne $ApprovedEnvironmentFingerprint) {
    throw 'CLOUD_ENVIRONMENT_FINGERPRINT_MISMATCH'
  }
}

try {
  $cliPath = (Resolve-Path -LiteralPath $DeveloperToolsCliPath).Path
  $projectPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
  $functionRoot = (Resolve-Path -LiteralPath (Join-Path $projectPath 'cloudfunctions')).Path
  $functionPath = (Resolve-Path -LiteralPath (Join-Path $functionRoot $FunctionName)).Path
} catch {
  Exit-DeployFailure 'CLI_ERROR' 'PRECHECK'
}
if ((Split-Path -Parent $functionPath) -cne $functionRoot -or
    (Split-Path -Leaf $functionPath) -cne $FunctionName) {
  Exit-DeployFailure 'CLI_ERROR' 'PRECHECK'
}

function Invoke-CliCapture([string[]]$Arguments) {
  $safeEnvironmentNames = @(
    'APPDATA', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH',
    'PATHEXT', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR'
  )
  $safeEnvironment = @{}
  foreach ($name in $safeEnvironmentNames) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $safeEnvironment[$name] = $value }
  }

  function Quote-CmdToken([string]$Value) {
    if (-not $Value -or $Value -match '[\r\n"%!&|<>^]') { throw 'CLI_ARGUMENT_INVALID' }
    return '"' + $Value + '"'
  }

  $tokens = @($cliPath) + $Arguments
  $commandLine = 'call ' + (($tokens | ForEach-Object { Quote-CmdToken ([string]$_) }) -join ' ')
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $safeEnvironment['ComSpec']
  $startInfo.WorkingDirectory = $projectPath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $utf8Encoding = [Text.UTF8Encoding]::new($false)
  $startInfo.StandardOutputEncoding = $utf8Encoding
  $startInfo.StandardErrorEncoding = $utf8Encoding
  # Windows PowerShell 5.1 uses the .NET Framework ProcessStartInfo, which has
  # Arguments but not ArgumentList. Every embedded token was rejected above if
  # it contained cmd metacharacters, so this quoted command line stays bounded.
  $startInfo.Arguments = '/d /s /c "' + $commandLine + '"'
  $startInfo.Environment.Clear()
  foreach ($entry in $safeEnvironment.GetEnumerator()) { $startInfo.Environment[$entry.Key] = $entry.Value }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'CLI_PROCESS_START_FAILED' }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $rawOutput = $stdout.GetAwaiter().GetResult() + "`n" + $stderr.GetAwaiter().GetResult()
  $ansiPattern = [regex]::Escape([string][char]27) + '\[[0-9;?]*[ -/]*[@-~]'
  $output = @($rawOutput -split '\r?\n' | ForEach-Object {
    ([string]$_) -replace $ansiPattern, ''
  })
  $joined = $output -join "`n"
  $reportedFailure = ''
  if ($joined -match '(?i)ECONNRESET|ETIMEDOUT|ENETUNREACH|socket disconnected|TLS connection') {
    $reportedFailure = 'NETWORK'
  } elseif ($joined -match '(?i)not logged|login required|login expired|\u672A\u767B\u5F55|\u8BF7\u767B\u5F55|\u767B\u5F55\u5931\u6548') {
    $reportedFailure = 'LOGIN'
  } elseif ($output | Where-Object { [string]$_ -match '^\s*(?:\u00D7|\[error\])' }) {
    $reportedFailure = 'CLI_ERROR'
  }
  return [PSCustomObject]@{
    ExitCode = $process.ExitCode
    Output = $output
    ReportedFailure = $reportedFailure
  }
}

function Invoke-EnvironmentLookup {
  $delays = @(200, 500)
  for ($attempt = 0; $attempt -lt 3; $attempt += 1) {
    $result = Invoke-CliCapture @(
      'cloud', 'env', 'list',
      '--project', $projectPath,
      '--port', ([string]$DeveloperToolsPort),
      '--lang', 'zh'
    )
    if ($result.ExitCode -eq 0 -and -not $result.ReportedFailure) { return $result }
    if ($result.ReportedFailure -ne 'NETWORK' -or $attempt -ge 2) {
      $category = if ($result.ReportedFailure) { $result.ReportedFailure } else { 'CLI_ERROR' }
      throw "CLOUD_ENVIRONMENT_LOOKUP_$category"
    }
    Start-Sleep -Milliseconds $delays[$attempt]
  }
  throw 'CLOUD_ENVIRONMENT_LOOKUP_NETWORK'
}

function Get-TargetEnvironment {
  $result = Invoke-EnvironmentLookup

  $legacyLines = @($result.Output | Where-Object { ([string]$_).TrimStart().StartsWith('*') })
  if ($legacyLines.Count -gt 0) {
    $legacyCandidates = @()
    foreach ($line in $legacyLines) {
      if (-not ([string]$line -match '^\*\s+([A-Za-z0-9_-]+)\s*$')) {
        throw 'CLOUD_ENVIRONMENT_SELECTION_INVALID'
      }
      $legacyCandidates += $Matches[1]
    }
    if ($legacyCandidates.Count -ne 1) { throw 'CLOUD_ENVIRONMENT_SELECTION_INVALID' }
    $candidate = $legacyCandidates[0]
    Assert-ApprovedEnvironment $candidate
    return $candidate
  }

  # Newer Developer Tools versions can render a single environment as a
  # bounded table instead of the legacy "* env-id" row. Parse only a complete
  # one-row table with a known schema; never scan arbitrary CLI text for an ID.
  $tableLines = @()
  $tableStarted = $false
  $tableEnded = $false
  foreach ($line in $result.Output) {
    $trimmed = ([string]$line).Trim()
    if (-not $trimmed) { continue }
    $isTableLine = $trimmed -match '[|\u2502]' -or
      $trimmed -match '^[+\-=:\s\u2500-\u257F]+$'
    if ($isTableLine) {
      if ($tableEnded) { throw 'CLOUD_ENVIRONMENT_SELECTION_INVALID' }
      $tableStarted = $true
      $tableLines += $trimmed
    } elseif ($tableStarted) {
      $tableEnded = $true
    }
  }
  if ($tableLines.Count -lt 3 -or $tableLines.Count -gt 5) {
    throw 'CLOUD_ENVIRONMENT_SELECTION_INVALID'
  }

  $contentRows = @($tableLines | Where-Object {
    -not ([string]$_ -match '^[+\-=:\s|\u2500-\u257F]+$')
  })
  if ($contentRows.Count -ne 2) { throw 'CLOUD_ENVIRONMENT_SELECTION_INVALID' }

  function Split-EnvironmentTableRow([string]$Line) {
    $cells = @($Line -split '[|\u2502]' | ForEach-Object { ([string]$_).Trim() })
    if ($cells.Count -gt 0 -and -not $cells[0]) { $cells = @($cells | Select-Object -Skip 1) }
    if ($cells.Count -gt 0 -and -not $cells[$cells.Count - 1]) {
      $cells = @($cells | Select-Object -First ($cells.Count - 1))
    }
    return @($cells)
  }

  function Unquote-EnvironmentTableCell([string]$Value) {
    $cell = $Value.Trim()
    if ($cell.Length -ge 2 -and
        (($cell[0] -eq "'" -and $cell[$cell.Length - 1] -eq "'") -or
         ($cell[0] -eq '"' -and $cell[$cell.Length - 1] -eq '"'))) {
      return $cell.Substring(1, $cell.Length - 2)
    }
    return $cell
  }

  $headers = @(Split-EnvironmentTableRow $contentRows[0])
  $values = @(Split-EnvironmentTableRow $contentRows[1])
  if ($headers.Count -ne $values.Count -or $headers.Count -lt 1 -or $headers.Count -gt 6) {
    throw 'CLOUD_ENVIRONMENT_SELECTION_INVALID'
  }

  $normalizedHeaders = @($headers | ForEach-Object {
    ((Unquote-EnvironmentTableCell ([string]$_)) -replace '[\s_-]', '').ToLowerInvariant()
  })
  $environmentColumn = -1
  if ($normalizedHeaders.Count -eq 2 -and
      $normalizedHeaders[0] -ceq '(index)' -and
      $normalizedHeaders[1] -ceq 'values') {
    if ((Unquote-EnvironmentTableCell $values[0]) -cne '0') {
      throw 'CLOUD_ENVIRONMENT_SELECTION_INVALID'
    }
    $environmentColumn = 1
  } else {
    $allowedHeaders = @(
      '(index)', 'environmentid', 'envid', 'alias', 'name', 'status',
      'source', 'type', 'current'
    )
    for ($index = 0; $index -lt $normalizedHeaders.Count; $index += 1) {
      $header = $normalizedHeaders[$index]
      if (-not ($allowedHeaders -ccontains $header)) {
        throw 'CLOUD_ENVIRONMENT_SELECTION_INVALID'
      }
      if ($header -ceq 'environmentid' -or $header -ceq 'envid') {
        if ($environmentColumn -ge 0) { throw 'CLOUD_ENVIRONMENT_SELECTION_INVALID' }
        $environmentColumn = $index
      }
    }
  }
  if ($environmentColumn -lt 0) { throw 'CLOUD_ENVIRONMENT_SELECTION_INVALID' }

  $candidate = Unquote-EnvironmentTableCell $values[$environmentColumn]
  if ($candidate -cnotmatch '^[A-Za-z][A-Za-z0-9_-]{0,47}-[A-Za-z0-9]{8,32}$') {
    throw 'CLOUD_ENVIRONMENT_SELECTION_INVALID'
  }
  Assert-ApprovedEnvironment $candidate
  return $candidate
}

function Has-DeploymentSuccess($Result, [string]$ExpectedFunctionName) {
  if ($Result.ExitCode -ne 0 -or $Result.ReportedFailure) { return $false }
  $successEvidenceCount = 0
  $resultRowPattern = '(?:\u2502|\|)\s*([^\u2502|\r\n]+?)\s*(?:\u2502|\|)\s*(true|false)\s*(?:\u2502|\|)'
  foreach ($line in $Result.Output) {
    if (-not ([string]$line -match $resultRowPattern)) { continue }
    if ($Matches[1].Trim() -cne $ExpectedFunctionName) { return $false }
    if ($Matches[2] -ine 'true') { return $false }
    $successEvidenceCount += 1
  }
  return $successEvidenceCount -eq 1
}

try {
  $targetEnvironment = Get-TargetEnvironment
} catch {
  $lookupFailure = [string]$_.Exception.Message
  $category = switch -Exact ($lookupFailure) {
    'CLOUD_ENVIRONMENT_LOOKUP_NETWORK' { 'NETWORK' }
    'CLOUD_ENVIRONMENT_LOOKUP_LOGIN' { 'LOGIN' }
    'CLOUD_ENVIRONMENT_SELECTION_INVALID' { 'ENVIRONMENT' }
    'CLOUD_ENVIRONMENT_FINGERPRINT_MISMATCH' { 'ENVIRONMENT' }
    default { 'CLI_ERROR' }
  }
  Exit-DeployFailure $category 'ENVIRONMENT_LOOKUP'
}
try {
  $result = Invoke-CliCapture @(
    'cloud', 'functions', 'deploy',
    '--env', $targetEnvironment,
    '--names', $FunctionName,
    '--project', $projectPath,
    '--remote-npm-install',
    '--report',
    '--port', ([string]$DeveloperToolsPort),
    '--lang', 'zh'
  )
} catch {
  # Once the deploy command is attempted, a local error cannot prove whether
  # the remote service accepted the request. Never imply that retry is safe.
  Exit-DeployFailure 'CLI_ERROR' 'FUNCTION_DEPLOY'
}

$effectiveExitCode = if (Has-DeploymentSuccess $result $FunctionName) { 0 } else { 1 }
if ($effectiveExitCode -ne 0) {
  $category = if ($result.ReportedFailure) { $result.ReportedFailure } else { 'CLI_ERROR' }
  Exit-DeployFailure $category 'FUNCTION_DEPLOY'
}
Write-Output "FUNCTION=$FunctionName"
Write-Output 'DEPLOY_STAGE=FUNCTION_DEPLOY'
Write-Output 'DEPLOY_REMOTE_STATE=CONFIRMED_SUCCEEDED'
Write-Output 'DEPLOY_RETRY_SAFE=NOT_NEEDED'
Write-Output 'DEPLOY_EXIT=0'
Write-Output 'DEPLOY_STATUS=SUCCEEDED'
