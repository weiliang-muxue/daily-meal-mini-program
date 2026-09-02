'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const plannerPath = path.join(root, 'miniprogram', 'pages', 'planner', 'planner.js')
const plannerWxmlPath = path.join(root, 'miniprogram', 'pages', 'planner', 'planner.wxml')
const plannerWxssPath = path.join(root, 'miniprogram', 'pages', 'planner', 'planner.wxss')
const membershipStorePath = path.join(root, 'miniprogram', 'services', 'membership-store.js')
const userStorePath = path.join(root, 'miniprogram', 'services', 'user-store.js')
const aiPlannerPath = path.join(root, 'miniprogram', 'services', 'ai-planner.js')
const {
  normalizeServiceStatus,
  failurePolicy,
  taskPresentation: realTaskPresentation,
  PROVIDER_CONTRACT_REVISION,
} = require(aiPlannerPath)
const {
  CONTRACT_VERSION,
  PLANNER_VERSION,
} = require('../cloudfunctions/aiPlanner/lib')
const {
  AI_DATA_CONSENT_VERSION,
  generateTaskId,
  generateLeaseToken,
  createTask,
  claimNext,
  failClaim,
  publicTask,
} = require('../cloudfunctions/aiPlanner/task-core')

const TEST_PROVIDER_REVISION = 7
const TEST_PROVIDER_CONFIG_VERSION = 'a'.repeat(64)

const activeTask = {
  taskId: 'task_page_test',
  contractVersion: 2,
  plannerVersion: '7',
  taskRevision: 3,
  status: 'running',
  phase: 'details',
  progressPercent: 40,
}

let pageDefinition
let flushImplementation = async () => userStore.data
let currentTaskResponse = null
let currentTaskImplementation = async () => currentTaskResponse
let recentFailureResponse = null
let recentFailureImplementation = async () => recentFailureResponse
let cachedTaskResponse = null
let statusResponse = {
  configured: false, storageReady: true, contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2,
}
let statusImplementation = async () => statusResponse
let startImplementation = async () => ({ task: activeTask })
let modalPromise = Promise.resolve()
const scrollCalls = []
const switchTabCalls = []
const navigateBackCalls = []
const calls = {
  patches: [],
  flush: 0,
  currentTask: 0,
  recentFailure: 0,
  start: 0,
  statusTask: 0,
  advance: 0,
  cancel: 0,
  startArgs: [],
}

const membershipStore = {
  init: async () => ({ status: 'active' }),
}

const userStore = {
  state: 'ready',
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
  return realTaskPresentation(task, interrupted)
}

const aiPlanner = {
  status: async () => statusImplementation(),
  loadCachedTask: () => cachedTaskResponse,
  clearCachedTask: () => true,
  async currentTask() {
    calls.currentTask += 1
    return currentTaskImplementation()
  },
  async recentFailure() {
    calls.recentFailure += 1
    return recentFailureImplementation()
  },
  async start(...args) {
    calls.start += 1
    calls.startArgs.push(args)
    return startImplementation(...args)
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
    failurePolicy,
    CONTRACT_VERSION: 2,
    PLANNER_VERSION: '7',
    AI_DATA_CONSENT_VERSION: 2,
    PROVIDER_CONTRACT_REVISION,
  },
}

global.Page = (definition) => { pageDefinition = definition }
global.wx = {
  reLaunch() {},
  pageScrollTo(options) { scrollCalls.push(options) },
  navigateTo() {},
  switchTab(options) { switchTabCalls.push(options) },
  navigateBack(options) { navigateBackCalls.push(options) },
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
    formControlActive: false,
    keyboardHeight: 0,
    formControlBlurTimer: null,
    keyboardHeightHandler: null,
    currentTask: null,
    pendingStart: null,
    taskRecoveryPromise: null,
    setData(partial) { this.data = { ...this.data, ...partial } },
  }
}

function resetMocks() {
  calls.patches.length = 0
  calls.flush = 0
  calls.currentTask = 0
  calls.recentFailure = 0
  calls.start = 0
  calls.statusTask = 0
  calls.advance = 0
  calls.cancel = 0
  calls.startArgs.length = 0
  scrollCalls.length = 0
  switchTabCalls.length = 0
  navigateBackCalls.length = 0
  flushImplementation = async () => userStore.data
  currentTaskResponse = null
  currentTaskImplementation = async () => currentTaskResponse
  recentFailureResponse = null
  recentFailureImplementation = async () => recentFailureResponse
  cachedTaskResponse = null
  statusResponse = {
    configured: false, storageReady: true, contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2,
  }
  statusImplementation = async () => statusResponse
  startImplementation = async () => ({ task: activeTask })
  modalPromise = Promise.resolve()
  userStore.data = { stateRevision: 7, generationPreferences: null }
  userStore.state = 'ready'
}

function testSecondaryPageNavigation() {
  resetMocks()
  const page = makePage()
  global.getCurrentPages = () => [{ route: 'pages/plan/plan' }, { route: 'pages/planner/planner' }]
  page.refreshPageNavigation()
  assert.strictEqual(page.data.canNavigateBack, true)
  assert.strictEqual(page.data.pageNavigationLabel, '返回上一页')
  page.navigateFromPage()
  assert.strictEqual(navigateBackCalls.length, 1)
  assert.strictEqual(navigateBackCalls[0].delta, 1)

  global.getCurrentPages = () => [{ route: 'pages/planner/planner' }]
  page.refreshPageNavigation()
  assert.strictEqual(page.data.canNavigateBack, false)
  assert.strictEqual(page.data.pageNavigationLabel, '返回餐单首页')
  page.navigateFromPage()
  assert.deepStrictEqual(switchTabCalls, [{ url: '/pages/plan/plan' }])

  global.getCurrentPages = () => [{ route: 'pages/plan/plan' }, { route: 'pages/planner/planner' }]
  wx.navigateBack = ({ fail }) => fail()
  page.navigateFromPage()
  assert.deepStrictEqual(switchTabCalls, [
    { url: '/pages/plan/plan' },
    { url: '/pages/plan/plan' },
  ])
  wx.navigateBack = (options) => { navigateBackCalls.push(options) }
  delete global.getCurrentPages
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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

async function testConnectKeepsPageLoadingUntilSharedRecoverySettles() {
  resetMocks()
  const currentTaskDeferred = deferred()
  currentTaskImplementation = () => currentTaskDeferred.promise
  recentFailureResponse = {
    status: 'failed', phase: 'outline', errorCode: 'AI_TIMEOUT', progressPercent: 0,
    retryable: true, category: 'transient',
  }
  const page = makePage()

  const connectPromise = page.connect()
  let connectSettled = false
  connectPromise.then(() => { connectSettled = true })
  await tick()

  assert.strictEqual(calls.currentTask, 1, '初始化必须开始一次任务恢复')
  assert.strictEqual(page.data.loadingPage, true, '任务恢复未完成时页面不能暴露为稳定状态')
  assert.strictEqual(page.data.recoverySettled, false)
  assert.strictEqual(connectSettled, false, 'connect 必须等待任务恢复完成')
  page.onShow()
  await tick()
  assert.strictEqual(calls.currentTask, 1, 'onShow 不得在初始化恢复期间发起第二次恢复')

  currentTaskDeferred.resolve(null)
  await connectPromise

  assert.strictEqual(connectSettled, true)
  assert.strictEqual(page.data.loadingPage, false)
  assert.strictEqual(page.data.recoverySettled, true)
  assert.strictEqual(calls.recentFailure, 1)
  assert.strictEqual(page.data.currentStep, 5, '初始化恢复结果应在页面稳定前完成渲染')

  page.setData({ currentStep: 1, taskVisible: false })
  page.renderPreferences({ ...page.data.preferences, durationDays: 14 })
  await tick()
  assert.strictEqual(page.data.currentStep, 1, '稳定后不得有迟到的初始化恢复覆盖用户步骤')
  assert.strictEqual(page.data.preferences.durationDays, 14)
}

async function testConnectRestoresPreferenceOnlyOfflineCacheWithoutEnablingAi() {
  resetMocks()
  userStore.state = 'offline'
  userStore.data = {
    stateRevision: 0,
    activePlan: null,
    draftPlan: null,
    generationPreferences: {
      durationDays: 3,
      mealTypes: ['breakfast', 'dinner'],
      goals: ['高碳水'],
    },
  }
  const page = makePage()

  await page.connect()

  assert.strictEqual(page.data.loadingPage, false)
  assert.strictEqual(page.data.pageError, '')
  assert.strictEqual(page.data.preferences.durationDays, 3)
  assert.deepStrictEqual(page.data.preferences.mealTypes, ['breakfast', 'dinner'])
  assert.strictEqual(page.data.preferencesOffline, true)
  assert.strictEqual(page.data.aiStatus, 'error')
  assert.strictEqual(page.data.providerDisplayName, '')
  assert(page.data.aiStatusDetail.includes('需要联网'))
  assert.strictEqual(calls.currentTask, 0, '离线恢复偏好时不能查询或启动 AI 任务')

  const wxml = fs.readFileSync(plannerWxmlPath, 'utf8')
  assert(wxml.includes('bindtap="retryConnect"'), '离线偏好恢复必须提供身份与云数据重连入口')
}

async function testCurrentFailureWithoutCachedTaskPreservesServiceStatus() {
  resetMocks()
  statusResponse = {
    configured: true,
    storageReady: true,
    providerContractRevision: PROVIDER_CONTRACT_REVISION,
    providerRevision: TEST_PROVIDER_REVISION,
    contractVersion: 2,
    plannerVersion: '7',
    aiDataConsentVersion: 2,
    providerDisplayName: '测试 AI 服务',
  }
  currentTaskImplementation = async () => {
    throw new Error('AI 没能生成合格计划，请重试；当前计划未改变')
  }
  const page = makePage()

  await page.connect()

  assert.strictEqual(page.data.aiStatus, 'ready')
  assert.strictEqual(page.data.aiStatusTitle, '生成服务可用')
  const wxml = fs.readFileSync(plannerWxmlPath, 'utf8')
  assert(wxml.includes('wx:if="{{aiStatus !== \'ready\'}}" class="service-strip'),
    '生成服务正常时不能常驻服务状态卡，异常、离线、未配置和检查中才显示')
  assert.strictEqual(page.data.taskVisible, false, '没有缓存任务时不得伪造任务恢复错误')
  assert(!page.data.aiStatusDetail.includes('没能生成合格计划'))

  page.setData({ aiStatus: 'error', aiStatusTitle: '旧状态', aiStatusDetail: '旧提示' })
  await page.retryAiStatus()
  assert.strictEqual(page.data.aiStatus, 'ready', '重试时 current 查询失败也不能覆盖服务检查结果')
  assert.strictEqual(page.data.aiStatusTitle, '生成服务可用')
  assert.strictEqual(page.data.taskVisible, false)
}

async function testCurrentFailureWithCachedTaskUsesRecoveryCopy() {
  for (const aiConfigured of [true, false]) {
    for (const cached of [activeTask, { ...activeTask, status: 'succeeded', progressPercent: 100 }]) {
      resetMocks()
      statusResponse = {
        configured: aiConfigured,
        storageReady: true,
        providerContractRevision: PROVIDER_CONTRACT_REVISION,
        contractVersion: 2,
        plannerVersion: '7',
        aiDataConsentVersion: 2,
        ...(aiConfigured ? {
          providerDisplayName: '测试 AI 服务', providerRevision: TEST_PROVIDER_REVISION,
        } : {}),
      }
      cachedTaskResponse = cached
      currentTaskImplementation = async () => {
        throw new Error('AI 没能生成合格计划，请重试；当前计划未改变')
      }
      const page = makePage()

      await page.connect()

      assert.strictEqual(page.data.aiStatus, aiConfigured ? 'ready' : 'unconfigured', '任务恢复失败不得覆盖生成服务状态')
      assert.strictEqual(page.data.taskVisible, true)
      assert.strictEqual(page.data.taskInterrupted, true)
      assert(page.data.taskDetail.includes('暂时无法同步'))
      assert(!page.data.taskDetail.includes('没能生成合格计划'), '恢复查询不得显示生成失败文案')
      assert.strictEqual(
        page.data.taskCanRetry,
        aiConfigured || cached.status === 'succeeded',
        '活动任务等待服务恢复，已完成任务始终可以继续同步',
      )
      assert.strictEqual(page.data.taskCanCancel, isActiveTask(cached), '仅活动任务保留取消入口')
    }
  }
}

async function testRefreshRecoversOnlySafeRecentFailureSummary() {
  resetMocks()
  recentFailureResponse = {
    status: 'failed', phase: 'outline', errorCode: 'AI_TIMEOUT', progressPercent: 0,
    retryable: true, category: 'transient',
  }
  const page = makePage()
  page.setData({ aiStatus: 'ready', aiStatusTitle: '生成服务可用', aiDataConsentAccepted: true })

  await page.recoverTask()

  assert.strictEqual(calls.currentTask, 1)
  assert.strictEqual(calls.recentFailure, 1, '无当前任务和可恢复缓存时才查询安全失败摘要')
  assert.strictEqual(page.currentTask, null, '安全摘要不得伪造可恢复任务 ID')
  assert.strictEqual(page.data.taskVisible, true)
  assert.strictEqual(page.data.taskCanRetry, true)
  assert.strictEqual(page.data.taskRetryLabel, '重新确认并生成')
  assert.strictEqual(page.data.taskStages[0].stateText, '可重试')
  assert.strictEqual(page.data.aiStatus, 'ready')

  await page.retryTask()
  assert.strictEqual(calls.start, 0, '恢复摘要的重试必须先回到确认页，不能直接复用旧同意调用 AI')
  assert.strictEqual(page.data.taskVisible, false)
  assert.strictEqual(page.data.aiDataConsentAccepted, false)

  resetMocks()
  recentFailureResponse = {
    status: 'failed', phase: 'outline', errorCode: 'AI_UPSTREAM_AUTH_REJECTED', progressPercent: 0,
    retryable: false, category: 'provider_configuration',
  }
  const configurationPage = makePage()
  configurationPage.setData({ aiStatus: 'ready', aiStatusTitle: '生成服务可用' })

  await configurationPage.recoverTask()

  assert.strictEqual(configurationPage.data.taskCanRetry, false)
  assert.strictEqual(configurationPage.data.taskCanEdit, true)
  assert.strictEqual(configurationPage.data.taskCanReturn, true)
  assert.strictEqual(configurationPage.data.taskStages[0].stateText, '未完成')
  assert(configurationPage.data.taskDetail.includes('管理员检查配置'))
  assert.strictEqual(configurationPage.data.aiStatus, 'ready')

  recentFailureResponse = {
    status: 'failed', phase: 'outline', errorCode: 'AI_UPSTREAM_FORBIDDEN', progressPercent: 0,
    retryable: false, category: 'provider_configuration',
  }
  const forbiddenPage = makePage()
  forbiddenPage.setData({ aiStatus: 'ready', aiStatusTitle: '生成服务可用' })

  await forbiddenPage.recoverTask()

  assert.strictEqual(forbiddenPage.data.taskCanRetry, false)
  assert.strictEqual(forbiddenPage.data.taskCanEdit, true)
  assert(forbiddenPage.data.taskDetail.includes('管理员检查配置'))
}

async function testRecentFailureRecoveryIsOptionalAndCannotOverrideServiceStatus() {
  resetMocks()
  recentFailureImplementation = async () => { throw new Error('PRIVATE_RECENT_FAILURE_DETAIL') }
  const page = makePage()
  page.setData({ aiStatus: 'ready', aiStatusTitle: '生成服务可用', aiStatusDetail: '服务状态正常' })

  await page.recoverTask()

  assert.strictEqual(calls.recentFailure, 1)
  assert.strictEqual(page.data.aiStatus, 'ready')
  assert.strictEqual(page.data.aiStatusTitle, '生成服务可用')
  assert.strictEqual(page.data.aiStatusDetail, '服务状态正常')
  assert.strictEqual(page.data.taskVisible, false)

  resetMocks()
  currentTaskResponse = { task: activeTask }
  recentFailureResponse = {
    status: 'failed', phase: 'outline', errorCode: 'AI_TIMEOUT', progressPercent: 0,
    retryable: true, category: 'transient',
  }
  const activePage = makePage()
  activePage.setData({ aiStatus: 'error' })
  await activePage.recoverTask()
  assert.strictEqual(calls.recentFailure, 0, '当前任务存在时不得额外查询历史失败')
}

function testTaskDiagnosticStageStaysInMemoryAndResets() {
  resetMocks()
  const page = makePage()
  assert.strictEqual(page.data.taskDiagnosticStage, '')
  page.currentTask = activeTask
  page.setData({ aiStatus: 'ready' })
  const failure = new Error('sanitized failure')
  failure.code = 'AI_STORAGE_NOT_READY'
  failure.stage = 'ADVANCE_SETTLE_FAILURE'
  page.markTaskInterrupted(failure)
  assert.strictEqual(page.data.taskDiagnosticStage, 'ADVANCE_SETTLE_FAILURE')
  page.resetTaskPanel()
  assert.strictEqual(page.data.taskDiagnosticStage, '')
}

async function testConsentProtocolVersionIsRequiredForReadyStatus() {
  resetMocks()
  const page = makePage()
  statusResponse = {
    configured: true, storageReady: true, providerContractRevision: PROVIDER_CONTRACT_REVISION,
    providerRevision: TEST_PROVIDER_REVISION,
    contractVersion: 2, plannerVersion: '7', providerDisplayName: '测试 AI 服务',
  }
  await page.checkAiStatus()
  assert.strictEqual(page.data.aiStatus, 'error', '旧云函数未声明同意协议时不能允许生成')

  statusResponse = {
    configured: true, storageReady: true, providerContractRevision: PROVIDER_CONTRACT_REVISION,
    providerRevision: TEST_PROVIDER_REVISION,
    contractVersion: 2, plannerVersion: '6',
    aiDataConsentVersion: 2, providerDisplayName: '测试 AI 服务',
  }
  await page.checkAiStatus()
  assert.strictEqual(page.data.aiStatus, 'error', '旧生成器版本不能被误判为可用')

  statusResponse = {
    configured: true, storageReady: true, providerContractRevision: PROVIDER_CONTRACT_REVISION,
    providerRevision: TEST_PROVIDER_REVISION,
    contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2,
  }
  await page.checkAiStatus()
  assert.strictEqual(page.data.aiStatus, 'error', '缺少公开服务名称时必须关闭生成入口')
  assert.strictEqual(page.data.providerDisplayName, '')

  statusResponse = {
    configured: true,
    storageReady: true,
    providerContractRevision: PROVIDER_CONTRACT_REVISION,
    providerRevision: TEST_PROVIDER_REVISION,
    contractVersion: 2,
    plannerVersion: '7',
    aiDataConsentVersion: 2,
    providerDisplayName: '测试 AI 服务',
  }
  await page.checkAiStatus()
  assert.strictEqual(page.data.aiStatus, 'ready')
  assert.strictEqual(page.data.providerDisplayName, '测试 AI 服务')
  assert.strictEqual(page.data.providerRevision, TEST_PROVIDER_REVISION)

  statusResponse = {
    configured: true, storageReady: true, contractVersion: 2, plannerVersion: '7',
    aiDataConsentVersion: 2, providerDisplayName: '测试 AI 服务', providerRevision: TEST_PROVIDER_REVISION,
  }
  await page.checkAiStatus()
  assert.strictEqual(page.data.aiStatus, 'error', '旧云函数缺少 provider 契约版本时不能允许生成')

  statusResponse = {
    configured: true, storageReady: true, providerContractRevision: PROVIDER_CONTRACT_REVISION,
    contractVersion: 2, plannerVersion: '7', aiDataConsentVersion: 2,
    providerDisplayName: '测试 AI 服务',
  }
  await page.checkAiStatus()
  assert.strictEqual(page.data.aiStatus, 'error', '缺少 provider revision 时不能允许生成')
  assert.strictEqual(page.data.providerRevision, 0)
}

async function testNormalizedServiceStatusReachesPageReadyState() {
  resetMocks()
  const page = makePage()
  statusResponse = normalizeServiceStatus({
    configured: true,
    storageReady: true,
    providerContractRevision: PROVIDER_CONTRACT_REVISION,
    providerRevision: TEST_PROVIDER_REVISION,
    contractVersion: 2,
    plannerVersion: '7',
    aiDataConsentVersion: 2,
    providerDisplayName: '测试 AI 服务',
    privateDetail: '不得透传到页面',
  })
  assert.strictEqual(statusResponse.plannerVersion, '7')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(statusResponse, 'privateDetail'), false)
  await page.checkAiStatus()
  assert.strictEqual(page.data.aiStatus, 'ready', '生产服务状态清洗结果必须能通过真实页面就绪检查')
}

async function testStorageReadinessBlocksGenerationAndMapsSafeCopy() {
  for (const storageReady of [undefined, false]) {
    resetMocks()
    statusResponse = {
      configured: true,
      storageReady,
      providerContractRevision: PROVIDER_CONTRACT_REVISION,
      providerRevision: TEST_PROVIDER_REVISION,
      contractVersion: 2,
      plannerVersion: '7',
      aiDataConsentVersion: 2,
      providerDisplayName: '测试 AI 服务',
    }
    const page = makePage()

    await page.checkAiStatus()

    assert.strictEqual(page.data.aiStatus, 'error')
    assert.strictEqual(page.data.aiStatusTitle, '餐单生成暂不可用')
    assert.strictEqual(page.data.aiStatusDetail, '餐单生成暂时不可用，请稍后重试。当前餐单不会改变。')
    assert.strictEqual(page.data.providerDisplayName, '')

    page.setData({
      currentStep: 5,
      aiDataConsentAccepted: true,
      preferences: { ...page.data.preferences, mealTypes: ['breakfast'] },
    })
    page.validateStep = () => ''
    await page.generatePlan()
    assert.strictEqual(calls.start, 0, '存储未就绪时不得建立生成任务')
  }

  resetMocks()
  const lowLevelError = new Error('database collection missing: internal detail')
  lowLevelError.code = 'AI_STORAGE_NOT_READY'
  statusImplementation = async () => { throw lowLevelError }
  const page = makePage()
  await page.checkAiStatus()
  assert.strictEqual(page.data.aiStatusDetail, '餐单生成暂时不可用，请稍后重试。当前餐单不会改变。')
  assert(!page.data.aiStatusDetail.includes('database'), '界面不得暴露底层存储错误')
}

async function testStorageFailureKeepsPendingStartForSameRequestRetry() {
  resetMocks()
  const page = makePage()
  page.setData({
    currentStep: 5,
    aiStatus: 'ready',
    providerRevision: TEST_PROVIDER_REVISION,
    aiDataConsentAccepted: true,
    preferences: { ...page.data.preferences, mealTypes: ['breakfast'] },
  })
  page.validateStep = () => ''
  const storageError = new Error('private database transaction failure')
  storageError.code = 'AI_STORAGE_NOT_READY'
  startImplementation = async () => { throw storageError }

  await page.generatePlan()

  assert.strictEqual(calls.start, 1)
  assert(page.pendingStart, '首次响应失败后必须保留原幂等请求')
  const pending = JSON.parse(JSON.stringify(page.pendingStart))
  assert.strictEqual(page.data.aiStatus, 'error')
  assert.strictEqual(page.data.taskCanRetry, false, '存储恢复前不得显示可执行的任务重试')
  assert.strictEqual(page.data.taskDetail, '餐单生成暂时不可用，请稍后重试。当前餐单不会改变。')
  assert(!page.data.taskDetail.includes('database'), '任务区不得暴露底层存储错误')

  await page.retryTask()
  assert.strictEqual(calls.start, 1, '存储恢复前点击任务重试也不得再次调用 start')

  statusResponse = {
    configured: true,
    storageReady: true,
    providerContractRevision: PROVIDER_CONTRACT_REVISION,
    providerRevision: TEST_PROVIDER_REVISION,
    contractVersion: 2,
    plannerVersion: '7',
    aiDataConsentVersion: 2,
    providerDisplayName: '测试 AI 服务',
  }
  currentTaskImplementation = async () => null
  await page.retryAiStatus()
  assert.strictEqual(page.data.aiStatus, 'ready')
  assert.strictEqual(page.data.taskCanRetry, true)

  startImplementation = async () => ({ task: activeTask })
  page.applyTaskResponse = async () => {}
  await page.retryTask()
  assert.strictEqual(calls.start, 2)
  assert.deepStrictEqual(calls.startArgs[1], [
    pending.preferences, pending.expectedStateRevision, pending.clientRequestId, pending.consentVersion,
    pending.providerRevision,
  ], '恢复后必须复用同一 clientRequestId、同意版本与接收方版本')
  assert.strictEqual(page.pendingStart, null)
}

async function testRecoveryStorageFailureCannotLeaveServiceReady() {
  for (const cached of [null, activeTask]) {
    resetMocks()
    cachedTaskResponse = cached
    const storageError = new Error('private collection detail')
    storageError.code = 'AI_STORAGE_NOT_READY'
    currentTaskImplementation = async () => { throw storageError }
    const page = makePage()
    page.setData({ aiStatus: 'ready', providerDisplayName: '测试 AI 服务' })

    await page.recoverTask()

    assert.strictEqual(page.data.aiStatus, 'error', '任务恢复遇到存储故障时不得继续显示服务可用')
    assert.strictEqual(page.data.aiStatusDetail, '餐单生成暂时不可用，请稍后重试。当前餐单不会改变。')
    assert(!page.data.aiStatusDetail.includes('collection'))
    if (cached) {
      assert.strictEqual(page.data.taskVisible, true)
      assert.strictEqual(page.data.taskCanCancel, true, '存储维护期间已有活动任务仍须保留取消入口')
      assert.strictEqual(page.data.taskCanRetry, false)
      assert.strictEqual(page.data.taskDetail, page.data.aiStatusDetail)
    }
  }

  resetMocks()
  statusResponse = {
    configured: true,
    storageReady: true,
    providerContractRevision: PROVIDER_CONTRACT_REVISION,
    providerRevision: TEST_PROVIDER_REVISION,
    contractVersion: 2,
    plannerVersion: '7',
    aiDataConsentVersion: 2,
    providerDisplayName: '测试 AI 服务',
  }
  const storageError = new Error('private current-task detail')
  storageError.code = 'AI_STORAGE_NOT_READY'
  currentTaskImplementation = async () => { throw storageError }
  const page = makePage()
  page.pendingStart = {
    preferences: { mealTypes: ['breakfast'] },
    expectedStateRevision: 7,
    clientRequestId: 'req_page_test_1234567890abcdef',
    consentVersion: 1,
    providerRevision: TEST_PROVIDER_REVISION,
  }
  page.setData({ taskVisible: true, taskCanRetry: false })

  await page.retryAiStatus()

  assert.strictEqual(page.data.aiStatus, 'error', '恢复查询失败必须覆盖刚刚成功的服务检查')
  assert.strictEqual(page.data.taskCanRetry, false, '恢复查询失败后不得重新点亮原请求重试')
}

async function testRetryIsBlockedButCancelStillWorks() {
  resetMocks()
  const page = makePage()
  page.setData({ aiStatus: 'unconfigured' })
  page.pendingStart = {
    preferences: { mealTypes: ['breakfast'] },
    expectedStateRevision: 7,
    clientRequestId: 'req_page_test_1234567890abcdef',
    providerRevision: TEST_PROVIDER_REVISION,
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

async function testTerminalFailureActionsFollowFailurePolicy() {
  resetMocks()
  const page = makePage()
  page.setData({ aiDataConsentAccepted: true })
  const transientTask = {
    ...activeTask,
    status: 'failed',
    phase: 'outline',
    progressPercent: 0,
    completedSteps: 0,
    totalSteps: 3,
    errorCode: 'AI_TIMEOUT',
  }

  page.renderTask(transientTask)

  assert.strictEqual(page.data.taskCanRetry, true, '瞬时错误必须允许用户重新确认后生成')
  assert.strictEqual(page.data.taskRetryLabel, '重新确认并生成')
  assert.strictEqual(page.data.taskCanEdit, true)
  assert.strictEqual(page.data.taskCanReturn, false, '可重试状态保持两个清晰操作，避免手机底栏拥挤')
  assert.strictEqual(page.data.taskStages[0].stateText, '可重试')

  await page.retryTask()

  assert.strictEqual(calls.start, 0, '终态重试不得复用旧请求或旧同意直接调用 AI')
  assert.strictEqual(page.data.taskVisible, false, '终态重试应先返回确认页面')
  assert.strictEqual(page.data.aiDataConsentAccepted, false, '重新生成必须重新勾选 AI 数据同意')

  const configurationTask = {
    ...transientTask,
    errorCode: 'AI_UPSTREAM_AUTH_REJECTED',
  }
  page.renderTask(configurationTask)

  assert.strictEqual(page.data.taskCanRetry, false, '鉴权或配置错误不得诱导用户重复请求')
  assert.strictEqual(page.data.taskCanEdit, true)
  assert.strictEqual(page.data.taskCanReturn, true)
  assert.strictEqual(page.data.taskStages[0].stateText, '未完成')
  assert(page.data.taskDetail.includes('管理员检查配置'))

  page.renderTask({ ...transientTask, errorCode: 'AI_UPSTREAM_FORBIDDEN' })
  assert.strictEqual(page.data.taskCanRetry, false, '403 访问拒绝不得诱导用户重复请求')
  assert.strictEqual(page.data.taskCanEdit, true)
  assert.strictEqual(page.data.taskCanReturn, true)
  assert(page.data.taskDetail.includes('管理员检查配置'))

  const interruptedConfiguration = new Error('已做安全映射的连接错误')
  interruptedConfiguration.code = 'AI_UPSTREAM_AUTH_REJECTED'
  page.markTaskInterrupted(interruptedConfiguration)
  assert.strictEqual(page.data.taskCanRetry, false, '终态配置错误同步中断后也不能闪回重试按钮')

  page.returnToCurrentPlan()
  assert.deepStrictEqual(switchTabCalls, [{ url: '/pages/plan/plan' }])

  page.renderTask({ ...transientTask, errorCode: 'AI_REQUEST_TOO_LARGE' })
  assert.strictEqual(page.data.taskCanRetry, false, '请求内容过大必须先调整条件，不能盲目重试')
  assert.strictEqual(page.data.taskCanReturn, true)
  assert(page.data.taskDetail.includes('精简补充说明或缩短周期'))

  page.renderTask({ ...transientTask, status: 'cancelled', errorCode: '' })
  assert.strictEqual(page.data.taskCanRetry, false, '用户取消的任务不得复用旧同意重新生成')
  assert.strictEqual(page.data.taskCanReturn, true)
  assert(page.data.taskDetail.includes('当前餐单没有改变'))

  const wxml = fs.readFileSync(plannerWxmlPath, 'utf8')
  assert(wxml.includes('bindtap="returnToCurrentPlan"') && wxml.includes('返回当前餐单'))
  assert(wxml.includes('{{item.stateText}}'), '阶段状态必须使用失败策略生成的语义文案')
  assert(!wxml.includes("item.state === 'error' ? '需重试'"), '不可重试错误不能继续统一显示“需重试”')
}

function testEditConditionsReturnsToFirstStepWithoutDroppingPreferences() {
  resetMocks()
  const page = makePage()
  const preferences = {
    ...page.data.preferences,
    durationDays: 10,
    mealTypes: ['breakfast', 'dinner'],
    goals: ['均衡饮食'],
    exerciseIntent: 'none',
  }
  page.renderPreferences(preferences)
  page.currentTask = { ...activeTask, status: 'failed', errorCode: 'AI_TIMEOUT' }
  page.setData({
    currentStep: 5,
    taskVisible: true,
    taskCanEdit: true,
    aiDataConsentAccepted: true,
    stepError: '旧错误',
    exerciseErrorsVisible: true,
  })

  page.editConditions()

  assert.strictEqual(page.data.currentStep, 0, '调整条件必须回到第 1 步')
  assert.strictEqual(page.data.stepNumber, 1)
  assert.strictEqual(page.data.stepTitle, '选择餐次')
  assert.strictEqual(page.data.taskVisible, false)
  assert.strictEqual(page.data.aiDataConsentAccepted, false)
  assert.strictEqual(page.data.stepError, '')
  assert.strictEqual(page.data.exerciseErrorsVisible, false)
  assert.deepStrictEqual(page.data.preferences.mealTypes, preferences.mealTypes, '调整条件不得丢失已选餐次')
  assert.strictEqual(page.data.preferences.durationDays, 10, '调整条件不得丢失已选周期')
  assert.strictEqual(scrollCalls.at(-1).scrollTop, 0)

  const activePage = makePage()
  activePage.currentTask = { ...activeTask }
  activePage.setData({ currentStep: 5, taskVisible: true, taskCanEdit: false })
  activePage.editConditions()
  assert.strictEqual(activePage.data.currentStep, 5, '活动任务不得绕过取消流程直接编辑')
  assert.strictEqual(activePage.data.taskVisible, true)
}

async function testFirstOutlineRequestRejectionFailsAtZeroWithoutRetry() {
  resetMocks()
  const startedAt = 1000
  const failedAt = 2100
  const leaseToken = generateLeaseToken(Buffer.alloc(32, 92))
  const created = createTask({
    taskId: generateTaskId(Buffer.alloc(32, 91)),
    owner: 'openid-outline-rejection-test',
    input: {
      contractVersion: CONTRACT_VERSION,
      durationDays: 1,
      startDate: '2026-09-01',
      mealTypes: ['breakfast'],
      doubleDinner: false,
      goals: ['均衡饮食'],
      styles: [],
      customGoal: '',
      restrictions: '',
      healthNotes: '',
      exerciseIntent: 'none',
      exerciseNotes: '',
      exerciseByDay: [],
    },
    baseStateRevision: 7,
    stateRevision: 7,
    planId: 'plan-outline-rejection-test',
    activePlan: null,
    draftPlan: null,
    generatedAt: '2026-09-01T00:00:00.000Z',
    now: startedAt,
    clientRequestId: '0123456789abcdef0123456789abcdef',
    contractVersion: CONTRACT_VERSION,
    plannerVersion: PLANNER_VERSION,
    aiDataConsentVersion: AI_DATA_CONSENT_VERSION,
    providerRevision: TEST_PROVIDER_REVISION,
    providerConfigVersion: TEST_PROVIDER_CONFIG_VERSION,
  })
  const claimed = claimNext(created, leaseToken, 2000)
  assert.strictEqual(claimed.claim.kind, 'outline', '第一次上游请求必须是 outline')

  const rejection = Object.assign(new Error('fixed safe upstream rejection'), {
    code: 'AI_UPSTREAM_REQUEST_REJECTED',
    retryable: false,
  })
  const settled = failClaim(
    claimed.task,
    claimed.claim,
    leaseToken,
    rejection.code,
    failedAt,
    { retryable: rejection.retryable },
  )
  assert.strictEqual(settled.accepted, true)
  const task = publicTask(settled.task, failedAt, created.owner)
  assert.strictEqual(task.status, 'failed')
  assert.strictEqual(task.errorCode, 'AI_UPSTREAM_REQUEST_REJECTED')
  assert.strictEqual(task.completedSteps, 0, '首个 outline 失败前没有任何已完成步骤')
  assert.strictEqual(task.progressPercent, 0, '首个 outline 失败必须保持 0%')

  const page = makePage()
  page.setData({ aiStatus: 'ready' })
  await page.applyTaskResponse({ task })

  const policy = failurePolicy(task.errorCode, task.status)
  assert.strictEqual(policy.category, 'provider_configuration')
  assert.strictEqual(policy.retryable, false)
  assert.strictEqual(page.data.taskPercent, 0)
  assert.strictEqual(page.data.taskPercentText, '0%')
  assert.strictEqual(page.data.taskStages[0].state, 'error')
  assert.strictEqual(page.data.taskStages[0].stateText, '未完成')
  assert(page.data.taskStages.slice(1).every((stage) => stage.state === 'pending'))
  assert.strictEqual(page.data.taskDetail, policy.detail)
  assert(page.data.taskDetail.includes('管理员检查配置'))
  assert.strictEqual(page.data.taskCanRetry, false)

  const visibleActions = [
    ...(page.data.taskCanEdit ? ['调整条件'] : []),
    ...(page.data.taskCanReturn ? ['返回当前餐单'] : []),
    ...(page.data.taskCanRetry ? [page.data.taskRetryLabel] : []),
  ]
  assert.deepStrictEqual(visibleActions, ['调整条件', '返回当前餐单'])
  assert(!visibleActions.includes('重新生成'), '不可重试的配置错误不得显示“重新生成”按钮')
  const wxml = fs.readFileSync(plannerWxmlPath, 'utf8')
  assert(/wx:if="\{\{taskCanRetry\}\}"[^>]*>\{\{generating \? '正在连接' : taskRetryLabel\}\}<\/button>/.test(wxml),
    '重试按钮必须由 taskCanRetry 严格控制')
}

async function testGenerateRevalidatesEveryEditableStep() {
  for (const invalidStep of [2, 3, 4]) {
    resetMocks()
    const page = makePage()
    const visited = []
    page.setData({
      currentStep: 5,
      aiStatus: 'ready',
      aiDataConsentAccepted: true,
      preferences: {
        ...page.data.preferences,
        mealTypes: ['breakfast'],
        goals: ['均衡饮食'],
        exerciseIntent: 'none',
      },
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
    providerRevision: TEST_PROVIDER_REVISION,
    aiDataConsentAccepted: true,
    preferences: {
      ...page.data.preferences,
      mealTypes: ['breakfast'],
      goals: ['均衡饮食'],
      exerciseIntent: 'none',
    },
  })
  page.validateStep = function validateAndTrack(step) {
    visited.push(step)
    return validateStep.call(this, step)
  }
  page.applyTaskResponse = async () => {}

  await page.generatePlan()

  assert.deepStrictEqual(visited, [0, 1, 2, 3, 4])
  assert.strictEqual(calls.start, 1)
  assert.strictEqual(calls.startArgs[0][3], AI_DATA_CONSENT_VERSION)
  assert.strictEqual(calls.startArgs[0][4], TEST_PROVIDER_REVISION)
  assert.strictEqual(page.data.stepError, '')
}

async function testConsentIsRequiredAndResetWhenConditionsChange() {
  resetMocks()
  const page = makePage()
  page.setData({
    currentStep: 5,
    aiStatus: 'ready',
    providerRevision: TEST_PROVIDER_REVISION,
    preferences: { ...page.data.preferences, mealTypes: ['breakfast'] },
  })
  page.validateStep = () => ''
  await page.generatePlan()
  assert.strictEqual(calls.start, 0)
  assert.strictEqual(calls.patches.length, 0, '未同意不能保存生成偏好')

  page.setData({ aiDataConsentAccepted: true })
  page.updatePreferences({ styles: ['清淡'] })
  assert.strictEqual(page.data.aiDataConsentAccepted, false, '修改发送内容必须撤销旧同意')
}

async function testPendingStartRetryKeepsOnlyTheSameConsent() {
  resetMocks()
  const page = makePage()
  page.setData({
    currentStep: 5,
    aiStatus: 'ready',
    providerRevision: TEST_PROVIDER_REVISION,
    aiDataConsentAccepted: true,
    preferences: { ...page.data.preferences, mealTypes: ['breakfast'] },
  })
  page.validateStep = () => ''
  startImplementation = async () => { throw new Error('offline') }

  await page.generatePlan()
  assert.strictEqual(page.data.aiDataConsentAccepted, false, '一次生成开始后界面必须清除勾选')
  assert(page.pendingStart)
  const pending = JSON.parse(JSON.stringify(page.pendingStart))
  assert.strictEqual(calls.start, 1)

  startImplementation = async () => ({ task: activeTask })
  page.applyTaskResponse = async () => {}
  await page.retryTask()
  assert.strictEqual(calls.start, 2)
  assert.deepStrictEqual(calls.startArgs[1], [
    pending.preferences, pending.expectedStateRevision, pending.clientRequestId, pending.consentVersion,
    pending.providerRevision,
  ])
  assert.strictEqual(page.pendingStart, null)
}

function withFakeTimers(callback) {
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  const timers = new Map()
  let nextTimerId = 1
  global.setTimeout = (handler, delay) => {
    const id = nextTimerId
    nextTimerId += 1
    timers.set(id, { handler, delay })
    return id
  }
  global.clearTimeout = (id) => timers.delete(id)
  try { callback(timers) } finally {
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
  }
}

function testMobileFormAndFooterContract() {
  resetMocks()
  const page = makePage()
  withFakeTimers((timers) => {
    assert.strictEqual(page.data.formControlFocused, false)
    page.onFormControlFocus()
    assert.strictEqual(page.data.formControlFocused, true, '输入聚焦时必须收起固定底栏')
    page.onFormControlBlur()
    assert.strictEqual(page.data.formControlFocused, true, '输入失焦瞬间不能恢复底栏')
    assert.strictEqual(timers.size, 1)
    assert([...timers.values()][0].delay >= 120 && [...timers.values()][0].delay <= 180,
      '失焦回退需要短延迟以避开 iOS 键盘退场抖动')

    page.onFormControlFocus()
    assert.strictEqual(timers.size, 0, '从输入 A 切换到输入 B 时必须取消旧恢复任务')
    page.onFormControlBlur()
    page.onKeyboardHeightChange({ height: 280 })
    assert.strictEqual(timers.size, 0)
    assert.strictEqual(page.data.formControlFocused, true, '键盘仍可见时底栏必须保持隐藏')
    page.onKeyboardHeightChange({ height: 0 })
    assert.strictEqual(timers.size, 1, '键盘归零且输入不活跃时才排队恢复')
    const [restoreId, restore] = [...timers.entries()][0]
    timers.delete(restoreId)
    restore.handler()
    assert.strictEqual(page.data.formControlFocused, false, '键盘关闭后必须恢复底栏')

    page.onFormControlFocus()
    page.onFormControlBlur()
    const [fallbackId, fallback] = [...timers.entries()][0]
    timers.delete(fallbackId)
    fallback.handler()
    assert.strictEqual(page.data.formControlFocused, false, '无键盘高度 API 时延迟回退必须可用')
  })

  const wxml = fs.readFileSync(plannerWxmlPath, 'utf8')
  const wxss = fs.readFileSync(plannerWxssPath, 'utf8')
  const formControls = wxml.match(/<(?:input|textarea)\b[^>]*\/>/g) || []
  assert(formControls.length >= 6, 'Planner 表单控件数量异常')
  formControls.forEach((control) => {
    assert(/cursor-spacing="\d+"/.test(control), `表单控件缺少 cursor-spacing: ${control}`)
    assert(control.includes('bindfocus="onFormControlFocus"'), `表单控件缺少 focus 处理: ${control}`)
    if (control.includes('class="duration-input"')) {
      assert(control.includes('bindblur="commitDurationDays"'), '周期输入失焦时必须先校验并提交草稿')
    } else {
      assert(control.includes('bindblur="onFormControlBlur"'), `表单控件缺少 blur 处理: ${control}`)
    }
  })
  const durationCommit = /commitDurationDays\(\)\s*\{[\s\S]*?\n\s*\},/.exec(fs.readFileSync(plannerPath, 'utf8'))
  assert(durationCommit && durationCommit[0].includes('this.onFormControlBlur()'),
    '周期输入专用 blur 提交完成后必须恢复通用表单失焦流程')
  assert(wxml.includes('wx:if="{{!formControlFocused}}" class="bottom-actions'), '聚焦时固定底栏必须退出渲染')
  assert(wxss.includes('safe-area-inset-left') && wxss.includes('safe-area-inset-right'), 'Planner 与底栏必须处理左右安全区')
  assert(/@media \(orientation: landscape\) and \(max-height: 500px\)/.test(wxss), '缺少横屏紧凑底栏断点')
  assert(/min-height:\s*60px/.test(wxss) && /height:\s*48px/.test(wxss), '横屏底栏与按钮必须使用稳定 48px 触控高度')
  assert(!/@media \(max-width: 340px\),\s*\(orientation: landscape\)/.test(wxss), '横屏不能沿用纵向多行底栏规则')
  assert(!/calc\([^)]*\/[^)]*\)/.test(wxss), '旧微信内核不应解析 calc 除法')
  assert(!/font-size:\s*\d+rpx/.test(wxss), 'Planner 字号必须使用稳定 px，避免横屏 rpx 缩小')
  assert(/\.planner-screen \.status-title\s*\{[^}]*font-size:\s*\d+px/.test(wxss), 'Planner 状态标题必须覆盖全局 rpx 字号')
  assert(/\.planner-screen \.primary-button[^}]*font-size:\s*\d+px/.test(wxss), 'Planner 主次按钮必须覆盖全局 rpx 字号')

  const portraitReserve = Number((/\.planner-screen\s*\{[\s\S]*?padding-bottom:\s*calc\((\d+)rpx\s*\+\s*env\(safe-area-inset-bottom\)\)/.exec(wxss) || [])[1])
  const portraitFooter = Number((/\.bottom-actions\s*\{[\s\S]*?min-height:\s*(\d+)rpx/.exec(wxss) || [])[1])
  assert(portraitReserve >= portraitFooter + 40, '纵向正文底部预留必须完整越过固定底栏')

  const landscape = (/@media \(orientation: landscape\) and \(max-height: 500px\)\s*\{([\s\S]*?)\n\}/.exec(wxss) || [])[1] || ''
  const landscapeReserve = Number((/padding-bottom:\s*calc\((\d+)px\s*\+\s*env\(safe-area-inset-bottom\)\)/.exec(landscape) || [])[1])
  const landscapeFooter = Number((/max-height:\s*calc\((\d+)px\s*\+\s*env\(safe-area-inset-bottom\)\)/.exec(landscape) || [])[1])
  assert(landscapeReserve >= landscapeFooter, '横屏正文底部预留不能小于底栏最大高度')
  assert(/\.intensity\s*\{[^}]*min-height:\s*48px/.test(landscape), '812×375 强度控件至少 48px')
}

function testIntensityAndConsentPresentation() {
  resetMocks()
  const page = makePage()
  const preferences = {
    ...page.data.preferences,
    mealTypes: ['dinner'],
    exerciseByDay: [{ dayIndex: 0, planned: true, type: '步行', durationMinutes: 30, intensity: 'medium' }],
  }
  page.renderPreferences(preferences)
  assert.deepStrictEqual(page.data.exerciseDays[0].intensityOptions.map((item) => item.label), ['轻松', '适中', '较强'])
  assert.strictEqual(page.data.exerciseDays[0].intensityOptions.filter((item) => item.checked).length, 1)
  assert.strictEqual(page.data.exerciseDays[0].intensityOptions[1].checked, true)
  assert(/持续活动/.test(page.data.exerciseDays[0].intensityHint), '强度组下方必须只解释当前选中强度')

  const wxml = fs.readFileSync(plannerWxmlPath, 'utf8')
  const wxss = fs.readFileSync(plannerWxssPath, 'utf8')
  assert(wxml.includes('class="intensity-check {{intensity.checked ? \'visible\' : \'\'}}"'), '强度控件必须只在选中项显示对勾')
  assert.strictEqual((wxml.match(/class="choice-check \{\{item\.checked \? 'visible' : ''\}\}"/g) || []).length, 2,
    '饮食目标和风格选中项都必须显示非颜色对勾')
  assert(/\.choice-check\.visible\s*\{[^}]*width:\s*16px[^}]*opacity:\s*1/.test(wxss),
    '目标与风格选中对勾必须稳定占位并可见')
  assert(!wxml.includes("{{intensity.checked ? '✓ 已选' : '未选'}}"), '未选强度不应重复展示“未选”噪声')
  assert(wxml.includes("{{intensity.checked ? '已选中' : '未选中'}}"), '强度控件必须向辅助功能暴露选中语义')
  assert(wxml.includes('aria-describedby="intensity-hint-{{item.dayIndex}}"')
    && wxml.includes('id="intensity-hint-{{item.dayIndex}}"'), '当前强度说明必须与强度组建立读屏关联')
  assert(wxml.includes('会发送') && wxml.includes('不会发送'), '发送范围必须清楚区分会发送与不会发送')
  assert(wxml.includes('wx:if="{{aiStatus === \'ready\' && providerDisplayName}}"'), '只有接收方已确认且服务可用时才能显示发送同意区')
  assert(wxml.includes('disabled="{{generating || aiStatus !== \'ready\' || !providerDisplayName || !aiDataConsentAccepted}}"'),
    '服务、接收方或单独同意任一未就绪时必须禁用生成按钮')
  assert(wxml.includes("aiStatus === 'loading' ? '检查完成且服务可用后"),
    '首次服务检查必须使用检查中文案，不能误写为服务恢复')
  assert(/\.privacy-box\s*\{[^}]*background:\s*var\(--surface-muted\);/.test(wxss), '常态发送范围必须使用中性信息面板')
  assert(!/\.privacy-box\s*\{[^}]*var\(--gold/.test(wxss), '常态发送范围不能继续使用黄色警示层级')
  assert(/\.task-boundary\s*\{[^}]*background:\s*var\(--surface-muted\);/.test(wxss), '常态生成说明必须使用中性信息面板')
  assert(!/\.task-boundary\s*\{[^}]*var\(--gold/.test(wxss), '常态生成说明不能继续使用黄色警示层级')
  assert(wxml.includes('class="step-body confirm-step"'), '确认步骤必须有独立底部滚动预留')
  assert(fs.readFileSync(plannerPath, 'utf8').includes("'确认信息'"),
    '第六步标题必须与确认页任务一致，不能回退为模糊的“确认生成”')
  assert(wxml.includes('第 {{stepNumber}} / {{stepCount}} 步')
    && wxml.includes('{{stepTitle}}') && wxml.includes('class="step-track"'),
  '确认页必须沿用六步共同的步骤编号、标题和进度条')
}

function testNativeControlTheme() {
  resetMocks()
  const page = makePage()
  const wxml = fs.readFileSync(plannerWxmlPath, 'utf8')
  const behavior = fs.readFileSync(plannerPath, 'utf8')
  const nativeControls = wxml.match(/<checkbox(?=\s)[^>]*>/g) || []
  assert(nativeControls.length >= 5, '规划页必须保留餐次、目标、风格、晚餐和 AI 同意原生选择控件')
  nativeControls.forEach((control) => {
    assert(control.includes('color="{{nativeControlColor}}"'), '规划页每个原生 checkbox 都必须使用主题化颜色')
    assert(!/color="#[\da-f]+"/i.test(control), '规划页原生 checkbox 不得写死浅色主题颜色')
  })
  assert(behavior.includes('wx.onThemeChange(this.themeChangeHandler)')
    && behavior.includes('wx.offThemeChange(this.themeChangeHandler)'),
  '规划页必须监听系统主题并在卸载时解绑')
  assert(!behavior.includes('getSystemInfoSync'), '规划页不得继续调用已废弃的 getSystemInfoSync')
  page.applyTheme({ theme: 'dark' })
  assert.strictEqual(page.data.nativeControlColor, '#72D49E')
  page.applyTheme({ theme: 'light' })
  assert.strictEqual(page.data.nativeControlColor, '#176B46')
}

function exerciseEvent(dayIndex, value) {
  return { currentTarget: { dataset: { index: dayIndex } }, detail: { value } }
}

function durationInputEvent(value) {
  return { detail: { value } }
}

function durationStepEvent(delta) {
  return { currentTarget: { dataset: { delta } } }
}

async function testDurationInputNormalizationAndValidation() {
  for (const value of ['', '0', '-1']) {
    resetMocks()
    const page = makePage()
    let blurCalls = 0
    page.onFormControlBlur = () => { blurCalls += 1 }
    page.inputDurationDays(durationInputEvent(value))
    assert.strictEqual(page.data.durationDaysInput, value, '失焦前应保留用户输入以便看见并修正')
    page.commitDurationDays()
    assert.strictEqual(page.data.preferences.durationDays, 1)
    assert.strictEqual(page.data.durationDaysInput, '1')
    assert.strictEqual(page.data.durationDaysError, '')
    assert(page.data.durationDaysFeedback.includes('已调整为 1 天'))
    assert.strictEqual(blurCalls, 1, '周期提交必须继续执行通用表单失焦流程')
  }

  for (const value of ['1.5', 'abc']) {
    resetMocks()
    const page = makePage()
    page.inputDurationDays(durationInputEvent(value))
    assert.strictEqual(page.data.durationDaysInput, value, '非法输入不能被静默改写')
    assert(page.data.durationDaysError.includes('整数'))
    page.commitDurationDays()
    assert.strictEqual(page.data.durationDaysInput, value)
    assert.strictEqual(page.data.preferences.durationDays, 1)
    assert(page.validateStep(1).includes('整数'))
  }

  for (const value of ['0', '-1', '1.5', 'abc']) {
    resetMocks()
    const invalidPage = makePage()
    invalidPage.setData({
      currentStep: 5,
      aiStatus: 'ready',
      providerRevision: TEST_PROVIDER_REVISION,
      aiDataConsentAccepted: true,
      preferences: {
        ...invalidPage.data.preferences,
        mealTypes: ['breakfast'],
        goals: ['均衡饮食'],
        exerciseIntent: 'none',
      },
    })
    invalidPage.inputDurationDays(durationInputEvent(value))
    await invalidPage.generatePlan()
    assert.strictEqual(calls.start, 0, `非法周期 ${value} 在页面层不得发出 AI start`)
    assert.strictEqual(invalidPage.data.currentStep, 1)
    assert(invalidPage.data.stepError, `非法周期 ${value} 必须显示字段错误`)
  }

  resetMocks()
  const page = makePage()
  page.setData({
    currentStep: 5,
    aiStatus: 'ready',
    providerRevision: TEST_PROVIDER_REVISION,
    aiDataConsentAccepted: true,
    preferences: { ...page.data.preferences, mealTypes: ['breakfast'] },
  })
  page.inputDurationDays(durationInputEvent('15'))
  assert.strictEqual(page.data.durationDaysInput, '15', '超过上限的值应保持可见')
  assert.strictEqual(page.data.preferences.durationDays, 1, '超过上限不能改变已生效周期')
  assert.strictEqual(page.data.durationDaysError, '最多生成 14 天，请输入 1–14')
  await page.generatePlan()
  assert.strictEqual(calls.start, 0, '超过上限时必须阻止 AI 生成')
  assert.strictEqual(page.data.currentStep, 1)
  assert.strictEqual(page.data.durationDaysInput, '15')
  assert.strictEqual(page.data.stepError, '最多生成 14 天，请输入 1–14')
}

function testDurationStepperAndShrinkCleanup() {
  resetMocks()
  const page = makePage()
  assert.strictEqual(page.data.preferences.durationDays, 1)
  for (let day = 1; day < 14; day += 1) page.adjustDuration(durationStepEvent(1))
  assert.strictEqual(page.data.preferences.durationDays, 14, '步进器必须能从 1 增加到 14')
  assert.strictEqual(page.data.durationAtMax, true)
  for (let day = 14; day > 1; day -= 1) page.adjustDuration(durationStepEvent(-1))
  assert.strictEqual(page.data.preferences.durationDays, 1, '步进器必须能从 14 减少到 1')
  assert.strictEqual(page.data.durationAtMin, true)

  const wxml = fs.readFileSync(plannerWxmlPath, 'utf8')
  assert(/aria-label="增加一天"><text class="duration-symbol">\+<\/text><\/button>/.test(wxml),
    '增加天数按钮必须用独立文本节点稳定渲染加号')
  assert(/\.duration-symbol\s*\{[^}]*line-height:\s*48px[^}]*text-align:\s*center/.test(fs.readFileSync(plannerWxssPath, 'utf8')),
    '天数步进符号必须在 48px 触控区内稳定居中')
  assert(/\.duration-button\s*\{[^}]*box-sizing:\s*border-box[^}]*width:\s*48px[^}]*min-width:\s*0[^}]*max-width:\s*48px/.test(fs.readFileSync(plannerWxssPath, 'utf8')),
    '微信原生 button 的最小宽度不得把增加按钮挤出 48px 网格列')
  assert(/class="primary-button next-button"[^>]*disabled="\{\{currentStep === 1 && durationDaysError\}\}"/.test(wxml),
    '周期输入无效时下一步必须使用原生 disabled 状态')

  page.applyDurationDays(14)
  page.exerciseDurationDrafts = { 1: '30', 4: '45', 13: '60' }
  page.exerciseDurationInputErrors = { 1: '', 4: '请输入 1–360 的整数分钟', 13: '请输入 1–360 的整数分钟' }
  page.applyDurationDays(3)
  assert.strictEqual(page.data.preferences.exerciseByDay.length, 3, '缩短周期必须裁剪逐日运动数组')
  assert.deepStrictEqual(page.exerciseDurationDrafts, { 1: '30' }, '缩短周期必须裁剪已移除日期的时长草稿')
  assert.deepStrictEqual(page.exerciseDurationInputErrors, { 1: '' }, '缩短周期必须裁剪已移除日期的字段错误')
  assert.strictEqual(page.data.exerciseDays.length, 3)
  assert(page.data.exerciseDays.every((item) => item.dayIndex < 3), '界面不得残留已移除日期')
}

async function testSupportedDurationsReachAiStartWithoutZero() {
  for (const durationDays of Array.from({ length: 14 }, (_, index) => index + 1)) {
    resetMocks()
    const page = makePage()
    page.applyDurationDays(durationDays)
    page.setData({
      currentStep: 5,
      aiStatus: 'ready',
      providerRevision: TEST_PROVIDER_REVISION,
      aiDataConsentAccepted: true,
      preferences: {
        ...page.data.preferences,
        mealTypes: ['breakfast'],
        goals: ['均衡饮食'],
        exerciseIntent: 'none',
      },
    })
    page.applyTaskResponse = async () => {}
    await page.generatePlan()
    assert.strictEqual(calls.start, 1, `${durationDays} 天必须能发起 AI 生成`)
    assert.strictEqual(calls.startArgs[0][0].durationDays, durationDays)
    assert.strictEqual(calls.startArgs[0][4], TEST_PROVIDER_REVISION)
    assert.notStrictEqual(calls.startArgs[0][0].durationDays, 0, 'AI start 永远不能收到 0 天')
  }
}

function testExercisePlanValidationAndNearbyErrors() {
  resetMocks()
  const page = makePage()
  page.applyDurationDays(3)
  page.setData({ currentStep: 4 })
  page.renderPreferences(page.data.preferences)
  page.onExerciseIntentChange({ detail: { value: 'daily' } })
  page.toggleExercise(exerciseEvent(2, ''))
  page.goNext()

  assert.strictEqual(page.data.currentStep, 4, '运动字段不完整时不能进入确认步骤')
  assert.strictEqual(page.data.exerciseErrorsVisible, true)
  assert.strictEqual(page.data.exerciseDays[2].typeError, '请填写运动类型')
  assert.strictEqual(page.data.exerciseDays[2].durationError, '请输入 1–360 的整数分钟')
  assert.strictEqual(scrollCalls.at(-1).selector, '#exercise-day-2', '必须定位到第一个错误日期')

  page.inputExerciseType(exerciseEvent(2, '快走'))
  page.inputExerciseDuration(exerciseEvent(2, '0'))
  assert.strictEqual(page.validateStep(4), '第 3 天：请输入 1–360 的整数分钟')
  assert.strictEqual(page.data.exerciseDays[2].durationText, '0', '零值应保留以便用户看见并修正')

  page.inputExerciseDuration(exerciseEvent(2, '361'))
  assert.strictEqual(page.data.exerciseDays[2].durationText, '361', '超范围输入不能被静默截断为 360')
  assert.strictEqual(page.data.exerciseDays[2].durationError, '请输入 1–360 的整数分钟')
  assert.strictEqual(page.validateStep(4), '第 3 天：请输入 1–360 的整数分钟')

  page.inputExerciseDuration(exerciseEvent(2, '1.5'))
  assert.strictEqual(page.validateStep(4), '第 3 天：请输入 1–360 的整数分钟')
  page.inputExerciseDuration(exerciseEvent(2, '360'))
  assert.strictEqual(page.validateStep(4), '')
  assert.strictEqual(page.data.exerciseDays[2].durationError, '')
  page.goNext()
  assert.strictEqual(page.data.currentStep, 5, '边界值 360 必须允许进入确认步骤')

  const wxml = fs.readFileSync(plannerWxmlPath, 'utf8')
  const wxss = fs.readFileSync(plannerWxssPath, 'utf8')
  assert(wxml.includes('id="exercise-day-{{item.dayIndex}}"'), '运动错误必须可定位到具体日期')
  assert(wxml.includes('aria-invalid="{{item.typeError ? \'true\' : \'false\'}}"'))
  assert(wxml.includes('aria-invalid="{{item.durationError ? \'true\' : \'false\'}}"'))
  assert(wxml.includes('class="field-error" aria-role="alert"'), '错误必须显示在对应输入框附近')
  assert(/\.field-error\s*\{[^}]*font-size:\s*12px/.test(wxss), '字段错误提示在窄屏仍须清晰可读')
}

function testExplicitDietAndExerciseIntent() {
  resetMocks()
  const page = makePage()
  assert.strictEqual(page.data.preferences.exerciseIntent, '', '新用户必须从未确认状态开始')
  assert.strictEqual(page.validateStep(2), '请至少选择一个饮食目标或风格，或填写本次补充目标')
  page.updatePreferences({ styles: ['清淡低油'] })
  assert.strictEqual(page.validateStep(2), '')
  assert.strictEqual(page.validateStep(4), '请选择本周期不安排运动，或逐日安排运动')

  page.onExerciseIntentChange({ detail: { value: 'none' } })
  assert.strictEqual(page.data.preferences.exerciseIntent, 'none')
  assert.strictEqual(page.validateStep(4), '')
  assert.strictEqual(page.data.summaryRows.find((row) => row.label === '运动').value, '本周期不安排运动')

  page.onExerciseIntentChange({ detail: { value: 'daily' } })
  assert.strictEqual(page.validateStep(4), '请至少安排一天运动；若本周期不运动，请选择“不安排运动”')
  page.toggleExercise(exerciseEvent(0, ''))
  page.inputExerciseType(exerciseEvent(0, '快走'))
  page.inputExerciseDuration(exerciseEvent(0, '30'))
  assert.strictEqual(page.validateStep(4), '')

  const restoredLegacy = { ...page.data.preferences }
  delete restoredLegacy.exerciseIntent
  page.renderPreferences(restoredLegacy)
  assert.strictEqual(page.data.preferences.exerciseIntent, '', '旧偏好不得被误认为已经确认运动意图')

  const wxml = fs.readFileSync(plannerWxmlPath, 'utf8')
  assert(wxml.includes('value="none"') && wxml.includes('value="daily"'), '运动步骤必须提供两个明确选择')
  assert(wxml.includes("preferences.exerciseIntent === 'daily'"), '逐日运动编辑只在用户明确选择后展示')
}

async function main() {
  testSecondaryPageNavigation()
  await testPreferenceDraftDebounce()
  await testLifecycleFlushConsumesFailure()
  await testConnectRecoversTaskWhenAiIsUnconfigured()
  await testConnectKeepsPageLoadingUntilSharedRecoverySettles()
  await testConnectRestoresPreferenceOnlyOfflineCacheWithoutEnablingAi()
  await testCurrentFailureWithoutCachedTaskPreservesServiceStatus()
  await testCurrentFailureWithCachedTaskUsesRecoveryCopy()
  await testRefreshRecoversOnlySafeRecentFailureSummary()
  await testRecentFailureRecoveryIsOptionalAndCannotOverrideServiceStatus()
  testTaskDiagnosticStageStaysInMemoryAndResets()
  await testConsentProtocolVersionIsRequiredForReadyStatus()
  await testNormalizedServiceStatusReachesPageReadyState()
  await testStorageReadinessBlocksGenerationAndMapsSafeCopy()
  await testStorageFailureKeepsPendingStartForSameRequestRetry()
  await testRecoveryStorageFailureCannotLeaveServiceReady()
  await testRetryIsBlockedButCancelStillWorks()
  await testTerminalFailureActionsFollowFailurePolicy()
  testEditConditionsReturnsToFirstStepWithoutDroppingPreferences()
  await testFirstOutlineRequestRejectionFailsAtZeroWithoutRetry()
  await testGenerateRevalidatesEveryEditableStep()
  await testGenerateStartsOnlyAfterAllStepsPass()
  await testConsentIsRequiredAndResetWhenConditionsChange()
  await testPendingStartRetryKeepsOnlyTheSameConsent()
  testMobileFormAndFooterContract()
  testIntensityAndConsentPresentation()
  testNativeControlTheme()
  await testDurationInputNormalizationAndValidation()
  testDurationStepperAndShrinkCleanup()
  await testSupportedDurationsReachAiStartWithoutZero()
  testExercisePlanValidationAndNearbyErrors()
  testExplicitDietAndExerciseIntent()
  console.log('planner page behavior tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
