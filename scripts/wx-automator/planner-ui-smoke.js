'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
const { KIND, contents } = require('../build-planner-ui-fixture')
const { createRun, finalizeRunReport, withAutomatorResponseTimeout, navigateAndAcquire,
  readAutomatorViewport, captureScreenshotWithRetry, sanitizeCode, sanitizeText,
  subscribeAutomatorDiagnostics, classifyAutomatorDiagnostic, cleanupAutomatorSession } = require('./automation-runtime')
const HOME = 'pages/plan/plan', PLANNER = 'pages/planner/planner'
const call = (stage, fn) => withAutomatorResponseTimeout(fn, { stage, timeoutMs: 10000 })
function nativeBoolean(value) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw Error('Unknown native boolean representation')
}
async function guard(miniProgram) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const marker = await call('PLANNER_FIXTURE_GUARD', () => miniProgram.evaluate(() => {
      const app = typeof getApp === 'function' ? getApp() : null
      return app ? { kind: app.globalData && app.globalData.plannerUiFixture,
        sourceHash: app.globalData && app.globalData.plannerUiSourceHash } : { initializing: true }
    }))
    if (marker && marker.initializing === true) { await new Promise(resolve => setTimeout(resolve, 250)); continue }
    if (!marker || marker.kind !== KIND) throw Object.assign(Error('Isolated planner fixture required'), { code: 'FIXTURE_REQUIRED' })
    if (marker.sourceHash !== contents().manifest.sourceHash) throw Object.assign(Error('Stale planner fixture'), { code: 'FIXTURE_SOURCE_STALE' })
    return
  }
  throw Object.assign(Error('Fixture not initialized'), { code: 'FIXTURE_NOT_READY' })
}
async function runScenario(miniProgram, directory, record) {
  await guard(miniProgram)
  await call('RESET_FIXTURE', () => miniProgram.evaluate(() => getApp().plannerUiTest.reset()))
  const snapshot = () => call('FIXTURE_MEMORY', () => miniProgram.evaluate(() => getApp().plannerUiTest.snapshot()))
  const before = await snapshot()
  const layoutIssues = []
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
      return page && page.path === route && !await data(page, 'loadingPage')
    })
    return page
  }
  async function control(page, selector) { const item = await call('CONTROL', () => page.$(selector)); assert(item, selector); return item }
  async function reveal(page, item) {
    const viewport = await readAutomatorViewport(miniProgram, page)
    const offset = await call('BEFORE_SCROLL_OFFSET', () => item.offset()), size = await call('BEFORE_SCROLL_SIZE', () => item.size())
    const top = Number(offset.top), height = Number(size.height)
    assert(Number.isFinite(top) && height > 0)
    if (top < 120 || top + height > viewport.windowHeight - 110) {
      const currentScroll = Number(await call('SCROLL_TOP', () => page.scrollTop()))
      assert(Number.isFinite(currentScroll))
      await call('REVEAL_CONTROL', () => miniProgram.pageScrollTo(Math.max(0, currentScroll + top - 130)))
      await call('SETTLE_SCROLL', () => page.waitFor(350))
    }
  }
  async function tap(page, selector) {
    const item = typeof selector === 'string' ? await control(page, selector) : selector
    if (!['.next-button', '.back-button'].includes(selector)) await reveal(page, item)
    await call('TAP', () => item.tap())
  }
  async function input(page, selector, value) {
    const item = typeof selector === 'string' ? await control(page, selector) : selector
    await reveal(page, item)
    await call('INPUT', () => item.input(value))
    // Explicit SDK event, not evidence of physical Android/iOS keyboard dismissal.
    await call('BLUR_EVENT', () => item.trigger('blur', {}))
    await settled('footer restored', async () => !await data(page, 'formControlFocused'))
  }
  async function step(page, number) { await settled('step ' + number, async () => await data(page, 'currentStep') === number) }
  async function capture(page, name, bottom = false) {
    await call('SCROLL_CAPTURE', () => miniProgram.pageScrollTo(bottom ? 100000 : 0))
    await call('SETTLE_CAPTURE', () => page.waitFor(3000))
    assert.equal((await call('CAPTURE_ROUTE', () => miniProgram.currentPage())).path, page.path)
    await captureScreenshotWithRetry(miniProgram, path.join(directory, name + '.png'), { expectedRoute: page.path, timeoutMs: 10000 })
    record(name, { screenshot: 'captured' })
  }
  async function layout(page, selectors) {
    const viewport = await readAutomatorViewport(miniProgram, page)
    const controls = []
    for (const selector of selectors) {
      const item = await control(page, selector), size = await call('SIZE', () => item.size()), offset = await call('OFFSET', () => item.offset())
      const width = Number(size.width), height = Number(size.height), left = Number(offset.left)
      controls.push({ selector, width, height, left })
      if (!(height >= 48 && width >= 48)) layoutIssues.push(selector + ' touch area')
      if (!(left >= -1 && left + width <= viewport.windowWidth + 1)) layoutIssues.push(selector + ' horizontal overflow')
    }
    record('layout-step-' + await data(page, 'currentStep'), { viewport, controls, issues: [...layoutIssues] })
  }
  await navigateAndAcquire(miniProgram, '/' + HOME)
  await tap(await current(HOME), '.fixture-open')
  let page = await current(PLANNER)
  assert.equal(await data(page, 'pageError'), '')
  assert.equal((await data(page, 'preferences')).durationDays, 1)
  assert.equal(await data(page, 'aiDataConsentAccepted'), false)
  await tap(page, '.next-button')
  assert.equal(await data(page, 'currentStep'), 0)
  assert.match(await data(page, 'stepError'), /餐次/)
  const meals = await call('MEAL_OPTIONS', () => page.$$('.option-row'))
  for (const item of meals.slice(0, 3)) await call('SELECT_MEAL', () => item.tap())
  await settled('three meals', async () => (await data(page, 'preferences')).mealTypes.length === 3)
  await layout(page, ['.page-navigation', '.option-row', '.next-button'])
  record('explicit-three-meals-no-default-consent', {})
  await tap(page, '.next-button'); await step(page, 1)
  await input(page, '.duration-input', '0')
  assert.equal((await data(page, 'preferences')).durationDays, 1)
  assert.equal(await data(page, 'durationDaysInput'), '1')
  await input(page, '.duration-input', '15')
  assert.match(await data(page, 'durationDaysError'), /14/)
  assert.equal(nativeBoolean(await call('DISABLED_NEXT', async () => (await control(page, '.next-button')).property('disabled'))), true)
  await input(page, '.duration-input', '14')
  assert.equal((await data(page, 'preferences')).exerciseByDay.length, 14)
  await layout(page, ['.duration-button', '.duration-input', '.next-button'])
  await capture(page, 'planner-duration')
  record('duration-zero-normalized-15-rejected-14-accepted', {})
  await tap(page, '.next-button'); await step(page, 2)
  const wish = '虚构测试：想吃番茄鸡蛋\n第二行：清淡家常'
  await input(page, 'textarea', wish)
  assert.equal((await data(page, 'preferences')).customGoal, wish)
  assert.equal(await call('TEXTAREA_BOOLEAN', async () => (await control(page, 'textarea')).property('autoHeight')), false)
  assert(Number((await call('TEXTAREA_SIZE', async () => (await control(page, 'textarea')).size())).height) >= 80)
  await input(page, '#cooking-servings', '0')
  await tap(page, '.next-button'); await step(page, 2)
  assert(await data(page, 'servingsError'))
  await input(page, '#cooking-servings', '2')
  await input(page, '#cooking-minutes', '45')
  assert.equal((await call('INITIAL_PANTRY_ACTIONS', () => page.$$('.pantry-action'))).length, 1)
  await tap(page, '.pantry-action')
  await settled('pantry added', async () => (await data(page, 'pantryRows')).length === 1)
  const rowId = (await data(page, 'pantryRows'))[0].id
  await input(page, '#pantry-name-' + rowId, '虚构番茄')
  await input(page, '#pantry-quantity-' + rowId, '300')
  await layout(page, ['textarea', '#cooking-servings', '#cooking-minutes', '#pantry-name-' + rowId, '#pantry-quantity-' + rowId])
  await capture(page, 'planner-cooking')
  await tap(page, '.next-button'); await step(page, 3)
  const prefs = await data(page, 'preferences')
  assert.equal(prefs.servings, 2); assert.equal(prefs.maxCookingMinutes, 45)
  assert.deepEqual(prefs.pantryItems, [{ name: '虚构番茄', quantity: 300, unit: 'g' }])
  record('wishes-multiline-cooking-validation-and-pantry', {})
  const constraints = await call('CONSTRAINT_FIELDS', () => page.$$('textarea'))
  assert.equal(constraints.length, 3)
  await input(page, constraints[0], '虚构偏好：少用苦瓜')
  await input(page, constraints[1], '虚构忌口：花生')
  await input(page, constraints[2], '虚构约束，仅供测试')
  for (const item of await call('CONSTRAINT_TEXTAREAS', () => page.$$('textarea'))) {
    assert.equal(await call('TEXTAREA_BOOLEAN', () => item.property('autoHeight')), false)
    assert(Number((await call('TEXTAREA_SIZE', () => item.size())).height) >= 80)
  }
  await capture(page, 'planner-constraints')
  await tap(page, '.next-button'); await step(page, 4)
  await tap(page, '.next-button'); await step(page, 4)
  assert.match(await data(page, 'stepError'), /运动/)
  const modes = await call('EXERCISE_MODES', () => page.$$('.exercise-mode-row'))
  assert.equal(modes.length, 2)
  await tap(page, modes[1])
  await settled('daily exercise selected', async () => (await data(page, 'preferences')).exerciseIntent === 'daily')
  await settled('14 exercise rows', async () => (await call('EXERCISE_ROWS', () => page.$$('.exercise-toggle'))).length === 14)
  await tap(page, '.exercise-toggle')
  await settled('first exercise enabled', async () => (await data(page, 'exerciseDays'))[0].planned === true)
  await tap(page, '.next-button'); await step(page, 4)
  assert((await data(page, 'exerciseDays'))[0].typeError)
  const exerciseInputs = await call('EXERCISE_INPUTS', () => page.$$('input'))
  assert.equal(exerciseInputs.length, 2)
  await input(page, exerciseInputs[0], '虚构快走')
  await input(page, exerciseInputs[1], '0')
  await tap(page, '.next-button'); await step(page, 4)
  assert((await data(page, 'exerciseDays'))[0].durationError)
  await input(page, exerciseInputs[1], '30')
  const intensities = await call('INTENSITIES', () => page.$$('.intensity'))
  assert.equal(intensities.length, 3)
  for (const [index, value] of ['low', 'medium', 'high'].entries()) {
    await tap(page, intensities[index])
    await settled('intensity ' + value, async () => (await data(page, 'exerciseDays'))[0].intensity === value)
  }
  await input(page, 'textarea', '虚构运动说明\n第二行')
  assert.equal(await call('EXERCISE_TEXTAREA_BOOLEAN', async () => (await control(page, 'textarea')).property('autoHeight')), false)
  assert(Number((await call('EXERCISE_TEXTAREA_SIZE', async () => (await control(page, 'textarea')).size())).height) >= 80)
  await tap(page, '.next-button'); await step(page, 5)
  assert.equal((await data(page, 'preferences')).exerciseByDay[0].durationMinutes, 30)
  await tap(page, '.back-button'); await step(page, 4)
  await tap(page, '.exercise-mode-row')
  await settled('explicit no exercise', async () => (await data(page, 'preferences')).exerciseIntent === 'none')
  assert((await data(page, 'preferences')).exerciseByDay.every(item => !item.planned && item.durationMinutes === 0 && !item.type))
  record('daily-exercise-validation-all-intensities-and-rest-reset', {})
  await tap(page, '.next-button'); await step(page, 5)
  assert.equal(await data(page, 'aiDataConsentAccepted'), false)
  assert.equal(nativeBoolean(await call('GENERATE_DISABLED', async () => (await control(page, '.next-button')).property('disabled'))), true)
  await tap(page, '.ai-consent-row')
  await settled('explicit fictional consent', async () => await data(page, 'aiDataConsentAccepted') === true)
  assert.equal(nativeBoolean(await call('GENERATE_ENABLED', async () => (await control(page, '.next-button')).property('disabled'))), false)
  await tap(page, '.double-dinner .option-row')
  await settled('changed options invalidate consent', async () => await data(page, 'aiDataConsentAccepted') === false)
  await capture(page, 'planner-confirm', true)
  record('explicit-exercise-and-per-request-consent', {})
  const selected = await data(page, 'preferences')
  await tap(page, '.page-navigation'); await current(HOME)
  await tap(await current(HOME), '.fixture-open'); page = await current(PLANNER)
  assert.deepEqual(await data(page, 'preferences'), selected)
  assert.equal(await data(page, 'aiDataConsentAccepted'), false)
  const after = await snapshot()
  assert.equal(after.starts, 0)
  assert.deepEqual(after.data.activePlan, before.data.activePlan)
  record('memory-reentry-preserves-choices-without-ai-or-plan-write', {})
  await tap(page, '.page-navigation'); await current(HOME)
  assert.deepEqual(layoutIssues, [], 'all observed layout defects must be fixed before this scenario passes')
}
async function main() {
  if (process.argv.length !== 2) throw Error('No arguments accepted')
  const run = createRun('planner-native-fixture', path.resolve(__dirname, '../../.local/automator/planner-ui'))
  const checks = [], diagnostics = []; let miniProgram, unsubscribe, errorCode = '', errorMessage = ''
  try {
    miniProgram = await require('./automator-client').connect()
    await guard(miniProgram)
    unsubscribe = await subscribeAutomatorDiagnostics(miniProgram, {
      console(entry) { const d = classifyAutomatorDiagnostic(entry); if (d.observed) diagnostics.push(d) },
      exception(entry) { diagnostics.push({ blocking: true, level: 'exception',
        text: sanitizeText(entry && (entry.message || entry.description || entry), 700) }) },
    })
    await runScenario(miniProgram, run.outputDir, (name, evidence) => {
      checks.push({ name, ...evidence }); console.log('PLANNER_NATIVE_CHECK ' + name)
    })
    assert.equal(diagnostics.filter(item => item.blocking).length, 0, 'blocking diagnostics observed during scenario')
  } catch (error) { errorCode = sanitizeCode(error.code || 'NATIVE_CHECK_FAILED'); errorMessage = sanitizeText(error.message, 700) }
  finally { if (!(await cleanupAutomatorSession(miniProgram, unsubscribe)).ok) errorCode = 'SESSION_CLEANUP_FAILED' }
  const { reportPath } = finalizeRunReport(run, { fixtureHash: contents().manifest.fixtureHash, fixtureOnly: true,
    status: errorCode ? 'failed' : 'scenario-passed', errorCode, errorMessage, checks, diagnostics,
    sdkBlurEventsUsed: true, cloudTested: false, aiTested: false, persistenceTested: false,
    realIdentityTested: false, androidIosTested: false, nativeKeyboardGestureTested: false, productionStoreTested: false })
  console.log(JSON.stringify({ reportPath, errorCode, errorMessage, checks: checks.length }))
  if (errorCode) process.exitCode = 1
}
if (require.main === module) main().catch(() => { console.error('PLANNER_UI_RUN_FAILED'); process.exitCode = 1 })
module.exports = { guard, runScenario, nativeBoolean }
