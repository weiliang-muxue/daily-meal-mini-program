const { catalog, plans, findPlan, findDay } = require('../../data/meal-plan')
const { userStore } = require('../../services/user-store')
const { authStore } = require('../../services/auth-store')
const { membershipStore } = require('../../services/membership-store')
const { formatUpdatedAt } = require('../../utils/date')

function mealWithOverride(dayId, type, meal, overrides) {
  const mealId = `${dayId}:${type}`
  const override = overrides[mealId]
  return { ...meal, ...(override || {}), mealId, personalized: Boolean(override) }
}

Page({
  data: {
    plans,
    days: [],
    activePlanId: catalog.defaultPlanId,
    planTitle: '',
    selectedDay: 0,
    selected: {},
    dinnerMode: 'rest',
    dinner: {},
    loading: true,
    offline: false,
    syncText: '正在连接云端',
  },

  onLoad() { this.loadData() },
  onShow() { if (!this.data.loading) this.render() },
  onHide() { userStore.flush().catch(() => {}) },

  async loadData(force = false) {
    this.setData({ loading: true })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      await authStore.init({ force })
      await userStore.init({ force })
    } catch (_) {}
    this.render()
  },

  render() {
    const state = userStore.data
    const plan = findPlan(state.activePlanId || catalog.defaultPlanId)
    const fallbackIndex = Number.isInteger(state.selectedDay) ? state.selectedDay : 0
    const selected = findDay(plan, state.selectedDayId, fallbackIndex)
    const selectedDay = plan.days.findIndex((day) => day.id === selected.id)
    const dinnerMode = state.dinnerModeByDay[selected.id] || state.defaultDinnerMode
    const breakfast = mealWithOverride(selected.id, 'breakfast', selected.breakfast, state.mealOverrides)
    const dinnerType = dinnerMode === 'workout' ? 'workoutDinner' : 'restDinner'
    const dinner = mealWithOverride(selected.id, dinnerType, selected[dinnerType], state.mealOverrides)
    this.setData({
      days: plan.days, activePlanId: plan.id, planTitle: plan.title, selectedDay, selected, dinnerMode,
      breakfast, dinner,
      loading: false,
      offline: userStore.state === 'offline',
      syncText: userStore.state === 'offline' ? '离线快照 · 点此重试' : `云端已同步 ${formatUpdatedAt(state.updatedAt)}`,
    })
    wx.stopPullDownRefresh()
  },

  selectDay(event) {
    const selectedDay = Number(event.currentTarget.dataset.index)
    const selectedDayId = this.data.days[selectedDay].id
    userStore.patch({ selectedDay, selectedDayId })
    this.render()
  },

  selectPlan(event) {
    const activePlanId = event.currentTarget.dataset.id
    const plan = findPlan(activePlanId)
    const selectedDay = Math.min(userStore.data.selectedDay, plan.days.length - 1)
    userStore.patch({ activePlanId: plan.id, selectedDay, selectedDayId: plan.days[selectedDay].id })
    this.render()
  },

  onSwiperChange(event) {
    const selectedDay = Number(event.detail.current)
    if (selectedDay === this.data.selectedDay) return
    const selectedDayId = this.data.days[selectedDay].id
    userStore.patch({ selectedDay, selectedDayId })
    this.render()
  },

  selectMode(event) {
    const dinnerMode = event.currentTarget.dataset.mode === 'workout' ? 'workout' : 'rest'
    const dinnerModeByDay = { ...userStore.data.dinnerModeByDay, [this.data.selected.id]: dinnerMode }
    userStore.patch({ dinnerModeByDay })
    this.render()
  },

  editBreakfast() { this.openMealEditor(this.data.breakfast.mealId) },
  editDinner() { this.openMealEditor(this.data.dinner.mealId) },
  openMealEditor(mealId) { wx.navigateTo({ url: `/pages/meal-edit/meal-edit?mealId=${encodeURIComponent(mealId)}` }) },

  retrySync() { this.loadData(true) },
  onPullDownRefresh() { this.loadData(true) },
})
