const { navigateToUserAgreement, openPrivacyContractOrLocal } = require('../../utils/privacy-auth')
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
  data: { contractError: '', canNavigateBack: false, pageNavigationLabel: '返回餐单首页' },
  onLoad() { this.refreshPageNavigation() },
  onShow() { this.refreshPageNavigation() },
  refreshPageNavigation() {
    const canGoBack = canNavigateBack()
    this.setData({ canNavigateBack: canGoBack, pageNavigationLabel: canGoBack ? '返回上一页' : '返回餐单首页' })
  },
  navigateFromPage() { return returnFromSecondaryPage() },
  async openPlatformPrivacy() {
    this.setData({ contractError: '' })
    const result = await openPrivacyContractOrLocal(null, {
      onFallback: () => this.setData({
        contractError: '微信平台《隐私保护指引》暂时无法打开。你仍可阅读本页说明，稍后可再次重试。',
      }),
    })
    return result
  },
  openUserAgreement() { return navigateToUserAgreement() },
})
