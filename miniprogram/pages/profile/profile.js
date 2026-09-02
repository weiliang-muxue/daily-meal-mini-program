const { authStore } = require('../../services/auth-store')
const { userStore } = require('../../services/user-store')
const { formatUpdatedAt } = require('../../utils/date')
const { membershipStore, deletionRecoveryState } = require('../../services/membership-store')
const { callFunction } = require('../../utils/cloud')
const { clearPrivateCache } = require('../../services/private-cache')
const { MAX_AVATAR_BYTES, privateImagePayload } = require('../../utils/private-image')
const {
  ensurePrivacyAuthorized,
  getPrivacyAuthorizationState,
  navigateToUserAgreement,
  openPrivacyContractOrLocal,
} = require('../../utils/privacy-auth')

const DEFAULT_MAX_MEMBERS = 4
const DEFAULT_INVITE_TTL_HOURS = 168

function pad(value) { return String(value).padStart(2, '0') }

function positiveSafeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function inviteTtlText(hours) {
  return hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小时`
}

function formatBeijingDateTime(value) {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return ''
  const date = new Date(timestamp + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

function cleanMemberName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 20) : ''
}

function visibleTransferMembers(summary) {
  const source = summary && Array.isArray(summary.members) ? summary.members : []
  return source.reduce((result, item) => {
    const memberRef = item && typeof item.memberRef === 'string' ? item.memberRef.toLowerCase() : ''
    if (!item || item.role !== 'member' || !/^[a-f0-9]{32}$/.test(memberRef)) return result
    result.push({
      displayName: cleanMemberName(item.displayName) || cleanMemberName(item.label) || '受邀成员',
      memberRef,
    })
    return result
  }, [])
}

function visibleActiveInvites(summary) {
  const source = summary && Array.isArray(summary.activeInvites) ? summary.activeInvites : []
  const seen = new Set()
  return source.reduce((result, item) => {
    const inviteRef = item && typeof item.inviteRef === 'string' ? item.inviteRef.toLowerCase() : ''
    const expiresAt = Number(item && item.expiresAt)
    if (!/^[a-f0-9]{32}$/.test(inviteRef) || seen.has(inviteRef) || !Number.isFinite(expiresAt)) return result
    seen.add(inviteRef)
    result.push({
      inviteRef,
      label: cleanMemberName(item.label) || '未备注邀请',
      expiresAt,
      expiresText: formatBeijingDateTime(expiresAt),
    })
    return result
  }, [])
}

function waterReminderSummary(value) {
  if (!value || value.enabled !== true) return '未开启'
  const cadence = value.cadence === 'weekdays' ? '周一至周五' : '每日'
  return `${cadence} ${value.startTime || '09:00'}–${value.endTime || '18:00'}，每 ${Number(value.intervalMinutes) || 60} 分钟`
}

function confirmModal(options) {
  return new Promise((resolve) => wx.showModal({
    ...options,
    success: ({ confirm }) => resolve(Boolean(confirm)),
    fail: () => resolve(false),
  }))
}

Page({
  data: {
    profile: {}, nickname: '', nicknameDirty: false, nicknameInitial: '我', avatarPreview: '', avatarLocalPath: '',
    avatarImageFailed: false,
    avatarPrivacyMode: 'native', avatarPrivacyError: '', avatarPrivacyTone: 'hint', authorizingAvatar: false,
    legalPrivacyError: '',
    authState: 'idle', authDetail: '', profileLoading: true, updatedText: '', saving: false, clearingData: false,
    bindingPhone: false, phoneError: '',
    settings: { calciumAnchorReminder: false, vitaminDReminder: false }, savingSettings: false,
    waterReminderSummary: '未开启',
    nativeControlColor: '#176B46',
    member: {}, memberCount: 0, occupiedCount: 0, maxMembers: DEFAULT_MAX_MEMBERS,
    inviteTtlHours: DEFAULT_INVITE_TTL_HOURS, inviteTtlText: inviteTtlText(DEFAULT_INVITE_TTL_HOURS),
    inviteLabel: '', inviteCode: '', inviteExpiresText: '', creatingInvite: false,
    activeInvites: [], inviteCapacityKnown: false, revokingInviteRef: '',
    transferMembers: [], membersState: 'idle', membersError: '', selectedMemberRef: '', transferringOwner: false,
  },

  onLoad() {
    this.applyTheme()
    this.themeChangeHandler = (event) => this.applyTheme(event)
    if (typeof wx.onThemeChange === 'function') wx.onThemeChange(this.themeChangeHandler)
    this.connect()
  },
  onShow() { this.render() },
  onUnload() {
    if (this.themeChangeHandler && typeof wx.offThemeChange === 'function') wx.offThemeChange(this.themeChangeHandler)
    this.themeChangeHandler = null
  },

  applyTheme(event = {}) {
    let theme = event && event.theme
    if (theme !== 'dark' && theme !== 'light') {
      try {
        if (typeof wx.getAppBaseInfo === 'function') theme = (wx.getAppBaseInfo() || {}).theme
      } catch (_) {}
    }
    if (theme !== 'dark' && theme !== 'light') theme = this.currentTheme || 'light'
    this.currentTheme = theme
    this.setData({ nativeControlColor: theme === 'dark' ? '#72D49E' : '#176B46' })
  },

  async connect(force = false) {
    this.setData({ authState: 'connecting', authDetail: '正在加载资料', profileLoading: true })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      const authRequest = authStore.init({ force })
      this.render()
      await authRequest
      await userStore.init({ force })
      this.render()
      this.setData({ profileLoading: false })
      if (member.role === 'owner') await this.loadMembers()
      else this.resetMemberManagement()
    }
    catch (error) {
      this.setData({
        authState: 'offline',
        authDetail: error.message || '资料加载失败，请稍后重试',
        profileLoading: false,
      })
      wx.showToast({ title: '连接失败，可稍后重试', icon: 'none' })
    }
  },

  resetMemberManagement() {
    this.setData({
      transferMembers: [], membersState: 'idle', membersError: '', selectedMemberRef: '',
      memberCount: 0, occupiedCount: 0, activeInvites: [], inviteCapacityKnown: false,
      maxMembers: DEFAULT_MAX_MEMBERS,
      inviteTtlHours: DEFAULT_INVITE_TTL_HOURS, inviteTtlText: inviteTtlText(DEFAULT_INVITE_TTL_HOURS),
      inviteCode: '', inviteExpiresText: '', inviteLabel: '', creatingInvite: false, revokingInviteRef: '',
    })
  },

  async loadMembers() {
    if (!membershipStore.member || membershipStore.member.role !== 'owner') {
      this.resetMemberManagement()
      return
    }
    this.setData({ membersState: 'loading', membersError: '', inviteCapacityKnown: false })
    try {
      const summary = await membershipStore.listMembers()
      if (!membershipStore.member || membershipStore.member.role !== 'owner') {
        this.resetMemberManagement()
        return
      }
      const transferMembers = visibleTransferMembers(summary)
      const activeInvites = visibleActiveInvites(summary)
      const memberCount = Number.isSafeInteger(summary && summary.count) ? summary.count : transferMembers.length + 1
      const maxMembers = positiveSafeInteger(summary && summary.maxMembers, DEFAULT_MAX_MEMBERS)
      const inviteTtlHours = positiveSafeInteger(summary && summary.inviteTtlHours, DEFAULT_INVITE_TTL_HOURS)
      const selectedMemberRef = transferMembers.some((item) => item.memberRef === this.data.selectedMemberRef)
        ? this.data.selectedMemberRef : ''
      this.setData({
        transferMembers,
        activeInvites,
        selectedMemberRef,
        membersState: transferMembers.length ? 'ready' : 'empty',
        membersError: '',
        memberCount,
        occupiedCount: memberCount + activeInvites.length,
        inviteCapacityKnown: true,
        maxMembers,
        inviteTtlHours,
        inviteTtlText: inviteTtlText(inviteTtlHours),
      })
    } catch (error) {
      this.setData({
        transferMembers: [], activeInvites: [], selectedMemberRef: '', membersState: 'error',
        occupiedCount: 0, inviteCapacityKnown: false,
        membersError: error.message || '成员列表加载失败，请重试',
      })
    }
  },

  retryMembers() {
    if (this.data.profileLoading || this.data.membersState === 'loading') return
    return this.loadMembers()
  },

  selectTransferMember(event) {
    if (this.data.profileLoading || this.data.transferringOwner || this.data.membersState !== 'ready') return
    const memberRef = String(event.detail && event.detail.value || '').toLowerCase()
    if (!this.data.transferMembers.some((item) => item.memberRef === memberRef)) return
    this.setData({ selectedMemberRef: memberRef })
  },

  async transferOwner() {
    if (this.data.profileLoading || this.data.transferringOwner) return
    const target = this.data.transferMembers.find((item) => item.memberRef === this.data.selectedMemberRef)
    if (!target) return wx.showToast({ title: '请先选择接任成员', icon: 'none' })

    const firstConfirmed = await confirmModal({
      title: '转移管理员身份？',
      content: `接任成员：${target.displayName}\n成员编号：${target.memberRef}\n\n转移后你会立即变为普通成员，不能再邀请或管理成员。`,
      confirmText: '继续',
    })
    if (!firstConfirmed) return

    const secondConfirmed = await confirmModal({
      title: '再次确认转移',
      content: `确认让“${target.displayName}”成为唯一管理员？生效后，只有新管理员可以继续管理或再次转移管理员身份。`,
      confirmText: '确认转移',
      confirmColor: '#A33F2B',
    })
    if (!secondConfirmed) return

    this.setData({ transferringOwner: true })
    wx.showLoading({ title: '正在转移', mask: true })
    try {
      const member = await membershipStore.transferOwner(target.memberRef, true)
      this.setData({ member: member || {} })
      this.render()
      if (member && member.role === 'owner') await this.loadMembers()
      else this.resetMemberManagement()
      wx.hideLoading()
      wx.showToast({ title: '管理员已转移', icon: 'success' })
    } catch (error) {
      wx.hideLoading()
      wx.showToast({ title: error.message || '转移失败，请重试', icon: 'none' })
      if (membershipStore.member && membershipStore.member.role === 'owner') await this.loadMembers()
    } finally {
      this.setData({ transferringOwner: false })
    }
  },

  render() {
    const profile = authStore.profile || {}
    const authState = authStore.state === 'ready' || authStore.state === 'offline'
      ? authStore.state : this.data.authState === 'connecting' ? 'connecting' : authStore.state
    const nickname = this.data.nicknameDirty ? this.data.nickname : profile.nickname || ''
    const avatarPreview = this.data.avatarLocalPath ? this.data.avatarPreview : profile.avatarUrl || ''
    this.setData({
      profile,
      nickname,
      nicknameInitial: (nickname || '我').slice(0, 1),
      avatarPreview,
      avatarImageFailed: avatarPreview === this.data.avatarPreview ? this.data.avatarImageFailed : false,
      authState,
      authDetail: authState === 'offline' ? authStore.error || this.data.authDetail || '网络连接不可用，请稍后重试' : '正在加载资料',
      updatedText: formatUpdatedAt(userStore.data.updatedAt),
      settings: userStore.data.settings || { calciumAnchorReminder: false, vitaminDReminder: false },
      waterReminderSummary: waterReminderSummary(userStore.data.waterReminder),
      member: membershipStore.member || {},
    })
  },

  clearRenderedPrivateData() {
    this.setData({
      profile: {}, nickname: '', nicknameDirty: false, nicknameInitial: '我',
      avatarPreview: '', avatarLocalPath: '', avatarImageFailed: false,
      phoneError: '', settings: { calciumAnchorReminder: false, vitaminDReminder: false }, waterReminderSummary: '未开启',
      updatedText: '', member: {}, memberCount: 0, occupiedCount: 0,
      activeInvites: [], transferMembers: [], selectedMemberRef: '',
      inviteCode: '', inviteExpiresText: '', inviteLabel: '',
    })
  },

  async checkAvatarPrivacy() {
    const privacy = await getPrivacyAuthorizationState()
    if (!privacy.supported || privacy.authorized) {
      this.setData({ avatarPrivacyMode: 'native', avatarPrivacyError: '', avatarPrivacyTone: 'hint', authorizingAvatar: false })
      return
    }
    if (privacy.needAuthorization === true) {
      this.setData({
        avatarPrivacyMode: 'authorize',
        avatarPrivacyError: '选择头像前需按微信平台流程完成隐私授权。完成后请再次点击头像。',
        avatarPrivacyTone: 'hint',
        authorizingAvatar: false,
      })
      return
    }
    this.setData({
      avatarPrivacyMode: 'authorize', avatarPrivacyError: privacy.message,
      avatarPrivacyTone: 'error', authorizingAvatar: false,
    })
  },

  async authorizeAvatarPrivacy() {
    if (this.data.profileLoading || this.data.authorizingAvatar) return
    this.setData({ authorizingAvatar: true, avatarPrivacyError: '', avatarPrivacyMode: 'checking' })
    const current = await getPrivacyAuthorizationState()
    if (!current.supported || current.authorized) {
      this.setData({
        avatarPrivacyMode: 'native',
        avatarPrivacyError: '',
        avatarPrivacyTone: 'hint',
        authorizingAvatar: false,
      })
      if (typeof wx.showToast === 'function') wx.showToast({ title: '请再次点头像选择', icon: 'none' })
      return
    }
    const privacy = await ensurePrivacyAuthorized()
    if (privacy.authorized) {
      this.setData({
        avatarPrivacyMode: 'native',
        avatarPrivacyError: '',
        avatarPrivacyTone: 'hint',
        authorizingAvatar: false,
      })
      if (typeof wx.showToast === 'function') wx.showToast({ title: '已授权，请点头像选择', icon: 'none' })
      return
    }
    this.setData({
      avatarPrivacyMode: 'authorize', avatarPrivacyError: privacy.message,
      avatarPrivacyTone: 'error', authorizingAvatar: false,
    })
  },

  openUserAgreement() { return navigateToUserAgreement() },
  openWaterReminder() { return wx.navigateTo({ url: '/pages/water-reminder/water-reminder' }) },
  async openPrivacyGuide() {
    this.setData({ legalPrivacyError: '' })
    const result = await openPrivacyContractOrLocal()
    if (!result.openedPlatformContract && !result.usedLocalFallback) {
      this.setData({ legalPrivacyError: result.error || '《隐私保护指引》暂时无法打开，请稍后重试。' })
    }
    return result
  },

  onAvatarImageError(event) {
    const source = String(event && event.currentTarget && event.currentTarget.dataset
      && event.currentTarget.dataset.src || '')
    if (!source || source !== this.data.avatarPreview) return
    this.setData({ avatarImageFailed: true })
  },

  onChooseAvatar(event) {
    if (this.data.profileLoading || this.data.saving) return
    if (event.detail && event.detail.avatarUrl) this.setData({
      avatarPreview: event.detail.avatarUrl,
      avatarLocalPath: event.detail.avatarUrl,
      avatarImageFailed: false,
      avatarPrivacyError: '',
      avatarPrivacyTone: 'hint',
    })
    else {
      const errMsg = String(event && event.detail && event.detail.errMsg || '').toLowerCase()
      const denied = /deny/.test(errMsg)
      const cancelled = /cancel/.test(errMsg)
      const unavailable = /not\s+declared|undeclared|unsupported|not\s+supported|not support/.test(errMsg)
      if (unavailable) {
        this.setData({
          avatarPrivacyMode: 'native',
          avatarPrivacyError: '当前微信版本或小程序配置暂不支持选择头像，可先填写昵称，不影响其他功能。',
          avatarPrivacyTone: 'error',
        })
        return
      }
      if (denied) {
        this.setData({
          avatarPrivacyMode: 'authorize',
          avatarPrivacyError: '已取消头像授权，不影响其他功能；需要时可再次尝试。',
          avatarPrivacyTone: 'hint',
        })
        return
      }
      if (cancelled) {
        this.setData({ avatarPrivacyError: '', avatarPrivacyTone: 'hint' })
        return
      }
      if (/privacy|permission|authorization|scope/.test(errMsg)) {
        this.setData({
          avatarPrivacyMode: 'authorize',
          avatarPrivacyError: '选择头像前需要完成微信隐私授权，授权后请再次点击头像。',
          avatarPrivacyTone: 'hint',
        })
        return
      }
      this.setData({
        avatarPrivacyError: '头像暂时无法选择，可先填写昵称，不影响其他功能。',
        avatarPrivacyTone: 'error',
      })
    }
  },
  onNicknameInput(event) {
    if (this.data.profileLoading || this.data.saving) return
    const nickname = event.detail.value
    this.setData({ nickname, nicknameDirty: true, nicknameInitial: (nickname || '我').slice(0, 1) })
  },

  async onGetPhoneNumber(event) {
    if (this.data.profileLoading || this.data.bindingPhone || this.data.saving) return
    const detail = event && event.detail || {}
    const code = typeof detail.code === 'string' ? detail.code.trim() : ''
    if (!code) {
      const denied = /deny|cancel/.test(String(detail.errMsg || '').toLowerCase())
      this.setData({
        phoneError: denied
          ? '已取消绑定，之后需要时可以再试'
          : '暂时无法获取手机号，可稍后重试，不影响其他功能',
      })
      return
    }
    this.setData({ bindingPhone: true, phoneError: '' })
    try {
      const profile = await authStore.bindPhoneNumber(code)
      this.setData({ profile, bindingPhone: false, phoneError: '' })
      wx.showToast({ title: '手机号已绑定', icon: 'success' })
    } catch (error) {
      this.setData({
        bindingPhone: false,
        phoneError: error.message || '暂时无法绑定手机号，可稍后重试，不影响其他功能',
      })
    }
  },

  async saveProfile(event) {
    const submittedNickname = event && event.detail && event.detail.value
      && Object.prototype.hasOwnProperty.call(event.detail.value, 'nickname')
      ? event.detail.value.nickname : this.data.nickname
    const nickname = String(submittedNickname || '').trim().slice(0, 20)
    if (this.data.profileLoading || this.data.saving || this.data.bindingPhone) return
    this.setData({ saving: true })
    wx.showLoading({ title: '正在保存', mask: true })
    try {
      const avatarImage = this.data.avatarLocalPath
        ? await privateImagePayload(this.data.avatarLocalPath, { maxBytes: MAX_AVATAR_BYTES, label: '头像' })
        : null
      const profile = await authStore.updateProfile({ nickname, avatarImage })
      this.setData({
        profile, nickname: profile.nickname, nicknameDirty: false,
        nicknameInitial: (profile.nickname || '我').slice(0, 1),
        avatarPreview: profile.avatarUrl, avatarLocalPath: '', avatarImageFailed: false,
      })
      wx.showToast({ title: '资料已保存', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message || '保存失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ saving: false })
    }
  },

  retryLogin() {
    if (this.data.authState !== 'offline') return
    return this.connect(true)
  },
  async toggleHealthSetting(event) {
    if (this.data.profileLoading || this.data.savingSettings) return
    const key = event.currentTarget.dataset.key
    if (!['calciumAnchorReminder', 'vitaminDReminder'].includes(key)) return
    const previous = { ...(userStore.data.settings || {}) }
    const settings = { ...previous, [key]: Boolean(event.detail.value) }
    this.setData({ savingSettings: true, settings })
    try {
      await userStore.patch({ settings }, { immediate: true })
      this.render()
    } catch (error) {
      this.render()
      wx.showToast({ title: error.message || '提醒设置保存失败', icon: 'none' })
    } finally {
      this.setData({ savingSettings: false })
    }
  },
  inputInviteLabel(event) {
    if (!this.data.profileLoading) this.setData({ inviteLabel: event.detail.value })
  },
  async createInvite() {
    if (this.data.profileLoading || this.data.creatingInvite || this.data.revokingInviteRef) return
    if (!this.data.inviteCapacityKnown) return wx.showToast({ title: '请先刷新邀请状态', icon: 'none' })
    if (this.data.occupiedCount >= this.data.maxMembers) return wx.showToast({ title: '成员名额已满', icon: 'none' })
    this.setData({ creatingInvite: true })
    try {
      const invite = await membershipStore.createInvite(this.data.inviteLabel)
      this.setData({ inviteCode: invite.code, inviteExpiresText: formatBeijingDateTime(invite.expiresAt), inviteLabel: '' })
      await this.loadMembers()
    } catch (error) { wx.showToast({ title: error.message || '邀请码生成失败', icon: 'none' }) }
    finally { this.setData({ creatingInvite: false }) }
  },
  copyInvite() {
    if (!this.data.inviteCode) return
    wx.setClipboardData({ data: this.data.inviteCode, success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' }) })
  },
  async revokeInvite(event) {
    if (this.data.profileLoading || this.data.revokingInviteRef || this.data.creatingInvite) return
    const inviteRef = String(event.currentTarget && event.currentTarget.dataset.inviteRef || '').toLowerCase()
    const invite = this.data.activeInvites.find((item) => item.inviteRef === inviteRef)
    if (!invite) return wx.showToast({ title: '邀请状态已变化，请刷新', icon: 'none' })
    const confirmed = await confirmModal({
      title: '撤销待使用邀请？',
      content: `备注：${invite.label}\n有效至：${invite.expiresText}（北京时间）\n\n撤销后原邀请码立即失效，并释放一个邀请名额。`,
      confirmText: '确认撤销',
      confirmColor: '#A33F2B',
    })
    if (!confirmed) return
    this.setData({ revokingInviteRef: inviteRef })
    try {
      const result = await membershipStore.revokeInvite(inviteRef)
      await this.loadMembers()
      wx.showToast({ title: result && result.revoked ? '邀请已撤销' : '邀请已失效', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message || '撤销失败，请重试', icon: 'none' })
    } finally {
      this.setData({ revokingInviteRef: '' })
    }
  },
  async clearMyData() {
    if (this.data.profileLoading || this.data.clearingData) return
    const isOwner = this.data.member && this.data.member.role === 'owner'
    if (isOwner && (!this.data.inviteCapacityKnown || this.data.membersState === 'error')) {
      wx.showToast({ title: '请先刷新成员状态', icon: 'none' })
      return
    }
    if (isOwner && this.data.memberCount > 1) {
      wx.showToast({ title: '请先完成管理员交接', icon: 'none' })
      return
    }

    const consequence = isOwner
      ? '将永久删除你的资料、餐单、采购、提醒、体重、运动、头像和照片。为避免小程序失去管理入口，只会保留不含个人资料的空管理员身份。此操作无法恢复。'
      : '将永久删除你的资料、餐单、采购、提醒、体重、运动、头像和照片，并退出当前成员资格。再次使用需要新的邀请码。此操作无法恢复。'
    const finalConsequence = isOwner
      ? '确认永久清空以上数据，只保留空管理员身份？'
      : '确认永久清空以上数据并退出当前成员资格？'

    this.setData({ clearingData: true })
    let loadingShown = false
    try {
      const firstConfirmed = await confirmModal({
        title: '清空我的私人数据？', content: consequence,
        confirmText: '永久清空', confirmColor: '#A33F2B',
      })
      if (!firstConfirmed) return
      const finalConfirmed = await confirmModal({
        title: '再次确认', content: finalConsequence,
        confirmText: '永久清空', confirmColor: '#A33F2B',
      })
      if (!finalConfirmed) return

      const cacheNamespace = membershipStore.cacheNamespace
      try { clearPrivateCache(cacheNamespace) } catch (_) {}
      if (typeof membershipStore.reset === 'function') membershipStore.reset()
      wx.showLoading({ title: '正在清空', mask: true })
      loadingShown = true
      try {
        await callFunction('privacy', 'clearMyData', {
          expectedCacheNamespace: cacheNamespace,
        })
      } catch (error) {
        let member = null
        try { member = await membershipStore.init({ force: true }) } catch (_) {}
        const recoveryState = membershipStore.state === 'ready'
          ? deletionRecoveryState(member, cacheNamespace) : 'unknown'
        if (recoveryState === 'completed') {
          this.clearRenderedPrivateData()
          wx.showToast({ title: '私人数据已清空', icon: 'success' })
          setTimeout(() => wx.reLaunch({ url: '/pages/access/access' }), 700)
          return
        }
        if (recoveryState === 'pending') {
          wx.showToast({ title: '请继续完成清理', icon: 'none' })
          setTimeout(() => wx.reLaunch({ url: '/pages/access/access' }), 700)
          return
        }
        wx.showToast({ title: error.message || '暂时无法确认清理结果', icon: 'none' })
        setTimeout(() => wx.reLaunch({ url: '/pages/access/access' }), 700)
        return
      }
      this.clearRenderedPrivateData()
      wx.showToast({ title: '私人数据已清空', icon: 'success' })
      setTimeout(() => wx.reLaunch({ url: '/pages/access/access' }), 700)
    } catch (error) {
      wx.showToast({ title: error.message || '清空失败，请重试', icon: 'none' })
    } finally {
      if (loadingShown) wx.hideLoading()
      this.setData({ clearingData: false })
    }
  },
})
