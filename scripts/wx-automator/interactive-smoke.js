'use strict'

const fs = require('fs')
const path = require('path')
const automator = require('./automator-client')
const {
  categorizeError,
  classifyAutomatorDiagnostic,
  cleanupAutomatorSession,
  createRecoveryJournal,
  createRun,
  finalizeRunReport,
  isFatalSessionError,
  LOCAL_AUTOMATOR_DIR,
  mergeAutomatorCleanupReport,
  navigateAndAcquire,
  sanitizeCode,
  sanitizeText,
  subscribeAutomatorDiagnostics,
} = require('./automation-runtime')

const OUTPUT_BASE = path.join(LOCAL_AUTOMATOR_DIR, 'artifacts', 'interactive')
const RECOVERY_PATH = path.join(OUTPUT_BASE, 'recovery.json')
const WAIT_MS = 700
const NATIVE_TIMEOUT_MS = 2500
const RESTORE_TIMEOUT_MS = 30000
const CLOUD_WRITE_SETTLE_TIMEOUT_MS = 30000
const STEP_FILTER = new Set(String(process.env.MINIPROGRAM_SMOKE_STEPS || '')
  .split(',').map((item) => item.trim()).filter(Boolean))
const ALLOW_WRITE = process.env.MINIPROGRAM_SMOKE_ALLOW_WRITE === '1'
const ALLOW_DANGEROUS = process.env.MINIPROGRAM_SMOKE_ALLOW_DANGEROUS === '1'
const RECOVERY_ONLY = process.env.MINIPROGRAM_SMOKE_RECOVERY_ONLY === '1'
const STEP_RISKS = Object.freeze({
  TAB_SWITCH: 'S',
  PLAN_DAY: 'W',
  PLAN_WEEK: 'W',
  DINNER_MODE: 'W',
  PLANNER_ENTRY: 'S',
  MEAL_EDIT_ENTRY: 'W',
  BASIS_ENTRY: 'S',
  HISTORY_CANCEL: 'S',
  DRAFT_SAFE: 'S',
  PLANNER_CONTROLS: 'W',
  AI_NO_GENERATE: 'S',
  HEALTH_MONTH: 'S',
  HEALTH_FORM: 'S',
  HEALTH_TRENDS: 'S',
  SHOPPING_RESTORE: 'W',
  GUIDE_SETTINGS: 'W',
  TEST_REMINDER: 'W',
  PROFILE_SETTINGS: 'W',
  WATER_REMINDER_DRAFT: 'S',
  PROFILE_LEGAL: 'S',
  CLEAR_CANCEL: 'D',
  TEST_INVITE: 'D',
  TRANSFER_CANCEL: 'D',
  AVATAR_ERROR: 'S',
  AVATAR_MANUAL: 'S',
  PHONE_AUTH_CANCEL: 'D',
  PRIVACY_LEGAL: 'S',
  ACCESS_SAFE: 'S',
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function validateStepSelection() {
  if (!STEP_FILTER.size) {
    throw new Error('MINIPROGRAM_SMOKE_STEPS must explicitly list one or more smoke step IDs')
  }
  const unknown = [...STEP_FILTER].filter((id) => !Object.prototype.hasOwnProperty.call(STEP_RISKS, id))
  if (unknown.length) throw new Error(`unknown MINIPROGRAM_SMOKE_STEPS: ${unknown.join(',')}`)

  const selected = [...STEP_FILTER].map((id) => ({ id, risk: STEP_RISKS[id] }))
  const needsWrite = selected.filter((item) => item.risk === 'W' || item.risk === 'D').map((item) => item.id)
  const needsDangerous = selected.filter((item) => item.risk === 'D').map((item) => item.id)
  const missing = []
  if (needsWrite.length && !ALLOW_WRITE) {
    missing.push(`MINIPROGRAM_SMOKE_ALLOW_WRITE=1 for ${needsWrite.join(',')}`)
  }
  if (needsDangerous.length && !ALLOW_DANGEROUS) {
    missing.push(`MINIPROGRAM_SMOKE_ALLOW_DANGEROUS=1 for ${needsDangerous.join(',')}`)
  }
  if (missing.length) throw new Error(`smoke risk opt-in required: ${missing.join('; ')}`)
}

async function main() {
  validateStepSelection()
  fs.mkdirSync(OUTPUT_BASE, { recursive: true })
  const run = createRun('interactive', OUTPUT_BASE)
  const recovery = createRecoveryJournal(RECOVERY_PATH, run.runId, { recoveryOnly: RECOVERY_ONLY })
  if (RECOVERY_ONLY) {
    const pending = recovery.unresolved().map((item) => item.id)
    throw Object.assign(new Error(`Recovery-only mode is active for: ${pending.join(',')}`), {
      code: 'RECOVERY_ACTION_REQUIRED',
    })
  }
  const report = {
    steps: [],
    consoleErrorCount: 0,
    consoleWarningCount: 0,
    consoleNoticeCount: 0,
    blockingConsoleCount: 0,
    exceptionCount: 0,
    cleanupFailureCount: 0,
    cleanupErrorCodes: [],
  }
  let miniProgram = null
  let unsubscribeDiagnostics = null
  let fatalError = null
  const mutationJournal = []
  let writeStepsBlocked = false
  let diagnosticStage = 'IDLE'

  function registerMutation(id, restore) {
    const normalizedId = recovery.register(id, 'REGISTERED')
    const entry = { id: normalizedId, restore, active: true, restoreAttempted: false }
    mutationJournal.push(entry)
    return entry
  }

  function mutationRestored(entry) {
    entry.active = false
    recovery.resolve(entry.id)
  }

  function withTimeout(promise, timeoutMs = NATIVE_TIMEOUT_MS) {
    let timer
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation timed out')), timeoutMs) }),
    ]).finally(() => clearTimeout(timer))
  }

  async function nativeCancelAuthorization() {
    return withTimeout(miniProgram.native().authorizeCancel())
  }

  async function nativeCancelModal() {
    return withTimeout(miniProgram.native().cancelModal())
  }

  async function nativeConfirmModal() {
    return withTimeout(miniProgram.native().confirmModal())
  }

  async function withMockModal(confirm, action) {
    await miniProgram.mockWxMethod('showModal', function (options, confirmed) {
      const result = { confirm: confirmed === true, cancel: confirmed !== true }
      if (options && typeof options.success === 'function') options.success(result)
      if (options && typeof options.complete === 'function') options.complete(result)
      return Promise.resolve(result)
    }, confirm === true)
    try {
      return await action()
    } finally {
      await miniProgram.restoreWxMethod('showModal')
    }
  }

  async function withRestoredMutation(id, restore, action) {
    const entry = registerMutation(id, restore)
    try {
      return await action()
    } finally {
      entry.restoreAttempted = true
      recovery.update(entry.id, 'RESTORING')
      try {
        await withTimeout(restore(), RESTORE_TIMEOUT_MS)
        mutationRestored(entry)
      } catch (error) {
        recovery.update(entry.id, 'RESTORE_FAILED')
        writeStepsBlocked = true
        throw error
      }
    }
  }

  async function restoreMutations() {
    if (!miniProgram) return
    for (const [operation, code] of [
      [nativeCancelAuthorization, 'CLEANUP_AUTHORIZATION_CANCEL_FAILED'],
      [nativeCancelModal, 'CLEANUP_MODAL_CANCEL_FAILED'],
    ]) {
      try {
        await operation()
      } catch (error) {
        if (isFatalSessionError(error)) {
          report.cleanupFailureCount += 1
          report.cleanupErrorCodes.push(code)
        }
      }
    }
    for (const entry of [...mutationJournal].reverse()) {
      if (!entry.active || entry.restoreAttempted) continue
      entry.restoreAttempted = true
      recovery.update(entry.id, 'RESTORING')
      try {
        await withTimeout(entry.restore(), RESTORE_TIMEOUT_MS)
        mutationRestored(entry)
      } catch (error) {
        recovery.update(entry.id, 'RESTORE_FAILED')
        report.cleanupFailureCount += 1
        report.cleanupErrorCodes.push(`CLEANUP_${entry.id}_FAILED`)
        if (isFatalSessionError(error)) break
      }
    }
  }

  async function optionalNonFatal(operation, fallback = null) {
    try {
      return await operation()
    } catch (error) {
      if (isFatalSessionError(error)) throw error
      return fallback
    }
  }

  async function activeRoute() {
    const page = await optionalNonFatal(() => miniProgram.currentPage(), null)
    return page && page.path || ''
  }

  async function step(id, name, action) {
    if (!STEP_FILTER.has(id)) return false
    const risk = STEP_RISKS[id]
    if (!risk) throw new Error(`smoke step risk is not declared: ${id}`)
    diagnosticStage = `${id}_START`
    const startedAtMs = Date.now()
    try {
      const result = await action()
      const status = result && result.skip ? 'skipped' : 'passed'
      const route = await activeRoute()
      report.steps.push({
        id, name, risk, status, errorCode: '', category: status === 'skipped' ? 'SKIPPED' : 'PASSED',
        stage: diagnosticStage, durationMs: Date.now() - startedAtMs, route,
      })
      process.stdout.write(`${status.toUpperCase()} ${name}\n`)
      return status === 'passed'
    } catch (error) {
      const route = isFatalSessionError(error) ? '' : await activeRoute()
      report.steps.push({
        id, name, risk, status: 'failed', errorCode: `STEP_${id}_FAILED`, category: categorizeError(error),
        stage: diagnosticStage, durationMs: Date.now() - startedAtMs, route,
      })
      process.stdout.write(`FAILED ${name} [STEP_${id}_FAILED:${diagnosticStage}]\n`)
      process.stderr.write(`DIAGNOSTIC ${id} ${sanitizeText(error && error.message || 'unknown failure', 240)}\n`)
      if (isFatalSessionError(error)) throw error
      return false
    } finally {
      diagnosticStage = 'IDLE'
    }
  }

  function stage(value) { diagnosticStage = value }

  async function writableStep(id, name, action) {
    const risk = STEP_RISKS[id]
    if (risk !== 'W' && risk !== 'D') throw new Error(`writable smoke step risk is invalid: ${id}`)
    if (!STEP_FILTER.has(id)) return false
    if (writeStepsBlocked) {
      report.steps.push({ id, name, risk, status: 'skipped', errorCode: 'WRITE_STEPS_BLOCKED' })
      process.stdout.write(`SKIPPED ${name} [WRITE_STEPS_BLOCKED]\n`)
      return false
    }
    return step(id, name, action)
  }

  async function current(expected = '', timeout = 8000) {
    if (!expected) {
      const page = await miniProgram.currentPage()
      if (!page) throw new Error('no current page')
      return page
    }
    const deadline = Date.now() + timeout
    let page = null
    while (Date.now() < deadline) {
      page = await miniProgram.currentPage()
      if (page && page.path === expected) return page
      await sleep(200)
    }
    throw new Error(`unexpected route ${page ? page.path : 'none'}`)
  }

  async function waitForData(page, predicate, timeout = 12000) {
    const deadline = Date.now() + timeout
    let data
    while (Date.now() < deadline) {
      data = await page.data()
      if (predicate(data)) return data
      await sleep(250)
    }
    throw new Error('page state timed out')
  }

  async function elements(page, selector) {
    const list = await page.$$(selector)
    return Array.isArray(list) ? list : []
  }

  async function element(page, selector, index = 0) {
    const list = await elements(page, selector)
    if (!list[index]) throw new Error(`missing control ${selector}[${index}]`)
    return list[index]
  }

  async function waitForElements(page, selector, minimum = 1, timeout = 8000) {
    const deadline = Date.now() + timeout
    let list = []
    while (Date.now() < deadline) {
      list = await elements(page, selector)
      if (list.length >= minimum) return list
      await sleep(150)
    }
    throw new Error(`missing rendered controls ${selector}`)
  }

  async function tapControl(page, selector, index = 0, settle = WAIT_MS) {
    let target = await element(page, selector, index)
    const offset = await optionalNonFatal(() => target.offset(), null)
    if (offset && Number.isFinite(offset.top)) {
      await optionalNonFatal(() => miniProgram.pageScrollTo(Math.max(0, offset.top - 170)))
      await sleep(120)
      target = await element(page, selector, index)
    }
    await target.tap()
    await sleep(settle)
  }

  async function returnTo(route) {
    let lastError = null
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const page = await current()
      if (page.path === route) return page
      try {
        await miniProgram.navigateBack()
        lastError = null
      } catch (error) {
        if (isFatalSessionError(error)) throw error
        // The IDE can reject the automation command after the page stack has
        // already changed. Verify the route before treating it as a failure.
        lastError = error
      }
      await sleep(WAIT_MS)
    }
    const page = await optionalNonFatal(() => current(), null)
    if (page && page.path === route) return page
    const reason = lastError && (lastError.message || lastError.errMsg) || 'route did not change'
    throw new Error(`could not return to ${route}: ${String(reason).slice(0, 160)}`)
  }

  async function cancelModal() {
    await sleep(350)
    await nativeCancelModal()
    await sleep(350)
  }

  async function confirmModal() {
    await sleep(350)
    await nativeConfirmModal()
    await sleep(500)
  }

  async function openPage(route) {
    return navigateAndAcquire(miniProgram, route)
  }

  async function waitForIdle(page) {
    return waitForData(page, (data) => data.loading !== true && data.loadingPage !== true
      && data.viewState !== 'loading' && data.authState !== 'connecting'
      && data.saving !== true && data.savingSettings !== true
      && data.creatingInvite !== true && !data.revokingInviteRef)
  }

  function findShoppingItem(data, itemId) {
    return (data.groups || []).flatMap((group) => group.items || []).find((item) => item.itemId === itemId)
  }

  async function restorePlanDay(dayId) {
    let page = await openPage('/pages/plan/plan')
    const data = await waitForData(page, (next) => next.loading === false && !next.error)
    const originalIndex = (data.days || []).findIndex((item) => item.id === dayId)
    const day = (data.days || [])[originalIndex]
    if (!day || originalIndex < 0) throw new Error('original plan day missing')
    await page.callMethod('savePlanSelection', { ...day, originalIndex })
    await waitForData(page, (next) => next.selectedDay && next.selectedDay.id === dayId && next.syncState !== 'saving')
    const reload = page.callMethod('loadData', true)
    await sleep(50)
    await reload
    page = await current('pages/plan/plan')
    await waitForData(page, (next) => next.loading === false && !next.error && next.offline !== true
      && next.syncState === 'ready' && next.selectedDay && next.selectedDay.id === dayId)
  }

  async function restoreDinnerMode(dayId, mode) {
    let page = await openPage('/pages/plan/plan')
    const data = await waitForData(page, (next) => next.loading === false)
    if (!data.selectedDay || data.selectedDay.id !== dayId) await restorePlanDay(dayId)
    page = await current('pages/plan/plan')
    await page.callMethod('selectDinnerMode', { currentTarget: { dataset: { mode } } })
    await waitForData(page, (next) => next.selectedDay && next.selectedDay.id === dayId
      && next.selectedDay.dinnerMode === mode && next.syncState !== 'saving')
    const reload = page.callMethod('loadData', true)
    await sleep(50)
    await reload
    page = await current('pages/plan/plan')
    await waitForData(page, (next) => next.loading === false && !next.error && next.offline !== true
      && next.syncState === 'ready' && next.selectedDay && next.selectedDay.id === dayId
      && next.selectedDay.dinnerMode === mode)
  }

  async function restorePlannerPreferences(preferences) {
    let page = await openPage('/pages/planner/planner')
    await waitForData(page, (next) => next.loadingPage === false)
    await page.callMethod('updatePreferences', preferences)
    await sleep(100)
    await page.callMethod('flushPreferenceDraft')
    const reload = page.callMethod('connect', true)
    await sleep(50)
    await reload
    page = await current('pages/planner/planner')
    await waitForData(page, (next) => next.loadingPage === false && !next.pageError
      && JSON.stringify(next.preferences) === JSON.stringify(preferences))
    const cloudProbe = await openPage('/pages/guide/guide')
    await cloudProbe.callMethod('connect', true)
    await waitForData(cloudProbe, (next) => next.loading === false && !next.error && next.offline !== true)
    page = await openPage('/pages/planner/planner')
    const finalReload = page.callMethod('connect', true)
    await sleep(50)
    await finalReload
    page = await current('pages/planner/planner')
    await waitForData(page, (next) => next.loadingPage === false && !next.pageError
      && JSON.stringify(next.preferences) === JSON.stringify(preferences))
  }

  async function restoreShoppingItem(itemId, checked) {
    let page = await navigateAndAcquire(miniProgram, '/pages/shopping/shopping', { method: 'switchTab' })
    const data = await waitForData(page, (next) => next.viewState !== 'loading' && next.saving !== true)
    const item = findShoppingItem(data, itemId)
    if (!item) throw new Error('original shopping item missing')
    if (item.checked !== checked) {
      await page.callMethod('toggleItem', { currentTarget: { dataset: { id: itemId } } })
      await page.callMethod('syncChanges')
      await waitForData(page, (next) => {
        const current = findShoppingItem(next, itemId)
        return next.saving !== true && current && current.checked === checked
      })
    }
    const reload = page.callMethod('loadData', true)
    await sleep(50)
    await reload
    page = await current('pages/shopping/shopping')
    await waitForData(page, (next) => {
      const current = findShoppingItem(next, itemId)
      return next.viewState === 'ready' && next.offline !== true && !next.errorMessage
        && next.saving !== true && current && current.checked === checked
    })
  }

  async function restoreSetting(route, method, key, value) {
    let page = await openPage(route)
    await waitForData(page, (next) => next.loading !== true && next.authState !== 'connecting'
      && next.offline !== true && next.authState !== 'offline' && !next.error)
    const data = await page.data()
    if (!data.settings || data.settings[key] !== value) {
      await page.callMethod(method, { currentTarget: { dataset: { key } }, detail: { value } })
      await waitForData(page, (next) => next.saving !== true && next.savingSettings !== true
        && next.settings && next.settings[key] === value)
    }
    if (route === '/pages/profile/profile') {
      const cloudProbe = await navigateAndAcquire(miniProgram, '/pages/guide/guide')
      await waitForData(cloudProbe, (next) => next.loading === false && !next.error
        && next.offline !== true && next.settings && next.settings[key] === value)
      page = await navigateAndAcquire(miniProgram, '/pages/profile/profile')
      await waitForData(page, (next) => next.authState !== 'connecting'
        && next.authState !== 'offline' && next.offline !== true && !next.error
        && next.settings && next.settings[key] === value)
    } else {
      page = await navigateAndAcquire(miniProgram, route)
      await waitForData(page, (next) => next.loading !== true && next.authState !== 'connecting'
        && next.offline !== true && !next.error && next.authState !== 'offline'
        && next.settings && next.settings[key] === value)
    }
  }

  async function removeTestReminder(journalState) {
    let page = await openPage('/pages/guide/guide')
    await page.callMethod('connect', true)
    page = await current('pages/guide/guide')
    let data = await waitForData(page, (next) => next.loading === false && next.saving !== true
      && !next.error && next.offline !== true, CLOUD_WRITE_SETTLE_TIMEOUT_MS)
    const target = (data.reminders || []).find((item) => (
      journalState.reminderId ? item.id === journalState.reminderId : item.text === journalState.label
    ))
    if (target) {
      await withMockModal(true, () => page.callMethod('removeReminder', {
        currentTarget: { dataset: { id: target.id } },
      }))
      await waitForData(page, (next) => next.saving !== true && next.offline !== true
        && !next.reminders.some((item) => item.id === target.id), CLOUD_WRITE_SETTLE_TIMEOUT_MS)
    }
    await page.callMethod('connect', true)
    page = await current('pages/guide/guide')
    data = await waitForData(page, (next) => next.loading === false && next.saving !== true
      && !next.error && next.offline !== true, CLOUD_WRITE_SETTLE_TIMEOUT_MS)
    if ((data.reminders || []).some((item) => (
      journalState.reminderId ? item.id === journalState.reminderId : item.text === journalState.label
    ))) throw new Error('test reminder cleanup unconfirmed')
  }

  async function revokeTestInvite(journalState) {
    let page = await navigateAndAcquire(miniProgram, '/pages/profile/profile', { method: 'switchTab' })
    await page.callMethod('connect', true)
    page = await current('pages/profile/profile')
    let data = await waitForData(page, (next) => next.authState !== 'connecting'
      && ['ready', 'empty', 'error'].includes(next.membersState) && next.creatingInvite !== true)
    if (data.membersState === 'error') {
      await page.callMethod('retryMembers')
      data = await waitForData(page, (next) => ['ready', 'empty'].includes(next.membersState), 15000)
    }
    const target = (data.activeInvites || []).find((item) => (
      journalState.inviteRef ? item.inviteRef === journalState.inviteRef : item.label === journalState.label
    ))
    if (!target) {
      await page.callMethod('connect', true)
      page = await current('pages/profile/profile')
      data = await waitForData(page, (next) => next.authState !== 'connecting'
        && next.authState !== 'offline' && ['ready', 'empty'].includes(next.membersState), 15000)
      if ((data.activeInvites || []).some((item) => (
        journalState.inviteRef ? item.inviteRef === journalState.inviteRef : item.label === journalState.label
      ))) throw new Error('test invite cleanup unconfirmed')
      return
    }
    await withMockModal(true, () => withTimeout(page.callMethod('revokeInvite', {
      currentTarget: { dataset: { inviteRef: target.inviteRef } },
    }), 70000))
    await waitForData(page, (next) => !next.revokingInviteRef
      && !next.activeInvites.some((item) => item.inviteRef === target.inviteRef), 70000)
    await page.callMethod('connect', true)
    page = await current('pages/profile/profile')
    data = await waitForData(page, (next) => next.authState !== 'connecting'
      && next.authState !== 'offline' && ['ready', 'empty'].includes(next.membersState), 15000)
    if ((data.activeInvites || []).some((item) => (
      journalState.inviteRef ? item.inviteRef === journalState.inviteRef : item.label === journalState.label
    ))) throw new Error('test invite cleanup unconfirmed')
  }

  try {
    miniProgram = await automator.connect()
    diagnosticStage = 'ENABLE_CONSOLE_LOG'
    unsubscribeDiagnostics = await subscribeAutomatorDiagnostics(miniProgram, {
      console: (entry) => {
        const diagnostic = classifyAutomatorDiagnostic(entry)
        if (!diagnostic.observed) return
        if (diagnostic.level.includes('error')) report.consoleErrorCount += 1
        else report.consoleWarningCount += 1
        if (diagnostic.category === 'DEVTOOLS_PERFORMANCE_NOTICE') report.consoleNoticeCount += 1
        if (diagnostic.blocking) report.blockingConsoleCount += 1
      },
      exception: () => { report.exceptionCount += 1 },
    })

    await step('TAB_SWITCH', 'TabBar 餐单/记录/采购/我的连续两轮切换', async () => {
      const routes = [
        '/pages/plan/plan', '/pages/health/health', '/pages/shopping/shopping', '/pages/profile/profile',
      ]
      for (let round = 0; round < 2; round += 1) {
        for (const route of routes) {
          const page = await navigateAndAcquire(miniProgram, route, { method: 'switchTab' })
          const data = await page.data()
          if (data.loading === true || data.viewState === 'loading' || data.authState === 'connecting') {
            await waitForData(page, (next) => next.loading !== true && next.viewState !== 'loading' && next.authState !== 'connecting')
          }
        }
      }
    })

    await writableStep('PLAN_DAY', '餐单日期逐项切换并恢复原日期', async () => {
      let page = await openPage('/pages/plan/plan')
      const original = await waitForData(page, (next) => next.loading === false)
      if (!original.hasPlan) return { skip: '当前账号没有已确认餐单' }
      const originalDayId = original.selectedDay.id
      await withRestoredMutation('PLAN_DAY', () => restorePlanDay(originalDayId), async () => {
        const days = await elements(page, '.day-button')
        if (!days.length) throw new Error('date controls missing')
        for (let index = 0; index < days.length; index += 1) {
          page = await current('pages/plan/plan')
          await tapControl(page, '.day-button', index, 300)
        }
      })
    })

    await writableStep('PLAN_WEEK', '14 天周切换并恢复', async () => {
      let page = await openPage('/pages/plan/plan')
      const original = await waitForData(page, (next) => next.loading === false)
      const weeks = await elements(page, '.week-button')
      if (weeks.length < 2) return { skip: '当前计划为 7 天，仅一周' }
      const originalDayId = original.selectedDay.id
      await withRestoredMutation('PLAN_WEEK_DAY', () => restorePlanDay(originalDayId), async () => {
        const target = original.selectedWeekIndex === 0 ? 1 : 0
        await tapControl(page, '.week-button', target)
      })
    })

    await writableStep('DINNER_MODE', '日常/运动日晚餐切换并恢复', async () => {
      const page = await openPage('/pages/plan/plan')
      const original = await waitForData(page, (next) => next.loading === false)
      const choices = await elements(page, '.segment-button')
      if (choices.length < 2) return { skip: '当前日期没有双晚餐备选' }
      const originalIndex = original.selectedDay.dinnerMode === 'workout' ? 1 : 0
      const dayId = original.selectedDay.id
      const mode = original.selectedDay.dinnerMode
      await withRestoredMutation('DINNER_MODE', () => restoreDinnerMode(dayId, mode), () => (
        tapControl(page, '.segment-button', originalIndex === 0 ? 1 : 0)
      ))
    })

    await step('PLANNER_ENTRY', '重新定制入口打开并返回', async () => {
      const page = await openPage('/pages/plan/plan')
      await waitForData(page, (next) => next.loading === false)
      await tapControl(page, '.header-action')
      await current('pages/planner/planner')
      await returnTo('pages/plan/plan')
    })

    await writableStep('MEAL_EDIT_ENTRY', '餐食调整入口打开真实表单并返回', async () => {
      stage('MEAL_EDIT_OPEN_PLAN')
      let page = await navigateAndAcquire(miniProgram, '/pages/plan/plan')
      await waitForData(page, (next) => next.loading === false)
      const original = await page.data()
      if (!original.hasPlan || !original.selectedDay || !original.selectedDay.id) {
        return { skip: '当前账号没有已确认餐单' }
      }

      const originalDayId = original.selectedDay.id
      const days = Array.isArray(original.days) ? original.days : []
      const originalIndex = days.findIndex((day) => day.id === originalDayId)
      if (originalIndex < 0) throw new Error('original plan day missing')
      const currentDayHasMeals = Array.isArray(original.selectedDay.meals)
        && original.selectedDay.meals.length > 0
      const targetIndex = currentDayHasMeals ? originalIndex : days.findIndex((day) => (
        Array.isArray(day.meals) && day.meals.length > 0
      ))
      if (targetIndex < 0) return { skip: '当前餐单没有可编辑餐食' }

      const targetDay = original.days[targetIndex]
      const openEditor = async () => {
        stage('MEAL_EDIT_SELECT_DAY')
        if (targetDay.id !== originalDayId) {
          await page.callMethod('savePlanSelection', { ...targetDay, originalIndex: targetIndex })
          page = await current('pages/plan/plan')
          await waitForData(page, (next) => next.selectedDay && next.selectedDay.id === targetDay.id
            && next.syncState !== 'saving')
        }

        stage('MEAL_EDIT_OPEN_ACTION')
        const selected = await page.data('selectedDay')
        const meal = selected && Array.isArray(selected.meals) ? selected.meals[0] : null
        if (!meal || !meal.mealId) throw new Error('editable meal missing')
        await page.callMethod('editMeal', {
          detail: { mealId: meal.mealId }, currentTarget: { dataset: { id: meal.mealId } },
        })
        await sleep(WAIT_MS)

        try {
          stage('MEAL_EDIT_WAIT_ROUTE')
          const editPage = await current('pages/meal-edit/meal-edit')
          stage('MEAL_EDIT_WAIT_DATA')
          const data = await waitForData(editPage, (next) => next.loading === false)
          if (data.error) throw new Error('real meal editor did not load')
          const inputs = await waitForElements(editPage, 'input', 1)
          const textareas = await waitForElements(editPage, 'textarea', 3)
          if (!inputs.length || textareas.length < 3) throw new Error('meal editor fields incomplete')
        } finally {
          const activePage = await optionalNonFatal(() => miniProgram.currentPage(), null)
          if (activePage && activePage.path === 'pages/meal-edit/meal-edit') {
            await miniProgram.navigateBack()
            await sleep(WAIT_MS)
            await current('pages/plan/plan')
          }
        }
      }

      if (targetDay.id === originalDayId) return openEditor()
      return withRestoredMutation('MEAL_EDIT_DAY', () => restorePlanDay(originalDayId), openEditor)
    })

    await step('BASIS_ENTRY', '生成依据入口打开并返回', async () => {
      const page = await openPage('/pages/plan/plan')
      await waitForData(page, (next) => next.loading === false)
      await tapControl(page, '.text-button')
      await current('pages/guide/guide')
      await miniProgram.navigateBack()
      await sleep(WAIT_MS)
      await current('pages/plan/plan')
    })

    await step('HISTORY_CANCEL', '历史入口与空态下一步', async () => {
      stage('HISTORY_OPEN_PLAN')
      let page = await navigateAndAcquire(miniProgram, '/pages/plan/plan')
      await waitForData(page, (next) => next.loading === false)
      stage('HISTORY_TAP_ENTRY')
      await tapControl(page, '.plan-actions .secondary-button')
      stage('HISTORY_WAIT_ROUTE')
      page = await current('pages/plan-history/plan-history')
      stage('HISTORY_WAIT_DATA')
      const data = await waitForData(page, (next) => next.viewState !== 'loading')
      if (data.viewState === 'error') {
        stage('HISTORY_RETRY')
        await tapControl(page, '.state-action')
        const retried = await waitForData(page, (next) => next.viewState !== 'loading')
        if (retried.viewState === 'error') throw new Error('餐单历史重试后仍不可用')
      }
      const readyData = await page.data()
      if (readyData.viewState === 'empty') {
        stage('HISTORY_EMPTY_ACTION')
        await waitForData(page, (next) => next.viewState === 'empty')
        await waitForElements(page, '.state-action')
        await tapControl(page, '.state-action')
        stage('HISTORY_EMPTY_WAIT_PLANNER')
        page = await current('pages/planner/planner', 12000)
        await waitForData(page, (next) => next.loadingPage === false)
        stage('HISTORY_EMPTY_PLANNER_CONFIRMED')
      } else if (readyData.plans && readyData.plans.length) {
        stage('HISTORY_EXPAND')
        await waitForElements(page, '.expand-action')
        await tapControl(page, '.expand-action', 0)
        await tapControl(page, '.expand-action', 0)
        stage('HISTORY_RESTORE_CANCEL')
        await waitForElements(page, '.restore-action')
        await tapControl(page, '.restore-action', 0)
        await cancelModal()
      } else {
        return { skip: '餐单历史当前没有可操作记录' }
      }
      await openPage('/pages/plan/plan')
    })

    await step('DRAFT_SAFE', '候选计划空态入口', async () => {
      const page = await navigateAndAcquire(miniProgram, '/pages/plan-preview/plan-preview')
      await sleep(WAIT_MS)
      const data = await waitForData(page, (next) => next.viewState !== 'loading')
      if (data.viewState !== 'no-draft') return { skip: '当前账号存在候选计划，常规冒烟不应用或丢弃' }
      await tapControl(page, '.state-action', 0)
      await current('pages/planner/planner')
    })

    await writableStep('PLANNER_CONTROLS', '定制计划六步导航与控件恢复', async () => {
      stage('PLANNER_OPEN')
      let page = await navigateAndAcquire(miniProgram, '/pages/planner/planner')
      await sleep(1000)
      let data = await waitForData(page, (next) => next.loadingPage === false)
      if (data.taskVisible) {
        const editButtons = await elements(page, '.bottom-actions .task-action')
        if (!data.taskCanEdit || !editButtons.length) return { skip: '当前生成任务不能调整条件' }
        stage('PLANNER_EDIT_ACTIVE_TASK')
        await tapControl(page, '.bottom-actions .task-action', 0)
        page = await current('pages/planner/planner')
        data = await waitForData(page, (next) => next.taskVisible === false && next.currentStep === 0)
      }
      const originalPreferences = JSON.parse(JSON.stringify(data.preferences))
      await withRestoredMutation('PLANNER_PREFERENCES', () => restorePlannerPreferences(originalPreferences), async () => {
        stage('PLANNER_MEALS')
        const originalMeals = originalPreferences.mealTypes.slice()
        const mealRows = await elements(page, '.option-row')
        if (!mealRows.length) throw new Error('meal options missing')
        if (originalMeals.length) {
          const toggleIndex = originalMeals.length > 1 ? 0 : 1
          const targetValue = data.mealOptions[toggleIndex].value
          const toggledMeals = originalMeals.includes(targetValue)
            ? originalMeals.filter((value) => value !== targetValue)
            : [...originalMeals, targetValue]
          await page.callMethod('onMealsChange', { detail: { value: toggledMeals } })
          await waitForData(page, (next) => JSON.stringify(next.preferences.mealTypes) === JSON.stringify(toggledMeals))
          await page.callMethod('onMealsChange', { detail: { value: originalMeals } })
          await waitForData(page, (next) => JSON.stringify(next.preferences.mealTypes) === JSON.stringify(originalMeals))
        } else {
          const temporaryMeal = data.mealOptions[0].value
          await page.callMethod('onMealsChange', { detail: { value: [temporaryMeal] } })
          await waitForData(page, (next) => next.preferences.mealTypes.length === 1)
        }

      stage('PLANNER_TO_DURATION')
      await tapControl(page, '.next-button')
      page = await current('pages/planner/planner')
      data = await page.data()
      if (data.currentStep !== 1) throw new Error('duration step not reached')
      for (const duration of [1, 10, 14]) {
        stage(`PLANNER_DURATION_VALID_${duration}`)
        const durationInput = await element(page, '.duration-input')
        await durationInput.input(String(duration))
        await page.callMethod('commitDurationDays')
        data = await waitForData(page, (next) => next.durationDaysError === ''
          && next.preferences.durationDays === duration && next.durationDaysInput === String(duration))
        if ((data.preferences.exerciseByDay || []).length !== duration) {
          throw new Error(`duration ${duration} did not resize exercise days`)
        }
      }
      for (const duration of [0, 15]) {
        stage(`PLANNER_DURATION_INVALID_${duration}_INPUT`)
        const durationInput = await element(page, '.duration-input')
        await durationInput.input(String(duration))
        data = await waitForData(page, (next) => next.durationDaysInput === String(duration)
          && Boolean(next.durationDaysError))
        if (data.preferences.durationDays === duration) {
          throw new Error(`invalid duration ${duration} was accepted`)
        }
        stage(`PLANNER_DURATION_INVALID_${duration}_GENERATE_BLOCK`)
        await page.callMethod('generatePlan')
        data = await waitForData(page, (next) => next.generating !== true && next.taskVisible !== true
          && next.currentStep === 1 && Boolean(next.stepError))
        if (data.durationDaysInput !== String(duration)) {
          throw new Error(`invalid duration ${duration} did not stop before generation`)
        }
        if (duration === 0) {
          stage('PLANNER_DURATION_INVALID_0_COMMIT_FALLBACK')
          await page.callMethod('commitDurationDays')
          data = await waitForData(page, (next) => next.preferences.durationDays === 1
            && next.durationDaysInput === '1' && next.durationDaysError === '')
          if (!data.durationDaysFeedback) {
            throw new Error('zero days did not fall back to one day')
          }
        } else {
          stage('PLANNER_DURATION_INVALID_15_NAVIGATION_BLOCK')
          await page.callMethod('goNext')
          data = await waitForData(page, (next) => next.currentStep === 1 && Boolean(next.stepError))
          if (data.durationDaysInput !== '15') throw new Error('invalid duration did not block navigation')
        }
      }
      await (await element(page, '.duration-input')).input('10')
      await page.callMethod('commitDurationDays')
      await waitForData(page, (next) => next.preferences.durationDays === 10 && next.durationDaysError === '')

      stage('PLANNER_TO_GOALS')
      await tapControl(page, '.next-button')
      page = await current('pages/planner/planner')
      data = await page.data()
      const originalGoals = data.preferences.goals.slice()
      const originalStyles = data.preferences.styles.slice()
      const originalCustomGoal = String(data.preferences.customGoal || '').trim()
      if (!originalGoals.length && !originalStyles.length && !originalCustomGoal) {
        await tapControl(page, '.choice', 0, 300)
        data = await waitForData(page, (next) => next.preferences.goals.length === 1)
      } else {
        await tapControl(page, '.choice', 0, 300)
        await tapControl(page, '.choice', 0, 300)
        if (JSON.stringify((await page.data()).preferences.goals) !== JSON.stringify(originalGoals)) {
          throw new Error('goal choice not restored')
        }
      }

      stage('PLANNER_TO_RESTRICTIONS')
      await tapControl(page, '.next-button')
      page = await current('pages/planner/planner')
      if ((await page.data()).currentStep !== 3) throw new Error('restriction step not reached')
      const restrictionInputs = await elements(page, 'textarea')
      if (restrictionInputs.length < 2) throw new Error('restriction fields missing')

      stage('PLANNER_TO_EXERCISE')
      await tapControl(page, '.next-button')
      page = await current('pages/planner/planner')
      data = await page.data()
      if (data.currentStep !== 4) throw new Error('exercise step not reached')
      const invalidPlannedExercise = data.preferences.exerciseByDay.some((item) => item.planned === true
        && (!String(item.type || '').trim() || Number(item.durationMinutes) < 1 || Number(item.durationMinutes) > 360))
      const validPlannedExercise = data.preferences.exerciseByDay.some((item) => item.planned === true
        && String(item.type || '').trim() && Number(item.durationMinutes) >= 1 && Number(item.durationMinutes) <= 360)
      await page.callMethod('onExerciseIntentChange', { detail: { value: 'daily' } })
      data = await waitForData(page, (next) => next.preferences.exerciseIntent === 'daily')
      const emptyExerciseIndex = data.exerciseDays.findIndex((item) => item.planned !== true)
      if (emptyExerciseIndex >= 0) {
        const originalExercise = data.preferences.exerciseByDay[emptyExerciseIndex]
        await tapControl(page, '.exercise-toggle', emptyExerciseIndex, 350)
        page = await current('pages/planner/planner')
        const activeBlocks = await elements(page, '.exercise-day.planned')
        if (!activeBlocks.length) throw new Error('exercise fields did not expand')
        await page.callMethod('toggleExercise', { currentTarget: { dataset: { index: emptyExerciseIndex } } })
        await waitForData(page, (next) => {
          const item = next.preferences.exerciseByDay[emptyExerciseIndex]
          return item && item.planned === originalExercise.planned
        })
      }
      await page.callMethod('onExerciseIntentChange', {
        detail: { value: validPlannedExercise && !invalidPlannedExercise ? 'daily' : 'none' },
      })
      await waitForData(page, (next) => next.preferences.exerciseIntent === (
        validPlannedExercise && !invalidPlannedExercise ? 'daily' : 'none'
      ))

      stage('PLANNER_TO_CONFIRM')
      await tapControl(page, '.next-button')
      page = await current('pages/planner/planner')
      data = await page.data()
      if (data.currentStep !== 5) throw new Error(data.stepError || 'confirmation step not reached')
      const consent = await elements(page, '.ai-consent-row')
      if (consent.length) {
        await tapControl(page, '.ai-consent-row', 0, 250)
        await tapControl(page, '.ai-consent-row', 0, 250)
      }
      const doubleDinner = await elements(page, '.double-dinner .option-row')
      if (doubleDinner.length) {
        await tapControl(page, '.double-dinner .option-row', 0, 250)
        await tapControl(page, '.double-dinner .option-row', 0, 250)
      }
      stage('PLANNER_BACK_TO_START')
      for (let index = 0; index < 5; index += 1) {
        page = await current('pages/planner/planner')
        await tapControl(page, '.back-button', 0, 180)
      }
        if ((await page.data()).currentStep !== 0) throw new Error('planner did not return to first step')
      })
    })

    await step('AI_NO_GENERATE', 'AI 生成按钮状态与提示', async () => {
      stage('AI_STATUS_OPEN_PLANNER')
      const page = await navigateAndAcquire(miniProgram, '/pages/planner/planner')
      await waitForData(page, (next) => next.loadingPage === false && !next.pageError
        && ['ready', 'unconfigured', 'error'].includes(next.aiStatus))
      const data = await page.data()
      if (!['ready', 'unconfigured', 'error'].includes(data.aiStatus)) throw new Error('AI status unresolved')
      if (data.aiStatus !== 'ready') return { skip: '当前云端 AI 服务未配置，生成按钮按设计禁用' }
      return { skip: '真实 AI 生成会创建外部任务，留待专用额度部署后复测' }
    })

    await step('HEALTH_MONTH', '健康月份切换并恢复', async () => {
      let page = await navigateAndAcquire(miniProgram, '/pages/health/health', { method: 'switchTab' })
      await sleep(WAIT_MS)
      const original = await waitForData(page, (next) => next.loading === false)
      await tapControl(page, '.month-button', 0)
      page = await current('pages/health/health')
      await waitForData(page, (next) => next.loading === false && next.month !== original.month)
      await tapControl(page, '.month-button', 1)
      await waitForData(page, (next) => next.loading === false && next.month === original.month)
    })

    await step('HEALTH_FORM', '健康空白日期表单、运动开关和校验', async () => {
      let page = await navigateAndAcquire(miniProgram, '/pages/health/health', { method: 'switchTab' })
      const original = await waitForData(page, (next) => next.loading === false)
      const available = original.cells.filter((item) => !item.empty)
      const blankIndex = available.findIndex((item) => !item.weightText && !item.exercised && !item.hasPhoto)
      if (blankIndex < 0) return { skip: '当前月份没有空白测试日期' }
      await tapControl(page, '.day-cell.touch-target', blankIndex)
      page = await current('pages/health/health')
      const selected = await page.data()
      if (selected.selectedRecord) return { skip: '选中日期已有私人记录，不修改' }
      await tapControl(page, '.exercise-switch-target switch', 0, 250)
      if ((await page.data()).exerciseCompleted !== true) throw new Error('exercise switch did not enable')
      await tapControl(page, '.exercise-switch-target switch', 0, 250)
      if ((await page.data()).exerciseCompleted !== false) throw new Error('exercise switch did not restore')
      const weightInput = await element(page, '.weight-input input')
      await weightInput.input('10')
      await tapControl(page, '.record-card .primary-button', 0, 400)
      if (!(await page.data()).weightError) throw new Error('invalid weight had no inline error')
      await (await element(page, '.weight-input input')).input('')
      const originalCellIndex = available.findIndex((item) => item.date === original.selectedDate)
      if (originalCellIndex >= 0) await tapControl(page, '.day-cell.touch-target', originalCellIndex)
    })

    await step('HEALTH_TRENDS', '健康趋势周期与指标切换', async () => {
      let page = await navigateAndAcquire(miniProgram, '/pages/health/health', { method: 'switchTab' })
      const original = await waitForData(page, (next) => next.loading === false)
      await tapControl(page, '.trend-switch .touch-target', original.trendMode === 'week' ? 1 : 0, 250)
      await tapControl(page, '.trend-switch .touch-target', original.trendMode === 'week' ? 0 : 1, 250)
      await tapControl(page, '.metric-switch .touch-target', original.trendMetric === 'weight' ? 1 : 0, 250)
      await tapControl(page, '.metric-switch .touch-target', original.trendMetric === 'weight' ? 0 : 1, 250)
      page = await current('pages/health/health')
      const restored = await page.data()
      if (restored.trendMode !== original.trendMode || restored.trendMetric !== original.trendMetric) throw new Error('trend controls not restored')
    })

    await writableStep('SHOPPING_RESTORE', '采购勾选、重置确认取消并恢复', async () => {
      let page = await navigateAndAcquire(miniProgram, '/pages/shopping/shopping', { method: 'switchTab' })
      await sleep(WAIT_MS)
      const original = await waitForData(page, (next) => next.viewState !== 'loading')
      if (original.viewState !== 'ready') return { skip: '当前没有可测试采购项' }
      const firstItem = original.groups.flatMap((group) => group.items)[0]
      const rows = await elements(page, '.shopping-row')
      if (!firstItem || !rows.length) throw new Error('shopping rows missing')
      await withRestoredMutation('SHOPPING_ITEM', () => restoreShoppingItem(firstItem.itemId, firstItem.checked), async () => {
        await page.callMethod('toggleItem', { currentTarget: { dataset: { id: firstItem.itemId } } })
        await page.callMethod('syncChanges')
        await waitForData(page, (next) => next.saving === false)
        page = await current('pages/shopping/shopping')
        const reset = await elements(page, '.reset-button')
        if (reset.length && !(await reset[0].attribute('disabled'))) {
      await withMockModal(false, () => tapControl(page, '.reset-button'))
        }
      })
    })

    await writableStep('GUIDE_SETTINGS', '健康提醒开关逐项切换并恢复', async () => {
      let page = await navigateAndAcquire(miniProgram, '/pages/guide/guide')
      await sleep(WAIT_MS)
      const original = await waitForData(page, (next) => next.loading === false)
      const keys = ['calciumAnchorReminder', 'vitaminDReminder']
      for (let index = 0; index < keys.length; index += 1) {
        page = await current('pages/guide/guide')
        const key = keys[index]
        const value = original.settings[key]
        await withRestoredMutation(`GUIDE_SETTING_${index}`, () => (
          restoreSetting('/pages/guide/guide', 'toggleSetting', key, value)
        ), async () => {
          await tapControl(page, '.setting-row switch', index)
          await waitForData(page, (next) => next.saving === false)
        })
        page = await current('pages/guide/guide')
      }
      const restored = await page.data()
      for (const key of keys) if (restored.settings[key] !== original.settings[key]) throw new Error('guide setting not restored')
    })

    await writableStep('TEST_REMINDER', '个人提醒新增、勾选、取消和删除测试项', async () => {
      stage('TEST_REMINDER_OPEN_GUIDE')
      let page = await openPage('/pages/guide/guide')
      await waitForData(page, (next) => next.loading === false)
      const marker = `TEST-${Date.now().toString(36)}`
      const journalState = { label: marker, reminderId: '' }
      await withRestoredMutation('TEST_REMINDER', () => removeTestReminder(journalState), async () => {
        stage('TEST_REMINDER_INPUT')
        const input = await element(page, '.reminder-form textarea')
        await input.input(marker)
        stage('TEST_REMINDER_ADD')
        await tapControl(page, '.reminder-form .primary-button')
        stage('TEST_REMINDER_WAIT_ADD')
        const data = await waitForData(page, (next) => next.saving === false && next.offline !== true
          && !next.error && next.reminders.some((item) => item.text === marker), CLOUD_WRITE_SETTLE_TIMEOUT_MS)
        const targetId = data.reminders.find((item) => item.text === marker).id
        journalState.reminderId = targetId
        stage('TEST_REMINDER_TOGGLE')
        await page.callMethod('toggleReminder', { currentTarget: { dataset: { id: targetId } } })
        stage('TEST_REMINDER_WAIT_TOGGLE')
        await waitForData(page, (next) => next.saving === false && next.offline !== true
          && !next.error && next.reminders.find((item) => item.id === targetId)?.done === true,
        CLOUD_WRITE_SETTLE_TIMEOUT_MS)
      })
    })

    await writableStep('PROFILE_SETTINGS', '资料页健康提醒开关恢复', async () => {
      let page = await navigateAndAcquire(miniProgram, '/pages/profile/profile', { method: 'switchTab' })
      const original = await waitForData(page, (next) => next.authState === 'ready'
        && next.offline !== true && !next.error && next.savingSettings !== true && next.settings)
      const keys = ['calciumAnchorReminder', 'vitaminDReminder']
      for (let index = 0; index < 2; index += 1) {
        page = await current('pages/profile/profile')
        const key = keys[index]
        const value = original.settings[key]
        await withRestoredMutation(`PROFILE_SETTING_${index}`, () => (
          restoreSetting('/pages/profile/profile', 'toggleHealthSetting', key, value)
        ), async () => {
          await tapControl(page, '.setting-row switch', index)
          await waitForData(page, (next) => next.authState === 'ready' && next.offline !== true
            && next.savingSettings === false && next.settings && next.settings[key] === !value)
        })
        page = await navigateAndAcquire(miniProgram, '/pages/profile/profile')
        await waitForData(page, (next) => next.authState === 'ready' && next.offline !== true
          && next.settings && next.settings[key] === value)
      }
      const restored = await page.data()
      if (JSON.stringify(restored.settings) !== JSON.stringify(original.settings)) throw new Error('profile settings not restored')
    })

    await step('WATER_REMINDER_DRAFT', '喝水提醒入口、开关、周期和时间草稿恢复', async () => {
      stage('WATER_REMINDER_OPEN_PROFILE')
      let page = await navigateAndAcquire(miniProgram, '/pages/profile/profile', { method: 'switchTab' })
      await waitForData(page, (next) => next.authState !== 'connecting' && next.profileLoading === false)
      await tapControl(page, '.reminder-navigation')
      page = await current('pages/water-reminder/water-reminder')
      const original = await waitForData(page, (next) => next.loading === false && !next.loadError)
      const originalDraft = JSON.parse(JSON.stringify(original.draft))
      const reminderFields = ['enabled', 'cadence', 'startTime', 'endTime', 'intervalMinutes', 'timeZone']
      const sameDraft = (candidate) => reminderFields.every((key) => candidate
        && candidate[key] === originalDraft[key])

      try {
        stage('WATER_REMINDER_TOGGLE')
        await tapControl(page, '.master-row switch', 0, 250)
        let data = await waitForData(page, (next) => next.draft.enabled === !originalDraft.enabled)
        if (!data.draft.enabled) {
          await tapControl(page, '.master-row switch', 0, 250)
          data = await waitForData(page, (next) => next.draft.enabled === true)
        }

        stage('WATER_REMINDER_CADENCE')
        const cadenceIndex = data.draft.cadence === 'daily' ? 1 : 0
        await tapControl(page, '.segment', cadenceIndex, 250)
        data = await waitForData(page, (next) => next.draft.cadence !== originalDraft.cadence
          || next.draft.cadence !== data.draft.cadence)

        stage('WATER_REMINDER_TIME_DRAFTS')
        await page.callMethod('changeStartTime', { detail: { value: '08:00' } })
        await page.callMethod('changeEndTime', { detail: { value: '18:00' } })
        const intervalOptions = data.intervalOptions || []
        const intervalIndex = intervalOptions.findIndex((item) => item.value === 90)
        if (intervalIndex < 0) throw new Error('water reminder interval option missing')
        await page.callMethod('changeInterval', { detail: { value: String(intervalIndex) } })
        data = await waitForData(page, (next) => next.draft.startTime === '08:00'
          && next.draft.endTime === '18:00' && next.draft.intervalMinutes === 90
          && next.scheduleInvalid === false && next.previewTimes.length > 0)
        if (!data.dirty) throw new Error('water reminder draft did not become dirty')
      } finally {
        stage('WATER_REMINDER_RESTORE_DRAFT')
        await page.callMethod('changeInterval', { detail: { value: String(original.intervalIndex) } })
        await page.callMethod('updateDraft', originalDraft)
        await waitForData(page, (next) => next.dirty === false
          && next.intervalIndex === original.intervalIndex && sameDraft(next.draft))
      }

      stage('WATER_REMINDER_RETURN_PROFILE')
      await page.callMethod('navigateFromPage')
      await current('pages/profile/profile')
    })

    await step('PROFILE_LEGAL', '资料页用户协议入口', async () => {
      let page = await navigateAndAcquire(miniProgram, '/pages/profile/profile', { method: 'switchTab' })
      await waitForData(page, (next) => next.authState !== 'connecting')
      await tapControl(page, '.legal-row', 0)
      await current('pages/legal/user-agreement')
      await miniProgram.navigateBack()
      await sleep(WAIT_MS)
      await current('pages/profile/profile')
    })

    await step('CLEAR_CANCEL', '清空私人数据首层确认取消', async () => {
      stage('CLEAR_OPEN_PROFILE')
      const page = await navigateAndAcquire(miniProgram, '/pages/profile/profile')
      const data = await waitForData(page, (next) => next.authState === 'ready'
        && next.member && next.member.status === 'active'
        && (next.member.role !== 'owner'
          || ['ready', 'empty', 'error'].includes(next.membersState)))
      const ownerGuarded = data.member && data.member.role === 'owner'
        && (!data.inviteCapacityKnown || data.membersState === 'error' || data.memberCount > 1)
      stage('CLEAR_TAP')
      stage('CLEAR_CANCEL_OR_GUARD')
      if (ownerGuarded) {
        stage('CLEAR_GUARD_TAP')
        await tapControl(page, '.danger-button', 0, 0)
      } else {
        stage('CLEAR_MODAL_TAP')
        await tapControl(page, '.danger-button', 0, 0)
        stage('CLEAR_WAIT_LOCK')
        await waitForData(page, (next) => next.clearingData === true, 3000)
        stage('CLEAR_CANCEL_MODAL')
        await cancelModal()
      }
      stage('CLEAR_WAIT_UNLOCK')
      try {
        await waitForData(page, (next) => next.clearingData === false, 3000)
      } catch (error) {
        if (isFatalSessionError(error)) throw error
        stage('CLEAR_REOPEN_AFTER_CANCEL')
        await optionalNonFatal(() => miniProgram.native().cancelModal())
        const reopened = await navigateAndAcquire(miniProgram, '/pages/profile/profile')
        await waitForData(reopened, (next) => next.authState === 'ready'
          && next.member && next.member.status === 'active' && next.clearingData === false)
      }
    })

    await writableStep('TEST_INVITE', '测试邀请码生成并撤销', async () => {
      stage('INVITE_OPEN_PROFILE')
      let page = await navigateAndAcquire(miniProgram, '/pages/profile/profile')
      await waitForData(page, (next) => next.authState !== 'connecting'
        && ['ready', 'empty', 'error'].includes(next.membersState))
      const data = await page.data()
      if (!data.member || data.member.role !== 'owner') return { skip: '当前身份不是管理员' }
      if (!data.inviteCapacityKnown || data.occupiedCount >= data.maxMembers) return { skip: '当前邀请名额不可用' }
      const label = `TEST-${Date.now().toString(36)}`
      const labelInput = await elements(page, '.invite-label')
      if (!labelInput.length) return { skip: '管理员邀请控件未显示' }
      const journalState = { label, inviteRef: '' }
      await withRestoredMutation('TEST_INVITE', () => revokeTestInvite(journalState), async () => {
        stage('INVITE_INPUT')
        await labelInput[0].input(label)
        stage('INVITE_CREATE')
        await tapControl(page, '.invite-card .secondary-button')
        stage('INVITE_WAIT_LIST')
        const next = await waitForData(page, (value) => value.creatingInvite === false
          && value.activeInvites.some((item) => item.label === label), 70000)
        const invite = next.activeInvites.find((item) => item.label === label)
        if (!invite) throw new Error('test invite not listed')
        journalState.inviteRef = invite.inviteRef
      })
    })

    await step('TRANSFER_CANCEL', '管理员转移确认取消', async () => {
      const page = await navigateAndAcquire(miniProgram, '/pages/profile/profile', { method: 'switchTab' })
      await waitForData(page, (next) => next.authState !== 'connecting'
        && ['ready', 'empty', 'error'].includes(next.membersState))
      const options = await elements(page, '.member-option')
      if (!options.length) return { skip: '没有可接任的普通成员' }
      await tapControl(page, '.member-option', 0)
      await tapControl(page, '.transfer-button')
      await cancelModal()
    })

    await step('AVATAR_ERROR', '头像失败提示与取消恢复', async () => {
      const page = await navigateAndAcquire(miniProgram, '/pages/profile/profile', { method: 'switchTab' })
      const original = await waitForData(page, (next) => next.authState !== 'connecting'
        && next.profileLoading === false)
      await waitForElements(page, '.avatar-button')

      stage('AVATAR_UNSUPPORTED_ERROR')
      await page.callMethod('onChooseAvatar', {
        detail: { errMsg: 'chooseAvatar:fail api is not supported' },
      })
      let data = await waitForData(page, (next) => next.avatarPrivacyMode === 'native'
        && Boolean(next.avatarPrivacyError))
      if (/scope|api|未声明/i.test(data.avatarPrivacyError)) {
        throw new Error('avatar failure exposed internal platform terms')
      }
      if (!(await elements(page, '.avatar-privacy-message')).length) {
        throw new Error('avatar failure message was not rendered')
      }
      if ((await elements(page, '.avatar-error-actions')).length) {
        throw new Error('unsupported avatar state exposed an ineffective retry action')
      }

      stage('AVATAR_CANCEL_RECOVERY')
      await page.callMethod('onChooseAvatar', {
        detail: { errMsg: 'chooseAvatar:fail user cancel' },
      })
      data = await waitForData(page, (next) => next.avatarPrivacyMode === 'native'
        && next.avatarPrivacyError === '')
      if (data.avatarLocalPath !== original.avatarLocalPath || data.avatarPreview !== original.avatarPreview) {
        throw new Error('avatar failure path changed the current avatar')
      }
    })

    await step('AVATAR_MANUAL', '头像授权入口人工跳过', async () => {
      const page = await navigateAndAcquire(miniProgram, '/pages/profile/profile', { method: 'switchTab' })
      await waitForData(page, (next) => next.authState !== 'connecting')
      await waitForElements(page, '.avatar-button')
      return { skip: 'chooseAvatar 由人工设备测试覆盖，自动化不点击' }
    })

    await step('PHONE_AUTH_CANCEL', '手机号授权入口只取消', async () => {
      const page = await navigateAndAcquire(miniProgram, '/pages/profile/profile', { method: 'switchTab' })
      await waitForData(page, (next) => next.authState !== 'connecting')
      await tapControl(page, '.phone-button', 0, 400)
      try {
        await nativeCancelAuthorization()
      } catch (error) {
        if (isFatalSessionError(error)) throw error
        await nativeCancelModal()
      }
      await sleep(300)
      const active = await current('pages/profile/profile')
      const legalRows = await elements(active, '.legal-row')
      if (!legalRows.length || (await active.data()).bindingPhone) throw new Error('profile page not interactive after phone cancel')
    })

    await step('PRIVACY_LEGAL', '隐私说明页与协议互跳', async () => {
      let page = await navigateAndAcquire(miniProgram, '/pages/legal/privacy')
      await sleep(WAIT_MS)
      const buttons = await elements(page, 'button')
      if (!buttons.length) throw new Error('privacy controls missing')
      await tapControl(page, 'button', buttons.length - 1)
      page = await current()
      if (page.path === 'pages/legal/user-agreement') {
        await miniProgram.navigateBack()
        await sleep(WAIT_MS)
      } else {
        await optionalNonFatal(() => miniProgram.native().navigateLeft())
      }
    })

    await step('ACCESS_SAFE', '邀请码登录页当前身份覆盖说明', async () => {
      const page = await navigateAndAcquire(miniProgram, '/pages/access/access', {
        allowedRoutes: ['pages/plan/plan'],
      })
      await sleep(1000)
      const actual = await current()
      if (actual.path === 'pages/plan/plan') return { skip: '当前已加入身份按设计自动进入餐单；不清除身份测试邀请表单' }
      return { skip: '邀请表单需专用未加入测试账号覆盖' }
    })

  } catch (error) {
    fatalError = error
    report.failure = {
      stage: sanitizeCode(error && error.stage, diagnosticStage),
      category: categorizeError(error),
      errorCode: sanitizeCode(error && error.code, 'INTERACTIVE_SMOKE_FAILED'),
      timeoutOrigin: error && error.timeoutOrigin || '',
      message: sanitizeText(error && error.message || 'unknown failure', 240),
    }
  } finally {
    try {
      await restoreMutations()
    } catch (_) {
      report.cleanupFailureCount += 1
      report.cleanupErrorCodes.push('CLEANUP_GLOBAL_FAILED')
    } finally {
      const cleanup = await cleanupAutomatorSession(miniProgram, unsubscribeDiagnostics)
      mergeAutomatorCleanupReport(report, cleanup)
      report.summary = report.steps.reduce((summary, item) => {
        summary[item.status] = (summary[item.status] || 0) + 1
        return summary
      }, {})
      if (!recovery.unresolved().length) recovery.complete()
      const output = finalizeRunReport(run, report)
      report.reportPath = output.reportPath
    }
  }

  if (fatalError) {
    fatalError.reportPath = report.reportPath
    throw fatalError
  }

  process.stdout.write(`REPORT ${report.reportPath || path.join(run.outputDir, 'report.json')}\n`)
  if (report.steps.some((item) => item.status === 'failed') || report.blockingConsoleCount
    || report.exceptionCount || report.cleanupFailureCount) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`INTERACTIVE_SMOKE_FAILED [${sanitizeCode(error && error.code, 'MAIN_FAILED')}] ${sanitizeText(error && error.message || 'unknown failure', 240)}\n`)
  process.exitCode = 1
})
