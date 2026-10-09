'use strict'

const { userStore } = require('../../services/user-store')
const { membershipStore } = require('../../services/membership-store')
const library = require('../../services/recipe-library')
const replacement = require('../../services/meal-replacement')
const { buildPlanView } = require('../../services/plan-view')
const { shoppingChanges } = require('../../services/meal-editor')
const PLAN_URL = '/pages/plan/plan'
function visibleRecipe(recipe) {
  return { ...recipe, displayIngredients: Array.isArray(recipe.ingredientItems)
    ? recipe.ingredientItems.map(item => `${item.name} ${item.quantity} ${item.unit}`).join(' · ') : recipe.ingredients }
}

Page({
  data: {
    canNavigateBack: false, pageNavigationLabel: '返回餐单首页',
    loading: true, busy: false, error: '', notice: '', offline: false, favorites: [], filtered: [],
    query: '', count: 0, capacity: library.MAX_FAVORITES, capture: null, selected: null,
    targets: [], targetIndex: 0, preview: null, reviewed: false,
  },
  onLoad(options = {}) {
    this.active = true
    this.refreshNavigation()
    try { this.captureMealId = decodeURIComponent(String(options.mealId || '')) } catch (_) { this.captureMealId = '' }
    this.unsubscribe = membershipStore.onCacheNamespaceChange(namespace => {
      if (!this.namespace || namespace === this.namespace) return
      this.identityChanged = true
      this.previewState = null
      if (!this.unloaded) this.setData({ favorites: [], filtered: [], capture: null, selected: null, targets: [], preview: null,
        count: 0, query: '', reviewed: false, loading: false, busy: false, notice: '', error: '账号已变化，请返回餐单后重新进入' })
    })
    return this.load()
  },
  onShow() { this.active = true; this.refreshNavigation(); if (this.namespace && !this.data.loading && this.current()) this.render() },
  onHide() { this.active = false; this.previewState = null; this.setData({ preview: null, reviewed: false }) },
  onUnload() { this.unloaded = true; this.active = false; if (this.unsubscribe) this.unsubscribe() },
  current() { return !this.unloaded && !this.identityChanged && this.active && userStore.isCurrentNamespace(this.namespace) },
  async load() {
    if (this.identityChanged || this.data.busy) return
    const epoch = this.loadEpoch = (this.loadEpoch || 0) + 1
    this.setData({ loading: true, error: '', preview: null, reviewed: false })
    try {
      const member = await membershipStore.init()
      if (this.unloaded || this.identityChanged || epoch !== this.loadEpoch) return
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      this.namespace = membershipStore.cacheNamespace
      await userStore.init({ force: true })
      if (!this.current() || epoch !== this.loadEpoch) return
      this.render()
    } catch (error) {
      if (this.current()) { this.render(); this.setData({ error: error.message || '收藏暂时无法加载，请重试' }) }
      else if (!this.unloaded && !this.identityChanged) this.setData({ loading: false, error: '收藏暂时无法加载，请返回重试' })
    }
  },
  render() {
    if (!this.current()) return
    const state = userStore.data, favorites = (state.favoriteRecipes || []).map(item => ({ ...item, recipe: visibleRecipe(item.recipe), reusable: library.reusable(item) }))
    const view = buildPlanView(state.activePlan, state)
    const targets = view.days.flatMap(day => day.meals.map(meal => ({ mealId: meal.id,
      label: `${day.date || day.name} · ${meal.label} · ${meal.title}` })))
    const selected = favorites.find(item => this.data.selected && item.id === this.data.selected.id) || null
    let capture = null
    if (this.captureMealId) {
      try {
        capture = visibleRecipe(library.capture(state, this.captureMealId))
        this.captureRevision = state.stateRevision
        this.capturePlanId = state.activePlan.id
      } catch (_) { this.captureMealId = ''; this.setData({ error: '原餐食已变化，请返回餐单重新选择' }) }
    }
    this.previewState = null
    this.setData({ loading: false, offline: userStore.state !== 'ready', favorites, count: favorites.length,
      capture, selected, targets, targetIndex: 0, preview: null, reviewed: false })
    this.filter()
  },
  filter() {
    const query = this.data.query.trim().toLocaleLowerCase()
    this.setData({ filtered: this.data.favorites.filter(item => !query || `${item.recipe.title} ${item.recipe.displayIngredients}`.toLocaleLowerCase().includes(query)) })
  },
  search(event) { this.setData({ query: String(event.detail.value || '').slice(0, 50) }); this.filter() },
  select(event) {
    if (this.data.busy || !this.current()) return
    const selected = this.data.favorites.find(item => item.id === event.currentTarget.dataset.id)
    this.setData({ selected: selected || null, preview: null, reviewed: false, error: '', notice: '' })
  },
  selectTarget(event) {
    if (this.data.busy || !this.current()) return
    const index = Number(event.detail.value)
    if (Number.isInteger(index) && this.data.targets[index]) this.setData({ targetIndex: index, preview: null, reviewed: false })
  },
  async saveFavorite() {
    if (!this.data.capture || this.data.busy || !this.current() || this.data.offline) return
    await this.write('addFavorite', { mealId: this.captureMealId, expectedPlanId: this.capturePlanId }, this.captureRevision, '已收藏当前餐食副本', true)
  },
  async removeFavorite() {
    if (!this.data.selected || this.data.busy || !this.current() || this.data.offline) return
    const selected = this.data.selected, revision = userStore.data.stateRevision
    this.setData({ busy: true })
    const confirmed = await new Promise(resolve => wx.showModal({ title: '移除这条收藏？',
      content: '只移除收藏副本，已经安排的餐食和历史记录不受影响。', confirmText: '移除收藏',
      success: result => resolve(result.confirm), fail: () => resolve(false) }))
    if (!this.current()) return
    this.setData({ busy: false })
    if (confirmed) await this.write('removeFavorite', { favoriteId: selected.id }, revision, '收藏已移除')
  },
  previewFavorite() {
    if (this.data.busy || !this.current() || this.data.offline || !this.data.selected) return
    try {
      const targetOption = this.data.targets[this.data.targetIndex]
      if (!targetOption) throw new Error('请先确认一份餐单，再选择要安排的餐次')
      const state = userStore.data, target = replacement.createTarget(state, targetOption.mealId)
      const now = new Date().toISOString()
      const next = library.proposal(state, this.data.selected.id, target, now)
      const changes = shoppingChanges(state, next)
      this.previewState = JSON.stringify(state)
      this.previewRequest = { favoriteId: this.data.selected.id, target }
      this.previewRevision = state.stateRevision
      this.setData({ preview: { targetLabel: targetOption.label, ...changes,
        restrictions: state.generationPreferences.restrictions || '尚未填写，请结合实际情况核对',
        dislikes: state.generationPreferences.dislikes || '未填写',
        planRestrictions: state.activePlan.generationBasis.restrictions || '原餐单未记录' }, reviewed: false, error: '', notice: '' })
    } catch (error) { this.setData({ preview: null, reviewed: false, error: error.message || '暂时不能安排，请刷新后重试' }) }
  },
  review(event) { if (!this.data.busy && this.data.preview) this.setData({ reviewed: (event.detail.value || []).includes('reviewed') }) },
  cancelPreview() { if (!this.data.busy) { this.previewState = null; this.setData({ preview: null, reviewed: false }) } },
  async confirmFavorite() {
    if (!this.current() || this.data.busy || this.data.offline || !this.data.preview || !this.data.reviewed) return
    if (this.previewState !== JSON.stringify(userStore.data)) {
      this.setData({ preview: null, reviewed: false, error: '餐单或采购状态已变化，请刷新后重新预览' }); return
    }
    await this.write('applyFavorite', this.previewRequest, this.previewRevision, '已安排到所选餐次，采购清单已更新')
  },
  async write(action, payload, revision, successText, clearCapture = false) {
    if (!this.current() || userStore.state !== 'ready') return
    this.setData({ busy: true, error: '', notice: '' })
    try {
      await userStore.changeFavorite(action, payload, revision)
      if (!this.current()) return
      if (clearCapture) this.captureMealId = ''
      this.render()
      this.setData({ notice: successText })
    } catch (error) {
      if (!this.current()) return
      this.previewState = null
      const known = error && ['RECIPE_LIBRARY_FULL', 'RECIPE_LIBRARY_INVALID', 'STATE_TOO_LARGE'].includes(error.code)
      this.setData({ preview: null, reviewed: false, error: known ? error.message : '操作未确认成功，请刷新核对后再试。当前餐单不会被本机强行覆盖。' })
    } finally { if (!this.unloaded && !this.identityChanged) this.setData({ busy: false }) }
  },
  refreshNavigation() {
    let canNavigateBack = false
    try { canNavigateBack = typeof getCurrentPages === 'function' && getCurrentPages().length > 1 } catch (_) {}
    this.setData({ canNavigateBack, pageNavigationLabel: canNavigateBack ? '返回上一页' : '返回餐单首页' })
  },
  navigateFromPage() {
    if (this.data.busy) return
    const goHome = () => wx.switchTab({ url: PLAN_URL })
    if (!this.data.canNavigateBack || typeof wx.navigateBack !== 'function') return goHome()
    try { wx.navigateBack({ delta: 1, fail: goHome }) } catch (_) { goHome() }
  },
})
