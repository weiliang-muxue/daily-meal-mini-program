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
  let finish
  p = await page({ mealId: 'meal-0-breakfast' }, false)
  write = () => new Promise(resolve => { finish = resolve })
  const waiting = p.saveFavorite(); await p.saveFavorite(); assert.strictEqual(writes.length, 1, 'double tap is blocked')
  p.onUnload(); finish(store.data); await waiting; assert.strictEqual(p.data.notice, '', 'late callback after unload must not claim success')
  const source = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/recipe-library/recipe-library.wxml'), 'utf8')
  const css = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/recipe-library/recipe-library.wxss'), 'utf8')
  assert(source.includes('checked="{{reviewed}}"')); assert(!source.includes('<web-view'))
  assert(css.includes('min-height: 48px')); assert(css.includes('var(--ink)')); assert(css.includes('overflow-wrap: anywhere'))
  console.log('Recipe library page: explicit confirmation, search, cancellation, offline, failure, identity and late-callback tests passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
