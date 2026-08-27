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

function maintenanceError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function safeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
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
  if (typeof taskId !== 'string' || !taskId || typeof rawTask.owner !== 'string' || !rawTask.owner) {
    throw maintenanceError('INVALID_TASK_IDENTITY', 'AI task identity is invalid')
  }

  const progress = progressCounts(rawTask)
  const baselineVerified = typeof rawTask.planStateFingerprint === 'string'
    && HASH_PATTERN.test(rawTask.planStateFingerprint)
  const status = baselineVerified ? 'expired' : 'conflict'
  const compacted = {
    taskSchemaVersion: safeInteger(rawTask.taskSchemaVersion, 1),
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
    failedAtMs: 0,
    cancelledAtMs: 0,
    conflictedAtMs: status === 'conflict' ? now : 0,
    errorCode: status === 'expired' ? 'AI_TASK_EXPIRED' : 'STATE_REVISION_CONFLICT',
    failureCode: status === 'expired' ? 'AI_TASK_EXPIRED' : 'STATE_REVISION_CONFLICT',
    retentionSchemaVersion: RETENTION_SCHEMA_VERSION,
    compactedAtMs: now,
    shardCleanupPending: true,
    shardCleanupUpdatedAtMs: rawTask.expiresAt,
  }
  copyDefined(compacted, rawTask, [
    'generationEpoch', 'idempotencyHash', 'requestFingerprint', 'preferencesHash',
    'contractVersion', 'plannerVersion', 'planId', 'baseStateRevision', 'stateRevision',
    'resultStateRevision', 'createdAt', 'createdAtMs',
  ])
  if (baselineVerified) compacted.planStateFingerprint = rawTask.planStateFingerprint
  return { taskId, owner: rawTask.owner, generationEpoch: rawTask.generationEpoch, data: compacted }
}

function controlMatchesTask(control, compacted) {
  return Boolean(
    control && compacted &&
    control.owner === compacted.owner &&
    control.activeTaskId === compacted.taskId &&
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
  ACTIVE_STATUS_ALIASES,
  QUERY_STATUSES,
  activeStatus,
  isExpiredActiveTask,
  progressCounts,
  compactExpiredTask,
  controlMatchesTask,
  safeErrorCode,
}
