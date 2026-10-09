'use strict'

// Native-page handlers with fictional membership. Not phone rendering or cloud tests.
const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const fs = require('node:fs')
const catalog = require('../miniprogram/services/recipe-catalog')
const record = require('../miniprogram/data/recipe-catalog')[0]
const root = path.resolve(__dirname, '..')
const read = name => fs.readFileSync(path.join(root, name), 'utf8')
const copy = value => JSON.parse(JSON.stringify(value))
const namespaces = new Set(), memberships = new Set()
const calls = []
let initialize, navigate, clipboard
const store = { member: { status: 'active' }, cacheNamespace: 'a'.repeat(32), init() { return initialize() },
  onCacheNamespaceChange(fn) { namespaces.add(fn); return () => namespaces.delete(fn) },
  onMembershipChange(fn) { memberships.add(fn); return () => memberships.delete(fn) } }
const filename = path.join(root, 'miniprogram/services/membership-store.js')
require.cache[filename] = { id: filename, filename, loaded: true, exports: { membershipStore: store } }
const definitions = {}
for (const name of ['recipe-catalog/recipe-catalog', 'recipe-detail/recipe-detail', 'legal/sources']) {
  global.Page = definition => { definitions[name] = definition }
  require('../miniprogram/pages/' + name)
}
function setup(name = 'recipe-catalog/recipe-catalog') {
  namespaces.clear(); memberships.clear(); calls.length = 0
  store.member = { status: 'active' }; store.cacheNamespace = 'a'.repeat(32)
  initialize = async () => store.member
  navigate = options => { calls.push(['navigate', options.url]); if (options.complete) options.complete() }
  clipboard = options => { calls.push(['clipboard', options.data]); if (options.success) options.success(); if (options.complete) options.complete() }
  global.getCurrentPages = () => [{}, {}]
  global.wx = { navigateTo: options => navigate(options), setClipboardData: options => clipboard(options),
    reLaunch: options => calls.push(['reLaunch', options.url]),
    switchTab: options => calls.push(['home', options.url]), navigateBack: options => calls.push(['back', options.delta]) }
  const definition = definitions[name]
  return { ...definition, data: copy(definition.data), writesAfterUnload: 0,
    setData(values) { if (this.unloaded) this.writesAfterUnload++; Object.assign(this.data, values) } }
}
const input = value => ({ detail: { value } })
const item = id => ({ currentTarget: { dataset: { id } } })
const source = key => ({ currentTarget: { dataset: { source: key } } })

test('search, filter, empty state, clear, back and return preserve the query', async () => {
  const p = setup(); await p.onLoad()
  assert.equal(p.data.loading, false); assert.equal(p.data.error, ''); assert(p.data.rows.length)
  p.search(input('豆腐')); const visible = copy(p.data.rows)
  p.openRecipe(item(visible[0].id)); assert(calls[0][1].startsWith('/pages/recipe-detail/recipe-detail?id='))
  p.onHide(); p.search(input('ignored')); p.onShow()
  assert.equal(p.data.query, '豆腐'); assert.deepEqual(p.data.rows, visible)
  p.selectCategory(input(p.data.categories.indexOf('早餐')))
  assert.equal(p.data.total, 0)
  p.selectCategory(input(-1)); assert(p.data.categoryIndex >= 0)
  p.clearSearch(); assert.equal(p.data.query, ''); assert.equal(p.data.categoryIndex, 0)
  p.navigateFromPage(); assert.deepEqual(calls.at(-1), ['back', 1])
  global.getCurrentPages = () => [{}]; p.refreshNavigation(); p.navigateFromPage()
  assert.deepEqual(calls.at(-1), ['home', '/pages/plan/plan'])
  p.onUnload(); assert.equal(namespaces.size, 0); assert.equal(memberships.size, 0)
})
test('large list loads in batches and changed search resets the limit', async () => {
  const p = setup(); await p.onLoad()
  p.catalog.index = catalog.createIndex(Array.from({ length: 31 }, (_, i) => ({ ...copy(record), id: 'test_' + i })))
  p.filter(); assert.equal(p.data.rows.length, 12); p.showMore(); assert.equal(p.data.rows.length, 24)
  p.showMore(); assert.equal(p.data.rows.length, 31); assert.equal(p.data.hasMore, false)
  p.search(input(record.title)); assert.equal(p.data.rows.length, 12)
})
test('nonmembers, legal-consent gate and failure retry do not render recipes', async () => {
  for (const status of ['invite_required', 'consent_required', 'deleting']) {
    const p = setup(); store.member.status = status; await p.onLoad()
    assert.equal(p.data.rows.length, 0); p.openRecipe(item(record.id)); p.openSources()
    assert.deepEqual(calls, [['reLaunch', '/pages/access/access']])
  }
  const p = setup(); initialize = async () => { throw new Error('raw failure must not escape') }
  await p.onLoad(); assert(p.data.error.includes('重试')); assert(!p.data.error.includes('raw'))
  initialize = async () => store.member; await p.load(); assert.equal(p.data.error, ''); assert(p.data.rows.length)
})
test('missing catalog gives friendly retry, with no fallback to network', async () => {
  const p = setup(), load = catalog.load
  try {
    catalog.load = () => { throw new Error('broken local package') }
    await p.onLoad(); assert.equal(p.data.rows.length, 0); assert(p.data.error.includes('重试'))
  } finally { catalog.load = load }
  await p.load(); assert.equal(p.data.error, '')
})
test('identity change or membership revocation clears local query and prevents actions', async () => {
  for (const change of [() => { store.cacheNamespace = 'b'.repeat(32); namespaces.forEach(fn => fn(store.cacheNamespace)) },
    () => { store.member = { status: 'deleting' }; memberships.forEach(fn => fn(store.member)) }]) {
    const p = setup(); await p.onLoad(); p.search(input('private preference'))
    change(); assert.equal(p.data.query, ''); assert.equal(p.data.rows.length, 0); assert.equal(p.data.accessChanged, true)
    p.openRecipe(item(record.id)); p.openSources(); await p.load(); assert.equal(calls.length, 0)
  }
})
test('one init at a time; unloading or identity change blocks late render', async () => {
  for (const mode of ['unload', 'identity']) {
    const p = setup(); let finish, count = 0
    initialize = () => { count++; return new Promise(resolve => { finish = resolve }) }
    const pending = p.onLoad(); await p.load(); assert.equal(count, 1)
    if (mode === 'unload') p.onUnload()
    else { store.cacheNamespace = 'b'.repeat(32); namespaces.forEach(fn => fn(store.cacheNamespace)) }
    finish(store.member); await pending
    assert.equal(p.data.rows.length, 0); assert.equal(p.writesAfterUnload, 0)
  }
})
test('known-only navigation, repeated taps and failures recover without losing search', async () => {
  const p = setup(); await p.onLoad(); p.search(input('豆腐'))
  p.openRecipe(item('../profile/profile')); assert.equal(calls.length, 0)
  let pending; navigate = options => { pending = options; calls.push(['pending']) }
  p.openSources(); p.openSources(); assert.equal(calls.length, 1)
  pending.fail(); assert.equal(p.data.navigating, false); assert(p.data.notice.includes('重试')); assert.equal(p.data.query, '豆腐')
  navigate = () => { throw new Error('native API unavailable') }; p.openSources(); assert.equal(p.data.navigating, false)
})
test('details display full source amounts and tips without scaling or personal writes', async () => {
  const p = setup('recipe-detail/recipe-detail'); await p.onLoad({ id: record.id })
  assert.deepEqual(p.data.recipe, record); assert(p.data.sourcePath.endsWith('.md'))
  assert.equal(calls.length, 0, 'opening is read-only')
  p.copyTitle(); assert.deepEqual(calls, [['clipboard', record.title]])
  assert(p.data.notice.includes('不会自动'))
  p.onHide(); p.copyTitle(); assert.equal(calls.length, 1)
  const bad = setup('recipe-detail/recipe-detail'); await bad.onLoad({ id: '%2e%2e%2fprivate' })
  assert.equal(bad.data.recipe, null); assert(bad.data.error.includes('暂未收录')); bad.copyTitle(); assert.equal(calls.length, 0)
})
test('clipboard failure and late callbacks cannot restore revoked/closed detail UI', async () => {
  let p = setup('recipe-detail/recipe-detail'); await p.onLoad({ id: record.id })
  clipboard = options => { options.fail(); options.complete() }; p.copyTitle()
  assert.equal(p.data.copying, false); assert(p.data.notice.includes('手动'))
  let pending; clipboard = options => { pending = options }; p.copyTitle(); p.onUnload()
  pending.success(); pending.complete(); assert.equal(p.writesAfterUnload, 0)
  p = setup('recipe-detail/recipe-detail'); await p.onLoad({ id: record.id })
  clipboard = options => { pending = options }; p.copyTitle()
  store.cacheNamespace = 'b'.repeat(32); namespaces.forEach(fn => fn(store.cacheNamespace))
  pending.success(); pending.complete(); assert.equal(p.data.recipe, null); assert.equal(p.data.notice, '')
})
test('public source page requires no membership login and copies only explicit fixed links', () => {
  const p = setup('legal/sources'); initialize = () => { throw new Error('must not log in for public license') }
  p.onLoad(); assert(p.data.meta.licenseText.includes('WITHOUT WARRANTY')); assert.equal(calls.length, 0)
  for (const key of ['__proto__', 'constructor', 'https://invalid.example', 'unknown']) p.copySource(source(key))
  assert.equal(calls.length, 0)
  p.copySource(source('dataset')); assert(calls[0][1].endsWith(p.data.meta.datasetCommit))
  p.copySource(source('upstream')); assert(calls[1][1].endsWith(p.data.meta.sourceVerificationCommit))
  let pending; clipboard = options => { pending = options }; p.copySource(source('dataset')); p.onUnload()
  pending.success(); pending.complete(); assert.equal(p.writesAfterUnload, 0)
})
test('routes and visible data disclosure use native controls and responsive theme styles', () => {
  const app = JSON.parse(read('miniprogram/app.json'))
  for (const route of Object.keys(definitions)) {
    assert(app.pages.includes('pages/' + route))
    const wxml = read('miniprogram/pages/' + route + '.wxml')
    const css = read('miniprogram/pages/' + route + '.wxss')
    assert(!wxml.includes('<web-view')); assert(!wxml.includes('<image')); assert(wxml.includes('navigateFromPage'))
    assert(css.includes('recipe-catalog.wxss'))
    for (const match of wxml.matchAll(/bind(?:tap|input|change)="(\w+)"/g)) assert.equal(typeof definitions[route][match[1]], 'function', route + ':' + match[1])
  }
  const css = read('miniprogram/styles/recipe-catalog.wxss')
  assert(css.includes('min-height: 48px')); assert(css.includes('overflow-wrap: anywhere'))
  assert(css.includes('font-size: 16px')); assert(!/#[\da-f]{3,8}\b/i.test(css))
  assert(!/position:\s*fixed|animation:/.test(css)); assert(read('miniprogram/app.wxss').includes('safe-area-inset-bottom'))
  const detail = read('miniprogram/pages/recipe-detail/recipe-detail.wxml')
  assert(!/wx:key="(?:index|tipIndex)"/.test(detail), 'native loop keys must refer to real record fields or primitive values')
  for (const text of ['item.amount', 'item.note', 'item.instruction', 'item.tips', 'recipe.tips', '未按你的就餐人数换算', '不加入采购']) assert(detail.includes(text))
  const sources = read('miniprogram/pages/legal/sources.wxml')
  for (const text of ['licenseText', 'datasetCommit', 'sourceVerificationCommit', '未知', '未使用', '不冒充']) {
    // The app says "没有使用" for exclusion; both phrases carry the same explicit boundary.
    assert(sources.includes(text) || (text === '未使用' && sources.includes('没有使用')))
  }
})
test('catalog has no hidden provider, personal-store or persistence path', () => {
  for (const file of ['miniprogram/services/recipe-catalog.js', 'miniprogram/utils/catalog-page.js',
    ...Object.keys(definitions).map(route => 'miniprogram/pages/' + route + '.js')]) {
    assert(!/user-store|ai-planner|setStorage|wx\.request|wx\.cloud|changeFavorite/.test(read(file)), file)
  }
})
