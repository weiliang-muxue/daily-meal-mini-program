const { openPrivacyContractOrLocal } = require('../../utils/privacy-auth')

Page({
  openPrivacyGuide() { return openPrivacyContractOrLocal() },
})
