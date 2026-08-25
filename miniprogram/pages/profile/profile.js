const { authStore } = require('../../services/auth-store')
const { userStore } = require('../../services/user-store')
const { formatUpdatedAt } = require('../../utils/date')
const { membershipStore } = require('../../services/membership-store')
const { callFunction } = require('../../utils/cloud')

async function uploadAvatar(filePath) {
  const extensionMatch = String(filePath).match(/\.([a-zA-Z0-9]+)(?:\?|$)/)
  const extension = extensionMatch ? extensionMatch[1].toLowerCase() : 'png'
  const ticket = await authStore.prepareAvatar(extension)
  const { fileID } = await wx.cloud.uploadFile({ cloudPath: ticket.cloudPath, filePath })
  return { avatarUploadToken: ticket.token, avatarUploadFileId: fileID }
}

Page({
  data: {
    profile: {}, nickname: '', nicknameInitial: '我', avatarPreview: '',
    authState: 'idle', authDetail: '', updatedText: '', saving: false,
    member: {}, memberCount: 0, maxMembers: 4, inviteLabel: '', inviteCode: '', inviteExpiresText: '', creatingInvite: false,
  },

  onLoad() { this.connect() },
  onShow() { this.render() },

  async connect(force = false) {
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      await authStore.init({ force }); await userStore.init({ force })
      if (member.role === 'owner') {
        const summary = await membershipStore.listMembers()
        this.setData({ memberCount: summary.count, maxMembers: summary.maxMembers })
      }
    }
    catch (error) { wx.showToast({ title: '连接失败，可稍后重试', icon: 'none' }) }
    this.render()
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
      member: membershipStore.member || {},
    })
  },

  onChooseAvatar(event) {
    if (event.detail.avatarUrl) this.setData({ avatarPreview: event.detail.avatarUrl })
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
      let avatarUploadToken = ''
      let avatarUploadFileId = ''
      if (this.data.avatarPreview && !String(this.data.avatarPreview).startsWith('http')) {
        const upload = await uploadAvatar(this.data.avatarPreview)
        avatarUploadToken = upload.avatarUploadToken
        avatarUploadFileId = upload.avatarUploadFileId
      }
      const profile = await authStore.updateProfile({ nickname, avatarUploadToken, avatarUploadFileId })
      this.setData({ profile, nickname: profile.nickname, avatarPreview: profile.avatarUrl })
      wx.showToast({ title: '资料已保存', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message || '保存失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ saving: false })
    }
  },

  retryLogin() { this.connect(true) },
  inputInviteLabel(event) { this.setData({ inviteLabel: event.detail.value }) },
  async createInvite() {
    if (this.data.creatingInvite) return
    this.setData({ creatingInvite: true })
    try {
      const invite = await membershipStore.createInvite(this.data.inviteLabel)
      this.setData({ inviteCode: invite.code, inviteExpiresText: new Date(invite.expiresAt).toLocaleDateString(), inviteLabel: '' })
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
      content: '将永久删除你的资料、餐食调整、采购状态、体重、运动、头像和体重照片。不会影响其他成员，且无法恢复。',
      confirmText: '永久清空', confirmColor: '#A33F2B',
      success: ({ confirm }) => {
        if (!confirm) return
        wx.showModal({ title: '再次确认', content: '确认删除当前微信账号在本小程序内的全部私人记录？', confirmText: '确认删除', confirmColor: '#A33F2B', success: async ({ confirm: confirmed }) => {
          if (!confirmed) return
          wx.showLoading({ title: '正在清空', mask: true })
          try {
            await callFunction('privacy', 'clearMyData')
            wx.clearStorageSync()
            wx.showToast({ title: '私人数据已清空', icon: 'success' })
            setTimeout(() => wx.reLaunch({ url: '/pages/access/access' }), 700)
          } catch (error) { wx.showToast({ title: error.message || '清空失败', icon: 'none' }) }
          finally { wx.hideLoading() }
        } })
      },
    })
  },
})
