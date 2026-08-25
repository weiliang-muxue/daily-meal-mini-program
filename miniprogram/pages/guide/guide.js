const { userStore } = require('../../services/user-store')
const { membershipStore } = require('../../services/membership-store')

Page({
  data: { settings: {}, reminders: [], newReminder: '', saving: false },
  async onLoad() {
    const member = await membershipStore.init()
    if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
    userStore.init().then(() => this.render())
  },
  onShow() { this.render() },
  onHide() { userStore.flush().catch(() => {}) },

  render() {
    this.setData({ settings: userStore.data.settings, reminders: userStore.data.customReminders, saving: userStore.state === 'saving' })
  },

  toggleSetting(event) {
    const key = event.currentTarget.dataset.key
    const settings = { ...userStore.data.settings, [key]: Boolean(event.detail.value) }
    userStore.patch({ settings })
    this.render()
  },

  inputReminder(event) { this.setData({ newReminder: event.detail.value }) },
  addReminder() {
    const text = String(this.data.newReminder || '').trim().slice(0, 80)
    if (!text) return wx.showToast({ title: '先写下提醒内容', icon: 'none' })
    const reminders = [...userStore.data.customReminders, { id: `reminder-${Date.now()}`, text, done: false }]
    userStore.patch({ customReminders: reminders })
    this.setData({ newReminder: '' })
    this.render()
  },
  toggleReminder(event) {
    const id = event.currentTarget.dataset.id
    const reminders = userStore.data.customReminders.map((item) => item.id === id ? { ...item, done: !item.done } : item)
    userStore.patch({ customReminders: reminders })
    this.render()
  },
  removeReminder(event) {
    const id = event.currentTarget.dataset.id
    userStore.patch({ customReminders: userStore.data.customReminders.filter((item) => item.id !== id) })
    this.render()
  },
})
