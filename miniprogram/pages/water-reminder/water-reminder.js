'use strict'

const { membershipStore } = require('../../services/membership-store')
const { userStore, hasPending } = require('../../services/user-store')
const {
  WATER_REMINDER_INTERVALS,
  defaultWaterReminder,
  sanitizeWaterReminder,
} = require('../../services/user-state-core')
const { reminderTimes, request: pushRequest } = require('../../services/water-push')
const pushActions = require('./push-actions')

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
  ...pushActions,
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
    pushLoading: false, subscribing: false, pushReady: false, canSubscribe: false,
    pushTitle: '正在检查微信提醒', pushDetail: '', pushNext: '', pushError: '',
    pendingGrant: false, subscribeLabel: '订阅下一次提醒',
  },

  async onLoad() {
    this.unloaded = false
    this.unsubscribeIdentity = membershipStore.onCacheNamespaceChange(() => {
      this.pushRevision = (this.pushRevision || 0) + 1
      this.intent = null; this.grant = null
      if (!this.unloaded) {
        this.setData({ canSubscribe: false, pendingGrant: false, pushReady: false, pushNext: '',
          pushTitle: '请重新验证账号', pushDetail: '', pushError: '', subscribing: false, saving: false,
          saved: defaultWaterReminder(), draft: defaultWaterReminder(), previewTimes: [], previewText: '',
          dirty: false, syncPending: false, loading: false, loadError: '账号已变化，请重新进入', saveError: '' })
        this.disableLeaveAlert()
      }
    })
    this.refreshNavigation()
    this.setupTheme()
    await this.load()
  },

  onShow() { this.refreshNavigation() },

  onUnload() {
    this.unloaded = true
    if (this.unsubscribeIdentity) this.unsubscribeIdentity()
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
    if (this.data.subscribing || this.data.saving) {
      wx.showToast({ title: '操作进行中，请稍候', icon: 'none' })
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
    const loadRevision = this.loadRevision = (this.loadRevision || 0) + 1
    this.setData({ loading: true, loadError: '', saveError: '' })
    try {
      const member = await membershipStore.init({ force })
      if (this.unloaded || loadRevision !== this.loadRevision) return
      if (!member || member.status !== 'active') {
        wx.reLaunch({ url: '/pages/access/access' })
        return
      }
      const namespace = membershipStore.cacheNamespace
      await userStore.init({ force })
      if (this.unloaded || loadRevision !== this.loadRevision || namespace !== membershipStore.cacheNamespace) return
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
        saveError: syncPending ? '设置仅保存在本机，尚未同步；关闭提醒也需要联网生效。' : '',
      })
      this.disableLeaveAlert()
      this.refreshPreview()
      await this.refreshPush()
    } catch (error) {
      if (this.unloaded || loadRevision !== this.loadRevision) return
      this.setData({ loading: false, loadError: error.message || '喝水提醒设置加载失败，请重试' })
    }
  },

  retryLoad() { return this.load(true) },

  updateDraft(patch) {
    if (this.data.loading || this.data.saving || this.data.subscribing) return
    this.pushRevision = (this.pushRevision || 0) + 1
    this.intent = null; this.grant = null
    const draft = { ...this.data.draft, ...patch }
    const dirty = !sameReminder(draft, this.data.saved)
    const syncPending = hasWaterReminderPending()
    this.setData({ draft, dirty, syncPending, saveError: '', canSubscribe: false, pendingGrant: false })
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
      this.setData({ previewTimes: [], previewText: '', scheduleInvalid: false })
      return
    }
    try {
      const clean = sanitizeWaterReminder(this.data.draft)
      const times = reminderTimes(clean)
      this.setData({
        previewTimes: times,
        previewText: `${cadenceLabel(clean.cadence)}，每天 ${times.length} 个时间点`,
        scheduleInvalid: false,
      })
    } catch (error) {
      this.setData({
        previewTimes: [], previewText: '',
        scheduleInvalid: true, saveError: displayScheduleError(error),
      })
    }
  },

  async save() {
    if (this.data.loading || this.data.saving || this.data.subscribing) return
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
    const namespace = membershipStore.cacheNamespace
    const isCurrent = () => !this.unloaded && namespace === membershipStore.cacheNamespace
    const now = new Date().toISOString()
    const next = {
      ...clean,
      scheduleVersion: this.data.saved.scheduleVersion + 1,
      updatedAt: now,
    }
    this.setData({ saving: true, saveError: '' })
    try {
      const state = await userStore.patch({ waterReminder: next }, { immediate: true })
      if (!isCurrent()) return
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
      if (!saved.enabled && this.data.pushReady) { try { await pushRequest('stop', {}, namespace) } catch (_) {} }
      if (!isCurrent()) return
      await this.refreshPush()
      if (!isCurrent()) return
      wx.showToast({ title: saved.enabled ? '时间已保存，请确认订阅' : '微信提醒已关闭', icon: 'success' })
    } catch (error) {
      if (!isCurrent()) return
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
          ? '设置仅保存在本机，尚未同步；关闭提醒也需要联网生效。'
          : displayError(error, '保存失败，请重试'),
      })
      if (local) this.disableLeaveAlert()
    } finally { if (isCurrent()) this.setData({ saving: false }) }
  },

  async retrySync() {
    if (!this.data.syncPending || this.data.saving || this.data.subscribing) return
    const namespace = membershipStore.cacheNamespace
    const isCurrent = () => !this.unloaded && namespace === membershipStore.cacheNamespace
    this.setData({ saving: true, saveError: '' })
    try {
      const state = await userStore.flush()
      if (!isCurrent()) return
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
      if (!saved.enabled && this.data.pushReady) { try { await pushRequest('stop', {}, namespace) } catch (_) {} }
      if (!isCurrent()) return
      await this.refreshPush()
      if (!isCurrent()) return
      wx.showToast({ title: '已同步到云端', icon: 'success' })
    } catch (error) {
      if (!isCurrent()) return
      this.setData({
        offline: userStore.state === 'offline',
        syncPending: hasWaterReminderPending(),
        saveError: hasWaterReminderPending()
          ? '设置仍保存在本机，尚未同步到云端；联网后可再次重试'
          : displayError(error, '同步失败，请重试'),
      })
    } finally { if (isCurrent()) this.setData({ saving: false }) }
  },


}

Page(waterReminderPage)

module.exports = { waterReminderPage, sameReminder, cadenceLabel, intervalIndex, reminderForSave }
