'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const healthPagePath = path.join(root, 'miniprogram', 'pages', 'health', 'health.js')
const guidePagePath = path.join(root, 'miniprogram', 'pages', 'guide', 'guide.js')
const mealEditPagePath = path.join(root, 'miniprogram', 'pages', 'meal-edit', 'meal-edit.js')
const guideWxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'guide', 'guide.wxml'), 'utf8')
const mealEditWxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'meal-edit', 'meal-edit.wxml'), 'utf8')
const legalWxss = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'legal', 'legal.wxss'), 'utf8')
assert(guideWxml.includes('本次修改已保存，正在同步'))
assert(guideWxml.includes('修改已保存，尚未同步'))
assert(!guideWxml.includes('本机已保存、尚未同步'))
assert(!guideWxml.includes('本次修改已先保存在本机'))
assert(guideWxml.includes('class="setting-row touch-target"'), '健康提醒整行必须可点并满足触控尺寸')
assert(guideWxml.includes('color="{{nativeControlColor}}"'), '健康提醒开关必须跟随明暗主题')
assert(guideWxml.includes("当前{{settings.calciumAnchorReminder ? '已开启' : '已关闭'}}"),
  '健康提醒开关必须向读屏说明当前状态')
assert(guideWxml.includes('这里显示你当前的提醒状态，可以随时按自己的需要开启或关闭。'),
  '提醒说明必须描述当前可操作状态，不能把初始默认值冒充当前状态')
assert(!guideWxml.includes('所有提醒默认关闭') && !guideWxml.includes('下方开关默认关闭'),
  '提醒页不能保留与当前已开启开关相冲突的默认状态文案')
const membershipPath = path.join(root, 'miniprogram', 'services', 'membership-store.js')
const healthStorePath = path.join(root, 'miniprogram', 'services', 'health-store.js')

assert(guideWxml.indexOf('class="surface setting-list"') < guideWxml.indexOf('wx:if="{{settings.calciumAnchorReminder}}"'),
  '提醒开关必须先于按需内容出现，让说明紧邻用户操作')
assert(!guideWxml.includes('没有启用专业健康提醒'), '关闭状态不能再用重复说明卡占据主要空间')
assert(guideWxml.includes('id="custom-reminder-input"') && guideWxml.includes('aria-label="个人提醒内容"'),
  '个人提醒输入框必须有稳定标识和可访问名称')
for (const label of ['个人餐名', '个人食材说明', '个人做法', '个人提示（可选）']) {
  assert(mealEditWxml.includes(`aria-label="${label}"`), `餐食编辑控件必须提供可访问名称：${label}`)
}
assert(legalWxss.includes('env(safe-area-inset-left)') && legalWxss.includes('env(safe-area-inset-right)'),
  '法律页必须避开横屏左右安全区')
for (const file of [
  path.join(root, 'miniprogram', 'pages', 'planner', 'planner.js'),
  path.join(root, 'miniprogram', 'pages', 'planner', 'planner.wxml'),
  path.join(root, 'miniprogram', 'pages', 'planner', 'planner.json'),
  path.join(root, 'miniprogram', 'pages', 'plan-preview', 'plan-preview.json'),
  path.join(root, 'miniprogram', 'pages', 'plan-history', 'plan-history.js'),
  path.join(root, 'miniprogram', 'pages', 'plan-history', 'plan-history.json'),
]) {
  assert(!fs.readFileSync(file, 'utf8').includes('计划'), `${path.basename(file)} 的用户文案必须统一为餐单`)
}
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
let rangeImplementation = async () => []
let saveDailyImplementation = async () => null
let canvasMeasurement = null
let themeHandler = null
let removedThemeHandler = null
const userPatchCalls = []
const healthSaveCalls = []
const modals = []
const modalResponses = []
const toasts = []
const unloadAlerts = []
let unloadAlertDisableCount = 0
const navigationCalls = []
const canvasContext = {
  transforms: [],
  operations: [],
  clearRect(...args) { this.operations.push(['clearRect', ...args]) },
  fillRect(...args) { this.operations.push(['fillRect', ...args]) },
  fillText(...args) { this.operations.push(['fillText', ...args]) },
  beginPath() { this.operations.push(['beginPath']) },
  moveTo(...args) { this.operations.push(['moveTo', ...args]) },
  lineTo(...args) { this.operations.push(['lineTo', ...args]) },
  stroke() { this.operations.push(['stroke']) },
  arc(...args) { this.operations.push(['arc', ...args]) },
  fill() { this.operations.push(['fill']) },
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
  getRange: (...args) => rangeImplementation(...args),
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
  setMealOverride: async () => null,
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
  showModal(options) {
    modals.push(options)
    const response = modalResponses.shift()
    if (response && typeof options.success === 'function') options.success(response)
  },
  showToast(options) { toasts.push(options) },
  enableAlertBeforeUnload(options) { unloadAlerts.push(options) },
  disableAlertBeforeUnload() { unloadAlertDisableCount += 1 },
  navigateBack(options) { navigationCalls.push({ type: 'back', options }) },
  switchTab(options) { navigationCalls.push({ type: 'tab', options }) },
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
  global.wx.getWindowInfo = () => ({ pixelRatio: 3 })
  global.wx.getAppBaseInfo = () => ({ theme: 'light' })
  global.wx.chooseMedia = undefined
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
  rangeImplementation = async () => []
  saveDailyImplementation = async () => null
  healthSaveCalls.length = 0
  modals.length = 0
  modalResponses.length = 0
  toasts.length = 0
  unloadAlerts.length = 0
  unloadAlertDisableCount = 0
  navigationCalls.length = 0
  userStore.setMealOverride = async () => null
  healthStore.state = 'ready'
  healthStore.error = ''
  canvasMeasurement = null
  canvasNode.width = 0
  canvasNode.height = 0
  canvasContext.transforms.length = 0
  canvasContext.operations.length = 0
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
  assert(canvasContext.operations.some(([name]) => name === 'fillRect'), '空态图表也必须绘制主题背景')
  assert(canvasContext.operations.some(([name]) => name === 'fillText'), '空态图表必须绘制可见提示，不能留下空白 Canvas')

  canvasContext.operations.length = 0
  page.setData({
    trendMode: 'month', trendMetric: 'weight',
    records: [{ date: '2026-08-24', weight: 62.1 }, { date: '2026-08-25', weight: 61.8 }],
  })
  page.drawTrend()
  assert(canvasContext.operations.some(([name]) => name === 'lineTo'), '两条体重记录必须绘制折线')
  assert.strictEqual(canvasContext.operations.filter(([name]) => name === 'arc').length, 2,
    '每条体重记录必须绘制一个趋势节点')

  page.measureTrendCanvas()
  assert.deepStrictEqual(canvasContext.transforms[1], [3, 0, 0, 3, 0, 0], '重复测量必须重置变换，不能累计缩放')

  delete global.wx.getWindowInfo
  page.measureTrendCanvas()
  assert.strictEqual(canvasNode.width, 320, '窗口信息不可用时必须安全回退到 1 倍 DPR')
  assert.strictEqual(canvasNode.height, 140)
  assert.deepStrictEqual(canvasContext.transforms[2], [1, 0, 0, 1, 0, 0])

  page.loadMonth = async () => {}
  page.onLoad()
  assert.strictEqual(typeof themeHandler, 'function')
  page.onUnload()
  assert.strictEqual(removedThemeHandler, themeHandler)
}

async function testExerciseActivityRingStatesAndTheme() {
  resetMocks()
  const page = makePage(loadPage(healthPagePath))
  page.drawTrendSoon = () => {}
  page.loadWeekTrend = async () => {}
  const date = '2026-08-28'

  page.setData({ records: [], selectedDate: date })
  page.selectDateValue(date)
  assert.strictEqual(page.data.exerciseStatus, '未打卡')
  assert.strictEqual(page.data.exerciseStatusHint, '打开开关，记录当天完成的运动')
  assert.strictEqual(page.data.exerciseStatusTone, 'idle')
  assert.strictEqual(page.data.exerciseDirty, false)
  assert.strictEqual(page.data.exerciseTypeIndex, -1, '空白日期不能预选运动类型')
  assert.strictEqual(page.data.exerciseDuration, '', '空白日期不能预填运动分钟数')
  assert.strictEqual(page.data.exerciseIntensity, '', '空白日期不能预选运动强度')

  page.toggleExercise({ detail: { value: true } })
  assert.strictEqual(page.data.exerciseStatus, '待保存')
  assert.strictEqual(page.data.exerciseStatusHint, '尚未打卡，填写本次运动并保存')
  assert.strictEqual(page.data.saveButtonText, '保存并完成打卡')
  assert.strictEqual(page.data.exerciseStatusTone, 'pending')
  assert.strictEqual(page.data.exerciseDirty, true)

  const saved = {
    date,
    recordRevision: 2,
    exercise: { completed: true, type: '快走', durationMinutes: 30, intensity: 'medium' },
  }
  page.setData({ records: [saved] })
  page.selectDateValue(date)
  assert.strictEqual(page.data.exerciseStatus, '已打卡')
  assert.strictEqual(page.data.exerciseStatusHint, '已保存，月历已显示运动标记')
  assert.strictEqual(page.data.saveButtonText, '保存当天记录')
  assert.strictEqual(page.data.exerciseStatusTone, 'saved')
  assert.strictEqual(page.data.exerciseStatusSymbol, '✓')
  assert.strictEqual(page.data.exerciseDirty, false)

  page.inputDuration({ detail: { value: '45' } })
  assert.strictEqual(page.data.exerciseStatus, '待更新')
  assert.strictEqual(page.data.exerciseStatusHint, '修改尚未生效，保存后更新月历标记')
  assert.strictEqual(page.data.saveButtonText, '保存运动修改')
  assert.strictEqual(page.data.exerciseStatusTone, 'pending')
  assert.strictEqual(page.data.exerciseDirty, true)

  page.inputDuration({ detail: { value: '30' } })
  assert.strictEqual(page.data.exerciseStatus, '已打卡', '改回云端值后必须恢复已保存状态')
  assert.strictEqual(page.data.exerciseDirty, false)

  page.toggleExercise({ detail: { value: false } })
  assert.strictEqual(page.data.exerciseStatus, '待取消')
  assert.strictEqual(page.data.exerciseStatusHint, '尚未生效，保存后取消月历运动标记')
  assert.strictEqual(page.data.saveButtonText, '保存并取消打卡')
  assert.strictEqual(page.data.exerciseStatusTone, 'cancel')
  assert.strictEqual(page.data.savedExerciseCompleted, true)

  page.applyTheme({ theme: 'dark' })
  assert.strictEqual(page.data.exerciseSwitchColor, '#72D49E')
  assert.strictEqual(page.currentTheme, 'dark')
  assert.strictEqual(page.chartPalette().surface, '#1b241f', 'Canvas 必须与主题事件共享 currentTheme')
  global.wx.getAppBaseInfo = () => { throw new Error('unsupported') }
  page.applyTheme({})
  assert.strictEqual(page.data.exerciseSwitchColor, '#72D49E', '主题查询异常时必须保留最近的主题事件')
  assert.strictEqual(page.chartPalette().surface, '#1b241f')
  page.applyTheme({ theme: 'light' })
  assert.strictEqual(page.data.exerciseSwitchColor, '#176B46')

  const fallbackPage = makePage(loadPage(healthPagePath))
  fallbackPage.drawTrendSoon = () => {}
  global.wx.getAppBaseInfo = undefined
  fallbackPage.applyTheme()
  assert.strictEqual(fallbackPage.currentTheme, 'light', '主题信息不可用时必须安全回退到默认浅色主题')
  assert.strictEqual(fallbackPage.data.exerciseSwitchColor, '#176B46')
  assert.strictEqual(fallbackPage.chartPalette().surface, '#ffffff')
}

async function testExerciseRequiresExplicitFieldChoices() {
  resetMocks()
  const page = makePage(loadPage(healthPagePath))
  page.drawTrendSoon = () => {}
  page.loadWeekTrend = async () => {}
  page.setData({ loading: false, error: '', records: [], selectedDate: '2026-08-28' })
  page.selectDateValue('2026-08-28')
  page.toggleExercise({ detail: { value: true } })

  await page.saveRecord()
  assert.strictEqual(page.data.exerciseTypeError, '请选择运动类型')
  assert.strictEqual(healthSaveCalls.length, 0)

  page.pickExerciseType({ detail: { value: '4' } })
  await page.saveRecord()
  assert.strictEqual(page.data.exerciseDurationError, '请输入 1–600 的整数分钟')
  assert.strictEqual(healthSaveCalls.length, 0)

  page.inputDuration({ detail: { value: '30' } })
  await page.saveRecord()
  assert.strictEqual(page.data.exerciseIntensityError, '请选择运动强度')
  assert.strictEqual(healthSaveCalls.length, 0)

  page.selectIntensity({ currentTarget: { dataset: { value: 'medium' } } })
  monthImplementation = async () => []
  await page.saveRecord()
  assert.strictEqual(healthSaveCalls.length, 1)
  assert.deepStrictEqual(healthSaveCalls[0][0].exercise, {
    completed: true, type: '快走', durationMinutes: 30, intensity: 'medium',
  })
}

async function testLateWeekTrendResponsesCannotReplaceCurrentDate() {
  resetMocks()
  const firstSuccess = deferred()
  const secondSuccess = deferred()
  let rangeCall = 0
  rangeImplementation = () => (++rangeCall === 1 ? firstSuccess.promise : secondSuccess.promise)
  const page = makePage(loadPage(healthPagePath))
  page.drawTrend = () => {}
  page.setData({ selectedDate: '2026-08-20' })
  const first = page.loadWeekTrend('2026-08-20')
  page.setData({ selectedDate: '2026-08-21' })
  const second = page.loadWeekTrend('2026-08-21')
  const currentRecords = [{ date: '2026-08-21', exercise: { completed: true, durationMinutes: 45 } }]
  secondSuccess.resolve(currentRecords)
  await second
  firstSuccess.resolve([{ date: '2026-08-20', exercise: { completed: true, durationMinutes: 10 } }])
  await first
  assert.deepStrictEqual(page.data.trendRecords, currentRecords, '旧日期成功响应不得覆盖当前日期')
  assert.strictEqual(page.data.weekExerciseMinutes, 45)

  const firstFailure = deferred()
  const secondAfterFailure = deferred()
  rangeCall = 0
  rangeImplementation = () => (++rangeCall === 1 ? firstFailure.promise : secondAfterFailure.promise)
  page.setData({ selectedDate: '2026-08-22' })
  const staleFailure = page.loadWeekTrend('2026-08-22')
  page.setData({ selectedDate: '2026-08-23' })
  const latest = page.loadWeekTrend('2026-08-23')
  const latestRecords = [{ date: '2026-08-23', exercise: { completed: true, durationMinutes: 30 } }]
  secondAfterFailure.resolve(latestRecords)
  await latest
  firstFailure.reject(new Error('旧请求失败'))
  await staleFailure
  assert.deepStrictEqual(page.data.trendRecords, latestRecords, '旧日期失败响应不得清空当前日期')
  assert.strictEqual(page.data.weekExerciseMinutes, 30)

  const unmounted = deferred()
  rangeImplementation = () => unmounted.promise
  page.setData({ selectedDate: '2026-08-24' })
  const afterUnload = page.loadWeekTrend('2026-08-24')
  page.onUnload()
  unmounted.resolve([{ date: '2026-08-24', exercise: { completed: true, durationMinutes: 90 } }])
  await afterUnload
  assert.strictEqual(page.data.weekExerciseMinutes, 30, '页面卸载后的迟到响应不得回写页面状态')
}

async function testWeekTrendMarksIncompleteCacheInsteadOfShowingZeroRecords() {
  resetMocks()
  const page = makePage(loadPage(healthPagePath))
  page.drawTrend = () => {}
  page.setData({ selectedDate: '2026-09-02' })
  rangeImplementation = async () => {
    const records = []
    Object.defineProperty(records, 'cacheInfo', {
      enumerable: false,
      value: { source: 'cache', complete: false, missingMonths: ['2026-08'] },
    })
    return records
  }

  await page.loadWeekTrend('2026-09-02')

  assert.strictEqual(page.data.weekTrendIncomplete, true)
  assert.strictEqual(page.data.weekExerciseCountDisplay, '—')
  assert.strictEqual(page.data.weekExerciseMinutesDisplay, '—')
  assert(page.data.weekTrendNotice.includes('缓存可能不完整'))

  rangeImplementation = async () => {
    const records = [{ date: '2026-09-01', exercise: { completed: true, durationMinutes: 25 } }]
    Object.defineProperty(records, 'cacheInfo', {
      enumerable: false,
      value: { source: 'cache', complete: false, missingMonths: ['2026-08'] },
    })
    return records
  }
  await page.loadWeekTrend('2026-09-02')
  assert.strictEqual(page.data.weekExerciseCountDisplay, '1+')
  assert.strictEqual(page.data.weekExerciseMinutesDisplay, '25+')

  const wxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'health', 'health.wxml'), 'utf8')
  assert(wxml.includes('bindtap="retryWeekTrend"'), '近 7 天缓存提示必须可点击重试')
}

async function testPhotoActionsKeepFormErrorRelevant() {
  resetMocks()
  const page = makePage(loadPage(healthPagePath))
  page.setData({ formError: '至少填写体重、运动、照片或备注中的一项' })
  global.wx.chooseMedia = ({ success }) => success({
    tempFiles: [{ size: 100, tempFilePath: 'wxfile://health-photo' }],
  })
  await page.choosePhoto()
  assert.strictEqual(page.data.formError, '', '成功选择照片后必须清理空表单错误')

  page.setData({ weight: '60', formError: '不相关旧错误' })
  page.removePhoto()
  assert.strictEqual(page.data.formError, '', '仍有其他表单内容时移除照片不得留下旧错误')

  page.setData({ weight: '', note: '', exerciseCompleted: false, savedExerciseCompleted: false, formError: '' })
  page.removePhoto()
  assert.strictEqual(page.data.formError, '至少填写体重、运动、照片或备注中的一项')
}

async function testDeletingOnlySavedPhotoIsValidRecordChange() {
  resetMocks()
  const date = '2026-08-28'
  const savedPhotoRecord = {
    date, recordRevision: 3, hasPhoto: true, photoFileId: 'cloud://saved-photo', photoUrl: 'https://example.invalid/photo',
  }
  monthImplementation = async () => {
    healthStore.state = 'ready'
    return []
  }
  const page = makePage(loadPage(healthPagePath))
  page.drawTrendSoon = () => {}
  page.loadWeekTrend = async () => {}
  page.setData({
    loading: false, error: '', month: '2026-08', selectedDate: date, selectedRecord: savedPhotoRecord,
    selectedRecordRevision: 3, records: [savedPhotoRecord], weight: '', note: '', exerciseCompleted: false,
    savedExerciseCompleted: false, photoPreview: savedPhotoRecord.photoUrl, photoFileId: savedPhotoRecord.photoFileId,
    photoLocalPath: '', clearPhoto: false,
  })

  page.removePhoto()
  assert.strictEqual(page.data.formError, '', '删除唯一已保存照片是有效操作，不应显示空表单错误')
  await page.saveRecord()

  assert.strictEqual(healthSaveCalls.length, 1, '删除唯一已保存照片必须通过表单门禁并调用保存')
  assert.strictEqual(healthSaveCalls[0][0].clearPhoto, true)
  assert.strictEqual(healthSaveCalls[0][0].expectedRecordRevision, 3)
  assert.strictEqual(toasts.some((item) => item.title === '至少记录一项内容'), false)
}

async function testExerciseSummaryFlagsAndCancellationSave() {
  resetMocks()
  const page = makePage(loadPage(healthPagePath))
  page.drawTrendSoon = () => {}
  page.loadWeekTrend = async () => {}
  const date = '2026-08-28'
  const saved = {
    date,
    recordRevision: 2,
    exercise: { completed: true, type: '快走', durationMinutes: 30, intensity: 'medium' },
  }
  page.setData({ loading: false, error: '', month: '2026-08', selectedDate: date, records: [saved] })
  page.renderCalendar()
  assert.strictEqual(page.data.hasMonthExercise, true)
  assert.strictEqual(page.data.monthExerciseCount, 1)

  page.selectDateValue(date)
  page.toggleExercise({ detail: { value: false } })
  monthImplementation = async () => {
    healthStore.state = 'ready'
    return []
  }
  await page.saveRecord()

  assert.strictEqual(healthSaveCalls.length, 1, '只有运动的当天也必须允许保存取消打卡')
  assert.strictEqual(healthSaveCalls[0][0].exercise, null)
  assert.strictEqual(page.data.hasMonthExercise, false)
  assert.strictEqual(page.data.monthExerciseCount, 0)
  assert.strictEqual(page.data.exerciseStatus, '未打卡')
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

async function testHealthDraftGuardsEveryRecordField() {
  resetMocks()
  const date = '2026-08-26'
  const nextDate = '2026-08-27'
  const saved = {
    date, recordRevision: 2, weight: 60, note: '原备注', hasPhoto: true,
    photoFileId: 'saved-photo', photoUrl: 'https://example.invalid/saved-photo',
    exercise: { completed: true, type: '快走', durationMinutes: 30, intensity: 'medium' },
  }
  const page = makePage(loadPage(healthPagePath))
  page.drawTrendSoon = () => {}
  page.loadWeekTrend = async () => {}
  page.setData({ loading: false, error: '', month: '2026-08', records: [saved] })
  page.selectDateValue(date)

  page.inputWeight({ detail: { value: '61' } })
  assert.strictEqual(page.data.recordDirty, true)
  assert.strictEqual(unloadAlerts.length, 1, '修改体重后必须启用系统离页提醒')
  modalResponses.push({ confirm: false })
  await page.selectDate({ currentTarget: { dataset: { date: nextDate } } })
  assert.strictEqual(page.data.selectedDate, date, '取消确认时必须保留当前日期和草稿')
  assert.strictEqual(page.data.weight, '61')

  page.inputWeight({ detail: { value: '60' } })
  page.inputNote({ detail: { value: '新备注' } })
  assert.strictEqual(page.data.recordDirty, true, '备注修改必须纳入统一 dirty 状态')
  page.inputNote({ detail: { value: '原备注' } })
  page.inputDuration({ detail: { value: '45' } })
  assert.strictEqual(page.data.recordDirty, true, '运动修改必须纳入统一 dirty 状态')
  page.inputDuration({ detail: { value: '30' } })
  page.removePhoto()
  assert.strictEqual(page.data.recordDirty, true, '删除已保存照片必须纳入统一 dirty 状态')
  modalResponses.push({ confirm: true })
  await page.selectDate({ currentTarget: { dataset: { date: nextDate } } })
  assert.strictEqual(page.data.selectedDate, nextDate)
  assert.strictEqual(page.data.recordDirty, false)

  page.setData({ selectedRecord: null, weight: '', note: '', photoLocalPath: 'wxfile://new-photo', clearPhoto: false })
  page.refreshDraftState()
  assert.strictEqual(page.data.recordDirty, true, '新选照片必须纳入统一 dirty 状态')
  modalResponses.push({ confirm: false })
  await page.changeMonth(1)
  assert.strictEqual(page.data.month, '2026-08', '取消切月确认时必须保留月份和照片草稿')
}

async function testMealEditGuardsCustomAndNativeBack() {
  resetMocks()
  const page = makePage(loadPage(mealEditPagePath))
  page.setData({
    loading: false, error: '',
    loadedForm: { title: '原餐名', ingredients: '原食材', method: '原做法', tag: '' },
    form: { title: '原餐名', ingredients: '原食材', method: '原做法', tag: '' },
  })
  page.setData({ form: { ...page.data.form, title: '新餐名' } })
  page.refreshDirtyState()
  assert.strictEqual(page.data.formDirty, true)
  assert.strictEqual(unloadAlerts.length, 1, '修改餐食后必须保护系统和手势返回')
  modalResponses.push({ confirm: false })
  await page.navigateFromPage()
  assert.strictEqual(navigationCalls.length, 0, '取消离页时不得导航')
  assert.strictEqual(page.data.form.title, '新餐名')
  modalResponses.push({ confirm: true })
  await page.navigateFromPage()
  assert.strictEqual(navigationCalls.at(-1).type, 'tab', '确认放弃后应返回餐单页')
  assert(unloadAlertDisableCount > 0, '确认放弃前必须关闭系统离页提醒')
}

async function testReminderDeletionConfirmationAndRollback() {
  resetMocks()
  const reminder = { id: 'keep-me', text: '复诊时带瓶身', done: false }
  userStore.data.customReminders = [reminder]
  const page = makePage(loadPage(guidePagePath))
  page.render()

  modalResponses.push({ confirm: false })
  await page.removeReminder({ currentTarget: { dataset: { id: reminder.id } } })
  assert.deepStrictEqual(userStore.data.customReminders, [reminder], '取消删除必须保留原提醒')
  assert.strictEqual(userPatchCalls.length, 0)

  userPatchImplementation = async (partial, options) => {
    userStore.data = { ...userStore.data, ...partial }
    if (options && options.localOnly) return userStore.data
    userStore.state = 'offline'
    userStore.error = '同步失败'
    throw new Error('同步失败')
  }
  modalResponses.push({ confirm: true })
  await page.removeReminder({ currentTarget: { dataset: { id: reminder.id } } })
  assert.deepStrictEqual(userStore.data.customReminders, [reminder], '删除同步失败时必须恢复原提醒')
  assert.deepStrictEqual(page.data.reminders, [reminder])
  assert(userPatchCalls.some(({ options }) => options && options.localOnly), '失败回滚必须更新本地待同步状态')
  assert(toasts.some(({ title }) => title === '删除失败，提醒已保留'))
}

async function testEmptyRevisionMarkerRefreshesAndRebuildsWithoutDisplayingContent() {
  resetMocks()
  const date = '2026-08-27'
  const emptyMarker = { date, recordRevision: 6, empty: true }
  const page = makePage(loadPage(healthPagePath))
  page.drawTrendSoon = () => {}
  page.loadWeekTrend = async () => {}
  page.setData({
    loading: false, error: '', month: '2026-08', selectedDate: date,
    records: [emptyMarker], weight: '', note: '', exerciseCompleted: false,
    photoPreview: '', photoLocalPath: '', clearPhoto: false,
  })

  page.renderCalendar()
  page.selectDateValue(date)
  assert.strictEqual(page.data.selectedRecordRevision, 6,
    '页面必须保留当前空态版本供下一次 CAS 写入')
  assert.strictEqual(page.data.weight, '')
  assert.strictEqual(page.data.note, '')
  assert.strictEqual(page.data.exerciseCompleted, false)
  assert.strictEqual(page.data.photoPreview, '')
  const cell = page.data.cells.find((item) => item.date === date)
  assert(cell && !cell.weightText && !cell.exercised && !cell.hasPhoto,
    '空态版本标记不能在月历显示体重、运动或照片')

  page.setData({ note: '刷新空态后重建' })
  monthImplementation = async () => {
    healthStore.state = 'ready'
    return [{ date, recordRevision: 7, note: '刷新空态后重建' }]
  }
  await page.saveRecord()
  assert.strictEqual(healthSaveCalls.length, 1)
  assert.strictEqual(healthSaveCalls[0][0].expectedRecordRevision, 6,
    '空态重建必须发送月读取得到的当前版本')
}

async function testGuideLoadingFailureAndRetry() {
  resetMocks()
  const definition = loadPage(guidePagePath)
  const themedPage = makePage(definition)
  themedPage.applyTheme({ theme: 'dark' })
  assert.strictEqual(themedPage.data.nativeControlColor, '#72D49E')
  themedPage.applyTheme({ theme: 'light' })
  assert.strictEqual(themedPage.data.nativeControlColor, '#176B46')
  await themedPage.onLoad()
  assert.strictEqual(typeof themeHandler, 'function')
  themedPage.onUnload()
  assert.strictEqual(removedThemeHandler, themeHandler)

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
  for (const file of [healthPagePath, guidePagePath]) {
    assert(!fs.readFileSync(file, 'utf8').includes('getSystemInfoSync'), `${path.basename(file)} 不得继续调用已废弃的 getSystemInfoSync`)
  }
  await testHealthReadyEmptyMonth()
  await testHealthOfflineWithoutSnapshotIsError()
  await testHealthOfflineWithSnapshotRemainsUsable()
  await testLateMonthResponseCannotReplaceCurrentMonth()
  await testHealthCanvasUsesMeasuredDprAndThemeLifecycle()
  await testExerciseActivityRingStatesAndTheme()
  await testExerciseRequiresExplicitFieldChoices()
  await testLateWeekTrendResponsesCannotReplaceCurrentDate()
  await testWeekTrendMarksIncompleteCacheInsteadOfShowingZeroRecords()
  await testPhotoActionsKeepFormErrorRelevant()
  await testDeletingOnlySavedPhotoIsValidRecordChange()
  await testExerciseSummaryFlagsAndCancellationSave()
  await testHealthConflictRefreshesWithoutAutomaticOverwrite()
  await testHealthDraftGuardsEveryRecordField()
  await testEmptyRevisionMarkerRefreshesAndRebuildsWithoutDisplayingContent()
  await testMealEditGuardsCustomAndNativeBack()
  await testGuideLoadingFailureAndRetry()
  await testGuidePersistsAndReportsOfflineWithoutRollback()
  await testReminderDeletionConfirmationAndRollback()
  await tick()
  console.log('health and guide page state tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
