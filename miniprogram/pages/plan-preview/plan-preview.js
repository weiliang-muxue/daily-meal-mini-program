'use strict'

const { membershipStore } = require('../../services/membership-store')
const { userStore } = require('../../services/user-store')

const MEAL_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }
const SCENARIO_LABELS = { default: '', rest: '不运动', workout: '运动' }
const INTENSITY_LABELS = { low: '轻松', medium: '适中', high: '较强' }

function pad(value) { return String(value).padStart(2, '0') }

function formatTimestamp(value) {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未记录'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function dateRange(plan) {
  const days = Array.isArray(plan.days) ? plan.days : []
  const start = days[0] && days[0].date || plan.startDate || ''
  const end = days[days.length - 1] && days[days.length - 1].date || start
  if (!start) return `${days.length} 天`
  return end && end !== start ? `${start} 至 ${end}` : start
}

function ingredientText(item) {
  if (typeof item === 'string') return item.trim()
  if (!item || typeof item !== 'object') return ''
  const quantity = item.quantity === undefined || item.quantity === null ? item.amount : item.quantity
  return [item.name, quantity, item.unit].filter((value) => value !== undefined && value !== null && value !== '').join(' ').trim()
}

function formatIngredients(value) {
  const source = Array.isArray(value) ? value.map(ingredientText) : [ingredientText(value)]
  return source.flatMap((item) => item.split(/\s*[·；;\n]\s*/)).map((item) => item.trim()).filter(Boolean).slice(0, 30)
}

function mealLabel(meal) {
  const base = meal.label || MEAL_LABELS[meal.type] || '餐次'
  const scenario = SCENARIO_LABELS[meal.scenario] || ''
  return scenario && !base.includes(scenario) ? `${base} · ${scenario}` : base
}

function exerciseText(exercise) {
  if (!exercise || !exercise.planned) return '无运动安排'
  const details = [exercise.type, exercise.durationMinutes ? `${exercise.durationMinutes} 分钟` : '', INTENSITY_LABELS[exercise.intensity]].filter(Boolean)
  return details.length ? details.join(' · ') : '有运动安排'
}

function prepareDay(day, dayIndex) {
  const meals = Array.isArray(day.meals) ? day.meals.map((meal, mealIndex) => ({
    ...meal,
    key: meal.id || `${day.id || dayIndex}-${mealIndex}`,
    displayLabel: mealLabel(meal),
    ingredientItems: formatIngredients(meal.ingredients),
  })) : []
  return {
    ...day,
    key: day.id || `day-${dayIndex}`,
    heading: [day.date, day.name].filter(Boolean).join(' · ') || `第 ${dayIndex + 1} 天`,
    exerciseText: exerciseText(day.exercise),
    meals,
  }
}

function generationBasisRows(plan) {
  const basis = plan.generationBasis || {}
  const mealTypes = Array.isArray(basis.mealTypes) ? basis.mealTypes.map((type) => MEAL_LABELS[type] || type) : []
  const rows = [
    { label: '生成餐次', value: mealTypes.join('、') || '未记录' },
    { label: '晚餐方案', value: basis.doubleDinner ? '运动与不运动两套' : '单一方案' },
    { label: '饮食目标', value: [...(basis.goals || []), basis.customGoal].filter(Boolean).join('、') },
    { label: '饮食风格', value: (basis.styles || []).join('、') },
    { label: '忌口约束', value: basis.restrictions || '' },
    { label: '健康约束', value: basis.healthNotes || '' },
    { label: '运动说明', value: basis.exerciseNotes || '' },
  ]
  return rows.filter((row) => row.value)
}

function preparePlan(plan) {
  const days = Array.isArray(plan.days) ? plan.days.map(prepareDay) : []
  return {
    ...plan,
    days,
    dateRange: dateRange(plan),
    basisRows: generationBasisRows(plan),
    rationale: Array.isArray(plan.rationale) ? plan.rationale : [],
    generatedText: formatTimestamp(plan.generatedAt),
    versionText: `计划 v${plan.planVersion || 1} · 契约 v${plan.contractVersion || 0}`,
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
    viewState: 'loading',
    offline: false,
    errorMessage: '',
    plan: null,
    busyAction: '',
  },

  onLoad() { this.loadData() },
  onShow() { if (this.data.viewState !== 'loading') this.render() },
  onPullDownRefresh() { this.loadData(true) },

  async loadData(force = false) {
    this.setData({ viewState: 'loading', errorMessage: '' })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      await userStore.init({ force })
      this.render()
    } catch (error) {
      if (userStore.data && userStore.data.draftPlan) this.render(true)
      else this.setData({ viewState: 'error', offline: true, errorMessage: error.message || '候选计划加载失败，请重试' })
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  render(forceOffline = false) {
    const draft = userStore.data && userStore.data.draftPlan
    if (!draft) {
      this.setData({ viewState: 'no-draft', offline: userStore.state === 'offline' || forceOffline, plan: null, errorMessage: '' })
      return
    }
    this.setData({
      viewState: userStore.state === 'offline' || forceOffline ? 'offline' : 'ready',
      offline: userStore.state === 'offline' || forceOffline,
      errorMessage: userStore.error || '',
      plan: preparePlan(draft),
    })
  },

  retry() { this.loadData(true) },

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
      title: '候选状态已变化',
      content: refreshed ? '已重新载入云端状态，请核对后再操作。当前已确认计划没有被替换。' : '暂时无法刷新云端状态，请恢复网络后重试。当前已确认计划没有被替换。',
      showCancel: false,
      confirmText: '知道了',
    })
  },

  async confirmPlan() {
    if (this.data.busyAction || !this.data.plan) return
    this.setData({ busyAction: 'confirm' })
    try {
      await userStore.confirmDraft()
      wx.showToast({ title: '计划已应用', icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/plan/plan' }), 350)
    } catch (error) {
      if (isConflict(error)) await this.refreshAfterConflict()
      else wx.showModal({ title: '确认失败', content: `${error.message || '请稍后重试'}。当前已确认计划没有变化。`, showCancel: false, confirmText: '知道了' })
    } finally {
      this.setData({ busyAction: '' })
    }
  },

  async discardPlan() {
    if (this.data.busyAction || !this.data.plan) return
    const confirmed = await confirmModal({
      title: '丢弃这份候选计划？',
      content: '丢弃后无法从预览恢复，但不会影响当前已确认计划。',
      confirmText: '继续',
      confirmColor: '#A33F2B',
    })
    if (!confirmed) return
    const confirmedAgain = await confirmModal({
      title: '再次确认丢弃',
      content: '确定删除这份尚未确认的候选计划吗？',
      confirmText: '确认丢弃',
      confirmColor: '#A33F2B',
    })
    if (!confirmedAgain) return
    this.setData({ busyAction: 'discard' })
    try {
      await userStore.discardDraft()
      wx.showToast({ title: '候选已丢弃', icon: 'success' })
      this.render()
    } catch (error) {
      if (isConflict(error)) await this.refreshAfterConflict()
      else wx.showToast({ title: error.message || '丢弃失败，请重试', icon: 'none' })
    } finally {
      this.setData({ busyAction: '' })
    }
  },

  backToPlanner() {
    wx.redirectTo({ url: '/pages/planner/planner' })
  },
})
