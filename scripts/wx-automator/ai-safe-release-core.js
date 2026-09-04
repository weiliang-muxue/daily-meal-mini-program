'use strict'

const crypto = require('crypto')
const fs = require('fs')
const { DatabaseSync } = require('node:sqlite')

const BLOCKED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ALLOWED_STATE_CHANGES = new Set([
  'stateRevision', 'generationPreferences', 'draftPlan', 'updatedAt',
])
const RECOVERY_JOURNAL_KEYS = [
  'createdAtMs', 'durationDays', 'ownerInstanceId', 'ownerPid', 'ownerToken',
  'recoveryAttempt', 'schemaVersion', 'updatedAtMs',
]
const RELEASE_COMPATIBILITY = Object.freeze({
  contractVersion: 2,
  plannerVersion: '7',
  aiDataConsentVersion: 2,
  providerContractRevision: 9,
  taskSchemaVersion: 3,
})
const PUBLIC_TASK_ERROR_CATEGORIES = Object.freeze({
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

function classifyPublicTaskErrorCode(value) {
  if (typeof value !== 'string'
    || !Object.prototype.hasOwnProperty.call(PUBLIC_TASK_ERROR_CATEGORIES, value)) {
    return 'GENERATION_FAILED'
  }
  return PUBLIC_TASK_ERROR_CATEGORIES[value]
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function same(left, right) { return canonical(left) === canonical(right) }

function trustedArrayKey(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  if (typeof value.id === 'string' && value.id) return `id:${value.id}`
  if (Number.isSafeInteger(value.dayIndex)) return `day:${value.dayIndex}`
  return ''
}

function mergeTrustedUnknown(sanitized, trusted, depth = 0) {
  if (depth > 40) throw new Error('merge depth exceeded')
  if (Array.isArray(sanitized)) {
    if (!Array.isArray(trusted)) return clone(sanitized)
    const trustedByKey = new Map()
    trusted.forEach((item) => {
      const key = trustedArrayKey(item)
      if (key && !trustedByKey.has(key)) trustedByKey.set(key, item)
    })
    return sanitized.map((item, index) => {
      const key = trustedArrayKey(item)
      const source = key ? trustedByKey.get(key) : trusted[index]
      return mergeTrustedUnknown(item, source, depth + 1)
    })
  }
  if (!sanitized || typeof sanitized !== 'object'
    || !trusted || typeof trusted !== 'object' || Array.isArray(trusted)) return clone(sanitized)
  if (typeof sanitized.id === 'string' && sanitized.id
    && typeof trusted.id === 'string' && trusted.id && sanitized.id !== trusted.id) return clone(sanitized)
  if (Number.isSafeInteger(sanitized.dayIndex) && Number.isSafeInteger(trusted.dayIndex)
    && sanitized.dayIndex !== trusted.dayIndex) return clone(sanitized)
  const result = {}
  Object.keys(sanitized).forEach((key) => {
    if (!BLOCKED_OBJECT_KEYS.has(key)) result[key] = mergeTrustedUnknown(sanitized[key], trusted[key], depth + 1)
  })
  Object.keys(trusted).forEach((key) => {
    if (!BLOCKED_OBJECT_KEYS.has(key) && !Object.prototype.hasOwnProperty.call(result, key)) {
      result[key] = clone(trusted[key])
    }
  })
  return result
}

function mergeExpectedPreferences(originalPreferences, requestedPreferences) {
  return mergeTrustedUnknown(requestedPreferences, originalPreferences)
}

function stateInvariantSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const result = {}
  Object.keys(source).sort().forEach((key) => {
    if (!ALLOWED_STATE_CHANGES.has(key) && !BLOCKED_OBJECT_KEYS.has(key)) result[key] = clone(source[key])
  })
  return result
}

function stateInvariantMatches(baseline, candidate) {
  return same(stateInvariantSnapshot(baseline), stateInvariantSnapshot(candidate))
}

function validRevision(value) { return Number.isSafeInteger(value) && value >= 0 }

function classifyTestSaveSnapshot(context, snapshot) {
  const state = context && typeof context === 'object' ? context : {}
  const latest = snapshot && typeof snapshot === 'object' ? snapshot : {}
  if (!validRevision(state.baseRevision) || !validRevision(latest.stateRevision)
    || latest.invariantMatches !== true) return 'conflict'
  const noDraft = latest.draftPlan === null || latest.draftPlan === undefined
  if (!noDraft) return 'conflict'
  if (latest.stateRevision === state.baseRevision + 1
    && same(latest.generationPreferences, state.testPreferences)) return 'committed'
  if (latest.stateRevision === state.baseRevision
    && same(latest.generationPreferences, state.originalPreferences)) return 'baseline'
  return 'conflict'
}

function classifyCleanupSnapshot(context, snapshot) {
  const state = context && typeof context === 'object' ? context : {}
  const latest = snapshot && typeof snapshot === 'object' ? snapshot : {}
  if (!validRevision(latest.stateRevision) || latest.invariantMatches !== true) return 'conflict'
  const noDraft = latest.draftPlan === null || latest.draftPlan === undefined
  const original = same(latest.generationPreferences, state.originalPreferences)
  const test = same(latest.generationPreferences, state.testPreferences)

  if (state.restoreRequest) {
    const before = state.restoreRequest.expectedStateRevision
    if (!validRevision(before) || !noDraft) return 'conflict'
    if (latest.stateRevision === before + 1 && original) return 'restored'
    if (latest.stateRevision === before && test) return 'restore_before'
    return 'conflict'
  }

  if (state.discardRequest) {
    const before = state.discardRequest.expectedStateRevision
    const expectedDraftId = state.discardRequest.expectedDraftPlanId
    if (!validRevision(before)) return 'conflict'
    if (latest.stateRevision === before + 1 && noDraft && test) return 'discarded'
    if (latest.stateRevision === before && latest.draftPlan
      && latest.draftPlan.id === expectedDraftId && test) return 'discard_before'
    return 'conflict'
  }

  if (latest.draftPlan) {
    if (latest.draftPlan.id === state.draftPlanId && test) return 'draft'
    return 'conflict'
  }
  if (!state.testSaveCommitted && latest.stateRevision === state.baseRevision && original) return 'baseline'
  if (state.testSaveCommitted && latest.stateRevision === state.expectedRevision && test) return 'test_saved'
  return 'conflict'
}

function acquireOwnership(existingState, ownerToken) {
  if (typeof ownerToken !== 'string' || !/^[a-f0-9]{48}$/.test(ownerToken)) {
    return { ok: false, code: 'INVALID_OWNER_TOKEN' }
  }
  if (existingState) {
    return { ok: false, code: 'PROBE_ALREADY_INSTALLED' }
  }
  return { ok: true, code: 'OK', ownerToken }
}

function acquireCleanupLock(state, ownerToken) {
  if (!state || state.ownerToken !== ownerToken) return { ok: false, code: 'PROBE_OWNERSHIP_MISMATCH' }
  if (state.cleanupLocked) return { ok: false, code: 'CLEANUP_ALREADY_RUNNING' }
  state.cleanupLocked = true
  state.cleanupLockOwnerToken = ownerToken
  return { ok: true, code: 'OK' }
}

function releaseCleanupLock(state, ownerToken) {
  if (!state || state.ownerToken !== ownerToken || !state.cleanupLocked
    || state.cleanupLockOwnerToken !== ownerToken) return false
  state.cleanupLocked = false
  state.cleanupLockOwnerToken = ''
  return true
}

function nextCleanupPhase(state, snapshot) {
  const classification = classifyCleanupSnapshot(state, snapshot)
  if (classification === 'restored' || classification === 'baseline') return 'verify'
  if (classification === 'restore_before' || classification === 'discarded'
    || classification === 'test_saved') return 'restore'
  if (classification === 'discard_before' || classification === 'draft') return 'discard'
  return 'conflict'
}

function parseProbeArguments(argv) {
  const values = Array.isArray(argv) ? argv : []
  if (values.length !== 2 || !/^(?:[1-9]|1[0-4])$/.test(values[0])
    || values[1] !== '--exclusive-session-ack') {
    return { ok: false, code: 'INVALID_ARGUMENTS', duration: 0, exclusiveSessionAck: false }
  }
  return {
    ok: true,
    code: 'OK',
    duration: Number(values[0]),
    exclusiveSessionAck: true,
  }
}

function releaseServiceCompatible(value) {
  return Boolean(value && value.configured === true && value.storageReady === true
    && value.contractVersion === RELEASE_COMPATIBILITY.contractVersion
    && value.plannerVersion === RELEASE_COMPATIBILITY.plannerVersion
    && value.aiDataConsentVersion === RELEASE_COMPATIBILITY.aiDataConsentVersion
    && value.providerContractRevision === RELEASE_COMPATIBILITY.providerContractRevision
    && Number.isSafeInteger(value.providerRevision) && value.providerRevision > 0)
}

function buildReleaseStartRequest(
  preferences, expectedStateRevision, clientRequestId, expectedCacheNamespace, providerRevision,
) {
  if (!preferences || preferences.contractVersion !== RELEASE_COMPATIBILITY.contractVersion
    || !Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 0
    || typeof clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(clientRequestId)
    || typeof expectedCacheNamespace !== 'string' || !/^[a-f0-9]{32}$/.test(expectedCacheNamespace)
    || !Number.isSafeInteger(providerRevision) || providerRevision < 1) {
    throw new Error('INVALID_RELEASE_START_REQUEST')
  }
  return {
    action: 'start',
    preferences: clone(preferences),
    expectedStateRevision,
    clientRequestId,
    aiDataConsent: {
      accepted: true,
      version: RELEASE_COMPATIBILITY.aiDataConsentVersion,
      providerRevision,
    },
    expectedCacheNamespace,
  }
}

class JournalError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function validOwnerToken(value) { return typeof value === 'string' && /^[a-f0-9]{48}$/.test(value) }
function validInstanceId(value) { return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) }
function validPid(value) { return Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff }
function validTimestamp(value) { return Number.isSafeInteger(value) && value > 0 }

function validRecoveryJournal(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && same(Object.keys(value).sort(), RECOVERY_JOURNAL_KEYS)
    && value.schemaVersion === 1
    && validOwnerToken(value.ownerToken)
    && validPid(value.ownerPid)
    && validInstanceId(value.ownerInstanceId)
    && Number.isSafeInteger(value.durationDays)
    && value.durationDays >= 1 && value.durationDays <= 14
    && validTimestamp(value.createdAtMs)
    && validTimestamp(value.updatedAtMs)
    && value.updatedAtMs >= value.createdAtMs
    && Number.isSafeInteger(value.recoveryAttempt) && value.recoveryAttempt >= 0)
}

function readSmallJson(filePath, maxBytes = 4096) {
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) {
      throw new JournalError('JOURNAL_INVALID')
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    if (error instanceof JournalError) throw error
    throw new JournalError('JOURNAL_INVALID')
  }
}

function bestEffortPrivateMode(filePath) {
  try { fs.chmodSync(filePath, 0o600) } catch (_) {}
}

function atomicWriteJson(filePath, value, randomHex) {
  const suffix = randomHex(16)
  if (!validInstanceId(suffix)) throw new JournalError('JOURNAL_INVALID')
  const tempPath = `${filePath}.${process.pid}.${suffix}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    bestEffortPrivateMode(tempPath)
    fs.renameSync(tempPath, filePath)
    bestEffortPrivateMode(filePath)
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch (_) {}
    }
    try { fs.unlinkSync(tempPath) } catch (_) {}
    if (error instanceof JournalError) throw error
    throw new JournalError('JOURNAL_WRITE_FAILED')
  }
}

function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && error.code === 'ESRCH') return false
    return undefined
  }
}

function withJournalLock(options, operation) {
  const lockPath = `${options.journalPath}.lock.sqlite`
  let database
  let transactionOpen = false
  let result
  let operationError = null
  let releaseError = null
  try {
    const Database = options.Database || DatabaseSync
    database = new Database(lockPath, { timeout: 0 })
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    transactionOpen = true
    if (options.afterLockOpen) options.afterLockOpen()
    result = operation()
  } catch (error) {
    if (!transactionOpen && error && error.code === 'ERR_SQLITE_ERROR') {
      if (database) {
        try { database.close() } catch (_) {}
        database = null
      }
      throw new JournalError('JOURNAL_LOCKED')
    }
    operationError = error
  }
  if (database && transactionOpen) {
    try {
      database.exec(operationError ? 'ROLLBACK' : 'COMMIT')
      transactionOpen = false
    } catch (_) {
      if (operationError) {
        try { database.exec('ROLLBACK'); transactionOpen = false } catch (_) {}
      }
      releaseError = new JournalError('JOURNAL_LOCK_RELEASE_FAILED')
    }
  }
  if (database) {
    try { database.close() } catch (_) {
      releaseError = new JournalError('JOURNAL_LOCK_RELEASE_FAILED')
    }
  }
  if (releaseError) throw releaseError
  if (operationError) throw operationError
  return result
}

function selectRecoveryAction(claimMode, probeState) {
  if (!['fresh', 'resume'].includes(claimMode)
    || !['absent', 'owned', 'foreign'].includes(probeState)) return 'reject'
  if (probeState === 'foreign') return 'reject'
  if (claimMode === 'resume' && probeState === 'owned') return 'cleanup'
  if (claimMode === 'resume' && probeState === 'absent') return 'state-lost'
  if (claimMode === 'fresh' && probeState === 'absent') return 'install'
  return 'reject'
}

function recoveryOptions(options) {
  const source = options && typeof options === 'object' ? options : {}
  const journalPath = source.journalPath
  const pid = source.pid === undefined ? process.pid : source.pid
  const processInstanceId = source.processInstanceId
  const isPidAlive = typeof source.isPidAlive === 'function' ? source.isPidAlive : defaultPidAlive
  const randomHex = typeof source.randomHex === 'function'
    ? source.randomHex : (bytes) => crypto.randomBytes(bytes).toString('hex')
  const now = typeof source.now === 'function' ? source.now : Date.now
  const afterLockOpen = typeof source.afterLockOpen === 'function' ? source.afterLockOpen : null
  const Database = typeof source.Database === 'function' ? source.Database : null
  if (typeof journalPath !== 'string' || !journalPath || !validPid(pid)
    || !validInstanceId(processInstanceId)) throw new JournalError('JOURNAL_INVALID')
  return { journalPath, pid, processInstanceId, isPidAlive, randomHex, now, afterLockOpen, Database }
}

function claimRecoveryJournal(options) {
  try {
    const settings = recoveryOptions(options)
    const durationDays = options && options.durationDays
    if (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 14) {
      throw new JournalError('JOURNAL_INVALID')
    }
    return withJournalLock(settings, () => {
      const existing = readSmallJson(settings.journalPath)
      const timestamp = settings.now()
      if (!validTimestamp(timestamp)) throw new JournalError('JOURNAL_INVALID')
      if (!existing) {
        const ownerToken = settings.randomHex(24)
        if (!validOwnerToken(ownerToken)) throw new JournalError('JOURNAL_INVALID')
        const record = {
          schemaVersion: 1,
          ownerToken,
          ownerPid: settings.pid,
          ownerInstanceId: settings.processInstanceId,
          durationDays,
          createdAtMs: timestamp,
          updatedAtMs: timestamp,
          recoveryAttempt: 0,
        }
        atomicWriteJson(settings.journalPath, record, settings.randomHex)
        return { ok: true, code: 'OK', mode: 'fresh', ownerToken, record }
      }
      if (!validRecoveryJournal(existing)) throw new JournalError('JOURNAL_INVALID')
      if (existing.durationDays !== durationDays) throw new JournalError('JOURNAL_DURATION_MISMATCH')
      let journalOwnerAlive
      try { journalOwnerAlive = settings.isPidAlive(existing.ownerPid) } catch (_) {
        throw new JournalError('PROBE_PROCESS_ACTIVE')
      }
      if (journalOwnerAlive !== false) throw new JournalError('PROBE_PROCESS_ACTIVE')
      const record = {
        ...existing,
        ownerPid: settings.pid,
        ownerInstanceId: settings.processInstanceId,
        updatedAtMs: timestamp,
        recoveryAttempt: existing.recoveryAttempt + 1,
      }
      atomicWriteJson(settings.journalPath, record, settings.randomHex)
      return { ok: true, code: 'OK', mode: 'resume', ownerToken: record.ownerToken, record }
    })
  } catch (error) {
    return { ok: false, code: error instanceof JournalError ? error.code : 'JOURNAL_INVALID' }
  }
}

function clearRecoveryJournal(options) {
  try {
    const settings = recoveryOptions(options)
    const ownerToken = options && options.ownerToken
    if (!validOwnerToken(ownerToken)) throw new JournalError('JOURNAL_INVALID')
    return withJournalLock(settings, () => {
      const existing = readSmallJson(settings.journalPath)
      if (!validRecoveryJournal(existing)) throw new JournalError('JOURNAL_INVALID')
      if (existing.ownerToken !== ownerToken || existing.ownerPid !== settings.pid
        || existing.ownerInstanceId !== settings.processInstanceId) {
        throw new JournalError('JOURNAL_OWNERSHIP_MISMATCH')
      }
      try { fs.unlinkSync(settings.journalPath) } catch (error) {
        if (!error || error.code !== 'ENOENT') throw new JournalError('JOURNAL_WRITE_FAILED')
      }
      if (fs.existsSync(settings.journalPath)) throw new JournalError('JOURNAL_WRITE_FAILED')
      return { ok: true, code: 'OK' }
    })
  } catch (error) {
    return { ok: false, code: error instanceof JournalError ? error.code : 'JOURNAL_INVALID' }
  }
}

module.exports = {
  PUBLIC_TASK_ERROR_CATEGORIES,
  RELEASE_COMPATIBILITY,
  acquireCleanupLock,
  acquireOwnership,
  canonical,
  claimRecoveryJournal,
  classifyPublicTaskErrorCode,
  clearRecoveryJournal,
  classifyCleanupSnapshot,
  classifyTestSaveSnapshot,
  clone,
  buildReleaseStartRequest,
  mergeExpectedPreferences,
  mergeTrustedUnknown,
  nextCleanupPhase,
  parseProbeArguments,
  releaseCleanupLock,
  releaseServiceCompatible,
  same,
  selectRecoveryAction,
  stateInvariantMatches,
  stateInvariantSnapshot,
  validRecoveryJournal,
}
