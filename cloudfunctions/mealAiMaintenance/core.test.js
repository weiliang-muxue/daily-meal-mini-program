'use strict'

const assert = require('assert')
const {
  AI_DATA_CONSENT_VERSION,
  AI_CONTRACT_VERSION,
  AI_PLANNER_VERSION,
  AI_PROVIDER_CONTRACT_REVISION,
  TASK_SCHEMA_VERSION,
  QUERY_STATUSES,
  activeStatus,
  isExpiredActiveTask,
  progressCounts,
  taskSchemaVersionState,
  taskVersionState,
  compactExpiredTask,
  controlMatchesTask,
  safeErrorCode,
} = require('./core')

const now = 2000
const planStateFingerprint = 'a'.repeat(64)
const cacheNamespace = 'b'.repeat(32)
assert.strictEqual(AI_DATA_CONSENT_VERSION, 2)
assert.strictEqual(AI_CONTRACT_VERSION, 2)
assert.strictEqual(AI_PLANNER_VERSION, '7')
assert.strictEqual(AI_PROVIDER_CONTRACT_REVISION, 9)
assert.strictEqual(TASK_SCHEMA_VERSION, 3)
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
  taskSchemaVersion: 3, owner: 'owner_12345678', status: 'validating', phase: 'validation', taskRevision: 7,
  cacheNamespace,
  generationEpoch: 3, expiresAt: 1000, createdAt: 100, createdAtMs: 100, updatedAt: 800,
  input: { healthNotes: 'must disappear' },
  outline: { result: { title: 'must disappear' }, status: 'completed' },
  chunks: [{ status: 'completed', result: { days: ['must disappear'] } }],
  finalize: { status: 'running', leaseHash: 'must disappear' },
  idempotencyHash: 'i', requestFingerprint: 'r', preferencesHash: 'p',
  contractVersion: AI_CONTRACT_VERSION, plannerVersion: AI_PLANNER_VERSION,
  planId: 'plan-1', baseStateRevision: 4,
  aiDataConsentVersion: AI_DATA_CONSENT_VERSION,
  providerRevision: 7,
  providerConfigVersion: 'c'.repeat(64),
  planStateFingerprint,
}
assert.strictEqual(taskVersionState(raw), 'current')
const compacted = compactExpiredTask(raw, 'task_12345678', now)
assert.strictEqual(compacted.data.status, 'expired')
assert.strictEqual(compacted.data.taskSchemaVersion, 3)
assert.strictEqual(compacted.data.contractVersion, AI_CONTRACT_VERSION)
assert.strictEqual(compacted.data.plannerVersion, AI_PLANNER_VERSION)
assert.strictEqual(compacted.data.planStateFingerprint, planStateFingerprint)
assert.strictEqual(compacted.data.cacheNamespace, cacheNamespace)
assert.strictEqual(compacted.data.taskRevision, 8)
assert.strictEqual(compacted.data.errorCode, 'AI_TASK_EXPIRED')
assert.strictEqual(compacted.data.shardCleanupPending, true)
assert.strictEqual(compacted.data.shardCleanupUpdatedAtMs, raw.expiresAt)
assert.strictEqual(compacted.data.input, undefined)
assert.strictEqual(compacted.data.outline, undefined)
assert.strictEqual(compacted.data.chunks, undefined)
assert.strictEqual(compacted.data.finalize, undefined)
assert.strictEqual(compactExpiredTask({ ...raw, status: 'failed' }, 'task_12345678', now), null)

const legacyContractRaw = {
  ...raw,
  contractVersion: AI_CONTRACT_VERSION - 1,
}
assert.strictEqual(taskVersionState(legacyContractRaw), 'legacy')
const legacyContractCompacted = compactExpiredTask(
  legacyContractRaw, 'task_legacy_contract_12345678', now,
)
assert.strictEqual(legacyContractCompacted.data.status, 'failed')
assert.strictEqual(legacyContractCompacted.data.errorCode, 'AI_PLANNER_VERSION_UNSUPPORTED')
assert.strictEqual(legacyContractCompacted.data.failedAtMs, now)
assert.strictEqual(legacyContractCompacted.data.contractVersion, AI_CONTRACT_VERSION - 1)
assert.strictEqual(legacyContractCompacted.data.plannerVersion, AI_PLANNER_VERSION)
assert.strictEqual(legacyContractCompacted.data.input, undefined)
assert.strictEqual(legacyContractCompacted.data.shardCleanupPending, true)

const refusedVersionCases = [
  {
    label: 'future task schema',
    expectedState: 'current',
    schemaState: 'future',
    task: { ...raw, taskSchemaVersion: TASK_SCHEMA_VERSION + 1 },
  },
  {
    label: 'invalid task schema string',
    expectedState: 'current',
    schemaState: 'invalid',
    task: { ...raw, taskSchemaVersion: String(TASK_SCHEMA_VERSION) },
  },
  {
    label: 'invalid task schema missing',
    expectedState: 'current',
    schemaState: 'invalid',
    task: (({ taskSchemaVersion: _version, ...value }) => value)(raw),
  },
  {
    label: 'future contract',
    expectedState: 'future',
    task: { ...raw, contractVersion: AI_CONTRACT_VERSION + 1 },
  },
  {
    label: 'future planner',
    expectedState: 'future',
    task: { ...raw, plannerVersion: String(Number(AI_PLANNER_VERSION) + 1) },
  },
  {
    label: 'invalid contract',
    expectedState: 'invalid',
    task: { ...raw, contractVersion: String(AI_CONTRACT_VERSION) },
  },
  {
    label: 'invalid planner',
    expectedState: 'invalid',
    task: { ...raw, plannerVersion: `${AI_PLANNER_VERSION}.0.0` },
  },
]
refusedVersionCases.forEach(({ label, expectedState, schemaState = 'current', task }) => {
  const before = JSON.parse(JSON.stringify(task))
  assert.strictEqual(taskVersionState(task), expectedState, `${label} 必须被版本门禁识别`)
  assert.strictEqual(taskSchemaVersionState(task), schemaState, `${label} 必须被 task schema 门禁识别`)
  assert.strictEqual(
    compactExpiredTask(task, `task_${label.replace(/ /g, '_')}`, now),
    null,
    `${label} 不能被维护函数改写`,
  )
  assert.deepStrictEqual(task, before, `${label} 被拒绝时输入也必须保持不变`)
})

const { planStateFingerprint: _omitted, ...legacyRaw } = raw
const legacyCompacted = compactExpiredTask({ ...legacyRaw, taskSchemaVersion: 1 }, 'task_legacy_12345678', now)
assert.strictEqual(legacyCompacted.data.status, 'conflict')
assert.strictEqual(legacyCompacted.data.errorCode, 'STATE_REVISION_CONFLICT')
assert.strictEqual(legacyCompacted.data.expiredAtMs, 0)
assert.strictEqual(legacyCompacted.data.conflictedAtMs, now)
assert.strictEqual(legacyCompacted.data.planStateFingerprint, undefined)
assert.strictEqual(legacyCompacted.data.input, undefined)
assert.strictEqual(legacyCompacted.data.shardCleanupPending, true)
const { aiDataConsentVersion: _consentOmitted, ...noConsentRaw } = raw
const noConsentCompacted = compactExpiredTask(noConsentRaw, 'task_no_consent_12345678', now)
assert.strictEqual(noConsentCompacted.data.status, 'failed')
assert.strictEqual(noConsentCompacted.data.errorCode, 'AI_DATA_CONSENT_REQUIRED')
assert.strictEqual(noConsentCompacted.data.failedAtMs, now)
assert.strictEqual(noConsentCompacted.data.input, undefined)
assert.strictEqual(controlMatchesTask({
  owner: raw.owner, cacheNamespace, activeTaskId: 'task_12345678', generationEpoch: 3,
}, compacted), true)
assert.strictEqual(controlMatchesTask({
  owner: raw.owner, cacheNamespace, activeTaskId: 'task_12345678', generationEpoch: 4,
}, compacted), false)
assert.strictEqual(controlMatchesTask({
  owner: raw.owner, cacheNamespace: 'c'.repeat(32), activeTaskId: 'task_12345678', generationEpoch: 3,
}, compacted), false)
assert.strictEqual(safeErrorCode({ code: 'DATABASE_TIMEOUT' }), 'DATABASE_TIMEOUT')
assert.strictEqual(safeErrorCode({ code: 'unsafe text' }, 'SAFE_FALLBACK'), 'SAFE_FALLBACK')

console.log('mealAiMaintenance core tests passed')
