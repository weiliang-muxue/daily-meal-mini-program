'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { KIND, contents } = require('../build-library-ui-fixture')
const { nativeBoolean } = require('./planner-ui-smoke')
const { createRun, finalizeRunReport, withAutomatorResponseTimeout, navigateAndAcquire,
  readAutomatorViewport, captureScreenshotWithRetry, sanitizeCode, sanitizeText,
  subscribeAutomatorDiagnostics, classifyAutomatorDiagnostic, cleanupAutomatorSession } = require('./automation-runtime')
const HOME = 'pages/plan/plan', LIBRARY = 'pages/recipe-library/recipe-library'
const call = (stage, fn) => withAutomatorResponseTimeout(fn, { stage, timeoutMs: 10000 })
async function guard(miniProgram) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const marker = await call('LIBRARY_FIXTURE_GUARD', () => miniProgram.evaluate(() => {
      const app = typeof getApp === 'function' ? getApp() : null
      return app ? { kind: app.globalData && app.globalData.libraryUiFixture,
        sourceHash: app.globalData && app.globalData.libraryUiSourceHash } : { initializing: true }
    }))
    if (marker && marker.initializing === true) { await new Promise(resolve => setTimeout(resolve, 250)); continue }
    if (!marker || marker.kind !== KIND) throw Object.assign(Error('Isolated library fixture required'), { code: 'FIXTURE_REQUIRED' })
    if (marker.sourceHash !== contents().manifest.sourceHash) throw Object.assign(Error('Stale public fixture'), { code: 'FIXTURE_SOURCE_STALE' })
    return
  }
  throw Object.assign(Error('Fixture not initialized'), { code: 'FIXTURE_NOT_READY' })
}
async function waitRemovalSettled(miniProgram, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs
  do {
    const settled = await call('REMOVAL_CALLBACK_FINISHED', () => miniProgram.evaluate(() => {
      const page = getCurrentPages().slice(-1)[0]
      return Boolean(page && page.route === 'pages/recipe-library/recipe-library'
        && page.active === true && !page.unloaded && !page.identityChanged
        && page.removePrompt === null && page.data.busy === false)
    }))
    if (settled === true) return
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() <= deadline)
  throw Object.assign(Error('Native modal command did not finish the removal interaction'), { code: 'NATIVE_MODAL_NO_EFFECT' })
}
async function runScenario(miniProgram, directory, record) {
  await guard(miniProgram)
  await call('RESET_FICTIONAL_MEMORY', () => miniProgram.evaluate(() => getApp().libraryUiTest.reset()))
  const snapshot = () => call('FICTIONAL_SNAPSHOT', () => miniProgram.evaluate(() => getApp().libraryUiTest.snapshot()))
  const before = await snapshot()
  // Read the object because this SDK maps a null selected path to undefined.
  // The fixture guard above is mandatory before any page-data access.
  const data = (page, key) => call('PAGE_DATA', async () => (await page.data())[key])
  async function settled(name, predicate) {
    const deadline = Date.now() + 10000
    do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)) } while (Date.now() < deadline)
    throw Error(name + ' did not settle')
  }
  async function current(route) {
    let page
    await settled('route ' + route, async () => {
      page = await call('CURRENT_PAGE', () => miniProgram.currentPage())
      return page && page.path === route && !await data(page, 'loading')
    })
    return page
  }
  async function control(page, selector) { const item = await call('CONTROL', () => page.$(selector)); assert(item, selector); return item }
  async function tap(page, selector) { await call('TAP', async () => (await control(page, selector)).tap()) }
  async function input(page, value) { await call('INPUT', async () => (await control(page, '#recipe-search')).input(value)) }
  async function button(page, label) {
    const buttons = await call('BUTTONS', () => page.$$('button'))
    for (const item of buttons) if ((await call('BUTTON_TEXT', () => item.text())).trim() === label) return item
    throw Error('Button not found: ' + label)
  }
  async function tapText(page, label) { await call('BUTTON_TAP', async () => (await button(page, label)).tap()) }
  async function capture(page, name, bottom = false) {
    await call('SCROLL_CAPTURE', () => miniProgram.pageScrollTo(bottom ? 100000 : 0))
    await call('SETTLE_CAPTURE', () => page.waitFor(3000))
    assert.equal((await call('CAPTURE_ROUTE', () => miniProgram.currentPage())).path, page.path)
    await captureScreenshotWithRetry(miniProgram, path.join(directory, name + '.png'), { expectedRoute: page.path, timeoutMs: 10000 })
    record(name, { screenshot: 'captured' })
  }
  const disabled = async item => nativeBoolean(await call('DISABLED', () => item.property('disabled')))
  async function review(page) {
    await tap(page, '.review-label')
    await settled('explicit review', async () => await data(page, 'reviewed') === true)
  }
  async function selectFavorite(page) {
    await tap(page, '.recipe-row')
    await settled('selected favorite', async () => Boolean(await data(page, 'selected')))
  }
  await navigateAndAcquire(miniProgram, '/' + HOME)
  let home = await current(HOME)
  await tap(home, '.fixture-open')
  let page = await current(LIBRARY)
  assert.equal(await data(page, 'count'), 0)
  assert.equal(await data(page, 'error'), '')
  assert.equal((await call('NO_EMPTY_ROWS', () => page.$$('.recipe-row'))).length, 0)
  assert.deepEqual(await snapshot(), before)
  await capture(page, 'library-empty')
  await tap(page, '.page-navigation')
  home = await current(HOME)
  await tap(home, '.fixture-capture')
  page = await current(LIBRARY)
  assert.equal((await data(page, 'capture')).title, '虚构早餐 1')
  assert.deepEqual(await snapshot(), before)
  record('capture-preview-read-only', {})
  await tapText(page, '确认收藏')
  await settled('captured', async () => await data(page, 'count') === 1 && !await data(page, 'busy'))
  const saved = await snapshot()
  assert.equal(saved.writes, 1)
  assert.deepEqual(saved.data.activePlan, before.data.activePlan)
  assert.deepEqual(saved.data.mealOverrides, {})
  assert.equal(await data(page, 'capture'), null)
  assert((await data(page, 'notice')).includes('已收藏'))
  record('explicit-capture-independent-copy', {})
  const viewport = await readAutomatorViewport(miniProgram, page)
  for (const selector of ['.page-navigation', '#recipe-search', '.recipe-row']) {
    const item = await control(page, selector), size = await call('SIZE', () => item.size()), offset = await call('OFFSET', () => item.offset())
    assert(Number(size.height) >= 48 && Number(size.width) >= 48, selector + ' touch area')
    assert(Number(offset.left) >= -1 && Number(offset.left) + Number(size.width) <= viewport.windowWidth + 1, selector + ' horizontal overflow')
  }
  record('favorites-touch-layout', { viewport })
  await input(page, '不存在的虚构菜')
  await settled('empty search', async () => (await data(page, 'filtered')).length === 0)
  assert.equal(await data(page, 'count'), 1)
  await input(page, '虚构鸡蛋')
  await settled('ingredient search', async () => (await data(page, 'filtered')).length === 1)
  await selectFavorite(page)
  assert.equal((await data(page, 'selected')).recipe.servings, 2)
  assert.deepEqual(await snapshot(), saved)
  record('name-and-ingredient-search-no-writes', {})
  // This explicit SDK change tests the picker binding, not the physical wheel.
  await call('PICKER_CHANGE_EVENT', async () => (await control(page, 'picker')).trigger('change', { value: 1 }))
  await settled('second target', async () => await data(page, 'targetIndex') === 1)
  await tapText(page, '预览餐食与采购变化')
  await settled('preview', async () => Boolean(await data(page, 'preview')))
  assert.equal(await data(page, 'reviewed'), false)
  assert.equal(await disabled(await button(page, '确认替换这一餐')), true)
  assert.deepEqual(await snapshot(), saved)
  assert.equal((await data(page, 'preview')).checkedReset, 1)
  await review(page)
  assert.equal(await disabled(await button(page, '确认替换这一餐')), false)
  await capture(page, 'library-reuse-preview', true)
  await tapText(page, '取消，保留原餐')
  await settled('cancelled preview', async () => await data(page, 'preview') === null)
  assert.equal(await data(page, 'preview'), null)
  assert.equal(await data(page, 'reviewed'), false)
  assert.deepEqual(await snapshot(), saved)
  record('review-required-cancel-keeps-current-meals', {})
  await tapText(page, '预览餐食与采购变化')
  await settled('preview for failure', async () => Boolean(await data(page, 'preview')))
  await review(page)
  await call('FAIL_FICTIONAL_SAVE', () => miniProgram.evaluate(() => getApp().libraryUiTest.failSave(true)))
  await tapText(page, '确认替换这一餐')
  await settled('failed apply', async () => !await data(page, 'busy') && Boolean(await data(page, 'error')))
  assert.deepEqual(await snapshot(), saved)
  assert.equal(await data(page, 'preview'), null)
  assert.equal(await data(page, 'reviewed'), false)
  await capture(page, 'library-apply-error')
  record('failure-preserves-original-and-requires-new-preview', {})
  await call('ALLOW_FICTIONAL_SAVE', () => miniProgram.evaluate(() => getApp().libraryUiTest.failSave(false)))
  await tapText(page, '刷新核对')
  await settled('refreshed', async () => !await data(page, 'loading') && !await data(page, 'error'))
  // Refresh deliberately resets target selection. Select the intended date again.
  await call('PICKER_CHANGE_EVENT', async () => (await control(page, 'picker')).trigger('change', { value: 1 }))
  await tapText(page, '预览餐食与采购变化')
  await settled('preview retry', async () => Boolean(await data(page, 'preview')))
  await review(page)
  await tapText(page, '确认替换这一餐')
  await settled('applied', async () => !await data(page, 'busy') && (await data(page, 'notice')).includes('已安排'))
  const applied = await snapshot()
  assert.equal(applied.writes, 2)
  assert.deepEqual(applied.data.activePlan, before.data.activePlan)
  assert.deepEqual(applied.data.favoriteRecipes, saved.data.favoriteRecipes)
  assert.deepEqual(Object.keys(applied.data.mealOverrides), ['fixture-meal-1'])
  assert.deepEqual(applied.data.checkedShoppingIds, ['fixture-eggs'])
  record('confirmed-reuse-only-one-meal-preserves-favorite-and-unrelated-check', {})
  await tap(page, '.page-navigation')
  home = await current(HOME); await tap(home, '.fixture-open'); page = await current(LIBRARY)
  assert.equal(await data(page, 'count'), 1)
  await selectFavorite(page)
  assert((await data(page, 'targets'))[1].label.includes('虚构早餐 1'))
  assert.deepEqual(await snapshot(), applied)
  record('memory-reentry-keeps-favorite-and-applied-meal', {})
  await call('FICTIONAL_OFFLINE', () => miniProgram.evaluate(() => getApp().libraryUiTest.offline(true)))
  await tap(page, '.page-navigation')
  home = await current(HOME); await tap(home, '.fixture-open'); page = await current(LIBRARY)
  assert.equal(await data(page, 'offline'), true)
  await selectFavorite(page)
  assert.equal(await disabled(await button(page, '预览餐食与采购变化')), true)
  assert.equal(await disabled(await button(page, '移除这条收藏')), true)
  assert.deepEqual(await snapshot(), applied)
  await capture(page, 'library-offline-read-only')
  record('offline-keeps-readable-copy-and-disables-mutations', {})
  await call('FICTIONAL_ONLINE', () => miniProgram.evaluate(() => getApp().libraryUiTest.offline(false)))
  await tapText(page, '刷新核对')
  await settled('online refreshed', async () => !await data(page, 'loading') && !await data(page, 'offline'))
  assert.equal(await disabled(await button(page, '预览餐食与采购变化')), false)
  assert.deepEqual(await snapshot(), applied)
  record('refresh-restores-actions-without-writing', {})

  // Use real system dialogs. Never mock showModal or invoke its callbacks.
  async function removeModal(confirmed) {
    await tapText(page, '移除这条收藏')
    await settled('removal prompt opened', () => call('REMOVAL_PROMPT_PENDING', () => miniProgram.evaluate(() => {
      const page = getCurrentPages().slice(-1)[0]
      return Boolean(page && page.route === 'pages/recipe-library/recipe-library'
        && page.active === true && page.removePrompt && page.data.busy === true)
    })))
    await call('NATIVE_REMOVAL_MODAL', () => confirmed
      ? miniProgram.native().confirmModal() : miniProgram.native().cancelModal())
    await waitRemovalSettled(miniProgram)
    assert.equal(await data(page, 'error'), '')
  }
  await removeModal(false)
  assert.deepEqual(await snapshot(), applied, 'native cancellation must preserve all fictional data')
  assert.equal(await data(page, 'count'), 1)
  record('native-removal-cancel-preserves-favorite-and-meals', {})
  await removeModal(true)
  const removed = await snapshot()
  assert.equal(removed.writes, applied.writes + 1)
  assert.deepEqual(removed.data, { ...applied.data, favoriteRecipes: [], stateRevision: applied.data.stateRevision + 1 })
  assert.equal(await data(page, 'count'), 0)
  record('native-removal-confirm-only-removes-favorite-copy', {})
}
async function main() {
  if (process.argv.length !== 2) throw Error('No arguments accepted')
  const run = createRun('recipe-library-native-fixture', path.resolve(__dirname, '../../.local/automator/library-ui'))
  const checks = [], diagnostics = []; let miniProgram, unsubscribe, errorCode = '', errorMessage = ''
  try {
    miniProgram = await require('./automator-client').connect()
    await guard(miniProgram)
    unsubscribe = await subscribeAutomatorDiagnostics(miniProgram, {
      console(entry) { const d = classifyAutomatorDiagnostic(entry); if (d.observed) diagnostics.push(d) },
      exception(entry) { diagnostics.push({ blocking: true, level: 'exception',
        text: sanitizeText(entry && (entry.message || entry.description || entry), 700) }) },
    })
    await runScenario(miniProgram, run.outputDir, (name, evidence) => { checks.push({ name, ...evidence }); console.log('LIBRARY_NATIVE_CHECK ' + name) })
    assert.equal(diagnostics.filter(item => item.blocking).length, 0, 'blocking diagnostics observed during scenario')
  } catch (error) { errorCode = sanitizeCode(error.code || 'NATIVE_CHECK_FAILED'); errorMessage = sanitizeText(error.message, 700) }
  finally { if (!(await cleanupAutomatorSession(miniProgram, unsubscribe)).ok) errorCode = 'SESSION_CLEANUP_FAILED' }
  const { reportPath } = finalizeRunReport(run, { fixtureHash: contents().manifest.fixtureHash, fixtureOnly: true,
    status: errorCode === 'NATIVE_MODAL_NO_EFFECT' ? 'needs-native-interaction' : errorCode ? 'failed' : 'scenario-passed', errorCode, errorMessage, checks, diagnostics,
    cloudTested: false, persistenceTested: false, realIdentityTested: false, androidIosTested: false,
    nativeKeyboardGestureTested: false, nativePickerGestureTested: false,
    removeModalTested: checks.some(item => item.name === 'native-removal-confirm-only-removes-favorite-copy'),
    catalogPageTested: false, productionStoreTested: false })
  console.log(JSON.stringify({ reportPath, errorCode, errorMessage, checks: checks.length }))
  if (errorCode) process.exitCode = 1
}
if (require.main === module) main().catch(() => { console.error('LIBRARY_UI_RUN_FAILED'); process.exitCode = 1 })
module.exports = { guard, runScenario, waitRemovalSettled }
