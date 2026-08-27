'use strict'

const assert = require('assert')
const path = require('path')

const root = path.resolve(__dirname, '..')
const healthPagePath = path.join(root, 'miniprogram', 'pages', 'health', 'health.js')
const guidePagePath = path.join(root, 'miniprogram', 'pages', 'guide', 'guide.js')
const membershipPath = path.join(root, 'miniprogram', 'services', 'membership-store.js')
const healthStorePath = path.join(root, 'miniprogram', 'services', 'health-store.js')
const userStorePath = path.join(root, 'miniprogram', 'services', 'user-store.js')

let pageDefinition
const membershipCalls = []
const userInitCalls = []
let membershipImplementation = async () => ({ status: 'active' })
let userInitImplementation = async () => userStore.data
let userPatchImplementation
let userFlushImplementation
let cachedMonth = false
let monthImplementation = async () => []
let saveDailyImplementation = async () => null
let canvasMeasurement = null
let themeHandler = null
let removedThemeHandler = null
const userPatchCalls = []
const healthSaveCalls = []
const modals = []
const toasts = []
const canvasContext = {
  transforms: [],
  clearRect() {}, fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
  setTransform(...args) { this.transforms.push(args) },
}
const canvasNode = {
  width: 0,
  height: 0,
  getContext(type) {
    assert.strictEqual(type, '2d')
    return canvasContext
  },
}

const membershipStore = {
  init(options) {
    membershipCalls.push(options || {})
    return membershipImplementation(options || {})
  },
}

const healthStore = {
  state: 'ready',
  error: '',
  hasCachedMonth: () => cachedMonth,
  getMonth: (...args) => monthImplementation(...args),
  getRange: async () => [],
  saveDaily: (...args) => {
    healthSaveCalls.push(args)
    return saveDailyImplementation(...args)
  },
}

const userStore = {
  data: {
    settings: { calciumAnchorReminder: false, vitaminDReminder: false },
    customReminders: [],
  },
  state: 'ready',
  error: '',
  init(options) {
    userInitCalls.push(options || {})
    return userInitImplementation(options || {})
  },
  flush() { return userFlushImplementation() },
  patch(partial, options) {
    userPatchCalls.push({ partial, options })
    return userPatchImplementation(partial, options)
  },
}

require.cache[membershipPath] = {
  id: membershipPath, filename: membershipPath, loaded: true, exports: { membershipStore },
}
require.cache[healthStorePath] = {
  id: healthStorePath, filename: healthStorePath, loaded: true, exports: {
    healthStore,
    isRecordRevisionConflict: (error) => Boolean(error && error.code === 'HEALTH_RECORD_REVISION_CONFLICT'),
  },
}
require.cache[userStorePath] = {
  id: userStorePath, filename: userStorePath, loaded: true, exports: { userStore },
}

global.wx = {
  reLaunch() {},
  stopPullDownRefresh() {},
  createSelectorQuery() {
    return {
      in() { return this },
      select(selector) {
        assert.strictEqual(selector, '#weightChart')
        return this
      },
      fields(options) {
        assert.deepStrictEqual(options, { node: true, size: true })
        return this
      },
      exec(callback) { callback(canvasMeasurement ? [canvasMeasurement] : []) },
    }
  },
  getWindowInfo: () => ({ pixelRatio: 3 }),
  getAppBaseInfo: () => ({ theme: 'light' }),
  onThemeChange(handler) { themeHandler = handler },
  offThemeChange(handler) { removedThemeHandler = handler },
  showLoading() {},
  hideLoading() {},
  showModal(options) { modals.push(options) },
  showToast(options) { toasts.push(options) },
}
global.Page = (definition) => { pageDefinition = definition }

function loadPage(file) {
  pageDefinition = null
  delete require.cache[file]
  require(file)
  assert(pageDefinition, `${file} 必须注册页面`)
  return pageDefinition
}

function makePage(definition) {
  const page = Object.create(definition)
  page.data = JSON.parse(JSON.stringify(definition.data))
  page.setData = (partial, callback) => {
    Object.assign(page.data, partial)
    if (callback) callback()
  }
  return page
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

async function tick() {
  await new Promise((resolve) => setImmediate(resolve))
}

function resetMocks() {
  membershipCalls.length = 0
  userInitCalls.length = 0
  membershipImplementation = async () => ({ status: 'active' })
  userInitImplementation = async () => userStore.data
  userPatchImplementation = async (partial) => {
    userStore.data = { ...userStore.data, ...partial }
    userStore.state = 'ready'
    userStore.error = ''
    return userStore.data
  }
  userFlushImplementation = async () => {
    userStore.state = 'ready'
    userStore.error = ''
    return userStore.data
  }
  userPatchCalls.length = 0
  userStore.data = {
    settings: { calciumAnchorReminder: false, vitaminDReminder: false },
    customReminders: [],
  }
  userStore.state = 'ready'
  userStore.error = ''
  cachedMonth = false
  monthImplementation = async () => {
    healthStore.state = 'ready'
    healthStore.error = ''
    return []
  }
  saveDailyImplementation = async () => null
  healthSaveCalls.length = 0
  modals.length = 0
  toasts.length = 0
  healthStore.state = 'ready'
  healthStore.error = ''
  canvasMeasurement = null
  canvasNode.width = 0
  canvasNode.height = 0
  canvasContext.transforms.length = 0
  themeHandler = null
  removedThemeHandler = null
}

async function testHealthReadyEmptyMonth() {
  resetMocks()
  const definition = loadPage(healthPagePath)
  const page = makePage(definition)
  page.drawTrendSoon = () => {}
  page.loadWeekTrend = async () => {}

  await page.loadMonth()

  assert.strictEqual(page.data.loading, false)
  assert.strictEqual(page.data.error, '')
  assert.strictEqual(page.data.offline, false)
  assert.strictEqual(page.data.cells.length, 42, '云端返回合法空月份时仍应显示完整空月历')
}

async function testHealthOfflineWithoutSnapshotIsError() {
  resetMocks()
  monthImplementation = async () => {
    healthStore.state = 'offline'
    healthStore.error = '网络不可用'
    return []
  }
  const page = makePage(loadPage(healthPagePath))
  page.drawTrendSoon = () => {}
  page.loadWeekTrend = async () => {}

  await page.loadMonth()

  assert.strictEqual(page.data.loading, false)
  assert.strictEqual(page.data.error, '网络不可用')
  assert.strictEqual(page.data.offline, false)
  assert.deepStrictEqual(page.data.cells, [], '没有可信快照时不能显示可编辑空月历')
}

async function testHealthOfflineWithSnapshotRemainsUsable() {
  resetMocks()
  cachedMonth = true
  monthImplementation = async () => {
    healthStore.state = 'offline'
    healthStore.error = '网络不可用'
    return [{ date: '2026-08-01', weight: 61.8 }]
  }
  const page = makePage(loadPage(healthPagePath))
  page.drawTrendSoon = () => {}
  page.loadWeekTrend = async () => {}

  await page.loadMonth()

  assert.strictEqual(page.data.error, '')
  assert.strictEqual(page.data.offline, true)
  assert.strictEqual(page.data.records.length, 1)
  assert.strictEqual(page.data.cells.length, 42)
}

async function testLateMonthResponseCannotReplaceCurrentMonth() {
  resetMocks()
  const august = deferred()
  const september = deferred()
  monthImplementation = async (month) => {
    const records = await (month === '2026-08' ? august.promise : september.promise)
    healthStore.state = 'ready'
    return records
  }
  const page = makePage(loadPage(healthPagePath))
  page.drawTrendSoon = () => {}
  page.loadWeekTrend = async () => {}
  page.setData({ month: '2026-08', monthText: '2026 年 8 月', selectedDate: '2026-08-01' })

  const first = page.loadMonth()
  page.setData({ month: '2026-09', selectedDate: '2026-09-01' })
  const second = page.loadMonth()
  september.resolve([{ date: '2026-09-01', weight: 60 }])
  await second
  august.resolve([{ date: '2026-08-01', weight: 70 }])
  await first

  assert.strictEqual(page.data.month, '2026-09')
  assert.deepStrictEqual(page.data.records, [{ date: '2026-09-01', weight: 60 }])
  assert.strictEqual(page.data.monthText.includes('9'), true)
}

async function testHealthCanvasUsesMeasuredDprAndThemeLifecycle() {
  resetMocks()
  canvasMeasurement = { node: canvasNode, width: 320, height: 140 }
  const page = makePage(loadPage(healthPagePath))
  page.setData({ loading: false, error: '', records: [] })

  page.measureTrendCanvas()
  assert.strictEqual(canvasNode.width, 960)
  assert.strictEqual(canvasNode.height, 420)
  assert.deepStrictEqual(canvasContext.transforms, [[3, 0, 0, 3, 0, 0]])

  page.measureTrendCanvas()
  assert.deepStrictEqual(canvasContext.transforms[1], [3, 0, 0, 3, 0, 0], '重复测量必须重置变换，不能累计缩放')

  page.loadMonth = async () => {}
  page.onLoad()
  assert.strictEqual(typeof themeHandler, 'function')
  page.onUnload()
  assert.strictEqual(removedThemeHandler, themeHandler)
}

async function testHealthConflictRefreshesWithoutAutomaticOverwrite() {
  resetMocks()
  const date = '2026-08-26'
  const latest = {
    date, recordRevision: 4, weight: 60, note: '设备 A 新备注', exercise: null,
    hasPhoto: false, photoFileId: '', photoUrl: '',
  }
  saveDailyImplementation = async (record) => {
    assert.strictEqual(record.expectedRecordRevision, 3)
    const error = new Error('这一天已在其他设备更新，请刷新后重新确认')
    error.code = 'HEALTH_RECORD_REVISION_CONFLICT'
    throw error
  }
  monthImplementation = async () => {
    healthStore.state = 'ready'
    healthStore.error = ''
    return [latest]
  }
  const page = makePage(loadPage(healthPagePath))
  page.drawTrendSoon = () => {}
  page.loadWeekTrend = async () => {}
  page.setData({
    loading: false, error: '', month: '2026-08', selectedDate: date,
    records: [{ ...latest, recordRevision: 3, note: '设备 B 旧备注' }],
    selectedRecordRevision: 3, weight: '61', note: '设备 B 想保存的备注',
    exerciseCompleted: false, photoPreview: '', photoLocalPath: '', clearPhoto: false,
  })

  await page.saveRecord()

  assert.strictEqual(healthSaveCalls.length, 1, '页面冲突后不得自动再次保存')
  assert.strictEqual(page.data.selectedRecordRevision, 4)
  assert.strictEqual(page.data.note, '设备 A 新备注', '冲突后必须显示云端最新值供用户重新确认')
  assert.strictEqual(page.data.weight, '60')
  assert.strictEqual(modals.length, 1)
  assert.strictEqual(modals[0].title, '记录已在其他设备更新')
  assert(modals[0].content.includes('重新核对'))
  assert.strictEqual(toasts.some((item) => item.title === '记录已保存'), false)
}

async function testGuideLoadingFailureAndRetry() {
  resetMocks()
  const definition = loadPage(guidePagePath)
  const readyPage = makePage(definition)
  assert.strictEqual(readyPage.data.loading, true)
  await readyPage.connect()
  assert.strictEqual(readyPage.data.loading, false)
  assert.strictEqual(readyPage.data.error, '')

  membershipImplementation = async () => { throw new Error('身份连接失败') }
  const failedPage = makePage(definition)
  await failedPage.connect()
  assert.strictEqual(failedPage.data.loading, false)
  assert.strictEqual(failedPage.data.error, '身份连接失败')

  membershipImplementation = async () => ({ status: 'active' })
  await failedPage.retryConnect()
  assert.strictEqual(failedPage.data.error, '')
  assert.strictEqual(failedPage.data.loading, false)
  assert.deepStrictEqual(membershipCalls[membershipCalls.length - 1], { force: true })
  assert.deepStrictEqual(userInitCalls[userInitCalls.length - 1], { force: true })
}

async function testGuidePersistsAndReportsOfflineWithoutRollback() {
  resetMocks()
  const page = makePage(loadPage(guidePagePath))
  page.setData({ loading: false, newReminder: '复诊时带钙片瓶身' })

  await page.addReminder()
  assert.strictEqual(userPatchCalls.length, 1)
  assert.deepStrictEqual(userPatchCalls[0].options, { immediate: true })
  assert.strictEqual(page.data.reminders.length, 1)
  assert.strictEqual(page.data.offline, false)
  assert.strictEqual(page.data.saving, false)

  userPatchImplementation = async (partial) => {
    userStore.data = { ...userStore.data, ...partial }
    userStore.state = 'offline'
    userStore.error = '网络不可用'
    throw new Error('网络不可用')
  }
  page.setData({ newReminder: '下次复诊提问' })
  await page.addReminder()
  assert.strictEqual(userStore.data.customReminders.length, 2, '云端失败后本机变更必须保留')
  assert.strictEqual(page.data.reminders.length, 2)
  assert.strictEqual(page.data.newReminder, '')
  assert.strictEqual(page.data.offline, true)
  assert.strictEqual(page.data.saveError, '网络不可用')
  assert.strictEqual(page.data.saving, false)

  userFlushImplementation = async () => {
    userStore.state = 'ready'
    userStore.error = ''
    return userStore.data
  }
  await page.retrySync()
  assert.strictEqual(page.data.offline, false)
  assert.strictEqual(page.data.saveError, '')
  assert.strictEqual(page.data.saving, false)
}

async function main() {
  await testHealthReadyEmptyMonth()
  await testHealthOfflineWithoutSnapshotIsError()
  await testHealthOfflineWithSnapshotRemainsUsable()
  await testLateMonthResponseCannotReplaceCurrentMonth()
  await testHealthCanvasUsesMeasuredDprAndThemeLifecycle()
  await testHealthConflictRefreshesWithoutAutomaticOverwrite()
  await testGuideLoadingFailureAndRetry()
  await testGuidePersistsAndReportsOfflineWithoutRollback()
  await tick()
  console.log('health and guide page state tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
