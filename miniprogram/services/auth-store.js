const { callFunction, wxLogin } = require('../utils/cloud')
const { membershipStore } = require('./membership-store')

const { withoutPhoneData, purgeRetiredPhoneCaches } = require('./retired-phone-data')

const CACHE_PREFIX = 'meal_auth_profile_v1_'

function normalizeCacheNamespace(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : ''
}

function namespaceChangedError() {
  const error = new Error('微信身份已变化，请重试')
  error.code = 'CACHE_NAMESPACE_CHANGED'
  return error
}

function supersededProfileError() {
  const error = new Error('资料加载请求已过期，请重新加载')
  error.code = 'PROFILE_REQUEST_SUPERSEDED'
  return error
}

class AuthStore {
  constructor(memberStore = membershipStore) {
    purgeRetiredPhoneCaches()
    this.membershipStore = memberStore
    this.cacheNamespace = normalizeCacheNamespace(memberStore.cacheNamespace)
    this.profile = null
    this.state = 'idle'
    this.error = ''
    this.initPromise = null
    this.initNamespace = ''
    this.readRevision = 0
    this.unsubscribeNamespace = memberStore.onCacheNamespaceChange((namespace) => this.applyCacheNamespace(namespace))
  }

  applyCacheNamespace(namespace) {
    const nextNamespace = normalizeCacheNamespace(namespace)
    if (nextNamespace === this.cacheNamespace) return nextNamespace
    this.cacheNamespace = nextNamespace
    this.profile = null
    this.state = 'idle'
    this.error = ''
    this.initPromise = null
    this.initNamespace = ''
    this.readRevision += 1
    return nextNamespace
  }

  currentCacheNamespace() {
    return this.applyCacheNamespace(this.membershipStore.cacheNamespace)
  }

  cacheKey(namespace = this.currentCacheNamespace()) {
    return namespace ? `${CACHE_PREFIX}${namespace}` : ''
  }

  requireCacheNamespace() {
    const namespace = this.currentCacheNamespace()
    if (!namespace) throw new Error('请先联网确认微信身份')
    return namespace
  }

  isCurrentNamespace(namespace) {
    return Boolean(namespace) && namespace === this.currentCacheNamespace()
  }

  init(options = {}) {
    let namespace
    try { namespace = this.requireCacheNamespace() }
    catch (error) { return Promise.reject(error) }
    if (!this.profile) this.profile = withoutPhoneData(wx.getStorageSync(this.cacheKey(namespace)) || null)
    if (this.initPromise && this.initNamespace === namespace && !options.force) return this.initPromise
    const readRevision = ++this.readRevision
    this.state = 'connecting'
    const request = wxLogin()
      .then(() => {
        if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
        if (readRevision !== this.readRevision) throw supersededProfileError()
        return callFunction('auth', 'login', { expectedCacheNamespace: namespace })
      })
      .then((rawProfile) => {
        const profile = withoutPhoneData(rawProfile)
        if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
        if (readRevision !== this.readRevision) {
          if (this.profile) return this.profile
          throw supersededProfileError()
        }
        this.profile = profile
        this.state = 'ready'
        this.error = ''
        wx.setStorageSync(this.cacheKey(namespace), profile)
        return profile
      })
      .catch((error) => {
        if (!this.isCurrentNamespace(namespace)) throw error
        if (readRevision !== this.readRevision) {
          if (this.profile) return this.profile
          throw error
        }
        this.state = 'offline'
        this.error = error.message || '微信身份连接失败'
        if (!this.profile) throw error
        return this.profile
      })
      .finally(() => {
        if (this.initPromise === request) {
          this.initPromise = null
          this.initNamespace = ''
        }
      })
    this.initPromise = request
    this.initNamespace = namespace
    return request
  }

  async updateProfile(profile) {
    const namespace = this.requireCacheNamespace()
    const result = withoutPhoneData(await callFunction('auth', 'updateProfile', {
      profile: withoutPhoneData(profile), expectedCacheNamespace: namespace,
    }))
    if (!this.isCurrentNamespace(namespace)) throw namespaceChangedError()
    // A login started before or during this write may contain an older server
    // snapshot. Failed writes leave valid reads available for recovery.
    this.readRevision += 1
    this.profile = result
    this.state = 'ready'
    this.error = ''
    wx.setStorageSync(this.cacheKey(namespace), result)
    return result
  }
}

module.exports = { AuthStore, authStore: new AuthStore() }
