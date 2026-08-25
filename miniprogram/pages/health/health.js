const { membershipStore } = require('../../services/membership-store')
const { healthStore } = require('../../services/health-store')
const { dateKey, monthKey, shiftMonth, monthLabel, calendarCells } = require('../../utils/date')

const exerciseTypes = ['跳操', '骑车', '抗阻训练', '跑步', '快走', '瑜伽', '其他运动']

function uploadFile(cloudPath, filePath) {
  return wx.cloud.uploadFile({ cloudPath, filePath }).then(({ fileID }) => fileID)
}

function recordFor(records, date) { return records.find((item) => item.date === date) || null }

Page({
  data: {
    month: monthKey(), monthText: monthLabel(monthKey()), weekdays: ['一', '二', '三', '四', '五', '六', '日'], cells: [], records: [],
    selectedDate: dateKey(), selectedRecord: null, weight: '', note: '', exerciseCompleted: false,
    exerciseTypes, exerciseTypeIndex: 0, exerciseDuration: '30', exerciseIntensity: 'medium',
    photoPreview: '', photoFileId: '', clearPhoto: false, saving: false, loading: true, offline: false,
    trendMetric: 'weight', trendMode: 'month', trendRecords: [], trendSummary: '本月暂无体重记录', canvasWidth: 640, canvasHeight: 280,
    weekExerciseCount: 0, weekExerciseMinutes: 0, monthExerciseCount: 0, monthExerciseMinutes: 0,
  },

  onLoad() { this.loadMonth() },
  onShow() { if (!this.data.loading) this.drawTrendSoon() },

  async loadMonth(force = false) {
    this.setData({ loading: true })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      const records = await healthStore.getMonth(this.data.month, { includePhotoUrls: true })
      this.setData({ records, loading: false, offline: healthStore.state === 'offline' })
      this.renderCalendar()
      this.selectDateValue(this.data.selectedDate.startsWith(this.data.month) ? this.data.selectedDate : `${this.data.month}-01`)
    } catch (error) {
      this.setData({ loading: false, offline: true })
    }
    wx.stopPullDownRefresh()
  },

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
      weight: record && typeof record.weight === 'number' ? String(record.weight) : '', note: record && record.note || '',
      exerciseCompleted: Boolean(exercise), exerciseTypeIndex: typeIndex,
      exerciseDuration: exercise ? String(exercise.durationMinutes) : '30', exerciseIntensity: exercise && exercise.intensity || 'medium',
      photoPreview: record && record.photoUrl || '', photoFileId: record && record.photoFileId || '',
      clearPhoto: false,
    })
    this.loadWeekTrend(date)
  },

  inputWeight(event) { this.setData({ weight: event.detail.value }) },
  inputNote(event) { this.setData({ note: event.detail.value }) },
  toggleExercise(event) { this.setData({ exerciseCompleted: event.detail.value }) },
  pickExerciseType(event) { this.setData({ exerciseTypeIndex: Number(event.detail.value) }) },
  inputDuration(event) { this.setData({ exerciseDuration: event.detail.value }) },
  selectIntensity(event) { this.setData({ exerciseIntensity: event.currentTarget.dataset.value }) },

  choosePhoto() {
    wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'], success: ({ tempFiles }) => {
      if (tempFiles && tempFiles[0]) this.setData({ photoPreview: tempFiles[0].tempFilePath, photoFileId: '' })
    } })
  },
  removePhoto() { this.setData({ photoPreview: '', photoFileId: '', clearPhoto: true }) },

  async saveRecord() {
    if (this.data.saving) return
    const weight = this.data.weight === '' ? null : Number(this.data.weight)
    if (weight !== null && (!Number.isFinite(weight) || weight < 20 || weight > 300)) return wx.showToast({ title: '请输入 20–300 kg', icon: 'none' })
    if (weight === null && !this.data.exerciseCompleted && !this.data.photoPreview && !String(this.data.note || '').trim()) return wx.showToast({ title: '至少记录一项内容', icon: 'none' })
    if (this.data.exerciseCompleted && (!Number.isFinite(Number(this.data.exerciseDuration)) || Number(this.data.exerciseDuration) < 1 || Number(this.data.exerciseDuration) > 600)) return wx.showToast({ title: '运动时长需为 1–600 分钟', icon: 'none' })
    this.setData({ saving: true })
    wx.showLoading({ title: '正在保存', mask: true })
    try {
      let photoUploadToken = '', photoUploadFileId = ''
      if (this.data.photoPreview && !String(this.data.photoPreview).startsWith('http') && !String(this.data.photoPreview).startsWith('cloud://')) {
        const match = this.data.photoPreview.match(/\.([a-zA-Z0-9]+)(?:\?|$)/)
        const ticket = await healthStore.preparePhoto(match ? match[1] : 'jpg')
        photoUploadToken = ticket.token
        photoUploadFileId = await uploadFile(ticket.cloudPath, this.data.photoPreview)
      }
      const exercise = this.data.exerciseCompleted ? {
        completed: true, type: exerciseTypes[this.data.exerciseTypeIndex], durationMinutes: Number(this.data.exerciseDuration), intensity: this.data.exerciseIntensity,
      } : null
      await healthStore.saveDaily({
        date: this.data.selectedDate, weight, note: this.data.note, exercise,
        clearPhoto: this.data.clearPhoto, photoUploadToken, photoUploadFileId,
      })
      const records = await healthStore.getMonth(this.data.month, { includePhotoUrls: true })
      this.setData({ records, offline: false })
      this.renderCalendar()
      this.selectDateValue(this.data.selectedDate)
      wx.showToast({ title: '记录已保存', icon: 'success' })
    } catch (error) { wx.showToast({ title: error.message || '保存失败', icon: 'none' }) }
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
  drawTrendSoon() { setTimeout(() => this.drawTrend(), 80) },
  drawTrend() {
    const source = this.data.trendMode === 'week' ? this.data.trendRecords : this.data.records
    const isWeight = this.data.trendMetric === 'weight'
    const points = source.filter((item) => isWeight ? typeof item.weight === 'number' : item.exercise && item.exercise.completed).map((item) => ({ ...item, chartValue: isWeight ? item.weight : Number(item.exercise.durationMinutes || 0) }))
    let summary
    if (isWeight) summary = points.length < 2 ? (points.length ? `当前 ${points[0].chartValue} kg，还需至少 2 条记录形成趋势` : '暂无体重记录') : `${points[0].chartValue} → ${points[points.length - 1].chartValue} kg，变化 ${(points[points.length - 1].chartValue - points[0].chartValue).toFixed(1)} kg`
    else summary = points.length ? `${points.length} 次运动，共 ${points.reduce((sum, item) => sum + item.chartValue, 0)} 分钟` : '暂无运动记录'
    this.setData({ trendSummary: summary })
    const ctx = wx.createCanvasContext('weightChart', this)
    const width = this.data.canvasWidth, height = this.data.canvasHeight
    ctx.setFillStyle('#ffffff'); ctx.fillRect(0, 0, width, height)
    if (!points.length) { ctx.setFillStyle('#87918b'); ctx.setFontSize(24); ctx.setTextAlign('center'); ctx.fillText(isWeight ? '记录体重后显示折线' : '运动打卡后显示折线', width / 2, height / 2); return ctx.draw() }
    const values = points.map((item) => item.chartValue), min = Math.min(...values), max = Math.max(...values), span = Math.max(1, max - min)
    const left = 44, right = width - 24, top = 28, bottom = height - 48
    ctx.setStrokeStyle('#dce4de'); ctx.setLineWidth(2); ctx.beginPath(); ctx.moveTo(left, bottom); ctx.lineTo(right, bottom); ctx.stroke()
    const coords = points.map((item, index) => ({ x: points.length === 1 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1), y: top + (max - item.chartValue) / span * (bottom - top), item }))
    ctx.setStrokeStyle('#176b46'); ctx.setLineWidth(5); ctx.beginPath(); coords.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.stroke()
    const labelEvery = points.length > 14 ? 5 : points.length > 7 ? 2 : 1
    coords.forEach((point, index) => {
      ctx.setFillStyle('#176b46'); ctx.beginPath(); ctx.arc(point.x, point.y, 7, 0, Math.PI * 2); ctx.fill()
      if (points.length <= 14 || index === 0 || index === points.length - 1) {
        ctx.setFillStyle('#405149'); ctx.setFontSize(19); ctx.setTextAlign('center'); ctx.fillText(`${point.item.chartValue}${isWeight ? '' : 'm'}`, point.x, point.y - 15)
      }
      if (index % labelEvery === 0 || index === points.length - 1) {
        ctx.setFillStyle('#68766f'); ctx.setFontSize(18); ctx.setTextAlign('center'); ctx.fillText(point.item.date.slice(5), point.x, bottom + 28)
      }
    })
    ctx.draw()
  },
  onPullDownRefresh() { this.loadMonth(true) },
})
