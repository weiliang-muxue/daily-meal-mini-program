const { membershipStore, deletionRecoveryState } = require('../../services/membership-store')
const { authStore } = require('../../services/auth-store')
const { userStore } = require('../../services/user-store')
const { clearPrivateCache } = require('../../services/private-cache')
const { callFunction } = require('../../utils/cloud')
const { navigateToUserAgreement, openPrivacyContractOrLocal } = require('../../utils/privacy-auth')

function validCacheNamespace(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
}

Page({
  data: {
    loading: true,
    checkError: '',
    showInviteForm: false,
    code: '',
    inviteError: '',
    submitting: false,
    deletionRecovery: false,
    continuingDeletion: false,
    deletionError: '',
    privacyError: '',
  },
  onLoad() { this.check() },

  async check(force = false) {
    if (this.data.loading && force) return
    this.setData({
      loading: true, checkError: '', inviteError: '', showInviteForm: false,
      deletionRecovery: false, deletionError: '',
    })
    try {
      const member = await membershipStore.init({ force })
      if (member && member.status === 'active') return this.enter()
      if (member && member.status === 'deleting' && validCacheNamespace(member.cacheNamespace)) {
        this.setData({ loading: false, deletionRecovery: true })
        return
      }
      this.setData({ loading: false, showInviteForm: true })
    } catch (error) {
      this.setData({
        loading: false,
        checkError: error.message || '暂时无法验证微信身份，请重试',
        showInviteForm: false,
      })
    }
  },

  retryCheck() { return this.check(true) },
  useInviteInstead() {
    if (this.data.deletionRecovery) return
    this.setData({ showInviteForm: true, inviteError: '' })
  },

  inputCode(event) {
    this.setData({
      code: String(event.detail.value || '').toUpperCase().replace(/\s/g, '').slice(0, 32),
      inviteError: '',
    })
  },

  async submit() {
    if (this.data.deletionRecovery) return
    const code = this.data.code.trim()
    if (!code) return this.setData({ inviteError: '请输入邀请码' })
    if (this.data.submitting) return
    this.setData({ submitting: true, inviteError: '' })
    try {
      await membershipStore.acceptInvite(code)
      await this.enter()
    } catch (error) {
      this.setData({ inviteError: error.message || '邀请码验证失败，请核对后重试' })
    } finally { this.setData({ submitting: false }) }
  },

  async continueDeletion() {
    if (this.data.continuingDeletion) return
    const cacheNamespace = membershipStore.cacheNamespace
    if (!validCacheNamespace(cacheNamespace)
      || !membershipStore.member || membershipStore.member.status !== 'deleting') {
      return this.check(true)
    }
    this.setData({ continuingDeletion: true, deletionError: '' })
    try {
      try { clearPrivateCache(cacheNamespace) } catch (_) {}
      if (typeof membershipStore.reset === 'function') membershipStore.reset()
      await callFunction('privacy', 'clearMyData', { expectedCacheNamespace: cacheNamespace })
      wx.showToast({ title: '私人数据已清空', icon: 'success' })
      setTimeout(() => wx.reLaunch({ url: '/pages/access/access' }), 500)
    } catch (error) {
      let recoveryState = 'unknown'
      try {
        const member = await membershipStore.init({ force: true })
        if (membershipStore.state === 'ready') {
          recoveryState = deletionRecoveryState(member, cacheNamespace)
        }
      } catch (_) {}
      if (recoveryState === 'completed') {
        wx.showToast({ title: '私人数据已清空', icon: 'success' })
        setTimeout(() => wx.reLaunch({ url: '/pages/access/access' }), 500)
      } else if (recoveryState === 'pending') {
        this.setData({ deletionRecovery: true, deletionError: '清理尚未完成，请再次继续。' })
      } else {
        this.setData({
          deletionRecovery: true,
          deletionError: error.message || '暂时无法确认清理结果，请联网后重试。',
        })
      }
    } finally {
      this.setData({ continuingDeletion: false })
    }
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
