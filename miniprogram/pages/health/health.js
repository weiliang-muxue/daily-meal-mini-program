const { membershipStore } = require('../../services/membership-store')
const { healthStore, isRecordRevisionConflict } = require('../../services/health-store')
const { dateKey, monthKey, shiftMonth, monthLabel, calendarCells } = require('../../utils/date')
const { MAX_HEALTH_PHOTO_BYTES, privateImagePayload } = require('../../utils/private-image')
const { ensurePrivacyAuthorized, openPrivacyContractOrLocal } = require('../../utils/privacy-auth')

const exerciseTypes = ['跳操', '骑车', '抗阻训练', '跑步', '快走', '瑜伽', '其他运动']

function recordFor(records, date) { return records.find((item) => item.date === date) || null }

Page({
  data: {
    month: monthKey(), monthText: monthLabel(monthKey()), weekdays: ['一', '二', '三', '四', '五', '六', '日'], cells: [], records: [],
    selectedDate: dateKey(), selectedRecord: null, selectedRecordRevision: 0, weight: '', note: '', exerciseCompleted: false,
    exerciseTypes, exerciseTypeIndex: 0, exerciseDuration: '30', exerciseIntensity: 'medium',
    photoPreview: '', photoFileId: '', photoLocalPath: '', clearPhoto: false, photoPrivacyError: '',
    choosingPhoto: false, saving: false, loading: true, error: '', offline: false,
    trendMetric: 'weight', trendMode: 'month', trendRecords: [], trendSummary: '本月暂无体重记录',
    weekExerciseCount: 0, weekExerciseMinutes: 0, monthExerciseCount: 0, monthExerciseMinutes: 0,
  },

  onLoad() {
    this.themeChangeHandler = () => this.drawTrendSoon()
    if (typeof wx.onThemeChange === 'function') wx.onThemeChange(this.themeChangeHandler)
    this.loadMonth()
  },
  onReady() { this.measureTrendCanvas() },
  onShow() { if (!this.data.loading && !this.data.error) this.drawTrendSoon() },
  onResize() { this.measureTrendCanvas() },
  onUnload() {
    clearTimeout(this.trendDrawTimer)
    if (this.themeChangeHandler && typeof wx.offThemeChange === 'function') wx.offThemeChange(this.themeChangeHandler)
  },

  async loadMonth(force = false) {
    const targetMonth = this.data.month
    const loadToken = (this.monthLoadToken || 0) + 1
    this.monthLoadToken = loadToken
    this.trendCanvas = null
    this.setData({
      loading: true, error: '', offline: false, monthText: monthLabel(targetMonth), records: [], cells: [],
      selectedRecord: null, selectedRecordRevision: 0, weight: '', note: '', exerciseCompleted: false, exerciseTypeIndex: 0,
      exerciseDuration: '30', exerciseIntensity: 'medium', photoPreview: '', photoFileId: '', photoLocalPath: '', clearPhoto: false,
      photoPrivacyError: '', choosingPhoto: false,
      trendRecords: [], trendSummary: '正在读取记录', weekExerciseCount: 0, weekExerciseMinutes: 0,
      monthExerciseCount: 0, monthExerciseMinutes: 0,
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

  retryLoad() { return this.loadMonth(true) },

  renderCalendar() {
    const exercised = this.data.records.filter((item) => item.exercise && item.exercise.completed)
    this.setData({
      cells: calendarCells(this.data.month, this.data.records), monthText: monthLabel(this.data.month),
      monthExerciseCount: exercised.length,
      monthExerciseMinutes: exercised.reduce((sum, item) => sum + Number(item.exercise.durationMinutes || 0), 0),
    })
    this.drawTrendSoon()
  },

  previousMonth() { this.changeMonth(-1) },
  nextMonth() { this.changeMonth(1) },
  changeMonth(offset) {
    const month = shiftMonth(this.data.month, offset)
    this.setData({ month, selectedDate: `${month}-01` })
    this.loadMonth()
  },

  selectDate(event) { if (event.currentTarget.dataset.date) this.selectDateValue(event.currentTarget.dataset.date) },
  selectDateValue(date) {
    const record = recordFor(this.data.records, date)
    const exercise = record && record.exercise
    const typeIndex = exercise ? Math.max(0, exerciseTypes.indexOf(exercise.type)) : 0
    this.setData({
      selectedDate: date, selectedRecord: record,
      selectedRecordRevision: record && Number.isSafeInteger(record.recordRevision) ? record.recordRevision : 0,
      weight: record && typeof record.weight === 'number' ? String(record.weight) : '', note: record && record.note || '',
      exerciseCompleted: Boolean(exercise), exerciseTypeIndex: typeIndex,
      exerciseDuration: exercise ? String(exercise.durationMinutes) : '30', exerciseIntensity: exercise && exercise.intensity || 'medium',
      photoPreview: record && record.photoUrl || '', photoFileId: record && record.photoFileId || '', photoLocalPath: '',
      clearPhoto: false, photoPrivacyError: '', choosingPhoto: false,
    })
    this.loadWeekTrend(date)
  },

  inputWeight(event) { this.setData({ weight: event.detail.value }) },
  inputNote(event) { this.setData({ note: event.detail.value }) },
  toggleExercise(event) { this.setData({ exerciseCompleted: event.detail.value }) },
  pickExerciseType(event) { this.setData({ exerciseTypeIndex: Number(event.detail.value) }) },
  inputDuration(event) { this.setData({ exerciseDuration: event.detail.value }) },
  selectIntensity(event) { this.setData({ exerciseIntensity: event.currentTarget.dataset.value }) },

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
      })
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
  removePhoto() { this.setData({ photoPreview: '', photoFileId: '', photoLocalPath: '', clearPhoto: true }) },

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
    if (weight !== null && (!Number.isFinite(weight) || weight < 20 || weight > 300)) return wx.showToast({ title: '请输入 20–300 kg', icon: 'none' })
    if (weight === null && !this.data.exerciseCompleted && !this.data.photoPreview && !String(this.data.note || '').trim()) return wx.showToast({ title: '至少记录一项内容', icon: 'none' })
    if (this.data.exerciseCompleted && (!Number.isFinite(Number(this.data.exerciseDuration)) || Number(this.data.exerciseDuration) < 1 || Number(this.data.exerciseDuration) > 600)) return wx.showToast({ title: '运动时长需为 1–600 分钟', icon: 'none' })
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
    finally { wx.hideLoading(); this.setData({ saving: false }) }
  },

  async loadWeekTrend(endDate) {
    const end = new Date(`${endDate}T00:00:00`)
    const start = new Date(end); start.setDate(start.getDate() - 6)
    const format = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    try {
      const trendRecords = await healthStore.getRange(format(start), format(end))
      const exercised = trendRecords.filter((item) => item.exercise && item.exercise.completed)
      this.setData({ trendRecords, weekExerciseCount: exercised.length, weekExerciseMinutes: exercised.reduce((sum, item) => sum + Number(item.exercise.durationMinutes || 0), 0) }, () => this.drawTrend())
    } catch (_) { this.setData({ trendRecords: [], weekExerciseCount: 0, weekExerciseMinutes: 0 }, () => this.drawTrend()) }
  },
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
        windowInfo = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
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
    let theme = 'light'
    try {
      const info = typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : (typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : {})
      theme = info && info.theme === 'dark' ? 'dark' : 'light'
    } catch (_) {}
    return theme === 'dark'
      ? { surface: '#1b241f', line: '#53665b', primary: '#72d49e', text: '#c8d4cd', muted: '#aebbb3' }
      : { surface: '#ffffff', line: '#dce4de', primary: '#176b46', text: '#405149', muted: '#5f6d66' }
  },
  drawTrend() {
    const source = this.data.trendMode === 'week' ? this.data.trendRecords : this.data.records
    const isWeight = this.data.trendMetric === 'weight'
    const points = source.filter((item) => isWeight ? typeof item.weight === 'number' : item.exercise && item.exercise.completed).map((item) => ({ ...item, chartValue: isWeight ? item.weight : Number(item.exercise.durationMinutes || 0) }))
    let summary
    if (isWeight) summary = points.length < 2 ? (points.length ? `当前 ${points[0].chartValue} kg，还需至少 2 条记录形成趋势` : '暂无体重记录') : `${points[0].chartValue} → ${points[points.length - 1].chartValue} kg，变化 ${(points[points.length - 1].chartValue - points[0].chartValue).toFixed(1)} kg`
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
      ctx.fillText(isWeight ? '记录体重后显示折线' : '运动打卡后显示折线', width / 2, height / 2)
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
  onPullDownRefresh() { this.loadMonth(true) },
})
