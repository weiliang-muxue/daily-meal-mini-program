const { membershipStore, deletionRecoveryState } = require('../../services/membership-store')
const { authStore } = require('../../services/auth-store')
const { userStore } = require('../../services/user-store')
const { clearPrivateCache } = require('../../services/private-cache')
const { callFunction } = require('../../utils/cloud')
const { navigateToUserAgreement, openPrivacyContractOrLocal } = require('../../utils/privacy-auth')
const { LEGAL_CONSENT_VERSION, hasCurrentLegalConsent, legalConsentPayload } = require('../../utils/legal-consent')

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
    needsLegalConsent: false,
    legalConsentVersion: LEGAL_CONSENT_VERSION,
    privacyRead: false,
    agreementRead: false,
    legalAccepted: false,
    legalError: '',
    openingLegal: false,
  },
  onLoad() {
    this.unloaded = false
    this.resetLegalConsent()
    if (typeof membershipStore.onCacheNamespaceChange === 'function') {
      this.unsubscribeNamespace = membershipStore.onCacheNamespaceChange(() => this.resetLegalConsent())
    }
    return this.check()
  },
  onShow() {
    this.ensureLegalScope()
    this.setData({ legalAccepted: false })
  },
  onUnload() {
    this.unloaded = true
    this.legalReadRevision = (this.legalReadRevision || 0) + 1
    if (this.unsubscribeNamespace) this.unsubscribeNamespace()
  },

  resetLegalConsent() {
    this.legalReadRevision = (this.legalReadRevision || 0) + 1
    this.legalNamespace = membershipStore.cacheNamespace || ''
    this.legalIdentityRevision = membershipStore.identityRequestRevision
    this.setData({
      legalConsentVersion: LEGAL_CONSENT_VERSION, privacyRead: false,
      agreementRead: false, legalAccepted: false, legalError: '', openingLegal: false,
    })
  },

  ensureLegalScope() {
    if (this.legalNamespace !== (membershipStore.cacheNamespace || '')
      || this.legalIdentityRevision !== membershipStore.identityRequestRevision
      || this.data.legalConsentVersion !== LEGAL_CONSENT_VERSION) this.resetLegalConsent()
  },

  changeLegalConsent(event) {
    this.ensureLegalScope()
    const selected = event && event.detail && event.detail.value
    const accepted = !this.data.submitting && !this.data.openingLegal
      && this.data.privacyRead && this.data.agreementRead
      && Array.isArray(selected) && selected.includes('legal-accepted')
    this.setData({ legalAccepted: Boolean(accepted), legalError: '' })
  },

  async check(force = false) {
    if (this.data.loading && force) return
    this.setData({
      loading: true, checkError: '', inviteError: '', showInviteForm: false,
      deletionRecovery: false, deletionError: '', needsLegalConsent: false,
    })
    this.resetLegalConsent()
    try {
      const member = await membershipStore.init({ force, allowUnconsented: true })
      this.ensureLegalScope()
      if (hasCurrentLegalConsent(member)) return this.enter(member)
      if (member && member.status === 'active') {
        this.setData({ loading: false, needsLegalConsent: true })
        return
      }
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
    if (this.data.deletionRecovery || this.data.needsLegalConsent) return
    this.setData({ showInviteForm: true, inviteError: '' })
  },

  inputCode(event) {
    this.setData({
      code: String(event.detail.value || '').toUpperCase().replace(/\s/g, '').slice(0, 32),
      inviteError: '',
    })
  },

  async submit() {
    if (this.data.deletionRecovery || this.data.loading || this.data.submitting) return
    this.ensureLegalScope()
    const code = this.data.code.trim()
    if (!this.data.needsLegalConsent && !code) return this.setData({ inviteError: '请输入邀请码' })
    const legalConsent = legalConsentPayload({
      version: this.data.legalConsentVersion, privacyRead: this.data.privacyRead,
      agreementRead: this.data.agreementRead, accepted: this.data.legalAccepted,
    })
    if (!legalConsent) return this.setData({ legalError: '请先分别打开两份协议，再主动勾选同意。', legalAccepted: false })
    this.setData({ submitting: true, inviteError: '', legalError: '' })
    try {
      const member = this.data.needsLegalConsent
        ? await membershipStore.acceptLegalConsent(legalConsent)
        : await membershipStore.acceptInvite(code, legalConsent)
      if (!hasCurrentLegalConsent(member)) throw new Error('暂时无法确认协议同意结果，请重新验证微信身份。')
      await this.enter(member)
    } catch (error) {
      this.setData({
        [this.data.needsLegalConsent ? 'legalError' : 'inviteError']: error.message || '验证失败，请稍后重试',
        legalAccepted: false,
      })
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
        const member = await membershipStore.init({ force: true, allowUnconsented: true })
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

  async enter(member) {
    if (!hasCurrentLegalConsent(member)) return
    try { await authStore.init({ force: true }); await userStore.init({ force: true }) } catch (_) {}
    wx.switchTab({ url: '/pages/plan/plan' })
  },

  async openLegalDocument(document) {
    if (this.data.openingLegal || this.data.submitting) return
    this.ensureLegalScope()
    const revision = this.legalReadRevision
    const openRevision = this.legalOpenRevision = (this.legalOpenRevision || 0) + 1
    const field = document === 'privacy' ? 'privacyRead' : 'agreementRead'
    this.setData({ [field]: false, legalAccepted: false, legalError: '', privacyError: '', openingLegal: true })
    const onRead = (detail) => {
      if (this.unloaded || revision !== this.legalReadRevision || openRevision !== this.legalOpenRevision
        || this.legalNamespace !== (membershipStore.cacheNamespace || '')
        || this.legalIdentityRevision !== membershipStore.identityRequestRevision
        || !detail || detail.document !== document || detail.version !== LEGAL_CONSENT_VERSION) return
      this.setData({ [field]: true, legalAccepted: false })
    }
    try {
      const result = document === 'privacy'
        ? await openPrivacyContractOrLocal(null, { onRead })
        : await navigateToUserAgreement(null, { onRead })
      if (this.unloaded || revision !== this.legalReadRevision) return result
      const opened = document === 'privacy'
        ? result && (result.openedPlatformContract || result.usedLocalFallback)
        : result && result.navigated
      if (!opened) {
        this.setData({
          [field]: false, legalAccepted: false,
          [document === 'privacy' ? 'privacyError' : 'legalError']: result && result.error
            || `《${document === 'privacy' ? '隐私保护指引' : '用户协议'}》暂时无法打开，请稍后重试。`,
        })
      }
      return result
    } catch (_) {
      if (!this.unloaded && revision === this.legalReadRevision) {
        this.setData({ [field]: false, legalAccepted: false, legalError: '协议暂时无法打开，请稍后重试。' })
      }
    } finally {
      if (!this.unloaded && revision === this.legalReadRevision) this.setData({ openingLegal: false })
    }
  },
  openUserAgreement() { return this.openLegalDocument('agreement') },
  openPrivacyGuide() { return this.openLegalDocument('privacy') },
})
