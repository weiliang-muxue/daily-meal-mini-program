'use strict'

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const {
  CONTRACT_VERSION, PLANNER_VERSION, normalizeRequest, buildOutlineRequestBody, buildDetailRequestBody,
  extractModelText, parseModelJson, normalizeOutline, normalizeDetailChunk,
  assembleRawPlan, normalizePlan, preferencesHash,
} = require('./lib')
const { configuration, PROVIDER_CONTRACT_REVISION } = require('./provider-config')
const {
  MIN_RETRY_DELAY_MS, MAX_RETRY_AFTER_MS,
  privateAddress, resolvePublicEndpoint,
} = require('./transport')
const {
  PROFILE_FULL, normalizeProfile, allowedProfileTransition, requestResponsesCompatible,
} = require('./provider-compat')
const {
  generateTaskId, generateLeaseToken, validateTaskId, validateClientRequestId,
  idempotencyFingerprint, requestFingerprint, sameIdempotentRequest,
  createTask, claimNext, completeClaim, failClaim, assertTaskOwner,
  cancelTask, expireTask, finishTask, publicTask, compactTask, terminal,
  planStateFingerprint, hasPlanStateFingerprint, hasAiDataConsent,
  AI_DATA_CONSENT_VERSION, assertSupportedTaskSchema,
} = require('./task-core')
const {
  CURRENT_SCHEMA, migrate, sanitizeState, sanitizePlan, sanitizeGenerationPreferences,
} = require('./user-state')
const { notFound } = require('./not-found')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const members = db.collection('meal_members')

const TASK_COLLECTION = 'meal_ai_tasks'
const CONTROL_COLLECTION = 'meal_ai_controls'
const STORAGE_PROBE_DOCUMENT_ID = 'ai-storage-readiness-probe-v1'
const STORAGE_NOT_READY_MESSAGE = 'AI 存储服务尚未准备好，请稍后再试'
const PUBLIC_STAGE = Symbol('aiPlannerPublicStage')
const PUBLIC_STAGES = new Set([
  'PREFLIGHT', 'STORAGE_PROBE',
  'START_TRANSACTION_BEGIN', 'START_TRANSACTION_READ', 'START_TRANSACTION_VALIDATE',
  'START_TRANSACTION_WRITE', 'START_TRANSACTION_COMMIT',
  'STATUS_TRANSACTION_BEGIN', 'STATUS_TRANSACTION_READ', 'STATUS_TRANSACTION_VALIDATE',
  'STATUS_TRANSACTION_WRITE', 'STATUS_TRANSACTION_COMMIT',
  'STATUS_READ_MEMBER', 'STATUS_READ_TASK', 'STATUS_READ_STATE', 'STATUS_READ_CONTROL',
  'STATUS_STATE_MIGRATE', 'STATUS_PUBLIC_PROJECT',
  'ADVANCE_CLAIM', 'ADVANCE_EXECUTE', 'ADVANCE_SETTLE_SUCCESS', 'ADVANCE_SETTLE_FAILURE',
  'UNKNOWN',
])
const STORAGE_INFRASTRUCTURE_CODES = new Set([
  '-501002', '-501009', '-502001', '-502003', '-502005',
  'DATABASE_COLLECTION_NOT_EXIST', 'DATABASE_COLLECTION_NOT_EXISTS', 'DATABASE_COLLECTION_NOT_FOUND',
  'DATABASE_CONNECTION_ERROR', 'DATABASE_CONNECTION_FAILED', 'DATABASE_INTERNAL_ERROR',
  'DATABASE_NETWORK_ERROR', 'DATABASE_REQUEST_FAILED', 'DATABASE_SERVICE_UNAVAILABLE',
  'DATABASE_TIMEOUT', 'DATABASE_UNAVAILABLE',
  'DATABASE_TRANSACTION_ABORTED', 'DATABASE_TRANSACTION_CONFLICT', 'DATABASE_TRANSACTION_ERROR',
  'DATABASE_TRANSACTION_FAIL', 'DATABASE_TRANSACTION_FAILED', 'DATABASE_TRANSACTION_TIMEOUT',
  'TRANSACTION_ABORTED', 'TRANSACTION_CONFLICT', 'TRANSACTION_ERROR',
  'TRANSACTION_FAIL', 'TRANSACTION_FAILED', 'TRANSACTION_TIMEOUT',
])
// Detail chunks currently stay inside meal_ai_tasks. meal_ai_shards is reserved for a future
// document-size migration and is intentionally not read or written by this implementation.
const RATE_WINDOW_MS = 30 * 60 * 1000
const RATE_LIMIT = 5
const MIN_INTERVAL_MS = 10 * 1000
const MAX_IDEMPOTENCY_ENTRIES = 5
const CACHE_NAMESPACE_PATTERN = /^[a-f0-9]{32}$/
const RECENT_FAILURE_STATUSES = new Set(['failed', 'expired', 'conflict'])
const RECENT_FAILURE_CODES = new Set([
  'AI_STORAGE_NOT_READY', 'AI_CONFIGURATION_INVALID', 'AI_NETWORK_ERROR', 'AI_TIMEOUT',
  'AI_RATE_LIMITED', 'AI_UPSTREAM_REJECTED', 'AI_UPSTREAM_FAILED', 'AI_UPSTREAM_AUTH_REJECTED',
  'AI_UPSTREAM_FORBIDDEN',
  'AI_UPSTREAM_REQUEST_REJECTED', 'AI_UPSTREAM_RATE_LIMITED', 'AI_UPSTREAM_UNAVAILABLE',
  'AI_UPSTREAM_POLICY_REJECTED', 'AI_UPSTREAM_MODEL_UNAVAILABLE',
  'AI_UPSTREAM_PARAMETER_REJECTED', 'AI_UPSTREAM_ENDPOINT_NOT_FOUND',
  'AI_REQUEST_INVALID', 'AI_REQUEST_TOO_LARGE', 'AI_RESPONSE_ERROR', 'AI_RESPONSE_INVALID',
  'AI_RESPONSE_INCOMPLETE', 'AI_RESPONSE_NOT_COMPLETED', 'AI_RESPONSE_REFUSED',
  'AI_RESPONSE_TOO_LARGE', 'AI_OUTPUT_INVALID', 'AI_GENERATION_FAILED',
  'AI_PLANNER_VERSION_UNSUPPORTED', 'AI_CONTRACT_VERSION_UNSUPPORTED',
  'AI_TASK_SCHEMA_VERSION_UNSUPPORTED', 'AI_TASK_VERSION_INVALID',
  'AI_DATA_CONSENT_REQUIRED', 'AI_TASK_EXPIRED', 'AI_STEP_TIMEOUT',
  'STATE_REVISION_CONFLICT', 'STALE_DATA_GENERATION',
])
const RETRYABLE_FAILURE_CODES = new Set([
  'AI_NETWORK_ERROR', 'AI_TIMEOUT', 'AI_RATE_LIMITED',
  'AI_UPSTREAM_RATE_LIMITED', 'AI_UPSTREAM_UNAVAILABLE',
  'AI_RESPONSE_INCOMPLETE', 'AI_RESPONSE_NOT_COMPLETED', 'AI_OUTPUT_INVALID', 'AI_STEP_TIMEOUT',
])
const PROVIDER_CONFIGURATION_FAILURE_CODES = new Set([
  'AI_STORAGE_NOT_READY', 'AI_CONFIGURATION_INVALID',
  'AI_UPSTREAM_AUTH_REJECTED', 'AI_UPSTREAM_FORBIDDEN', 'AI_UPSTREAM_MODEL_UNAVAILABLE',
  'AI_UPSTREAM_ENDPOINT_NOT_FOUND', 'AI_UPSTREAM_PARAMETER_REJECTED',
  'AI_UPSTREAM_POLICY_REJECTED', 'AI_UPSTREAM_REQUEST_REJECTED',
  'AI_UPSTREAM_REJECTED', 'AI_UPSTREAM_FAILED',
  'AI_REQUEST_INVALID',
])
const RESPONSE_REVIEW_FAILURE_CODES = new Set([
  'AI_REQUEST_TOO_LARGE', 'AI_RESPONSE_ERROR', 'AI_RESPONSE_INVALID',
  'AI_RESPONSE_REFUSED', 'AI_RESPONSE_TOO_LARGE',
])
const DATA_CONFLICT_FAILURE_CODES = new Set([
  'STATE_REVISION_CONFLICT', 'STALE_DATA_GENERATION',
  'AI_PLANNER_VERSION_UNSUPPORTED', 'AI_CONTRACT_VERSION_UNSUPPORTED',
  'AI_TASK_SCHEMA_VERSION_UNSUPPORTED', 'AI_TASK_VERSION_INVALID', 'AI_DATA_CONSENT_REQUIRED',
])
const MIN_READABLE_STATE_SCHEMA = 7

function atomicFinalizedStateFields(value) {
  return {
    draftPlan: db.command.set(value.draftPlan),
    generationPreferences: db.command.set(value.generationPreferences),
    stateRevision: db.command.set(value.stateRevision),
  }
}

function plannerError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function sanitizePublicStage(value, fallback = 'UNKNOWN') {
  return PUBLIC_STAGES.has(value) ? value : fallback
}

function markPublicStage(error, stage) {
  const value = error && typeof error === 'object' ? error : plannerError('AI_GENERATION_FAILED', '')
  const safeStage = sanitizePublicStage(stage)
  try {
    Object.defineProperty(value, PUBLIC_STAGE, { value: safeStage, configurable: true })
    return value
  } catch (_) {
    const wrapped = plannerError(
      typeof value.code === 'string' ? value.code : 'AI_GENERATION_FAILED',
      '',
    )
    wrapped.errCode = value.errCode
    Object.defineProperty(wrapped, PUBLIC_STAGE, { value: safeStage })
    return wrapped
  }
}

function publicStage(error, fallback = 'UNKNOWN') {
  return sanitizePublicStage(error && error[PUBLIC_STAGE], sanitizePublicStage(fallback))
}

async function readReference(reference) {
  try { return (await reference.get()).data || null }
  catch (error) { if (notFound(error)) return null; throw error }
}

function errorCodes(error) {
  if (!error || typeof error !== 'object') return []
  return ['code', 'errCode']
    .map((field) => error[field])
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .map((value) => String(value).trim().toUpperCase())
    .filter(Boolean)
}

function isStorageInfrastructureError(error) {
  return errorCodes(error).some((code) => STORAGE_INFRASTRUCTURE_CODES.has(code))
}

async function assertStorageReady() {
  try {
    await db.runTransaction(async (transaction) => {
      await readReference(transaction.collection(TASK_COLLECTION).doc(STORAGE_PROBE_DOCUMENT_ID))
      await readReference(transaction.collection(CONTROL_COLLECTION).doc(STORAGE_PROBE_DOCUMENT_ID))
    })
  } catch (_) {
    throw markPublicStage(plannerError('AI_STORAGE_NOT_READY', STORAGE_NOT_READY_MESSAGE), 'STORAGE_PROBE')
  }
  return true
}

function assertActiveMember(member) {
  if (member && member.status === 'active') return member
  if (member && member.status === 'deleting') throw plannerError('ACCOUNT_DELETION_IN_PROGRESS', '账号数据正在删除')
  throw plannerError('MEMBERSHIP_REQUIRED', '需要有效邀请才能使用')
}

function assertExpectedCacheNamespace(member, expectedCacheNamespace) {
  assertActiveMember(member)
  if (!CACHE_NAMESPACE_PATTERN.test(expectedCacheNamespace || '')
    || member.cacheNamespace !== expectedCacheNamespace) {
    throw plannerError('STALE_DATA_GENERATION', '账号数据版本已变化，请刷新后重试')
  }
  return member
}

function assertStoredCacheNamespace(record, expectedCacheNamespace, label) {
  if (!record || record.cacheNamespace !== expectedCacheNamespace) {
    throw plannerError('STALE_DATA_GENERATION', `${label}属于旧账号数据版本，请重新发起`)
  }
  return record
}

async function requireMember(openid) {
  return assertActiveMember(await readReference(members.doc(openid)))
}

function taskData(task) {
  const { _id, ...data } = task
  return data
}

function validRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw plannerError('INVALID_STATE_REVISION', '请刷新数据后重试')
  return value
}

function currentStateForPlanning(rawState, options = {}) {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    throw plannerError('INVALID_STATE_REVISION', '请先刷新用户数据')
  }
  const sourceSchema = Number(rawState.schemaVersion || 0)
  if (sourceSchema < MIN_READABLE_STATE_SCHEMA) {
    throw plannerError('STATE_SCHEMA_UPGRADE_REQUIRED', '请先刷新并升级个人数据')
  }
  const state = migrate(rawState, options)
  return state
}

function validateAiDataConsent(raw, config) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw plannerError('AI_DATA_CONSENT_REQUIRED', '请先单独同意本次 AI 数据发送')
  }
  const keys = Object.keys(raw).sort()
  if (keys.length !== 3 || keys[0] !== 'accepted' || keys[1] !== 'providerRevision' || keys[2] !== 'version'
    || raw.accepted !== true || raw.version !== AI_DATA_CONSENT_VERSION
    || !config || raw.providerRevision !== config.providerRevision) {
    throw plannerError('AI_DATA_CONSENT_REQUIRED', '请重新确认本次 AI 数据发送范围')
  }
  return { aiDataConsentVersion: AI_DATA_CONSENT_VERSION, providerRevision: config.providerRevision }
}

function providerOptions(config) {
  return {
    apiStyle: config.apiStyle,
    model: config.model,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    reasoningEffort: config.reasoningEffort,
  }
}

function completedMealTitles(task, beforeChunkIndex) {
  if (!task || !Array.isArray(task.chunks)) return []
  return task.chunks
    .filter((chunk) => (
      chunk && chunk.status === 'completed' && Number.isInteger(chunk.index) &&
      chunk.index < beforeChunkIndex && chunk.result && Array.isArray(chunk.result.days)
    ))
    .sort((left, right) => left.index - right.index)
    .flatMap((chunk) => chunk.result.days.flatMap((day) => (
      day && Array.isArray(day.meals)
        ? day.meals.map((meal) => meal && meal.title).filter((title) => typeof title === 'string' && title)
        : []
    )))
}

function newPlanId() { return `ai_${crypto.randomBytes(18).toString('base64url')}` }

function canonicalPlanStateFingerprint(state) {
  const value = state && typeof state === 'object' ? state : {}
  return planStateFingerprint(
    value.activePlan ? sanitizePlan(value.activePlan, 'activePlan') : null,
    value.draftPlan ? sanitizePlan(value.draftPlan, 'draftPlan') : null,
  )
}

function conflictTask(task, now) {
  return compactTask(finishTask(task, 'conflict', now, { errorCode: 'STATE_REVISION_CONFLICT' }), 'conflict', now)
}

function consentFailureTask(task, now) {
  return compactTask(
    finishTask(task, 'failed', now, { errorCode: 'AI_DATA_CONSENT_REQUIRED' }),
    'failed', now,
  )
}

function unsupportedPlannerTask(task, now) {
  return compactTask(
    finishTask(task, 'failed', now, { errorCode: 'AI_PLANNER_VERSION_UNSUPPORTED' }),
    'failed', now,
  )
}

function plannerVersionNumber(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN
}

function assertTaskVersionReadable(task) {
  const taskSchema = assertSupportedTaskSchema(task)
  const contractVersion = task && task.contractVersion
  const plannerVersion = plannerVersionNumber(task && task.plannerVersion)
  if (!Number.isSafeInteger(contractVersion) || contractVersion < 1
    || !Number.isSafeInteger(plannerVersion) || plannerVersion < 1) {
    throw plannerError('AI_TASK_VERSION_INVALID', '生成任务版本无效')
  }
  if (contractVersion > CONTRACT_VERSION || plannerVersion > Number(PLANNER_VERSION)) {
    throw plannerError('AI_CONTRACT_VERSION_UNSUPPORTED', '生成任务来自更新版本，请升级后重试')
  }
  return { taskSchemaVersion: taskSchema.version, contractVersion, plannerVersion }
}

function hasCurrentPlannerContract(task) {
  const version = assertTaskVersionReadable(task)
  return version.plannerVersion === Number(PLANNER_VERSION) && version.contractVersion === CONTRACT_VERSION
}

function hasCurrentProviderConfiguration(task, config) {
  return Boolean(task && config
    && Number.isSafeInteger(config.providerRevision) && config.providerRevision > 0
    && typeof config.providerConfigVersion === 'string' && /^[a-f0-9]{64}$/.test(config.providerConfigVersion)
    && task.providerRevision === config.providerRevision
    && task.providerConfigVersion === config.providerConfigVersion)
}

function controlDefaults(openid) {
  return {
    owner: openid, cacheNamespace: '', activeTaskId: '', generationEpoch: 0,
    rateWindowStart: 0, rateCount: 0, lastRequestedAt: 0,
    idempotencyEntries: [], aiDataConsentVersion: 0, providerRevision: 0, aiDataConsentAt: 0, updatedAt: 0,
  }
}

function normalizeControl(raw, openid) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const entries = Array.isArray(source.idempotencyEntries) ? source.idempotencyEntries : []
  return {
    ...controlDefaults(openid), owner: openid,
    cacheNamespace: CACHE_NAMESPACE_PATTERN.test(source.cacheNamespace || '') ? source.cacheNamespace : '',
    activeTaskId: typeof source.activeTaskId === 'string' ? source.activeTaskId : '',
    generationEpoch: Number.isSafeInteger(source.generationEpoch) && source.generationEpoch >= 0 ? source.generationEpoch : 0,
    rateWindowStart: Number.isSafeInteger(source.rateWindowStart) ? source.rateWindowStart : 0,
    rateCount: Number.isSafeInteger(source.rateCount) && source.rateCount >= 0 ? source.rateCount : 0,
    lastRequestedAt: Number.isSafeInteger(source.lastRequestedAt) ? source.lastRequestedAt : 0,
    idempotencyEntries: entries.filter((entry) => (
      entry && typeof entry.idempotencyHash === 'string' && typeof entry.requestFingerprint === 'string' &&
      typeof entry.taskId === 'string'
    )).slice(0, MAX_IDEMPOTENCY_ENTRIES),
    aiDataConsentVersion: Number.isSafeInteger(source.aiDataConsentVersion) ? source.aiDataConsentVersion : 0,
    providerRevision: Number.isSafeInteger(source.providerRevision) && source.providerRevision > 0
      ? source.providerRevision : 0,
    aiDataConsentAt: Number.isSafeInteger(source.aiDataConsentAt) ? source.aiDataConsentAt : 0,
    updatedAt: Number.isSafeInteger(source.updatedAt) ? source.updatedAt : 0,
  }
}

function addIdempotencyEntry(control, task) {
  const entry = {
    idempotencyHash: task.idempotencyHash, requestFingerprint: task.requestFingerprint,
    taskId: task._id, createdAt: task.createdAt,
  }
  return [entry, ...control.idempotencyEntries.filter((item) => item.idempotencyHash !== entry.idempotencyHash)]
    .slice(0, MAX_IDEMPOTENCY_ENTRIES)
}

function enforceRateLimit(control, now) {
  if (control.lastRequestedAt && now - control.lastRequestedAt < MIN_INTERVAL_MS) {
    throw plannerError('AI_RATE_LIMITED', '请求太频繁，请稍等片刻再生成')
  }
  const sameWindow = control.rateWindowStart && now - control.rateWindowStart < RATE_WINDOW_MS
  const count = sameWindow ? control.rateCount : 0
  if (count >= RATE_LIMIT) throw plannerError('AI_RATE_LIMITED', '本时段生成次数已达上限，请稍后再试')
  return { rateWindowStart: sameWindow ? control.rateWindowStart : now, rateCount: count + 1, lastRequestedAt: now }
}

function publicProgress(task, now, openid) {
  assertTaskVersionReadable(task)
  return { ...publicTask(task, now, openid), nextPollAfterMs: 400 }
}

function resultFromState(task, state) {
  if (!hasPlanStateFingerprint(task) || task.status !== 'succeeded'
    || !state || !state.draftPlan || state.draftPlan.id !== task.planId) return null
  return {
    draftPlan: state.draftPlan, generationPreferences: state.generationPreferences,
    stateRevision: state.stateRevision, updatedAt: new Date().toISOString(),
  }
}

function failurePolicy(errorCode, status = 'failed') {
  const code = RECENT_FAILURE_CODES.has(errorCode) ? errorCode : 'AI_GENERATION_FAILED'
  if (RETRYABLE_FAILURE_CODES.has(code) || status === 'expired') {
    return { errorCode: code, retryable: true, category: status === 'expired' ? 'task_lifecycle' : 'transient' }
  }
  if (PROVIDER_CONFIGURATION_FAILURE_CODES.has(code)) {
    return { errorCode: code, retryable: false, category: 'provider_configuration' }
  }
  if (RESPONSE_REVIEW_FAILURE_CODES.has(code)) {
    return { errorCode: code, retryable: false, category: 'response_review' }
  }
  if (DATA_CONFLICT_FAILURE_CODES.has(code) || status === 'conflict') {
    return { errorCode: code, retryable: false, category: 'data_conflict' }
  }
  return { errorCode: code, retryable: false, category: 'unknown' }
}

function recentFailureProjection(task, now, openid) {
  const progress = publicProgress(task, now, openid)
  if (!RECENT_FAILURE_STATUSES.has(progress.status)) return null
  const policy = failurePolicy(progress.errorCode, progress.status)
  return {
    status: progress.status,
    phase: ['outline', 'details', 'validation', 'terminal'].includes(progress.phase) ? progress.phase : 'terminal',
    errorCode: policy.errorCode,
    progressPercent: Math.max(0, Math.min(100, Number(progress.progressPercent) || 0)),
    retryable: policy.retryable,
    category: policy.category,
  }
}

async function readRecentFailure(openid, expectedCacheNamespace) {
  const now = Date.now()
  return db.runTransaction(async (transaction) => {
    const member = await readReference(transaction.collection('meal_members').doc(openid))
    const rawControl = await readReference(transaction.collection(CONTROL_COLLECTION).doc(openid))
    assertExpectedCacheNamespace(member, expectedCacheNamespace)
    if (!rawControl || rawControl.owner !== openid) return { failure: null }
    const control = normalizeControl(rawControl, openid)
    assertStoredCacheNamespace(control, expectedCacheNamespace, '生成任务控制')
    if (control.activeTaskId || control.generationEpoch < 1) return { failure: null }

    let currentGenerationMatches = 0
    let currentTask = null
    for (const entry of control.idempotencyEntries.slice(0, MAX_IDEMPOTENCY_ENTRIES)) {
      try { validateTaskId(entry.taskId) } catch (_) { continue }
      const rawTask = await readReference(transaction.collection(TASK_COLLECTION).doc(entry.taskId))
      if (!rawTask || !Number.isSafeInteger(rawTask.generationEpoch)
        || rawTask.generationEpoch !== control.generationEpoch) continue
      currentGenerationMatches += 1
      if (currentGenerationMatches > 1) continue
      if (rawTask.owner !== openid || rawTask.cacheNamespace !== expectedCacheNamespace
        || rawTask.idempotencyHash !== entry.idempotencyHash
        || rawTask.requestFingerprint !== entry.requestFingerprint) continue
      const task = { ...rawTask, _id: entry.taskId }
      try { assertTaskVersionReadable(task) } catch (_) { continue }
      currentTask = task
    }
    if (currentGenerationMatches !== 1 || !currentTask) return { failure: null }
    try { return { failure: recentFailureProjection(currentTask, now, openid) } }
    catch (_) { return { failure: null } }
  })
}

function terminalControl(control, task, now) {
  if (control.activeTaskId !== task._id || Number(control.generationEpoch) !== Number(task.generationEpoch)) return control
  return { ...control, activeTaskId: '', updatedAt: now }
}

function clearActiveTaskPointer(control, taskId, now) {
  if (control.activeTaskId !== taskId) return control
  return { ...control, activeTaskId: '', updatedAt: now }
}

async function startTask(openid, rawPreferences, expectedStateRevision, clientRequestId, rawConsent, expectedCacheNamespace, config) {
  const { aiDataConsentVersion, providerRevision } = validateAiDataConsent(rawConsent, config)
  const input = normalizeRequest(rawPreferences)
  const baseStateRevision = validRevision(expectedStateRevision)
  validateClientRequestId(clientRequestId)
  const now = Date.now()
  const prefHash = preferencesHash(input)
  const idemHash = idempotencyFingerprint(openid, clientRequestId)
  const reqFingerprint = requestFingerprint({
    preferencesHash: prefHash, baseStateRevision,
    contractVersion: CONTRACT_VERSION, plannerVersion: PLANNER_VERSION, aiDataConsentVersion,
    providerRevision, providerConfigVersion: config.providerConfigVersion,
  })
  const taskId = generateTaskId()
  const planId = newPlanId()

  let startStage = 'START_TRANSACTION_BEGIN'
  try {
    return await db.runTransaction(async (transaction) => {
      startStage = 'START_TRANSACTION_READ'
    const memberRef = transaction.collection('meal_members').doc(openid)
    const stateRef = transaction.collection('meal_user_states').doc(openid)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const member = await readReference(memberRef)
    const rawState = await readReference(stateRef)
    const rawControl = await readReference(controlRef)
    startStage = 'START_TRANSACTION_VALIDATE'
    assertExpectedCacheNamespace(member, expectedCacheNamespace)
    if (!rawState) throw plannerError('INVALID_STATE_REVISION', '请先刷新用户数据')
    const state = currentStateForPlanning(rawState, { preserveUnknown: false })
    if (state.stateRevision !== baseStateRevision) {
      throw plannerError('STATE_REVISION_CONFLICT', '数据已在另一台设备更新，请刷新后重试')
    }
    let control = normalizeControl(rawControl, openid)
    if (rawControl && control.cacheNamespace && control.cacheNamespace !== expectedCacheNamespace) {
      throw plannerError('STALE_DATA_GENERATION', '生成任务属于旧账号数据版本，请重新发起')
    }
    const replayEntry = control.idempotencyEntries.find((entry) => entry.idempotencyHash === idemHash)
    if (replayEntry) {
      const replayRef = transaction.collection(TASK_COLLECTION).doc(replayEntry.taskId)
      const replayRaw = await readReference(replayRef)
      if (!replayRaw) throw plannerError('IDEMPOTENCY_CONFLICT', '原生成任务已不可恢复，请重新选择')
      let replayTask = { ...replayRaw, _id: replayEntry.taskId }
      assertStoredCacheNamespace(replayTask, expectedCacheNamespace, '生成任务')
      assertTaskVersionReadable(replayTask)
      if (replayTask.idempotencyHash !== idemHash) {
        throw plannerError('IDEMPOTENCY_CONFLICT', '同一请求编号不能用于不同生成条件')
      }
      if (!terminal(replayTask.status) && !hasAiDataConsent(replayTask)) {
        replayTask = consentFailureTask(replayTask, now)
        control = terminalControl(control, replayTask, now)
        startStage = 'START_TRANSACTION_WRITE'
        await replayRef.set({ data: taskData(replayTask) })
        await controlRef.set({ data: control })
      } else if (!terminal(replayTask.status) && !hasPlanStateFingerprint(replayTask)) {
        replayTask = conflictTask(replayTask, now)
        control = terminalControl(control, replayTask, now)
        startStage = 'START_TRANSACTION_WRITE'
        await replayRef.set({ data: taskData(replayTask) })
        await controlRef.set({ data: control })
      } else if (!terminal(replayTask.status) && !hasCurrentPlannerContract(replayTask)) {
        replayTask = unsupportedPlannerTask(replayTask, now)
        control = terminalControl(control, replayTask, now)
        startStage = 'START_TRANSACTION_WRITE'
        await replayRef.set({ data: taskData(replayTask) })
        await controlRef.set({ data: control })
      } else if (!terminal(replayTask.status) && !hasCurrentProviderConfiguration(replayTask, config)) {
        replayTask = consentFailureTask(replayTask, now)
        control = terminalControl(control, replayTask, now)
        startStage = 'START_TRANSACTION_WRITE'
        await replayRef.set({ data: taskData(replayTask) })
        await controlRef.set({ data: control })
      } else {
        const match = sameIdempotentRequest(replayTask, {
          idempotencyHash: idemHash, requestFingerprint: reqFingerprint,
        })
        if (match !== 'replay') throw plannerError('IDEMPOTENCY_CONFLICT', '同一请求编号不能用于不同生成条件')
      }
      startStage = 'START_TRANSACTION_COMMIT'
      return { task: publicProgress(replayTask, now, openid), result: resultFromState(replayTask, state) }
    }

    if (control.activeTaskId) {
      const activeRef = transaction.collection(TASK_COLLECTION).doc(control.activeTaskId)
      const rawActive = await readReference(activeRef)
      if (rawActive) {
        let activeTask = { ...rawActive, _id: control.activeTaskId }
        assertTaskOwner(activeTask, openid)
        assertTaskVersionReadable(activeTask)
        if (activeTask.cacheNamespace !== expectedCacheNamespace) {
          activeTask = compactTask(
            finishTask(activeTask, 'conflict', now, { errorCode: 'STALE_DATA_GENERATION' }),
            'conflict', now,
          )
        }
        if (!terminal(activeTask.status) && !hasAiDataConsent(activeTask)) {
          activeTask = consentFailureTask(activeTask, now)
        } else if (!terminal(activeTask.status) && !hasPlanStateFingerprint(activeTask)) {
          activeTask = conflictTask(activeTask, now)
        } else if (!terminal(activeTask.status) && !hasCurrentPlannerContract(activeTask)) {
          activeTask = unsupportedPlannerTask(activeTask, now)
        } else if (!terminal(activeTask.status) && !hasCurrentProviderConfiguration(activeTask, config)) {
          activeTask = consentFailureTask(activeTask, now)
        }
        const active = Number(activeTask.expiresAt || 0) <= now ? expireTask(activeTask, now) : activeTask
        if (!terminal(active.status)) throw plannerError('ACTIVE_TASK_EXISTS', '已有生成任务正在进行，请先继续或取消')
        const stored = compactTask(active, active.status, now)
        startStage = 'START_TRANSACTION_WRITE'
        await activeRef.set({ data: taskData(stored) })
      }
      control = { ...control, activeTaskId: '' }
      startStage = 'START_TRANSACTION_VALIDATE'
    }

    const rate = enforceRateLimit(control, now)
    const generationEpoch = control.generationEpoch + 1
    const task = createTask({
      taskId, owner: openid, input, preferencesHash: prefHash,
      baseStateRevision, stateRevision: baseStateRevision, planId,
      activePlan: state.activePlan, draftPlan: state.draftPlan,
      generatedAt: new Date(now).toISOString(), clientRequestId,
      idempotencyHash: idemHash, requestFingerprint: reqFingerprint,
      contractVersion: CONTRACT_VERSION, plannerVersion: PLANNER_VERSION,
      aiDataConsentVersion,
      providerRevision, providerConfigVersion: config.providerConfigVersion,
      now,
    })
    task.generationEpoch = generationEpoch
    task.cacheNamespace = expectedCacheNamespace
    task.providerRequestProfile = PROFILE_FULL
    const nextControl = {
      ...control, cacheNamespace: expectedCacheNamespace, ...rate, activeTaskId: taskId, generationEpoch,
      idempotencyEntries: addIdempotencyEntry(control, task),
      aiDataConsentVersion, providerRevision, aiDataConsentAt: now, updatedAt: now,
    }
    startStage = 'START_TRANSACTION_WRITE'
    await transaction.collection(TASK_COLLECTION).doc(taskId).set({ data: taskData(task) })
    await controlRef.set({ data: nextControl })
    startStage = 'START_TRANSACTION_COMMIT'
    return { task: publicProgress(task, now, openid), result: null }
    })
  } catch (error) {
    throw markPublicStage(error, startStage)
  }
}

async function readTaskStatus(openid, taskId, expectedCacheNamespace, config) {
  const id = validateTaskId(taskId)
  const now = Date.now()
  let statusStage = 'STATUS_TRANSACTION_BEGIN'
  try {
    return await db.runTransaction(async (transaction) => {
      const memberRef = transaction.collection('meal_members').doc(openid)
      const taskRef = transaction.collection(TASK_COLLECTION).doc(id)
      const stateRef = transaction.collection('meal_user_states').doc(openid)
      const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
      statusStage = 'STATUS_READ_MEMBER'
      const member = await readReference(memberRef)
      statusStage = 'STATUS_READ_TASK'
      const rawTask = await readReference(taskRef)
      statusStage = 'STATUS_READ_CONTROL'
      const rawControl = await readReference(controlRef)
      statusStage = 'STATUS_TRANSACTION_VALIDATE'
      assertExpectedCacheNamespace(member, expectedCacheNamespace)
      assertTaskOwner(rawTask && { ...rawTask, _id: id }, openid)
      let task = { ...rawTask, _id: id }
      let control = normalizeControl(rawControl, openid)
      assertStoredCacheNamespace(task, expectedCacheNamespace, '生成任务')
      assertStoredCacheNamespace(control, expectedCacheNamespace, '生成任务控制')
      assertTaskVersionReadable(task)
      let rawState = null
      if (task.status === 'succeeded') {
        statusStage = 'STATUS_READ_STATE'
        rawState = await readReference(stateRef)
        statusStage = 'STATUS_TRANSACTION_VALIDATE'
      }
      if (!terminal(task.status) && !hasAiDataConsent(task)) {
        task = consentFailureTask(task, now)
        control = terminalControl(control, task, now)
        statusStage = 'STATUS_TRANSACTION_WRITE'
        await taskRef.set({ data: taskData(task) })
        await controlRef.set({ data: control })
      } else if (!terminal(task.status) && !hasPlanStateFingerprint(task)) {
        task = conflictTask(task, now)
        control = terminalControl(control, task, now)
        statusStage = 'STATUS_TRANSACTION_WRITE'
        await taskRef.set({ data: taskData(task) })
        await controlRef.set({ data: control })
      } else if (!terminal(task.status) && !hasCurrentPlannerContract(task)) {
        task = unsupportedPlannerTask(task, now)
        control = terminalControl(control, task, now)
        statusStage = 'STATUS_TRANSACTION_WRITE'
        await taskRef.set({ data: taskData(task) })
        await controlRef.set({ data: control })
      } else if (!terminal(task.status) && !hasCurrentProviderConfiguration(task, config)) {
        task = consentFailureTask(task, now)
        control = terminalControl(control, task, now)
        statusStage = 'STATUS_TRANSACTION_WRITE'
        await taskRef.set({ data: taskData(task) })
        await controlRef.set({ data: control })
      } else if (!terminal(task.status) && Number(task.expiresAt || 0) <= now) {
        task = compactTask(expireTask(task, now), 'expired', now)
        control = terminalControl(control, task, now)
        statusStage = 'STATUS_TRANSACTION_WRITE'
        await taskRef.set({ data: taskData(task) })
        await controlRef.set({ data: control })
      }
      statusStage = 'STATUS_STATE_MIGRATE'
      const state = rawState ? currentStateForPlanning(rawState, { preserveUnknown: false }) : null
      statusStage = 'STATUS_PUBLIC_PROJECT'
      const outcome = { task: publicProgress(task, now, openid), result: resultFromState(task, state) }
      statusStage = 'STATUS_TRANSACTION_COMMIT'
      return outcome
    })
  } catch (error) {
    throw markPublicStage(error, statusStage)
  }
}

async function readCurrentTask(openid, expectedCacheNamespace, config) {
  const now = Date.now()
  const outcome = await db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const member = await readReference(memberRef)
    const rawControl = await readReference(controlRef)
    assertExpectedCacheNamespace(member, expectedCacheNamespace)
    let control = normalizeControl(rawControl, openid)
    if (rawControl) assertStoredCacheNamespace(control, expectedCacheNamespace, '生成任务控制')
    const activeTaskId = control.activeTaskId
    if (!activeTaskId) return { notFound: true }

    try { validateTaskId(activeTaskId) } catch (_) {
      control = clearActiveTaskPointer(control, activeTaskId, now)
      await controlRef.set({ data: control })
      return { notFound: true }
    }

    const taskRef = transaction.collection(TASK_COLLECTION).doc(activeTaskId)
    const stateRef = transaction.collection('meal_user_states').doc(openid)
    const rawTask = await readReference(taskRef)
    const rawState = await readReference(stateRef)
    if (!rawTask || rawTask.owner !== openid) {
      control = clearActiveTaskPointer(control, activeTaskId, now)
      await controlRef.set({ data: control })
      return { notFound: true }
    }

    let task = { ...rawTask, _id: activeTaskId }
    assertStoredCacheNamespace(task, expectedCacheNamespace, '生成任务')
    assertTaskVersionReadable(task)
    const state = rawState ? currentStateForPlanning(rawState, { preserveUnknown: false }) : null
    const epochMatches = Number(control.generationEpoch) === Number(task.generationEpoch)
    if (!terminal(task.status) && !hasAiDataConsent(task)) {
      task = consentFailureTask(task, now)
    } else if (!terminal(task.status) && !hasPlanStateFingerprint(task)) {
      task = conflictTask(task, now)
    } else if (!terminal(task.status) && !hasCurrentPlannerContract(task)) {
      task = unsupportedPlannerTask(task, now)
    } else if (!terminal(task.status) && !hasCurrentProviderConfiguration(task, config)) {
      task = consentFailureTask(task, now)
    } else if (!terminal(task.status) && !epochMatches) {
      task = compactTask(finishTask(task, 'conflict', now, { errorCode: 'STATE_REVISION_CONFLICT' }), 'conflict', now)
    } else if (!terminal(task.status) && Number(task.expiresAt || 0) <= now) {
      task = compactTask(expireTask(task, now), 'expired', now)
    } else if (terminal(task.status)) {
      task = compactTask(task, task.status, now)
    }

    if (terminal(task.status)) {
      control = clearActiveTaskPointer(control, activeTaskId, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
    }
    return { value: { task: publicProgress(task, now, openid), result: resultFromState(task, state) } }
  })
  if (outcome.notFound) return null
  return outcome.value
}

async function claimWork(openid, taskId, expectedCacheNamespace, config) {
  const id = validateTaskId(taskId)
  const now = Date.now()
  const leaseToken = generateLeaseToken()
  return db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const taskRef = transaction.collection(TASK_COLLECTION).doc(id)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const member = await readReference(memberRef)
    const rawTask = await readReference(taskRef)
    const rawControl = await readReference(controlRef)
    assertExpectedCacheNamespace(member, expectedCacheNamespace)
    assertTaskOwner(rawTask && { ...rawTask, _id: id }, openid)
    const current = { ...rawTask, _id: id }
    let control = normalizeControl(rawControl, openid)
    assertStoredCacheNamespace(current, expectedCacheNamespace, '生成任务')
    assertStoredCacheNamespace(control, expectedCacheNamespace, '生成任务控制')
    assertTaskVersionReadable(current)
    if (terminal(current.status)) {
      const stored = compactTask(current, current.status, now)
      const nextControl = clearActiveTaskPointer(control, id, now)
      await taskRef.set({ data: taskData(stored) })
      await controlRef.set({ data: nextControl })
      return { task: stored, claim: null }
    }
    if (!hasAiDataConsent(current)) {
      const denied = consentFailureTask(current, now)
      const nextControl = terminalControl(control, denied, now)
      await taskRef.set({ data: taskData(denied) })
      await controlRef.set({ data: nextControl })
      return { task: denied, claim: null }
    }
    if (!hasPlanStateFingerprint(current)) {
      const conflicted = conflictTask(current, now)
      const nextControl = terminalControl(control, conflicted, now)
      await taskRef.set({ data: taskData(conflicted) })
      await controlRef.set({ data: nextControl })
      return { task: conflicted, claim: null }
    }
    if (!hasCurrentPlannerContract(current)) {
      const unsupported = unsupportedPlannerTask(current, now)
      control = terminalControl(control, unsupported, now)
      await taskRef.set({ data: taskData(unsupported) })
      await controlRef.set({ data: control })
      return { task: unsupported, claim: null }
    }
    if (!hasCurrentProviderConfiguration(current, config)) {
      const denied = consentFailureTask(current, now)
      control = terminalControl(control, denied, now)
      await taskRef.set({ data: taskData(denied) })
      await controlRef.set({ data: control })
      return { task: denied, claim: null }
    }
    if (control.activeTaskId !== id || Number(control.generationEpoch) !== Number(current.generationEpoch)) {
      const conflicted = compactTask(finishTask(current, 'conflict', now, { errorCode: 'STATE_REVISION_CONFLICT' }), 'conflict', now)
      const nextControl = clearActiveTaskPointer(control, id, now)
      await taskRef.set({ data: taskData(conflicted) })
      await controlRef.set({ data: nextControl })
      return { task: conflicted, claim: null }
    }
    const claimed = claimNext(current, leaseToken, now)
    let stored = claimed.task
    let nextControl = control
    if (terminal(stored.status)) {
      stored = compactTask(stored, stored.status, now)
      nextControl = terminalControl(control, stored, now)
      await controlRef.set({ data: nextControl })
    }
    await taskRef.set({ data: taskData(stored) })
    return { task: stored, claim: claimed.claim }
  })
}

async function executeClaim(task, claim, config, endpoint, deadlineAt) {
  if (!hasCurrentPlannerContract(task)) {
    throw plannerError('AI_PLANNER_VERSION_UNSUPPORTED', '生成任务版本不受支持')
  }
  if (!hasCurrentProviderConfiguration(task, config)) {
    throw plannerError('AI_DATA_CONSENT_REQUIRED', 'AI 服务配置已变化，请重新确认发送范围')
  }
  const initialProfile = normalizeProfile(task.providerRequestProfile)
  if (claim.kind === 'outline') {
    const body = buildOutlineRequestBody(task.input, providerOptions(config))
    const execution = await requestResponsesCompatible(config, body, endpoint, { deadlineAt, initialProfile })
    return {
      value: normalizeOutline(parseModelJson(extractModelText(execution.response, config.apiStyle)), task.input),
      providerRequestProfile: execution.profile,
    }
  }
  if (claim.kind === 'detail') {
    const chunk = task.chunks.find((item) => item.index === claim.index)
    if (!chunk) throw plannerError('AI_OUTPUT_INVALID', '生成分片不存在')
    const forbiddenMealTitles = completedMealTitles(task, claim.index)
    const context = { forbiddenMealTitles, retryAttempt: claim.attempt }
    const body = buildDetailRequestBody(task.input, task.outline.result, chunk, providerOptions(config), context)
    const execution = await requestResponsesCompatible(config, body, endpoint, { deadlineAt, initialProfile })
    const raw = parseModelJson(extractModelText(execution.response, config.apiStyle))
    return {
      value: { days: normalizeDetailChunk(raw, task.input, task.outline.result, chunk, context) },
      providerRequestProfile: execution.profile,
    }
  }
  if (claim.kind === 'finalize') {
    const rawPlan = assembleRawPlan(task.input, task.outline.result, task.chunks.map((chunk) => chunk.result))
    return {
      value: normalizePlan(rawPlan, task.input, { planId: task.planId, generatedAt: task.generatedAt }),
      providerRequestProfile: initialProfile,
    }
  }
  throw plannerError('AI_OUTPUT_INVALID', '生成任务步骤无效')
}

function failureCode(error) {
  if (error && typeof error.code === 'string' && /^AI_[A-Z0-9_]+$/.test(error.code)) return error.code
  return 'AI_OUTPUT_INVALID'
}

function retryPolicy(error) {
  const code = failureCode(error)
  const retryable = Boolean(error && error.retryable === true) ||
    (!error || error.retryable === undefined) && ['AI_OUTPUT_INVALID', 'AI_UPSTREAM_FAILED'].includes(code)
  const requestedDelay = Number(error && error.retryAfterMs)
  const retryAfterMs = retryable && Number.isFinite(requestedDelay)
    ? Math.max(MIN_RETRY_DELAY_MS, Math.min(MAX_RETRY_AFTER_MS, Math.ceil(requestedDelay)))
    : retryable ? MIN_RETRY_DELAY_MS : 0
  return { code, retryable, retryAfterMs }
}

async function settleFailure(
  openid, taskId, claim, leaseToken, failure, expectedCacheNamespace, runtimeConfig,
) {
  const now = Date.now()
  const policy = typeof failure === 'string'
    ? { code: failure, retryable: true, retryAfterMs: MIN_RETRY_DELAY_MS }
    : failure
  return db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const taskRef = transaction.collection(TASK_COLLECTION).doc(taskId)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const member = await readReference(memberRef)
    const rawTask = await readReference(taskRef)
    const rawControl = await readReference(controlRef)
    assertExpectedCacheNamespace(member, expectedCacheNamespace)
    assertTaskOwner(rawTask && { ...rawTask, _id: taskId }, openid)
    assertStoredCacheNamespace(rawTask, expectedCacheNamespace, '生成任务')
    assertStoredCacheNamespace(normalizeControl(rawControl, openid), expectedCacheNamespace, '生成任务控制')
    assertTaskVersionReadable(rawTask)
    if (!terminal(rawTask.status) && !hasAiDataConsent(rawTask)) {
      let task = consentFailureTask({ ...rawTask, _id: taskId }, now)
      let control = normalizeControl(rawControl, openid)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    if (!terminal(rawTask.status) && !hasPlanStateFingerprint(rawTask)) {
      let task = conflictTask({ ...rawTask, _id: taskId }, now)
      let control = normalizeControl(rawControl, openid)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    const currentConfig = runtimeConfig || configuration(process.env)
    if (!terminal(rawTask.status) && !hasCurrentPlannerContract(rawTask)) {
      let task = unsupportedPlannerTask({ ...rawTask, _id: taskId }, now)
      let control = normalizeControl(rawControl, openid)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    if (!terminal(rawTask.status) && !hasCurrentProviderConfiguration(rawTask, currentConfig)) {
      let task = consentFailureTask({ ...rawTask, _id: taskId }, now)
      let control = normalizeControl(rawControl, openid)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    const failed = failClaim({ ...rawTask, _id: taskId }, claim, leaseToken, policy.code, now, {
      retryable: policy.retryable,
      retryAt: now + policy.retryAfterMs,
    })
    let task = failed.task
    let control = normalizeControl(rawControl, openid)
    if (terminal(task.status)) {
      task = compactTask(task, task.status, now)
      control = terminalControl(control, task, now)
      await controlRef.set({ data: control })
    }
    if (failed.accepted || terminal(task.status)) await taskRef.set({ data: taskData(task) })
    return { task: publicProgress(task, now, openid), result: null }
  })
}

async function settleSuccess(
  openid, taskId, claim, leaseToken, result, expectedCacheNamespace, rawProviderRequestProfile,
  runtimeConfig,
) {
  const now = Date.now()
  return db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const taskRef = transaction.collection(TASK_COLLECTION).doc(taskId)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const stateRef = transaction.collection('meal_user_states').doc(openid)
    const member = await readReference(memberRef)
    const rawTask = await readReference(taskRef)
    const rawControl = await readReference(controlRef)
    assertExpectedCacheNamespace(member, expectedCacheNamespace)
    assertTaskOwner(rawTask && { ...rawTask, _id: taskId }, openid)
    assertStoredCacheNamespace(rawTask, expectedCacheNamespace, '生成任务')
    assertStoredCacheNamespace(normalizeControl(rawControl, openid), expectedCacheNamespace, '生成任务控制')
    assertTaskVersionReadable(rawTask)
    let task = { ...rawTask, _id: taskId }
    let control = normalizeControl(rawControl, openid)
    if (!terminal(task.status) && !hasAiDataConsent(task)) {
      task = consentFailureTask(task, now)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    if (!terminal(task.status) && !hasPlanStateFingerprint(task)) {
      task = conflictTask(task, now)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    const currentConfig = runtimeConfig || configuration(process.env)
    if (!terminal(task.status) && !hasCurrentPlannerContract(task)) {
      task = unsupportedPlannerTask(task, now)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    if (!terminal(task.status) && !hasCurrentProviderConfiguration(task, currentConfig)) {
      task = consentFailureTask(task, now)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    const currentProfile = normalizeProfile(task.providerRequestProfile)
    const providerRequestProfile = normalizeProfile(rawProviderRequestProfile, currentProfile)
    if (!allowedProfileTransition(currentProfile, providerRequestProfile)) {
      throw plannerError('AI_REQUEST_INVALID', 'AI 请求兼容配置不能回退到更强模式')
    }
    task.providerRequestProfile = providerRequestProfile
    const completed = completeClaim(task, claim, leaseToken, result, now)
    if (!completed.accepted) return { task: publicProgress(completed.task, now, openid), result: null }
    task = completed.task
    if (claim.kind !== 'finalize') {
      await taskRef.set({ data: taskData(task) })
      return { task: publicProgress(task, now, openid), result: null }
    }

    const rawState = await readReference(stateRef)
    if (!rawState || !hasPlanStateFingerprint(task)
      || control.activeTaskId !== taskId || Number(control.generationEpoch) !== Number(task.generationEpoch)) {
      task = compactTask(finishTask(task, 'conflict', now, { errorCode: 'STATE_REVISION_CONFLICT' }), 'conflict', now)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    const state = currentStateForPlanning(rawState, { preserveUnknownFrom: rawState })
    if (canonicalPlanStateFingerprint(state) !== task.planStateFingerprint) {
      task = conflictTask(task, now)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    if (task.preferencesHash !== preferencesHash(task.input)) throw plannerError('AI_OUTPUT_INVALID', '生成条件已变化')
    let latestPreferencesHash = ''
    try { latestPreferencesHash = preferencesHash(state.generationPreferences) } catch (_) {}
    if (latestPreferencesHash !== task.preferencesHash) {
      task = compactTask(finishTask(task, 'conflict', now, { errorCode: 'STATE_REVISION_CONFLICT' }), 'conflict', now)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    const draftPlan = sanitizePlan(result, 'draftPlan')
    const cleanGenerationPreferences = sanitizeGenerationPreferences(task.input)
    const stateRevision = state.stateRevision + 1
    const nextState = sanitizeState({
      ...state, draftPlan, generationPreferences: cleanGenerationPreferences, stateRevision,
    }, { preserveUnknownFrom: state })
    const generationPreferences = nextState.generationPreferences
    await stateRef.update({ data: {
      ...atomicFinalizedStateFields({ draftPlan, generationPreferences, stateRevision }),
      updatedAt: db.serverDate(),
    } })
    task = finishTask(task, 'succeeded', now, { resultStateRevision: stateRevision })
    task = compactTask(task, 'succeeded', now, { stateRevision })
    control = terminalControl(control, task, now)
    await taskRef.set({ data: taskData(task) })
    await controlRef.set({ data: control })
    return {
      task: publicProgress(task, now, openid),
      result: { draftPlan, generationPreferences, stateRevision, updatedAt: new Date(now).toISOString() },
    }
  })
}

async function advanceTask(openid, taskId, config, expectedCacheNamespace, operations = {}) {
  const claim = operations.claimWork || claimWork
  const execute = operations.executeClaim || executeClaim
  const settleSucceeded = operations.settleSuccess || settleSuccess
  const settleFailed = operations.settleFailure || settleFailure
  const upstreamDeadlineAt = Date.now() + config.timeoutMs
  let claimed
  try {
    claimed = await claim(openid, taskId, expectedCacheNamespace, config)
  } catch (error) {
    throw markPublicStage(error, 'ADVANCE_CLAIM')
  }
  assertTaskVersionReadable(claimed && claimed.task)
  if (!claimed.claim) return { task: publicProgress(claimed.task, Date.now(), openid), result: null }
  const leaseToken = claimed.claim.leaseToken
  let result
  let providerRequestProfile
  try {
    const endpoint = claimed.claim.kind === 'finalize'
      ? null
      : await resolvePublicEndpoint(config.url, { deadlineAt: upstreamDeadlineAt })
    const execution = await execute(claimed.task, claimed.claim, config, endpoint, upstreamDeadlineAt)
    if (execute === executeClaim) {
      result = execution.value
      providerRequestProfile = execution.providerRequestProfile
    } else result = execution
  } catch (error) {
    let policy
    try {
      policy = retryPolicy(error)
    } catch (policyError) {
      throw markPublicStage(policyError, 'ADVANCE_EXECUTE')
    }
    try {
      return await settleFailed(
        openid, claimed.task._id, claimed.claim, leaseToken, policy, expectedCacheNamespace, config,
      )
    } catch (settlementError) {
      throw markPublicStage(settlementError, 'ADVANCE_SETTLE_FAILURE')
    }
  }
  try {
    return await settleSucceeded(
      openid, claimed.task._id, claimed.claim, leaseToken, result, expectedCacheNamespace,
      providerRequestProfile, config,
    )
  } catch (error) {
    // This write may have committed remotely even when its response was lost.
    throw markPublicStage(error, 'ADVANCE_SETTLE_SUCCESS')
  }
}

async function cancelGeneration(openid, taskId, expectedTaskRevision, expectedCacheNamespace) {
  const id = validateTaskId(taskId)
  const now = Date.now()
  return db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const taskRef = transaction.collection(TASK_COLLECTION).doc(id)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const member = await readReference(memberRef)
    const rawTask = await readReference(taskRef)
    const rawControl = await readReference(controlRef)
    assertExpectedCacheNamespace(member, expectedCacheNamespace)
    assertTaskOwner(rawTask && { ...rawTask, _id: id }, openid)
    assertStoredCacheNamespace(rawTask, expectedCacheNamespace, '生成任务')
    assertStoredCacheNamespace(normalizeControl(rawControl, openid), expectedCacheNamespace, '生成任务控制')
    assertTaskVersionReadable(rawTask)
    if (!Number.isSafeInteger(expectedTaskRevision) || expectedTaskRevision < 0) {
      throw plannerError('INVALID_TASK_REVISION', '请刷新生成进度后再取消')
    }
    const revision = expectedTaskRevision
    let task = cancelTask({ ...rawTask, _id: id }, openid, revision, now)
    task = compactTask(task, task.status, now)
    let control = normalizeControl(rawControl, openid)
    control = terminalControl(control, task, now)
    await taskRef.set({ data: taskData(task) })
    await controlRef.set({ data: control })
    return { task: publicProgress(task, now, openid), result: null }
  })
}

const PUBLIC_FAILURE_MESSAGES = Object.freeze({
  MEMBERSHIP_REQUIRED: '需要有效邀请才能使用',
  ACCOUNT_DELETION_IN_PROGRESS: '账号数据正在删除',
  OWNER_REQUIRED: '只有管理员可以执行服务检查',
  AI_RATE_LIMITED: '生成请求过于频繁，请稍后再试',
  STATE_REVISION_CONFLICT: '数据已在另一台设备更新，请刷新后重试',
  INVALID_STATE_REVISION: '请刷新数据后重试',
  AI_CONFIGURATION_INVALID: 'AI 服务尚未配置，请联系管理员',
  STATE_SCHEMA_UNSUPPORTED: '数据版本较新，请更新小程序后重试',
  STATE_SCHEMA_UPGRADE_REQUIRED: '个人数据需要先升级，请刷新后重试',
  PLAN_TOO_LARGE: '计划内容过大，请减少生成条件后重试',
  STATE_TOO_LARGE: '个人数据空间已满，请整理后重试',
  TASK_NOT_FOUND: '任务不存在',
  INVALID_TASK_ID: '任务编号无效',
  INVALID_CLIENT_REQUEST_ID: '生成请求编号无效，请重新发起',
  IDEMPOTENCY_CONFLICT: '原生成请求已变化，请重新发起',
  TASK_REVISION_CONFLICT: '任务状态已变化，请刷新后重试',
  INVALID_TASK_REVISION: '请刷新生成进度后再取消',
  ACTIVE_TASK_EXISTS: '已有生成任务正在进行，请先继续或取消',
  AI_DATA_CONSENT_REQUIRED: '请重新确认本次 AI 数据发送范围',
  DIET_INTENT_REQUIRED: '请至少选择一个饮食目标或风格，或填写本次补充目标',
  EXERCISE_INTENT_REQUIRED: '请明确选择本周期是否安排运动',
  EXERCISE_PLAN_INVALID: '运动安排与所选方式不一致，请重新选择',
  EXERCISE_PLAN_REQUIRED: '逐日安排运动时请至少选择一天',
  STALE_DATA_GENERATION: '账号数据版本已变化，请刷新后重试',
  AI_CONTRACT_VERSION_UNSUPPORTED: '生成任务来自更新版本，请升级小程序后重试',
  AI_TASK_SCHEMA_VERSION_UNSUPPORTED: '生成任务来自更新版本，请升级小程序后重试',
  AI_TASK_VERSION_INVALID: '生成任务版本无效，请重新发起',
})

function publicError(error) {
  const code = error && error.code || 'AI_GENERATION_FAILED'
  if (code === 'AI_STORAGE_NOT_READY' || isStorageInfrastructureError(error)) {
    return { code: 'AI_STORAGE_NOT_READY', message: STORAGE_NOT_READY_MESSAGE }
  }
  if (PUBLIC_FAILURE_MESSAGES[code]) return { code, message: PUBLIC_FAILURE_MESSAGES[code] }
  return { code: 'AI_GENERATION_FAILED', message: 'AI 没能生成合格计划，请重试；当前计划未改变' }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, code: 'IDENTITY_REQUIRED', message: '无法识别微信身份', stage: 'PREFLIGHT' }
  try {
    const expectedCacheNamespace = event.expectedCacheNamespace
    assertExpectedCacheNamespace(await requireMember(OPENID), expectedCacheNamespace)
    const config = configuration(process.env)
    if (event.action === 'status' && !event.taskId) {
      await assertStorageReady()
      return {
        success: true,
        data: {
          configured: config.configured,
          storageReady: true,
          providerDisplayName: config.providerDisplayName,
          providerContractRevision: PROVIDER_CONTRACT_REVISION,
          providerRevision: config.providerRevision,
          providerConfigVersion: config.providerConfigVersion,
          contractVersion: CONTRACT_VERSION,
          plannerVersion: PLANNER_VERSION,
          aiDataConsentVersion: AI_DATA_CONSENT_VERSION,
          apiStyle: config.apiStyle,
        },
      }
    }
    if (event.action === 'status') return { success: true, data: await readTaskStatus(OPENID, event.taskId, expectedCacheNamespace, config) }
    if (event.action === 'current') return { success: true, data: await readCurrentTask(OPENID, expectedCacheNamespace, config) }
    if (event.action === 'recentFailure') return { success: true, data: await readRecentFailure(OPENID, expectedCacheNamespace) }
    if (event.action === 'cancel') {
      return { success: true, data: await cancelGeneration(OPENID, event.taskId, event.expectedTaskRevision, expectedCacheNamespace) }
    }
    if (event.action === 'start') {
      if (!config.configured) throw plannerError('AI_CONFIGURATION_INVALID', 'AI 服务尚未配置，请联系管理员')
      return {
        success: true,
        data: await startTask(
          OPENID, event.preferences, event.expectedStateRevision, event.clientRequestId, event.aiDataConsent,
          expectedCacheNamespace, config,
        ),
      }
    }
    if (event.action === 'advance') {
      if (!config.configured) throw plannerError('AI_CONFIGURATION_INVALID', 'AI 服务尚未配置，请联系管理员')
      return { success: true, data: await advanceTask(OPENID, event.taskId, config, expectedCacheNamespace) }
    }
    return { success: false, code: 'UNSUPPORTED_ACTION', message: '不支持的计划操作' }
  } catch (error) {
    const failure = publicError(error)
    const fallbackStage = event.action === 'start'
      ? 'PREFLIGHT'
      : event.action === 'status' && !event.taskId
        ? 'STORAGE_PROBE'
        : event.action === 'status' ? 'STATUS_TRANSACTION_BEGIN'
          : event.action === 'advance' ? 'ADVANCE_CLAIM'
            : 'UNKNOWN'
    const stage = publicStage(error, fallbackStage)
    console.error({ code: failure.code, stage })
    return { success: false, ...failure, stage }
  }
}

exports._test = {
  taskData, normalizeControl, addIdempotencyEntry, enforceRateLimit, validateAiDataConsent,
  atomicFinalizedStateFields,
  terminalControl, clearActiveTaskPointer,
  canonicalPlanStateFingerprint,
  STORAGE_PROBE_DOCUMENT_ID, assertStorageReady, isStorageInfrastructureError,
  sanitizePublicStage, markPublicStage, publicStage,
  startTask, readTaskStatus, readCurrentTask, claimWork, settleSuccess, settleFailure, advanceTask, cancelGeneration,
  readRecentFailure, recentFailureProjection, failurePolicy,
  privateAddress, publicError, failureCode, completedMealTitles, executeClaim,
  retryPolicy,
  providerOptions,
  hasCurrentProviderConfiguration,
  currentStateForPlanning,
}
