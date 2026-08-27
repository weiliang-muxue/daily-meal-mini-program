'use strict'

const assert = require('assert')
const {
  QUERY_STATUSES,
  activeStatus,
  isExpiredActiveTask,
  progressCounts,
  compactExpiredTask,
  controlMatchesTask,
  safeErrorCode,
} = require('./core')

const now = 2000
const planStateFingerprint = 'a'.repeat(64)
assert.deepStrictEqual(QUERY_STATUSES, [
  'queued', 'running', 'finalizing', 'pending', 'processing', 'generating', 'validating', 'active',
])
assert.strictEqual(activeStatus('processing'), 'running')
assert.strictEqual(activeStatus('completed'), '')
assert.strictEqual(isExpiredActiveTask({ status: 'queued', expiresAt: now }, now), true)
assert.strictEqual(isExpiredActiveTask({ status: 'running', expiresAt: now + 1 }, now), false)
assert.strictEqual(isExpiredActiveTask({ status: 'failed', expiresAt: now - 1 }, now), false)
assert.deepStrictEqual(progressCounts({
  outline: { status: 'completed' },
  chunks: [{ status: 'completed' }, { status: 'running' }],
  finalize: { status: 'pending' },
}), { totalSteps: 4, completedSteps: 2 })

const raw = {
  taskSchemaVersion: 2, owner: 'owner_12345678', status: 'validating', phase: 'validation', taskRevision: 7,
  generationEpoch: 3, expiresAt: 1000, createdAt: 100, createdAtMs: 100, updatedAt: 800,
  input: { healthNotes: 'must disappear' },
  outline: { result: { title: 'must disappear' }, status: 'completed' },
  chunks: [{ status: 'completed', result: { days: ['must disappear'] } }],
  finalize: { status: 'running', leaseHash: 'must disappear' },
  idempotencyHash: 'i', requestFingerprint: 'r', preferencesHash: 'p',
  contractVersion: 3, plannerVersion: '3.0.0', planId: 'plan-1', baseStateRevision: 4,
  planStateFingerprint,
}
const compacted = compactExpiredTask(raw, 'task_12345678', now)
assert.strictEqual(compacted.data.status, 'expired')
assert.strictEqual(compacted.data.taskSchemaVersion, 2)
assert.strictEqual(compacted.data.planStateFingerprint, planStateFingerprint)
assert.strictEqual(compacted.data.taskRevision, 8)
assert.strictEqual(compacted.data.errorCode, 'AI_TASK_EXPIRED')
assert.strictEqual(compacted.data.shardCleanupPending, true)
assert.strictEqual(compacted.data.shardCleanupUpdatedAtMs, raw.expiresAt)
assert.strictEqual(compacted.data.input, undefined)
assert.strictEqual(compacted.data.outline, undefined)
assert.strictEqual(compacted.data.chunks, undefined)
assert.strictEqual(compacted.data.finalize, undefined)
assert.strictEqual(compactExpiredTask({ ...raw, status: 'failed' }, 'task_12345678', now), null)

const { planStateFingerprint: _omitted, ...legacyRaw } = raw
const legacyCompacted = compactExpiredTask({ ...legacyRaw, taskSchemaVersion: 1 }, 'task_legacy_12345678', now)
assert.strictEqual(legacyCompacted.data.status, 'conflict')
assert.strictEqual(legacyCompacted.data.errorCode, 'STATE_REVISION_CONFLICT')
assert.strictEqual(legacyCompacted.data.expiredAtMs, 0)
assert.strictEqual(legacyCompacted.data.conflictedAtMs, now)
assert.strictEqual(legacyCompacted.data.planStateFingerprint, undefined)
assert.strictEqual(legacyCompacted.data.input, undefined)
assert.strictEqual(legacyCompacted.data.shardCleanupPending, true)
assert.strictEqual(controlMatchesTask({
  owner: raw.owner, activeTaskId: 'task_12345678', generationEpoch: 3,
}, compacted), true)
assert.strictEqual(controlMatchesTask({
  owner: raw.owner, activeTaskId: 'task_12345678', generationEpoch: 4,
}, compacted), false)
assert.strictEqual(safeErrorCode({ code: 'DATABASE_TIMEOUT' }), 'DATABASE_TIMEOUT')
assert.strictEqual(safeErrorCode({ code: 'unsafe text' }, 'SAFE_FALLBACK'), 'SAFE_FALLBACK')

console.log('mealAiMaintenance core tests passed')
