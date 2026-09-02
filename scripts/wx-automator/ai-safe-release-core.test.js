'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  acquireCleanupLock,
  acquireOwnership,
  buildReleaseStartRequest,
  claimRecoveryJournal,
  classifyCleanupSnapshot,
  classifyTestSaveSnapshot,
  clearRecoveryJournal,
  clone,
  mergeExpectedPreferences,
  nextCleanupPhase,
  parseProbeArguments,
  PUBLIC_TASK_ERROR_CATEGORIES,
  RELEASE_COMPATIBILITY,
  releaseCleanupLock,
  releaseServiceCompatible,
  selectRecoveryAction,
  classifyPublicTaskErrorCode,
  stateInvariantMatches,
  stateInvariantSnapshot,
} = require('./ai-safe-release-core')

const OWNER_A = 'a'.repeat(48)
const OWNER_B = 'b'.repeat(48)
const tests = []

function test(name, fn) { tests.push({ name, fn }) }

function withTempJournal(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meal-ai-recovery-test-'))
  const journalPath = path.join(directory, 'recovery.json')
  try { return fn(journalPath) } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

function journalOptions(journalPath, overrides = {}) {
  return {
    journalPath,
    durationDays: 7,
    pid: 41001,
    processInstanceId: '1'.repeat(32),
    isPidAlive: () => false,
    randomHex: (bytes) => (bytes === 24 ? 'c'.repeat(48) : 'd'.repeat(32)),
    now: () => 1000,
    ...overrides,
  }
}

function failure(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function originalPreferences(durationDays) {
  return {
    contractVersion: 2,
    durationDays,
    startDate: '2026-08-31',
    mealTypes: ['breakfast', 'lunch', 'dinner'],
    goals: ['original'],
    exerciseIntent: 'daily',
    futureRoot: { schemaVersion: 99, nested: { keep: true } },
    exerciseByDay: Array.from({ length: durationDays }, (_, dayIndex) => ({
      dayIndex,
      planned: dayIndex % 2 === 0,
      type: 'walk',
      durationMinutes: 20,
      intensity: 'low',
      futureExerciseField: `future-${dayIndex}`,
      futureNested: { day: dayIndex },
    })),
  }
}

function requestedPreferences(durationDays) {
  return {
    contractVersion: 2,
    durationDays,
    startDate: '2026-09-01',
    mealTypes: ['breakfast'],
    goals: ['probe'],
    exerciseIntent: 'none',
    exerciseByDay: Array.from({ length: durationDays }, (_, index) => {
      const dayIndex = durationDays - index - 1
      return {
        dayIndex,
        planned: false,
        type: '',
        durationMinutes: 0,
        intensity: 'medium',
      }
    }),
  }
}

function cleanupContext(original, probe) {
  return {
    originalPreferences: original,
    testPreferences: probe,
    baseRevision: 10,
    expectedRevision: 11,
    testSaveCommitted: true,
    draftPlanId: 'draft-owned',
    discardRequest: null,
    restoreRequest: {
      action: 'saveState',
      state: { generationPreferences: clone(original) },
      expectedStateRevision: 12,
      expectedCacheNamespace: 'c'.repeat(32),
    },
  }
}

function testSaveSnapshot(context, overrides = {}) {
  return {
    stateRevision: context.baseRevision + 1,
    generationPreferences: clone(context.testPreferences),
    draftPlan: null,
    invariantMatches: true,
    ...overrides,
  }
}

test('accepts strict integer durations throughout the 1-14 day range', () => {
  for (const duration of [1, 2, 6, 7, 10, 13, 14]) {
    assert.deepEqual(parseProbeArguments([String(duration), '--exclusive-session-ack']), {
      ok: true, code: 'OK', duration, exclusiveSessionAck: true,
    })
  }
})

test('rejects missing, invalid, reordered, duplicate, and unknown arguments', () => {
  const invalidCases = [
    [],
    ['7'],
    ['0', '--exclusive-session-ack'],
    ['15', '--exclusive-session-ack'],
    ['7.0', '--exclusive-session-ack'],
    ['07', '--exclusive-session-ack'],
    ['--exclusive-session-ack', '7'],
    ['7', '--exclusive-session-ack', '--exclusive-session-ack'],
    ['7', '--exclusive-session-ack', '--unknown'],
    ['7', '--unknown'],
  ]
  invalidCases.forEach((args) => {
    assert.deepEqual(parseProbeArguments(args), {
      ok: false, code: 'INVALID_ARGUMENTS', duration: 0, exclusiveSessionAck: false,
    }, `unexpectedly accepted ${JSON.stringify(args)}`)
  })
})

test('pins the release probe contract and carries the public provider revision into consent', () => {
  assert.deepEqual(RELEASE_COMPATIBILITY, {
    contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2,
    providerContractRevision: 9, taskSchemaVersion: 3,
  })
  assert.equal(releaseServiceCompatible({
    configured: true, storageReady: true, contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2,
    providerContractRevision: 9, providerRevision: 23,
  }), true)
  for (const incompatible of [
    { configured: true, storageReady: true, contractVersion: 1, plannerVersion: '7', aiDataConsentVersion: 2, providerContractRevision: 9 },
    { configured: true, storageReady: true, contractVersion: 2, plannerVersion: '6', aiDataConsentVersion: 2, providerContractRevision: 9 },
    { configured: true, storageReady: true, contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 1, providerContractRevision: 9 },
    { configured: true, storageReady: true, contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2 },
    { configured: true, storageReady: true, contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2, providerContractRevision: 6 },
    { configured: true, storageReady: true, contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2, providerContractRevision: 8, providerRevision: 23 },
    { configured: true, storageReady: true, contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2, providerContractRevision: 9 },
    { configured: true, storageReady: true, contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2, providerContractRevision: 9, providerRevision: 0 },
    { configured: true, storageReady: true, contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2, providerContractRevision: 9, providerRevision: 1.5 },
    { configured: true, storageReady: true, contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2, providerContractRevision: 9, providerRevision: '23' },
  ]) assert.equal(releaseServiceCompatible(incompatible), false)

  const preferences = requestedPreferences(10)
  const request = buildReleaseStartRequest(preferences, 11, 'a'.repeat(48), 'b'.repeat(32), 23)
  assert.deepEqual(request, {
    action: 'start', preferences, expectedStateRevision: 11, clientRequestId: 'a'.repeat(48),
    aiDataConsent: { accepted: true, version: 2, providerRevision: 23 },
    expectedCacheNamespace: 'b'.repeat(32),
  })
  for (const providerRevision of [undefined, null, 0, -1, 1.5, '23']) {
    assert.throws(
      () => buildReleaseStartRequest(
        preferences, 11, 'a'.repeat(48), 'b'.repeat(32), providerRevision,
      ),
      /INVALID_RELEASE_START_REQUEST/,
    )
  }
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'taskSchemaVersion'), false,
    'task schema is assigned and verified by the server, not selected by a client request')
  const serverTaskCore = fs.readFileSync(path.resolve(__dirname, '..', '..', 'cloudfunctions', 'aiPlanner', 'task-core.js'), 'utf8')
  assert.match(serverTaskCore, /const TASK_SCHEMA_VERSION = 3\b/)
  const probeSource = fs.readFileSync(path.resolve(__dirname, 'ai-safe-release-probe.js'), 'utf8')
  assert.match(probeSource, /state\.providerRevision = service\.data\.providerRevision/)
  assert.match(probeSource, /providerRevision:\s*state\.providerRevision/)
  assert.doesNotMatch(
    probeSource,
    /aiDataConsent:\s*\{\s*accepted:\s*true,\s*version:\s*compatibility\.aiDataConsentVersion\s*\}/,
  )
})

test('classifies only the fixed public task error-code allowlist', () => {
  assert.equal(Object.isFrozen(PUBLIC_TASK_ERROR_CATEGORIES), true)
  assert.deepEqual(PUBLIC_TASK_ERROR_CATEGORIES, {
    AI_CONFIGURATION_INVALID: 'AI_KEY_MISSING',
    AI_STORAGE_NOT_READY: 'AI_STORAGE_NOT_READY',
    AI_UPSTREAM_AUTH_REJECTED: 'AI_AUTH_REJECTED',
    AI_UPSTREAM_FORBIDDEN: 'AI_FORBIDDEN',
    AI_UPSTREAM_MODEL_UNAVAILABLE: 'AI_MODEL_UNAVAILABLE',
    AI_UPSTREAM_ENDPOINT_NOT_FOUND: 'AI_RESPONSES_ENDPOINT_NOT_FOUND',
    AI_UPSTREAM_PARAMETER_REJECTED: 'AI_RESPONSES_PARAMETER_REJECTED',
    AI_UPSTREAM_REQUEST_REJECTED: 'AI_RESPONSES_PROTOCOL_REJECTED',
    AI_REQUEST_INVALID: 'AI_RESPONSES_PROTOCOL_REJECTED',
    AI_REQUEST_TOO_LARGE: 'AI_RESPONSES_PROTOCOL_REJECTED',
    AI_UPSTREAM_POLICY_REJECTED: 'AI_POLICY_REJECTED',
    AI_NETWORK_ERROR: 'AI_NETWORK_FAILED',
    AI_RATE_LIMITED: 'AI_RATE_LIMITED',
    AI_UPSTREAM_RATE_LIMITED: 'AI_RATE_LIMITED',
    AI_TIMEOUT: 'AI_TIMEOUT',
    AI_STEP_TIMEOUT: 'AI_TIMEOUT',
    AI_TASK_EXPIRED: 'AI_TIMEOUT',
    AI_UPSTREAM_REJECTED: 'AI_UPSTREAM_UNAVAILABLE',
    AI_UPSTREAM_FAILED: 'AI_UPSTREAM_UNAVAILABLE',
    AI_UPSTREAM_UNAVAILABLE: 'AI_UPSTREAM_UNAVAILABLE',
    AI_RESPONSE_ERROR: 'AI_RESPONSE_CONTRACT_REJECTED',
    AI_RESPONSE_INVALID: 'AI_RESPONSE_CONTRACT_REJECTED',
    AI_RESPONSE_INCOMPLETE: 'AI_RESPONSE_CONTRACT_REJECTED',
    AI_RESPONSE_NOT_COMPLETED: 'AI_RESPONSE_CONTRACT_REJECTED',
    AI_RESPONSE_REFUSED: 'AI_RESPONSE_CONTRACT_REJECTED',
    AI_RESPONSE_TOO_LARGE: 'AI_RESPONSE_CONTRACT_REJECTED',
    AI_OUTPUT_INVALID: 'AI_RESPONSE_CONTRACT_REJECTED',
    AI_PLANNER_VERSION_UNSUPPORTED: 'AI_VERSION_MISMATCH',
    AI_CONTRACT_VERSION_UNSUPPORTED: 'AI_VERSION_MISMATCH',
    AI_TASK_SCHEMA_VERSION_UNSUPPORTED: 'AI_VERSION_MISMATCH',
    AI_TASK_VERSION_INVALID: 'AI_VERSION_MISMATCH',
    AI_DATA_CONSENT_REQUIRED: 'AI_STATE_CONFLICT',
    STATE_REVISION_CONFLICT: 'AI_STATE_CONFLICT',
    STALE_DATA_GENERATION: 'AI_STATE_CONFLICT',
    AI_GENERATION_FAILED: 'GENERATION_FAILED',
  })
  Object.entries(PUBLIC_TASK_ERROR_CATEGORIES).forEach(([code, category]) => {
    assert.equal(classifyPublicTaskErrorCode(code), category)
  })
  for (const unreviewed of [
    '', null, undefined, 'AI_FUTURE_ERROR', 'https://provider.invalid/private',
    'Bearer secret-value', '__proto__', { errorCode: 'AI_TIMEOUT' },
  ]) {
    assert.equal(classifyPublicTaskErrorCode(unreviewed), 'GENERATION_FAILED')
  }
})

test('keeps safe endpoint and parameter diagnoses distinct from generic protocol rejection', () => {
  assert.equal(
    classifyPublicTaskErrorCode('AI_UPSTREAM_ENDPOINT_NOT_FOUND'),
    'AI_RESPONSES_ENDPOINT_NOT_FOUND',
  )
  assert.equal(
    classifyPublicTaskErrorCode('AI_UPSTREAM_PARAMETER_REJECTED'),
    'AI_RESPONSES_PARAMETER_REJECTED',
  )
  for (const generic of [
    'AI_UPSTREAM_REQUEST_REJECTED', 'AI_REQUEST_INVALID', 'AI_REQUEST_TOO_LARGE',
  ]) {
    assert.equal(classifyPublicTaskErrorCode(generic), 'AI_RESPONSES_PROTOCOL_REJECTED')
  }
  for (const untrusted of [
    'AI_UPSTREAM_ENDPOINT_NOT_FOUND:https://provider.invalid/private',
    'AI_UPSTREAM_PARAMETER_REJECTED:Bearer secret-value',
    { errorCode: 'AI_UPSTREAM_ENDPOINT_NOT_FOUND', status: 404, body: 'private' },
  ]) {
    assert.equal(classifyPublicTaskErrorCode(untrusted), 'GENERATION_FAILED')
  }
})

test('allows every fixed task failure category through both probe allowlists', () => {
  const probeSource = fs.readFileSync(path.resolve(__dirname, 'ai-safe-release-probe.js'), 'utf8')
  const outerBlock = /const ALLOWED_CODES = new Set\(\[([\s\S]*?)\]\)/.exec(probeSource)
  const workerBlock = /const allowedTaskFailureCategories = new Set\(\[([\s\S]*?)\]\)/.exec(probeSource)
  assert.ok(outerBlock, 'outer probe code allowlist must remain statically reviewable')
  assert.ok(workerBlock, 'worker task category allowlist must remain statically reviewable')
  const tokens = (block) => new Set([...block.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((match) => match[1]))
  const outerCodes = tokens(outerBlock[1])
  const workerCodes = tokens(workerBlock[1])
  new Set(Object.values(PUBLIC_TASK_ERROR_CATEGORIES)).forEach((category) => {
    assert.equal(outerCodes.has(category), true, `outer probe allowlist is missing ${category}`)
    assert.equal(workerCodes.has(category), true, `worker task category allowlist is missing ${category}`)
  })
})

test('classifies every failure code currently projected by the server', () => {
  const serverIndex = fs.readFileSync(path.resolve(
    __dirname, '..', '..', 'cloudfunctions', 'aiPlanner', 'index.js',
  ), 'utf8')
  const recentFailureBlock = /const RECENT_FAILURE_CODES = new Set\(\[([\s\S]*?)\]\)/.exec(serverIndex)
  assert.ok(recentFailureBlock, 'server public failure allowlist must remain statically reviewable')
  const serverCodes = [...recentFailureBlock[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)]
    .map((match) => match[1])
  assert.ok(serverCodes.length > 0)
  serverCodes.forEach((code) => {
    assert.equal(Object.prototype.hasOwnProperty.call(PUBLIC_TASK_ERROR_CATEGORIES, code), true,
      `server public failure code ${code} requires an explicit safe release-probe category`)
  })
})

test('rejects a second process whenever V4 state already exists', () => {
  assert.deepEqual(acquireOwnership(null, OWNER_A), { ok: true, code: 'OK', ownerToken: OWNER_A })
  assert.deepEqual(acquireOwnership({ installed: true, ownerToken: OWNER_A }, OWNER_B), {
    ok: false, code: 'PROBE_ALREADY_INSTALLED',
  })
  assert.deepEqual(acquireOwnership({ installed: false }, OWNER_B), {
    ok: false, code: 'PROBE_ALREADY_INSTALLED',
  })
  assert.deepEqual(acquireOwnership(null, 'invalid'), {
    ok: false, code: 'INVALID_OWNER_TOKEN',
  })
})

test('cleanup lock is owner-bound and rejects contention', () => {
  const state = { ownerToken: OWNER_A, cleanupLocked: false, cleanupLockOwnerToken: '' }
  assert.deepEqual(acquireCleanupLock(state, OWNER_A), { ok: true, code: 'OK' })
  assert.equal(state.cleanupLocked, true)
  assert.equal(state.cleanupLockOwnerToken, OWNER_A)
  assert.deepEqual(acquireCleanupLock(state, OWNER_A), {
    ok: false, code: 'CLEANUP_ALREADY_RUNNING',
  })
  assert.deepEqual(acquireCleanupLock(state, OWNER_B), {
    ok: false, code: 'PROBE_OWNERSHIP_MISMATCH',
  })
  assert.equal(releaseCleanupLock(state, OWNER_B), false)
  assert.equal(state.cleanupLocked, true)
  assert.equal(releaseCleanupLock(state, OWNER_A), true)
  assert.equal(state.cleanupLocked, false)
  assert.equal(state.cleanupLockOwnerToken, '')
})

for (const durationDays of [1, 10, 14]) {
  test(`preserves root and exerciseByDay future fields for ${durationDays} days`, () => {
    const original = originalPreferences(durationDays)
    const requested = requestedPreferences(durationDays)
    const merged = mergeExpectedPreferences(original, requested)

    assert.deepEqual(merged.futureRoot, original.futureRoot)
    assert.equal(merged.startDate, requested.startDate)
    assert.deepEqual(merged.goals, requested.goals)
    assert.deepEqual(merged.exerciseByDay.map((day) => day.dayIndex),
      requested.exerciseByDay.map((day) => day.dayIndex))
    merged.exerciseByDay.forEach((day) => {
      assert.equal(day.futureExerciseField, `future-${day.dayIndex}`)
      assert.deepEqual(day.futureNested, { day: day.dayIndex })
      assert.equal(day.planned, false)
      assert.equal(day.intensity, 'medium')
    })
    assert.deepEqual(original, originalPreferences(durationDays), 'merge mutated original preferences')
    assert.deepEqual(requested, requestedPreferences(durationDays), 'merge mutated requested preferences')
  })
}

test('restoration requires the exact original full preference snapshot', () => {
  const original = originalPreferences(7)
  const probe = mergeExpectedPreferences(original, requestedPreferences(7))
  const context = cleanupContext(original, probe)
  const restored = {
    stateRevision: 13,
    generationPreferences: clone(original),
    draftPlan: null,
    invariantMatches: true,
  }
  assert.equal(classifyCleanupSnapshot(context, restored), 'restored')

  const missingFutureField = clone(restored)
  delete missingFutureField.generationPreferences.futureRoot
  assert.equal(classifyCleanupSnapshot(context, missingFutureField), 'conflict')

  const changedFutureDay = clone(restored)
  changedFutureDay.generationPreferences.exerciseByDay[0].futureExerciseField = 'changed'
  assert.equal(classifyCleanupSnapshot(context, changedFutureDay), 'conflict')
})

test('state invariants permit only the four probe-owned fields to differ', () => {
  const baseline = {
    stateRevision: 10,
    generationPreferences: { goals: ['original'] },
    draftPlan: null,
    updatedAt: 100,
    profile: { nickname: 'private' },
    weightRecords: [{ date: '2026-08-30', weightKg: 62.1 }],
    exerciseRecords: [{ durationMinutes: 30 }],
  }
  const allowed = clone(baseline)
  allowed.stateRevision = 11
  allowed.generationPreferences = { goals: ['probe'] }
  allowed.draftPlan = { id: 'draft-owned' }
  allowed.updatedAt = 200

  assert.deepEqual(stateInvariantSnapshot(baseline), {
    exerciseRecords: baseline.exerciseRecords,
    profile: baseline.profile,
    weightRecords: baseline.weightRecords,
  })
  assert.equal(stateInvariantMatches(baseline, allowed), true)

  const changedPrivateData = clone(allowed)
  changedPrivateData.weightRecords[0].weightKg = 61.8
  assert.equal(stateInvariantMatches(baseline, changedPrivateData), false)

  const addedPrivateData = clone(allowed)
  addedPrivateData.photoRecords = ['private-cloud-file-id']
  assert.equal(stateInvariantMatches(baseline, addedPrivateData), false)
})

test('successful save reconciliation accepts only an exact authoritative commit', () => {
  const original = originalPreferences(7)
  const probe = mergeExpectedPreferences(original, requestedPreferences(7))
  const context = cleanupContext(original, probe)

  assert.equal(classifyTestSaveSnapshot(context, testSaveSnapshot(context)), 'committed')
  assert.equal(classifyTestSaveSnapshot(context, testSaveSnapshot(context, {
    stateRevision: context.baseRevision,
    generationPreferences: clone(original),
  })), 'baseline')
  assert.equal(classifyTestSaveSnapshot(context, testSaveSnapshot(context, {
    stateRevision: undefined,
  })), 'conflict', 'a malformed success response must require authoritative reconciliation')

  for (const changed of [
    { stateRevision: context.baseRevision + 2 },
    { generationPreferences: clone(original) },
    { draftPlan: { id: 'unexpected-draft' } },
    { invariantMatches: false },
  ]) {
    assert.equal(classifyTestSaveSnapshot(context, testSaveSnapshot(context, changed)), 'conflict')
  }
})

test('classifies restore before-state and committed reentry without ambiguity', () => {
  const original = originalPreferences(14)
  const probe = mergeExpectedPreferences(original, requestedPreferences(14))
  const context = cleanupContext(original, probe)

  assert.equal(classifyCleanupSnapshot(context, {
    stateRevision: 12,
    generationPreferences: probe,
    draftPlan: null,
    invariantMatches: true,
  }), 'restore_before')
  assert.equal(nextCleanupPhase(context, {
    stateRevision: 12,
    generationPreferences: probe,
    draftPlan: null,
    invariantMatches: true,
  }), 'restore')

  const committed = {
    stateRevision: context.restoreRequest.expectedStateRevision + 1,
    generationPreferences: original,
    draftPlan: null,
    invariantMatches: true,
  }
  assert.equal(classifyCleanupSnapshot(context, committed), 'restored')
  assert.equal(nextCleanupPhase(context, committed), 'verify')
})

test('post-restore verification failure reenters verification without another write', () => {
  const original = originalPreferences(7)
  const probe = mergeExpectedPreferences(original, requestedPreferences(7))
  const context = cleanupContext(original, probe)
  const committed = {
    stateRevision: context.restoreRequest.expectedStateRevision + 1,
    generationPreferences: original,
    draftPlan: null,
    invariantMatches: true,
  }
  let restoreWrites = 0
  const enterCleanup = () => {
    const phase = nextCleanupPhase(context, committed)
    if (phase === 'restore') restoreWrites += 1
    return phase
  }

  assert.equal(enterCleanup(), 'verify')
  // Simulate the final verification read failing after the restore was committed.
  assert.equal(enterCleanup(), 'verify')
  assert.equal(restoreWrites, 0)
})

test('cleanup snapshots fail closed when invariants are absent or changed', () => {
  const original = originalPreferences(7)
  const probe = mergeExpectedPreferences(original, requestedPreferences(7))
  const context = cleanupContext(original, probe)
  const snapshot = {
    stateRevision: 13,
    generationPreferences: original,
    draftPlan: null,
  }
  assert.equal(classifyCleanupSnapshot(context, snapshot), 'conflict')
  snapshot.invariantMatches = false
  assert.equal(classifyCleanupSnapshot(context, snapshot), 'conflict')
})

test('installation response loss is recoverable by a new dead-owner process', () => {
  withTempJournal((journalPath) => {
    const first = claimRecoveryJournal(journalOptions(journalPath))
    assert.equal(first.ok, true)
    assert.equal(first.mode, 'fresh')
    assert.equal(selectRecoveryAction(first.mode, 'absent'), 'install')

    // Simulate install taking effect in the simulator while its host response is lost.
    const second = claimRecoveryJournal(journalOptions(journalPath, {
      pid: 41002,
      processInstanceId: '2'.repeat(32),
      now: () => 2000,
      isPidAlive: (pid) => pid !== 41001,
    }))
    assert.equal(second.ok, true)
    assert.equal(second.mode, 'resume')
    assert.equal(second.ownerToken, first.ownerToken)
    assert.equal(selectRecoveryAction(second.mode, 'owned'), 'cleanup')
  })
})

test('cleanup failure followed by process exit resumes with the same owner token', () => {
  withTempJournal((journalPath) => {
    const first = claimRecoveryJournal(journalOptions(journalPath))
    const resumed = claimRecoveryJournal(journalOptions(journalPath, {
      pid: 41003,
      processInstanceId: '3'.repeat(32),
      now: () => 3000,
      isPidAlive: () => false,
    }))
    assert.equal(resumed.ok, true)
    assert.equal(resumed.mode, 'resume')
    assert.equal(resumed.ownerToken, first.ownerToken)
    assert.equal(resumed.record.recoveryAttempt, 1)
    assert.equal(selectRecoveryAction(resumed.mode, 'owned'), 'cleanup')
  })
})

test('a live old process prevents journal takeover', () => {
  withTempJournal((journalPath) => {
    const first = claimRecoveryJournal(journalOptions(journalPath))
    assert.equal(first.ok, true)
    const blocked = claimRecoveryJournal(journalOptions(journalPath, {
      pid: 41004,
      processInstanceId: '4'.repeat(32),
      now: () => 4000,
      isPidAlive: (pid) => pid === 41001,
    }))
    assert.deepEqual(blocked, { ok: false, code: 'PROBE_PROCESS_ACTIVE' })
    const persisted = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    assert.equal(persisted.ownerPid, 41001)
    assert.equal(persisted.ownerInstanceId, '1'.repeat(32))
  })
})

test('SQLite transaction lock rejects a second process while the first operation is active', () => {
  withTempJournal((journalPath) => {
    let contender
    const first = claimRecoveryJournal(journalOptions(journalPath, {
      afterLockOpen: () => {
        const script = [
          "'use strict'",
          'const core = require(process.argv[1])',
          'const result = core.claimRecoveryJournal({',
          '  journalPath: process.argv[2],',
          '  durationDays: 7,',
          '  pid: process.pid,',
          "  processInstanceId: '2'.repeat(32),",
          '  isPidAlive: () => false,',
          "  randomHex: (bytes) => bytes === 24 ? 'f'.repeat(48) : '9'.repeat(32),",
          '  now: () => 1000,',
          '})',
          'process.stdout.write(JSON.stringify(result))',
        ].join('\n')
        const child = childProcess.spawnSync(process.execPath, [
          '-e', script, require.resolve('./ai-safe-release-core'), journalPath,
        ], {
          encoding: 'utf8',
          env: {},
          windowsHide: true,
        })
        assert.equal(child.status, 0, child.stderr)
        contender = JSON.parse(child.stdout)
      },
    }))

    assert.deepEqual(contender, { ok: false, code: 'JOURNAL_LOCKED' })
    assert.equal(first.ok, true)
    assert.equal(first.mode, 'fresh')
    const persisted = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    assert.equal(persisted.ownerPid, 41001)
    assert.equal(persisted.ownerInstanceId, '1'.repeat(32))
    assert.equal(persisted.ownerToken, first.ownerToken)
  })
})

test('a killed lock holder is recovered by SQLite and the next process can claim', () => {
  withTempJournal((journalPath) => {
    const holderScript = [
      "'use strict'",
      "const { DatabaseSync } = require('node:sqlite')",
      'const db = new DatabaseSync(`${process.argv[1]}.lock.sqlite`, { timeout: 0 })',
      "db.exec('BEGIN IMMEDIATE')",
      "process.kill(process.pid, 'SIGKILL')",
    ].join('\n')
    const holder = childProcess.spawnSync(process.execPath, ['-e', holderScript, journalPath], {
      encoding: 'utf8', windowsHide: true,
    })
    assert.notEqual(holder.status, 0)
    const claimed = claimRecoveryJournal(journalOptions(journalPath))
    assert.equal(claimed.ok, true)
  })
})

test('operation failure rolls back and releases the SQLite transaction lock', () => {
  withTempJournal((journalPath) => {
    const failed = claimRecoveryJournal(journalOptions(journalPath, {
      randomHex: () => { throw failure('INJECTED') },
    }))
    assert.deepEqual(failed, { ok: false, code: 'JOURNAL_INVALID' })
    const claimed = claimRecoveryJournal(journalOptions(journalPath))
    assert.equal(claimed.ok, true)
  })
})

for (const releaseFailure of ['commit', 'close']) {
  test(`${releaseFailure} failure cannot report a successful journal operation`, () => {
    withTempJournal((journalPath) => {
      const { DatabaseSync } = require('node:sqlite')
      class FaultDatabase {
        constructor(filename, options) { this.inner = new DatabaseSync(filename, options) }
        exec(sql) {
          if (releaseFailure === 'commit' && sql === 'COMMIT') throw failure('EBUSY')
          return this.inner.exec(sql)
        }
        close() {
          if (releaseFailure === 'close') {
            this.inner.close()
            throw failure('EPERM')
          }
          return this.inner.close()
        }
      }
      const failed = claimRecoveryJournal(journalOptions(journalPath, { Database: FaultDatabase }))
      assert.deepEqual(failed, { ok: false, code: 'JOURNAL_LOCK_RELEASE_FAILED' })
    })
  })
}

test('a corrupt SQLite lock database fails closed', () => {
  withTempJournal((journalPath) => {
    fs.writeFileSync(`${journalPath}.lock.sqlite`, 'not a sqlite database', 'utf8')
    const rejected = claimRecoveryJournal(journalOptions(journalPath))
    assert.deepEqual(rejected, { ok: false, code: 'JOURNAL_LOCKED' })
  })
})

test('indeterminate or throwing journal owner liveness never permits journal takeover', () => {
  for (const mode of ['undefined', 'throw']) {
    withTempJournal((journalPath) => {
      const first = claimRecoveryJournal(journalOptions(journalPath))
      assert.equal(first.ok, true)
      const blocked = claimRecoveryJournal(journalOptions(journalPath, {
        pid: 44004,
        processInstanceId: 'a'.repeat(32),
        now: () => 2000,
        isPidAlive: () => {
          if (mode === 'throw') throw failure('EPERM')
          return undefined
        },
      }))
      assert.deepEqual(blocked, { ok: false, code: 'PROBE_PROCESS_ACTIVE' })
    })
  }
})

test('successful verified uninstall deletes the recovery journal', () => {
  withTempJournal((journalPath) => {
    const claim = claimRecoveryJournal(journalOptions(journalPath))
    assert.equal(fs.existsSync(journalPath), true)
    const cleared = clearRecoveryJournal(journalOptions(journalPath, {
      ownerToken: claim.ownerToken,
    }))
    assert.deepEqual(cleared, { ok: true, code: 'OK' })
    assert.equal(fs.existsSync(journalPath), false)
  })
})

test('stale journal with no simulator state fails closed and keeps recovery metadata', () => {
  withTempJournal((journalPath) => {
    claimRecoveryJournal(journalOptions(journalPath))
    const resumed = claimRecoveryJournal(journalOptions(journalPath, {
      pid: 41005,
      processInstanceId: '5'.repeat(32),
      now: () => 5000,
      isPidAlive: () => false,
    }))
    assert.equal(resumed.ok, true)
    assert.equal(resumed.mode, 'resume')
    assert.equal(selectRecoveryAction(resumed.mode, 'absent'), 'state-lost')
    assert.equal(selectRecoveryAction(resumed.mode, 'foreign'), 'reject')
    assert.equal(fs.existsSync(journalPath), true)
    const persisted = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    assert.equal(persisted.ownerToken, resumed.ownerToken)
    assert.equal(persisted.ownerPid, 41005)
    assert.equal(persisted.ownerInstanceId, '5'.repeat(32))
  })
})

test('journal contains only process recovery metadata', () => {
  withTempJournal((journalPath) => {
    claimRecoveryJournal(journalOptions(journalPath))
    const persisted = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    assert.deepEqual(Object.keys(persisted).sort(), [
      'createdAtMs', 'durationDays', 'ownerInstanceId', 'ownerPid', 'ownerToken',
      'recoveryAttempt', 'schemaVersion', 'updatedAtMs',
    ])
    const serialized = JSON.stringify(persisted)
    assert.doesNotMatch(serialized, /(preference|task|draft|openid|unionid|secret|api.?key)/i)
  })
})

test('journal validation rejects any extra field', () => {
  withTempJournal((journalPath) => {
    claimRecoveryJournal(journalOptions(journalPath))
    const persisted = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    persisted.taskId = 'must-not-be-kept'
    fs.writeFileSync(journalPath, `${JSON.stringify(persisted)}\n`, 'utf8')
    const rejected = claimRecoveryJournal(journalOptions(journalPath, {
      pid: 41006,
      processInstanceId: '6'.repeat(32),
      now: () => 6000,
      isPidAlive: () => false,
    }))
    assert.deepEqual(rejected, { ok: false, code: 'JOURNAL_INVALID' })
  })
})

let failed = 0
tests.forEach(({ name, fn }) => {
  try {
    fn()
    process.stdout.write(`ok - ${name}\n`)
  } catch (error) {
    failed += 1
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`)
  }
})

if (failed > 0) {
  process.stderr.write(`${failed} test(s) failed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${tests.length} test(s) passed\n`)
}
