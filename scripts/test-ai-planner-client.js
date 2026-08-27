'use strict'

const assert = require('assert')
const {
  AiPlannerService,
  normalizeTaskProgress,
  normalizeTaskResponse,
  safeTaskCache,
  isActiveTask,
  isTerminalTask,
  shouldReplaceCachedTask,
  taskPresentation,
  createClientRequestId,
} = require('../miniprogram/services/ai-planner')

const taskId = 'task_12345678'
const normalized = normalizeTaskProgress({
  task: {
    taskId,
    status: 'processing',
    phase: 'shards',
    taskRevision: 2,
    completedSteps: 2,
    totalSteps: 5,
    errorCode: 'PRIVATE_TEXT_MUST_NOT_BE_CACHED',
    nextPollAfterMs: 99999,
  },
})
assert.deepStrictEqual(normalized, {
  taskId,
  status: 'running',
  phase: 'details',
  taskRevision: 2,
  completedSteps: 2,
  totalSteps: 5,
  progressPercent: 40,
  errorCode: 'PRIVATE_TEXT_MUST_NOT_BE_CACHED',
  expiresAt: '',
  resultStateRevision: null,
  nextPollAfterMs: 5000,
})
assert.strictEqual(isActiveTask(normalized), true)
assert.strictEqual(isTerminalTask(normalized), false)

const completed = normalizeTaskResponse({
  progress: { taskId, status: 'completed', phase: 'completed', progressPercent: 100 },
  result: { draftPlan: { id: 'draft' }, generationPreferences: { healthNotes: 'private' }, stateRevision: 9 },
})
assert.strictEqual(completed.task.status, 'succeeded')
assert.strictEqual(completed.draftPlan.id, 'draft')
assert.strictEqual(completed.stateRevision, 9)
assert.strictEqual(isTerminalTask(completed.task), true)
assert.strictEqual(shouldReplaceCachedTask(
  { ...normalized, taskRevision: 4, completedSteps: 3, progressPercent: 60 },
  { ...normalized, taskRevision: 3, completedSteps: 4, progressPercent: 80 },
), false, '较早响应不能覆盖较新的任务版本')
assert.strictEqual(shouldReplaceCachedTask(
  { ...completed.task, taskRevision: 5 },
  { ...normalized, taskRevision: 6 },
), false, '终态不能被迟到的运行态覆盖')
assert.strictEqual(shouldReplaceCachedTask(
  { ...normalized, taskId: 'task_newer_1234' },
  { ...normalized, taskId: 'task_older_1234' },
  false,
), false, '旧任务响应不能切换当前缓存任务')
assert.throws(() => normalizeTaskProgress({ taskId, status: 'unknown-status' }), /状态无效/)
const coreEnvelope = normalizeTaskProgress({
  taskId, status: 'failed', phase: 'terminal', taskRevision: 3,
  completedSteps: 1, totalSteps: 4, failureCode: 'AI_TIMEOUT',
  expiresAt: Date.UTC(2026, 7, 26), resultStateRevision: null,
})
assert.strictEqual(coreEnvelope.phase, 'done')
assert.strictEqual(coreEnvelope.errorCode, 'AI_TIMEOUT')
assert.strictEqual(coreEnvelope.expiresAt, '2026-08-26T00:00:00.000Z')
assert.strictEqual(coreEnvelope.resultStateRevision, null)
assert.deepStrictEqual(taskPresentation(coreEnvelope).stages.map((stage) => stage.state), ['done', 'error', 'pending'])
const cloudDateEnvelope = normalizeTaskProgress({
  taskId, status: 'running', phase: 'details', expiresAt: { $date: Date.UTC(2026, 7, 27) },
})
assert.strictEqual(cloudDateEnvelope.expiresAt, '2026-08-27T00:00:00.000Z')
const timestampEnvelope = normalizeTaskProgress({
  taskId, status: 'running', phase: 'details', expiresAt: { seconds: 1787788800, nanoseconds: 500000000 },
})
assert.strictEqual(timestampEnvelope.expiresAt, '2026-08-27T00:00:00.500Z')

const cached = safeTaskCache({
  ...normalized,
  preferences: { healthNotes: '不能缓存' },
  healthNotes: '不能缓存',
  draftPlan: { title: '不能缓存' },
  output: '不能缓存',
}, Date.UTC(2026, 7, 26))
assert.strictEqual(cached.taskId, taskId)
assert.strictEqual(cached.savedAt, '2026-08-26T00:00:00.000Z')
assert.strictEqual(Object.prototype.hasOwnProperty.call(cached, 'preferences'), false)
assert.strictEqual(Object.prototype.hasOwnProperty.call(cached, 'healthNotes'), false)
assert.strictEqual(Object.prototype.hasOwnProperty.call(cached, 'draftPlan'), false)
assert.strictEqual(Object.prototype.hasOwnProperty.call(cached, 'output'), false)

const presentation = taskPresentation(normalized)
assert.strictEqual(presentation.title, '正在生成餐食明细')
assert.strictEqual(presentation.percentText, '40%')
assert.deepStrictEqual(presentation.stages.map((stage) => stage.state), ['done', 'current', 'pending'])
assert.strictEqual(taskPresentation(normalized, true).canRetry, true)

const randomValues = ({ length, success }) => success({ randomValues: Uint8Array.from({ length }, (_, index) => index).buffer })

const namespace = 'a'.repeat(32)
const otherNamespace = 'b'.repeat(32)
const listeners = new Set()
const memberStore = {
  cacheNamespace: namespace,
  onCacheNamespaceChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
}
const storageData = new Map()
const storage = {
  getStorageSync(key) { return storageData.get(key) },
  setStorageSync(key, value) { storageData.set(key, value) },
  removeStorageSync(key) { storageData.delete(key) },
}
const calls = []
const caller = async (name, action, payload) => {
  calls.push({ name, action, payload })
  return { task: { taskId, status: action === 'cancel' ? 'cancelled' : 'running', phase: 'details', completedSteps: 1, totalSteps: 4 } }
}
const service = new AiPlannerService(memberStore, caller, storage)

;(async () => {
  const requestId = await createClientRequestId(123456789, randomValues)
  assert.match(requestId, /^req_[a-z0-9]+_[a-f0-9]{32}$/)
  assert.strictEqual(requestId.endsWith('000102030405060708090a0b0c0d0e0f'), true)
  await assert.rejects(() => createClientRequestId(123456789, null), /微信版本|安全请求标识/)

  await service.start({ healthNotes: 'sent only to cloud, never cached' }, 7, requestId)
  assert.deepStrictEqual(calls[0], {
    name: 'aiPlanner', action: 'start',
    payload: { preferences: { healthNotes: 'sent only to cloud, never cached' }, expectedStateRevision: 7, clientRequestId: requestId },
  })
  const storedKey = `meal_ai_task_v1_${namespace}`
  assert.strictEqual(storageData.get(storedKey).taskId, taskId)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(storageData.get(storedKey), 'preferences'), false)

  await service.statusTask(taskId)
  await service.advance(taskId)
  await service.cancel(taskId, 0)
  assert.deepStrictEqual(calls.slice(1).map((call) => call.action), ['status', 'advance', 'cancel'])
  assert.deepStrictEqual(calls[3].payload, { taskId, expectedTaskRevision: 0 })
  assert.strictEqual(service.loadCachedTask().status, 'cancelled')

  await assert.rejects(() => service.cancel(taskId), /任务版本无效/)
  const current = await service.currentTask()
  assert.strictEqual(current.task.taskId, taskId)
  assert.strictEqual(calls[4].action, 'current')

  const emptyService = new AiPlannerService(memberStore, async () => null, storage)
  assert.strictEqual(await emptyService.currentTask(), null)
  assert.strictEqual(storageData.has(storedKey), true, '云端无活动任务时由页面决定是否保留成功态缓存')

  memberStore.cacheNamespace = otherNamespace
  listeners.forEach((listener) => listener(otherNamespace, namespace))
  assert.strictEqual(service.loadCachedTask(), null)
  assert.strictEqual(service.clearCachedTask(taskId), true)
  assert.strictEqual(storageData.has(storedKey), true, '身份变化后不能清理前一身份的缓存')

  console.log('ai planner client tests passed')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
