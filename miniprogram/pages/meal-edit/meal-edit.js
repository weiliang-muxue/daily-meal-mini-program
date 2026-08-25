const { plans } = require('../../data/meal-plan')
const { userStore } = require('../../services/user-store')
const { membershipStore } = require('../../services/membership-store')

function findBaseMeal(mealId) {
  const [dayId, type] = String(mealId || '').split(':')
  for (const plan of plans) {
    const day = plan.days.find((item) => item.id === dayId)
    if (day && ['breakfast', 'restDinner', 'workoutDinner'].includes(type)) return { day, type, meal: day[type] }
  }
  return null
}

Page({
  data: { mealId: '', base: {}, form: {}, hasOverride: false, saving: false },
  async onLoad(options) {
    const member = await membershipStore.init()
    if (!member || member.status !== 'active') return wx.reLaunch({ url: '/pages/access/access' })
    await userStore.init()
    const mealId = decodeURIComponent(options.mealId || '')
    const found = findBaseMeal(mealId)
    if (!found) return wx.showToast({ title: '餐食不存在', icon: 'none' })
    const override = userStore.data.mealOverrides[mealId]
    this.setData({ mealId, base: found.meal, form: { ...found.meal, ...(override || {}) }, hasOverride: Boolean(override) })
  },
  input(event) { this.setData({ [`form.${event.currentTarget.dataset.field}`]: event.detail.value }) },
  async save() {
    const form = this.data.form
    if (!String(form.title || '').trim() || !String(form.ingredients || '').trim()) return wx.showToast({ title: '名称和食材不能为空', icon: 'none' })
    this.setData({ saving: true })
    const mealOverrides = { ...userStore.data.mealOverrides, [this.data.mealId]: {
      title: String(form.title).trim().slice(0, 40), ingredients: String(form.ingredients).trim().slice(0, 300),
      method: String(form.method || '').trim().slice(0, 300), tag: String(form.tag || '').trim().slice(0, 60), updatedAt: new Date().toISOString(),
    } }
    try { await userStore.patch({ mealOverrides }, { immediate: true }); wx.showToast({ title: '我的方案已保存', icon: 'success' }); setTimeout(() => wx.navigateBack(), 500) }
    catch (error) { wx.showToast({ title: error.message || '保存失败', icon: 'none' }); this.setData({ saving: false }) }
  },
  reset() {
    wx.showModal({ title: '恢复基础餐食？', content: '只删除你的个人调整，不影响其他人。', confirmText: '恢复', success: async ({ confirm }) => {
      if (!confirm) return
      const mealOverrides = { ...userStore.data.mealOverrides }; delete mealOverrides[this.data.mealId]
      try { await userStore.patch({ mealOverrides }, { immediate: true }); wx.navigateBack() } catch (error) { wx.showToast({ title: '恢复失败', icon: 'none' }) }
    } })
  },
})
