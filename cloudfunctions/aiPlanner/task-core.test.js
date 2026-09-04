'use strict'

const assert = require('assert')
const { CONTRACT_VERSION, PLANNER_VERSION, preferencesHash } = require('./lib')
const {
  TASK_SCHEMA_VERSION, TASK_TTL_MS, LEASE_MS, MAX_ATTEMPTS, MAX_CONCURRENT_DETAILS, AI_DATA_CONSENT_VERSION,
  RETENTION_SCHEMA_VERSION,
  generateTaskId, validateTaskId, generateLeaseToken, validateClientRequestId,
  idempotencyFingerprint, requestFingerprint, sameIdempotentRequest,
  planStateFingerprint, hasPlanStateFingerprint, hasAiDataConsent,
  taskSchemaVersionState, assertSupportedTaskSchema,
  createTask, claimNext, completeClaim, failClaim, verifyLease,
  assertTaskOwner, cancelTask, expireTask, finishTask,
  publicTask, compactTask, terminal,
} = require('./task-core')

const input = {
  contractVersion: CONTRACT_VERSION, durationDays: 7, startDate: '2026-08-31',
  mealTypes: ['breakfast', 'lunch', 'dinner'], doubleDinner: true,
  goals: ['均衡饮食'], styles: ['清淡'], customGoal: '', restrictions: '', healthNotes: '', exerciseIntent: 'none', exerciseNotes: '', exerciseByDay: [],
}
const owner = 'openid-test-owner'
const clientRequestId = '0123456789abcdef0123456789abcdef'
const fixedTaskId = generateTaskId(Buffer.alloc(32, 7))
const providerRevision = 7
const providerConfigVersion = 'a'.repeat(64)

function lease(seed) { return generateLeaseToken(Buffer.alloc(32, seed)) }
function task(overrides = {}) {
  const hash = preferencesHash(input)
  return createTask({
    taskId: fixedTaskId, owner, input, preferencesHash: hash,
    baseStateRevision: 2, stateRevision: 2, planId: 'plan-test',
    generatedAt: '2026-08-26T00:00:00.000Z', now: 1000,
    clientRequestId, contractVersion: CONTRACT_VERSION, plannerVersion: PLANNER_VERSION,
    aiDataConsentVersion: AI_DATA_CONSENT_VERSION,
    providerRevision, providerConfigVersion,
    ...overrides,
  })
}

function completeOutline(value, at = 2100) {
  const token = lease(1)
  const claimed = claimNext(value, token, 2000)
  assert.strictEqual(claimed.claim.kind, 'outline')
  return completeClaim(claimed.task, claimed.claim, token, { title: '脱敏提纲', rationale: ['脱敏依据'] }, at)
}

const tests = []
function test(name, run) { tests.push({ name, run }) }

test('任务 ID 与租约不包含 owner 且要求足够随机长度', () => {
  assert.match(fixedTaskId, /^task_[A-Za-z0-9_-]{43}$/)
  assert.strictEqual(fixedTaskId.includes(owner), false)
  assert.strictEqual(validateTaskId(fixedTaskId), fixedTaskId)
  assert.match(lease(2), /^[A-Za-z0-9_-]{43}$/)
  assert.throws(() => validateTaskId(`task_${owner}`), (error) => error.code === 'INVALID_TASK_ID')
})

test('clientRequestId 严格校验，幂等键按 owner 隔离', () => {
  assert.strictEqual(validateClientRequestId(clientRequestId), clientRequestId)
  assert.throws(() => validateClientRequestId('short'), (error) => error.code === 'INVALID_CLIENT_REQUEST_ID')
  assert.throws(() => validateClientRequestId(`${clientRequestId}/bad`), (error) => error.code === 'INVALID_CLIENT_REQUEST_ID')
  assert.notStrictEqual(idempotencyFingerprint(owner, clientRequestId), idempotencyFingerprint('other-owner', clientRequestId))
})

test('相同幂等键和请求只重放，内容或 revision 改变即冲突', () => {
  const created = task()
  const expected = { idempotencyHash: created.idempotencyHash, requestFingerprint: created.requestFingerprint }
  assert.strictEqual(sameIdempotentRequest(null, expected), 'new')
  assert.strictEqual(sameIdempotentRequest(created, expected), 'replay')
  const changed = requestFingerprint({
    preferencesHash: created.preferencesHash, baseStateRevision: 3,
    contractVersion: CONTRACT_VERSION, plannerVersion: created.plannerVersion,
    aiDataConsentVersion: AI_DATA_CONSENT_VERSION,
    providerRevision, providerConfigVersion,
  })
  assert.strictEqual(sameIdempotentRequest(created, { ...expected, requestFingerprint: changed }), 'conflict')
  assert.strictEqual(sameIdempotentRequest(created, { ...expected, idempotencyHash: 'f'.repeat(64) }), 'conflict')
})

test('创建任务会重新规范化偏好并拒绝伪造的三类指纹', () => {
  const created = task({ input: { ...input, ignoredByContract: '不得存入任务' } })
  assert.strictEqual(TASK_SCHEMA_VERSION, 3)
  assert.strictEqual(created.taskSchemaVersion, TASK_SCHEMA_VERSION)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(created.input, 'ignoredByContract'), false)
  assert.throws(() => task({ preferencesHash: 'f'.repeat(32) }), (error) => error.code === 'REQUEST_FINGERPRINT_MISMATCH')
  assert.throws(() => task({ idempotencyHash: 'f'.repeat(64) }), (error) => error.code === 'IDEMPOTENCY_FINGERPRINT_MISMATCH')
  assert.throws(() => task({ requestFingerprint: 'f'.repeat(64) }), (error) => error.code === 'REQUEST_FINGERPRINT_MISMATCH')
  assert.match(created.planStateFingerprint, /^[a-f0-9]{64}$/)
  assert.strictEqual(created.planStateFingerprint, planStateFingerprint(null, null))
  assert.strictEqual(hasPlanStateFingerprint(created), true)
  assert.strictEqual(hasAiDataConsent(created), true)
  assert.strictEqual(created.providerRevision, providerRevision)
  assert.strictEqual(created.providerConfigVersion, providerConfigVersion)
  assert.throws(() => task({ aiDataConsentVersion: 0 }), (error) => error.code === 'AI_DATA_CONSENT_REQUIRED')
  assert.throws(() => task({ providerRevision: 0 }), (error) => error.code === 'INVALID_TASK_INPUT')
  assert.throws(() => task({ providerConfigVersion: '' }), (error) => error.code === 'INVALID_TASK_INPUT')
})

test('核心 worker 对未来或非法 task schema 失败关闭且不修改输入', () => {
  const cases = [
    { value: TASK_SCHEMA_VERSION + 1, state: 'future', code: 'AI_TASK_SCHEMA_VERSION_UNSUPPORTED' },
    { value: '3', state: 'invalid', code: 'AI_TASK_VERSION_INVALID' },
    { value: 0, state: 'invalid', code: 'AI_TASK_VERSION_INVALID' },
    { value: undefined, state: 'invalid', code: 'AI_TASK_VERSION_INVALID' },
  ]
  cases.forEach(({ value, state, code }, index) => {
    const original = task()
    if (value === undefined) delete original.taskSchemaVersion
    else original.taskSchemaVersion = value
    const before = JSON.parse(JSON.stringify(original))
    const claim = { taskId: original._id, kind: 'outline', index: -1, attempt: 1, inputHash: '', outlineHash: '' }
    const token = lease(50 + index)
    assert.strictEqual(taskSchemaVersionState(original), state)
    ;[
      () => assertSupportedTaskSchema(original),
      () => claimNext(original, token, 1200),
      () => completeClaim(original, claim, token, { title: '不得写入' }, 1200),
      () => failClaim(original, claim, token, 'AI_NETWORK_ERROR', 1200),
      () => cancelTask(original, owner, original.taskRevision, 1200),
      () => expireTask(original, original.expiresAt + 1),
      () => finishTask(original, 'failed', 1200),
      () => publicTask(original, 1200, owner),
      () => compactTask(original, 'failed', 1200),
    ].forEach((invoke) => assert.throws(invoke, (error) => error && error.code === code))
    assert.deepStrictEqual(original, before, 'schema 门禁拒绝时不能改写任务对象')
  })
})

test('task schema v2 仍进入明确允许的旧任务关闭逻辑且不会被升级为 v3', () => {
  const legacy = task()
  legacy.taskSchemaVersion = 2
  delete legacy.aiDataConsentVersion
  assert.deepStrictEqual(assertSupportedTaskSchema(legacy), { state: 'legacy', version: 2 })
  const outcome = claimNext(legacy, lease(59), 1200)
  assert.strictEqual(outcome.task.status, 'failed')
  assert.strictEqual(outcome.task.errorCode, 'AI_DATA_CONSENT_REQUIRED')
  const compacted = compactTask(outcome.task, 'failed', 1200)
  assert.strictEqual(compacted.taskSchemaVersion, 2)
})

test('同意版本进入请求指纹，缺少同意的旧活动任务在 claim 前失败关闭', () => {
  const created = task()
  assert.throws(() => requestFingerprint({
    preferencesHash: created.preferencesHash,
    baseStateRevision: created.baseStateRevision,
    contractVersion: created.contractVersion,
    plannerVersion: created.plannerVersion,
    providerRevision,
    providerConfigVersion,
  }), (error) => error.code === 'AI_DATA_CONSENT_REQUIRED')
  const legacy = { ...created, status: 'queued' }
  delete legacy.aiDataConsentVersion
  const outcome = claimNext(legacy, lease(44), 1200)
  assert.strictEqual(outcome.claim, null)
  assert.strictEqual(outcome.task.status, 'failed')
  assert.strictEqual(outcome.task.errorCode, 'AI_DATA_CONSENT_REQUIRED')
})

test('计划基线摘要包含 null 与完整规范化计划内容且不保存计划正文', () => {
  const activePlan = { id: 'active-plan', planVersion: 1, nested: { title: 'private active body' } }
  const draftPlan = { id: 'draft-plan', planVersion: 2, nested: { title: 'private draft body' } }
  const created = task({ activePlan, draftPlan })
  assert.strictEqual(created.planStateFingerprint, planStateFingerprint(activePlan, draftPlan))
  assert.notStrictEqual(created.planStateFingerprint, planStateFingerprint(activePlan, null))
  assert.notStrictEqual(created.planStateFingerprint, planStateFingerprint({ ...activePlan, planVersion: 2 }, draftPlan))
  assert.strictEqual(Object.prototype.hasOwnProperty.call(created, 'activePlan'), false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(created, 'draftPlan'), false)
  assert.strictEqual(JSON.stringify(created).includes('private active body'), false)
  assert.strictEqual(JSON.stringify(created).includes('private draft body'), false)
})

test('任务从 queued 开始，每次有效状态变更递增 taskRevision', () => {
  const created = task()
  assert.strictEqual(created.plannerVersion, '7')
  assert.strictEqual(created.chunks.every((chunk) => chunk.mealSlots === 1), true)
  assert.strictEqual(created.chunks.reduce((sum, chunk) => sum + chunk.mealSlots, 0), 28)
  assert.strictEqual(created.status, 'queued')
  assert.strictEqual(created.taskRevision, 0)
  assert.strictEqual(created.createdAt, 1000)
  assert.strictEqual(created.updatedAt, 1000)
  const claimed = claimNext(created, lease(3), 2000)
  assert.strictEqual(claimed.task.status, 'running')
  assert.strictEqual(claimed.task.taskRevision, 1)
  assert.strictEqual(claimed.task.createdAt, 1000)
  assert.strictEqual(claimed.task.updatedAt, 2000)
  assert.strictEqual(claimed.task.planStateFingerprint, created.planStateFingerprint)
  assert.strictEqual(created.taskRevision, 0)
  const completed = completeClaim(claimed.task, claimed.claim, lease(3), { title: '提纲' }, 2100)
  assert.strictEqual(completed.task.taskRevision, 2)
})

test('缺少计划基线摘要的旧活动任务及状态别名在核心 claim 层失败关闭', () => {
  ['queued', 'running', 'finalizing', 'pending', 'processing', 'generating', 'validating', 'active']
    .forEach((status) => {
      const legacy = task()
      delete legacy.planStateFingerprint
      legacy.taskSchemaVersion = 1
      legacy.status = status
      const outcome = claimNext(legacy, lease(43), 1200)
      assert.strictEqual(outcome.claim, null)
      assert.strictEqual(outcome.task.status, 'conflict')
      assert.strictEqual(outcome.task.errorCode, 'STATE_REVISION_CONFLICT')
    })
})

test('跨用户读取或取消与不存在任务使用同一 TASK_NOT_FOUND', () => {
  const created = task()
  assert.throws(() => assertTaskOwner(created, 'other-owner'), (error) => error.code === 'TASK_NOT_FOUND' && error.message === '任务不存在')
  assert.throws(() => assertTaskOwner(null, owner), (error) => error.code === 'TASK_NOT_FOUND' && error.message === '任务不存在')
  assert.throws(() => publicTask(created, 1100, 'other-owner'), (error) => error.code === 'TASK_NOT_FOUND')
  assert.throws(() => cancelTask(created, 'other-owner', 0, 1100), (error) => error.code === 'TASK_NOT_FOUND')
})

test('同一工作单元只能有一个有效租约，并绑定 attempt/inputHash/outlineHash', () => {
  const firstToken = lease(4)
  const first = claimNext(task(), firstToken, 2000)
  assert.strictEqual(first.claim.kind, 'outline')
  assert.strictEqual(first.claim.attempt, 1)
  assert.strictEqual(claimNext(first.task, lease(5), 2001).claim, null)
  assert.strictEqual(verifyLease(first.task, first.claim, firstToken, 2002), true)
  assert.strictEqual(verifyLease(first.task, { ...first.claim, attempt: 2 }, firstToken, 2002), false)
  assert.strictEqual(verifyLease(first.task, { ...first.claim, inputHash: '0'.repeat(64) }, firstToken, 2002), false)
})

test('提纲冻结 outlineHash，详情 claim 绑定对应提纲与分片输入', () => {
  const outlined = completeOutline(task())
  assert.strictEqual(outlined.accepted, true)
  assert.match(outlined.task.outlineHash, /^[a-f0-9]{64}$/)
  assert.strictEqual(outlined.task.chunks.every((chunk) => chunk.outlineHash === outlined.task.outlineHash), true)
  const detail = claimNext(outlined.task, lease(6), 2200)
  assert.strictEqual(detail.claim.kind, 'detail')
  assert.strictEqual(detail.claim.outlineHash, outlined.task.outlineHash)
  assert.strictEqual(detail.claim.inputHash, detail.task.chunks[detail.claim.index].inputHash)
  const tampered = completeClaim(detail.task, { ...detail.claim, outlineHash: '0'.repeat(64) }, lease(6), { days: [] }, 2300)
  assert.strictEqual(tampered.accepted, false)
  assert.strictEqual(tampered.reason, 'STALE_LEASE')
})

test('详情分片严格顺序领取，前一分片完成前不能领取下一分片', () => {
  assert.strictEqual(MAX_CONCURRENT_DETAILS, 1)
  let current = completeOutline(task()).task
  const firstToken = lease(10)
  const first = claimNext(current, firstToken, 2300)
  assert.strictEqual(first.claim.kind, 'detail')
  assert.strictEqual(first.claim.index, 0)
  assert.strictEqual(claimNext(first.task, lease(20), 2400).claim, null)
  current = completeClaim(first.task, first.claim, firstToken, { days: [] }, 2450).task
  const second = claimNext(current, lease(11), 2500)
  assert.strictEqual(second.claim.kind, 'detail')
  assert.strictEqual(second.claim.index, 1)
})

test('详情失败等待重试时不能越过当前分片，恢复后仍领取同一索引', () => {
  let current = completeOutline(task()).task
  const firstToken = lease(12)
  const first = claimNext(current, firstToken, 2600)
  const failed = failClaim(first.task, first.claim, firstToken, 'AI_OUTPUT_INVALID', 2650, { retryAt: 3250 })
  assert.strictEqual(failed.task.status, 'running')
  assert.strictEqual(claimNext(failed.task, lease(13), 3000).claim, null)
  const retried = claimNext(failed.task, lease(14), 3250)
  assert.strictEqual(retried.claim.kind, 'detail')
  assert.strictEqual(retried.claim.index, first.claim.index)
  assert.strictEqual(retried.claim.attempt, 2)
})

test('租约超时后可重新 claim，旧 worker 晚到不能覆盖新租约', () => {
  const outlined = completeOutline(task()).task
  const oldToken = lease(21)
  const old = claimNext(outlined, oldToken, 3000)
  const newToken = lease(22)
  const reclaimed = claimNext(old.task, newToken, 3000 + LEASE_MS)
  assert.strictEqual(reclaimed.claim.attempt, 2)
  const late = completeClaim(reclaimed.task, old.claim, oldToken, { days: ['old'] }, 3000 + LEASE_MS + 1)
  assert.strictEqual(late.accepted, false)
  const current = completeClaim(reclaimed.task, reclaimed.claim, newToken, { days: ['new'] }, 3000 + LEASE_MS + 2)
  assert.strictEqual(current.accepted, true)
  assert.deepStrictEqual(current.task.chunks[reclaimed.claim.index].result, { days: ['new'] })
})

test('相同完成回包幂等，不同结果不能借旧 claim 重放', () => {
  const token = lease(23)
  const claimed = claimNext(task(), token, 2000)
  const first = completeClaim(claimed.task, claimed.claim, token, { title: '同一结果' }, 2100)
  const replay = completeClaim(first.task, claimed.claim, token, { title: '同一结果' }, 2200)
  assert.strictEqual(replay.accepted, true)
  assert.strictEqual(replay.idempotent, true)
  assert.strictEqual(replay.task.taskRevision, first.task.taskRevision)
  const changed = completeClaim(first.task, claimed.claim, token, { title: '篡改结果' }, 2200)
  assert.strictEqual(changed.accepted, false)
})

test('失败和租约超时的上游尝试次数有硬上限', () => {
  let current = task()
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const token = lease(30 + attempt)
    const work = claimNext(current, token, 3000 + attempt * 100)
    const failed = failClaim(work.task, work.claim, token, 'AI_TIMEOUT', 3050 + attempt * 100)
    assert.strictEqual(failed.accepted, true)
    current = failed.task
  }
  assert.strictEqual(current.status, 'failed')
  assert.strictEqual(current.errorCode, 'AI_TIMEOUT')
  assert.strictEqual(terminal(current.status), true)
  assert.strictEqual(claimNext(current, lease(39), 4000).claim, null)
})

test('不可重试的上游拒绝首次就进入终态', () => {
  const token = lease(38)
  const work = claimNext(task(), token, 3000)
  const failed = failClaim(work.task, work.claim, token, 'AI_UPSTREAM_AUTH_REJECTED', 3050, { retryable: false })
  assert.strictEqual(failed.accepted, true)
  assert.strictEqual(failed.task.status, 'failed')
  assert.strictEqual(failed.task.errorCode, 'AI_UPSTREAM_AUTH_REJECTED')
  assert.strictEqual(claimNext(failed.task, lease(39), 4000).claim, null)
})

test('到期边界使用服务端传入时间，过期任务不能再 claim 或完成', () => {
  const before = claimNext(task(), lease(40), 1000 + TASK_TTL_MS - 1)
  assert(before.claim)
  const atBoundary = claimNext(task(), lease(41), 1000 + TASK_TTL_MS)
  assert.strictEqual(atBoundary.task.status, 'expired')
  assert.strictEqual(atBoundary.claim, null)
  const late = completeClaim(before.task, before.claim, lease(40), { title: 'late' }, 1000 + TASK_TTL_MS)
  assert.strictEqual(late.accepted, false)
  assert.strictEqual(late.task.status, 'expired')
  assert(before.task.outline.leaseExpiresAt <= before.task.expiresAt)
})

test('取消要求 owner 与 taskRevision，所有终态均不可逆', () => {
  const created = task()
  assert.throws(() => cancelTask(created, owner, 1, 1500), (error) => error.code === 'TASK_REVISION_CONFLICT')
  const cancelled = cancelTask(created, owner, 0, 1500)
  assert.strictEqual(cancelled.status, 'cancelled')
  assert.strictEqual(cancelTask(cancelled, owner, cancelled.taskRevision, 1600).status, 'cancelled')
  assert.strictEqual(finishTask(cancelled, 'failed', 1700).status, 'cancelled')
  assert.strictEqual(expireTask(cancelled, 1000 + TASK_TTL_MS).status, 'cancelled')
  assert.strictEqual(claimNext(cancelled, lease(42), 1800).claim, null)
})

test('只有完成 finalize 的任务可成功，revision 冲突使用独立终态', () => {
  assert.throws(() => finishTask(task(), 'succeeded', 2000, { resultStateRevision: 3 }), (error) => error.code === 'TASK_NOT_FINALIZED')
  const conflicted = finishTask(task(), 'conflict', 2000, { errorCode: 'STATE_REVISION_CONFLICT' })
  assert.strictEqual(conflicted.status, 'conflict')
  assert.strictEqual(conflicted.errorCode, 'STATE_REVISION_CONFLICT')
  assert.strictEqual(finishTask(conflicted, 'succeeded', 2100).status, 'conflict')
})

test('公开进度不泄露 owner、偏好、结果、租约或健康文本', () => {
  const progress = publicTask(task(), 1100, owner)
  assert.deepStrictEqual(Object.keys(progress), [
    'taskId', 'status', 'contractVersion', 'plannerVersion', 'phase', 'taskRevision', 'completedSteps', 'totalSteps', 'progressPercent',
    'errorCode', 'failureCode', 'expiresAt', 'resultStateRevision',
  ])
  const serialized = JSON.stringify(progress)
  assert.strictEqual(serialized.includes(owner), false)
  assert.strictEqual(serialized.includes('均衡饮食'), false)
  assert.strictEqual(serialized.includes('清淡'), false)
  assert.strictEqual(serialized.includes('lease'), false)
})

test('任务压缩保留幂等与审计字段并清除私人正文和所有租约结果', () => {
  const active = task()
  active.generationEpoch = 7
  const cancelled = cancelTask(active, owner, 0, 1500)
  const compacted = compactTask(cancelled, 'cancelled', 1500)
  assert.strictEqual(compacted.status, 'cancelled')
  assert.strictEqual(compacted.owner, owner)
  assert.strictEqual(compacted.generationEpoch, 7)
  assert.strictEqual(compacted.createdAt, 1000)
  assert.strictEqual(compacted.updatedAt, 1500)
  assert.strictEqual(compacted.retentionSchemaVersion, RETENTION_SCHEMA_VERSION)
  assert.strictEqual(compacted.compactedAtMs, 1500)
  assert.strictEqual(compacted.shardCleanupPending, true)
  assert.strictEqual(compacted.shardCleanupUpdatedAtMs, 1500)
  assert.match(compacted.idempotencyHash, /^[a-f0-9]{64}$/)
  assert.strictEqual(compacted.planStateFingerprint, active.planStateFingerprint)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(compacted, 'input'), false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(compacted, 'outline'), false)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(compacted, 'chunks'), false)
  assert.strictEqual(JSON.stringify(compacted).includes('leaseHash'), false)
  assert.strictEqual(sameIdempotentRequest(compacted, {
    idempotencyHash: compacted.idempotencyHash,
    requestFingerprint: compacted.requestFingerprint,
  }), 'replay')

  const cleaned = compactTask({
    ...compacted,
    shardCleanupPending: false,
    shardCleanupUpdatedAtMs: 1600,
    shardsCleanedAtMs: 1600,
  }, 'cancelled', 1700)
  assert.strictEqual(cleaned.shardCleanupPending, false, '重复压缩不能重新排队已完成的分片清理')
  assert.strictEqual(cleaned.shardCleanupUpdatedAtMs, 1600)
  assert.strictEqual(cleaned.shardsCleanedAtMs, 1600)
  assert.strictEqual(cleaned.compactedAtMs, 1500)

  const legacyRetention = compactTask({
    ...cleaned,
    retentionSchemaVersion: 0,
    shardCleanupPending: false,
  }, 'cancelled', 1800)
  assert.strictEqual(legacyRetention.shardCleanupPending, true, '旧 retention 版本必须重新登记清理')
  assert.strictEqual(legacyRetention.shardCleanupUpdatedAtMs, 1800)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(legacyRetention, 'shardsCleanedAtMs'), false)
})

let passed = 0
tests.forEach(({ name, run }) => {
  try {
    run()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
})
console.log(`AI task core tests passed: ${passed}/${tests.length}`)
