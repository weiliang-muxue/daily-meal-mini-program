const { callFunction, wxLogin } = require('../utils/cloud')

const CACHE_KEY = 'meal_auth_profile_v1'

class AuthStore {
  constructor() {
    this.profile = null
    this.state = 'idle'
    this.error = ''
    this.initPromise = null
  }

  init(options = {}) {
    if (!this.profile) this.profile = wx.getStorageSync(CACHE_KEY) || null
    if (this.initPromise && !options.force) return this.initPromise
    this.state = 'connecting'
    const request = wxLogin()
      .then(() => callFunction('auth', 'login'))
      .then((profile) => {
        this.profile = profile
        this.state = 'ready'
        this.error = ''
        wx.setStorageSync(CACHE_KEY, profile)
        return profile
      })
      .catch((error) => {
        this.state = 'offline'
        this.error = error.message || '微信身份连接失败'
        if (!this.profile) throw error
        return this.profile
      })
      .finally(() => { if (this.initPromise === request) this.initPromise = null })
    this.initPromise = request
    return request
  }

  async updateProfile(profile) {
    const result = await callFunction('auth', 'updateProfile', { profile })
    this.profile = result
    this.state = 'ready'
    wx.setStorageSync(CACHE_KEY, result)
    return result
  }

  prepareAvatar(extension) {
    return callFunction('auth', 'prepareAvatar', { extension })
  }
}

module.exports = { authStore: new AuthStore() }
