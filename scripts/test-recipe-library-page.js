'use strict'

// Fictional page interactions. No native runtime, provider or cloud connection.
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { fixture, NOW, ID } = require('./test-recipe-library')
const library = require('../shared/recipe-library')
const copy = value => JSON.parse(JSON.stringify(value))
let listener, definition, write, modalConfirm = true
const writes = []
const member = { cacheNamespace: 'a'.repeat(32), async init() { return { status: 'active' } },
  onCacheNamespaceChange(callback) { listener = callback; return () => { listener = null } } }
const store = { state: 'ready', namespace: member.cacheNamespace, data: fixture(),
  async init() { return this.data }, isCurrentNamespace(namespace) { return namespace === this.namespace && namespace === member.cacheNamespace },
  async changeFavorite(...args) { writes.push(args); return write(...args) },
}
for (const [name, exports] of [['user-store', { userStore: store }], ['membership-store', { membershipStore: member }]]) {
  const filename = path.resolve(__dirname, '../miniprogram/services', name + '.js')
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}
global.Page = value => { definition = value }
global.wx = { reLaunch() {}, navigateBack() {}, switchTab() {}, showModal: options => options.success({ confirm: modalConfirm }) }
require('../miniprogram/pages/recipe-library/recipe-library')
const event = id => ({ currentTarget: { dataset: { id } } })
async function page(options = {}, withFavorite = true) {
  writes.length = 0; modalConfirm = true; store.state = 'ready'; member.cacheNamespace = store.namespace = 'a'.repeat(32)
  store.data = withFavorite ? library.add(fixture(), 'meal-0-breakfast', ID, NOW) : fixture()
  write = async (action, payload, revision) => {
    assert.strictEqual(revision, store.data.stateRevision)
    if (action === 'addFavorite') store.data = library.add(store.data, payload.mealId, ID, NOW)
    if (action === 'removeFavorite') store.data = library.remove(store.data, payload.favoriteId)
    if (action === 'applyFavorite') store.data = library.proposal(store.data, payload.favoriteId, payload.target, NOW)
    store.data = { ...store.data, stateRevision: revision + 1 }
    return store.data
  }
  const value = { ...definition, data: copy(definition.data), setData(partial) { Object.assign(this.data, partial) } }
  await value.onLoad(options)
  return value
}
async function run() {
  let p = await page({}, false)
  assert.strictEqual(p.data.count, 0); assert.strictEqual(writes.length, 0)
  let navigation, navigationCount = 0
  wx.navigateTo = options => { navigation = options; navigationCount++ }
  p.openCatalog(); p.openCatalog(); assert.strictEqual(navigationCount, 1)
  assert.strictEqual(navigation.url, '/pages/recipe-catalog/recipe-catalog')
  navigation.fail(); assert(p.data.error.includes('重试')); assert.strictEqual(p.catalogOpening, false)
  p.openCatalog(); p.onUnload(); const message = p.data.error; navigation.fail()
  assert.strictEqual(p.data.error, message, 'navigation callback does not update an unloaded library')
  assert.strictEqual(writes.length, 0, 'opening public recipes does not change favorites')
  p = await page({ mealId: 'meal-0-breakfast' }, false)
  assert(p.data.capture); await p.saveFavorite()
  assert.strictEqual(p.data.count, 1); assert.strictEqual(p.data.capture, null)
  assert(p.data.notice.includes('已收藏'))
  p.search({ detail: { value: '找不到' } }); assert.strictEqual(p.data.filtered.length, 0)
  p.search({ detail: { value: '鸡蛋' } }); assert.strictEqual(p.data.filtered.length, 1)
  p.select(event(ID)); p.selectTarget({ detail: { value: 1 } })
  const original = copy(store.data)
  p.previewFavorite(); assert(p.data.preview); assert.strictEqual(p.data.reviewed, false)
  assert.strictEqual(p.data.preview.restrictions, store.data.generationPreferences.restrictions)
  await p.confirmFavorite(); assert.deepStrictEqual(store.data, original)
  p.review({ detail: { value: ['reviewed'] } }); p.cancelPreview()
  assert.deepStrictEqual(store.data, original)
  p.previewFavorite(); p.review({ detail: { value: ['reviewed'] } }); await p.confirmFavorite()
  assert(store.data.mealOverrides['meal-0-rest']); assert.strictEqual(p.data.preview, null)
  assert.deepStrictEqual(store.data.activePlan, original.activePlan)
  modalConfirm = false; const before = copy(store.data); await p.removeFavorite(); assert.deepStrictEqual(store.data, before)
  modalConfirm = true; await p.removeFavorite(); assert.strictEqual(p.data.count, 0)
  assert.deepStrictEqual(store.data.mealOverrides, before.mealOverrides)
  p = await page(); p.select(event(ID)); p.previewFavorite(); p.review({ detail: { value: ['reviewed'] } })
  store.data.stateRevision += 1; await p.confirmFavorite(); assert.strictEqual(writes.length, 0); assert(p.data.error.includes('变化'))
  p = await page(); p.select(event(ID)); p.previewFavorite(); p.review({ detail: { value: ['reviewed'] } })
  const failedState = copy(store.data); write = async () => { throw new Error('network failure') }
  await p.confirmFavorite(); assert.deepStrictEqual(store.data, failedState); assert(p.data.error.includes('刷新'))
  p = await page(); store.state = 'offline'; p.render(); p.select(event(ID)); p.previewFavorite(); await p.removeFavorite()
  assert.strictEqual(p.data.offline, true); assert.strictEqual(p.data.preview, null); assert.strictEqual(writes.length, 0)
  p = await page(); p.select(event(ID)); p.previewFavorite(); p.review({ detail: { value: ['reviewed'] } })
  member.cacheNamespace = store.namespace = 'b'.repeat(32); listener(member.cacheNamespace)
  assert.deepStrictEqual(p.data.favorites, []); assert.strictEqual(p.data.selected, null); await p.confirmFavorite(); assert.strictEqual(writes.length, 0)
  p = await page(); p.select(event(ID)); p.previewFavorite(); p.onHide(); assert.strictEqual(p.data.preview, null)
  p.onShow(); assert.strictEqual(p.data.reviewed, false)
  p = await page()
  store.data.favoriteRecipes[0].recipe.ingredientItems = Array.from({ length: 30 }, (_, index) => ({
    name: '虚构长名称食材'.repeat(4) + index, quantity: 1, unit: 'g', category: '其他' }))
  const lastIngredient = store.data.favoriteRecipes[0].recipe.ingredientItems[29].name
  p.render(); p.search({ detail: { value: lastIngredient } }); p.select(event(ID))
  assert.strictEqual(p.data.filtered.length, 1, 'search includes ingredients beyond the short text summary')
  assert(p.data.selected.recipe.displayIngredients.includes(lastIngredient), 'review must display every structured ingredient')
  const originalInit = store.init
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  try {
    p = await page()
    let pendingLoad = deferred()
    store.init = () => pendingLoad.promise
    let loading = p.load(); await Promise.resolve()
    p.onHide(); pendingLoad.resolve(store.data); await loading; p.onShow()
    assert.strictEqual(p.data.loading, false, 'a load completed while hidden must not freeze the returned page')
    assert.strictEqual(p.data.count, 1)
    assert.strictEqual(writes.length, 0)

    pendingLoad = deferred(); loading = p.load(); await Promise.resolve()
    p.onHide(); p.onShow()
    assert.strictEqual(p.data.loading, true, 'returning before sync completes must not expose ready controls')
    pendingLoad.resolve(store.data); await loading
    assert.strictEqual(p.data.loading, false)

    pendingLoad = deferred(); loading = p.load(); await Promise.resolve()
    p.onHide(); pendingLoad.reject(new Error('synthetic hidden failure')); await loading; p.onShow()
    assert.strictEqual(p.data.loading, false)
    assert(p.data.error.includes('重试'))
    store.init = originalInit; await p.load()
    assert.strictEqual(p.data.error, '')

    const oldLoad = deferred(), newLoad = deferred()
    let loads = 0
    store.init = () => (++loads === 1 ? oldLoad.promise : newLoad.promise)
    const firstLoad = p.load(); await Promise.resolve()
    const secondLoad = p.load(); await Promise.resolve()
    oldLoad.reject(new Error('synthetic stale failure')); await firstLoad
    assert.strictEqual(p.data.loading, true, 'an old failure cannot finish the newer refresh')
    assert.strictEqual(p.data.error, '', 'an old failure cannot replace newer feedback')
    newLoad.resolve(store.data); await secondLoad
    assert.strictEqual(p.data.loading, false)

    pendingLoad = deferred(); store.init = () => pendingLoad.promise
    loading = p.load(); await Promise.resolve(); p.onUnload()
    const unloadedData = copy(p.data)
    pendingLoad.resolve(store.data); await loading
    assert.deepStrictEqual(p.data, unloadedData, 'loading completion cannot update an unloaded page')
  } finally { store.init = originalInit }
  const originalModal = wx.showModal
  try {
    for (const confirmed of [false, true]) {
      p = await page(); p.select(event(ID))
      let modal
      wx.showModal = options => { modal = options }
      const pending = p.removeFavorite()
      assert.strictEqual(p.data.busy, true)
      p.onHide(); p.onShow()
      assert.strictEqual(p.data.busy, false, 'leaving a pending prompt cannot lock the returned page')
      modal.success({ confirm: confirmed }); await pending
      assert.strictEqual(writes.length, 0, 'a prompt from before leaving cannot remove a favorite')
      assert.strictEqual(p.data.count, 1)
    }
    p = await page(); p.select(event(ID))
    wx.showModal = () => { throw new Error('synthetic modal startup failure') }
    await assert.doesNotReject(p.removeFavorite())
    assert.strictEqual(p.data.busy, false)
    assert(p.data.error.includes('重试'))
    assert.strictEqual(writes.length, 0)
    p = await page(); p.select(event(ID))
    wx.showModal = options => options.fail({ errMsg: 'synthetic failure' })
    await p.removeFavorite()
    assert.strictEqual(p.data.busy, false)
    assert(p.data.error.includes('重试'))
    assert.strictEqual(writes.length, 0)
    // A late old callback must not unlock or confirm a newer visible prompt.
    p = await page(); p.select(event(ID))
    const prompts = []
    wx.showModal = options => prompts.push(options)
    const first = p.removeFavorite()
    p.onHide(); p.onShow()
    const second = p.removeFavorite()
    assert.strictEqual(prompts.length, 2)
    prompts[0].success({ confirm: true }); await first
    assert.strictEqual(p.data.busy, true)
    assert.strictEqual(writes.length, 0)
    prompts[1].success({ confirm: false }); await second
    assert.strictEqual(p.data.busy, false)
    assert.strictEqual(writes.length, 0)
  } finally { wx.showModal = originalModal }
  let finish
  p = await page({ mealId: 'meal-0-breakfast' }, false)
  write = () => new Promise(resolve => { finish = resolve })
  const waiting = p.saveFavorite(); await p.saveFavorite(); assert.strictEqual(writes.length, 1, 'double tap is blocked')
  p.onHide(); p.onShow()
  assert.strictEqual(p.data.busy, true, 'leaving an already dispatched write must not unlock another write')
  p.onUnload(); finish(store.data); await waiting; assert.strictEqual(p.data.notice, '', 'late callback after unload must not claim success')
  const source = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/recipe-library/recipe-library.wxml'), 'utf8')
  const css = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/recipe-library/recipe-library.wxss'), 'utf8')
  assert(source.includes('checked="{{reviewed}}"')); assert(!source.includes('<web-view'))
  assert(css.includes('min-height: 48px')); assert(css.includes('var(--ink)')); assert(css.includes('overflow-wrap: anywhere'))
  console.log('Recipe library page: explicit confirmation, search, cancellation, offline, failure, identity and late-callback tests passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
