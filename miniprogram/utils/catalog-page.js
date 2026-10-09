'use strict'

const { membershipStore } = require('../services/membership-store')
const catalog = require('../services/recipe-catalog')
const PLAN_URL = '/pages/plan/plan'
const navigation = {
  refreshNavigation() {
    let back = false
    try { back = typeof getCurrentPages === 'function' && getCurrentPages().length > 1 } catch (_) {}
    this.setData({ canNavigateBack: back, pageNavigationLabel: back ? '返回上一页' : '返回餐单首页' })
  },
  navigateFromPage() {
    if (this.unloaded || this.data.navigating) return
    const goHome = () => wx.switchTab({ url: PLAN_URL,
      fail: () => { if (!this.unloaded) this.setData({ notice: '暂时无法返回，请使用微信顶部返回按钮重试' }) } })
    if (!this.data.canNavigateBack || typeof wx.navigateBack !== 'function') return goHome()
    try { wx.navigateBack({ delta: 1, fail: goHome }) } catch (_) { goHome() }
  },
  openPage(url) {
    if (this.unloaded || this.data.navigating) return
    this.setData({ navigating: true, notice: '' })
    const done = () => { if (!this.unloaded) this.setData({ navigating: false }) }
    const fail = () => { if (!this.unloaded) this.setData({ notice: '页面暂时无法打开，请稍后重试' }); done() }
    try { wx.navigateTo({ url, fail, complete: done }) } catch (_) { fail() }
  },
}
function createCatalogPage(spec) {
  return {
    ...navigation, ...spec,
    data: { canNavigateBack: false, pageNavigationLabel: '返回餐单首页', loading: true, error: '', notice: '',
      navigating: false, accessChanged: false, ...spec.data },
    onLoad(options = {}) {
      this.active = true; this.options = options; this.refreshNavigation()
      this.namespace = membershipStore.cacheNamespace || ''
      this.unsubscribeNamespace = membershipStore.onCacheNamespaceChange(namespace => {
        if (this.namespace && namespace !== this.namespace) this.invalidate()
      })
      this.unsubscribeMembership = membershipStore.onMembershipChange(member => {
        if (this.namespace && (!member || member.status !== 'active')) this.invalidate()
      })
      return this.load()
    },
    onShow() {
      this.active = true; this.refreshNavigation()
      if (this.loaded && !this.current()) this.invalidate()
    },
    onHide() { this.active = false },
    onUnload() {
      this.unloaded = true; this.active = false; this.options = {}; this.catalog = null
      if (this.unsubscribeNamespace) this.unsubscribeNamespace()
      if (this.unsubscribeMembership) this.unsubscribeMembership()
    },
    current() {
      return this.authorized && !this.unloaded && !this.invalidated && this.active && !!this.namespace
        && this.namespace === membershipStore.cacheNamespace && membershipStore.member && membershipStore.member.status === 'active'
    },
    invalidate() {
      if (this.unloaded) return
      this.invalidated = true; this.authorized = false; this.catalog = null; this.options = {}
      this.setData({ ...spec.data, accessChanged: true, loading: false, navigating: false, notice: '', error: '账号或访问状态已变化，请返回餐单后重新进入' })
    },
    async load() {
      if (this.unloaded || this.invalidated || this.inFlight) return
      this.inFlight = true; this.setData({ loading: true, error: '', notice: '' })
      try {
        const member = await membershipStore.init()
        if (this.unloaded || this.invalidated) return
        if (!member || member.status !== 'active') {
          this.setData({ loading: false, error: '请先完成加入与协议确认，再查看菜谱' })
          wx.reLaunch({ url: '/pages/access/access' }); return
        }
        this.namespace = membershipStore.cacheNamespace
        if (!this.namespace) throw new Error('CATALOG_IDENTITY')
        this.catalog = catalog.load(); this.loaded = true; this.authorized = true
        // Only public data may settle while hidden. Interactive handlers still require current().
        this.renderCatalog(this.options)
        this.setData({ loading: false })
      } catch (_) {
        if (!this.unloaded && !this.invalidated) this.setData({ loading: false, error: '菜谱暂时无法加载，请重试；你的餐单不会改变' })
      } finally { this.inFlight = false }
    },
    openSources() { if (this.current()) this.openPage('/pages/legal/sources') },
  }
}
module.exports = { createCatalogPage, navigation }
