'use strict'

const crypto = require('crypto')
const { buildChunkLayout, normalizeRequest, preferencesHash: computePreferencesHash } = require('./lib')

const TASK_SCHEMA_VERSION = 2
const TASK_TTL_MS = 2 * 60 * 60 * 1000
const LEASE_MS = 70 * 1000
const MAX_ATTEMPTS = 2
const MAX_CONCURRENT_DETAILS = 1
const ACTIVE_STATUSES = new Set(['queued', 'running', 'finalizing'])
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'conflict'])
const TERMINAL = TERMINAL_STATUSES
const TASK_ID_PATTERN = /^task_[A-Za-z0-9_-]{43}$/
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }

function taskError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function safeInteger(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw taskError('INVALID_TASK_INPUT', `${field}无效`)
  return value
}

function safeTime(value, field) { return safeInteger(value, field, 0) }

function stableStringify(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw taskError('INVALID_TASK_INPUT', '任务指纹包含非法数字')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  throw taskError('INVALID_TASK_INPUT', '任务指纹包含不支持的值')
}

function digestParts(...parts) {
  const hash = crypto.createHash('sha256')
  parts.forEach((part) => {
    const value = Buffer.from(typeof part === 'string' ? part : stableStringify(part), 'utf8')
    hash.update(String(value.length))
    hash.update(':')
    hash.update(value)
    hash.update('|')
  })
  return hash.digest('hex')
}

function tokenHash(value) { return digestParts('meal-ai-lease-v1', String(value || '')) }
function resultHash(value) { return digestParts('meal-ai-result-v1', value === undefined ? null : value) }

function planStateFingerprint(activePlan, draftPlan) {
  return digestParts('meal-ai-plan-state-v1', {
    activePlan: activePlan === undefined || activePlan === null ? null : activePlan,
    draftPlan: draftPlan === undefined || draftPlan === null ? null : draftPlan,
  })
}

function hasPlanStateFingerprint(task) {
  return Boolean(task && typeof task.planStateFingerprint === 'string' && HASH_PATTERN.test(task.planStateFingerprint))
}

function randomBytes(source, length) {
  if (Buffer.isBuffer(source)) return source
  if (typeof source === 'function') return source(length)
  return crypto.randomBytes(length)
}

function generateTaskId(source) {
  const bytes = randomBytes(source, 32)
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw taskError('INVALID_RANDOM_SOURCE', '任务随机源无效')
  return `task_${bytes.toString('base64url')}`
}

function validateTaskId(value) {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) throw taskError('INVALID_TASK_ID', '任务编号无效')
  return value
}

function generateLeaseToken(source) {
  const bytes = randomBytes(source, 32)
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw taskError('INVALID_RANDOM_SOURCE', '租约随机源无效')
  return bytes.toString('base64url')
}

function validateLeaseToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw taskError('INVALID_LEASE_TOKEN', '任务租约无效')
  }
  return value
}

function validateClientRequestId(value) {
  if (typeof value !== 'string' || !CLIENT_REQUEST_ID_PATTERN.test(value)) {
    throw taskError('INVALID_CLIENT_REQUEST_ID', '请求编号必须是至少 128 位熵的随机值')
  }
  return value
}

function idempotencyFingerprint(owner, clientRequestId) {
  if (typeof owner !== 'string' || !owner) throw taskError('INVALID_TASK_INPUT', '任务所有者无效')
  return digestParts('meal-ai-idempotency-v1', owner, validateClientRequestId(clientRequestId))
}

function normalizeHash(value, field) {
  const hash = typeof value === 'string' ? value.toLowerCase() : ''
  if (!HASH_PATTERN.test(hash)) throw taskError('INVALID_TASK_INPUT', `${field}无效`)
  return hash
}

function normalizePreferencesHash(value) {
  const hash = typeof value === 'string' ? value.toLowerCase() : ''
  if (!/^[a-f0-9]{32}$|^[a-f0-9]{64}$/.test(hash)) throw taskError('INVALID_TASK_INPUT', 'preferencesHash无效')
  return hash
}

function requestFingerprint(options = {}) {
  const preferencesHash = normalizePreferencesHash(options.preferencesHash)
  const baseStateRevision = safeInteger(options.baseStateRevision, 'baseStateRevision')
  const contractVersion = safeInteger(options.contractVersion, 'contractVersion', 1)
  const plannerVersion = typeof options.plannerVersion === 'string' ? options.plannerVersion.trim() : ''
  if (!plannerVersion || plannerVersion.length > 40 || !/^[A-Za-z0-9._-]+$/.test(plannerVersion)) {
    throw taskError('INVALID_TASK_INPUT', 'plannerVersion无效')
  }
  return digestParts('meal-ai-request-v1', { preferencesHash, baseStateRevision, contractVersion, plannerVersion })
}

function sameIdempotentRequest(task, expected = {}) {
  if (!task) return 'new'
  const idempotencyHash = normalizeHash(expected.idempotencyHash, 'idempotencyHash')
  const fingerprint = normalizeHash(expected.requestFingerprint, 'requestFingerprint')
  if (task.idempotencyHash !== idempotencyHash) return 'conflict'
  return task.requestFingerprint === fingerprint ? 'replay' : 'conflict'
}

function terminal(status) {
  if (status === 'completed') return true
  return TERMINAL_STATUSES.has(status)
}

function canonicalStatus(status) {
  if (status === 'completed') return 'succeeded'
  if (status === 'pending') return 'queued'
  if (['processing', 'generating', 'active'].includes(status)) return 'running'
  if (status === 'validating') return 'finalizing'
  return status
}

function assertTaskOwner(task, openid) {
  if (!task || typeof openid !== 'string' || !openid || task.owner !== openid) {
    throw taskError('TASK_NOT_FOUND', '任务不存在')
  }
  return task
}

function safeErrorCode(value, fallback = 'AI_GENERATION_FAILED') {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value) ? value : fallback
}

function step(inputHash = '', outlineHash = '') {
  return {
    status: 'pending', attempt: 0, attempts: 0,
    leaseHash: '', leaseExpiresAt: 0, inputHash, outlineHash,
    result: null, resultHash: '', completionHash: '', lastFailureCode: '', nextAttemptAt: 0,
  }
}

function chunkInputHash(task, chunk, outlineHash) {
  return digestParts('meal-ai-detail-input-v1', task.requestFingerprint, outlineHash, {
    index: chunk.index, dayOffset: chunk.dayOffset, dayCount: chunk.dayCount, mealSlots: chunk.mealSlots,
  })
}

function finalizeInputHash(task) {
  return digestParts('meal-ai-finalize-input-v1', task.requestFingerprint, task.outlineHash, task.chunks.map((chunk) => ({
    index: chunk.index, inputHash: chunk.inputHash, resultHash: chunk.resultHash,
  })))
}

function createTask(options = {}) {
  const owner = typeof options.owner === 'string' ? options.owner : ''
  if (!owner) throw taskError('INVALID_TASK_INPUT', '任务所有者无效')
  const normalizedInput = normalizeRequest(options.input)
  const now = safeTime(options.now, 'now')
  const baseStateRevision = safeInteger(options.baseStateRevision, 'baseStateRevision')
  const stateRevision = options.stateRevision === undefined ? baseStateRevision : safeInteger(options.stateRevision, 'stateRevision')
  const preferencesHash = computePreferencesHash(normalizedInput)
  const suppliedPreferencesHash = options.preferencesHash || options.requestHash
  if (suppliedPreferencesHash && normalizePreferencesHash(suppliedPreferencesHash) !== preferencesHash) {
    throw taskError('REQUEST_FINGERPRINT_MISMATCH', '偏好指纹不匹配')
  }
  const contractVersion = safeInteger(options.contractVersion || normalizedInput.contractVersion, 'contractVersion', 1)
  if (contractVersion !== normalizedInput.contractVersion) throw taskError('REQUEST_FINGERPRINT_MISMATCH', '契约版本不匹配')
  const plannerVersion = typeof options.plannerVersion === 'string' && options.plannerVersion ? options.plannerVersion : '1'
  const clientRequestId = validateClientRequestId(options.clientRequestId)
  const idempotencyHash = idempotencyFingerprint(owner, clientRequestId)
  if (options.idempotencyHash && normalizeHash(options.idempotencyHash, 'idempotencyHash') !== idempotencyHash) {
    throw taskError('IDEMPOTENCY_FINGERPRINT_MISMATCH', '幂等指纹不匹配')
  }
  const fingerprint = requestFingerprint({ preferencesHash, baseStateRevision, contractVersion, plannerVersion })
  if (options.requestFingerprint && normalizeHash(options.requestFingerprint, 'requestFingerprint') !== fingerprint) {
    throw taskError('REQUEST_FINGERPRINT_MISMATCH', '请求指纹不匹配')
  }
  const taskId = options.taskId ? validateTaskId(options.taskId) : generateTaskId(options.randomSource)
  const outlineInputHash = digestParts('meal-ai-outline-input-v1', fingerprint)
  const task = {
    _id: taskId, taskSchemaVersion: TASK_SCHEMA_VERSION, owner,
    status: 'queued', phase: 'outline', taskRevision: 0,
    clientRequestIdHash: digestParts('meal-ai-client-request-v1', clientRequestId),
    idempotencyHash, requestFingerprint: fingerprint, preferencesHash, requestHash: preferencesHash,
    baseStateRevision, stateRevision, input: normalizedInput, contractVersion, plannerVersion,
    planId: typeof options.planId === 'string' ? options.planId : '',
    planStateFingerprint: planStateFingerprint(options.activePlan, options.draftPlan),
    generatedAt: typeof options.generatedAt === 'string' ? options.generatedAt : '',
    outlineHash: '', outline: step(outlineInputHash, ''), chunks: [], finalize: step('', ''),
    failureCode: '', errorCode: '', resultStateRevision: null,
    createdAt: now, updatedAt: now,
    createdAtMs: now, updatedAtMs: now, expiresAt: now + TASK_TTL_MS, terminalAtMs: 0,
  }
  task.chunks = buildChunkLayout(normalizedInput).map((chunk) => ({
    ...chunk, ...step(digestParts('meal-ai-detail-pending-v1', fingerprint, chunk), ''),
  }))
  return task
}

function touch(task, now) {
  task.taskRevision = safeInteger(Number(task.taskRevision || 0), 'taskRevision') + 1
  task.updatedAt = now
  task.updatedAtMs = now
}

function clearLease(value) { value.leaseHash = ''; value.leaseExpiresAt = 0 }

function expireRunningStep(value, now) {
  if (!value || value.status !== 'running' || Number(value.leaseExpiresAt || 0) > now) return false
  clearLease(value)
  if (Number(value.attempts || value.attempt || 0) >= MAX_ATTEMPTS) {
    value.status = 'failed'
    value.lastFailureCode = 'AI_STEP_TIMEOUT'
  } else value.status = 'pending'
  return true
}

function transitionTerminal(rawTask, status, now, extra = {}) {
  const task = clone(rawTask)
  const nextStatus = canonicalStatus(status)
  if (!TERMINAL_STATUSES.has(nextStatus)) throw taskError('INVALID_TASK_STATUS', '任务终态无效')
  if (terminal(task.status)) return task
  if (!ACTIVE_STATUSES.has(canonicalStatus(task.status))) throw taskError('INVALID_TASK_STATUS', '任务状态无效')
  if (nextStatus === 'succeeded' && (!task.finalize || task.finalize.status !== 'completed')) {
    throw taskError('TASK_NOT_FINALIZED', '任务尚未完成最终校验')
  }
  task.status = nextStatus
  task.phase = 'terminal'
  task.terminalAtMs = now
  task.completedAtMs = nextStatus === 'succeeded' ? now : 0
  task.failedAtMs = nextStatus === 'failed' ? now : 0
  task.cancelledAtMs = nextStatus === 'cancelled' ? now : 0
  task.expiredAtMs = nextStatus === 'expired' ? now : 0
  task.conflictedAtMs = nextStatus === 'conflict' ? now : 0
  task.resultStateRevision = Number.isSafeInteger(extra.resultStateRevision)
    ? extra.resultStateRevision
    : Number.isSafeInteger(extra.stateRevision) ? extra.stateRevision : task.resultStateRevision
  const fallback = nextStatus === 'expired' ? 'AI_TASK_EXPIRED'
    : nextStatus === 'conflict' ? 'STATE_REVISION_CONFLICT'
      : nextStatus === 'cancelled' ? 'AI_TASK_CANCELLED' : `AI_TASK_${nextStatus.toUpperCase()}`
  const errorCode = nextStatus === 'succeeded' ? '' : safeErrorCode(extra.errorCode || extra.failureCode, fallback)
  task.errorCode = errorCode
  task.failureCode = errorCode
  touch(task, now)
  return task
}

function finishTask(task, status, now, extra = {}) { return transitionTerminal(task, status, safeTime(now, 'now'), extra) }

function expireTask(rawTask, now) {
  const instant = safeTime(now, 'now')
  if (terminal(rawTask.status) || Number(rawTask.expiresAt || 0) > instant) return clone(rawTask)
  return transitionTerminal(rawTask, 'expired', instant, { errorCode: 'AI_TASK_EXPIRED' })
}

function cancelTask(rawTask, owner, expectedTaskRevision, now) {
  assertTaskOwner(rawTask, owner)
  const revision = safeInteger(expectedTaskRevision, 'expectedTaskRevision')
  if (Number(rawTask.taskRevision || 0) !== revision) throw taskError('TASK_REVISION_CONFLICT', '任务状态已变化，请刷新后重试')
  if (terminal(rawTask.status)) return clone(rawTask)
  return transitionTerminal(rawTask, 'cancelled', safeTime(now, 'now'), { errorCode: 'AI_TASK_CANCELLED' })
}

function claimStep(task, value, kind, index, token, now) {
  const cleanToken = validateLeaseToken(token)
  value.status = 'running'
  value.attempt = Number(value.attempts || value.attempt || 0) + 1
  value.attempts = value.attempt
  value.leaseHash = tokenHash(cleanToken)
  value.leaseExpiresAt = Math.min(now + LEASE_MS, Number(task.expiresAt || now + LEASE_MS))
  value.nextAttemptAt = 0
  const claim = {
    taskId: task._id, kind, index, attempt: value.attempt,
    inputHash: value.inputHash, outlineHash: value.outlineHash || '', leaseToken: cleanToken,
  }
  touch(task, now)
  claim.taskRevision = task.taskRevision
  return claim
}

function markFailed(task, code, now) { return transitionTerminal(task, 'failed', now, { errorCode: safeErrorCode(code) }) }

function claimNext(rawTask, token, now) {
  const instant = safeTime(now, 'now')
  let task = clone(rawTask)
  if (terminal(task.status)) return { task, claim: null }
  if (!hasPlanStateFingerprint(task)) {
    return {
      task: transitionTerminal(task, 'conflict', instant, { errorCode: 'STATE_REVISION_CONFLICT' }),
      claim: null,
    }
  }
  if (Number(task.expiresAt || 0) <= instant) return { task: expireTask(task, instant), claim: null }
  let leaseExpired = expireRunningStep(task.outline, instant)
  task.chunks.forEach((chunk) => { leaseExpired = expireRunningStep(chunk, instant) || leaseExpired })
  leaseExpired = expireRunningStep(task.finalize, instant) || leaseExpired
  const exhausted = [task.outline, ...task.chunks, task.finalize].find((item) => item.status === 'failed')
  if (exhausted) return { task: markFailed(task, exhausted.lastFailureCode, instant), claim: null }
  if (task.outline.status !== 'completed') {
    task.phase = 'outline'; task.status = 'running'
    if (task.outline.status === 'pending') return { task, claim: claimStep(task, task.outline, 'outline', -1, token, instant) }
    if (leaseExpired) touch(task, instant)
    return { task, claim: null }
  }
  const incomplete = task.chunks.filter((chunk) => chunk.status !== 'completed')
  if (incomplete.length) {
    task.phase = 'details'; task.status = 'running'
    const next = incomplete.slice().sort((left, right) => left.index - right.index)[0]
    if (next.status === 'pending' && Number(next.nextAttemptAt || 0) <= instant) {
      return { task, claim: claimStep(task, next, 'detail', next.index, token, instant) }
    }
    if (leaseExpired) touch(task, instant)
    return { task, claim: null }
  }
  task.phase = 'finalizing'; task.status = 'finalizing'
  task.finalize.outlineHash = task.outlineHash
  task.finalize.inputHash = finalizeInputHash(task)
  if (task.finalize.status === 'pending' && Number(task.finalize.nextAttemptAt || 0) <= instant) {
    return { task, claim: claimStep(task, task.finalize, 'finalize', -1, token, instant) }
  }
  if (leaseExpired) touch(task, instant)
  return { task, claim: null }
}

function claimedStep(task, claim) {
  if (!claim || typeof claim !== 'object') return null
  if (claim.taskId && task._id && claim.taskId !== task._id) return null
  if (claim.kind === 'outline' && claim.index === -1) return task.outline
  if (claim.kind === 'finalize' && claim.index === -1) return task.finalize
  if (claim.kind !== 'detail' || !Number.isSafeInteger(claim.index)) return null
  return task.chunks.find((chunk) => chunk.index === claim.index) || null
}

function verifyLease(task, claim, token, now) {
  let cleanToken
  try { cleanToken = validateLeaseToken(token) } catch (_) { return false }
  if (!task || terminal(task.status) || Number(task.expiresAt || 0) <= now) return false
  const value = claimedStep(task, claim)
  return Boolean(value && value.status === 'running' && value.leaseHash === tokenHash(cleanToken) &&
    Number(value.leaseExpiresAt || 0) > now && Number(claim.attempt) === Number(value.attempts || value.attempt || 0) &&
    claim.inputHash === value.inputHash && (claim.outlineHash || '') === (value.outlineHash || ''))
}

function completionHash(claim, token, contentHash) {
  return digestParts('meal-ai-completion-v1', tokenHash(token), claim.attempt, claim.inputHash, claim.outlineHash || '', contentHash)
}

function completeClaim(rawTask, claim, token, result, now, options = {}) {
  const instant = safeTime(now, 'now')
  let task = clone(rawTask)
  if (terminal(task.status)) return { task, accepted: false, reason: 'TASK_TERMINAL' }
  if (Number(task.expiresAt || 0) <= instant) return { task: expireTask(task, instant), accepted: false, reason: 'TASK_EXPIRED' }
  const value = claimedStep(task, claim)
  const contentHash = resultHash(result)
  let cleanToken
  try { cleanToken = validateLeaseToken(token) } catch (_) { return { task, accepted: false, reason: 'STALE_LEASE' } }
  const expectedCompletionHash = completionHash(claim, cleanToken, contentHash)
  if (value && value.status === 'completed' && value.completionHash === expectedCompletionHash) {
    return { task, accepted: true, idempotent: true }
  }
  if (!verifyLease(task, claim, cleanToken, instant)) return { task, accepted: false, reason: 'STALE_LEASE' }
  if (claim.kind === 'outline') {
    const outlineHash = options.outlineHash ? normalizeHash(options.outlineHash, 'outlineHash') : contentHash
    if (options.outlineHash && outlineHash !== contentHash) return { task, accepted: false, reason: 'RESULT_HASH_MISMATCH' }
    task.outlineHash = outlineHash
    task.chunks.forEach((chunk) => { chunk.outlineHash = outlineHash; chunk.inputHash = chunkInputHash(task, chunk, outlineHash) })
  } else if ((claim.outlineHash || '') !== (task.outlineHash || '')) return { task, accepted: false, reason: 'OUTLINE_CHANGED' }
  value.status = 'completed'
  value.result = result === undefined ? null : clone(result)
  value.resultHash = contentHash
  value.completionHash = expectedCompletionHash
  value.completedAttempt = value.attempt
  clearLease(value)
  value.lastFailureCode = ''; value.nextAttemptAt = 0
  if (claim.kind === 'outline') { task.phase = 'details'; task.status = 'running' }
  else if (claim.kind === 'detail' && task.chunks.every((chunk) => chunk.status === 'completed')) {
    task.phase = 'finalizing'; task.status = 'finalizing'
    task.finalize.outlineHash = task.outlineHash; task.finalize.inputHash = finalizeInputHash(task)
  } else if (claim.kind === 'finalize') { task.phase = 'finalizing'; task.status = 'finalizing' }
  touch(task, instant)
  return { task, accepted: true, idempotent: false }
}

function failClaim(rawTask, claim, token, code, now, options = {}) {
  const instant = safeTime(now, 'now')
  let task = clone(rawTask)
  if (terminal(task.status)) return { task, accepted: false, reason: 'TASK_TERMINAL' }
  if (Number(task.expiresAt || 0) <= instant) return { task: expireTask(task, instant), accepted: false, reason: 'TASK_EXPIRED' }
  if (!verifyLease(task, claim, token, instant)) return { task, accepted: false, reason: 'STALE_LEASE' }
  const value = claimedStep(task, claim)
  clearLease(value)
  value.lastFailureCode = safeErrorCode(code)
  value.nextAttemptAt = options.retryAt === undefined ? instant : safeTime(options.retryAt, 'retryAt')
  if (options.retryable === false || Number(value.attempts || value.attempt || 0) >= MAX_ATTEMPTS) {
    value.status = 'failed'; task = markFailed(task, value.lastFailureCode, instant)
  } else { value.status = 'pending'; touch(task, instant) }
  return { task, accepted: true }
}

function progressCounts(task) {
  if (Number.isSafeInteger(task.totalSteps) && Number.isSafeInteger(task.completedSteps)) {
    return { totalSteps: task.totalSteps, completedSteps: task.completedSteps }
  }
  const chunks = Array.isArray(task.chunks) ? task.chunks : []
  const totalSteps = chunks.length + 2
  const completedSteps = (task.outline && task.outline.status === 'completed' ? 1 : 0) +
    chunks.filter((chunk) => chunk.status === 'completed').length +
    (task.finalize && task.finalize.status === 'completed' ? 1 : 0)
  return { totalSteps, completedSteps }
}

function publicTask(task, now = Date.now(), owner) {
  if (owner !== undefined) assertTaskOwner(task, owner)
  const instant = safeTime(now, 'now')
  const expired = !terminal(task.status) && Number(task.expiresAt || 0) <= instant
  const status = expired ? 'expired' : canonicalStatus(task.status)
  const { totalSteps, completedSteps } = progressCounts(task)
  const errorCode = expired ? 'AI_TASK_EXPIRED'
    : terminal(status) && status !== 'succeeded'
      ? safeErrorCode(task.errorCode || task.failureCode, status === 'conflict' ? 'STATE_REVISION_CONFLICT' : `AI_TASK_${status.toUpperCase()}`)
      : ''
  return {
    taskId: typeof task._id === 'string' ? task._id : '', status,
    phase: terminal(status) ? 'terminal' : task.phase,
    taskRevision: Number(task.taskRevision || 0), completedSteps, totalSteps,
    progressPercent: status === 'succeeded' ? 100 : Math.min(99, Math.round((completedSteps / Math.max(1, totalSteps)) * 100)),
    errorCode, failureCode: errorCode, expiresAt: Number(task.expiresAt || 0),
    resultStateRevision: Number.isSafeInteger(task.resultStateRevision) ? task.resultStateRevision : null,
  }
}

function compactTask(rawTask, status, now, extra = {}) {
  const terminalTask = terminal(rawTask.status) ? clone(rawTask) : transitionTerminal(rawTask, status, safeTime(now, 'now'), extra)
  const progress = publicTask(terminalTask, now)
  return {
    _id: terminalTask._id, taskSchemaVersion: terminalTask.taskSchemaVersion || TASK_SCHEMA_VERSION,
    owner: terminalTask.owner, status: progress.status, phase: 'terminal', taskRevision: terminalTask.taskRevision,
    ...(Number.isSafeInteger(terminalTask.generationEpoch) && terminalTask.generationEpoch >= 0
      ? { generationEpoch: terminalTask.generationEpoch }
      : {}),
    idempotencyHash: terminalTask.idempotencyHash, requestFingerprint: terminalTask.requestFingerprint,
    preferencesHash: terminalTask.preferencesHash, contractVersion: terminalTask.contractVersion,
    plannerVersion: terminalTask.plannerVersion, planId: terminalTask.planId,
    ...(hasPlanStateFingerprint(terminalTask) ? { planStateFingerprint: terminalTask.planStateFingerprint } : {}),
    baseStateRevision: terminalTask.baseStateRevision,
    stateRevision: Number.isSafeInteger(extra.stateRevision) ? extra.stateRevision : terminalTask.stateRevision,
    resultStateRevision: progress.resultStateRevision, totalSteps: progress.totalSteps, completedSteps: progress.completedSteps,
    createdAt: terminalTask.createdAt === undefined ? terminalTask.createdAtMs : terminalTask.createdAt,
    updatedAt: terminalTask.updatedAt === undefined ? terminalTask.updatedAtMs : terminalTask.updatedAt,
    createdAtMs: terminalTask.createdAtMs, updatedAtMs: terminalTask.updatedAtMs, expiresAt: terminalTask.expiresAt,
    terminalAtMs: terminalTask.terminalAtMs || now, completedAtMs: terminalTask.completedAtMs || 0,
    failedAtMs: terminalTask.failedAtMs || 0, cancelledAtMs: terminalTask.cancelledAtMs || 0,
    expiredAtMs: terminalTask.expiredAtMs || 0, conflictedAtMs: terminalTask.conflictedAtMs || 0,
    errorCode: progress.errorCode, failureCode: progress.errorCode,
  }
}

module.exports = {
  TASK_SCHEMA_VERSION, TASK_TTL_MS, LEASE_MS, MAX_ATTEMPTS, MAX_CONCURRENT_DETAILS,
  ACTIVE_STATUSES, TERMINAL_STATUSES, TERMINAL,
  generateTaskId, validateTaskId, generateLeaseToken, validateLeaseToken,
  validateClientRequestId, idempotencyFingerprint, requestFingerprint, sameIdempotentRequest,
  planStateFingerprint, hasPlanStateFingerprint,
  createTask, claimNext, completeClaim, failClaim, verifyLease,
  assertTaskOwner, cancelTask, expireTask, finishTask,
  publicTask, compactTask, terminal,
}
