'use strict'

const catalog = require('../../services/recipe-catalog')
const { createCatalogPage } = require('../../utils/catalog-page')
Page(createCatalogPage({
  data: { recipe: null, sourcePath: '', copying: false },
  renderCatalog(options) {
    const recipe = catalog.find(this.catalog.index, options.id)
    if (!recipe) { this.setData({ recipe: null, error: '这道菜暂未收录，请返回菜谱库重新选择' }); return }
    const source = catalog.sourceFor(this.catalog.meta, recipe.id)
    this.setData({ recipe, sourcePath: source ? source.path : '' })
  },
  copyTitle() {
    if (!this.current() || !this.data.recipe || this.data.copying) return
    this.setData({ copying: true, notice: '' })
    const finish = () => { if (!this.unloaded) this.setData({ copying: false }) }
    try { wx.setClipboardData({ data: this.data.recipe.title,
      success: () => { if (this.current()) this.setData({ notice: '菜名已复制，可自行填入“想吃什么”；不会自动生成或替换餐单' }) },
      fail: () => { if (this.current()) this.setData({ notice: '复制未成功，可以手动输入菜名' }) }, complete: finish })
    } catch (_) { if (this.current()) this.setData({ notice: '复制未成功，可以手动输入菜名' }); finish() }
  },
}))
