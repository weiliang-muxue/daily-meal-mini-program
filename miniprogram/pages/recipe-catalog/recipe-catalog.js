'use strict'

const catalog = require('../../services/recipe-catalog')
const { createCatalogPage } = require('../../utils/catalog-page')
Page(createCatalogPage({
  data: { query: '', categories: ['全部分类'], categoryIndex: 0, rows: [], total: 0, hasMore: false, catalogCount: 0 },
  renderCatalog() {
    this.limit = catalog.PAGE_SIZE
    this.setData({ categories: catalog.categories(this.catalog.index), catalogCount: this.catalog.meta.count })
    this.filter()
  },
  filter() {
    if (!this.catalog) return
    this.setData(catalog.search(this.catalog.index, this.data.query,
      this.data.categoryIndex ? this.data.categories[this.data.categoryIndex] : '', this.limit))
  },
  search(event) {
    if (!this.current() || this.data.loading) return
    this.limit = catalog.PAGE_SIZE
    this.setData({ query: String(event.detail.value || '').slice(0, 50) }); this.filter()
  },
  selectCategory(event) {
    if (!this.current() || this.data.loading) return
    const index = Number(event.detail.value)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.categories.length) return
    this.limit = catalog.PAGE_SIZE; this.setData({ categoryIndex: index }); this.filter()
  },
  clearSearch() {
    if (!this.current()) return
    this.limit = catalog.PAGE_SIZE; this.setData({ query: '', categoryIndex: 0 }); this.filter()
  },
  showMore() {
    if (!this.current() || !this.data.hasMore) return
    this.limit += catalog.PAGE_SIZE; this.filter()
  },
  openRecipe(event) {
    if (!this.current() || !this.catalog) return
    const recipe = catalog.find(this.catalog.index, event.currentTarget.dataset.id)
    if (recipe) this.openPage('/pages/recipe-detail/recipe-detail?id=' + encodeURIComponent(recipe.id))
  },
}))
