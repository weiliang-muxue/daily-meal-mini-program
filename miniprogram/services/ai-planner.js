'use strict'

const { callFunction } = require('../utils/cloud')
const { membershipStore } = require('./membership-store')

const CACHE_PREFIX = 'meal_ai_task_v2_'
const CACHE_VERSION = 2
const CONTRACT_VERSION = 2
const PLANNER_VERSION = '7'
const AI_DATA_CONSENT_VERSION = 2
const PROVIDER_CONTRACT_REVISION = 9
const ACTIVE_STATUSES = new Set(['queued', 'running', 'finalizing'])
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'conflict'])
const STATUS_ALIASES = {
  pending: 'queued', processing: 'running', generating: 'running', validating: 'finalizing',
  completed: 'succeeded', complete: 'succeeded', done: 'succeeded', error: 'failed',
  canceled: 'cancelled', stale: 'conflict',
}
const PHASE_ALIASES = {
  queued: 'outline', preparing: 'outline', outline: 'outline', outlining: 'outline',
  detail: 'details', details: 'details', generating: 'details', shards: 'details', meals: 'details',
  validation: 'validation', validating: 'validation', merging: 'validation', finalizing: 'validation',
  terminal: 'done',
  completed: 'done', succeeded: 'done', done: 'done',
}
const FAILURE_CATEGORIES = new Set([
  'transient', 'provider_configuration', 'response_review', 'data_conflict', 'task_lifecycle', 'unknown',
])
const FAILURE_STATUSES = new Set(['failed', 'expired', 'conflict'])
const TRANSIENT_FAILURE_CODES = new Set([
  'AI_NETWORK_ERROR', 'AI_TIMEOUT', 'AI_RATE_LIMITED',
  'AI_UPSTREAM_RATE_LIMITED', 'AI_UPSTREAM_UNAVAILABLE',
  'AI_RESPONSE_INCOMPLETE', 'AI_RESPONSE_NOT_COMPLETED', 'AI_OUTPUT_INVALID', 'AI_STEP_TIMEOUT',
])
const PROVIDER_CONFIGURATION_CODES = new Set([
  'AI_STORAGE_NOT_READY', 'AI_CONFIGURATION_INVALID',
  'AI_UPSTREAM_AUTH_REJECTED', 'AI_UPSTREAM_FORBIDDEN', 'AI_UPSTREAM_MODEL_UNAVAILABLE',
  'AI_UPSTREAM_ENDPOINT_NOT_FOUND', 'AI_UPSTREAM_PARAMETER_REJECTED',
  'AI_UPSTREAM_POLICY_REJECTED', 'AI_UPSTREAM_REQUEST_REJECTED',
  'AI_UPSTREAM_REJECTED', 'AI_UPSTREAM_FAILED', 'AI_REQUEST_INVALID',
])
const RESPONSE_REVIEW_CODES = new Set([
  'AI_REQUEST_TOO_LARGE', 'AI_RESPONSE_ERROR', 'AI_RESPONSE_INVALID',
  'AI_RESPONSE_REFUSED', 'AI_RESPONSE_TOO_LARGE',
])
const DATA_CONFLICT_CODES = new Set([
  'STATE_REVISION_CONFLICT', 'STALE_DATA_GENERATION',
  'AI_PLANNER_VERSION_UNSUPPORTED', 'AI_CONTRACT_VERSION_UNSUPPORTED',
  'AI_TASK_SCHEMA_VERSION_UNSUPPORTED', 'AI_TASK_VERSION_INVALID', 'AI_DATA_CONSENT_REQUIRED',
])

function validNamespace(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

function validIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value)
}

function integer(value, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback
}

function normalizeStatus(value) {
  const raw = String(value || '').trim().toLowerCase()
  const status = STATUS_ALIASES[raw] || raw
  if (!ACTIVE_STATUSES.has(status) && !TERMINAL_STATUSES.has(status)) throw new Error('生成任务状态无效，请重新加载')
  return status
}

function normalizePhase(value, status) {
  if (status === 'succeeded') return 'done'
  const raw = String(value || '').trim().toLowerCase()
  if (PHASE_ALIASES[raw]) return PHASE_ALIASES[raw]
  if (status === 'finalizing') return 'validation'
  return status === 'queued' ? 'outline' : 'details'
}

function dateTimestamp(value) {
  if (value instanceof Date) return value.getTime()
  if (value && typeof value.toMillis === 'function') return Number(value.toMillis())
  if (value && typeof value.toDate === 'function') return dateTimestamp(value.toDate())
  if (value && typeof value === 'object') {
    if (Number.isFinite(Number(value.$date))) return Number(value.$date)
    const seconds = value.seconds === undefined ? value._seconds : value.seconds
    const nanos = value.nanoseconds === undefined ? value._nanoseconds : value.nanoseconds
    if (Number.isFinite(Number(seconds))) return Number(seconds) * 1000 + Math.floor((Number(nanos) || 0) / 1000000)
  }
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  return Date.parse(String(value || ''))
}

function isoDate(value) {
  const timestamp = dateTimestamp(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ''
}

function normalizeTaskProgress(value) {
  const container = value && typeof value === 'object' ? value : {}
  const source = container.task && typeof container.task === 'object'
    ? container.task
    : container.progress && typeof container.progress === 'object'
      ? container.progress
      : container
  if (!validIdentifier(source.taskId)) throw new Error('生成任务标识无效，请重新发起')
  if (source.contractVersion !== CONTRACT_VERSION || source.plannerVersion !== PLANNER_VERSION) {
    throw new Error('生成任务版本不受支持，请升级或重新发起')
  }
  const status = normalizeStatus(source.status)
  const completedSteps = integer(source.completedSteps, 0, 1000)
  const totalSteps = Math.max(completedSteps, integer(source.totalSteps, 0, 1000))
  const derivedPercent = totalSteps ? Math.round(completedSteps * 100 / totalSteps) : 0
  let progressPercent = Number.isFinite(Number(source.progressPercent))
    ? Math.max(0, Math.min(100, Math.round(Number(source.progressPercent))))
    : derivedPercent
  if (status === 'succeeded') progressPercent = 100
  return {
    taskId: source.taskId,
    contractVersion: CONTRACT_VERSION,
    plannerVersion: PLANNER_VERSION,
    status,
    phase: normalizePhase(source.phase, status),
    taskRevision: integer(source.taskRevision),
    completedSteps,
    totalSteps,
    progressPercent,
    errorCode: typeof (source.errorCode || source.failureCode) === 'string'
      ? String(source.errorCode || source.failureCode).slice(0, 80)
      : '',
    expiresAt: isoDate(source.expiresAt),
    resultStateRevision: Number.isInteger(source.resultStateRevision) && source.resultStateRevision >= 0
      ? source.resultStateRevision
      : null,
    nextPollAfterMs: Math.max(250, Math.min(5000, integer(source.nextPollAfterMs, 500, 5000))),
  }
}

function normalizeTaskResponse(value) {
  const container = value && typeof value === 'object' ? value : {}
  const task = normalizeTaskProgress(container)
  const result = container.result && typeof container.result === 'object' ? container.result : container
  return {
    task,
    draftPlan: result.draftPlan && typeof result.draftPlan === 'object' ? result.draftPlan : null,
    generationPreferences: result.generationPreferences && typeof result.generationPreferences === 'object'
      ? result.generationPreferences
      : null,
    stateRevision: Number.isInteger(result.stateRevision) ? result.stateRevision : task.resultStateRevision,
    updatedAt: isoDate(result.updatedAt),
  }
}

function normalizeServiceStatus(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const contractVersion = Number(source.contractVersion)
  const plannerVersion = typeof source.plannerVersion === 'string' && /^[1-9][0-9]{0,8}$/.test(source.plannerVersion)
    ? source.plannerVersion
    : ''
  const aiDataConsentVersion = Number(source.aiDataConsentVersion)
  const providerContractRevision = Number(source.providerContractRevision)
  return {
    configured: source.configured === true,
    storageReady: source.storageReady === true,
    providerDisplayName: typeof source.providerDisplayName === 'string' ? source.providerDisplayName : '',
    providerContractRevision: Number.isSafeInteger(providerContractRevision) && providerContractRevision >= 0
      ? providerContractRevision
      : 0,
    providerRevision: Number.isSafeInteger(Number(source.providerRevision))
      && Number(source.providerRevision) > 0 ? Number(source.providerRevision) : 0,
    providerConfigVersion: typeof source.providerConfigVersion === 'string'
      && /^[a-f0-9]{64}$/.test(source.providerConfigVersion) ? source.providerConfigVersion : '',
    contractVersion: Number.isSafeInteger(contractVersion) && contractVersion >= 0 ? contractVersion : 0,
    plannerVersion,
    aiDataConsentVersion: Number.isSafeInteger(aiDataConsentVersion) && aiDataConsentVersion >= 0
      ? aiDataConsentVersion
      : 0,
    apiStyle: typeof source.apiStyle === 'string' ? source.apiStyle : '',
  }
}

function failurePolicy(errorCode, status = 'failed') {
  const code = typeof errorCode === 'string' ? errorCode : ''
  if (TRANSIENT_FAILURE_CODES.has(code) || status === 'expired') {
    return {
      category: status === 'expired' ? 'task_lifecycle' : 'transient',
      retryable: true,
      detail: status === 'expired'
        ? '本次生成已结束。请重新确认发送范围后再生成。'
        : '生成服务刚才未能稳定完成。请稍后重新确认发送范围后再生成。',
    }
  }
  if (PROVIDER_CONFIGURATION_CODES.has(code)) {
    return {
      category: 'provider_configuration', retryable: false,
      detail: '生成服务需要管理员检查配置，暂时不建议重复尝试。当前餐单没有改变。',
    }
  }
  if (RESPONSE_REVIEW_CODES.has(code)) {
    return {
      category: 'response_review', retryable: false,
      detail: code === 'AI_REQUEST_TOO_LARGE'
        ? '本次生成条件内容较多。请精简补充说明或缩短周期后再生成，当前餐单没有改变。'
        : 'AI 返回的内容未通过安全或完整性检查。可以调整条件后再生成，当前餐单没有改变。',
    }
  }
  if (DATA_CONFLICT_CODES.has(code) || status === 'conflict') {
    return {
      category: 'data_conflict', retryable: false,
      detail: '餐单设置或程序版本已经变化。请调整条件并重新确认，当前餐单没有改变。',
    }
  }
  return {
    category: 'unknown', retryable: false,
    detail: '本次候选计划没有生效。可以调整条件后再生成，当前餐单没有改变。',
  }
}

function normalizeRecentFailure(value) {
  const container = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  if (container.failure === null || container.failure === undefined) return null
  const source = container.failure && typeof container.failure === 'object' && !Array.isArray(container.failure)
    ? container.failure : {}
  const status = FAILURE_STATUSES.has(source.status) ? source.status : 'failed'
  const phase = ['outline', 'details', 'validation', 'terminal'].includes(source.phase) ? source.phase : 'terminal'
  const policy = failurePolicy(source.errorCode, status)
  const category = FAILURE_CATEGORIES.has(source.category) ? source.category : policy.category
  const percent = Number(source.progressPercent)
  return {
    status,
    phase,
    errorCode: typeof source.errorCode === 'string' ? source.errorCode.slice(0, 80) : '',
    progressPercent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0,
    retryable: source.retryable === true && policy.retryable,
    category,
  }
}

function safeTaskCache(value, now = Date.now()) {
  if (value && Object.prototype.hasOwnProperty.call(value, 'cacheVersion')
    && value.cacheVersion !== CACHE_VERSION) return null
  let task
  try { task = normalizeTaskProgress(value) } catch (_) { return null }
  return {
    cacheVersion: CACHE_VERSION,
    taskId: task.taskId,
    contractVersion: task.contractVersion,
    plannerVersion: task.plannerVersion,
    status: task.status,
    phase: task.phase,
    taskRevision: task.taskRevision,
    completedSteps: task.completedSteps,
    totalSteps: task.totalSteps,
    progressPercent: task.progressPercent,
    errorCode: task.errorCode,
    expiresAt: task.expiresAt,
    resultStateRevision: task.resultStateRevision,
    nextPollAfterMs: task.nextPollAfterMs,
    savedAt: new Date(now).toISOString(),
  }
}

function isActiveTask(task) {
  return Boolean(task && ACTIVE_STATUSES.has(task.status))
}

function isTerminalTask(task) {
  return Boolean(task && TERMINAL_STATUSES.has(task.status))
}

function shouldReplaceCachedTask(current, candidate, allowTaskSwitch = true) {
  if (!current) return true
  if (current.taskId !== candidate.taskId) return allowTaskSwitch
  if (isTerminalTask(current) && !isTerminalTask(candidate)) return false
  if (candidate.taskRevision !== current.taskRevision) return candidate.taskRevision > current.taskRevision
  if (candidate.completedSteps !== current.completedSteps) return candidate.completedSteps > current.completedSteps
  return candidate.progressPercent >= current.progressPercent
}

function taskPresentation(value, interrupted = false) {
  const task = normalizeTaskProgress(value)
  const terminalFallbackIndex = task.completedSteps <= 0 ? 0 : task.totalSteps && task.completedSteps >= task.totalSteps ? 2 : 1
  const phaseIndex = task.phase === 'outline' ? 0 : task.phase === 'details' ? 1 : task.phase === 'validation' ? 2 : terminalFallbackIndex
  const failed = ['failed', 'expired', 'conflict'].includes(task.status)
  const cancelled = task.status === 'cancelled'
  const terminalFailure = failed && failurePolicy(task.errorCode, task.status)
  const stages = [
    { key: 'outline', label: '安排餐次', detail: '安排日期与每餐结构' },
    { key: 'details', label: '搭配餐食', detail: '生成每餐食材与做法' },
    { key: 'validation', label: '完整检查', detail: '检查天数、餐次与采购清单' },
  ].map((stage, index) => ({
    ...stage,
    state: index < phaseIndex || task.status === 'succeeded'
      ? 'done'
      : index === phaseIndex && failed
        ? 'error'
        : index === phaseIndex && cancelled
          ? 'cancelled'
          : index === phaseIndex
            ? 'current'
            : 'pending',
  }))
  const progressDetail = task.totalSteps
    ? `已完成 ${task.completedSteps} / ${task.totalSteps} 项餐食安排`
    : '正在准备候选餐单'
  let title = task.phase === 'outline' ? '正在安排日期与餐次' : task.phase === 'details' ? '正在搭配每餐食物' : '正在检查餐单完整性'
  if (task.status === 'succeeded') title = '候选计划已经生成'
  else if (task.status === 'failed') title = '本次生成未完成'
  else if (task.status === 'cancelled') title = '本次生成已取消'
  else if (task.status === 'expired') title = '本次生成已过期'
  else if (task.status === 'conflict') title = '你的餐单设置已更新'
  else if (interrupted) title = '生成已暂停，可继续'
  return {
    title,
    detail: interrupted ? '网络连接中断，生成进度仍已保存，点击继续即可恢复。' : progressDetail,
    percent: task.progressPercent,
    percentText: `${task.progressPercent}%`,
    stages,
    canCancel: isActiveTask(task),
    canRetry: (interrupted && (isActiveTask(task) || task.status === 'succeeded'))
      || Boolean(terminalFailure && terminalFailure.retryable),
  }
}

function secureRandomBytes(length, getRandomValues) {
  return new Promise((resolve, reject) => {
    const randomApi = getRandomValues || (typeof wx !== 'undefined' && typeof wx.getRandomValues === 'function'
      ? wx.getRandomValues.bind(wx)
      : null)
    if (!randomApi) {
      reject(new Error('当前微信版本不支持安全随机数，请更新微信后重试'))
      return
    }
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        const bytes = new Uint8Array(result && result.randomValues)
        if (bytes.length !== length) throw new Error('安全随机数长度不正确')
        resolve(bytes)
      } catch (_) {
        reject(new Error('无法生成安全请求标识，请重试'))
      }
    }
    const fail = () => {
      if (settled) return
      settled = true
      reject(new Error('无法生成安全请求标识，请重试'))
    }
    try {
      const pending = randomApi({ length, success: finish, fail })
      if (pending && typeof pending.then === 'function') pending.then(finish, fail)
    } catch (_) { fail() }
  })
}

async function createClientRequestId(now = Date.now(), getRandomValues) {
  const bytes = await secureRandomBytes(16, getRandomValues)
  const randomPart = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `req_${Number(now).toString(36)}_${randomPart}`.slice(0, 64)
}

function namespaceChangedError() {
  const error = new Error('微信身份已变化，请重新进入页面')
  error.code = 'CACHE_NAMESPACE_CHANGED'
  return error
}

class AiPlannerService {
  constructor(memberStore = membershipStore, caller = callFunction, storage = null) {
    this.membershipStore = memberStore
    this.caller = caller
    this.storage = storage
    this.namespace = validNamespace(memberStore.cacheNamespace) ? memberStore.cacheNamespace : ''
    this.unsubscribeNamespace = typeof memberStore.onCacheNamespaceChange === 'function'
      ? memberStore.onCacheNamespaceChange((namespace) => { this.namespace = validNamespace(namespace) ? namespace : '' })
      : () => {}
  }

  storageApi() { return this.storage || wx }

  currentNamespace() {
    const namespace = this.membershipStore.cacheNamespace
    this.namespace = validNamespace(namespace) ? namespace : ''
    return this.namespace
  }

  requireNamespace() {
    const namespace = this.currentNamespace()
    if (!namespace) throw new Error('请先联网确认微信身份')
    return namespace
  }

  isCurrentNamespace(namespace) {
    return Boolean(namespace) && namespace === this.currentNamespace()
  }

  cacheKey(namespace = this.currentNamespace()) {
    return namespace ? `${CACHE_PREFIX}${namespace}` : ''
  }

  loadCachedTask() {
    const namespace = this.currentNamespace()
    if (!namespace) return null
    const key = this.cacheKey(namespace)
    const task = safeTaskCache(this.storageApi().getStorageSync(key))
    if (!task) {
      this.storageApi().removeStorageSync(key)
      return null
    }
    if (task.expiresAt && Date.parse(task.expiresAt) <= Date.now()) {
      this.storageApi().removeStorageSync(key)
      return null
    }
    return task
  }

  saveCachedTask(value, namespace = this.requireNamespace(), options = {}) {
    if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
    const task = safeTaskCache(value)
    if (!task) throw new Error('无法保存生成任务进度')
    const key = this.cacheKey(namespace)
    const current = safeTaskCache(this.storageApi().getStorageSync(key))
    const next = shouldReplaceCachedTask(current, task, options.allowTaskSwitch !== false) ? task : current
    this.storageApi().setStorageSync(key, next)
    return next
  }

  clearCachedTask(taskId = '') {
    const namespace = this.currentNamespace()
    if (!namespace) return false
    const cached = this.loadCachedTask()
    if (taskId && cached && cached.taskId !== taskId) return false
    this.storageApi().removeStorageSync(this.cacheKey(namespace))
    return true
  }

  async status() {
    const expectedCacheNamespace = this.requireNamespace()
    return normalizeServiceStatus(await this.caller('aiPlanner', 'status', { expectedCacheNamespace }))
  }

  async currentTask() {
    const namespace = this.requireNamespace()
    const value = await this.caller('aiPlanner', 'current', { expectedCacheNamespace: namespace })
    if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
    if (!value) return null
    const response = normalizeTaskResponse(value)
    const cached = this.saveCachedTask(response.task, namespace, { allowTaskSwitch: true })
    if (cached.taskId === response.task.taskId) response.task = cached
    return response
  }

  async recentFailure() {
    const namespace = this.requireNamespace()
    const value = await this.caller('aiPlanner', 'recentFailure', { expectedCacheNamespace: namespace })
    if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
    return normalizeRecentFailure(value)
  }

  async taskAction(action, payload, expectedTaskId = '') {
    const namespace = this.requireNamespace()
    const response = normalizeTaskResponse(await this.caller('aiPlanner', action, {
      ...payload,
      expectedCacheNamespace: namespace,
    }))
    if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
    if (expectedTaskId && response.task.taskId !== expectedTaskId) throw new Error('生成任务返回不一致，请重新加载')
    const cached = this.saveCachedTask(response.task, namespace, { allowTaskSwitch: action === 'start' })
    if (cached.taskId === response.task.taskId) response.task = cached
    return response
  }

  start(preferences, expectedStateRevision, clientRequestId, consentVersion, providerRevision) {
    if (!validIdentifier(clientRequestId)) return Promise.reject(new Error('生成请求标识无效'))
    if (consentVersion !== AI_DATA_CONSENT_VERSION) {
      return Promise.reject(new Error('请重新确认本次 AI 数据发送范围'))
    }
    if (!Number.isSafeInteger(providerRevision) || providerRevision < 1) {
      return Promise.reject(new Error('请重新确认本次 AI 数据发送接收方'))
    }
    if (!preferences || !Number.isSafeInteger(preferences.durationDays)
      || preferences.durationDays < 1 || preferences.durationDays > 14) {
      return Promise.reject(new Error('计划周期必须是 1–14 天的整数'))
    }
    return this.taskAction('start', {
      preferences, expectedStateRevision, clientRequestId,
      aiDataConsent: {
        accepted: true,
        version: AI_DATA_CONSENT_VERSION,
        providerRevision,
      },
    })
  }

  advance(taskId) {
    if (!validIdentifier(taskId)) return Promise.reject(new Error('生成任务标识无效'))
    return this.taskAction('advance', { taskId }, taskId)
  }

  statusTask(taskId) {
    if (!validIdentifier(taskId)) return Promise.reject(new Error('生成任务标识无效'))
    return this.taskAction('status', { taskId }, taskId)
  }

  cancel(taskId, expectedTaskRevision) {
    if (!validIdentifier(taskId)) return Promise.reject(new Error('生成任务标识无效'))
    if (!Number.isSafeInteger(expectedTaskRevision) || expectedTaskRevision < 0) {
      return Promise.reject(new Error('生成任务版本无效，请先刷新进度'))
    }
    return this.taskAction('cancel', { taskId, expectedTaskRevision }, taskId)
  }
}

module.exports = {
  AiPlannerService,
  aiPlanner: new AiPlannerService(),
  normalizeTaskProgress,
  normalizeTaskResponse,
  normalizeServiceStatus,
  normalizeRecentFailure,
  failurePolicy,
  safeTaskCache,
  isActiveTask,
  isTerminalTask,
  shouldReplaceCachedTask,
  taskPresentation,
  createClientRequestId,
  CONTRACT_VERSION,
  PLANNER_VERSION,
  AI_DATA_CONSENT_VERSION,
  PROVIDER_CONTRACT_REVISION,
}
