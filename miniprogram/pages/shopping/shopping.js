'use strict'

const { userStore } = require('../../services/user-store')
const { authStore } = require('../../services/auth-store')
const { membershipStore } = require('../../services/membership-store')
const { buildPlanView, shoppingView } = require('../../services/plan-view')

function amountText(item) {
  if (typeof item.amount === 'string' && item.amount.trim()) return item.amount.trim()
  if (Number.isFinite(Number(item.quantity)) && item.unit) return `${Number(item.quantity)} ${item.unit}`
  const ingredient = item.ingredient && typeof item.ingredient === 'object' ? item.ingredient : null
  if (ingredient && Number.isFinite(Number(ingredient.quantity)) && ingredient.unit) return `${Number(ingredient.quantity)} ${ingredient.unit}`
  return '按餐单备齐'
}

function prepareGroups(groups) {
  return groups.map((group, groupIndex) => ({
    ...group,
    key: group.id || `shopping-group-${groupIndex + 1}`,
    name: group.name || '其他食材',
    items: group.items.map((item) => ({
      ...item,
      key: item.itemId,
      amountText: amountText(item),
    })),
  }))
}

function isConflict(error) {
  const message = `${error && error.code || ''} ${error && error.message || ''}`
  return /STATE_REVISION_CONFLICT|版本|冲突|其他设备|another device|changed|reload/i.test(message)
}

function operationIdentity() {
  const state = userStore.data || {}
  const activePlanId = state.activePlanId || (state.activePlan && state.activePlan.id) || ''
  return {
    cacheNamespace: membershipStore.cacheNamespace || '',
    activePlanId: typeof activePlanId === 'string' ? activePlanId : '',
  }
}

function sameOperationScope(scope, identity) {
  return Boolean(scope)
    && scope.cacheNamespace === identity.cacheNamespace
    && scope.activePlanId === identity.activePlanId
}

function createOperationScope(identity) {
  return {
    ...identity,
    changeSequence: 0,
    pendingOperations: new Map(),
    syncTimer: null,
    syncPromise: null,
    conflictPending: false,
  }
}

const shoppingPage = {
  data: {
    viewState: 'loading',
    groups: [],
    total: 0,
    checked: 0,
    remaining: 0,
    planTitle: '',
    durationDays: 0,
    dateRangeText: '',
    mealSummaryText: '',
    offline: false,
    saving: false,
    errorMessage: '',
    emptyKind: '',
    skeletons: [1, 2, 3],
  },

  onLoad() {
    this.skipFirstShow = true
    this.operationScope = createOperationScope(operationIdentity())
    this.unsubscribeNamespace = membershipStore.onCacheNamespaceChange(() => this.ensureOperationScope())
    this.loadData()
  },

  onShow() {
    if (this.skipFirstShow) {
      this.skipFirstShow = false
      return
    }
    const scope = this.ensureOperationScope()
    if (this.data.saving || scope.pendingOperations.size) this.retrySync()
    else this.loadData()
  },

  onHide() {
    const scope = this.ensureOperationScope()
    clearTimeout(scope.syncTimer)
    if (scope.pendingOperations.size) this.syncChanges(scope).catch(() => {})
  },

  onUnload() {
    const scope = this.ensureOperationScope()
    clearTimeout(scope.syncTimer)
    if (scope.pendingOperations.size) this.syncChanges(scope).catch(() => {})
    if (this.unsubscribeNamespace) this.unsubscribeNamespace()
  },

  ensureOperationScope() {
    const identity = operationIdentity()
    if (sameOperationScope(this.operationScope, identity)) return this.operationScope
    if (this.operationScope) {
      clearTimeout(this.operationScope.syncTimer)
      this.operationScope.pendingOperations.clear()
    }
    this.operationScope = createOperationScope(identity)
    return this.operationScope
  },

  isCurrentOperationScope(scope) {
    return scope === this.operationScope && sameOperationScope(scope, operationIdentity())
  },

  async loadData(force = false) {
    const initialScope = this.ensureOperationScope()
    if (initialScope.pendingOperations.size) return this.retrySync()
    this.setData({ viewState: 'loading', errorMessage: '' })
    let loadError = ''
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      await authStore.init({ force })
      await userStore.init({ force })
    } catch (error) {
      loadError = error.message || '采购清单加载失败，请重试'
    }
    this.ensureOperationScope()
    this.render(loadError)
    wx.stopPullDownRefresh()
  },

  render(loadError = '') {
    const scope = this.ensureOperationScope()
    const state = userStore.data || {}
    const planView = buildPlanView(state.activePlan, state)
    const shopping = planView.shopping
    const offline = userStore.state === 'offline'
    let viewState = 'ready'
    let emptyKind = ''
    const errorMessage = loadError || (offline ? userStore.error : '') || ''

    if (!planView.hasPlan) {
      if (loadError || userStore.state === 'error') viewState = 'error'
      else {
        viewState = 'empty'
        emptyKind = 'no-plan'
      }
    } else if (!shopping.totalCount) {
      viewState = 'empty'
      emptyKind = 'no-items'
    }

    this.setData({
      viewState,
      groups: prepareGroups(shopping.groups),
      total: shopping.totalCount,
      checked: shopping.checkedCount,
      remaining: shopping.remainingCount,
      planTitle: planView.title,
      durationDays: planView.durationDays,
      dateRangeText: planView.dateRange.text,
      mealSummaryText: planView.mealSummary.text,
      offline,
      saving: scope.pendingOperations.size > 0 || userStore.state === 'saving',
      errorMessage,
      emptyKind,
    })
  },

  currentShopping() {
    return shoppingView(userStore.data && userStore.data.activePlan, userStore.data || {})
  },

  applyCheckedIds(nextChecked, changedIds) {
    const scope = this.ensureOperationScope()
    const current = this.currentShopping()
    const allowed = new Set(current.groups.flatMap((group) => group.items.map((item) => item.itemId)))
    const checkedShoppingIds = [...nextChecked].filter((id) => allowed.has(id))
    scope.changeSequence += 1
    changedIds.forEach((id) => {
      if (allowed.has(id)) scope.pendingOperations.set(id, { checked: nextChecked.has(id), sequence: scope.changeSequence })
    })
    try {
      userStore.patch({ checkedShoppingIds }, { localOnly: true })
      scope.conflictPending = false
      this.render()
      this.scheduleSync(500, scope)
    } catch (error) {
      this.setData({ errorMessage: error.message || '采购进度无法保存' })
    }
  },

  toggleItem(event) {
    const itemId = event.currentTarget.dataset.id
    if (!itemId) return
    const current = this.currentShopping()
    const checked = new Set(current.checkedIds)
    if (checked.has(itemId)) checked.delete(itemId)
    else checked.add(itemId)
    this.applyCheckedIds(checked, [itemId])
  },

  scheduleSync(delay = 500, requestedScope = this.ensureOperationScope()) {
    if (!this.isCurrentOperationScope(requestedScope)) return
    clearTimeout(requestedScope.syncTimer)
    requestedScope.syncTimer = setTimeout(() => {
      if (this.isCurrentOperationScope(requestedScope)) this.syncChanges(requestedScope).catch(() => {})
    }, delay)
  },

  syncChanges(requestedScope = this.ensureOperationScope()) {
    if (!this.isCurrentOperationScope(requestedScope)) return Promise.resolve(userStore.data)
    clearTimeout(requestedScope.syncTimer)
    if (!requestedScope.pendingOperations.size) return Promise.resolve(userStore.data)
    if (requestedScope.syncPromise) return requestedScope.syncPromise
    const syncedSequence = requestedScope.changeSequence
    this.setData({ saving: true, errorMessage: '' })
    const request = userStore.flush().then((data) => {
      if (!this.isCurrentOperationScope(requestedScope)) return data
      for (const [id, operation] of requestedScope.pendingOperations) {
        if (operation.sequence <= syncedSequence) requestedScope.pendingOperations.delete(id)
      }
      requestedScope.conflictPending = false
      this.render()
      return data
    }).catch((error) => {
      if (this.isCurrentOperationScope(requestedScope)) {
        requestedScope.conflictPending = isConflict(error)
        this.render(error.message || '尚未同步到云端，点此重试')
      }
      throw error
    }).finally(() => {
      if (requestedScope.syncPromise === request) requestedScope.syncPromise = null
      if (this.isCurrentOperationScope(requestedScope) && requestedScope.pendingOperations.size && !requestedScope.conflictPending && userStore.state !== 'offline') {
        this.scheduleSync(80, requestedScope)
      }
    })
    requestedScope.syncPromise = request
    return request
  },

  async mergePendingWithCloud(requestedScope = this.ensureOperationScope()) {
    if (!this.isCurrentOperationScope(requestedScope)) return userStore.data
    const operations = [...requestedScope.pendingOperations.entries()]
    await userStore.init({ force: true })
    if (!this.isCurrentOperationScope(requestedScope)) {
      this.ensureOperationScope()
      this.render()
      return userStore.data
    }
    if (userStore.state !== 'ready') throw new Error(userStore.error || '云端状态仍不可用')

    const latest = this.currentShopping()
    const allowed = new Set(latest.groups.flatMap((group) => group.items.map((item) => item.itemId)))
    const checked = new Set(latest.checkedIds)
    operations.forEach(([id, operation]) => {
      if (!allowed.has(id)) return
      if (operation.checked) checked.add(id)
      else checked.delete(id)
    })

    requestedScope.pendingOperations.clear()
    const applicable = operations.filter(([id]) => allowed.has(id))
    if (!applicable.length) {
      requestedScope.conflictPending = false
      this.render()
      return
    }
    requestedScope.changeSequence += 1
    applicable.forEach(([id, operation]) => requestedScope.pendingOperations.set(id, { checked: operation.checked, sequence: requestedScope.changeSequence }))
    userStore.patch({ checkedShoppingIds: [...checked] }, { localOnly: true })
    requestedScope.conflictPending = false
    await this.syncChanges(requestedScope)
    if (this.isCurrentOperationScope(requestedScope)) wx.showToast({ title: '已合并云端进度', icon: 'success' })
  },

  async retrySync() {
    const scope = this.ensureOperationScope()
    if (scope.syncPromise) return scope.syncPromise.catch(() => {})
    if (!scope.pendingOperations.size) return this.loadData(true)
    try {
      if (scope.conflictPending) await this.mergePendingWithCloud(scope)
      else await this.syncChanges(scope)
    } catch (error) {
      if (!this.isCurrentOperationScope(scope)) return
      if (isConflict(error)) {
        scope.conflictPending = true
        wx.showModal({
          title: '云端采购进度已变化',
          content: '另一台设备更新了清单。再次点“重试同步”会先读取云端，再合并你在本页勾选过的项目。',
          showCancel: false,
          confirmText: '知道了',
        })
      } else {
        wx.showToast({ title: error.message || '同步失败，请检查网络', icon: 'none' })
      }
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  resetChecked() {
    const current = this.currentShopping()
    if (!current.checkedIds.length) return
    wx.showModal({
      title: '重置采购进度？',
      content: '只会取消当前计划内的采购勾选，不会删除餐单或其他用户的数据。',
      confirmText: '重置',
      confirmColor: '#A33F2B',
      success: ({ confirm }) => {
        if (!confirm) return
        this.applyCheckedIds(new Set(), current.checkedIds)
      },
    })
  },

  openPlanner() { wx.navigateTo({ url: '/pages/planner/planner' }) },
  openPlan() { wx.switchTab({ url: '/pages/plan/plan' }) },
  onPullDownRefresh() { this.retrySync() },
}

Page(shoppingPage)

module.exports = { shoppingPage, createOperationScope, sameOperationScope }
