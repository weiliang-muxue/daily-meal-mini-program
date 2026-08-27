const { membershipStore } = require('../../services/membership-store')
const { authStore } = require('../../services/auth-store')
const { userStore } = require('../../services/user-store')
const { navigateToUserAgreement, openPrivacyContractOrLocal } = require('../../utils/privacy-auth')

Page({
  data: { loading: true, code: '', error: '', submitting: false, privacyError: '' },
  onLoad() { this.check() },

  async check(force = false) {
    this.setData({ loading: true, error: '' })
    try {
      const member = await membershipStore.init({ force })
      if (member && member.status === 'active') return this.enter()
    } catch (error) {
      this.setData({ error: error.message || '验证失败，请重试' })
    }
    this.setData({ loading: false })
  },

  inputCode(event) { this.setData({ code: String(event.detail.value || '').toUpperCase().replace(/\s/g, '').slice(0, 32) }) },

  async submit() {
    const code = this.data.code.trim()
    if (!code) return this.setData({ error: '请输入邀请码' })
    if (this.data.submitting) return
    this.setData({ submitting: true, error: '' })
    try {
      await membershipStore.acceptInvite(code)
      await this.enter()
    } catch (error) {
      this.setData({ error: error.message || '验证失败，请核对后重试' })
    } finally { this.setData({ submitting: false }) }
  },

  async enter() {
    try { await authStore.init({ force: true }); await userStore.init({ force: true }) } catch (_) {}
    wx.switchTab({ url: '/pages/plan/plan' })
  },

  openUserAgreement() { return navigateToUserAgreement() },
  async openPrivacyGuide() {
    this.setData({ privacyError: '' })
    const result = await openPrivacyContractOrLocal()
    if (!result.openedPlatformContract && !result.usedLocalFallback) {
      this.setData({ privacyError: result.error || '《隐私保护指引》暂时无法打开，请稍后重试。' })
    }
    return result
  },
})
