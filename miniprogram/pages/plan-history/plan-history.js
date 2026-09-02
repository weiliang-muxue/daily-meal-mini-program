'use strict'

const { membershipStore } = require('../../services/membership-store')
const { userStore } = require('../../services/user-store')
const { MAX_HISTORY } = require('../../services/user-state-core')

const MEAL_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }
const SCENARIO_LABELS = { rest: '不运动', workout: '运动' }
const PLAN_URL = '/pages/plan/plan'

function canNavigateBack() {
  try {
    return typeof getCurrentPages === 'function' && getCurrentPages().length > 1
  } catch (_) {
    return false
  }
}

function returnFromSecondaryPage() {
  const goHome = () => wx.switchTab({ url: PLAN_URL })
  if (!canNavigateBack() || typeof wx.navigateBack !== 'function') return goHome()
  try {
    return wx.navigateBack({ delta: 1, fail: goHome })
  } catch (_) {
    return goHome()
  }
}

function pad(value) { return String(value).padStart(2, '0') }

function dateRange(plan) {
  const days = Array.isArray(plan.days) ? plan.days : []
  const start = days[0] && days[0].date || plan.startDate || ''
  const end = days[days.length - 1] && days[days.length - 1].date || start
  if (!start) return `${days.length} 天`
  return end && end !== start ? `${start} 至 ${end}` : start
}

function formatTimestamp(value) {
  if (!value) return '历史餐单'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '历史餐单'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function mealLabel(meal) {
  const base = meal.label || MEAL_LABELS[meal.type] || '餐次'
  const scenario = SCENARIO_LABELS[meal.scenario] || ''
  return scenario && !base.includes(scenario) ? `${base} · ${scenario}` : base
}

function prepareHistoryPlan(plan, expanded) {
  const days = Array.isArray(plan.days) ? plan.days.map((day, dayIndex) => ({
    ...day,
    key: day.id || `${plan.id}-day-${dayIndex}`,
    heading: [day.date, day.name].filter(Boolean).join(' · ') || `第 ${dayIndex + 1} 天`,
    meals: Array.isArray(day.meals) ? day.meals.map((meal, mealIndex) => ({
      ...meal,
      key: meal.id || `${day.id}-${mealIndex}`,
      displayLabel: mealLabel(meal),
    })) : [],
  })) : []
  const mealCount = days.reduce((sum, day) => sum + day.meals.length, 0)
  return {
    ...plan,
    days,
    expanded,
    dateRange: dateRange(plan),
    mealCount,
    generatedText: formatTimestamp(plan.generatedAt),
    sourceText: plan.source === 'legacy' ? '历史迁移' : plan.source === 'ai' ? 'AI 生成' : '个人计划',
    expandText: expanded ? '收起餐次概览' : '查看日期与餐次概览',
  }
}

function isConflict(error) {
  const text = `${error && error.code || ''} ${error && error.message || ''}`
  return /STATE_REVISION_CONFLICT|版本|冲突|其他设备|another device|changed|reload/i.test(text)
}

function confirmModal(options) {
  return new Promise((resolve) => wx.showModal({ ...options, success: ({ confirm }) => resolve(Boolean(confirm)), fail: () => resolve(false) }))
}

Page({
  data: {
    canNavigateBack: false,
    pageNavigationLabel: '返回餐单首页',
    viewState: 'loading',
    offline: false,
    errorMessage: '',
    plans: [],
    historyCapacity: MAX_HISTORY,
    expandedPlanId: '',
    restoringPlanId: '',
  },

  onLoad() { this.refreshPageNavigation(); this.loadData() },
  onShow() { this.refreshPageNavigation(); if (this.data.viewState !== 'loading') this.render() },
  onPullDownRefresh() { this.loadData(true) },

  async loadData(force = false) {
    this.setData({ viewState: 'loading', errorMessage: '' })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      await userStore.init({ force })
      this.render()
    } catch (error) {
      const history = userStore.data && userStore.data.planHistory
      if (Array.isArray(history) && history.length) this.render(true)
      else this.setData({ viewState: 'error', offline: true, errorMessage: error.message || '餐单历史加载失败，请重试' })
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  render(forceOffline = false) {
    const history = Array.isArray(userStore.data && userStore.data.planHistory) ? userStore.data.planHistory : []
    const plans = history.map((plan) => prepareHistoryPlan(plan, plan.id === this.data.expandedPlanId))
    this.setData({
      viewState: plans.length ? (userStore.state === 'offline' || forceOffline ? 'offline' : 'ready') : 'empty',
      offline: userStore.state === 'offline' || forceOffline,
      errorMessage: userStore.error || '',
      plans,
    })
  },

  retry() { this.loadData(true) },

  refreshPageNavigation() {
    const canGoBack = canNavigateBack()
    this.setData({
      canNavigateBack: canGoBack,
      pageNavigationLabel: canGoBack ? '返回上一页' : '返回餐单首页',
    })
  },

  navigateFromPage() {
    return returnFromSecondaryPage()
  },

  openPlanner() { wx.navigateTo({ url: '/pages/planner/planner' }) },

  togglePlan(event) {
    const planId = event.currentTarget.dataset.id
    this.setData({ expandedPlanId: this.data.expandedPlanId === planId ? '' : planId })
    this.render()
  },

  async refreshAfterConflict() {
    let refreshed = false
    try {
      await userStore.init({ force: true })
      refreshed = true
      this.render()
    } catch (_) {
      this.render(true)
    }
    wx.showModal({
      title: '餐单历史已变化',
      content: refreshed ? '已重新载入最新餐单历史，请核对后再恢复。当前餐单没有被替换。' : '暂时无法刷新餐单历史，请恢复网络后重试。当前餐单没有被替换。',
      showCancel: false,
      confirmText: '知道了',
    })
  },

  async restorePlan(event) {
    if (this.data.restoringPlanId) return
    const planId = event.currentTarget.dataset.id
    const plan = this.data.plans.find((item) => item.id === planId)
    if (!plan) return
    const confirmed = await confirmModal({
      title: '恢复这份历史餐单？',
      content: `将“${plan.title}”设为当前餐单。现在使用的餐单会自动进入历史，并恢复这份餐单自己的采购勾选和晚餐选择。`,
      confirmText: '继续',
    })
    if (!confirmed) return
    const confirmedAgain = await confirmModal({
      title: '再次确认恢复',
      content: '确定切换当前餐单吗？此操作不会删除其他历史餐单。',
      confirmText: '确认恢复',
    })
    if (!confirmedAgain) return
    this.setData({ restoringPlanId: planId })
    try {
      await userStore.restoreHistory(planId)
      wx.showToast({ title: '历史餐单已恢复', icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/plan/plan' }), 350)
    } catch (error) {
      if (isConflict(error)) await this.refreshAfterConflict()
      else wx.showModal({ title: '恢复失败', content: `${error.message || '请稍后重试'}。当前餐单没有变化。`, showCancel: false, confirmText: '知道了' })
    } finally {
      this.setData({ restoringPlanId: '' })
    }
  },
})
