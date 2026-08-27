'use strict'

const assert = require('assert')
const path = require('path')

const root = path.resolve(__dirname, '..')
const plannerPath = path.join(root, 'miniprogram', 'pages', 'planner', 'planner.js')
const membershipStorePath = path.join(root, 'miniprogram', 'services', 'membership-store.js')
const userStorePath = path.join(root, 'miniprogram', 'services', 'user-store.js')
const aiPlannerPath = path.join(root, 'miniprogram', 'services', 'ai-planner.js')

const activeTask = {
  taskId: 'task_page_test',
  taskRevision: 3,
  status: 'running',
  phase: 'details',
  progressPercent: 40,
}

let pageDefinition
let flushImplementation = async () => userStore.data
let currentTaskResponse = null
let modalPromise = Promise.resolve()
const scrollCalls = []
const calls = {
  patches: [],
  flush: 0,
  currentTask: 0,
  start: 0,
  statusTask: 0,
  advance: 0,
  cancel: 0,
}

const membershipStore = {
  init: async () => ({ status: 'active' }),
}

const userStore = {
  data: {
    stateRevision: 7,
    generationPreferences: null,
  },
  init: async () => userStore.data,
  patch(partial, options) {
    calls.patches.push({ partial, options })
    userStore.data = { ...userStore.data, ...partial }
    return Promise.resolve(userStore.data)
  },
  flush() {
    calls.flush += 1
    return flushImplementation()
  },
  replaceFromCloud(next) {
    userStore.data = next
  },
}

function isActiveTask(task) {
  return Boolean(task && ['queued', 'running'].includes(task.status))
}

function taskPresentation(task, interrupted = false) {
  return {
    title: interrupted ? '任务已中断' : '正在生成',
    detail: interrupted ? '等待恢复' : '正在处理',
    percent: task.progressPercent || 0,
    percentText: `${task.progressPercent || 0}%`,
    stages: [],
    canCancel: isActiveTask(task),
    canRetry: interrupted,
  }
}

const aiPlanner = {
  status: async () => ({ configured: false, contractVersion: 1 }),
  loadCachedTask: () => null,
  clearCachedTask: () => true,
  async currentTask() {
    calls.currentTask += 1
    return currentTaskResponse
  },
  async start() {
    calls.start += 1
    return { task: activeTask }
  },
  async statusTask() {
    calls.statusTask += 1
    return { task: activeTask }
  },
  async advance() {
    calls.advance += 1
    return { task: activeTask }
  },
  async cancel(taskId, taskRevision) {
    calls.cancel += 1
    assert.strictEqual(taskId, activeTask.taskId)
    assert.strictEqual(taskRevision, activeTask.taskRevision)
    return { task: { ...activeTask, status: 'cancelled', progressPercent: 40 } }
  },
}

require.cache[membershipStorePath] = {
  id: membershipStorePath, filename: membershipStorePath, loaded: true, exports: { membershipStore },
}
require.cache[userStorePath] = {
  id: userStorePath, filename: userStorePath, loaded: true, exports: { userStore },
}
require.cache[aiPlannerPath] = {
  id: aiPlannerPath,
  filename: aiPlannerPath,
  loaded: true,
  exports: {
    aiPlanner,
    createClientRequestId: async () => 'req_page_test_1234567890abcdef',
    isActiveTask,
    taskPresentation,
  },
}

global.Page = (definition) => { pageDefinition = definition }
global.wx = {
  reLaunch() {},
  pageScrollTo(options) { scrollCalls.push(options) },
  navigateTo() {},
  showModal(options) {
    modalPromise = Promise.resolve(options.success({ confirm: true }))
  },
}

delete require.cache[plannerPath]
require(plannerPath)

function makePage() {
  return {
    ...pageDefinition,
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    pageActive: true,
    connected: false,
    taskLoopToken: 0,
    taskLoopTimer: null,
    preferenceSaveTimer: null,
    currentTask: null,
    pendingStart: null,
    setData(partial) { this.data = { ...this.data, ...partial } },
  }
}

function resetMocks() {
  calls.patches.length = 0
  calls.flush = 0
  calls.currentTask = 0
  calls.start = 0
  calls.statusTask = 0
  calls.advance = 0
  calls.cancel = 0
  scrollCalls.length = 0
  flushImplementation = async () => userStore.data
  currentTaskResponse = null
  modalPromise = Promise.resolve()
  userStore.data = { stateRevision: 7, generationPreferences: null }
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve))
}

async function testPreferenceDraftDebounce() {
  resetMocks()
  const page = makePage()
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  const timers = new Map()
  let nextTimerId = 1
  global.setTimeout = (callback, delay) => {
    const id = nextTimerId
    nextTimerId += 1
    timers.set(id, { callback, delay })
    return id
  }
  global.clearTimeout = (id) => timers.delete(id)

  try {
    page.updatePreferences({ mealTypes: ['breakfast'] })
    await tick()
    assert.strictEqual(calls.patches.length, 1)
    assert.deepStrictEqual(calls.patches[0].options, { localOnly: true })
    assert.strictEqual(calls.flush, 0, '本地写入后不能立即访问云端')

    page.updatePreferences({ mealTypes: ['breakfast', 'lunch'] })
    await tick()
    assert.strictEqual(calls.patches.length, 2)
    assert.deepStrictEqual(calls.patches[1].options, { localOnly: true })
    assert.strictEqual(timers.size, 1, '连续编辑只能保留一个防抖定时器')
    const timer = [...timers.values()][0]
    assert.strictEqual(timer.delay, 700)

    timer.callback()
    await tick()
    assert.strictEqual(calls.flush, 1, '700ms 防抖到期后必须同步云端')
  } finally {
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
  }
}

async function testLifecycleFlushConsumesFailure() {
  resetMocks()
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  flushImplementation = async () => { throw new Error('offline') }

  try {
    const hiddenPage = makePage()
    hiddenPage.onHide()
    await tick()
    assert.strictEqual(calls.flush, 1)

    const unloadedPage = makePage()
    unloadedPage.onUnload()
    await tick()
    assert.strictEqual(calls.flush, 2)
    assert.deepStrictEqual(unhandled, [], '生命周期中的同步失败必须在页面内部处理')
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
}

async function testConnectRecoversTaskWhenAiIsUnconfigured() {
  resetMocks()
  currentTaskResponse = { task: activeTask }
  const page = makePage()

  await page.connect()

  assert.strictEqual(page.data.aiStatus, 'unconfigured')
  assert.strictEqual(calls.currentTask, 1, 'AI 未配置时仍须查询并恢复已有云端任务')
  assert.strictEqual(page.currentTask.taskId, activeTask.taskId)
  assert.strictEqual(page.data.taskVisible, true)
  assert.strictEqual(page.data.taskCanCancel, true, '服务未配置时已有任务仍须允许取消')
  assert.strictEqual(calls.advance, 0, '服务未配置时不能推进 AI 任务')
  assert.strictEqual(page.taskLoopTimer, null)
}

async function testRetryIsBlockedButCancelStillWorks() {
  resetMocks()
  const page = makePage()
  page.setData({ aiStatus: 'unconfigured' })
  page.pendingStart = {
    preferences: { mealTypes: ['breakfast'] },
    expectedStateRevision: 7,
    clientRequestId: 'req_page_test_1234567890abcdef',
  }

  await page.retryTask()
  assert.strictEqual(calls.start, 0, 'AI 未就绪时不能重试建立任务')
  assert.strictEqual(calls.advance, 0)

  page.pendingStart = null
  page.currentTask = activeTask
  await page.retryTask()
  assert.strictEqual(calls.statusTask, 0, 'AI 未就绪时不能通过恢复路径间接推进任务')
  assert.strictEqual(calls.start, 0)
  assert.strictEqual(calls.advance, 0)

  page.cancelGeneration()
  await modalPromise
  assert.strictEqual(calls.cancel, 1, 'AI 未就绪不能阻止用户取消已有任务')
}

async function testGenerateRevalidatesEveryEditableStep() {
  for (const invalidStep of [2, 3, 4]) {
    resetMocks()
    const page = makePage()
    const visited = []
    page.setData({
      currentStep: 5,
      aiStatus: 'ready',
      preferences: { ...page.data.preferences, mealTypes: ['breakfast'] },
    })
    page.validateStep = (step) => {
      visited.push(step)
      return step === invalidStep ? `第 ${invalidStep + 1} 步无效` : ''
    }

    await page.generatePlan()

    assert.strictEqual(calls.start, 0, `第 ${invalidStep + 1} 步无效时不能调用 AI`)
    assert.strictEqual(page.data.currentStep, invalidStep)
    assert.strictEqual(page.data.stepError, `第 ${invalidStep + 1} 步无效`)
    assert.deepStrictEqual(visited, Array.from({ length: invalidStep + 1 }, (_, index) => index))
    assert.strictEqual(scrollCalls.length, 1)
    assert.strictEqual(scrollCalls[0].scrollTop, 0)
  }
}

async function testGenerateStartsOnlyAfterAllStepsPass() {
  resetMocks()
  const page = makePage()
  const visited = []
  const validateStep = page.validateStep
  page.setData({
    currentStep: 5,
    aiStatus: 'ready',
    preferences: { ...page.data.preferences, mealTypes: ['breakfast'] },
  })
  page.validateStep = function validateAndTrack(step) {
    visited.push(step)
    return validateStep.call(this, step)
  }
  page.applyTaskResponse = async () => {}

  await page.generatePlan()

  assert.deepStrictEqual(visited, [0, 1, 2, 3, 4])
  assert.strictEqual(calls.start, 1)
  assert.strictEqual(page.data.stepError, '')
}

async function main() {
  await testPreferenceDraftDebounce()
  await testLifecycleFlushConsumesFailure()
  await testConnectRecoversTaskWhenAiIsUnconfigured()
  await testRetryIsBlockedButCancelStillWorks()
  await testGenerateRevalidatesEveryEditableStep()
  await testGenerateStartsOnlyAfterAllStepsPass()
  console.log('planner page behavior tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
