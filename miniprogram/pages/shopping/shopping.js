const { shoppingGroups } = require('../../data/meal-plan')
const { userStore } = require('../../services/user-store')
const { authStore } = require('../../services/auth-store')
const { membershipStore } = require('../../services/membership-store')

function buildGroups(checkedIds) {
  const checked = new Set(checkedIds)
  return shoppingGroups.map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, checked: checked.has(item.id) })),
    checkedCount: group.items.filter((item) => checked.has(item.id)).length,
  }))
}

Page({
  data: { groups: [], total: 0, checked: 0, loading: true, offline: false, saving: false, skeletons: [1, 2, 3] },
  onLoad() { this.loadData() },
  onShow() { if (!this.data.loading) this.render() },
  onHide() { userStore.flush().catch(() => {}) },

  async loadData(force = false) {
    this.setData({ loading: true })
    try {
      const member = await membershipStore.init({ force })
      if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
      await authStore.init({ force }); await userStore.init({ force })
    } catch (_) {}
    this.render()
    wx.stopPullDownRefresh()
  },

  render() {
    const checkedIds = userStore.data.checkedShoppingIds
    const total = shoppingGroups.reduce((sum, group) => sum + group.items.length, 0)
    this.setData({
      groups: buildGroups(checkedIds), total, checked: checkedIds.length,
      loading: false, offline: userStore.state === 'offline', saving: userStore.state === 'saving',
    })
  },

  toggleItem(event) {
    const id = event.currentTarget.dataset.id
    const checked = new Set(userStore.data.checkedShoppingIds)
    if (checked.has(id)) checked.delete(id); else checked.add(id)
    userStore.patch({ checkedShoppingIds: [...checked] })
    this.render()
  },

  resetChecked() {
    if (!userStore.data.checkedShoppingIds.length) return
    wx.showModal({
      title: '重置采购进度？', content: '只会清空勾选，不会删除清单。', confirmText: '重置',
      success: ({ confirm }) => {
        if (!confirm) return
        userStore.patch({ checkedShoppingIds: [] }, { immediate: true }).then(() => this.render()).catch(() => this.render())
      },
    })
  },

  retrySync() { this.loadData(true) },
  onPullDownRefresh() { this.loadData(true) },
})
