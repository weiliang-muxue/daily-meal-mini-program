const { userStore } = require('../../services/user-store')
const { membershipStore } = require('../../services/membership-store')

Page({
  data: { settings: {}, reminders: [], newReminder: '', saving: false, offline: false, saveError: '', loading: true, error: '' },
  onLoad() { return this.connect() },
  onShow() { if (!this.data.loading && !this.data.error) this.render() },
  onHide() { userStore.flush().catch(() => {}) },

  async connect(force = false) {
    this.setData({ loading: true, error: '', saveError: '' })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      await userStore.init({ force })
      this.render()
      this.setData({ loading: false })
    } catch (error) {
      this.setData({ loading: false, error: error.message || '健康提醒暂时无法加载，请重试' })
    }
  },

  retryConnect() { return this.connect(true) },

  render() {
    this.setData({
      settings: userStore.data.settings || {},
      reminders: userStore.data.customReminders || [],
      offline: userStore.state === 'offline',
      saveError: userStore.state === 'offline' ? (userStore.error || this.data.saveError || '网络恢复后可重试同步') : '',
    })
  },

  async persist(partial) {
    if (this.data.saving) return false
    this.setData({ saving: true, saveError: '' })
    try {
      await userStore.patch(partial, { immediate: true })
      this.render()
      this.setData({ offline: false, saveError: '' })
      return true
    } catch (error) {
      this.render()
      this.setData({
        offline: true,
        saveError: userStore.error || error.message || '网络暂时不可用',
      })
      return false
    } finally {
      this.setData({ saving: false })
    }
  },

  async retrySync() {
    if (this.data.saving) return
    this.setData({ saving: true, saveError: '' })
    try {
      await userStore.flush()
      if (userStore.state === 'offline') await userStore.init({ force: true })
      if (userStore.state === 'offline') throw new Error(userStore.error || '同步仍未完成，请稍后重试')
      this.render()
      this.setData({ offline: false, saveError: '' })
    } catch (error) {
      this.render()
      this.setData({ offline: true, saveError: userStore.error || error.message || '同步仍未完成，请稍后重试' })
    } finally {
      this.setData({ saving: false })
    }
  },

  async toggleSetting(event) {
    const key = event.currentTarget.dataset.key
    if (!['calciumAnchorReminder', 'vitaminDReminder'].includes(key) || this.data.saving) return
    const settings = { ...(userStore.data.settings || {}), [key]: Boolean(event.detail.value) }
    this.setData({ settings })
    await this.persist({ settings })
  },

  inputReminder(event) { this.setData({ newReminder: event.detail.value }) },
  async addReminder() {
    if (this.data.saving) return
    const text = String(this.data.newReminder || '').trim().slice(0, 80)
    if (!text) return wx.showToast({ title: '先写下提醒内容', icon: 'none' })
    const reminders = [...(userStore.data.customReminders || []), { id: `reminder-${Date.now()}`, text, done: false }]
    await this.persist({ customReminders: reminders })
    this.setData({ newReminder: '' })
  },
  async toggleReminder(event) {
    if (this.data.saving) return
    const id = event.currentTarget.dataset.id
    const reminders = (userStore.data.customReminders || []).map((item) => item.id === id ? { ...item, done: !item.done } : item)
    await this.persist({ customReminders: reminders })
  },
  async removeReminder(event) {
    if (this.data.saving) return
    const id = event.currentTarget.dataset.id
    const reminders = (userStore.data.customReminders || []).filter((item) => item.id !== id)
    await this.persist({ customReminders: reminders })
  },
})
