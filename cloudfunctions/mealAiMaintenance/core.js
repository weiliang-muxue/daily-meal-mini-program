'use strict'

const RETENTION_SCHEMA_VERSION = 1
const ACTIVE_STATUS_ALIASES = Object.freeze({
  queued: 'queued',
  running: 'running',
  finalizing: 'finalizing',
  pending: 'queued',
  processing: 'running',
  generating: 'running',
  validating: 'finalizing',
  active: 'running',
})
const QUERY_STATUSES = Object.freeze(Object.keys(ACTIVE_STATUS_ALIASES))
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const CACHE_NAMESPACE_PATTERN = /^[a-f0-9]{32}$/
const AI_DATA_CONSENT_VERSION = 2
const AI_CONTRACT_VERSION = 2
const AI_PLANNER_VERSION = '7'
const AI_PROVIDER_CONTRACT_REVISION = 9
const TASK_SCHEMA_VERSION = 3

function maintenanceError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function safeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function validCacheNamespace(value) {
  return typeof value === 'string' && CACHE_NAMESPACE_PATTERN.test(value)
}

function activeStatus(status) {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : ''
  return ACTIVE_STATUS_ALIASES[value] || ''
}

function isExpiredActiveTask(task, now) {
  return Boolean(
    task &&
    activeStatus(task.status) &&
    Number.isSafeInteger(task.expiresAt) &&
    task.expiresAt > 0 &&
    task.expiresAt <= now
  )
}

function taskVersionState(task) {
  const contractVersion = task && task.contractVersion
  const plannerNumber = typeof (task && task.plannerVersion) === 'string'
    && /^\d+$/.test(task.plannerVersion) ? Number(task.plannerVersion) : Number.NaN
  if (!Number.isSafeInteger(contractVersion) || contractVersion < 1
    || !Number.isSafeInteger(plannerNumber) || plannerNumber < 1) return 'invalid'
  if (contractVersion > AI_CONTRACT_VERSION || plannerNumber > Number(AI_PLANNER_VERSION)) return 'future'
  if (contractVersion === AI_CONTRACT_VERSION && plannerNumber === Number(AI_PLANNER_VERSION)) return 'current'
  return 'legacy'
}

function taskSchemaVersionState(task) {
  const version = task && task.taskSchemaVersion
  if (!Number.isSafeInteger(version) || version < 1) return 'invalid'
  if (version > TASK_SCHEMA_VERSION) return 'future'
  return version === TASK_SCHEMA_VERSION ? 'current' : 'legacy'
}

function taskVersionsSupported(task) {
  return !['future', 'invalid'].includes(taskSchemaVersionState(task))
    && !['future', 'invalid'].includes(taskVersionState(task))
}

function providerIdentityPresent(task) {
  return Boolean(task && Number.isSafeInteger(task.providerRevision) && task.providerRevision > 0
    && typeof task.providerConfigVersion === 'string' && /^[a-f0-9]{64}$/.test(task.providerConfigVersion))
}

function progressCounts(task) {
  if (Number.isSafeInteger(task.totalSteps) && task.totalSteps >= 0 &&
      Number.isSafeInteger(task.completedSteps) && task.completedSteps >= 0) {
    return {
      totalSteps: task.totalSteps,
      completedSteps: Math.min(task.completedSteps, task.totalSteps),
    }
  }
  const chunks = Array.isArray(task.chunks) ? task.chunks : []
  const totalSteps = chunks.length + 2
  const completedSteps = (task.outline && task.outline.status === 'completed' ? 1 : 0) +
    chunks.filter((chunk) => chunk && chunk.status === 'completed').length +
    (task.finalize && task.finalize.status === 'completed' ? 1 : 0)
  return { totalSteps, completedSteps }
}

function copyDefined(target, source, fields) {
  fields.forEach((field) => {
    if (source[field] !== undefined) target[field] = source[field]
  })
  return target
}

function compactExpiredTask(rawTask, taskId, now) {
  if (!isExpiredActiveTask(rawTask, now)) return null
  const versionState = taskVersionState(rawTask)
  if (!taskVersionsSupported(rawTask)) return null
  if (typeof taskId !== 'string' || !taskId || typeof rawTask.owner !== 'string' || !rawTask.owner) {
    throw maintenanceError('INVALID_TASK_IDENTITY', 'AI task identity is invalid')
  }

  const progress = progressCounts(rawTask)
  const baselineVerified = typeof rawTask.planStateFingerprint === 'string'
    && HASH_PATTERN.test(rawTask.planStateFingerprint)
  const consentVerified = rawTask.aiDataConsentVersion === AI_DATA_CONSENT_VERSION
  const plannerVerified = versionState === 'current'
  const providerVerified = providerIdentityPresent(rawTask)
  const status = !consentVerified || !providerVerified || !plannerVerified ? 'failed' : baselineVerified ? 'expired' : 'conflict'
  const failureCode = !consentVerified || !providerVerified ? 'AI_DATA_CONSENT_REQUIRED'
    : !plannerVerified ? 'AI_PLANNER_VERSION_UNSUPPORTED'
      : baselineVerified ? 'AI_TASK_EXPIRED' : 'STATE_REVISION_CONFLICT'
  const compacted = {
    taskSchemaVersion: rawTask.taskSchemaVersion,
    owner: rawTask.owner,
    status,
    phase: 'terminal',
    taskRevision: safeInteger(rawTask.taskRevision) + 1,
    totalSteps: progress.totalSteps,
    completedSteps: progress.completedSteps,
    updatedAt: now,
    updatedAtMs: now,
    expiresAt: rawTask.expiresAt,
    terminalAtMs: now,
    expiredAtMs: status === 'expired' ? now : 0,
    completedAtMs: 0,
    failedAtMs: status === 'failed' ? now : 0,
    cancelledAtMs: 0,
    conflictedAtMs: status === 'conflict' ? now : 0,
    errorCode: failureCode,
    failureCode,
    retentionSchemaVersion: RETENTION_SCHEMA_VERSION,
    compactedAtMs: now,
    shardCleanupPending: true,
    shardCleanupUpdatedAtMs: rawTask.expiresAt,
  }
  copyDefined(compacted, rawTask, [
    'cacheNamespace', 'generationEpoch', 'idempotencyHash', 'requestFingerprint', 'preferencesHash',
    'contractVersion', 'plannerVersion', 'aiDataConsentVersion', 'providerRevision', 'providerConfigVersion',
    'planId', 'baseStateRevision', 'stateRevision',
    'resultStateRevision', 'createdAt', 'createdAtMs',
  ])
  if (baselineVerified) compacted.planStateFingerprint = rawTask.planStateFingerprint
  return {
    taskId, owner: rawTask.owner, cacheNamespace: rawTask.cacheNamespace,
    generationEpoch: rawTask.generationEpoch, data: compacted,
  }
}

function controlMatchesTask(control, compacted) {
  return Boolean(
    control && compacted &&
    control.owner === compacted.owner &&
    control.activeTaskId === compacted.taskId &&
    validCacheNamespace(control.cacheNamespace) &&
    control.cacheNamespace === compacted.cacheNamespace &&
    Number.isSafeInteger(control.generationEpoch) &&
    Number.isSafeInteger(compacted.generationEpoch) &&
    control.generationEpoch === compacted.generationEpoch
  )
}

function safeErrorCode(error, fallback = 'MAINTENANCE_FAILED') {
  const code = error && typeof error.code === 'string' ? error.code : ''
  return ERROR_CODE_PATTERN.test(code) ? code : fallback
}

module.exports = {
  RETENTION_SCHEMA_VERSION,
  AI_DATA_CONSENT_VERSION,
  AI_CONTRACT_VERSION,
  AI_PLANNER_VERSION,
  AI_PROVIDER_CONTRACT_REVISION,
  TASK_SCHEMA_VERSION,
  ACTIVE_STATUS_ALIASES,
  QUERY_STATUSES,
  activeStatus,
  isExpiredActiveTask,
  progressCounts,
  validCacheNamespace,
  taskSchemaVersionState,
  taskVersionState,
  taskVersionsSupported,
  providerIdentityPresent,
  compactExpiredTask,
  controlMatchesTask,
  safeErrorCode,
}
