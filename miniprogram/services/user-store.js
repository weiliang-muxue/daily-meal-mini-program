const { callFunction } = require('../utils/cloud')
const { currentDayIndex } = require('../utils/date')

const CACHE_KEY = 'meal_user_state_v2'

function defaults() {
  return {
    schemaVersion: 4,
    activePlanId: 'week-2026-01',
    selectedDayId: '',
    selectedDay: currentDayIndex(),
    defaultDinnerMode: 'rest',
    dinnerModeByDay: {},
    mealOverrides: {},
    checkedShoppingIds: [],
    customReminders: [],
    settings: { calciumAnchorReminder: true, vitaminDReminder: true },
    updatedAt: null,
  }
}

function normalize(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const legacyMode = value.dinnerMode === 'workout' ? 'workout' : 'rest'
  return {
    ...defaults(), ...value,
    schemaVersion: 4,
    activePlanId: typeof value.activePlanId === 'string' && value.activePlanId ? value.activePlanId : 'week-2026-01',
    selectedDayId: typeof value.selectedDayId === 'string' ? value.selectedDayId : '',
    selectedDay: Math.max(0, Math.min(6, Number(value.selectedDay ?? currentDayIndex()))),
    defaultDinnerMode: value.defaultDinnerMode === 'workout' ? 'workout' : legacyMode,
    dinnerModeByDay: value.dinnerModeByDay && typeof value.dinnerModeByDay === 'object' ? value.dinnerModeByDay : {},
    mealOverrides: value.mealOverrides && typeof value.mealOverrides === 'object' ? value.mealOverrides : {},
    checkedShoppingIds: Array.isArray(value.checkedShoppingIds) ? value.checkedShoppingIds : [],
    customReminders: Array.isArray(value.customReminders) ? value.customReminders : [],
    settings: { ...defaults().settings, ...(value.settings || {}) },
  }
}

class UserStore {
  constructor() {
    this.data = defaults()
    this.state = 'idle'
    this.error = ''
    this.initPromise = null
    this.pendingSave = null
    this.saveTimer = null
    this.cacheLoaded = false
    this.revision = 0
  }

  init(options = {}) {
    if (!this.cacheLoaded) {
      this.data = normalize(wx.getStorageSync(CACHE_KEY))
      this.cacheLoaded = true
    }
    if (this.initPromise && !options.force) return this.initPromise
    this.state = 'loading'
    const request = callFunction('userData', 'bootstrap')
      .then((data) => {
        this.data = normalize(data)
        this.state = 'ready'
        this.error = ''
        this.persistCache()
        return this.data
      })
      .catch((error) => {
        this.state = 'offline'
        this.error = error.message || '云端数据加载失败'
        return this.data
      })
      .finally(() => { if (this.initPromise === request) this.initPromise = null })
    this.initPromise = request
    return request
  }

  persistCache() { wx.setStorageSync(CACHE_KEY, this.data) }

  patch(partial, options = {}) {
    this.data = normalize({ ...this.data, ...partial, updatedAt: new Date().toISOString() })
    this.revision += 1
    this.persistCache()
    if (options.immediate) return this.flush()
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush().catch(() => {}), 500)
    return Promise.resolve(this.data)
  }

  flush() {
    clearTimeout(this.saveTimer)
    if (this.pendingSave) return this.pendingSave
    this.state = 'saving'
    const snapshot = normalize(this.data)
    const savedRevision = this.revision
    const request = callFunction('userData', 'saveState', { state: snapshot })
      .then((data) => {
        if (this.revision === savedRevision) this.data = normalize(data)
        this.state = this.revision === savedRevision ? 'ready' : 'saving'
        this.error = ''
        this.persistCache()
        return this.data
      })
      .catch((error) => {
        this.state = 'offline'
        this.error = error.message || '保存失败，已保留在本机'
        throw error
      })
      .finally(() => {
        if (this.pendingSave === request) this.pendingSave = null
        if (this.revision !== savedRevision) {
          clearTimeout(this.saveTimer)
          this.saveTimer = setTimeout(() => this.flush().catch(() => {}), 50)
        }
      })
    this.pendingSave = request
    return request
  }
}

module.exports = { userStore: new UserStore(), normalize, defaults }
