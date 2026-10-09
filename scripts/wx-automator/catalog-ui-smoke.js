'use strict'

// Native public-data fixture only. Never connects this development UI to real accounts.
const assert = require('node:assert/strict')
const path = require('node:path')
const { KIND, contents } = require('../build-catalog-ui-fixture')
const { PAGE_SIZE } = require('../../miniprogram/services/recipe-catalog')
const { createRun, finalizeRunReport, withAutomatorResponseTimeout, navigateAndAcquire,
  readAutomatorViewport, captureScreenshotWithRetry, sanitizeCode, sanitizeText, safeDisconnect } = require('./automation-runtime')
const LIST = '/pages/recipe-catalog/recipe-catalog'
const DETAIL = 'pages/recipe-detail/recipe-detail'
const SOURCES = 'pages/legal/sources'
const call = (stage, fn) => withAutomatorResponseTimeout(fn, { stage, timeoutMs: 10000 })

async function assertFixture(miniProgram, options = {}) {
  const timeoutMs = options.timeoutMs == null ? 20000 : options.timeoutMs
  const deadline = Date.now() + timeoutMs
  let marker
  do {
    marker = await call('FIXTURE_GUARD', () => miniProgram.evaluate(() => {
      const app = typeof getApp === 'function' ? getApp() : null
      if (!app) return { initializing: true }
      return { kind: app.globalData && app.globalData.catalogUiFixture,
        sourceHash: app.globalData && app.globalData.catalogUiSourceHash }
    }))
    if (!marker || marker.initializing !== true) break
    if (Date.now() >= deadline) throw Object.assign(new Error('Fixture app not initialized'), { code: 'FIXTURE_NOT_READY' })
    await new Promise(resolve => setTimeout(resolve, options.pollMs == null ? 250 : options.pollMs))
  } while (true)
  if (!marker || marker.kind !== KIND) throw Object.assign(new Error('Isolated fixture required'), { code: 'FIXTURE_REQUIRED' })
  if (marker.sourceHash !== contents().manifest.sourceHash) {
    throw Object.assign(new Error('Rebuild fixture for this public source revision'), { code: 'FIXTURE_SOURCE_STALE' })
  }
}
async function waitForNativePage(miniProgram, page) {
  // Page data can settle before native navigation chrome. Use the same 3s transition
  // allowance as the installed official SDK's changeRoute, then recheck the route.
  await call('NATIVE_TRANSITION_SETTLE', () => page.waitFor(3000))
  const visible = await call('CAPTURE_CURRENT_ROUTE', () => miniProgram.currentPage())
  if (!visible || visible.path !== page.path) {
    throw Object.assign(new Error('Page changed before capture'), { code: 'FIXTURE_CAPTURE_ROUTE_CHANGED' })
  }
}
async function assertPaginationState(page, records, visibleCount) {
  const ids = records.slice(0, visibleCount).map(item => item.id)
  const state = await call('PAGINATION_STATE', () => page.data())
  assert.equal(state.total, records.length)
  assert.equal(state.hasMore, visibleCount < records.length)
  assert.deepEqual(state.rows.map(item => item.id), ids)
  const nodes = await call('PAGINATION_NODES', () => page.$$('.catalog-row'))
  const renderedIds = []
  for (const node of nodes) renderedIds.push(await call('PAGINATION_NODE_ID', () => node.attribute('data-id')))
  assert.deepEqual(renderedIds, ids, 'rendered pagination must not omit, duplicate or reorder recipes')
}
async function runScenario(miniProgram, outputDir, record) {
  await assertFixture(miniProgram)
  const expected = require('../../miniprogram/data/recipe-catalog')
  async function current(route) {
    const expectedRoute = route.replace(/^\//, '')
    const deadline = Date.now() + 15000
    do {
      const page = await call('CURRENT_PAGE', () => miniProgram.currentPage())
      if (page && page.path === expectedRoute && !await call('LOADING', () => page.data('loading'))) {
        // A route can be reported before onShow. Do not type into a still-hidden page.
        if (expectedRoute === SOURCES || await call('PAGE_ACTIVE', () => page.callMethod('current'))) return page
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    throw Object.assign(new Error('Page not ready: ' + expectedRoute), { code: 'FIXTURE_PAGE_NOT_READY' })
  }
  async function element(page, selector) {
    const item = await call('FIND_CONTROL', () => page.$(selector))
    assert(item, 'missing control ' + selector)
    return item
  }
  async function tap(page, selector) { await call('TAP_CONTROL', async () => (await element(page, selector)).tap()) }
  async function tapAction(page, label) {
    const actions = await call('FIND_ACTIONS', () => page.$$('.catalog-action'))
    const matches = []
    for (const action of actions) {
      if ((await call('ACTION_LABEL', () => action.text())).trim() === label) matches.push(action)
    }
    assert.equal(matches.length, 1, 'one action with label ' + label)
    await call('TAP_NAMED_ACTION', () => matches[0].tap())
  }
  async function input(page, text) { await call('SEARCH_INPUT', async () => (await element(page, '#catalog-search')).input(text)) }
  async function data(page, key) { return call('PUBLIC_PAGE_DATA', () => page.data(key)) }
  async function settled(name, predicate) {
    const deadline = Date.now() + 5000
    do {
      if (await predicate()) return
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    throw Object.assign(new Error(name + ' did not settle'), { code: 'FIXTURE_RENDER_NOT_SETTLED' })
  }
  async function checkLayout(page, name, selectors) {
    const viewport = await readAutomatorViewport(miniProgram, page)
    const controls = []
    for (const selector of selectors) {
      const item = await element(page, selector)
      const size = await call('CONTROL_SIZE', () => item.size())
      const offset = await call('CONTROL_OFFSET', () => item.offset())
      const width = Number(size.width), height = Number(size.height), left = Number(offset.left)
      assert(Number.isFinite(left) && width >= 48 && height >= 48, 'touch area ' + selector)
      assert(left >= -1 && left + width <= viewport.windowWidth + 1, 'horizontal overflow ' + selector)
      controls.push({ selector, width, height, left })
    }
    record(name, { viewport, controls })
  }
  async function capture(page, name) {
    try {
      await waitForNativePage(miniProgram, page)
      await captureScreenshotWithRetry(miniProgram, path.join(outputDir, name + '.png'), {
        expectedRoute: page.path, timeoutMs: 10000,
      })
      record(name, { screenshot: 'captured', transitionSettleMs: 3000 })
    } catch (error) {
      record(name, { screenshot: 'unverified', errorCode: sanitizeCode(error.code || 'CAPTURE_FAILED') })
    }
  }

  await navigateAndAcquire(miniProgram, LIST)
  let page = await current(LIST)
  assert.equal(await data(page, 'error'), '')
  let visibleCount = Math.min(PAGE_SIZE, expected.length)
  await settled('initial batch rendering', async () => (await call('RENDERED_ROWS', () => page.$$('.catalog-row'))).length === visibleCount)
  await assertPaginationState(page, expected, visibleCount)
  record('initial-public-catalog', { count: expected.length, visibleCount })
  await checkLayout(page, 'catalog-layout', ['.catalog-back', '#catalog-search', '.catalog-picker', '.catalog-row'])
  await capture(page, 'catalog-initial')

  let pagesLoaded = 1
  while (visibleCount < expected.length) {
    await tapAction(page, '查看更多菜谱')
    visibleCount = Math.min(visibleCount + PAGE_SIZE, expected.length)
    await settled('next batch rendering', async () => (await call('RENDERED_ROWS', () => page.$$('.catalog-row'))).length === visibleCount)
    await assertPaginationState(page, expected, visibleCount)
    pagesLoaded++
  }
  record('pagination-complete-without-duplicates', { pagesLoaded, visibleCount })
  // Open the final row, including a recipe that was not in the first batch.
  const finalRow = (await call('FINAL_ROWS', () => page.$$('.catalog-row'))).at(-1)
  assert(finalRow)
  await call('OPEN_FINAL_ROW', () => finalRow.tap())
  page = await current(DETAIL)
  assert.deepEqual(await data(page, 'recipe'), expected.at(-1))
  await tap(page, '.catalog-back')
  page = await current(LIST)
  await assertPaginationState(page, expected, expected.length)
  record('final-row-detail-and-return-preserve-pagination', {})

  await input(page, '豆腐 葱')
  await settled('AND query state', async () => await data(page, 'query') === '豆腐 葱')
  assert((await data(page, 'total')) > 0)
  const selectedId = (await data(page, 'rows'))[0].id
  await settled('filtered rendered rows', async () => (await call('FIRST_RENDERED_ID', async () =>
    (await element(page, '.catalog-row')).attribute('data-id'))) === selectedId)
  record('literal-and-search', { count: await data(page, 'total') })
  await tap(page, '.catalog-row')
  page = await current(DETAIL)
  const selected = expected.find(item => item.id === selectedId)
  assert.deepEqual(await data(page, 'recipe'), selected)
  assert.equal((await call('INGREDIENT_NODES', () => page.$$('.catalog-ingredient'))).length, selected.ingredients.length)
  assert.equal((await call('STEP_NODES', () => page.$$('.catalog-step'))).length, selected.steps.length)
  record('detail-full-content', { ingredients: selected.ingredients.length, steps: selected.steps.length })
  await checkLayout(page, 'detail-layout', ['.catalog-back', '.catalog-action'])
  await capture(page, 'catalog-detail')
  await tap(page, '.catalog-back')
  page = await current(LIST)
  assert.equal(await data(page, 'query'), '豆腐 葱')
  assert.equal((await data(page, 'rows'))[0].id, selectedId)
  record('return-preserves-search', {})

  await input(page, '不在库里的测试食材')
  await settled('empty query state', async () => await data(page, 'query') === '不在库里的测试食材' && await data(page, 'total') === 0)
  await settled('empty rendered rows', async () => (await call('EMPTY_ROWS', () => page.$$('.catalog-row'))).length === 0)
  await capture(page, 'catalog-empty')
  record('no-results', {})
  await tapAction(page, '清除搜索与筛选')
  await settled('clear search state', async () => await data(page, 'total') === expected.length)
  await settled('clear search batch rendering', async () => (await call('RENDERED_ROWS', () => page.$$('.catalog-row'))).length === Math.min(PAGE_SIZE, expected.length))
  await assertPaginationState(page, expected, Math.min(PAGE_SIZE, expected.length))
  assert.equal(await data(page, 'query'), '')
  assert.equal(await data(page, 'categoryIndex'), 0)
  assert.equal(await data(page, 'total'), expected.length)
  record('clear-search', {})

  const categories = await data(page, 'categories')
  const categoryIndex = categories.indexOf('早餐')
  assert(categoryIndex > 0)
  await call('PICKER_CHANGE_EVENT', async () => (await element(page, 'picker')).trigger('change', { value: categoryIndex }))
  await settled('selected category state', async () => await data(page, 'categoryIndex') === categoryIndex)
  assert((await data(page, 'rows')).every(row => row.category === '早餐'))
  assert.equal(await data(page, 'total'), expected.filter(row => row.category === '早餐').length)
  record('category-change-event', { nativePickerGestureTested: false })
  await settled('category rows rendering', async () => (await call('CATEGORY_ROWS', () => page.$$('.catalog-row'))).length === Math.min(PAGE_SIZE, expected.filter(row => row.category === '早餐').length))
  await tapAction(page, '清除搜索与筛选')
  await settled('category clear state', async () => await data(page, 'categoryIndex') === 0 && await data(page, 'total') === expected.length)
  await settled('category clear batch rendering', async () => (await call('RENDERED_ROWS', () => page.$$('.catalog-row'))).length === Math.min(PAGE_SIZE, expected.length))
  await assertPaginationState(page, expected, Math.min(PAGE_SIZE, expected.length))
  await tapAction(page, '开源与数据来源')
  page = await current(SOURCES)
  const meta = await data(page, 'meta')
  assert.equal(meta.count, expected.length)
  const bodyText = await call('SOURCE_TEXT', async () => (await element(page, '.catalog-page')).text())
  assert(bodyText.includes(meta.licenseText.trim()))
  assert(bodyText.includes(meta.datasetCommit) && bodyText.includes(meta.sourceVerificationCommit))
  record('license-and-provenance-rendered', {})
  await checkLayout(page, 'sources-layout', ['.catalog-back', '.catalog-action'])
  await capture(page, 'catalog-sources')
  await tap(page, '.catalog-back')
  page = await current(LIST)
  assert.equal(await data(page, 'total'), expected.length)
  record('sources-return', {})
  await navigateAndAcquire(miniProgram, '/' + DETAIL + '?id=unknown_fixture_recipe')
  page = await current(DETAIL)
  // DevTools can omit a top-level null data-path result; inspect the enclosing object.
  assert.equal((await data(page)).recipe, null)
  assert.match(await data(page, 'error'), /暂未收录/)
  record('unknown-recipe-recovery', {})
  await navigateAndAcquire(miniProgram, LIST)
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No arguments accepted')
  const run = createRun('catalog-native-fixture', path.resolve(__dirname, '../../.local/automator/catalog-ui'))
  const checks = []
  let miniProgram, errorCode = '', errorMessage = ''
  try {
    miniProgram = await require('./automator-client').connect()
    await runScenario(miniProgram, run.outputDir, (name, evidence) => {
      checks.push({ name, ...evidence }); console.log('CATALOG_NATIVE_CHECK ' + name)
    })
  } catch (error) {
    errorCode = sanitizeCode(error.code || 'NATIVE_CHECK_FAILED')
    errorMessage = sanitizeText(error.message, 700)
    console.error(errorCode + ': ' + errorMessage)
  }
  finally { if (!await safeDisconnect(miniProgram)) errorCode = 'DISCONNECT_FAILED' }
  const { reportPath } = finalizeRunReport(run, {
    fixtureHash: contents().manifest.fixtureHash, fixtureOnly: true,
    status: errorCode ? 'failed' : 'scenario-passed', errorCode, errorMessage, checks,
    screenshotsComplete: checks.filter(c => c.screenshot === 'captured').length === 4,
    cloudTested: false, realIdentityTested: false, androidIosTested: false,
    clipboardTested: false, keyboardAndPickerGestureTested: false,
  })
  console.log(JSON.stringify({ reportPath, errorCode, checks: checks.length }))
  if (errorCode) process.exitCode = 1
}
if (require.main === module) main().catch(() => { console.error('CATALOG_NATIVE_RUN_FAILED'); process.exitCode = 1 })
module.exports = { assertFixture, waitForNativePage, assertPaginationState, runScenario }
