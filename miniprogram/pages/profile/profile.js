const { authStore } = require('../../services/auth-store')
const { userStore } = require('../../services/user-store')
const { formatUpdatedAt } = require('../../utils/date')
const { membershipStore } = require('../../services/membership-store')
const { callFunction } = require('../../utils/cloud')
const { clearPrivateCache } = require('../../services/private-cache')
const { MAX_AVATAR_BYTES, privateImagePayload } = require('../../utils/private-image')

function pad(value) { return String(value).padStart(2, '0') }

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

function confirmModal(options) {
  return new Promise((resolve) => wx.showModal({
    ...options,
    success: ({ confirm }) => resolve(Boolean(confirm)),
    fail: () => resolve(false),
  }))
}

Page({
  data: {
    profile: {}, nickname: '', nicknameInitial: '我', avatarPreview: '', avatarLocalPath: '',
    authState: 'idle', authDetail: '', updatedText: '', saving: false,
    settings: { calciumAnchorReminder: false, vitaminDReminder: false }, savingSettings: false,
    member: {}, memberCount: 0, maxMembers: 7, inviteLabel: '', inviteCode: '', inviteExpiresText: '', creatingInvite: false,
    transferMembers: [], membersState: 'idle', membersError: '', selectedMemberRef: '', transferringOwner: false,
  },

  onLoad() { this.connect() },
  onShow() { this.render() },

  async connect(force = false) {
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      await authStore.init({ force }); await userStore.init({ force })
      this.render()
      if (member.role === 'owner') await this.loadMembers()
      else this.resetMemberManagement()
    }
    catch (error) { wx.showToast({ title: '连接失败，可稍后重试', icon: 'none' }) }
    this.render()
  },

  resetMemberManagement() {
    this.setData({
      transferMembers: [], membersState: 'idle', membersError: '', selectedMemberRef: '',
      memberCount: 0, inviteCode: '', inviteExpiresText: '', inviteLabel: '', creatingInvite: false,
    })
  },

  async loadMembers() {
    if (!membershipStore.member || membershipStore.member.role !== 'owner') {
      this.resetMemberManagement()
      return
    }
    this.setData({ membersState: 'loading', membersError: '' })
    try {
      const summary = await membershipStore.listMembers()
      if (!membershipStore.member || membershipStore.member.role !== 'owner') {
        this.resetMemberManagement()
        return
      }
      const transferMembers = visibleTransferMembers(summary)
      const selectedMemberRef = transferMembers.some((item) => item.memberRef === this.data.selectedMemberRef)
        ? this.data.selectedMemberRef : ''
      this.setData({
        transferMembers,
        selectedMemberRef,
        membersState: transferMembers.length ? 'ready' : 'empty',
        membersError: '',
        memberCount: Number.isSafeInteger(summary && summary.count) ? summary.count : transferMembers.length + 1,
        maxMembers: Number.isSafeInteger(summary && summary.maxMembers) ? summary.maxMembers : this.data.maxMembers,
      })
    } catch (error) {
      this.setData({
        transferMembers: [], selectedMemberRef: '', membersState: 'error',
        membersError: error.message || '成员列表加载失败，请重试',
      })
    }
  },

  retryMembers() { this.loadMembers() },

  selectTransferMember(event) {
    if (this.data.transferringOwner || this.data.membersState !== 'ready') return
    const memberRef = String(event.detail && event.detail.value || '').toLowerCase()
    if (!this.data.transferMembers.some((item) => item.memberRef === memberRef)) return
    this.setData({ selectedMemberRef: memberRef })
  },

  async transferOwner() {
    if (this.data.transferringOwner) return
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
    this.setData({
      profile,
      nickname: this.data.nickname || profile.nickname || '',
      nicknameInitial: (this.data.nickname || profile.nickname || '我').slice(0, 1),
      avatarPreview: this.data.avatarPreview || profile.avatarUrl || '',
      authState: authStore.state,
      authDetail: authStore.state === 'ready' ? '微信身份已安全连接，数据按当前用户隔离' : authStore.error || '正在连接微信身份',
      updatedText: formatUpdatedAt(userStore.data.updatedAt),
      settings: userStore.data.settings || { calciumAnchorReminder: false, vitaminDReminder: false },
      member: membershipStore.member || {},
    })
  },

  onChooseAvatar(event) {
    if (event.detail.avatarUrl) this.setData({
      avatarPreview: event.detail.avatarUrl, avatarLocalPath: event.detail.avatarUrl,
    })
  },
  onNicknameInput(event) {
    const nickname = event.detail.value
    this.setData({ nickname, nicknameInitial: (nickname || '我').slice(0, 1) })
  },

  async saveProfile() {
    const nickname = String(this.data.nickname || '').trim().slice(0, 20)
    if (!nickname) return wx.showToast({ title: '请填写昵称', icon: 'none' })
    if (this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '正在保存', mask: true })
    try {
      const avatarImage = this.data.avatarLocalPath
        ? await privateImagePayload(this.data.avatarLocalPath, { maxBytes: MAX_AVATAR_BYTES, label: '头像' })
        : null
      const profile = await authStore.updateProfile({ nickname, avatarImage })
      this.setData({ profile, nickname: profile.nickname, avatarPreview: profile.avatarUrl, avatarLocalPath: '' })
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
    if (this.data.savingSettings) return
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
  inputInviteLabel(event) { this.setData({ inviteLabel: event.detail.value }) },
  async createInvite() {
    if (this.data.creatingInvite) return
    this.setData({ creatingInvite: true })
    try {
      const invite = await membershipStore.createInvite(this.data.inviteLabel)
      this.setData({ inviteCode: invite.code, inviteExpiresText: formatBeijingDateTime(invite.expiresAt), inviteLabel: '' })
    } catch (error) { wx.showToast({ title: error.message || '邀请码生成失败', icon: 'none' }) }
    finally { this.setData({ creatingInvite: false }) }
  },
  copyInvite() {
    if (!this.data.inviteCode) return
    wx.setClipboardData({ data: this.data.inviteCode, success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' }) })
  },
  clearMyData() {
    wx.showModal({
      title: '清空我的私人数据？',
      content: '将永久删除你的资料、当前及候选餐单、历史计划、生成偏好、提醒、采购状态、体重、运动、头像、照片和成员身份。管理员仍有其他成员时，必须先明确转移管理员身份。此操作无法恢复。',
      confirmText: '永久清空', confirmColor: '#A33F2B',
      success: ({ confirm }) => {
        if (!confirm) return
        wx.showModal({ title: '再次确认', content: '确认删除当前微信账号的全部数据和成员身份？删除后再次使用需要重新获得邀请。', confirmText: '确认删除', confirmColor: '#A33F2B', success: async ({ confirm: confirmed }) => {
          if (!confirmed) return
          wx.showLoading({ title: '正在清空', mask: true })
          try {
            const cacheNamespace = membershipStore.cacheNamespace
            await callFunction('privacy', 'clearMyData')
            const storageInfo = wx.getStorageInfoSync()
            clearPrivateCache(cacheNamespace, storageInfo)
            if (typeof membershipStore.reset === 'function') membershipStore.reset()
            wx.showToast({ title: '私人数据已清空', icon: 'success' })
            setTimeout(() => wx.reLaunch({ url: '/pages/access/access' }), 700)
          } catch (error) { wx.showToast({ title: error.message || '清空失败', icon: 'none' }) }
          finally { wx.hideLoading() }
        } })
      },
    })
  },
})
