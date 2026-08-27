const { navigateToUserAgreement, openPrivacyContractOrLocal } = require('../../utils/privacy-auth')

Page({
  data: { contractError: '' },
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
