'use strict'

const { userStore } = require('../../services/user-store')
const { membershipStore } = require('../../services/membership-store')
const editor = require('../../services/meal-editor')
const { storedMealConditions } = require('../../services/meal-conditions')

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
    ...storedMealConditions(meal),
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
    loadedForm: {},
    formDirty: false,
    originalIngredients: [],
    hasStructuredIngredients: false,
    mealLabel: '',
    scenarioLabel: '',
    dayLabel: '',
    isAiPlan: false,
    hasOverride: false,
    saving: false,
    resetting: false,
    ingredientRows: [], loadedIngredientRows: [], baseIngredientRows: [],
    canSyncIngredients: false, legacyIngredientNote: '', inlineError: '',
    previewing: false, previewChanges: [], previewResetCount: 0,
  },

  async onLoad(options) {
    this.unloaded = false
    this.namespace = membershipStore.cacheNamespace
    if (typeof membershipStore.onCacheNamespaceChange === 'function') this.unsubscribeIdentity = membershipStore.onCacheNamespaceChange(() => {
      if (!this.namespace || this.namespace === membershipStore.cacheNamespace) return
      this.pendingOverride = undefined
      if (!this.unloaded) this.setData({ loading: false, error: '账号已变化，请返回餐单后重新进入', errorAction: 'back', base: {}, form: {}, loadedForm: {}, ingredientRows: [], loadedIngredientRows: [], baseIngredientRows: [], originalIngredients: [], legacyIngredientNote: '', previewChanges: [], previewing: false })
    })
    this.refreshPageNavigation()
    await this.load(options)
  },

  onShow() {
    this.refreshPageNavigation()
  },

  onUnload() { this.unloaded = true; if (this.unsubscribeIdentity) this.unsubscribeIdentity(); this.setUnloadAlert(false) },

  refreshPageNavigation() {
    const canGoBack = canNavigateBack()
    this.setData({
      canNavigateBack: canGoBack,
      pageNavigationLabel: canGoBack ? '返回上一页' : '返回餐单首页',
    })
  },

  hasUnsavedChanges() {
    return !this.data.loading && !this.data.error && (!sameForm(this.data.form, this.data.loadedForm)
      || editor.rowSnapshot(this.data.ingredientRows) !== editor.rowSnapshot(this.data.loadedIngredientRows))
  },
  setUnloadAlert(enabled) {
    if (enabled === this.unloadAlertEnabled) return
    if (enabled && typeof wx.enableAlertBeforeUnload === 'function') {
      try {
        wx.enableAlertBeforeUnload({ message: '个人餐食调整尚未保存，离开后将丢失这些修改。' })
        this.unloadAlertEnabled = true
      } catch (_) {}
      return
    }
    if (!enabled && this.unloadAlertEnabled && typeof wx.disableAlertBeforeUnload === 'function') {
      try { wx.disableAlertBeforeUnload() } catch (_) {}
    }
    if (!enabled) this.unloadAlertEnabled = false
  },
  refreshDirtyState() {
    const formDirty = this.hasUnsavedChanges()
    if (formDirty !== this.data.formDirty) this.setData({ formDirty })
    this.setUnloadAlert(formDirty)
    return formDirty
  },
  async confirmDiscardChanges() {
    if (this.unloaded || this.resetPromptPending) return false
    if (!this.refreshDirtyState()) return true
    if (this.discardPromptPending) return false
    const namespace = membershipStore.cacheNamespace
    this.discardPromptPending = true
    const confirmed = await new Promise((resolve) => {
      try {
        wx.showModal({
          title: '放弃未保存的调整？',
          content: '返回后，本次对餐名、食材、做法和提示的修改将不会保留。',
          confirmText: '放弃修改',
          confirmColor: '#A33F2B',
          cancelText: '继续编辑',
          success: ({ confirm }) => resolve(Boolean(confirm)),
          fail: () => resolve(false),
        })
      } catch (_) { resolve(false) }
    })
    this.discardPromptPending = false
    if (this.unloaded || namespace !== membershipStore.cacheNamespace) return false
    if (confirmed) this.setUnloadAlert(false)
    return confirmed
  },
  async navigateFromPage() {
    if (this.unloaded || this.resetPromptPending || this.data.saving || this.data.resetting) return false
    const namespace = membershipStore.cacheNamespace
    if (!await this.confirmDiscardChanges()) return false
    if (this.unloaded || namespace !== membershipStore.cacheNamespace) return false
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
      if (this.unloaded || this.data.error) return
      if (!member || member.status !== 'active') {
        wx.reLaunch({ url: '/pages/access/access' })
        return
      }
      const namespace = membershipStore.cacheNamespace
      this.namespace = namespace
      await userStore.init({ force })
      if (this.unloaded || namespace !== membershipStore.cacheNamespace) return
      this.namespace = namespace
      const found = findPlanMeal(userStore.data.activePlan, mealId)
      if (!found) throw new Error('当前计划中没有这份餐食，计划可能已更新')
      const base = baseForm(found.meal)
      if (!base.title || !base.ingredients || !base.method) throw new Error('餐食数据不完整，暂时无法编辑')
      const overrides = userStore.data.mealOverrides && typeof userStore.data.mealOverrides === 'object'
        ? userStore.data.mealOverrides : {}
      const override = overrides[mealId]
      const form = override ? sanitizedForm({ ...base, ...override }) : base
      this.existingOverride = override
      this.loadedOverrideSignature = JSON.stringify(override || null)
      const canSyncIngredients = found.plan.days.every(day => day.meals.every(meal => Array.isArray(meal.ingredients)))
      const rows = structuredIngredients(override && override.ingredientItems || found.meal.ingredients)
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
        loadedForm: { ...form },
        formDirty: false,
        ingredientRows: rows, loadedIngredientRows: rows.map(row => ({ ...row })), baseIngredientRows: structuredIngredients(found.meal.ingredients),
        canSyncIngredients, legacyIngredientNote: override && !override.ingredientItems ? override.ingredients || '' : '',
        inlineError: '', previewing: false,
        originalIngredients: structuredIngredients(found.meal.ingredients),
        hasStructuredIngredients: Array.isArray(found.meal.ingredients),
        mealLabel: type,
        scenarioLabel: scenario,
        dayLabel: [date, dayName].filter(Boolean).join(' · '),
        isAiPlan: found.plan.source === 'ai',
        hasOverride: Boolean(override),
      })
    } catch (error) {
      if (!this.unloaded && !this.data.error) this.setData({ loading: false, error: error.message || '暂时无法打开这份餐食' })
    }
  },

  retry() {
    this.load({ mealId: encodeURIComponent(this.data.mealId) }, true)
  },

  backToPlan() {
    if (!this.hasUnsavedChanges()) return wx.switchTab({ url: '/pages/plan/plan' })
    return this.navigateFromPage()
  },

  input(event) {
    if (this.data.saving || this.data.resetting || this.data.previewing) return
    const field = event.currentTarget.dataset.field
    if (!EDITABLE_FIELDS.includes(field)) return
    this.setData({ [`form.${field}`]: event.detail.value }, () => this.refreshDirtyState())
  },

  inputIngredient(event) {
    if (this.data.saving || this.data.resetting || this.data.previewing) return
    const { index, field } = event.currentTarget.dataset
    if (!['name', 'quantity', 'unit', 'category'].includes(field) || !this.data.ingredientRows[index]) return
    const rows = this.data.ingredientRows.map((row, i) => i === Number(index) ? { ...row, [field]: event.detail.value } : row)
    this.setData({ ingredientRows: rows, inlineError: '' }, () => this.refreshDirtyState())
  },
  addIngredient() {
    if (this.data.saving || this.data.resetting || this.data.previewing || this.data.ingredientRows.length >= 30) return
    this.rowSequence = (this.rowSequence || 0) + 1
    this.setData({ ingredientRows: [...this.data.ingredientRows, { id: `new-${this.rowSequence}`, name: '', quantity: '', unit: 'g', category: '其他' }], inlineError: '' }, () => this.refreshDirtyState())
  },
  removeIngredient(event) {
    if (this.data.saving || this.data.resetting || this.data.previewing || this.data.ingredientRows.length <= 1) return
    this.setData({ ingredientRows: this.data.ingredientRows.filter((_, i) => i !== Number(event.currentTarget.dataset.index)), inlineError: '' }, () => this.refreshDirtyState())
  },
  cancelPreview() { if (!this.data.saving) this.setData({ previewing: false, inlineError: '' }) },

  currentContext() {
    const state = userStore.data, plan = state.activePlan
    return !this.unloaded && this.namespace === membershipStore.cacheNamespace && plan && plan.id === this.data.planId
      && Boolean(findPlanMeal(plan, this.data.mealId))
  },
  previewSnapshot() {
    const state = userStore.data
    return JSON.stringify([state.stateRevision, state.mealOverrides, state.checkedShoppingIds, state.dinnerModeByDay, state.defaultDinnerMode])
  },
  async save() {
    if (this.data.saving || this.data.resetting || this.data.previewing) return
    const form = sanitizedForm(this.data.form)
    if (!form.title || !form.ingredients || !form.method) { this.setData({ inlineError: '名称、食材和做法不能为空' }); return }
    if (!this.currentContext()) { this.setData({ error: '账号或当前餐单已经变化，请返回后重新打开餐食', errorAction: 'back' }); return }
    if (JSON.stringify(userStore.data.mealOverrides[this.data.mealId] || null) !== this.loadedOverrideSignature) {
      this.setData({ inlineError: '这餐已在其他操作中修改，请重新读取后再编辑' }); return
    }
    try {
      const rowsChanged = this.data.canSyncIngredients && editor.rowSnapshot(this.data.ingredientRows) !== editor.rowSnapshot(this.data.loadedIngredientRows)
      this.pendingOverride = editor.draftOverride(form, this.data.base, this.data.ingredientRows, this.data.baseIngredientRows, this.existingOverride, rowsChanged)
      const preview = editor.previewChange(userStore.data, this.data.mealId, this.pendingOverride)
      this.previewState = this.previewSnapshot()
      this.setData({ previewing: true, previewChanges: preview.changes, previewResetCount: preview.checkedReset, inlineError: '' })
    } catch (error) { this.setData({ inlineError: error.message || '请检查食材和数量后重试' }) }
  },
  async confirmSave() {
    if (!this.data.previewing || this.data.saving || this.data.resetting || this.pendingOverride === undefined) return
    if (!this.currentContext() || this.previewState !== this.previewSnapshot()) {
      this.setData({ previewing: false, inlineError: '餐单或采购状态已变化，请重新预览后确认' }); return
    }
    const override = this.pendingOverride
    this.setData({ saving: true, inlineError: '' })
    try {
      await userStore.setMealOverride(this.data.mealId, override)
      if (!this.currentContext()) return
      this.setUnloadAlert(false)
      this.setData({ loadedForm: { ...this.data.form }, loadedIngredientRows: this.data.ingredientRows.map(row => ({ ...row })), formDirty: false })
      wx.showToast({ title: '个人调整已保存', icon: 'success' })
      setTimeout(() => { if (this.currentContext()) returnFromSecondaryPage() }, 500)
    } catch (error) {
      if (!this.currentContext()) return
      this.setData({ saving: false, inlineError: userStore.state === 'offline'
        ? '尚未同步到云端，本机调整已保留；联网后可重试确认。' : error.message || '保存失败，请检查后重试' }, () => this.refreshDirtyState())
      this.loadedOverrideSignature = JSON.stringify(userStore.data.mealOverrides[this.data.mealId] || null)
      this.existingOverride = userStore.data.mealOverrides[this.data.mealId]
      this.previewState = this.previewSnapshot()
    }
  },

  reset() {
    if (this.unloaded || this.resetPromptPending || this.discardPromptPending || this.data.saving || this.data.resetting || this.data.previewing) return
    this.resetPromptPending = true
    let handled = false
    const closePrompt = () => {
      if (handled) return false
      handled = true
      this.resetPromptPending = false
      return true
    }
    const fail = () => {
      if (closePrompt() && this.currentContext()) this.setData({ inlineError: '暂时无法打开确认，请重试' })
    }
    try { wx.showModal({ title: '恢复原计划内容？', content: '只恢复这一餐；采购清单将按原食材重新计算，受影响项需重新勾选，其他勾选保留。', confirmText: '恢复', fail, success: async ({ confirm }) => {
      if (!closePrompt() || !confirm || this.unloaded) return
      if (!this.currentContext() || JSON.stringify(userStore.data.mealOverrides[this.data.mealId] || null) !== this.loadedOverrideSignature) { this.setData({ inlineError: '餐食已变化，请重新读取后再恢复' }); return }
      this.setData({ resetting: true })
      try {
        await userStore.setMealOverride(this.data.mealId, null)
        if (!this.currentContext()) return
        this.setUnloadAlert(false)
        this.setData({ loadedForm: { ...this.data.base }, form: { ...this.data.base }, formDirty: false })
        wx.showToast({ title: '已恢复原计划', icon: 'success' })
        setTimeout(() => { if (this.currentContext()) returnFromSecondaryPage() }, 400)
      } catch (error) {
        if (!this.currentContext()) return
        this.loadedOverrideSignature = JSON.stringify(userStore.data.mealOverrides[this.data.mealId] || null)
        this.setData({ resetting: false, inlineError: userStore.state === 'offline'
          ? '恢复操作尚未同步到云端，本机已保留；联网后可重试。' : error.message || '恢复失败，请重试' }, () => this.refreshDirtyState())
      }
    } }) } catch (_) { fail() }
  },
})
