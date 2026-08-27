'use strict'

const { callFunction } = require('../utils/cloud')
const { defaults, sanitizeState, sanitizeGenerationPreferences } = require('./user-state-core')
const { membershipStore } = require('./membership-store')

const CACHE_PREFIX = 'meal_user_state_v3_'
const PENDING_PREFIX = 'meal_user_pending_v1_'
const EDITABLE_FIELDS = [
  'generationPreferences', 'selectedDayId', 'selectedDay', 'defaultDinnerMode', 'dinnerModeByDay',
  'planUiStateByPlan', 'mealOverrides', 'checkedShoppingIds', 'customReminders', 'settings',
]
const PLAN_UI_VALUE_FIELDS = ['selectedDayId', 'selectedDay', 'defaultDinnerMode', 'dinnerModeByDay']
const PENDING_VALUE_FIELDS = EDITABLE_FIELDS.filter((key) => (
  key !== 'checkedShoppingIds' && !PLAN_UI_VALUE_FIELDS.includes(key)
))

function cacheKey(namespace) { return namespace ? `${CACHE_PREFIX}${namespace}` : '' }
function pendingKey(namespace) { return namespace ? `${PENDING_PREFIX}${namespace}` : '' }

function normalizeCacheNamespace(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : ''
}

function namespaceChangedError() {
  const error = new Error('微信身份已变化，请重试')
  error.code = 'CACHE_NAMESPACE_CHANGED'
  return error
}

function normalize(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  try { return { ...sanitizeState(value), updatedAt: value.updatedAt || null } }
  catch (_) { return { ...defaults(), updatedAt: null } }
}

function normalizeStrict(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  return { ...sanitizeState(value), updatedAt: value.updatedAt || null }
}

function editableSnapshot(state) {
  return Object.fromEntries(EDITABLE_FIELDS.map((key) => [key, state[key]]))
}

function emptyPlanUiPending() {
  return { fields: {}, fieldRevisions: {}, checkedOperations: {} }
}

function emptyPending() {
  return {
    version: 2,
    revision: 0,
    fields: {},
    fieldRevisions: {},
    planUiByPlan: {},
    unscopedPlanUi: emptyPlanUiPending(),
  }
}

function pendingPlanId(state) {
  if (state && state.activePlan && typeof state.activePlan.id === 'string') return state.activePlan.id
  return state && typeof state.activePlanId === 'string' ? state.activePlanId : ''
}

function normalizePlanUiPending(source) {
  const pending = emptyPlanUiPending()
  PLAN_UI_VALUE_FIELDS.forEach((key) => {
    const revision = Number(source && source.fieldRevisions && source.fieldRevisions[key])
    if (!Object.prototype.hasOwnProperty.call(source && source.fields || {}, key)
      || !Number.isSafeInteger(revision) || revision < 1) return
    pending.fields[key] = source.fields[key]
    pending.fieldRevisions[key] = revision
  })
  Object.entries(source && source.checkedOperations || {}).forEach(([id, operation]) => {
    const revision = Number(operation && operation.revision)
    if (typeof id !== 'string' || !id || id.length > 160 || !operation || typeof operation.checked !== 'boolean') return
    if (!Number.isSafeInteger(revision) || revision < 1) return
    pending.checkedOperations[id] = { checked: operation.checked, revision }
  })
  return pending
}

function planUiRevisions(value) {
  return [
    ...Object.values(value.fieldRevisions),
    ...Object.values(value.checkedOperations).map((operation) => operation.revision),
  ]
}

function planUiHasPending(value) {
  return Boolean(value && (Object.keys(value.fields).length || Object.keys(value.checkedOperations).length))
}

function normalizePending(value, cachedState) {
  const source = value && typeof value === 'object' ? value : {}
  const pending = emptyPending()
  PENDING_VALUE_FIELDS.forEach((key) => {
    const revision = Number(source.fieldRevisions && source.fieldRevisions[key])
    if (!Object.prototype.hasOwnProperty.call(source.fields || {}, key) || !Number.isSafeInteger(revision) || revision < 1) return
    pending.fields[key] = source.fields[key]
    pending.fieldRevisions[key] = revision
  })
  Object.entries(source.planUiByPlan || {}).forEach(([planId, planUi]) => {
    if (typeof planId !== 'string' || !planId || planId.length > 120) return
    const clean = normalizePlanUiPending(planUi)
    if (planUiHasPending(clean)) pending.planUiByPlan[planId] = clean
  })
  pending.unscopedPlanUi = normalizePlanUiPending(source.unscopedPlanUi)

  // v1 stored flat plan UI changes. Attach them to the plan represented by the
  // same cached snapshot so an app update cannot move them to a later plan.
  const legacy = normalizePlanUiPending(source)
  if (planUiHasPending(legacy)) {
    const legacyPlanId = pendingPlanId(cachedState)
    if (legacyPlanId) pending.planUiByPlan[legacyPlanId] = legacy
    else pending.unscopedPlanUi = legacy
  }
  const revisions = [
    ...Object.values(pending.fieldRevisions),
    ...Object.values(pending.planUiByPlan).flatMap(planUiRevisions),
    ...planUiRevisions(pending.unscopedPlanUi),
  ]
  pending.revision = revisions.length ? Math.max(...revisions) : 0
  return pending
}

function hasPending(pending) {
  return Boolean(pending && (
    Object.keys(pending.fields).length
    || Object.values(pending.planUiByPlan).some(planUiHasPending)
    || planUiHasPending(pending.unscopedPlanUi)
  ))
}

function applyPlanUiPending(state, planId, planUi) {
  let base = state
  const activePlanId = pendingPlanId(base)
  const scoped = Boolean(planId)
  const effectivePlanId = planId || activePlanId
  Object.entries(planUi.fields)
    .sort((left, right) => Number(planUi.fieldRevisions[left[0]] || 0) - Number(planUi.fieldRevisions[right[0]] || 0))
    .forEach(([key, value]) => {
      const currentUi = effectivePlanId && base.planUiStateByPlan[effectivePlanId] || {}
      const partial = effectivePlanId
        ? { planUiStateByPlan: { ...base.planUiStateByPlan, [effectivePlanId]: { ...currentUi, [key]: value } } }
        : { [key]: value }
      if (!scoped || effectivePlanId === activePlanId) partial[key] = value
      try { base = normalizeStrict({ ...base, ...partial }) } catch (_) {}
    })
  const currentUi = effectivePlanId && base.planUiStateByPlan[effectivePlanId] || {}
  let checked = new Set(effectivePlanId ? currentUi.checkedShoppingIds || [] : base.checkedShoppingIds)
  Object.entries(planUi.checkedOperations)
    .sort((left, right) => left[1].revision - right[1].revision)
    .forEach(([id, operation]) => {
      const next = new Set(checked)
      if (operation.checked) next.add(id)
      else next.delete(id)
      try {
        const partial = effectivePlanId ? {
          planUiStateByPlan: {
            ...base.planUiStateByPlan,
            [effectivePlanId]: { ...(base.planUiStateByPlan[effectivePlanId] || {}), checkedShoppingIds: [...next] },
          },
        } : { checkedShoppingIds: [...next] }
        if (!scoped || effectivePlanId === activePlanId) partial.checkedShoppingIds = [...next]
        base = normalizeStrict({ ...base, ...partial })
        checked = next
      } catch (_) {}
    })
  return base
}

function applyPending(state, pending) {
  let base = normalize(state)
  const fields = pending && pending.fields || {}
  Object.entries(fields)
    .sort((left, right) => Number(pending.fieldRevisions[left[0]] || 0) - Number(pending.fieldRevisions[right[0]] || 0))
    .forEach(([key, value]) => {
      try { base = normalizeStrict({ ...base, [key]: value }) } catch (_) {}
    })
  if (!pending) return base
  Object.entries(pending.planUiByPlan || {}).forEach(([planId, planUi]) => {
    base = applyPlanUiPending(base, planId, planUi)
  })
  if (planUiHasPending(pending.unscopedPlanUi)) base = applyPlanUiPending(base, '', pending.unscopedPlanUi)
  return base
}

function isRevisionConflict(error) {
  return Boolean(error && error.code === 'STATE_REVISION_CONFLICT')
}

class UserStore {
  constructor(memberStore = membershipStore) {
    this.membershipStore = memberStore
    this.data = normalize()
    this.state = 'idle'
    this.error = ''
    this.initPromise = null
    this.pendingSave = null
    this.saveTimer = null
    this.namespace = ''
    this.cacheLoaded = false
    this.initEpoch = 0
    this.localRevision = 0
    this.confirmedLocalRevision = 0
    this.pending = emptyPending()
    this.unsubscribeNamespace = memberStore.onCacheNamespaceChange((namespace) => this.applyNamespace(namespace))
  }

  applyNamespace(namespace) {
    const nextNamespace = normalizeCacheNamespace(namespace)
    if (nextNamespace === this.namespace) return nextNamespace
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.namespace = nextNamespace
    this.cacheLoaded = false
    this.initEpoch += 1
    this.initPromise = null
    this.pendingSave = null
    this.localRevision = 0
    this.confirmedLocalRevision = 0
    this.pending = emptyPending()
    this.data = normalize()
    this.state = 'idle'
    this.error = ''
    return nextNamespace
  }

  bindNamespace(options = {}) {
    const namespace = this.applyNamespace(this.membershipStore.cacheNamespace)
    if (namespace && options.loadCache !== false && !this.cacheLoaded) {
      const cachedState = normalize(wx.getStorageSync(cacheKey(namespace)))
      this.pending = normalizePending(wx.getStorageSync(pendingKey(namespace)), cachedState)
      this.localRevision = this.pending.revision
      this.data = applyPending(cachedState, this.pending)
      this.cacheLoaded = true
    }
    return namespace
  }

  requireNamespace(options = {}) {
    const namespace = this.bindNamespace(options)
    if (!namespace) throw new Error('需要先在线确认微信身份')
    return namespace
  }

  isCurrentNamespace(namespace) {
    return Boolean(namespace) && namespace === normalizeCacheNamespace(this.membershipStore.cacheNamespace) && namespace === this.namespace
  }

  init(options = {}) {
    let namespace
    try { namespace = this.requireNamespace() }
    catch (error) { return Promise.reject(error) }
    if (this.initPromise && !options.force) return this.initPromise
    const initEpoch = ++this.initEpoch
    this.state = 'loading'
    const request = callFunction('userData', 'bootstrap')
      .then(async (data) => {
        if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
        if (initEpoch !== this.initEpoch) return this.data
        const cloudState = normalize(data)
        if (cloudState.stateRevision >= this.data.stateRevision) {
          this.data = applyPending(cloudState, this.pending)
        }
        this.state = hasPending(this.pending) ? 'saving' : 'ready'
        this.error = ''
        this.persistCache()
        this.persistPending()
        if (hasPending(this.pending)) await this.flush()
        return this.data
      })
      .catch((error) => {
        if (!this.isCurrentNamespace(namespace)) throw error
        if (initEpoch !== this.initEpoch) return this.data
        this.state = this.data.activePlan ? 'offline' : 'error'
        this.error = error.message || '云端数据加载失败'
        if (!this.data.activePlan && !this.data.draftPlan && !hasPending(this.pending)) throw error
        return this.data
      })
      .finally(() => { if (this.initPromise === request) this.initPromise = null })
    this.initPromise = request
    return request
  }

  persistCache(namespace = this.namespace) {
    const key = this.isCurrentNamespace(namespace) ? cacheKey(namespace) : ''
    if (key) wx.setStorageSync(key, this.data)
  }

  persistPending(namespace = this.namespace) {
    const key = this.isCurrentNamespace(namespace) ? pendingKey(namespace) : ''
    if (key) wx.setStorageSync(key, this.pending)
  }

  scheduleFlush(delay = 500) {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush().catch(() => {}), delay)
  }

  replaceFromCloud(value, namespace = this.requireNamespace({ loadCache: false })) {
    if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
    this.data = applyPending(normalize(value), this.pending)
    this.state = hasPending(this.pending) ? 'saving' : 'ready'
    this.error = ''
    this.persistCache()
    this.persistPending()
    return this.data
  }

  patch(partial, options = {}) {
    let namespace
    try { namespace = this.requireNamespace() }
    catch (error) { return Promise.reject(error) }
    const allowed = Object.fromEntries(EDITABLE_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(partial || {}, key)).map((key) => [key, partial[key]]))
    if (allowed.generationPreferences) allowed.generationPreferences = sanitizeGenerationPreferences(allowed.generationPreferences)
    if (!Object.keys(allowed).length) return Promise.resolve(this.data)
    const before = normalize(this.data)
    this.data = normalize({ ...before, ...allowed, updatedAt: new Date().toISOString() })
    this.localRevision += 1
    const revision = this.localRevision
    PENDING_VALUE_FIELDS.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(allowed, key)) return
      this.pending.fields[key] = this.data[key]
      this.pending.fieldRevisions[key] = revision
    })
    const planId = pendingPlanId(before)
    const planUiPending = planId
      ? (this.pending.planUiByPlan[planId] || (this.pending.planUiByPlan[planId] = emptyPlanUiPending()))
      : this.pending.unscopedPlanUi
    PLAN_UI_VALUE_FIELDS.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(allowed, key)) return
      planUiPending.fields[key] = this.data[key]
      planUiPending.fieldRevisions[key] = revision
    })
    if (Object.prototype.hasOwnProperty.call(allowed, 'checkedShoppingIds')) {
      const previous = new Set(before.checkedShoppingIds)
      const next = new Set(this.data.checkedShoppingIds)
      new Set([...previous, ...next]).forEach((id) => {
        if (previous.has(id) === next.has(id)) return
        planUiPending.checkedOperations[id] = { checked: next.has(id), revision }
      })
    }
    this.pending.revision = revision
    this.persistPending(namespace)
    this.persistCache(namespace)
    if (options.localOnly) return Promise.resolve(this.data)
    if (options.immediate) return this.flush()
    this.scheduleFlush()
    return Promise.resolve(this.data)
  }

  clearPendingThrough(revision) {
    Object.entries(this.pending.fieldRevisions).forEach(([key, changedAt]) => {
      if (changedAt > revision) return
      delete this.pending.fieldRevisions[key]
      delete this.pending.fields[key]
    })
    const clearPlanUi = (planUi) => {
      Object.entries(planUi.fieldRevisions).forEach(([key, changedAt]) => {
        if (changedAt > revision) return
        delete planUi.fieldRevisions[key]
        delete planUi.fields[key]
      })
      Object.entries(planUi.checkedOperations).forEach(([id, operation]) => {
        if (operation.revision <= revision) delete planUi.checkedOperations[id]
      })
    }
    Object.entries(this.pending.planUiByPlan).forEach(([planId, planUi]) => {
      clearPlanUi(planUi)
      if (!planUiHasPending(planUi)) delete this.pending.planUiByPlan[planId]
    })
    clearPlanUi(this.pending.unscopedPlanUi)
    const remaining = [
      ...Object.values(this.pending.fieldRevisions),
      ...Object.values(this.pending.planUiByPlan).flatMap(planUiRevisions),
      ...planUiRevisions(this.pending.unscopedPlanUi),
    ]
    this.pending.revision = remaining.length ? Math.max(...remaining) : 0
  }

  flush(targetRevision = this.localRevision) {
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    let namespace
    try { namespace = this.requireNamespace() }
    catch (error) { return Promise.reject(error) }
    const waitForTarget = () => {
      if (!this.isCurrentNamespace(namespace)) return Promise.reject(namespaceChangedError())
      if (!hasPending(this.pending) || this.confirmedLocalRevision >= targetRevision) return Promise.resolve(this.data)
      if (!this.pendingSave) this.pendingSave = this.saveOnce(namespace)
      return this.pendingSave.then(waitForTarget)
    }
    return waitForTarget()
  }

  saveOnce(namespace) {
    this.state = 'saving'
    const write = async (conflictRetries) => {
      const snapshot = normalize(this.data)
      const savedLocalRevision = this.localRevision
      try {
        const data = await callFunction('userData', 'saveState', {
          state: editableSnapshot(snapshot),
          expectedStateRevision: snapshot.stateRevision,
        })
        if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
        this.confirmedLocalRevision = Math.max(this.confirmedLocalRevision, savedLocalRevision)
        this.clearPendingThrough(savedLocalRevision)
        this.data = applyPending(normalize(data), this.pending)
        this.state = hasPending(this.pending) ? 'saving' : 'ready'
        this.error = ''
        this.persistPending(namespace)
        this.persistCache(namespace)
        return this.data
      } catch (error) {
        if (!this.isCurrentNamespace(namespace)) throw error
        if (!isRevisionConflict(error) || conflictRetries < 1) throw error
        const latest = await callFunction('userData', 'bootstrap')
        if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
        this.data = applyPending(normalize(latest), this.pending)
        this.persistCache(namespace)
        return write(conflictRetries - 1)
      }
    }
    const request = write(1).catch((error) => {
      if (!this.isCurrentNamespace(namespace)) throw error
      this.state = 'offline'
      this.error = error.message || '保存失败，已保留在本机'
      throw error
    }).finally(() => {
      if (this.pendingSave === request) this.pendingSave = null
      if (this.isCurrentNamespace(namespace) && hasPending(this.pending) && this.state !== 'offline') this.scheduleFlush(50)
    })
    this.pendingSave = request
    return request
  }

  savePreferences(preferences) { return this.patch({ generationPreferences: preferences }, { immediate: true }) }

  async confirmDraft() {
    const namespace = this.requireNamespace()
    await this.flush()
    const data = await callFunction('userData', 'confirmDraft', { expectedStateRevision: this.data.stateRevision })
    return this.replaceFromCloud(data, namespace)
  }

  async discardDraft() {
    const namespace = this.requireNamespace()
    await this.flush()
    const data = await callFunction('userData', 'discardDraft', { expectedStateRevision: this.data.stateRevision })
    return this.replaceFromCloud(data, namespace)
  }

  async restoreHistory(planId) {
    const namespace = this.requireNamespace()
    await this.flush()
    const data = await callFunction('userData', 'restoreHistory', { planId, expectedStateRevision: this.data.stateRevision })
    return this.replaceFromCloud(data, namespace)
  }
}

module.exports = {
  UserStore, userStore: new UserStore(), normalize, defaults, editableSnapshot,
  emptyPending, normalizePending, applyPending, hasPending, isRevisionConflict,
}
