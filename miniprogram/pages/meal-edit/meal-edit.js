'use strict'

const { userStore } = require('../../services/user-store')
const { membershipStore } = require('../../services/membership-store')

const MEAL_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' }
const SCENARIO_LABELS = { default: '', rest: '不运动备选', workout: '运动备选' }
const EDITABLE_FIELDS = ['title', 'ingredients', 'method', 'tag']
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

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function safeDecode(value) {
  try { return decodeURIComponent(String(value || '')) } catch (_) { return '' }
}

function displayIngredients(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (!item || typeof item !== 'object') return ''
      const name = cleanText(item.name, 50)
      const quantity = Number(item.quantity)
      const unit = cleanText(item.unit, 12)
      if (!name || !Number.isFinite(quantity) || quantity <= 0 || !unit) return ''
      return `${name} ${quantity} ${unit}`
    }).filter(Boolean).join(' · ')
  }
  return cleanText(value, 500)
}

function structuredIngredients(value) {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => ({
    id: `${index}-${cleanText(item && item.name, 50)}`,
    name: cleanText(item && item.name, 50),
    quantity: Number.isFinite(Number(item && item.quantity)) ? Number(item.quantity) : '',
    unit: cleanText(item && item.unit, 12),
    category: cleanText(item && item.category, 20),
  })).filter((item) => item.name)
}

function fallbackMealId(plan, day, meal, dayIndex, mealIndex) {
  if (meal && typeof meal.id === 'string' && meal.id) return meal.id
  if (meal && typeof meal.mealId === 'string' && meal.mealId) return meal.mealId
  const planId = cleanText(plan && plan.id, 120) || 'plan'
  const dayId = cleanText(day && day.id, 120) || `${planId}-d${dayIndex + 1}`
  const type = cleanText(meal && meal.type, 20) || 'snack'
  const scenario = cleanText(meal && meal.scenario, 20) || 'default'
  return `${planId}:${dayId}:meal:${type}:${scenario}:${mealIndex + 1}`
}

function findPlanMeal(plan, mealId) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.days)) return null
  for (let dayIndex = 0; dayIndex < plan.days.length; dayIndex += 1) {
    const day = plan.days[dayIndex]
    const meals = Array.isArray(day && day.meals) ? day.meals : []
    for (let mealIndex = 0; mealIndex < meals.length; mealIndex += 1) {
      const meal = meals[mealIndex]
      if (fallbackMealId(plan, day, meal, dayIndex, mealIndex) === mealId) {
        return { plan, day, dayIndex, meal, mealIndex }
      }
    }
  }
  return null
}

function baseForm(meal) {
  return {
    title: cleanText(meal && meal.title, 50),
    ingredients: displayIngredients(meal && meal.ingredients),
    method: cleanText(meal && meal.method, 500),
    tag: cleanText(meal && meal.tag, 80),
  }
}

function sanitizedForm(value) {
  return {
    title: cleanText(value && value.title, 50),
    ingredients: cleanText(value && value.ingredients, 500),
    method: cleanText(value && value.method, 500),
    tag: cleanText(value && value.tag, 80),
  }
}

function sameForm(left, right) {
  return EDITABLE_FIELDS.every((field) => cleanText(left && left[field], field === 'title' ? 50 : field === 'tag' ? 80 : 500)
    === cleanText(right && right[field], field === 'title' ? 50 : field === 'tag' ? 80 : 500))
}

Page({
  data: {
    canNavigateBack: false,
    pageNavigationLabel: '返回餐单首页',
    loading: true,
    error: '',
    errorAction: 'retry',
    mealId: '',
    planId: '',
    base: {},
    form: {},
    originalIngredients: [],
    hasStructuredIngredients: false,
    mealLabel: '',
    scenarioLabel: '',
    dayLabel: '',
    isAiPlan: false,
    hasOverride: false,
    saving: false,
    resetting: false,
  },

  async onLoad(options) {
    this.refreshPageNavigation()
    await this.load(options)
  },

  onShow() {
    this.refreshPageNavigation()
  },

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

  async load(options, force = false) {
    const mealId = safeDecode(options && options.mealId)
    if (!mealId || mealId.length > 120) {
      this.setData({
        loading: false,
        error: '这份餐食已更新或不存在，请返回餐单重新选择',
        errorAction: 'back',
        mealId: '',
      })
      return
    }
    this.setData({ loading: true, error: '', errorAction: 'retry', mealId })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') {
        wx.reLaunch({ url: '/pages/access/access' })
        return
      }
      await userStore.init({ force })
      const found = findPlanMeal(userStore.data.activePlan, mealId)
      if (!found) throw new Error('当前计划中没有这份餐食，计划可能已更新')
      const base = baseForm(found.meal)
      if (!base.title || !base.ingredients || !base.method) throw new Error('餐食数据不完整，暂时无法编辑')
      const overrides = userStore.data.mealOverrides && typeof userStore.data.mealOverrides === 'object'
        ? userStore.data.mealOverrides : {}
      const override = overrides[mealId]
      const form = override ? sanitizedForm({ ...base, ...override }) : base
      const type = MEAL_LABELS[found.meal.type] || cleanText(found.meal.label, 30) || '餐食'
      const scenario = SCENARIO_LABELS[found.meal.scenario || 'default'] || ''
      const date = cleanText(found.day.date, 10)
      const dayName = cleanText(found.day.name, 12) || `第 ${found.dayIndex + 1} 天`
      this.setData({
        loading: false,
        mealId,
        planId: cleanText(found.plan.id, 120),
        base,
        form,
        originalIngredients: structuredIngredients(found.meal.ingredients),
        hasStructuredIngredients: Array.isArray(found.meal.ingredients),
        mealLabel: type,
        scenarioLabel: scenario,
        dayLabel: [date, dayName].filter(Boolean).join(' · '),
        isAiPlan: found.plan.source === 'ai',
        hasOverride: Boolean(override),
      })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '暂时无法打开这份餐食' })
    }
  },

  retry() {
    this.load({ mealId: encodeURIComponent(this.data.mealId) }, true)
  },

  backToPlan() {
    wx.switchTab({ url: '/pages/plan/plan' })
  },

  input(event) {
    const field = event.currentTarget.dataset.field
    if (!EDITABLE_FIELDS.includes(field)) return
    this.setData({ [`form.${field}`]: event.detail.value })
  },

  async save() {
    if (this.data.saving || this.data.resetting) return
    const form = sanitizedForm(this.data.form)
    if (!form.title || !form.ingredients || !form.method) {
      wx.showToast({ title: '名称、食材和做法不能为空', icon: 'none' })
      return
    }
    const currentPlan = userStore.data.activePlan
    if (!currentPlan || currentPlan.id !== this.data.planId || !findPlanMeal(currentPlan, this.data.mealId)) {
      this.setData({ error: '当前计划已经变化，请返回后重新打开餐食' })
      return
    }
    this.setData({ saving: true })
    const override = sameForm(form, this.data.base) ? null : { ...form, updatedAt: new Date().toISOString() }
    try {
      await userStore.setMealOverride(this.data.mealId, override)
      wx.showToast({ title: sameForm(form, this.data.base) ? '已恢复原计划' : '个人调整已保存', icon: 'success' })
      setTimeout(() => this.navigateFromPage(), 500)
    } catch (error) {
      wx.showToast({ title: error.message || '保存失败，请重试', icon: 'none' })
      this.setData({ saving: false })
    }
  },

  reset() {
    if (this.data.saving || this.data.resetting) return
    wx.showModal({ title: '恢复原计划内容？', content: '只删除这份餐食的个人显示调整，不修改已确认计划和采购清单。', confirmText: '恢复', success: async ({ confirm }) => {
      if (!confirm) return
      this.setData({ resetting: true })
      try {
        await userStore.setMealOverride(this.data.mealId, null)
        wx.showToast({ title: '已恢复原计划', icon: 'success' })
        setTimeout(() => this.navigateFromPage(), 400)
      } catch (error) {
        wx.showToast({ title: error.message || '恢复失败，请重试', icon: 'none' })
        this.setData({ resetting: false })
      }
    } })
  },
})
