'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { KIND, contents } = require('../build-meal-edit-ui-fixture')
const { createRun, finalizeRunReport, withAutomatorResponseTimeout, navigateAndAcquire,
  readAutomatorViewport, captureScreenshotWithRetry, sanitizeCode, sanitizeText, safeDisconnect } = require('./automation-runtime')
const HOME = 'pages/plan/plan', EDIT = 'pages/meal-edit/meal-edit'
const call = (stage, fn) => withAutomatorResponseTimeout(fn, { stage, timeoutMs: 10000 })
async function guard(miniProgram) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const marker = await call('MEAL_FIXTURE_GUARD', () => miniProgram.evaluate(() => {
      const app = typeof getApp === 'function' ? getApp() : null
      return app ? { kind: app.globalData && app.globalData.mealEditUiFixture,
        sourceHash: app.globalData && app.globalData.mealEditUiSourceHash } : { initializing: true }
    }))
    if (marker && marker.initializing === true) { await new Promise(resolve => setTimeout(resolve, 250)); continue }
    if (!marker || marker.kind !== KIND) throw Object.assign(Error('Isolated meal fixture required'), { code: 'FIXTURE_REQUIRED' })
    if (marker.sourceHash !== contents().manifest.sourceHash) throw Object.assign(Error('Stale public fixture'), { code: 'FIXTURE_SOURCE_STALE' })
    return
  }
  throw Object.assign(Error('Fixture not initialized'), { code: 'FIXTURE_NOT_READY' })
}
async function waitModalCancelled(miniProgram, flag, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs
  do {
    const finished = await call('MODAL_CALLBACK_FINISHED', () => miniProgram.evaluate(pendingFlag => {
      const page = getCurrentPages().slice(-1)[0]
      return Boolean(page && page.route === 'pages/meal-edit/meal-edit' && page[pendingFlag] === false)
    }, flag))
    if (finished === true) return
    if (Date.now() >= deadline) break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() <= deadline)
  throw Object.assign(Error('Native cancel returned without a verified modal callback'), { code: 'NATIVE_MODAL_NO_EFFECT' })
}
const waitDiscardCancelled = (miniProgram, options) => waitModalCancelled(miniProgram, 'discardPromptPending', options)
const waitResetCancelled = (miniProgram, options) => waitModalCancelled(miniProgram, 'resetPromptPending', options)
async function runScenario(miniProgram, directory, record) {
  await guard(miniProgram)
  // These controls exist only in the generated memory fixture. Never load a real store.
  await call('RESET_FICTIONAL_MEMORY', () => miniProgram.evaluate(() => getApp().mealEditUiTest.reset()))
  const snapshot = () => call('FICTIONAL_SNAPSHOT', () => miniProgram.evaluate(() => getApp().mealEditUiTest.snapshot()))
  const before = await snapshot()
  const data = (page, key) => call('PAGE_DATA', () => page.data(key))
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
  async function control(page, selector) {
    const result = await call('CONTROL', () => page.$(selector)); assert(result, selector); return result
  }
  async function tap(page, selector) { await call('TAP', async () => (await control(page, selector)).tap()) }
  async function input(page, selector, value) { await call('INPUT', async () => (await control(page, selector)).input(value)) }
  async function capture(page, name, bottom = false) {
    await call('SCROLL_CAPTURE', () => miniProgram.pageScrollTo(bottom ? 100000 : 0))
    await call('SETTLE_CAPTURE', () => page.waitFor(3000))
    assert.equal((await call('CAPTURE_ROUTE', () => miniProgram.currentPage())).path, page.path)
    await captureScreenshotWithRetry(miniProgram, path.join(directory, name + '.png'), { expectedRoute: page.path, timeoutMs: 10000 })
    record(name, { screenshot: 'captured' })
  }
  async function openMeal() {
    const home = await current(HOME); await tap(home, '.fixture-open'); return current(EDIT)
  }
  await navigateAndAcquire(miniProgram, '/' + HOME)
  let page = await openMeal()
  assert.equal(await data(page, 'error'), '')
  assert.equal(await data(page, 'canSyncIngredients'), true)
  assert.equal((await data(page, 'ingredientRows')).length, 2)
  const viewport = await readAutomatorViewport(miniProgram, page)
  for (const selector of ['.page-navigation', '#ingredient-name-0', '#ingredient-quantity-0', '#ingredient-unit-0', '#meal-title-input', '#meal-method-input', '#meal-tag-input', '.ingredient-remove', '.ingredient-add', '.save']) {
    const item = await control(page, selector), size = await call('SIZE', () => item.size()), offset = await call('OFFSET', () => item.offset())
    assert(Number(size.height) >= 48 && Number(size.width) >= 48, selector + ' touch area')
    assert(Number(offset.left) >= -1 && Number(offset.left) + Number(size.width) <= viewport.windowWidth + 1, selector + ' horizontal overflow')
  }
  record('original-and-touch-layout', { viewport })
  for (const selector of ['#meal-method-input', '#meal-tag-input']) {
    const item = await control(page, selector)
    assert.equal(await call('TEXTAREA_AUTO_HEIGHT', () => item.property('autoHeight')), false)
    assert(Number((await call('TEXTAREA_SIZE', () => item.size())).height) >= 80, 'multi-line editor collapsed: ' + selector)
  }
  const multiline = '第一行虚构步骤\n第二行虚构步骤\n第三行虚构步骤'
  await input(page, '#meal-method-input', multiline)
  await settled('multiline draft', async () => (await data(page, 'form')).method === multiline)
  await input(page, '#meal-method-input', before.data.activePlan.days[0].meals[0].method)
  await settled('restored method', async () => (await data(page, 'form')).method === before.data.activePlan.days[0].meals[0].method)
  record('textarea-boolean-height-and-multiline-input', {})
  await capture(page, 'meal-edit-initial')
  await tap(page, '.ingredient-add')
  await settled('added row', async () => (await data(page, 'ingredientRows')).length === 3)
  const remove = await call('REMOVE_CONTROLS', () => page.$$('.ingredient-remove'))
  await call('REMOVE_NEW_ROW', () => remove[2].tap())
  await settled('removed row', async () => (await data(page, 'ingredientRows')).length === 2)
  assert.deepEqual(await snapshot(), before)
  record('add-remove-before-save-is-read-only', {})
  await input(page, '#ingredient-quantity-0', '')
  await tap(page, '.save')
  await settled('invalid quantity', async () => Boolean(await data(page, 'inlineError')))
  assert.equal(await data(page, 'previewing'), false)
  assert.deepEqual(await snapshot(), before)
  record('invalid-quantity-preserves-original', {})
  await input(page, '#ingredient-quantity-0', '80')
  await tap(page, '.save')
  await settled('preview', async () => await data(page, 'previewing') === true)
  assert.deepEqual(await data(page, 'previewChanges'), [{ id: 'fixture-oats', name: '虚构燕麦', before: '100 g', after: '140 g' }])
  assert.equal(await data(page, 'previewResetCount'), 1)
  assert.deepEqual(await snapshot(), before)
  record('preview-shopping-delta-read-only', {})
  await capture(page, 'meal-edit-preview', true)
  await tap(page, '.preview-card .reset')
  await settled('cancel preview', async () => await data(page, 'previewing') === false)
  assert.equal(String((await data(page, 'ingredientRows'))[0].quantity), '80')
  assert.deepEqual(await snapshot(), before)
  record('cancel-preview-preserves-draft-and-original', {})
  await tap(page, '.save')
  await settled('preview again', async () => await data(page, 'previewing') === true)
  await call('FAIL_FICTIONAL_SAVE', () => miniProgram.evaluate(() => getApp().mealEditUiTest.failSave(true)))
  await tap(page, '.preview-card .save')
  await settled('save failure', async () => !await data(page, 'saving') && Boolean(await data(page, 'inlineError')))
  assert.deepEqual(await snapshot(), before)
  assert.equal(String((await data(page, 'ingredientRows'))[0].quantity), '80')
  record('failed-save-keeps-draft-and-original', {})
  await capture(page, 'meal-edit-save-error', true)
  await call('ALLOW_FICTIONAL_SAVE', () => miniProgram.evaluate(() => getApp().mealEditUiTest.failSave(false)))
  await tap(page, '.preview-card .save')
  await current(HOME)
  const after = await snapshot()
  assert.equal(after.writes, 1)
  assert.deepEqual(after.data.activePlan, before.data.activePlan)
  assert.deepEqual(after.data.checkedShoppingIds, ['fixture-eggs'])
  assert.deepEqual(Object.keys(after.data.mealOverrides), ['fixture-meal-0'])
  assert.equal(after.data.mealOverrides['fixture-meal-0'].ingredientItems[0].quantity, 80)
  record('confirm-saves-once-keeps-other-day-and-unaffected-check', {})
  page = await openMeal()
  assert.equal(await data(page, 'hasOverride'), true)
  assert.equal((await data(page, 'ingredientRows'))[0].quantity, 80)
  assert.equal(await data(page, 'formDirty'), false)
  await tap(page, '.page-navigation')
  await current(HOME)
  assert.deepEqual(await snapshot(), after)
  record('reopen-restores-saved-edit-and-clean-back', {})

  // Exercise actual native dialogs; never mock showModal or its callbacks here.
  async function modal(confirmed) {
    await call('SETTLE_NATIVE_MODAL', () => page.waitFor(500))
    await call(confirmed ? 'CONFIRM_NATIVE_MODAL' : 'CANCEL_NATIVE_MODAL', () => confirmed
      ? miniProgram.native().confirmModal() : miniProgram.native().cancelModal())
  }
  page = await openMeal()
  const draftTitle = '尚未保存的虚构餐名'
  await input(page, '#meal-title-input', draftTitle)
  await settled('dirty title', async () => await data(page, 'formDirty') === true)
  await tap(page, '.page-navigation')
  await modal(false)
  await waitDiscardCancelled(miniProgram)
  await current(EDIT)
  assert.equal((await data(page, 'form')).title, draftTitle)
  assert.equal(await data(page, 'formDirty'), true)
  assert.deepEqual(await snapshot(), after)
  record('native-discard-cancel-keeps-draft-and-saved-override', {})
  await tap(page, '.page-navigation')
  await modal(true)
  await current(HOME)
  assert.deepEqual(await snapshot(), after)
  page = await openMeal()
  assert.notEqual((await data(page, 'form')).title, draftTitle)
  assert.equal((await data(page, 'ingredientRows'))[0].quantity, 80)
  assert.equal(await data(page, 'formDirty'), false)
  record('native-discard-confirm-drops-only-unsaved-draft', {})
  await tap(page, '.reset')
  await modal(false)
  await waitResetCancelled(miniProgram)
  await current(EDIT)
  assert.equal(await data(page, 'hasOverride'), true)
  assert.deepEqual(await snapshot(), after)
  record('native-reset-cancel-keeps-saved-override', {})
  await call('FAIL_FICTIONAL_RESET', () => miniProgram.evaluate(() => getApp().mealEditUiTest.failSave(true)))
  await tap(page, '.reset')
  await modal(true)
  await settled('reset failure', async () => !await data(page, 'resetting') && Boolean(await data(page, 'inlineError')))
  assert.equal(await data(page, 'hasOverride'), true)
  assert.equal((await data(page, 'ingredientRows'))[0].quantity, 80)
  assert.deepEqual(await snapshot(), after)
  record('native-reset-failure-keeps-saved-override', {})
  await capture(page, 'meal-edit-reset-error', true)
  await call('ALLOW_FICTIONAL_RESET', () => miniProgram.evaluate(() => getApp().mealEditUiTest.failSave(false)))
  await tap(page, '.reset')
  await modal(true)
  await current(HOME)
  const restored = await snapshot()
  assert.equal(restored.writes, 2)
  assert.deepEqual(restored.data.activePlan, before.data.activePlan)
  assert.deepEqual(restored.data.mealOverrides, {})
  assert.deepEqual(restored.data.checkedShoppingIds, ['fixture-eggs'])
  record('native-reset-confirm-restores-target-and-keeps-unrelated-state', {})
  page = await openMeal()
  assert.equal(await data(page, 'hasOverride'), false)
  assert.equal((await data(page, 'ingredientRows'))[0].quantity, 40)
  assert.equal(await data(page, 'formDirty'), false)
  await tap(page, '.page-navigation')
  await current(HOME)
  assert.deepEqual(await snapshot(), restored)
  record('reopen-restored-base-with-no-spurious-dirty-state', {})
}
async function main() {
  if (process.argv.length !== 2) throw Error('No arguments accepted')
  const run = createRun('meal-edit-native-fixture', path.resolve(__dirname, '../../.local/automator/meal-edit-ui'))
  const checks = []; let miniProgram, errorCode = '', errorMessage = ''
  try {
    miniProgram = await require('./automator-client').connect()
    await runScenario(miniProgram, run.outputDir, (name, evidence) => {
      checks.push({ name, ...evidence }); console.log('MEAL_EDIT_NATIVE_CHECK ' + name)
    })
  } catch (error) { errorCode = sanitizeCode(error.code || 'NATIVE_CHECK_FAILED'); errorMessage = sanitizeText(error.message, 700) }
  finally { if (!await safeDisconnect(miniProgram)) errorCode = 'DISCONNECT_FAILED' }
  const { reportPath } = finalizeRunReport(run, { fixtureHash: contents().manifest.fixtureHash, fixtureOnly: true,
    status: errorCode === 'NATIVE_MODAL_NO_EFFECT' ? 'needs-native-interaction' : errorCode ? 'failed' : 'scenario-passed', errorCode, errorMessage, checks,
    cloudTested: false, persistenceTested: false, realIdentityTested: false, androidIosTested: false,
    nativeKeyboardGestureTested: false,
    discardModalTested: checks.some(item => item.name === 'native-discard-confirm-drops-only-unsaved-draft'),
    resetModalTested: checks.some(item => item.name === 'native-reset-confirm-restores-target-and-keeps-unrelated-state'),
    productionStoreTested: false })
  console.log(JSON.stringify({ reportPath, errorCode, errorMessage, checks: checks.length }))
  if (errorCode) process.exitCode = 1
}
if (require.main === module) main().catch(() => { console.error('MEAL_EDIT_UI_RUN_FAILED'); process.exitCode = 1 })
module.exports = { guard, runScenario, waitDiscardCancelled, waitResetCancelled }
