const { membershipStore } = require('../../services/membership-store')
const { healthStore, isRecordRevisionConflict } = require('../../services/health-store')
const { dateKey, monthKey, shiftMonth, monthLabel, calendarCells } = require('../../utils/date')
const { MAX_HEALTH_PHOTO_BYTES, privateImagePayload } = require('../../utils/private-image')
const { ensurePrivacyAuthorized, openPrivacyContractOrLocal } = require('../../utils/privacy-auth')

const exerciseTypes = ['跳操', '骑车', '抗阻训练', '跑步', '快走', '瑜伽', '其他运动']

function recordFor(records, date) { return records.find((item) => item.date === date) || null }

function normalizedExercise(value) {
  if (!value || value.completed !== true) return null
  const type = exerciseTypes.includes(value.type) ? value.type : '其他运动'
  const durationMinutes = Number(value.durationMinutes)
  const intensity = ['low', 'medium', 'high'].includes(value.intensity) ? value.intensity : 'medium'
  return { completed: true, type, durationMinutes, intensity }
}

function exerciseDraft(data) {
  if (!data.exerciseCompleted) return null
  const typeIndex = Number(data.exerciseTypeIndex)
  return {
    completed: true,
    type: Number.isInteger(typeIndex) && typeIndex >= 0 && typeIndex < exerciseTypes.length
      ? exerciseTypes[typeIndex] : '',
    durationMinutes: Number(data.exerciseDuration),
    intensity: ['low', 'medium', 'high'].includes(data.exerciseIntensity) ? data.exerciseIntensity : '',
  }
}

function sameExercise(left, right) {
  if (!left || !right) return left === right
  return left.type === right.type
    && left.durationMinutes === right.durationMinutes
    && left.intensity === right.intensity
}

function hasSavedPhoto(record) {
  return Boolean(record && (record.hasPhoto || record.photoFileId || record.photoUrl))
}

function recordDraftChanged(data) {
  const saved = data.selectedRecord || null
  const savedWeight = saved && typeof saved.weight === 'number' ? String(saved.weight) : ''
  const savedNote = saved && typeof saved.note === 'string' ? saved.note : ''
  const photoChanged = Boolean(data.photoLocalPath)
    || (Boolean(data.clearPhoto) && hasSavedPhoto(saved))
  return String(data.weight == null ? '' : data.weight) !== savedWeight
    || String(data.note == null ? '' : data.note) !== savedNote
    || !sameExercise(normalizedExercise(saved && saved.exercise), exerciseDraft(data))
    || photoChanged
}

function exercisePresentation(savedValue, draftValue) {
  const saved = normalizedExercise(savedValue)
  const draft = exerciseDraft(draftValue)
  const dirty = !sameExercise(saved, draft)
  if (!dirty && saved) return {
    savedExerciseCompleted: true, exerciseDirty: false, exerciseStatus: '已打卡', exerciseStatusTone: 'saved',
    exerciseStatusSymbol: '✓', exerciseStatusHint: '已保存，月历已显示运动标记', saveButtonText: '保存当天记录',
  }
  if (!dirty) return {
    savedExerciseCompleted: false, exerciseDirty: false, exerciseStatus: '未打卡', exerciseStatusTone: 'idle',
    exerciseStatusSymbol: '—', exerciseStatusHint: '打开开关，记录当天完成的运动', saveButtonText: '保存当天记录',
  }
  if (saved && !draft) return {
    savedExerciseCompleted: true, exerciseDirty: true, exerciseStatus: '待取消', exerciseStatusTone: 'cancel',
    exerciseStatusSymbol: '撤', exerciseStatusHint: '尚未生效，保存后取消月历运动标记', saveButtonText: '保存并取消打卡',
  }
  if (saved) return {
    savedExerciseCompleted: true, exerciseDirty: true, exerciseStatus: '待更新', exerciseStatusTone: 'pending',
    exerciseStatusSymbol: '改', exerciseStatusHint: '修改尚未生效，保存后更新月历标记', saveButtonText: '保存运动修改',
  }
  return {
    savedExerciseCompleted: false, exerciseDirty: true, exerciseStatus: '待保存', exerciseStatusTone: 'pending',
    exerciseStatusSymbol: '待', exerciseStatusHint: '尚未打卡，填写本次运动并保存', saveButtonText: '保存并完成打卡',
  }
}

Page({
  data: {
    month: monthKey(), monthText: monthLabel(monthKey()), weekdays: ['一', '二', '三', '四', '五', '六', '日'], cells: [], records: [],
    selectedDate: dateKey(), selectedRecord: null, selectedRecordRevision: 0, weight: '', note: '', exerciseCompleted: false,
    exerciseTypes, exerciseTypeIndex: -1, exerciseDuration: '', exerciseIntensity: '',
    savedExerciseCompleted: false, exerciseDirty: false, exerciseStatus: '未打卡', exerciseStatusTone: 'idle',
    exerciseStatusSymbol: '—', exerciseStatusHint: '打开开关，记录当天完成的运动', saveButtonText: '保存当天记录',
    weightError: '', exerciseTypeError: '', exerciseDurationError: '', exerciseIntensityError: '', formError: '', exerciseSwitchColor: '#176B46',
    photoPreview: '', photoFileId: '', photoLocalPath: '', clearPhoto: false, photoPrivacyError: '',
    choosingPhoto: false, saving: false, loading: true, error: '', offline: false, recordDirty: false,
    trendMetric: 'weight', trendMode: 'month', trendRecords: [], trendSummary: '本月暂无体重记录',
    weekTrendIncomplete: false, weekTrendNotice: '', weekExerciseCountDisplay: '0', weekExerciseMinutesDisplay: '0',
    weekExerciseCount: 0, weekExerciseMinutes: 0, hasWeekExercise: false,
    monthExerciseCount: 0, monthExerciseMinutes: 0, hasMonthExercise: false,
  },

  onLoad() {
    this.applyTheme()
    this.themeChangeHandler = (event) => this.applyTheme(event)
    if (typeof wx.onThemeChange === 'function') wx.onThemeChange(this.themeChangeHandler)
    this.loadMonth()
  },
  onReady() { this.measureTrendCanvas() },
  onShow() { if (!this.data.loading && !this.data.error) this.drawTrendSoon() },
  onResize() { this.measureTrendCanvas() },
  onUnload() {
    clearTimeout(this.trendDrawTimer)
    this.weekTrendLoadToken = (this.weekTrendLoadToken || 0) + 1
    this.setUnloadAlert(false)
    if (this.themeChangeHandler && typeof wx.offThemeChange === 'function') wx.offThemeChange(this.themeChangeHandler)
  },

  hasUnsavedRecordChanges() {
    return !this.data.loading && !this.data.error && recordDraftChanged(this.data)
  },
  setUnloadAlert(enabled) {
    if (enabled === this.unloadAlertEnabled) return
    if (enabled && typeof wx.enableAlertBeforeUnload === 'function') {
      try {
        wx.enableAlertBeforeUnload({ message: '当天记录还有未保存的修改，离开后将丢失这些内容。' })
        this.unloadAlertEnabled = true
      } catch (_) {}
      return
    }
    if (!enabled && this.unloadAlertEnabled && typeof wx.disableAlertBeforeUnload === 'function') {
      try { wx.disableAlertBeforeUnload() } catch (_) {}
    }
    if (!enabled) this.unloadAlertEnabled = false
  },
  refreshDraftState() {
    const recordDirty = this.hasUnsavedRecordChanges()
    if (recordDirty !== this.data.recordDirty) this.setData({ recordDirty })
    this.setUnloadAlert(recordDirty)
    return recordDirty
  },
  async confirmDiscardDraft(content) {
    if (!this.refreshDraftState()) return true
    if (this.discardPromptPending) return false
    this.discardPromptPending = true
    const confirmed = await new Promise((resolve) => {
      try {
        wx.showModal({
          title: '放弃未保存的记录？',
          content,
          confirmText: '放弃修改',
          confirmColor: '#A33F2B',
          cancelText: '继续编辑',
          success: ({ confirm }) => resolve(Boolean(confirm)),
          fail: () => resolve(false),
        })
      } catch (_) { resolve(false) }
    })
    this.discardPromptPending = false
    if (confirmed) this.setUnloadAlert(false)
    return confirmed
  },

  async loadMonth(force = false) {
    const targetMonth = this.data.month
    const loadToken = (this.monthLoadToken || 0) + 1
    this.monthLoadToken = loadToken
    this.weekTrendLoadToken = (this.weekTrendLoadToken || 0) + 1
    this.trendCanvas = null
    this.setData({
      loading: true, error: '', offline: false, monthText: monthLabel(targetMonth), records: [], cells: [],
      selectedRecord: null, selectedRecordRevision: 0, weight: '', note: '', exerciseCompleted: false, exerciseTypeIndex: -1,
      exerciseDuration: '', exerciseIntensity: '', photoPreview: '', photoFileId: '', photoLocalPath: '', clearPhoto: false,
      savedExerciseCompleted: false, exerciseDirty: false, exerciseStatus: '未打卡', exerciseStatusTone: 'idle',
      exerciseStatusSymbol: '—', exerciseStatusHint: '打开开关，记录当天完成的运动', saveButtonText: '保存当天记录',
      weightError: '', exerciseTypeError: '', exerciseDurationError: '', exerciseIntensityError: '', formError: '',
      photoPrivacyError: '', choosingPhoto: false, recordDirty: false,
      trendRecords: [], trendSummary: '正在读取记录', weekExerciseCount: 0, weekExerciseMinutes: 0,
      weekTrendIncomplete: false, weekTrendNotice: '', weekExerciseCountDisplay: '0', weekExerciseMinutesDisplay: '0',
      hasWeekExercise: false, monthExerciseCount: 0, monthExerciseMinutes: 0, hasMonthExercise: false,
    })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      const hadCachedMonth = healthStore.hasCachedMonth(targetMonth)
      const records = await healthStore.getMonth(targetMonth, { includePhotoUrls: true })
      if (loadToken !== this.monthLoadToken || targetMonth !== this.data.month) return
      if (healthStore.state === 'offline' && !hadCachedMonth) {
        this.setData({ loading: false, error: healthStore.error || '健康记录暂时无法加载，请重试' })
        return
      }
      this.setData({ records, loading: false, offline: healthStore.state === 'offline' })
      this.renderCalendar()
      this.selectDateValue(this.data.selectedDate.startsWith(targetMonth) ? this.data.selectedDate : `${targetMonth}-01`)
    } catch (error) {
      if (loadToken === this.monthLoadToken && targetMonth === this.data.month) {
        this.setData({ loading: false, offline: false, error: error.message || '健康记录暂时无法加载，请重试' })
      }
    } finally {
      if (loadToken === this.monthLoadToken) wx.stopPullDownRefresh()
    }
  },

  async retryLoad() {
    if (!await this.confirmDiscardDraft('重新加载会丢失当前日期尚未保存的体重、运动、照片和备注。')) return false
    return this.loadMonth(true)
  },

  renderCalendar() {
    const exercised = this.data.records.filter((item) => item.exercise && item.exercise.completed)
    this.setData({
      cells: calendarCells(this.data.month, this.data.records), monthText: monthLabel(this.data.month),
      monthExerciseCount: exercised.length,
      monthExerciseMinutes: exercised.reduce((sum, item) => sum + Number(item.exercise.durationMinutes || 0), 0),
      hasMonthExercise: exercised.length > 0,
    })
    this.drawTrendSoon()
  },

  previousMonth() { return this.changeMonth(-1) },
  nextMonth() { return this.changeMonth(1) },
  async changeMonth(offset) {
    if (this.data.saving || this.data.choosingPhoto) return false
    if (!await this.confirmDiscardDraft('切换月份会丢失当前日期尚未保存的体重、运动、照片和备注。')) return false
    const month = shiftMonth(this.data.month, offset)
    this.setData({ month, selectedDate: `${month}-01`, recordDirty: false })
    return this.loadMonth()
  },

  async selectDate(event) {
    const date = event.currentTarget.dataset.date
    if (!date || date === this.data.selectedDate || this.data.saving || this.data.choosingPhoto) return false
    if (!await this.confirmDiscardDraft('切换日期会丢失当前日期尚未保存的体重、运动、照片和备注。')) return false
    this.selectDateValue(date)
    return true
  },
  selectDateValue(date) {
    const record = recordFor(this.data.records, date)
    const exercise = record && record.exercise
    const savedExercise = normalizedExercise(exercise)
    const typeIndex = savedExercise ? exerciseTypes.indexOf(savedExercise.type) : -1
    const draft = {
      exerciseCompleted: Boolean(savedExercise), exerciseTypeIndex: typeIndex,
      exerciseDuration: savedExercise ? String(savedExercise.durationMinutes) : '',
      exerciseIntensity: savedExercise ? savedExercise.intensity : '',
    }
    this.setData({
      selectedDate: date, selectedRecord: record,
      selectedRecordRevision: record && Number.isSafeInteger(record.recordRevision) ? record.recordRevision : 0,
      weight: record && typeof record.weight === 'number' ? String(record.weight) : '', note: record && record.note || '',
      ...draft, ...exercisePresentation(exercise, draft),
      photoPreview: record && record.photoUrl || '', photoFileId: record && record.photoFileId || '', photoLocalPath: '',
      clearPhoto: false, photoPrivacyError: '', choosingPhoto: false,
      weightError: '', exerciseTypeError: '', exerciseDurationError: '', exerciseIntensityError: '', formError: '', recordDirty: false,
    }, () => this.refreshDraftState())
    this.loadWeekTrend(date)
  },

  inputWeight(event) { this.setData({ weight: event.detail.value, weightError: '', formError: '' }, () => this.refreshDraftState()) },
  inputNote(event) { this.setData({ note: event.detail.value, formError: '' }, () => this.refreshDraftState()) },
  updateExerciseDraft(patch, errorPatch = {}) {
    const next = { ...this.data, ...patch }
    const saved = this.data.selectedRecord && this.data.selectedRecord.exercise
    this.setData({ ...patch, ...exercisePresentation(saved, next), ...errorPatch, formError: '' }, () => this.refreshDraftState())
  },
  toggleExercise(event) {
    this.updateExerciseDraft(
      { exerciseCompleted: event.detail.value === true },
      { exerciseTypeError: '', exerciseDurationError: '', exerciseIntensityError: '' },
    )
  },
  pickExerciseType(event) {
    this.updateExerciseDraft({ exerciseTypeIndex: Number(event.detail.value) }, { exerciseTypeError: '' })
  },
  inputDuration(event) {
    this.updateExerciseDraft({ exerciseDuration: event.detail.value }, { exerciseDurationError: '' })
  },
  selectIntensity(event) {
    this.updateExerciseDraft({ exerciseIntensity: event.currentTarget.dataset.value }, { exerciseIntensityError: '' })
  },

  applyTheme(event = {}) {
    let theme = event && event.theme
    if (theme !== 'dark' && theme !== 'light') {
      try {
        if (typeof wx.getAppBaseInfo === 'function') theme = (wx.getAppBaseInfo() || {}).theme
      } catch (_) {}
    }
    if (theme !== 'dark' && theme !== 'light') theme = this.currentTheme || 'light'
    this.currentTheme = theme
    this.setData({ exerciseSwitchColor: theme === 'dark' ? '#72D49E' : '#176B46' }, () => this.drawTrendSoon())
  },

  async choosePhoto() {
    if (this.data.choosingPhoto) return
    this.setData({ choosingPhoto: true, photoPrivacyError: '' })
    try {
      const privacy = await ensurePrivacyAuthorized()
      if (!privacy.authorized) {
        this.setData({ photoPrivacyError: privacy.message })
        return
      }
      if (typeof wx === 'undefined' || typeof wx.chooseMedia !== 'function') {
        throw new Error('CHOOSE_MEDIA_UNAVAILABLE')
      }

      const { tempFiles } = await new Promise((resolve, reject) => {
        wx.chooseMedia({
          count: 1,
          mediaType: ['image'],
          sourceType: ['album', 'camera'],
          sizeType: ['compressed'],
          success: resolve,
          fail: reject,
        })
      })
      const selected = tempFiles && tempFiles[0]
      if (!selected) return
      if (Number(selected.size) > MAX_HEALTH_PHOTO_BYTES) {
        wx.showToast({ title: '健康照片不能超过 2 MB', icon: 'none' })
        return
      }
      this.setData({
        photoPreview: selected.tempFilePath,
        photoFileId: '',
        photoLocalPath: selected.tempFilePath,
        photoPrivacyError: '',
        formError: '',
      }, () => this.refreshDraftState())
    } catch (error) {
      const message = String(error && error.errMsg || error && error.message || '')
      if (!/cancel/i.test(message)) {
        this.setData({
          photoPrivacyError: '照片选择暂时不可用。请更新微信或稍后重试，也可先查看《隐私保护指引》。',
        })
      }
    } finally {
      this.setData({ choosingPhoto: false })
    }
  },
  retryChoosePhoto() { return this.choosePhoto() },
  async openPrivacyGuide() {
    const result = await openPrivacyContractOrLocal()
    if (!result.openedPlatformContract && !result.usedLocalFallback) {
      this.setData({ photoPrivacyError: result.error || '《隐私保护指引》暂时无法打开，请稍后重试。' })
    }
    return result
  },
  removePhoto() {
    const removingSavedPhoto = Boolean(this.data.selectedRecord && this.data.selectedRecord.hasPhoto)
    const hasOtherRecordContent = this.data.weight !== ''
      || this.data.exerciseCompleted
      || (this.data.savedExerciseCompleted && !this.data.exerciseCompleted)
      || Boolean(String(this.data.note || '').trim())
    this.setData({
      photoPreview: '', photoFileId: '', photoLocalPath: '', clearPhoto: true,
      formError: hasOtherRecordContent || removingSavedPhoto ? '' : '至少填写体重、运动、照片或备注中的一项',
    }, () => this.refreshDraftState())
  },

  async refreshAfterRecordConflict(date, month) {
    const records = await healthStore.getMonth(month, { includePhotoUrls: true })
    if (healthStore.state !== 'ready') throw new Error(healthStore.error || '最新记录刷新失败，请联网后重试')
    if (this.data.month === month) {
      this.setData({ records, offline: false, error: '' })
      this.renderCalendar()
      this.selectDateValue(date)
    }
    wx.showModal({
      title: '记录已在其他设备更新',
      content: '已刷新为云端最新内容。请重新核对这一天的体重、运动、备注和照片后再保存。',
      showCancel: false,
      confirmText: '我知道了',
    })
  },

  async saveRecord() {
    if (this.data.saving || this.data.loading || this.data.error) return
    const weight = this.data.weight === '' ? null : Number(this.data.weight)
    this.setData({
      weightError: '', exerciseTypeError: '', exerciseDurationError: '', exerciseIntensityError: '', formError: '',
    })
    if (weight !== null && (!Number.isFinite(weight) || weight < 20 || weight > 300)) {
      this.setData({ weightError: '请输入 20–300 kg 的有效体重' })
      return wx.showToast({ title: '请输入 20–300 kg', icon: 'none' })
    }
    const cancellingSavedExercise = this.data.savedExerciseCompleted && !this.data.exerciseCompleted
    const removingSavedPhoto = Boolean(this.data.clearPhoto && this.data.selectedRecord && this.data.selectedRecord.hasPhoto)
    if (weight === null && !this.data.exerciseCompleted && !cancellingSavedExercise && !removingSavedPhoto && !this.data.photoPreview && !String(this.data.note || '').trim()) {
      this.setData({ formError: '至少填写体重、运动、照片或备注中的一项' })
      return wx.showToast({ title: '至少记录一项内容', icon: 'none' })
    }
    if (this.data.exerciseCompleted) {
      const typeIndex = Number(this.data.exerciseTypeIndex)
      if (!Number.isInteger(typeIndex) || typeIndex < 0 || typeIndex >= exerciseTypes.length) {
        this.setData({ exerciseTypeError: '请选择运动类型' })
        return wx.showToast({ title: '请选择运动类型', icon: 'none' })
      }
      const rawDuration = String(this.data.exerciseDuration == null ? '' : this.data.exerciseDuration).trim()
      const durationMinutes = Number(rawDuration)
      if (!/^\d+$/.test(rawDuration) || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 600) {
        this.setData({ exerciseDurationError: '请输入 1–600 的整数分钟' })
        return wx.showToast({ title: '运动时长需为 1–600 分钟', icon: 'none' })
      }
      if (!['low', 'medium', 'high'].includes(this.data.exerciseIntensity)) {
        this.setData({ exerciseIntensityError: '请选择运动强度' })
        return wx.showToast({ title: '请选择运动强度', icon: 'none' })
      }
    }
    this.setData({ saving: true })
    wx.showLoading({ title: '正在保存', mask: true })
    const savingDate = this.data.selectedDate
    const savingMonth = this.data.month
    try {
      const photoImage = this.data.photoLocalPath
        ? await privateImagePayload(this.data.photoLocalPath, { maxBytes: MAX_HEALTH_PHOTO_BYTES, label: '健康照片' })
        : null
      const exercise = this.data.exerciseCompleted ? {
        completed: true, type: exerciseTypes[this.data.exerciseTypeIndex], durationMinutes: Number(this.data.exerciseDuration), intensity: this.data.exerciseIntensity,
      } : null
      await healthStore.saveDaily({
        date: this.data.selectedDate, weight, note: this.data.note, exercise,
        clearPhoto: this.data.clearPhoto, photoImage,
        expectedRecordRevision: this.data.selectedRecordRevision,
      })
      const records = await healthStore.getMonth(this.data.month, { includePhotoUrls: true })
      this.setData({ records, offline: false })
      this.renderCalendar()
      this.selectDateValue(this.data.selectedDate)
      wx.showToast({ title: '记录已保存', icon: 'success' })
    } catch (error) {
      if (isRecordRevisionConflict(error)) {
        try { await this.refreshAfterRecordConflict(savingDate, savingMonth) }
        catch (refreshError) {
          wx.showModal({
            title: '记录未覆盖',
            content: refreshError.message || '云端记录已变化，但最新内容刷新失败。请联网刷新后重新确认。',
            showCancel: false,
            confirmText: '我知道了',
          })
        }
      } else wx.showToast({ title: error.message || '保存失败', icon: 'none' })
    }
    finally {
      wx.hideLoading()
      this.setData({ saving: false }, () => this.refreshDraftState())
    }
  },

  async loadWeekTrend(endDate) {
    const loadToken = (this.weekTrendLoadToken || 0) + 1
    this.weekTrendLoadToken = loadToken
    const end = new Date(`${endDate}T00:00:00`)
    const start = new Date(end); start.setDate(start.getDate() - 6)
    const format = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    try {
      const trendRecords = await healthStore.getRange(format(start), format(end))
      if (loadToken !== this.weekTrendLoadToken || endDate !== this.data.selectedDate) return
      const exercised = trendRecords.filter((item) => item.exercise && item.exercise.completed)
      const cacheInfo = trendRecords.cacheInfo || { source: 'cloud', complete: true }
      const cached = cacheInfo.source === 'cache'
      const incomplete = cached && cacheInfo.complete !== true
      this.setData({
        trendRecords, weekExerciseCount: exercised.length,
        weekExerciseMinutes: exercised.reduce((sum, item) => sum + Number(item.exercise.durationMinutes || 0), 0),
        weekExerciseCountDisplay: incomplete ? (exercised.length ? `${exercised.length}+` : '—') : String(exercised.length),
        weekExerciseMinutesDisplay: incomplete
          ? (exercised.length ? `${exercised.reduce((sum, item) => sum + Number(item.exercise.durationMinutes || 0), 0)}+` : '—')
          : String(exercised.reduce((sum, item) => sum + Number(item.exercise.durationMinutes || 0), 0)),
        weekTrendIncomplete: incomplete,
        weekTrendNotice: cached
          ? (incomplete ? '当前显示部分已保存记录，近 7 天缓存可能不完整。点此联网重试。' : '当前显示已保存的近 7 天记录。点此联网重试。')
          : '',
        hasWeekExercise: exercised.length > 0,
      }, () => this.drawTrend())
    } catch (_) {
      if (loadToken !== this.weekTrendLoadToken || endDate !== this.data.selectedDate) return
      this.setData({
        trendRecords: [], weekExerciseCount: 0, weekExerciseMinutes: 0,
        weekExerciseCountDisplay: '—', weekExerciseMinutesDisplay: '—',
        weekTrendIncomplete: true, weekTrendNotice: '近 7 天记录暂时无法读取，点此重试。', hasWeekExercise: false,
      }, () => this.drawTrend())
    }
  },
  retryWeekTrend() { return this.loadWeekTrend(this.data.selectedDate) },
  async selectTrendMode(event) {
    const trendMode = event.currentTarget.dataset.mode
    if (trendMode === 'week') {
      this.setData({ trendMode })
      await this.loadWeekTrend(this.data.selectedDate)
    } else this.setData({ trendMode, trendRecords: [] }, () => this.drawTrend())
  },
  selectTrendMetric(event) { this.setData({ trendMetric: event.currentTarget.dataset.metric }, () => this.drawTrend()) },
  drawTrendSoon() {
    clearTimeout(this.trendDrawTimer)
    this.trendDrawTimer = setTimeout(() => this.measureTrendCanvas(), 80)
  },
  measureTrendCanvas() {
    if (this.data.loading || this.data.error) return
    let query
    if (typeof this.createSelectorQuery === 'function') query = this.createSelectorQuery()
    else if (typeof wx.createSelectorQuery === 'function') query = wx.createSelectorQuery().in(this)
    if (!query) return
    query.select('#weightChart').fields({ node: true, size: true }).exec((result) => {
      const measurement = result && result[0]
      if (!measurement || !measurement.node || !measurement.width || !measurement.height) return
      let windowInfo = {}
      try {
        if (typeof wx.getWindowInfo === 'function') windowInfo = wx.getWindowInfo()
      } catch (_) {}
      const dpr = Math.max(1, Number(windowInfo.pixelRatio) || 1)
      const width = Math.max(1, Math.round(measurement.width))
      const height = Math.max(1, Math.round(measurement.height))
      const canvas = measurement.node
      const resized = canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)
      if (resized) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      else if (resized) ctx.scale(dpr, dpr)
      this.trendCanvas = { canvas, ctx, width, height, dpr }
      this.drawTrend()
    })
  },
  chartPalette() {
    return this.currentTheme === 'dark'
      ? { surface: '#1b241f', line: '#60756a', primary: '#72d49e', text: '#c8d4cd', muted: '#aebbb3' }
      : { surface: '#ffffff', line: '#718a7a', primary: '#176b46', text: '#405149', muted: '#5f6d66' }
  },
  drawTrend() {
    const source = this.data.trendMode === 'week' ? this.data.trendRecords : this.data.records
    const isWeight = this.data.trendMetric === 'weight'
    const points = source.filter((item) => isWeight ? typeof item.weight === 'number' : item.exercise && item.exercise.completed).map((item) => ({ ...item, chartValue: isWeight ? item.weight : Number(item.exercise.durationMinutes || 0) }))
    let summary
    if (this.data.trendMode === 'week' && this.data.weekTrendIncomplete && !points.length) {
      summary = '近 7 天缓存不完整，暂不能确认是否有记录'
    } else if (isWeight) summary = points.length < 2 ? (points.length ? `当前 ${points[0].chartValue} kg，还需至少 2 条记录形成趋势` : '暂无体重记录') : `${points[0].chartValue} → ${points[points.length - 1].chartValue} kg，变化 ${(points[points.length - 1].chartValue - points[0].chartValue).toFixed(1)} kg`
    else summary = points.length ? `${points.length} 次运动，共 ${points.reduce((sum, item) => sum + item.chartValue, 0)} 分钟` : '暂无运动记录'
    this.setData({ trendSummary: summary })
    if (!this.trendCanvas) return
    const { ctx, width, height } = this.trendCanvas
    const palette = this.chartPalette()
    const baseFont = Math.max(10, Math.min(13, width / 45))
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = palette.surface; ctx.fillRect(0, 0, width, height)
    ctx.font = `${baseFont + 1}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
    if (!points.length) {
      ctx.fillStyle = palette.muted
      ctx.fillText(this.data.trendMode === 'week' && this.data.weekTrendIncomplete
        ? '缓存不完整，联网后重试'
        : (isWeight ? '记录体重后显示折线' : '运动打卡后显示折线'), width / 2, height / 2)
      return
    }
    const values = points.map((item) => item.chartValue), min = Math.min(...values), max = Math.max(...values), span = Math.max(1, max - min)
    const left = Math.max(34, width * .08), right = width - Math.max(18, width * .04), top = 28, bottom = height - 42
    ctx.strokeStyle = palette.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(left, bottom); ctx.lineTo(right, bottom); ctx.stroke()
    const coords = points.map((item, index) => ({ x: points.length === 1 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1), y: top + (max - item.chartValue) / span * (bottom - top), item }))
    ctx.strokeStyle = palette.primary; ctx.lineWidth = 2.5; ctx.beginPath(); coords.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.stroke()
    const labelEvery = points.length > 14 ? 5 : points.length > 7 ? 2 : 1
    coords.forEach((point, index) => {
      ctx.fillStyle = palette.primary; ctx.beginPath(); ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2); ctx.fill()
      if (points.length <= 14 || index === 0 || index === points.length - 1) {
        ctx.fillStyle = palette.text; ctx.font = `${baseFont}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText(`${point.item.chartValue}${isWeight ? '' : 'm'}`, point.x, point.y - 10)
      }
      if (index % labelEvery === 0 || index === points.length - 1) {
        ctx.fillStyle = palette.muted; ctx.font = `${baseFont}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText(point.item.date.slice(5), point.x, bottom + 22)
      }
    })
  },
  async onPullDownRefresh() {
    if (!await this.confirmDiscardDraft('刷新会丢失当前日期尚未保存的体重、运动、照片和备注。')) {
      wx.stopPullDownRefresh()
      return false
    }
    return this.loadMonth(true)
  },
})
