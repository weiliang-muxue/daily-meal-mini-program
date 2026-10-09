'use strict'

const { navigation } = require('../../utils/catalog-page')
Page({
  ...navigation,
  data: { canNavigateBack: false, pageNavigationLabel: '返回餐单首页', meta: null, error: '', notice: '', copying: false },
  onLoad() { this.refreshNavigation(); this.load() },
  onShow() { this.refreshNavigation() },
  onUnload() { this.unloaded = true },
  load() {
    if (this.unloaded) return
    try { this.setData({ meta: require('../../data/recipe-catalog-meta'), error: '' }) }
    catch (_) { this.setData({ meta: null, error: '来源说明暂时无法加载，请重新打开或重试' }) }
  },
  copySource(event) {
    if (this.unloaded || this.data.copying || !this.data.meta) return
    const meta = this.data.meta
    const links = { dataset: meta.datasetRepository + '/tree/' + meta.datasetCommit,
      upstream: meta.sourceRepository + '/tree/' + meta.sourceVerificationCommit }
    const key = event.currentTarget.dataset.source
    if (!Object.prototype.hasOwnProperty.call(links, key)) return
    this.setData({ copying: true, notice: '' })
    const finish = () => { if (!this.unloaded) this.setData({ copying: false }) }
    const fail = () => { if (!this.unloaded) this.setData({ notice: '复制未成功，可长按下方来源文字复制' }); finish() }
    try { wx.setClipboardData({ data: links[key],
      success: () => { if (!this.unloaded) this.setData({ notice: '已复制公开来源链接，可在浏览器中查看' }) },
      fail, complete: finish }) } catch (_) { fail() }
  },
})
