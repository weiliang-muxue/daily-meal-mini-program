const { callFunction } = require('../utils/cloud')

const CACHE_PREFIX = 'meal_health_month_v1_'

class HealthStore {
  constructor() {
    this.months = {}
    this.state = 'idle'
    this.error = ''
  }

  cacheKey(month) { return `${CACHE_PREFIX}${month}` }

  loadCache(month) {
    if (!this.months[month]) this.months[month] = wx.getStorageSync(this.cacheKey(month)) || []
    return this.months[month]
  }

  async getMonth(month, options = {}) {
    this.loadCache(month)
    this.state = 'loading'
    try {
      const records = await callFunction('health', 'getMonth', { month, includePhotoUrls: options.includePhotoUrls === true })
      this.months[month] = records
      wx.setStorageSync(this.cacheKey(month), records.map((item) => ({ ...item, photoUrl: '' })))
      this.state = 'ready'
      this.error = ''
      return records
    } catch (error) {
      this.state = 'offline'
      this.error = error.message || '健康记录加载失败'
      return this.months[month]
    }
  }

  preparePhoto(extension) { return callFunction('health', 'preparePhoto', { extension }) }
  getRange(startDate, endDate) { return callFunction('health', 'getRange', { startDate, endDate }) }

  async saveDaily(record) {
    this.state = 'saving'
    try {
      const saved = await callFunction('health', 'saveDaily', { record })
      const month = saved.date.slice(0, 7)
      const list = this.loadCache(month).filter((item) => item.date !== saved.date)
      this.months[month] = [...list, saved].sort((a, b) => a.date.localeCompare(b.date))
      wx.setStorageSync(this.cacheKey(month), this.months[month].map((item) => ({ ...item, photoUrl: '' })))
      this.state = 'ready'
      return saved
    } catch (error) {
      this.state = 'offline'
      this.error = error.message || '记录保存失败'
      throw error
    }
  }
}

module.exports = { healthStore: new HealthStore() }
