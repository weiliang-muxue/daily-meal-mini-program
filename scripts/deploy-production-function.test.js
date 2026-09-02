'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createHash } = require('crypto')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const script = path.join(__dirname, 'deploy-production-function.ps1')
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const commonArgs = process.platform === 'win32'
  ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
  : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script]

function validateTarget(functionName) {
  const args = [...commonArgs]
  if (functionName !== undefined) args.push('-FunctionName', functionName)
  args.push('-ValidateOnly')
  return spawnSync(shell, args, {
    cwd: root,
    encoding: 'utf8',
    env: {},
    windowsHide: true,
  })
}

const productionFunctions = [
  'membership', 'auth', 'userData', 'health', 'privacy', 'aiPlanner', 'mealAiMaintenance',
]

for (const functionName of productionFunctions) {
  const result = validateTarget(functionName)
  assert.strictEqual(result.status, 0, `${functionName} should pass the production allowlist: ${result.stderr}`)
  assert.strictEqual(result.stdout.trim(), `DEPLOY_TARGET_VALID=${functionName}`)
}

const forbiddenTargets = [
  'ownerBootstrapOnce', '*', '?', '.', '..', '/', '\\',
  'root', 'all', 'ALL', 'cloudfunctions', 'cloudfunctions/*',
  'cloudfunctions/membership', '../membership', 'membership,auth',
  'membership auth', 'Membership', '',
]
for (const functionName of forbiddenTargets) {
  const result = validateTarget(functionName)
  assert.notStrictEqual(result.status, 0, `${JSON.stringify(functionName)} must fail before any CLI call`)
  assert(!result.stdout.includes('DEPLOY_TARGET_VALID='), 'forbidden targets must not be marked valid')
}

const missing = validateTarget(undefined)
assert.notStrictEqual(missing.status, 0, 'an explicit single function is required')

const source = fs.readFileSync(script, 'utf8')
assert(!/[^\x00-\x7F]/.test(source), 'the PowerShell 5.1 entrypoint must remain ASCII encoded')
assert(source.indexOf('if ($ValidateOnly)') < source.indexOf('Resolve-Path -LiteralPath $DeveloperToolsCliPath'),
  'allowlist-only validation must return before resolving or invoking the CLI')
assert(/'--names',\s*\$FunctionName/.test(source), 'deploy must pass exactly the validated function name')
assert(!/'--names',\s*(?:'|")?\*/.test(source), 'deploy must not contain a wildcard target')
assert(!/'--names',\s*\$functionRoot/.test(source), 'deploy must not pass the cloudfunctions root')
assert(!/\.ArgumentList\b/.test(source), 'the script must remain compatible with Windows PowerShell 5.1')
assert(/\$startInfo\.Arguments\s*=/.test(source), 'PowerShell 5.1 compatible process arguments are required')
assert(/\$resultRowPattern/.test(source) && /\$successEvidenceCount\s+-eq\s+1/.test(source),
  'deployment success must require one target-bound positive result row')
assert(/Invoke-EnvironmentLookup/.test(source) && /Start-Sleep -Milliseconds/.test(source),
  'read-only environment lookup must have bounded network retries')
assert(/function Exit-DeployFailure/.test(source), 'runtime failures must use the fixed safe output protocol')
assert(/DEPLOY_STAGE=/.test(source) && /DEPLOY_REMOTE_STATE=/.test(source) && /DEPLOY_RETRY_SAFE=/.test(source),
  'the fixed protocol must expose stage, remote state, and retry safety')
assert(/DEPLOY_STATUS=SUCCEEDED/.test(source), 'deployment success must have a fixed success signal')
assert(!/Write-Output\s+\$result\.Output/.test(source), 'raw CLI output must never be echoed')
assert(!/function\s+Redact-Line/.test(source), 'the script must not depend on incomplete line redaction')
assert(/\^sha256-v1:\[0-9a-f\]\{64\}\$/.test(source)
  && source.includes('meal-planner:production-environment:v1:'),
  'deployment approval must require a versioned, domain-separated lowercase SHA-256 environment fingerprint')
assert(/Assert-ApprovedEnvironment\s+\$candidate/.test(source),
  'the parsed environment must match the independently approved fingerprint before deployment')

const deployInvocation = source.match(/Invoke-CliCapture\s+@\(\s*\n\s*'cloud', 'functions', 'deploy',([\s\S]*?)\n\s*\)/)
assert(deployInvocation, 'the deployment CLI invocation must remain statically reviewable')
const deployOptions = [...deployInvocation[1].matchAll(/'(\-\-[a-z-]+)'/g)].map((match) => match[1])
assert.deepStrictEqual(deployOptions, [
  '--env', '--names', '--project', '--remote-npm-install', '--report', '--port', '--lang',
], 'deployment must use only the reviewed target, package-install, report, port, and language options')
assert(!/(?:environment-variables|env-vars|set-env|update-env|clear-env)/i.test(deployInvocation[1]),
  'deployment must not actively set, replace, or clear aiPlanner environment variables')

if (process.platform === 'win32') {
  const sentinel = 'SECRET_SENTINEL_DO_NOT_ECHO'

  function safeWindowsEnvironment() {
    const allowed = [
      'APPDATA', 'ComSpec', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH',
      'PATHEXT', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
    ]
    const sourceKeys = Object.keys(process.env)
    return allowed.reduce((result, name) => {
      const sourceKey = sourceKeys.find((key) => key.toLowerCase() === name.toLowerCase())
      if (sourceKey && process.env[sourceKey]) result[name] = process.env[sourceKey]
      return result
    }, {})
  }

  function tableRow(functionName, success) {
    return `echo ^| ${functionName} ^| ${success} ^| 1 ^| 2 ^|`
  }

  function currentEnvironmentTable(environmentIds) {
    return [
      'echo ^| (index) ^| Values ^|',
      'echo +---------+------------------------+',
      ...environmentIds.map((environmentId, index) =>
        `echo ^| ${index} ^| '${environmentId}' ^|`),
      'echo +---------+------------------------+',
    ]
  }

  function normalizeOutput(value) {
    return String(value || '').trim().replace(/\r\n/g, '\n')
  }

  function environmentFingerprint(environmentId) {
    const input = `meal-planner:production-environment:v1:${environmentId}`
    return `sha256-v1:${createHash('sha256').update(input, 'utf8').digest('hex')}`
  }

  function runFakeCli({
    envBody,
    deployBody,
    functionName = 'membership',
    approvedEnvironmentId = 'env-prod',
    approvedEnvironmentFingerprint = environmentFingerprint(approvedEnvironmentId),
    includeApprovedEnvironmentFingerprint = true,
  }) {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-cli-test-'))
    const cliPath = path.join(fixtureRoot, 'fake-cli.bat')
    const envCountPath = path.join(fixtureRoot, 'env-count.txt')
    const deployCountPath = path.join(fixtureRoot, 'deploy-count.txt')
    const batch = [
      '@echo off',
      'setlocal EnableExtensions DisableDelayedExpansion',
      'if /i "%~1"=="cloud" if /i "%~2"=="env" if /i "%~3"=="list" goto env_command',
      'if /i "%~1"=="cloud" if /i "%~2"=="functions" if /i "%~3"=="deploy" goto deploy_command',
      `echo [error] unexpected command ${sentinel}`,
      'exit /b 0',
      ':env_command',
      'set "count=0"',
      'if exist "%~dp0env-count.txt" set /p count=<"%~dp0env-count.txt"',
      'set /a count+=1',
      '>"%~dp0env-count.txt" echo %count%',
      ...envBody,
      'exit /b 0',
      ':deploy_command',
      'set "count=0"',
      'if exist "%~dp0deploy-count.txt" set /p count=<"%~dp0deploy-count.txt"',
      'set /a count+=1',
      '>"%~dp0deploy-count.txt" echo %count%',
      ...deployBody,
      'exit /b 0',
      '',
    ].join('\r\n')

    fs.writeFileSync(cliPath, batch, 'ascii')
    try {
      const invocationArgs = [
        ...commonArgs,
        '-FunctionName', functionName,
        '-DeveloperToolsPort', '19430',
        '-DeveloperToolsCliPath', cliPath,
      ]
      if (includeApprovedEnvironmentFingerprint) {
        invocationArgs.push('-ApprovedEnvironmentFingerprint', approvedEnvironmentFingerprint)
      }
      const result = spawnSync(shell, invocationArgs, {
        cwd: root,
        encoding: 'utf8',
        env: safeWindowsEnvironment(),
        windowsHide: true,
        timeout: 15000,
      })
      const readCount = (file) => fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8').trim()) : 0
      return {
        result,
        envCalls: readCount(envCountPath),
        deployCalls: readCount(deployCountPath),
      }
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }

  function assertSafeFailure(run, category, stage, label) {
    const remoteState = stage === 'FUNCTION_DEPLOY' ? 'UNKNOWN' : 'NOT_STARTED'
    const retrySafe = stage === 'FUNCTION_DEPLOY' ? 'NO' : 'YES'
    assert.strictEqual(run.result.status, 1, `${label}: expected exit 1; stderr=${run.result.stderr}`)
    assert.strictEqual(normalizeOutput(run.result.stdout), [
      'FUNCTION=membership',
      `DEPLOY_STAGE=${stage}`,
      `DEPLOY_REMOTE_STATE=${remoteState}`,
      `DEPLOY_RETRY_SAFE=${retrySafe}`,
      'DEPLOY_EXIT=1',
      `DEPLOY_FAILURE=${category}`,
    ].join('\n'), `${label}: output must contain only the fixed failure protocol`)
    assert(!`${run.result.stdout}\n${run.result.stderr}`.includes(sentinel), `${label}: raw CLI output leaked`)
  }

  function assertIdentifiersNotLeaked(run, identifiers, label) {
    const output = `${run.result.stdout}\n${run.result.stderr}`
    for (const identifier of identifiers) {
      assert(!output.includes(identifier), `${label}: environment identifier leaked`)
    }
  }

  let run = runFakeCli({
    envBody: ['echo * env-prod'],
    deployBody: [tableRow('membership', 'true')],
    includeApprovedEnvironmentFingerprint: false,
  })
  assertSafeFailure(run, 'ENVIRONMENT', 'PRECHECK', 'missing environment approval')
  assert.strictEqual(run.envCalls, 0, 'missing approval must fail before environment lookup')
  assert.strictEqual(run.deployCalls, 0, 'missing approval must fail before deployment')

  run = runFakeCli({
    envBody: ['echo * env-prod'],
    deployBody: [tableRow('membership', 'true')],
    approvedEnvironmentFingerprint: 'sha256-v1:INVALID',
  })
  assertSafeFailure(run, 'ENVIRONMENT', 'PRECHECK', 'malformed environment approval')
  assert.strictEqual(run.envCalls, 0, 'malformed approval must fail before environment lookup')
  assert.strictEqual(run.deployCalls, 0, 'malformed approval must fail before deployment')

  run = runFakeCli({
    envBody: [
      'if %count% LSS 3 (',
      `  echo [error] ECONNRESET ${sentinel}`,
      '  exit /b 0',
      ')',
      'echo * env-prod',
    ],
    deployBody: [tableRow('membership', 'true')],
  })
  assert.strictEqual(run.result.status, 0, `network retry should recover: ${run.result.stderr}`)
  assert.strictEqual(normalizeOutput(run.result.stdout), [
    'FUNCTION=membership',
    'DEPLOY_STAGE=FUNCTION_DEPLOY',
    'DEPLOY_REMOTE_STATE=CONFIRMED_SUCCEEDED',
    'DEPLOY_RETRY_SAFE=NOT_NEEDED',
    'DEPLOY_EXIT=0',
    'DEPLOY_STATUS=SUCCEEDED',
  ].join('\n'))
  assert.strictEqual(run.envCalls, 3, 'environment lookup must stop after recovery on attempt 3')
  assert.strictEqual(run.deployCalls, 1, 'deployment must run once after lookup recovery')
  assert(!`${run.result.stdout}\n${run.result.stderr}`.includes(sentinel), 'recovered network output leaked')

  run = runFakeCli({
    envBody: [`echo [error] ECONNRESET ${sentinel}`],
    deployBody: [tableRow('membership', 'true')],
  })
  assertSafeFailure(run, 'NETWORK', 'ENVIRONMENT_LOOKUP', 'network retry exhaustion')
  assert.strictEqual(run.envCalls, 3, 'network lookup must have a hard three-attempt limit')
  assert.strictEqual(run.deployCalls, 0, 'deployment must not run after lookup failure')

  run = runFakeCli({
    envBody: [`echo [error] login required ${sentinel}`],
    deployBody: [tableRow('membership', 'true')],
  })
  assertSafeFailure(run, 'LOGIN', 'ENVIRONMENT_LOOKUP', 'login failure')
  assert.strictEqual(run.envCalls, 1, 'login failures must not be retried')
  assert.strictEqual(run.deployCalls, 0)

  run = runFakeCli({
    envBody: [`echo [error] invalid request ${sentinel}`],
    deployBody: [tableRow('membership', 'true')],
  })
  assertSafeFailure(run, 'CLI_ERROR', 'ENVIRONMENT_LOOKUP', 'CLI-reported lookup failure')
  assert.strictEqual(run.envCalls, 1, 'CLI errors must not be retried')
  assert.strictEqual(run.deployCalls, 0)

  run = runFakeCli({
    envBody: [`echo unclassified failure ${sentinel}`, 'exit /b 9'],
    deployBody: [tableRow('membership', 'true')],
  })
  assertSafeFailure(run, 'CLI_ERROR', 'ENVIRONMENT_LOOKUP', 'nonzero lookup exit')
  assert.strictEqual(run.envCalls, 1, 'unclassified nonzero exits must not be retried')
  assert.strictEqual(run.deployCalls, 0)

  run = runFakeCli({
    envBody: ['echo * env-one', 'echo * env-two'],
    deployBody: [tableRow('membership', 'true')],
  })
  assertSafeFailure(run, 'ENVIRONMENT', 'ENVIRONMENT_LOOKUP', 'ambiguous environment selection')
  assert.strictEqual(run.envCalls, 1)
  assert.strictEqual(run.deployCalls, 0)

  const currentEnvironmentId = 'meal-test-1a2b3c4d'
  run = runFakeCli({
    envBody: currentEnvironmentTable([currentEnvironmentId]),
    deployBody: [tableRow('membership', 'true')],
    approvedEnvironmentId: currentEnvironmentId,
  })
  assert.strictEqual(run.result.status, 0, `current environment table should succeed: ${run.result.stderr}`)
  assert.strictEqual(normalizeOutput(run.result.stdout), [
    'FUNCTION=membership',
    'DEPLOY_STAGE=FUNCTION_DEPLOY',
    'DEPLOY_REMOTE_STATE=CONFIRMED_SUCCEEDED',
    'DEPLOY_RETRY_SAFE=NOT_NEEDED',
    'DEPLOY_EXIT=0',
    'DEPLOY_STATUS=SUCCEEDED',
  ].join('\n'))
  assertIdentifiersNotLeaked(run, [currentEnvironmentId], 'current environment success')
  assert.strictEqual(run.envCalls, 1)
  assert.strictEqual(run.deployCalls, 1)

  const currentEnvironmentIds = ['meal-test-1a2b3c4d', 'meal-test-5e6f7a8b']
  run = runFakeCli({
    envBody: currentEnvironmentTable(currentEnvironmentIds),
    deployBody: [tableRow('membership', 'true')],
  })
  assertSafeFailure(run, 'ENVIRONMENT', 'ENVIRONMENT_LOOKUP', 'multiple current environments')
  assertIdentifiersNotLeaked(run, currentEnvironmentIds, 'multiple current environments')
  assert.strictEqual(run.envCalls, 1)
  assert.strictEqual(run.deployCalls, 0)

  const approvedEnvironmentId = 'env-approved'
  const selectedEnvironmentId = 'env-not-approved'
  const approvedFingerprint = environmentFingerprint(approvedEnvironmentId)
  run = runFakeCli({
    envBody: [`echo * ${selectedEnvironmentId}`],
    deployBody: [tableRow('membership', 'true')],
    approvedEnvironmentFingerprint: approvedFingerprint,
  })
  assertSafeFailure(run, 'ENVIRONMENT', 'ENVIRONMENT_LOOKUP', 'environment fingerprint mismatch')
  assertIdentifiersNotLeaked(run, [
    approvedEnvironmentId, selectedEnvironmentId, approvedFingerprint,
    environmentFingerprint(selectedEnvironmentId),
  ], 'environment fingerprint mismatch')
  assert.strictEqual(run.envCalls, 1)
  assert.strictEqual(run.deployCalls, 0, 'deployment must not run for an unapproved environment')

  const malformedEnvironmentId = 'meal-test-9a0b1c2d'
  run = runFakeCli({
    envBody: [
      'echo ^| (index) ^| Value ^|',
      'echo +---------+------------------------+',
      `echo ^| 0 ^| '${malformedEnvironmentId}' ^|`,
      'echo +---------+------------------------+',
      `echo ${sentinel}`,
    ],
    deployBody: [tableRow('membership', 'true')],
  })
  assertSafeFailure(run, 'ENVIRONMENT', 'ENVIRONMENT_LOOKUP', 'malformed current environment table')
  assertIdentifiersNotLeaked(run, [malformedEnvironmentId], 'malformed current environment table')
  assert.strictEqual(run.envCalls, 1)
  assert.strictEqual(run.deployCalls, 0)

  const deploymentFailures = [
    { label: 'exit zero without evidence', body: [`echo deployment ended ${sentinel}`], category: 'CLI_ERROR' },
    { label: 'negative result row', body: [tableRow('membership', 'false'), `echo ${sentinel}`], category: 'CLI_ERROR' },
    { label: 'different function row', body: [tableRow('auth', 'true'), `echo ${sentinel}`], category: 'CLI_ERROR' },
    { label: 'duplicate positive rows', body: [tableRow('membership', 'true'), tableRow('membership', 'true'), `echo ${sentinel}`], category: 'CLI_ERROR' },
    { label: 'positive row plus error', body: [tableRow('membership', 'true'), `echo [error] rejected ${sentinel}`], category: 'CLI_ERROR' },
    { label: 'positive row with nonzero exit', body: [tableRow('membership', 'true'), `echo ${sentinel}`, 'exit /b 7'], category: 'CLI_ERROR' },
    { label: 'deployment network failure', body: [`echo [error] ECONNRESET ${sentinel}`], category: 'NETWORK' },
  ]
  for (const scenario of deploymentFailures) {
    run = runFakeCli({ envBody: ['echo * env-prod'], deployBody: scenario.body })
    assertSafeFailure(run, scenario.category, 'FUNCTION_DEPLOY', scenario.label)
    assert.strictEqual(run.envCalls, 1, `${scenario.label}: lookup count`)
    assert.strictEqual(run.deployCalls, 1, `${scenario.label}: deployment must never retry`)
  }

  run = runFakeCli({
    envBody: ['echo * env-prod'],
    deployBody: [tableRow('aiPlanner', 'true')],
    functionName: 'aiPlanner',
  })
  assert.strictEqual(run.result.status, 0, `positive evidence should succeed: ${run.result.stderr}`)
  assert.strictEqual(normalizeOutput(run.result.stdout), [
    'FUNCTION=aiPlanner',
    'DEPLOY_STAGE=FUNCTION_DEPLOY',
    'DEPLOY_REMOTE_STATE=CONFIRMED_SUCCEEDED',
    'DEPLOY_RETRY_SAFE=NOT_NEEDED',
    'DEPLOY_EXIT=0',
    'DEPLOY_STATUS=SUCCEEDED',
  ].join('\n'))
  assert.strictEqual(run.envCalls, 1)
  assert.strictEqual(run.deployCalls, 1)

  const missingCli = path.join(os.tmpdir(), `${sentinel}-missing-cli.bat`)
  const missingCliResult = spawnSync(shell, [
    ...commonArgs,
    '-FunctionName', 'membership',
    '-DeveloperToolsCliPath', missingCli,
    '-ApprovedEnvironmentFingerprint', environmentFingerprint('env-prod'),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: safeWindowsEnvironment(),
    windowsHide: true,
    timeout: 15000,
  })
  assertSafeFailure({ result: missingCliResult }, 'CLI_ERROR', 'PRECHECK', 'missing CLI path')
}

console.log('Production deployment gate passed: allowlist, bounded lookup retries, positive evidence, and safe output verified.')
