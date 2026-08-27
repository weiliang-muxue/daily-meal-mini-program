'use strict'

const { userStore } = require('../../services/user-store')
const { authStore } = require('../../services/auth-store')
const { membershipStore } = require('../../services/membership-store')
const { buildPlanView } = require('../../services/plan-view')
const { formatUpdatedAt } = require('../../utils/date')

Page({
  data: {
    loading: true, error: '', offline: false, hasPlan: false, hasDraft: false,
    days: [], selectedDayIndex: 0, selectedDay: {}, planTitle: '', dateRangeText: '', mealSummaryText: '',
    planVersion: 0, sourceLabel: '', syncText: '正在连接云端',
  },

  onLoad() { this.loadData() },
  onShow() { if (!this.data.loading) this.render() },
  onHide() { userStore.flush().catch(() => {}) },

  async loadData(force = false) {
    this.setData({ loading: true, error: '' })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      await authStore.init({ force })
      await userStore.init({ force })
    } catch (error) {
      this.setData({ error: error.message || '暂时无法加载餐单' })
    }
    this.render()
  },

  render() {
    const state = userStore.data
    const view = buildPlanView(state.activePlan, state)
    const plan = state.activePlan
    this.setData({
      loading: false,
      error: this.data.error || (!view.hasPlan && userStore.state === 'error' ? userStore.error : ''),
      offline: userStore.state === 'offline',
      hasPlan: view.hasPlan,
      hasDraft: Boolean(state.draftPlan),
      days: view.days,
      selectedDayIndex: Math.max(0, view.selectedDayIndex),
      selectedDay: view.selectedDay || {},
      planTitle: view.title,
      dateRangeText: view.dateRange.text,
      mealSummaryText: view.mealSummary.text,
      planVersion: view.planVersion,
      sourceLabel: plan && plan.source === 'legacy' ? '旧版迁移计划' : 'AI 定制计划',
      syncText: userStore.state === 'offline' ? '离线快照 · 点此重试' : `云端已同步 ${formatUpdatedAt(state.updatedAt)}`,
    })
    wx.stopPullDownRefresh()
  },

  selectDay(event) {
    const index = Number(event.currentTarget.dataset.index)
    const day = this.data.days[index]
    if (!day) return
    userStore.patch({ selectedDay: index, selectedDayId: day.id })
    this.render()
  },

  selectDinnerMode(event) {
    const mode = event.currentTarget.dataset.mode === 'workout' ? 'workout' : 'rest'
    const dayId = this.data.selectedDay.id
    userStore.patch({ dinnerModeByDay: { ...userStore.data.dinnerModeByDay, [dayId]: mode } })
    this.render()
  },

  editMeal(event) {
    const mealId = event.currentTarget.dataset.id
    if (mealId) wx.navigateTo({ url: `/pages/meal-edit/meal-edit?mealId=${encodeURIComponent(mealId)}` })
  },

  openPlanner() { wx.navigateTo({ url: '/pages/planner/planner' }) },
  openDraft() { wx.navigateTo({ url: '/pages/plan-preview/plan-preview' }) },
  openHistory() { wx.navigateTo({ url: '/pages/plan-history/plan-history' }) },
  openBasis() { wx.navigateTo({ url: '/pages/guide/guide' }) },
  retrySync() { this.loadData(true) },
  onPullDownRefresh() { this.loadData(true) },
})
