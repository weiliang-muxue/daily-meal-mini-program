'use strict'

const { membershipStore } = require('../../services/membership-store')
const { userStore, hasPending } = require('../../services/user-store')
const {
  WATER_REMINDER_INTERVALS,
  defaultWaterReminder,
  sanitizeWaterReminder,
} = require('../../services/user-state-core')
const {
  CALENDAR_REPEAT_DAYS,
  reminderTimes,
  buildCalendarEntries,
  canUseRepeatCalendar,
  installCalendarEntries,
} = require('../../services/water-reminder-calendar')

const INTERVAL_OPTIONS = WATER_REMINDER_INTERVALS.map((value) => ({ value, label: `${value} 分钟` }))

function canNavigateBack() {
  try { return typeof getCurrentPages === 'function' && getCurrentPages().length > 1 } catch (_) { return false }
}

function goHome() { wx.switchTab({ url: '/pages/profile/profile' }) }

function sameReminder(left, right) {
  return ['enabled', 'cadence', 'startTime', 'endTime', 'intervalMinutes', 'timeZone']
    .every((key) => left && right && left[key] === right[key])
}

function intervalIndex(value) {
  const index = WATER_REMINDER_INTERVALS.indexOf(Number(value))
  return index < 0 ? WATER_REMINDER_INTERVALS.indexOf(60) : index
}

function reminderForSave(draft, saved) {
  try {
    return sanitizeWaterReminder(draft)
  } catch (error) {
    if (!draft || draft.enabled !== false) throw error
    return { ...sanitizeWaterReminder(saved || defaultWaterReminder()), enabled: false }
  }
}

function cadenceLabel(cadence) { return cadence === 'weekdays' ? '周一至周五' : '每日' }

function displayError(error, fallback) {
  const message = String(error && error.message || fallback)
  if (/需要先在线|网络|cloud|offline/i.test(message)) return '当前网络不可用，设置已保留在本机；联网后点“重试保存”'
  return message
}

function displayScheduleError(error) {
  const message = String(error && error.message || '')
  if (/endTime must be later than startTime/.test(message)) return '结束时间必须晚于开始时间'
  if (/more than 24 reminders/.test(message)) return '每天最多 24 次提醒，请缩短时段或增大间隔'
  return '请检查提醒日期、时间与间隔'
}

function hasWaterReminderPending() {
  return Boolean(hasPending(userStore.pending)
    && userStore.pending && userStore.pending.fields
    && Object.prototype.hasOwnProperty.call(userStore.pending.fields, 'waterReminder'))
}

function confirmModal(options) {
  return new Promise((resolve) => wx.showModal({
    ...options,
    success: ({ confirm }) => resolve(Boolean(confirm)),
    fail: () => resolve(false),
  }))
}

const waterReminderPage = {
  data: {
    canNavigateBack: false,
    pageNavigationLabel: '返回我的',
    loading: true,
    loadError: '',
    offline: false,
    saving: false,
    saveError: '',
    scheduleInvalid: false,
    syncPending: false,
    dirty: false,
    nativeControlColor: '#176B46',
    intervalOptions: INTERVAL_OPTIONS,
    intervalIndex: intervalIndex(60),
    draft: defaultWaterReminder(),
    saved: defaultWaterReminder(),
    previewTimes: [],
    previewText: '',
    calendarEntryCount: 0,
    calendarActionLocked: false,
    calendarInstalling: false,
    calendarProgress: 0,
    calendarTotal: 0,
    calendarStatus: 'idle',
    calendarMessage: '',
    calendarPermissionDenied: false,
    repeatDays: CALENDAR_REPEAT_DAYS,
  },

  async onLoad() {
    this.refreshNavigation()
    this.setupTheme()
    await this.load()
  },

  onShow() { this.refreshNavigation() },

  onUnload() {
    if (this.calendarInstallToken) this.calendarInstallToken.cancelled = true
    this.calendarActionLocked = false
    if (this.themeChangeHandler && typeof wx.offThemeChange === 'function') wx.offThemeChange(this.themeChangeHandler)
    this.disableLeaveAlert()
  },

  setupTheme() {
    let theme = 'light'
    try {
      if (typeof wx.getAppBaseInfo === 'function') theme = wx.getAppBaseInfo().theme || theme
    } catch (_) {}
    this.applyTheme({ theme })
    if (typeof wx.onThemeChange === 'function') {
      this.themeChangeHandler = (event) => this.applyTheme(event)
      wx.onThemeChange(this.themeChangeHandler)
    }
  },

  applyTheme(event) {
    this.setData({ nativeControlColor: event && event.theme === 'dark' ? '#72D49E' : '#176B46' })
  },

  refreshNavigation() {
    const canGoBack = canNavigateBack()
    this.setData({ canNavigateBack: canGoBack, pageNavigationLabel: canGoBack ? '返回上一页' : '返回我的' })
  },

  async navigateFromPage() {
    if (this.data.calendarInstalling || this.calendarActionLocked) {
      wx.showToast({ title: '日历操作进行中，请稍候', icon: 'none' })
      return
    }
    if (this.data.dirty && !await this.confirmDiscard()) return
    this.disableLeaveAlert()
    if (canNavigateBack() && typeof wx.navigateBack === 'function') {
      try { return wx.navigateBack({ delta: 1, fail: goHome }) } catch (_) {}
    }
    return goHome()
  },

  async confirmDiscard() {
    return confirmModal({
      title: '放弃未保存修改？',
      content: '离开后，本页尚未保存的喝水提醒设置会丢失。',
      confirmText: '放弃修改',
      confirmColor: '#A33F2B',
    })
  },

  enableLeaveAlert(message = '喝水提醒设置尚未保存，确定离开吗？') {
    if (this.leaveAlertEnabled || typeof wx.enableAlertBeforeUnload !== 'function') return
    try {
      wx.enableAlertBeforeUnload({ message })
      this.leaveAlertEnabled = true
    } catch (_) {}
  },

  disableLeaveAlert() {
    if (!this.leaveAlertEnabled || typeof wx.disableAlertBeforeUnload !== 'function') return
    try { wx.disableAlertBeforeUnload() } catch (_) {}
    this.leaveAlertEnabled = false
  },

  async load(force = false) {
    this.setData({ loading: true, loadError: '', saveError: '' })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') {
        wx.reLaunch({ url: '/pages/access/access' })
        return
      }
      await userStore.init({ force })
      const saved = sanitizeWaterReminder(userStore.data.waterReminder)
      const syncPending = hasWaterReminderPending()
      this.setData({
        loading: false,
        offline: userStore.state === 'offline',
        saved,
        draft: { ...saved },
        intervalIndex: intervalIndex(saved.intervalMinutes),
        dirty: false,
        syncPending,
        saveError: syncPending ? '设置已保存在本机，尚未同步到云端；联网后点“重试同步”' : '',
      })
      this.disableLeaveAlert()
      this.refreshPreview()
    } catch (error) {
      this.setData({ loading: false, loadError: error.message || '喝水提醒设置加载失败，请重试' })
    }
  },

  retryLoad() { return this.load(true) },

  updateDraft(patch) {
    if (this.data.loading || this.data.saving || this.data.calendarInstalling) return
    const draft = { ...this.data.draft, ...patch }
    const dirty = !sameReminder(draft, this.data.saved)
    const syncPending = hasWaterReminderPending()
    this.setData({ draft, dirty, syncPending, saveError: '', calendarStatus: 'idle', calendarMessage: '' })
    if (dirty) this.enableLeaveAlert()
    else this.disableLeaveAlert()
    this.refreshPreview()
  },

  toggleEnabled(event) { this.updateDraft({ enabled: Boolean(event.detail.value) }) },

  chooseCadence(event) {
    const cadence = event.currentTarget && event.currentTarget.dataset.cadence
    if (cadence === 'daily' || cadence === 'weekdays') this.updateDraft({ cadence })
  },

  changeStartTime(event) { this.updateDraft({ startTime: event.detail.value }) },
  changeEndTime(event) { this.updateDraft({ endTime: event.detail.value }) },

  changeInterval(event) {
    const index = Number(event.detail.value)
    const option = INTERVAL_OPTIONS[index]
    if (!option) return
    this.setData({ intervalIndex: index })
    this.updateDraft({ intervalMinutes: option.value })
  },

  refreshPreview() {
    if (!this.data.draft.enabled) {
      this.setData({ previewTimes: [], previewText: '', calendarEntryCount: 0, scheduleInvalid: false })
      return
    }
    try {
      const clean = sanitizeWaterReminder(this.data.draft)
      const times = reminderTimes(clean)
      const count = times.length * (clean.cadence === 'weekdays' ? 5 : 1)
      this.setData({
        previewTimes: times,
        previewText: `${cadenceLabel(clean.cadence)}，每天 ${times.length} 次`,
        calendarEntryCount: count,
        scheduleInvalid: false,
      })
    } catch (error) {
      this.setData({
        previewTimes: [], previewText: '', calendarEntryCount: 0,
        scheduleInvalid: true, saveError: displayScheduleError(error),
      })
    }
  },

  async save() {
    if (this.data.loading || this.data.saving || this.data.calendarInstalling) return
    if (this.data.syncPending && !this.data.dirty) return this.retrySync()
    let clean
    try { clean = reminderForSave(this.data.draft, this.data.saved) }
    catch (error) {
      this.setData({ saveError: displayScheduleError(error), scheduleInvalid: true })
      return
    }
    if (!this.data.dirty) {
      wx.showToast({ title: '设置没有变化', icon: 'none' })
      return
    }
    const now = new Date().toISOString()
    const next = {
      ...clean,
      scheduleVersion: this.data.saved.scheduleVersion + 1,
      updatedAt: now,
    }
    this.setData({ saving: true, saveError: '' })
    try {
      const state = await userStore.patch({ waterReminder: next }, { immediate: true })
      const saved = sanitizeWaterReminder(state.waterReminder)
      this.setData({
        saved,
        draft: { ...saved },
        intervalIndex: intervalIndex(saved.intervalMinutes),
        dirty: false,
        syncPending: false,
        scheduleInvalid: false,
        saveError: '',
        offline: userStore.state === 'offline',
      })
      this.disableLeaveAlert()
      this.refreshPreview()
      wx.showToast({ title: saved.enabled ? '提醒设置已保存' : '喝水提醒已关闭', icon: 'success' })
    } catch (error) {
      const syncPending = hasWaterReminderPending()
      const local = syncPending ? sanitizeWaterReminder(userStore.data.waterReminder) : null
      this.setData({
        offline: userStore.state === 'offline',
        saved: local || this.data.saved,
        draft: local ? { ...local } : this.data.draft,
        intervalIndex: local ? intervalIndex(local.intervalMinutes) : this.data.intervalIndex,
        dirty: local ? false : this.data.dirty,
        syncPending,
        saveError: syncPending
          ? '设置已保存在本机，尚未同步到云端；联网后点“重试同步”'
          : displayError(error, '保存失败，请重试'),
      })
      if (local) this.disableLeaveAlert()
    } finally { this.setData({ saving: false }) }
  },

  async retrySync() {
    if (!this.data.syncPending || this.data.saving || this.data.calendarInstalling) return
    this.setData({ saving: true, saveError: '' })
    try {
      const state = await userStore.flush()
      const saved = sanitizeWaterReminder(state.waterReminder)
      this.setData({
        saved,
        draft: { ...saved },
        intervalIndex: intervalIndex(saved.intervalMinutes),
        dirty: false,
        syncPending: false,
        offline: false,
        saveError: '',
      })
      this.refreshPreview()
      wx.showToast({ title: '已同步到云端', icon: 'success' })
    } catch (error) {
      this.setData({
        offline: userStore.state === 'offline',
        syncPending: hasWaterReminderPending(),
        saveError: hasWaterReminderPending()
          ? '设置仍保存在本机，尚未同步到云端；联网后可再次重试'
          : displayError(error, '同步失败，请重试'),
      })
    } finally { this.setData({ saving: false }) }
  },

  async addToCalendar() {
    if (this.data.loading || this.data.saving || this.data.calendarInstalling || this.calendarActionLocked) return
    if (!this.data.draft.enabled || !this.data.saved.enabled) return
    if (this.data.dirty || this.data.syncPending) {
      this.setData({ calendarStatus: 'error', calendarMessage: '请先保存当前设置，再添加到系统日历' })
      return
    }
    if (!canUseRepeatCalendar(wx)) {
      this.setData({ calendarStatus: 'error', calendarMessage: '当前微信版本不支持添加重复日历，请更新微信后重试' })
      return
    }
    let entries
    try { entries = buildCalendarEntries(this.data.saved) }
    catch (error) {
      this.setData({ calendarStatus: 'error', calendarMessage: error.message || '提醒排程无效' })
      return
    }
    if (!entries.length) return
    const token = { cancelled: false }
    this.calendarActionLocked = true
    this.calendarInstallToken = token
    this.setData({ calendarActionLocked: true })
    try {
      const confirmed = await confirmModal({
        title: `添加 ${entries.length} 条日历事项？`,
        content: `如果以前添加过相同排程，本次操作会产生重复事项，请先在系统日历核对。将按${cadenceLabel(this.data.saved.cadence)}排程，把 ${entries.length} 条重复事项写入设备系统日历，覆盖未来 ${CALENDAR_REPEAT_DAYS} 天。系统会另行请求日历权限。修改或关闭本页设置不会自动删除已添加事项。`,
        confirmText: '继续添加',
      })
      if (!confirmed || token.cancelled) return
      this.setData({
        calendarInstalling: true,
        calendarProgress: 0,
        calendarTotal: entries.length,
        calendarStatus: 'installing',
        calendarMessage: '正在逐项添加，请勿离开本页',
        calendarPermissionDenied: false,
      })
      this.enableLeaveAlert('正在添加系统日历事项，离开可能只完成部分添加。')
      const result = await installCalendarEntries(wx, entries, (progress) => {
        if (!token.cancelled) this.setData({ calendarProgress: progress.completed })
      }, { shouldContinue: () => !token.cancelled })
      if (token.cancelled) return
      if (result.created === result.total) {
        this.setData({
          calendarStatus: 'success',
          calendarMessage: `已添加 ${result.created} 条重复事项。再次添加可能产生重复，请先在系统日历核对；是否提醒仍受系统日历与设备通知设置影响。`,
        })
        return
      }
      const uncreated = result.failed + result.skipped
      this.setData({
        calendarStatus: result.created ? 'partial' : 'error',
        calendarPermissionDenied: result.permissionDenied,
        calendarMessage: result.permissionDenied
          ? `已添加 ${result.created} 条，${uncreated} 条未添加。请允许“添加到日历”后再重新操作；先在系统日历核对，避免重复。`
          : `已添加 ${result.created} 条，${uncreated} 条未添加。失败项不会自动重试，请先在系统日历核对后再决定是否重试。`,
      })
    } catch (error) {
      if (!token.cancelled) {
        this.setData({ calendarStatus: 'error', calendarMessage: error.message || '系统日历暂时不可用，请稍后重试' })
      }
    } finally {
      if (this.calendarInstallToken === token) this.calendarInstallToken = null
      this.calendarActionLocked = false
      if (!token.cancelled) {
        this.setData({ calendarInstalling: false, calendarActionLocked: false })
        this.disableLeaveAlert()
      }
    }
  },

  openCalendarPermission() {
    if (!this.data.calendarPermissionDenied || typeof wx.openSetting !== 'function') return
    wx.openSetting({ fail: () => wx.showToast({ title: '设置页暂时无法打开', icon: 'none' }) })
  },
}

Page(waterReminderPage)

module.exports = { waterReminderPage, sameReminder, cadenceLabel, intervalIndex, reminderForSave }
