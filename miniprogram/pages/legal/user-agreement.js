const { openPrivacyContractOrLocal } = require('../../utils/privacy-auth')
const PLAN_URL = '/pages/plan/plan'

function canNavigateBack() {
  try { return typeof getCurrentPages === 'function' && getCurrentPages().length > 1 } catch (_) { return false }
}

function returnFromSecondaryPage() {
  const goHome = () => wx.switchTab({ url: PLAN_URL })
  if (!canNavigateBack() || typeof wx.navigateBack !== 'function') return goHome()
  try { return wx.navigateBack({ delta: 1, fail: goHome }) } catch (_) { return goHome() }
}

Page({
  data: { canNavigateBack: false, pageNavigationLabel: '返回餐单首页' },
  onLoad() { this.refreshPageNavigation() },
  onShow() { this.refreshPageNavigation() },
  refreshPageNavigation() {
    const canGoBack = canNavigateBack()
    this.setData({ canNavigateBack: canGoBack, pageNavigationLabel: canGoBack ? '返回上一页' : '返回餐单首页' })
  },
  navigateFromPage() { return returnFromSecondaryPage() },
  openPrivacyGuide() { return openPrivacyContractOrLocal() },
})
