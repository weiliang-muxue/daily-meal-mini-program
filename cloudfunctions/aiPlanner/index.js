'use strict'

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const {
  CONTRACT_VERSION, PLANNER_VERSION, normalizeRequest, buildOutlineRequestBody, buildDetailRequestBody,
  extractModelText, parseModelJson, normalizeOutline, normalizeDetailChunk,
  assembleRawPlan, normalizePlan, preferencesHash,
} = require('./lib')
const { configuration } = require('./provider-config')
const {
  MIN_RETRY_DELAY_MS, MAX_RETRY_AFTER_MS,
  privateAddress, resolvePublicEndpoint, requestJson,
} = require('./transport')
const {
  generateTaskId, generateLeaseToken, validateTaskId, validateClientRequestId,
  idempotencyFingerprint, requestFingerprint, sameIdempotentRequest,
  createTask, claimNext, completeClaim, failClaim, assertTaskOwner,
  cancelTask, expireTask, finishTask, publicTask, compactTask, terminal,
  planStateFingerprint, hasPlanStateFingerprint,
} = require('./task-core')
const { migrate, sanitizeState, sanitizePlan, sanitizeGenerationPreferences } = require('./user-state')
const { notFound } = require('./not-found')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const members = db.collection('meal_members')

const TASK_COLLECTION = 'meal_ai_tasks'
const CONTROL_COLLECTION = 'meal_ai_controls'
// Detail chunks currently stay inside meal_ai_tasks. meal_ai_shards is reserved for a future
// document-size migration and is intentionally not read or written by this implementation.
const RATE_WINDOW_MS = 30 * 60 * 1000
const RATE_LIMIT = 5
const MIN_INTERVAL_MS = 10 * 1000
const MAX_IDEMPOTENCY_ENTRIES = 5

function plannerError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

async function readReference(reference) {
  try { return (await reference.get()).data || null }
  catch (error) { if (notFound(error)) return null; throw error }
}

function assertActiveMember(member) {
  if (member && member.status === 'active') return member
  if (member && member.status === 'deleting') throw plannerError('ACCOUNT_DELETION_IN_PROGRESS', '账号数据正在删除')
  throw plannerError('MEMBERSHIP_REQUIRED', '需要有效邀请才能使用')
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

function controlDefaults(openid) {
  return {
    owner: openid, activeTaskId: '', generationEpoch: 0,
    rateWindowStart: 0, rateCount: 0, lastRequestedAt: 0,
    idempotencyEntries: [], updatedAt: 0,
  }
}

function normalizeControl(raw, openid) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const entries = Array.isArray(source.idempotencyEntries) ? source.idempotencyEntries : []
  return {
    ...controlDefaults(openid), owner: openid,
    activeTaskId: typeof source.activeTaskId === 'string' ? source.activeTaskId : '',
    generationEpoch: Number.isSafeInteger(source.generationEpoch) && source.generationEpoch >= 0 ? source.generationEpoch : 0,
    rateWindowStart: Number.isSafeInteger(source.rateWindowStart) ? source.rateWindowStart : 0,
    rateCount: Number.isSafeInteger(source.rateCount) && source.rateCount >= 0 ? source.rateCount : 0,
    lastRequestedAt: Number.isSafeInteger(source.lastRequestedAt) ? source.lastRequestedAt : 0,
    idempotencyEntries: entries.filter((entry) => (
      entry && typeof entry.idempotencyHash === 'string' && typeof entry.requestFingerprint === 'string' &&
      typeof entry.taskId === 'string'
    )).slice(0, MAX_IDEMPOTENCY_ENTRIES),
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

function terminalControl(control, task, now) {
  if (control.activeTaskId !== task._id || Number(control.generationEpoch) !== Number(task.generationEpoch)) return control
  return { ...control, activeTaskId: '', updatedAt: now }
}

function clearActiveTaskPointer(control, taskId, now) {
  if (control.activeTaskId !== taskId) return control
  return { ...control, activeTaskId: '', updatedAt: now }
}

async function startTask(openid, rawPreferences, expectedStateRevision, clientRequestId) {
  const input = normalizeRequest(rawPreferences)
  const baseStateRevision = validRevision(expectedStateRevision)
  validateClientRequestId(clientRequestId)
  const now = Date.now()
  const prefHash = preferencesHash(input)
  const idemHash = idempotencyFingerprint(openid, clientRequestId)
  const reqFingerprint = requestFingerprint({
    preferencesHash: prefHash, baseStateRevision,
    contractVersion: CONTRACT_VERSION, plannerVersion: PLANNER_VERSION,
  })
  const taskId = generateTaskId()
  const planId = newPlanId()

  return db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const stateRef = transaction.collection('meal_user_states').doc(openid)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const [member, rawState, rawControl] = await Promise.all([
      readReference(memberRef), readReference(stateRef), readReference(controlRef),
    ])
    assertActiveMember(member)
    if (!rawState) throw plannerError('INVALID_STATE_REVISION', '请先刷新用户数据')
    const state = migrate(rawState, { preserveUnknown: false })
    if (state.stateRevision !== baseStateRevision) {
      throw plannerError('STATE_REVISION_CONFLICT', '数据已在另一台设备更新，请刷新后重试')
    }
    let control = normalizeControl(rawControl, openid)
    const replayEntry = control.idempotencyEntries.find((entry) => entry.idempotencyHash === idemHash)
    if (replayEntry) {
      const replayRef = transaction.collection(TASK_COLLECTION).doc(replayEntry.taskId)
      const replayRaw = await readReference(replayRef)
      if (!replayRaw) throw plannerError('IDEMPOTENCY_CONFLICT', '原生成任务已不可恢复，请重新选择')
      let replayTask = { ...replayRaw, _id: replayEntry.taskId }
      const match = sameIdempotentRequest(replayTask, { idempotencyHash: idemHash, requestFingerprint: reqFingerprint })
      if (match !== 'replay') throw plannerError('IDEMPOTENCY_CONFLICT', '同一请求编号不能用于不同生成条件')
      if (!terminal(replayTask.status) && !hasPlanStateFingerprint(replayTask)) {
        replayTask = conflictTask(replayTask, now)
        control = terminalControl(control, replayTask, now)
        await replayRef.set({ data: taskData(replayTask) })
        await controlRef.set({ data: control })
      }
      return { task: publicProgress(replayTask, now, openid), result: resultFromState(replayTask, state) }
    }

    if (control.activeTaskId) {
      const activeRef = transaction.collection(TASK_COLLECTION).doc(control.activeTaskId)
      const rawActive = await readReference(activeRef)
      if (rawActive) {
        let activeTask = { ...rawActive, _id: control.activeTaskId }
        assertTaskOwner(activeTask, openid)
        if (!terminal(activeTask.status) && !hasPlanStateFingerprint(activeTask)) {
          activeTask = conflictTask(activeTask, now)
        }
        const active = Number(activeTask.expiresAt || 0) <= now ? expireTask(activeTask, now) : activeTask
        if (!terminal(active.status)) throw plannerError('ACTIVE_TASK_EXISTS', '已有生成任务正在进行，请先继续或取消')
        const stored = compactTask(active, active.status, now)
        await activeRef.set({ data: taskData(stored) })
      }
      control = { ...control, activeTaskId: '' }
    }

    const rate = enforceRateLimit(control, now)
    const generationEpoch = control.generationEpoch + 1
    const task = createTask({
      taskId, owner: openid, input, preferencesHash: prefHash,
      baseStateRevision, stateRevision: baseStateRevision, planId,
      activePlan: state.activePlan, draftPlan: state.draftPlan,
      generatedAt: new Date(now).toISOString(), clientRequestId,
      idempotencyHash: idemHash, requestFingerprint: reqFingerprint,
      contractVersion: CONTRACT_VERSION, plannerVersion: PLANNER_VERSION, now,
    })
    task.generationEpoch = generationEpoch
    const nextControl = {
      ...control, ...rate, activeTaskId: taskId, generationEpoch,
      idempotencyEntries: addIdempotencyEntry(control, task), updatedAt: now,
    }
    await transaction.collection(TASK_COLLECTION).doc(taskId).set({ data: taskData(task) })
    await controlRef.set({ data: nextControl })
    return { task: publicProgress(task, now, openid), result: null }
  })
}

async function readTaskStatus(openid, taskId) {
  const id = validateTaskId(taskId)
  const now = Date.now()
  return db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const taskRef = transaction.collection(TASK_COLLECTION).doc(id)
    const stateRef = transaction.collection('meal_user_states').doc(openid)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const [member, rawTask, rawState, rawControl] = await Promise.all([
      readReference(memberRef), readReference(taskRef), readReference(stateRef), readReference(controlRef),
    ])
    assertActiveMember(member)
    assertTaskOwner(rawTask && { ...rawTask, _id: id }, openid)
    let task = { ...rawTask, _id: id }
    let control = normalizeControl(rawControl, openid)
    if (!terminal(task.status) && !hasPlanStateFingerprint(task)) {
      task = conflictTask(task, now)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
    } else if (!terminal(task.status) && Number(task.expiresAt || 0) <= now) {
      task = compactTask(expireTask(task, now), 'expired', now)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
    }
    const state = rawState ? migrate(rawState, { preserveUnknown: false }) : null
    return { task: publicProgress(task, now, openid), result: resultFromState(task, state) }
  })
}

async function readCurrentTask(openid) {
  const now = Date.now()
  const outcome = await db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const [member, rawControl] = await Promise.all([
      readReference(memberRef), readReference(controlRef),
    ])
    assertActiveMember(member)
    let control = normalizeControl(rawControl, openid)
    const activeTaskId = control.activeTaskId
    if (!activeTaskId) return { notFound: true }

    try { validateTaskId(activeTaskId) } catch (_) {
      control = clearActiveTaskPointer(control, activeTaskId, now)
      await controlRef.set({ data: control })
      return { notFound: true }
    }

    const taskRef = transaction.collection(TASK_COLLECTION).doc(activeTaskId)
    const stateRef = transaction.collection('meal_user_states').doc(openid)
    const [rawTask, rawState] = await Promise.all([
      readReference(taskRef), readReference(stateRef),
    ])
    if (!rawTask || rawTask.owner !== openid) {
      control = clearActiveTaskPointer(control, activeTaskId, now)
      await controlRef.set({ data: control })
      return { notFound: true }
    }

    let task = { ...rawTask, _id: activeTaskId }
    const epochMatches = Number(control.generationEpoch) === Number(task.generationEpoch)
    if (!terminal(task.status) && !hasPlanStateFingerprint(task)) {
      task = conflictTask(task, now)
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
    const state = rawState ? migrate(rawState, { preserveUnknown: false }) : null
    return { value: { task: publicProgress(task, now, openid), result: resultFromState(task, state) } }
  })
  if (outcome.notFound) return null
  return outcome.value
}

async function claimWork(openid, taskId) {
  const id = validateTaskId(taskId)
  const now = Date.now()
  const leaseToken = generateLeaseToken()
  return db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const taskRef = transaction.collection(TASK_COLLECTION).doc(id)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const [member, rawTask, rawControl] = await Promise.all([
      readReference(memberRef), readReference(taskRef), readReference(controlRef),
    ])
    assertActiveMember(member)
    assertTaskOwner(rawTask && { ...rawTask, _id: id }, openid)
    const current = { ...rawTask, _id: id }
    let control = normalizeControl(rawControl, openid)
    if (terminal(current.status)) {
      const stored = compactTask(current, current.status, now)
      const nextControl = clearActiveTaskPointer(control, id, now)
      await taskRef.set({ data: taskData(stored) })
      await controlRef.set({ data: nextControl })
      return { task: stored, claim: null }
    }
    if (!hasPlanStateFingerprint(current)) {
      const conflicted = conflictTask(current, now)
      const nextControl = terminalControl(control, conflicted, now)
      await taskRef.set({ data: taskData(conflicted) })
      await controlRef.set({ data: nextControl })
      return { task: conflicted, claim: null }
    }
    if (current.plannerVersion !== PLANNER_VERSION) {
      const unsupported = compactTask(finishTask(current, 'failed', now, { errorCode: 'AI_PLANNER_VERSION_UNSUPPORTED' }), 'failed', now)
      control = terminalControl(control, unsupported, now)
      await taskRef.set({ data: taskData(unsupported) })
      await controlRef.set({ data: control })
      return { task: unsupported, claim: null }
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
  if (claim.kind === 'outline') {
    const body = buildOutlineRequestBody(task.input, providerOptions(config))
    const response = await requestJson(config, body, endpoint, { deadlineAt })
    return normalizeOutline(parseModelJson(extractModelText(response, config.apiStyle)), task.input)
  }
  if (claim.kind === 'detail') {
    const chunk = task.chunks.find((item) => item.index === claim.index)
    if (!chunk) throw plannerError('AI_OUTPUT_INVALID', '生成分片不存在')
    const forbiddenMealTitles = completedMealTitles(task, claim.index)
    const context = { forbiddenMealTitles, retryAttempt: claim.attempt }
    const body = buildDetailRequestBody(task.input, task.outline.result, chunk, providerOptions(config), context)
    const response = await requestJson(config, body, endpoint, { deadlineAt })
    const raw = parseModelJson(extractModelText(response, config.apiStyle))
    return { days: normalizeDetailChunk(raw, task.input, task.outline.result, chunk, context) }
  }
  if (claim.kind === 'finalize') {
    const rawPlan = assembleRawPlan(task.input, task.outline.result, task.chunks.map((chunk) => chunk.result))
    return normalizePlan(rawPlan, task.input, { planId: task.planId, generatedAt: task.generatedAt })
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

async function settleFailure(openid, taskId, claim, leaseToken, failure) {
  const now = Date.now()
  const policy = typeof failure === 'string'
    ? { code: failure, retryable: true, retryAfterMs: MIN_RETRY_DELAY_MS }
    : failure
  return db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const taskRef = transaction.collection(TASK_COLLECTION).doc(taskId)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const [member, rawTask, rawControl] = await Promise.all([
      readReference(memberRef), readReference(taskRef), readReference(controlRef),
    ])
    assertActiveMember(member)
    assertTaskOwner(rawTask && { ...rawTask, _id: taskId }, openid)
    if (!terminal(rawTask.status) && !hasPlanStateFingerprint(rawTask)) {
      let task = conflictTask({ ...rawTask, _id: taskId }, now)
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

async function settleSuccess(openid, taskId, claim, leaseToken, result) {
  const now = Date.now()
  return db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const taskRef = transaction.collection(TASK_COLLECTION).doc(taskId)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const stateRef = transaction.collection('meal_user_states').doc(openid)
    const [member, rawTask, rawControl, rawState] = await Promise.all([
      readReference(memberRef), readReference(taskRef), readReference(controlRef), readReference(stateRef),
    ])
    assertActiveMember(member)
    assertTaskOwner(rawTask && { ...rawTask, _id: taskId }, openid)
    let task = { ...rawTask, _id: taskId }
    let control = normalizeControl(rawControl, openid)
    if (!terminal(task.status) && !hasPlanStateFingerprint(task)) {
      task = conflictTask(task, now)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    const completed = completeClaim(task, claim, leaseToken, result, now)
    if (!completed.accepted) return { task: publicProgress(completed.task, now, openid), result: null }
    task = completed.task
    if (claim.kind !== 'finalize') {
      await taskRef.set({ data: taskData(task) })
      return { task: publicProgress(task, now, openid), result: null }
    }

    if (!rawState || !hasPlanStateFingerprint(task)
      || control.activeTaskId !== taskId || Number(control.generationEpoch) !== Number(task.generationEpoch)) {
      task = compactTask(finishTask(task, 'conflict', now, { errorCode: 'STATE_REVISION_CONFLICT' }), 'conflict', now)
      control = terminalControl(control, task, now)
      await taskRef.set({ data: taskData(task) })
      await controlRef.set({ data: control })
      return { task: publicProgress(task, now, openid), result: null }
    }
    const state = migrate(rawState, { preserveUnknownFrom: rawState })
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
    await stateRef.update({ data: { draftPlan, generationPreferences, stateRevision, updatedAt: db.serverDate() } })
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

async function advanceTask(openid, taskId, config, operations = {}) {
  const claim = operations.claimWork || claimWork
  const execute = operations.executeClaim || executeClaim
  const settleSucceeded = operations.settleSuccess || settleSuccess
  const settleFailed = operations.settleFailure || settleFailure
  const upstreamDeadlineAt = Date.now() + config.timeoutMs
  const claimed = await claim(openid, taskId)
  if (!claimed.claim) return { task: publicProgress(claimed.task, Date.now(), openid), result: null }
  const leaseToken = claimed.claim.leaseToken
  try {
    const endpoint = claimed.claim.kind === 'finalize'
      ? null
      : await resolvePublicEndpoint(config.url, { deadlineAt: upstreamDeadlineAt })
    const result = await execute(claimed.task, claimed.claim, config, endpoint, upstreamDeadlineAt)
    return await settleSucceeded(openid, claimed.task._id, claimed.claim, leaseToken, result)
  } catch (error) {
    return settleFailed(openid, claimed.task._id, claimed.claim, leaseToken, retryPolicy(error))
  }
}

async function cancelGeneration(openid, taskId, expectedTaskRevision) {
  const id = validateTaskId(taskId)
  const now = Date.now()
  return db.runTransaction(async (transaction) => {
    const memberRef = transaction.collection('meal_members').doc(openid)
    const taskRef = transaction.collection(TASK_COLLECTION).doc(id)
    const controlRef = transaction.collection(CONTROL_COLLECTION).doc(openid)
    const [member, rawTask, rawControl] = await Promise.all([
      readReference(memberRef), readReference(taskRef), readReference(controlRef),
    ])
    assertActiveMember(member)
    assertTaskOwner(rawTask && { ...rawTask, _id: id }, openid)
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

function publicError(error) {
  const code = error && error.code || 'AI_GENERATION_FAILED'
  const known = new Set([
    'MEMBERSHIP_REQUIRED', 'ACCOUNT_DELETION_IN_PROGRESS', 'AI_RATE_LIMITED',
    'STATE_REVISION_CONFLICT', 'INVALID_STATE_REVISION', 'AI_CONFIGURATION_INVALID',
    'STATE_SCHEMA_UNSUPPORTED', 'PLAN_TOO_LARGE', 'STATE_TOO_LARGE', 'TASK_NOT_FOUND',
    'INVALID_TASK_ID', 'INVALID_CLIENT_REQUEST_ID', 'IDEMPOTENCY_CONFLICT',
    'TASK_REVISION_CONFLICT', 'INVALID_TASK_REVISION', 'ACTIVE_TASK_EXISTS',
  ])
  if (known.has(code)) return { code, message: error.message }
  return { code: 'AI_GENERATION_FAILED', message: 'AI 没能生成合格计划，请重试；当前计划未改变' }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { success: false, code: 'IDENTITY_REQUIRED', message: '无法识别微信身份' }
  try {
    await requireMember(OPENID)
    const config = configuration(process.env)
    if (event.action === 'status' && !event.taskId) {
      return { success: true, data: { configured: config.configured, contractVersion: CONTRACT_VERSION, apiStyle: config.apiStyle } }
    }
    if (event.action === 'status') return { success: true, data: await readTaskStatus(OPENID, event.taskId) }
    if (event.action === 'current') return { success: true, data: await readCurrentTask(OPENID) }
    if (event.action === 'cancel') {
      return { success: true, data: await cancelGeneration(OPENID, event.taskId, event.expectedTaskRevision) }
    }
    if (!config.configured) throw plannerError('AI_CONFIGURATION_INVALID', 'AI 服务尚未配置，请联系管理员')
    if (event.action === 'start') {
      return { success: true, data: await startTask(OPENID, event.preferences, event.expectedStateRevision, event.clientRequestId) }
    }
    if (event.action === 'advance') return { success: true, data: await advanceTask(OPENID, event.taskId, config) }
    return { success: false, code: 'UNSUPPORTED_ACTION', message: '不支持的计划操作' }
  } catch (error) {
    console.error('aiPlanner failed', { code: error && error.code, name: error && error.name, statusCode: error && error.statusCode })
    return { success: false, ...publicError(error) }
  }
}

exports._test = {
  taskData, normalizeControl, addIdempotencyEntry, enforceRateLimit,
  terminalControl, clearActiveTaskPointer,
  canonicalPlanStateFingerprint,
  startTask, readTaskStatus, readCurrentTask, claimWork, settleSuccess, settleFailure, advanceTask, cancelGeneration,
  privateAddress, publicError, failureCode, completedMealTitles, executeClaim,
  retryPolicy,
}
