'use strict'
const push = require('../../services/water-push')
const { membershipStore } = require('../../services/membership-store')
const active = (page, namespace) => !page.unloaded && namespace === membershipStore.cacheNamespace

module.exports = {
  async refreshPush() {
    if (this.data.pushLoading || this.data.subscribing) return
    const namespace = membershipStore.cacheNamespace
    const revision = this.pushRevision = (this.pushRevision || 0) + 1
    this.intent = null
    this.setData({ pushLoading: true, canSubscribe: false, pushError: '' })
    try {
      let state = await push.request('status', {}, namespace)
      if (!active(this, namespace) || revision !== this.pushRevision) return
      if (state.ready && this.data.saved.enabled && !this.data.dirty && !this.data.syncPending && !this.grant) state = await push.request('prepare', {}, namespace)
      if (active(this, namespace) && revision === this.pushRevision) this.showPush(state)
    } catch (error) {
      if (active(this, namespace) && revision === this.pushRevision) this.setData({ pushReady: false, canSubscribe: false, pushTitle: '微信提醒暂不可用', pushDetail: '提醒时间会保留，不影响餐单和其他记录。', pushNext: '', pushError: error.message || '请稍后重试' })
    } finally { if (active(this, namespace)) this.setData({ pushLoading: false }) }
  },
  showPush(state) {
    const view = push.presentation(state)
    this.intent = state.intentId ? { id: state.intentId, templateId: state.templateId, expiresAt: state.intentExpiresAt } : null
    this.setData({ pushReady: state.ready, pushTitle: view.title, pushDetail: view.detail, pushNext: view.next,
      canSubscribe: Boolean(this.intent && state.ready && !this.data.dirty && !this.data.syncPending && this.data.saved.enabled),
      subscribeLabel: state.type === 'longterm' ? '授权微信提醒' : '订阅下一次提醒' })
  },
  subscribe() {
    if (!this.data.canSubscribe || this.data.subscribing || this.data.saving || this.data.dirty || this.data.syncPending) return
    const namespace = membershipStore.cacheNamespace, intent = this.intent
    if (!intent || intent.expiresAt <= Date.now()) { this.setData({ canSubscribe: false, pushError: '授权准备已过期，请刷新状态后再订阅。' }); return }
    if (typeof wx.requestSubscribeMessage !== 'function') { this.setData({ pushError: '当前微信版本不支持订阅消息，请更新微信。' }); return }
    this.setData({ subscribing: true, pushError: '' })
    // Direct user gesture: no await, modal or cloud call before the native request.
    try { wx.requestSubscribeMessage({ tmplIds: [intent.templateId],
      success: (result) => {
        if (!active(this, namespace)) return
        if (!['accept', 'acceptWithAudio'].includes(result[intent.templateId])) {
          this.setData({ subscribing: false, pushError: '本次未允许提醒，没有增加次数；其他功能仍可使用。' }); return
        }
        this.grant = { intentId: intent.id, namespace }
        this.submitGrant()
      },
      fail: () => { if (active(this, namespace)) this.setData({ subscribing: false, pushError: '微信订阅未完成，请稍后重试；不会自动申请权限。' }) },
    }) } catch (_) { this.setData({ subscribing: false, pushError: '微信订阅暂不可用，请稍后重试。' }) }
  },
  async submitGrant() {
    const grant = this.grant
    if (!grant || this.grantSubmitting || !active(this, grant.namespace)) return
    this.grantSubmitting = true
    this.setData({ subscribing: true, canSubscribe: false, pushError: '' })
    try {
      const state = await push.request('grant', { intentId: grant.intentId, accepted: true }, grant.namespace)
      if (!active(this, grant.namespace)) return
      this.grant = null
      this.showPush(state)
      this.setData({ pendingGrant: false })
      wx.showToast({ title: '订阅已登记', icon: 'success' })
    } catch (error) {
      if (active(this, grant.namespace)) {
        const expired = error.code === 'WATER_INTENT_INVALID'
        if (expired) this.grant = null
        this.setData({ pendingGrant: !expired, pushError: expired ? '登记已过期，请刷新后重新订阅。' : '微信授权结果尚未登记，请重试登记；无需再次弹出授权。' })
      }
    } finally { this.grantSubmitting = false; if (active(this, grant.namespace)) this.setData({ subscribing: false }) }
  },
}
