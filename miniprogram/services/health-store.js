const { callFunction } = require('../utils/cloud')
const { membershipStore } = require('./membership-store')

const CACHE_PREFIX = 'meal_health_month_v1_'

function clientError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeRecord(value = {}) {
  const record = value && typeof value === 'object' ? value : {}
  return {
    ...record,
    recordRevision: Number.isSafeInteger(record.recordRevision) && record.recordRevision >= 0
      ? record.recordRevision : 0,
  }
}

function normalizeRecords(value) {
  return Array.isArray(value) ? value.map(normalizeRecord) : []
}

function isRecordRevisionConflict(error) {
  return Boolean(error && error.code === 'HEALTH_RECORD_REVISION_CONFLICT')
}

function normalizeCacheNamespace(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : ''
}

function namespaceChangedError() {
  const error = new Error('微信身份已变化，请重试')
  error.code = 'CACHE_NAMESPACE_CHANGED'
  return error
}

class HealthStore {
  constructor(memberStore = membershipStore) {
    this.membershipStore = memberStore
    this.cacheNamespace = normalizeCacheNamespace(memberStore.cacheNamespace)
    this.months = {}
    this.cachedMonths = new Set()
    this.monthRequestId = 0
    this.state = 'idle'
    this.error = ''
    this.unsubscribeNamespace = memberStore.onCacheNamespaceChange((namespace) => this.applyCacheNamespace(namespace))
  }

  applyCacheNamespace(namespace) {
    const nextNamespace = normalizeCacheNamespace(namespace)
    if (nextNamespace === this.cacheNamespace) return nextNamespace
    this.cacheNamespace = nextNamespace
    this.months = {}
    this.cachedMonths = new Set()
    this.monthRequestId += 1
    this.state = 'idle'
    this.error = ''
    return nextNamespace
  }

  currentCacheNamespace() {
    return this.applyCacheNamespace(this.membershipStore.cacheNamespace)
  }

  requireCacheNamespace() {
    const namespace = this.currentCacheNamespace()
    if (!namespace) throw new Error('请先联网确认微信身份')
    return namespace
  }

  isCurrentNamespace(namespace) {
    return Boolean(namespace) && namespace === this.currentCacheNamespace()
  }

  cacheKey(month, namespace = this.currentCacheNamespace()) {
    return namespace ? `${CACHE_PREFIX}${namespace}_${month}` : ''
  }

  loadCache(month, namespace = this.currentCacheNamespace()) {
    if (!namespace) return []
    if (!this.months[month]) {
      const cached = wx.getStorageSync(this.cacheKey(month, namespace))
      if (Array.isArray(cached)) {
        this.months[month] = normalizeRecords(cached)
        this.cachedMonths.add(month)
      } else this.months[month] = []
    }
    return this.months[month]
  }

  hasCachedMonth(month, namespace = this.currentCacheNamespace()) {
    if (!namespace) return false
    this.loadCache(month, namespace)
    return this.cachedMonths.has(month)
  }

  async getMonth(month, options = {}) {
    const namespace = this.requireCacheNamespace()
    const requestId = ++this.monthRequestId
    this.loadCache(month, namespace)
    this.state = 'loading'
    try {
      const records = normalizeRecords(await callFunction('health', 'getMonth', { month, includePhotoUrls: options.includePhotoUrls === true }))
      if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
      this.months[month] = records
      this.cachedMonths.add(month)
      wx.setStorageSync(this.cacheKey(month, namespace), records.map((item) => ({ ...item, photoUrl: '' })))
      if (requestId === this.monthRequestId) {
        this.state = 'ready'
        this.error = ''
      }
      return records
    } catch (error) {
      if (!this.isCurrentNamespace(namespace)) return []
      if (requestId === this.monthRequestId) {
        this.state = 'offline'
        this.error = error.message || '健康记录加载失败'
      }
      return this.months[month] || []
    }
  }

  async getRange(startDate, endDate) {
    const namespace = this.requireCacheNamespace()
    const result = await callFunction('health', 'getRange', { startDate, endDate })
    if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
    return normalizeRecords(result)
  }

  async saveDaily(record) {
    const namespace = this.requireCacheNamespace()
    const value = record && typeof record === 'object' ? record : {}
    if (!Number.isSafeInteger(value.expectedRecordRevision) || value.expectedRecordRevision < 0) {
      throw clientError('INVALID_HEALTH_RECORD_REVISION', '请先刷新当天记录后再保存')
    }
    this.state = 'saving'
    try {
      const saved = normalizeRecord(await callFunction('health', 'saveDaily', { record: value }))
      if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
      const month = saved.date.slice(0, 7)
      const list = this.loadCache(month, namespace).filter((item) => item.date !== saved.date)
      this.months[month] = [...list, saved].sort((a, b) => a.date.localeCompare(b.date))
      this.cachedMonths.add(month)
      wx.setStorageSync(this.cacheKey(month, namespace), this.months[month].map((item) => ({ ...item, photoUrl: '' })))
      this.state = 'ready'
      return saved
    } catch (error) {
      if (!this.isCurrentNamespace(namespace)) throw error
      this.state = isRecordRevisionConflict(error) ? 'conflict' : 'offline'
      this.error = error.message || '记录保存失败'
      throw error
    }
  }
}

module.exports = {
  HealthStore,
  healthStore: new HealthStore(),
  isRecordRevisionConflict,
  normalizeRecord,
}
