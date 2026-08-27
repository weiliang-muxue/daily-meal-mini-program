'use strict'

const { callFunction } = require('../utils/cloud')
const { membershipStore } = require('./membership-store')

const CACHE_PREFIX = 'meal_ai_task_v1_'
const CACHE_VERSION = 1
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

function safeTaskCache(value, now = Date.now()) {
  let task
  try { task = normalizeTaskProgress(value) } catch (_) { return null }
  return {
    cacheVersion: CACHE_VERSION,
    taskId: task.taskId,
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
  const stages = [
    { key: 'outline', label: '提纲', detail: '拆分日期与餐次结构' },
    { key: 'details', label: '明细', detail: '逐片生成餐食与食材' },
    { key: 'validation', label: '校验', detail: '合并并检查完整性' },
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
    ? `已完成 ${task.completedSteps} / ${task.totalSteps} 个生成片段`
    : '正在准备生成任务'
  let title = task.phase === 'outline' ? '正在整理计划提纲' : task.phase === 'details' ? '正在生成餐食明细' : '正在合并并校验'
  if (task.status === 'succeeded') title = '候选计划已经生成'
  else if (task.status === 'failed') title = '生成任务未完成'
  else if (task.status === 'cancelled') title = '生成任务已取消'
  else if (task.status === 'expired') title = '生成任务已过期'
  else if (task.status === 'conflict') title = '云端数据已经更新'
  else if (interrupted) title = '生成已暂停，可继续'
  return {
    title,
    detail: interrupted ? '网络连接中断后任务仍保留在云端，点击继续即可恢复。' : progressDetail,
    percent: task.progressPercent,
    percentText: `${task.progressPercent}%`,
    stages,
    canCancel: isActiveTask(task),
    canRetry: interrupted || failed || cancelled,
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

  status() { return this.caller('aiPlanner', 'status') }

  async currentTask() {
    const namespace = this.requireNamespace()
    const value = await this.caller('aiPlanner', 'current')
    if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
    if (!value) return null
    const response = normalizeTaskResponse(value)
    const cached = this.saveCachedTask(response.task, namespace, { allowTaskSwitch: true })
    if (cached.taskId === response.task.taskId) response.task = cached
    return response
  }

  async taskAction(action, payload, expectedTaskId = '') {
    const namespace = this.requireNamespace()
    const response = normalizeTaskResponse(await this.caller('aiPlanner', action, payload))
    if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
    if (expectedTaskId && response.task.taskId !== expectedTaskId) throw new Error('生成任务返回不一致，请重新加载')
    const cached = this.saveCachedTask(response.task, namespace, { allowTaskSwitch: action === 'start' })
    if (cached.taskId === response.task.taskId) response.task = cached
    return response
  }

  start(preferences, expectedStateRevision, clientRequestId) {
    if (!validIdentifier(clientRequestId)) return Promise.reject(new Error('生成请求标识无效'))
    return this.taskAction('start', { preferences, expectedStateRevision, clientRequestId })
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
  safeTaskCache,
  isActiveTask,
  isTerminalTask,
  shouldReplaceCachedTask,
  taskPresentation,
  createClientRequestId,
}
