'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  CALENDAR_REPEAT_DAYS,
  reminderTimes,
  buildCalendarEntries,
  canUseRepeatCalendar,
  installCalendarEntries,
} = require('../miniprogram/services/water-reminder-calendar')

const root = path.resolve(__dirname, '..')
const enabled = {
  enabled: true,
  cadence: 'daily',
  startTime: '09:00',
  endTime: '18:00',
  intervalMinutes: 60,
  timeZone: 'Asia/Shanghai',
  scheduleVersion: 1,
  updatedAt: '2026-09-02T00:00:00.000Z',
}
const nowMs = Date.parse('2026-09-02T02:15:00.000Z')

assert.strictEqual(CALENDAR_REPEAT_DAYS, 30)
assert.deepStrictEqual(reminderTimes(enabled), [
  '09:00', '10:00', '11:00', '12:00', '13:00',
  '14:00', '15:00', '16:00', '17:00', '18:00',
], 'start and end times must both be included')

const daily = buildCalendarEntries(enabled, nowMs)
assert.strictEqual(daily.length, 10)
daily.forEach((entry) => {
  assert.strictEqual(entry.options.repeatInterval, 'day')
  assert(entry.options.startTime > Math.floor(nowMs / 1000), 'calendar entry must start in the future')
})

const weekdays = buildCalendarEntries({ ...enabled, cadence: 'weekdays' }, nowMs)
assert.strictEqual(weekdays.length, 50, 'each time needs five weekly calendar rules')
assert.strictEqual(new Set(weekdays.map((entry) => entry.key)).size, weekdays.length)
weekdays.forEach((entry) => {
  assert.strictEqual(entry.options.repeatInterval, 'week')
  assert(entry.options.startTime > Math.floor(nowMs / 1000))
})

assert.deepStrictEqual(buildCalendarEntries({ ...enabled, enabled: false }, nowMs), [])
assert.strictEqual(canUseRepeatCalendar({}), false)
assert.strictEqual(canUseRepeatCalendar({ addPhoneRepeatCalendar() {}, canIUse: () => false }), false)
assert.strictEqual(canUseRepeatCalendar({ addPhoneRepeatCalendar() {}, canIUse: () => true }), true)

async function testCalendarCalls() {
  let calls = 0
  const disabledEntries = buildCalendarEntries({ ...enabled, enabled: false }, nowMs)
  const disabledResult = await installCalendarEntries({
    addPhoneRepeatCalendar() { calls += 1 },
    canIUse: () => true,
  }, disabledEntries)
  assert.strictEqual(disabledResult.total, 0)
  assert.strictEqual(calls, 0, 'disabled reminders must never call the calendar API')

  await assert.rejects(installCalendarEntries({}, daily), (error) => error.code === 'CALENDAR_API_UNAVAILABLE')

  calls = 0
  const denied = await installCalendarEntries({
    canIUse: () => true,
    addPhoneRepeatCalendar(options) {
      calls += 1
      if (calls === 1) options.success({})
      else options.fail({ errMsg: 'addPhoneRepeatCalendar:fail auth deny' })
    },
  }, daily.slice(0, 4))
  assert.deepStrictEqual(
    { created: denied.created, failed: denied.failed, skipped: denied.skipped, permissionDenied: denied.permissionDenied },
    { created: 1, failed: 1, skipped: 2, permissionDenied: true },
  )
  assert.strictEqual(calls, 2, 'permission denial must stop further calendar writes')

  calls = 0
  const partial = await installCalendarEntries({
    canIUse: () => true,
    addPhoneRepeatCalendar(options) {
      calls += 1
      if (calls === 2) options.fail({ errMsg: 'temporary failure' })
      else options.success({})
    },
  }, daily.slice(0, 3))
  assert.deepStrictEqual(
    { created: partial.created, failed: partial.failed, skipped: partial.skipped, permissionDenied: partial.permissionDenied },
    { created: 2, failed: 1, skipped: 0, permissionDenied: false },
  )

  calls = 0
  let keepInstalling = true
  const cancelled = await installCalendarEntries({
    canIUse: () => true,
    addPhoneRepeatCalendar(options) { calls += 1; options.success({}) },
  }, daily.slice(0, 3), () => { keepInstalling = false }, { shouldContinue: () => keepInstalling })
  assert.deepStrictEqual(
    { created: cancelled.created, skipped: cancelled.skipped, cancelled: cancelled.cancelled },
    { created: 1, skipped: 2, cancelled: true },
  )
  assert.strictEqual(calls, 1, 'cancellation must stop remaining calendar writes')
}

function testPageIntegration() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram', 'app.json'), 'utf8'))
  const page = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'water-reminder', 'water-reminder.js'), 'utf8')
  const markup = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'water-reminder', 'water-reminder.wxml'), 'utf8')
  const profile = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'profile', 'profile.wxml'), 'utf8')
  assert(app.pages.includes('pages/water-reminder/water-reminder'))
  assert(profile.includes('bindtap="openWaterReminder"'))
  assert(page.includes('async retrySync()'))
  assert(page.includes('const state = await userStore.flush()'), 'retry must flush the existing pending value')
  const retryMethod = page.slice(page.indexOf('async retrySync()'), page.indexOf('async addToCalendar()'))
  assert(!/scheduleVersion\s*:/.test(retryMethod), 'retry must not increment scheduleVersion')
  assert(markup.includes("(syncPending && !dirty) ? '重试同步' : '保存设置'"))
  assert(!/disabled="[^"]*saveError/.test(markup), 'a save error must not disable retry')
  assert(markup.includes('周一至周五模式会为每个时间点分别创建 5 条每周规则'))
  assert.strictEqual((markup.match(/<picker[^>]+aria-label=/g) || []).length, 3)
  assert(page.includes("const syncPending = hasWaterReminderPending()"))
  assert(page.includes('if (this.data.syncPending && !this.data.dirty) return this.retrySync()'))
  assert(page.includes('reminderForSave(this.data.draft, this.data.saved)'),
    '关闭提醒时必须允许以最后保存的有效排程修复隐藏的无效草稿')
  assert(page.includes('结束时间必须晚于开始时间'))
  assert(page.includes('如果以前添加过相同排程，本次操作会产生重复事项'))
  assert(!page.includes("const hasPriorWrites = this.data.calendarStatus"),
    'duplicate warning must not depend on the current page session')
  assert(page.includes("this.enableLeaveAlert('正在添加系统日历事项，离开可能只完成部分添加。')"))
  assert(markup.includes('disabled="{{calendarInstalling || calendarActionLocked}}"'))
  assert(markup.includes('calendarInstalling || calendarActionLocked || saving'))
  assert(page.includes('this.calendarActionLocked = true'))
  assert(page.includes('if (this.calendarInstallToken) this.calendarInstallToken.cancelled = true'))
}

function testDisabledReminderCanSaveAfterInvalidScheduleEdit() {
  const previousPage = global.Page
  const previousWx = global.wx
  let registeredPage
  global.Page = (definition) => { registeredPage = definition }
  global.wx = { switchTab() {} }
  const pagePath = path.join(root, 'miniprogram', 'pages', 'water-reminder', 'water-reminder.js')
  delete require.cache[pagePath]
  const { reminderForSave } = require(pagePath)

  const result = reminderForSave({
    ...enabled,
    enabled: false,
    startTime: '18:00',
    endTime: '09:00',
  }, enabled)

  assert.strictEqual(result.enabled, false)
  assert.strictEqual(result.startTime, enabled.startTime,
    '关闭时遇到隐藏的无效开始时间，应保留最后保存的有效排程')
  assert.strictEqual(result.endTime, enabled.endTime,
    '关闭时遇到隐藏的无效结束时间，应保留最后保存的有效排程')
  assert.throws(() => reminderForSave({
    ...enabled,
    enabled: true,
    startTime: '18:00',
    endTime: '09:00',
  }, enabled), /endTime must be later than startTime/,
  '开启提醒时仍必须拒绝无效排程')

  global.Page = previousPage
  global.wx = previousWx
  delete require.cache[pagePath]
}

async function testCalendarActionLock() {
  const previousPage = global.Page
  const previousWx = global.wx
  let registeredPage
  let modalSuccess
  let modalCalls = 0
  let navigationCalls = 0
  let toastCalls = 0
  global.Page = (definition) => { registeredPage = definition }
  global.wx = {
    canIUse: () => true,
    addPhoneRepeatCalendar() {},
    showModal(options) { modalCalls += 1; modalSuccess = options.success },
    showToast() { toastCalls += 1 },
    switchTab() { navigationCalls += 1 },
  }
  const pagePath = path.join(root, 'miniprogram', 'pages', 'water-reminder', 'water-reminder.js')
  delete require.cache[pagePath]
  require(pagePath)
  const context = {
    ...registeredPage,
    data: {
      ...registeredPage.data,
      loading: false,
      saving: false,
      dirty: false,
      syncPending: false,
      scheduleInvalid: false,
      calendarInstalling: false,
      saved: { ...enabled },
      draft: { ...enabled },
    },
    setData(patch) { this.data = { ...this.data, ...patch } },
    disableLeaveAlert() {},
  }
  const first = context.addToCalendar()
  const second = context.addToCalendar()
  assert.strictEqual(modalCalls, 1, 'double tap before confirmation must open one modal only')
  assert.strictEqual(context.calendarActionLocked, true)
  await context.navigateFromPage()
  assert.strictEqual(toastCalls, 1)
  assert.strictEqual(navigationCalls, 0, 'navigation must be blocked while calendar action is locked')
  modalSuccess({ confirm: false })
  await Promise.all([first, second])
  assert.strictEqual(context.calendarActionLocked, false)
  global.Page = previousPage
  global.wx = previousWx
  delete require.cache[pagePath]
}

function testPendingStaysVisibleAcrossEditAndRevert() {
  const previousPage = global.Page
  const previousWx = global.wx
  let registeredPage
  global.Page = (definition) => { registeredPage = definition }
  global.wx = { switchTab() {} }
  const pagePath = path.join(root, 'miniprogram', 'pages', 'water-reminder', 'water-reminder.js')
  const storePath = path.join(root, 'miniprogram', 'services', 'user-store.js')
  delete require.cache[pagePath]
  const { userStore, emptyPending } = require(storePath)
  const pending = emptyPending()
  pending.revision = 1
  pending.fields.waterReminder = { ...enabled }
  pending.fieldRevisions.waterReminder = 1
  userStore.pending = pending
  require(pagePath)
  const context = {
    ...registeredPage,
    data: {
      ...registeredPage.data,
      loading: false,
      saving: false,
      calendarInstalling: false,
      saved: { ...enabled },
      draft: { ...enabled },
    },
    setData(patch) { this.data = { ...this.data, ...patch } },
    enableLeaveAlert() {},
    disableLeaveAlert() {},
    refreshPreview() {},
  }
  context.updateDraft({ startTime: '10:00' })
  assert.strictEqual(context.data.dirty, true)
  assert.strictEqual(context.data.syncPending, true)
  context.updateDraft({ startTime: '09:00' })
  assert.strictEqual(context.data.dirty, false)
  assert.strictEqual(context.data.syncPending, true, 'reverting an edit must not hide the persisted pending save')
  return context.addToCalendar().then(() => {
    assert.strictEqual(context.data.calendarStatus, 'error')
    assert.strictEqual(context.data.calendarMessage, '请先保存当前设置，再添加到系统日历')
  }).finally(() => {
    userStore.pending = emptyPending()
    global.Page = previousPage
    global.wx = previousWx
    delete require.cache[pagePath]
  })
}

testCalendarCalls().then(() => {
  testPageIntegration()
  testDisabledReminderCanSaveAfterInvalidScheduleEdit()
  return testPendingStaysVisibleAcrossEditAndRevert()
}).then(() => testCalendarActionLock()).then(() => {
  console.log('water reminder calendar and page tests passed')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
