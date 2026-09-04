'use strict'

const { userStore } = require('../../services/user-store')
const { authStore } = require('../../services/auth-store')
const { membershipStore } = require('../../services/membership-store')
const { buildPlanView } = require('../../services/plan-view')
const { formatUpdatedAt } = require('../../utils/date')

Page({
  data: {
    loading: true, error: '', offline: false, hasPlan: false, hasDraft: false,
    days: [], displayedDays: [], weeks: [], selectedWeekIndex: 0, selectedWeekLabel: '',
    selectedDayIndex: 0, selectedDay: {}, planTitle: '', dateRangeText: '', mealSummaryText: '',
    planVersion: 0, sourceLabel: '', isAiPlan: false,
    syncState: 'loading', syncText: '正在读取餐单', localSaveNotice: '',
  },

  onLoad() { this.loadData() },
  onShow() { if (!this.data.loading) this.render() },
  onHide() { userStore.flush().catch(() => {}) },

  async loadData(force = false) {
    this.setData({ loading: true, error: '' })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      Promise.resolve().then(() => authStore.init({ force })).catch(() => null)
      await userStore.init({ force })
      if (userStore.state === 'ready') this.setData({ localSaveNotice: '' })
    } catch (error) {
      this.setData({ error: error.message || '暂时无法加载餐单' })
    }
    this.render()
  },

  render() {
    const state = userStore.data
    const view = buildPlanView(state.activePlan, state)
    const plan = state.activePlan
    const selectedDayIndex = Math.max(0, view.selectedDayIndex)
    const weeks = this.buildWeeks(view.days)
    const selectedWeekIndex = weeks.length ? Math.floor(selectedDayIndex / 7) : 0
    const selectedWeek = weeks[selectedWeekIndex] || { label: '', days: [] }
    const sync = this.buildSyncStatus()
    this.setData({
      loading: false,
      error: this.data.error || (!view.hasPlan && userStore.state === 'error' ? userStore.error : ''),
      offline: userStore.state === 'offline',
      hasPlan: view.hasPlan,
      hasDraft: Boolean(state.draftPlan),
      days: view.days,
      displayedDays: selectedWeek.days,
      weeks,
      selectedWeekIndex,
      selectedWeekLabel: selectedWeek.label,
      selectedDayIndex,
      selectedDay: view.selectedDay || {},
      planTitle: view.title,
      dateRangeText: view.dateRange.text,
      mealSummaryText: view.mealSummary.text,
      planVersion: view.planVersion,
      sourceLabel: plan && plan.source === 'legacy' ? '旧版迁移计划' : plan && plan.source === 'ai' ? 'AI 定制计划' : '个人计划',
      isAiPlan: Boolean(plan && plan.source === 'ai'),
      syncState: sync.state,
      syncText: sync.text,
    })
    wx.stopPullDownRefresh()
  },

  buildWeeks(days) {
    const list = Array.isArray(days) ? days : []
    const weeks = []
    for (let start = 0; start < list.length; start += 7) {
      const weekIndex = Math.floor(start / 7)
      const weekDays = list.slice(start, start + 7).map((day, offset) => ({
        ...day,
        originalIndex: start + offset,
        dateLabel: this.formatDayDate(day.date),
      }))
      weeks.push({ index: weekIndex, label: `第${weekIndex + 1}周`, days: weekDays })
    }
    return weeks
  },

  formatDayDate(value) {
    const match = typeof value === 'string' && value.match(/^\d{4}-(\d{2})-(\d{2})$/)
    return match ? `${Number(match[1])}/${Number(match[2])}` : value || ''
  },

  buildSyncStatus() {
    const state = userStore.state
    if (state === 'saving') return { state: 'saving', text: '正在保存你的选择…' }
    if (this.data.localSaveNotice && (state === 'offline' || state === 'error')) {
      return { state: 'offline', text: this.data.localSaveNotice }
    }
    if (state === 'offline') return { state: 'offline', text: '尚未同步，修改已安全保存' }
    if (state === 'error') return { state: 'error', text: userStore.error || '同步失败，请重试' }
    const updated = formatUpdatedAt(userStore.data && userStore.data.updatedAt)
    return { state: 'ready', text: updated ? `更新于 ${updated}` : '已同步' }
  },

  selectWeek(event) {
    const weekIndex = Number(event.currentTarget.dataset.index)
    const week = this.data.weeks[weekIndex]
    if (!week || !week.days.length || weekIndex === this.data.selectedWeekIndex) return
    const remembered = this.weekSelectedDays && this.weekSelectedDays[weekIndex]
    const target = week.days.find((day) => day.originalIndex === remembered) || week.days[0]
    this.savePlanSelection(target)
  },

  selectDay(event) {
    const index = Number(event.currentTarget.dataset.index)
    const day = this.data.days[index]
    if (!day) return
    this.savePlanSelection({ ...day, originalIndex: index })
  },

  savePlanSelection(day) {
    const index = day.originalIndex
    this.weekSelectedDays = { ...(this.weekSelectedDays || {}), [Math.floor(index / 7)]: index }
    const request = userStore.patch({ selectedDay: index, selectedDayId: day.id }, { immediate: true })
    this.render()
    request.then(() => this.render()).catch(() => this.render())
  },

  selectDinnerMode(event) {
    const mode = event.currentTarget.dataset.mode === 'workout' ? 'workout' : 'rest'
    const dayId = this.data.selectedDay.id
    const dinnerModeByDay = { ...userStore.data.dinnerModeByDay, [dayId]: mode }
    const projectedState = { ...userStore.data, dinnerModeByDay }
    const validShoppingIds = new Set(buildPlanView(projectedState.activePlan, projectedState).shopping.groups
      .flatMap((group) => group.items.map((item) => item.itemId)))
    const checkedShoppingIds = (Array.isArray(userStore.data.checkedShoppingIds) ? userStore.data.checkedShoppingIds : [])
      .filter((id) => validShoppingIds.has(id))
    const request = userStore.patch({ dinnerModeByDay, checkedShoppingIds }, { immediate: true })
    this.render()
    return request.then(() => {
      this.setData({ localSaveNotice: '' })
      this.render()
    }).catch(() => {
      this.setData({ localSaveNotice: '已保存在本机，联网后重试' })
      this.render()
    })
  },

  editMeal(event) {
    const mealId = event.detail && event.detail.mealId || event.currentTarget.dataset.id
    if (mealId) wx.navigateTo({ url: `/pages/meal-edit/meal-edit?mealId=${encodeURIComponent(mealId)}` })
  },

  openPlanner() { wx.navigateTo({ url: '/pages/planner/planner' }) },
  openDraft() { wx.navigateTo({ url: '/pages/plan-preview/plan-preview' }) },
  openHistory() { wx.navigateTo({ url: '/pages/plan-history/plan-history' }) },
  openBasis() { wx.navigateTo({ url: '/pages/guide/guide' }) },
  retrySync() { this.loadData(true) },
  onPullDownRefresh() { this.loadData(true) },
})
