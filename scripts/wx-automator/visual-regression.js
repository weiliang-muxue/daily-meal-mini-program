'use strict'

const fs = require('fs')
const path = require('path')
const { PNG } = require('pngjs')
const automator = require('./automator-client')
const { assertPngStepperGlyphs, assertStepperButtonGeometry } = require('./visual-pixel-core')
const {
  captureScreenshotWithRetry,
  categorizeError,
  classifyAutomatorDiagnostic,
  cleanupAutomatorSession,
  createRun,
  DEFAULT_SCREENSHOT_ATTEMPTS,
  DEFAULT_SCREENSHOT_TIMEOUT_MS,
  finalizeRunReport,
  isAutomatorResponseTimeout,
  isFatalSessionError,
  LOCAL_AUTOMATOR_DIR,
  mergeAutomatorCleanupReport,
  navigateAndAcquire,
  readAutomatorViewport,
  sanitizeCode,
  sanitizeText,
  subscribeAutomatorDiagnostics,
  TIMEOUT_ORIGIN_DEVTOOLS_RESPONSE,
  withAutomatorResponseTimeout,
} = require('./automation-runtime')

const OUTPUT_BASE = path.join(LOCAL_AUTOMATOR_DIR, 'artifacts', 'visual')
const BOTTOM_EVIDENCE_SELECTORS = Object.freeze({
  plan: ['.plan-actions', '.empty-state', '.status-panel'],
  shopping: ['.reset-button', '.status-panel', '.group'],
  guide: ['.warning', '.reminder-list', '.status-panel', '.reminder-form', '.guide-state'],
  profile: ['.danger-card'],
  'water-reminder': ['.calendar-card', '.save-button', '.status-panel'],
  'user-agreement': ['.legal-section'],
  privacy: ['.legal-link'],
})
const EVIDENCE_ROUTES = Object.freeze({
  plan: 'pages/plan/plan', planner: 'pages/planner/planner', health: 'pages/health/health',
  shopping: 'pages/shopping/shopping', guide: 'pages/guide/guide', profile: 'pages/profile/profile',
  'water-reminder': 'pages/water-reminder/water-reminder',
  'meal-edit': 'pages/meal-edit/meal-edit', 'user-agreement': 'pages/legal/user-agreement',
  privacy: 'pages/legal/privacy',
})
const REQUIRED_EVIDENCE_NAMES = Object.freeze([
  'plan-bottom', 'shopping-bottom', 'guide-bottom', 'profile-bottom',
  'water-reminder-bottom',
  'user-agreement-bottom', 'privacy-bottom',
  'meal-edit-form', 'meal-edit-form-bottom',
  'planner-duration-1', 'planner-duration-14', 'planner-duration-15-error',
  'health-exercise-completed', 'health-weight-trend', 'health-exercise-trend',
  'planner-confirm',
])
const ROUTES = [
  ['access', '/pages/access/access', ['.access-screen', '.access-content']],
  ['plan', '/pages/plan/plan', ['.plan-page']],
  ['planner', '/pages/planner/planner', ['.planner-screen', '.step-head']],
  ['plan-preview', '/pages/plan-preview/plan-preview', ['.preview-page']],
  ['plan-history', '/pages/plan-history/plan-history', ['.history-page']],
  ['health', '/pages/health/health', ['.health-screen']],
  ['shopping', '/pages/shopping/shopping', ['.shopping-screen']],
  ['guide', '/pages/guide/guide', ['.screen']],
  ['profile', '/pages/profile/profile', ['.screen', '.profile-header', '.profile-form']],
  ['water-reminder', '/pages/water-reminder/water-reminder', ['.reminder-screen', '.setting-card', '.master-row']],
  ['meal-edit', '/pages/meal-edit/meal-edit', ['.screen']],
  ['user-agreement', '/pages/legal/user-agreement', ['.legal-screen', '.legal-document']],
  ['privacy', '/pages/legal/privacy', ['.legal-screen', '.legal-document']],
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const RESPONSE_TIMEOUT_MS = 8000
const SCREENSHOT_TIMEOUT_MS = DEFAULT_SCREENSHOT_TIMEOUT_MS

function protocol(operation, stage, timeoutMs = RESPONSE_TIMEOUT_MS) {
  return withAutomatorResponseTimeout(operation, { stage, timeoutMs })
}

async function captureVisualEvidence(miniProgram, targetPath, item, stage) {
  const screenshot = await captureScreenshotWithRetry(miniProgram, targetPath, {
    stage,
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    healthTimeoutMs: RESPONSE_TIMEOUT_MS,
    expectedRoute: item.expectedRoute || EVIDENCE_ROUTES[item.sourcePage] || '',
    allowedRoutes: item.allowedRoutes || [],
  })
  item.screenshotAttempts = screenshot.attempts
  item.screenshotRetried = screenshot.retried
  item.screenshotCaptured = screenshot.captured
  item.screenshotTransient = screenshot.transient
  return screenshot
}

function recordScreenshotFailure(item, error) {
  if (!Number.isSafeInteger(error && error.screenshotAttempts)) return false
  item.screenshotAttempts = error.screenshotAttempts
  item.screenshotRetried = error.screenshotRetried === true
  item.screenshotCaptured = false
  item.screenshotTransient = error.screenshotTransient || null
  return true
}

function isExhaustedDevToolsScreenshot(error) {
  return Number.isSafeInteger(error && error.screenshotAttempts)
    && error.screenshotAttempts === DEFAULT_SCREENSHOT_ATTEMPTS
    && error.timeoutOrigin === TIMEOUT_ORIGIN_DEVTOOLS_RESPONSE
}

async function captureNamedEvidence(miniProgram, run, report, name, stage, details = {}) {
  const { verify, ...publicDetails } = details
  const item = { name, stage, errorCode: '', ...publicDetails }
  report.evidence.push(item)
  const startedAtMs = Date.now()
  const targetPath = path.join(run.outputDir, `${name}.png`)
  try {
    await captureVisualEvidence(
      miniProgram,
      targetPath,
      item,
      stage,
    )
    if (typeof verify === 'function') await verify({ targetPath, item })
    item.stage = 'EVIDENCE_COMPLETED'
    return item
  } catch (error) {
    item.errorCode = sanitizeCode(error && error.code, 'VISUAL_EVIDENCE_FAILED')
    item.category = categorizeError(error)
    item.stage = sanitizeCode(error && error.stage, stage)
    item.error = sanitizeText(error && error.message || 'unknown failure', 240)
    item.timeoutOrigin = error && error.timeoutOrigin || ''
    recordScreenshotFailure(item, error)
    if (isFatalSessionError(error)
      || (isAutomatorResponseTimeout(error) && !isExhaustedDevToolsScreenshot(error))) throw error
    return false
  } finally {
    item.durationMs = Date.now() - startedAtMs
  }
}

async function waitForPageData(page, predicate, stage, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let data = null
  while (Date.now() <= deadline) {
    data = await protocol(() => page.data(), stage)
    if (predicate(data)) return data
    await sleep(250)
  }
  const error = new Error(`page state did not settle during ${stage}`)
  error.stage = stage
  throw error
}

function preferencesForDuration(preferences, durationDays) {
  const existing = Array.isArray(preferences.exerciseByDay) ? preferences.exerciseByDay : []
  return {
    ...preferences,
    durationDays,
    exerciseByDay: Array.from({ length: durationDays }, (_, dayIndex) => existing[dayIndex] || {
      dayIndex,
      planned: false,
      type: '',
      durationMinutes: 0,
      intensity: 'medium',
    }),
  }
}

async function scrollAndCapture(miniProgram, run, report, name, stage, scrollTop, details = {}) {
  await protocol(() => miniProgram.pageScrollTo(scrollTop), `${stage}_SCROLL`)
  await sleep(350)
  if (details.bottomSelectors) {
    await assertPageBottomVisible(miniProgram, details, `${stage}_BOTTOM_VERIFY`)
  }
  return captureNamedEvidence(miniProgram, run, report, name, stage, details)
}

async function optionalProtocol(operation, stage, fallback) {
  try {
    return await protocol(operation, stage)
  } catch (error) {
    if (isAutomatorResponseTimeout(error) || isFatalSessionError(error)) throw error
    return fallback
  }
}

async function lastAvailableElement(page, selectors, stage) {
  for (const selector of selectors) {
    const nodes = await protocol(() => page.$$(selector), `${stage}_SELECT_${selector}`)
    if (Array.isArray(nodes) && nodes.length) return { node: nodes[nodes.length - 1], selector }
  }
  const error = new Error(`bottom evidence selector missing: ${selectors.join(', ')}`)
  error.stage = stage
  throw error
}

async function assertPageBottomVisible(miniProgram, details, stage) {
  const page = await protocol(() => miniProgram.currentPage(), `${stage}_CURRENT_PAGE`)
  const expectedRoute = details.expectedRoute || EVIDENCE_ROUTES[details.sourcePage] || ''
  if (!page || (expectedRoute && page.path !== expectedRoute)) {
    const error = new Error(`bottom evidence route changed to ${page && page.path || 'none'}`)
    error.stage = stage
    throw error
  }
  const { node, selector } = await lastAvailableElement(page, details.bottomSelectors, stage)
  const [offset, size, rawDocumentHeight, rawScrollTop] = await Promise.all([
    protocol(() => node.offset(), `${stage}_OFFSET`),
    protocol(() => node.size(), `${stage}_SIZE`),
    protocol(() => page.windowProperty('document.documentElement.scrollHeight'), `${stage}_DOCUMENT_HEIGHT`),
    protocol(() => page.scrollTop(), `${stage}_SCROLL_TOP`),
  ])
  const viewportHeight = Number(details.viewportHeight)
  const scrollPosition = Number(rawScrollTop) || 0
  // Element.getOffset already returns viewport-relative coordinates.
  const elementTop = Number(offset && offset.top)
  const elementBottom = elementTop + Number(size && size.height)
  const documentHeight = Number(rawDocumentHeight)
  if (!Number.isFinite(viewportHeight) || !Number.isFinite(elementTop)
    || !Number.isFinite(elementBottom) || elementBottom <= 0 || elementTop >= viewportHeight) {
    const error = new Error(`bottom selector ${selector} is outside the viewport`)
    error.stage = stage
    throw error
  }
  if (Number.isFinite(documentHeight) && scrollPosition + viewportHeight < documentHeight - 2) {
    const error = new Error(`page bottom was not reached for ${selector}`)
    error.stage = stage
    throw error
  }
}

function assertPngRegionVariation(targetPath, box, viewport, stage) {
  const png = PNG.sync.read(fs.readFileSync(targetPath))
  const viewportWidth = Number(viewport && viewport.windowWidth)
  const viewportHeight = Number(viewport && viewport.windowHeight)
  if (!viewportWidth || !viewportHeight || !finiteBox(box)) {
    const error = new Error('canvas evidence geometry is invalid')
    error.stage = stage
    throw error
  }
  const scaleX = png.width / viewportWidth
  const scaleY = png.height / viewportHeight
  const left = Math.max(0, Math.floor(box.left * scaleX))
  const top = Math.max(0, Math.floor(box.top * scaleY))
  const right = Math.min(png.width, Math.ceil((box.left + box.width) * scaleX))
  const bottom = Math.min(png.height, Math.ceil((box.top + box.height) * scaleY))
  const colors = new Map()
  let pixels = 0
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      const index = (png.width * y + x) << 2
      if (png.data[index + 3] < 128) continue
      const color = `${png.data[index] >> 3}:${png.data[index + 1] >> 3}:${png.data[index + 2] >> 3}`
      colors.set(color, (colors.get(color) || 0) + 1)
      pixels += 1
    }
  }
  const dominant = Math.max(0, ...colors.values())
  const varied = pixels - dominant
  if (colors.size < 3 || varied < Math.max(20, Math.round(pixels * 0.002))) {
    const error = new Error('trend canvas screenshot region has no verified drawing variation')
    error.stage = stage
    throw error
  }
  return { colorBuckets: colors.size, variedPixels: varied }
}

async function canvasViewportBox(page, selector, stage) {
  const nodes = await protocol(() => page.$$(selector), `${stage}_SELECT`)
  if (!nodes.length) {
    const error = new Error(`canvas selector missing: ${selector}`)
    error.stage = stage
    throw error
  }
  const [offset, size] = await Promise.all([
    protocol(() => nodes[0].offset(), `${stage}_OFFSET`),
    protocol(() => nodes[0].size(), `${stage}_SIZE`),
  ])
  return {
    left: Number(offset && offset.left),
    top: Number(offset && offset.top),
    width: Number(size && size.width),
    height: Number(size && size.height),
  }
}

async function prepareTrendCanvas(page, stage) {
  await protocol(() => page.callMethod('measureTrendCanvas'), `${stage}_MEASURE`)
  await sleep(500)
  await protocol(() => page.callMethod('drawTrend'), `${stage}_DRAW`)
  await sleep(200)
}

function finiteBox(value) {
  return value && ['left', 'top', 'width', 'height'].every((key) => Number.isFinite(Number(value[key])))
}

async function inspect(page, selector, viewport) {
  const nodes = await protocol(() => page.$$(selector), `SELECT_${selector}`)
  if (!Array.isArray(nodes) || !nodes.length) throw new Error(`required selector missing: ${selector}`)
  const results = []
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    const offset = await optionalProtocol(() => node.offset(), 'READ_NODE_OFFSET', null)
    const size = await optionalProtocol(() => node.size(), 'READ_NODE_SIZE', null)
    const box = offset && size ? { left: offset.left, top: offset.top, width: size.width, height: size.height } : null
    results.push({
      selector,
      index,
      box,
      display: await optionalProtocol(() => node.style('display'), 'READ_NODE_STYLE', ''),
      overflowX: finiteBox(box) ? box.left < -1 || box.left + box.width > viewport.windowWidth + 1 : null,
    })
  }
  return results
}

async function captureMealEditEvidence(miniProgram, run, report) {
  let plan = await navigateAndAcquire(miniProgram, '/pages/plan/plan', {
    timeoutMs: 12000,
    responseTimeoutMs: RESPONSE_TIMEOUT_MS,
  })
  const planData = await waitForPageData(
    plan,
    (data) => data.loading === false,
    'MEAL_EDIT_EVIDENCE_WAIT_PLAN',
  )
  const selectedDay = planData.selectedDay
  const meal = selectedDay && Array.isArray(selectedDay.meals) ? selectedDay.meals[0] : null
  const mealId = meal && (meal.mealId || meal.id)
  if (!mealId) {
    const error = new Error('confirmed plan has no editable meal for visual evidence')
    error.stage = 'MEAL_EDIT_EVIDENCE_PRECONDITION'
    throw error
  }
  await protocol(() => plan.callMethod('editMeal', {
    detail: { mealId },
    currentTarget: { dataset: { id: mealId } },
  }), 'MEAL_EDIT_EVIDENCE_OPEN')
  const deadline = Date.now() + 12000
  let editor = null
  while (Date.now() <= deadline) {
    editor = await protocol(() => miniProgram.currentPage(), 'MEAL_EDIT_EVIDENCE_CURRENT_PAGE')
    if (editor && editor.path === 'pages/meal-edit/meal-edit') break
    await sleep(200)
  }
  if (!editor || editor.path !== 'pages/meal-edit/meal-edit') {
    const error = new Error('meal editor route did not open for visual evidence')
    error.stage = 'MEAL_EDIT_EVIDENCE_ROUTE'
    throw error
  }
  const editorData = await waitForPageData(
    editor,
    (data) => data.loading === false,
    'MEAL_EDIT_EVIDENCE_WAIT_EDITOR',
  )
  if (editorData.error) {
    const error = new Error('meal editor did not load the confirmed meal')
    error.stage = 'MEAL_EDIT_EVIDENCE_LOAD'
    throw error
  }
  await protocol(() => miniProgram.pageScrollTo(0), 'MEAL_EDIT_EVIDENCE_TOP_SCROLL')
  await sleep(350)
  await captureNamedEvidence(
    miniProgram,
    run,
    report,
    'meal-edit-form',
    'MEAL_EDIT_EVIDENCE_TOP',
    { sourcePage: 'meal-edit', state: 'loaded-form' },
  )
  await scrollAndCapture(
    miniProgram,
    run,
    report,
    'meal-edit-form-bottom',
    'MEAL_EDIT_EVIDENCE_BOTTOM',
    10000,
    {
      sourcePage: 'meal-edit', state: 'loaded-form-bottom', expectedRoute: 'pages/meal-edit/meal-edit',
      bottomSelectors: ['.reset', '.save'], viewportHeight: report.viewport.windowHeight,
    },
  )
}

async function capturePlannerDurationEvidence(miniProgram, run, report) {
  const planner = await navigateAndAcquire(miniProgram, '/pages/planner/planner', {
    timeoutMs: 12000,
    responseTimeoutMs: RESPONSE_TIMEOUT_MS,
  })
  const initial = await waitForPageData(
    planner,
    (data) => data.loadingPage === false && data.recoverySettled === true,
    'PLANNER_DURATION_EVIDENCE_WAIT',
  )
  const assertStepperLayout = async (stage) => {
    const buttons = await protocol(() => planner.$$('.duration-button'), `${stage}_SELECT_BUTTONS`)
    if (!Array.isArray(buttons) || buttons.length !== 2) {
      const error = new Error('planner duration stepper buttons are missing')
      error.stage = stage
      throw error
    }
    const expectedText = ['−', '+']
    const boxes = []
    for (let index = 0; index < buttons.length; index += 1) {
      const [offset, size, content] = await Promise.all([
        protocol(() => buttons[index].offset(), `${stage}_BUTTON_${index}_OFFSET`),
        protocol(() => buttons[index].size(), `${stage}_BUTTON_${index}_SIZE`),
        protocol(() => buttons[index].text(), `${stage}_BUTTON_${index}_TEXT`),
      ])
      const left = Number(offset && offset.left)
      const top = Number(offset && offset.top)
      const width = Number(size && size.width)
      const height = Number(size && size.height)
      if (String(content || '').trim() !== expectedText[index]) {
        const error = new Error(`planner duration button ${index} is outside its stable touch target`)
        error.stage = stage
        throw error
      }
      boxes.push({ left, top, width, height })
    }
    return assertStepperButtonGeometry(boxes, report.viewport, stage)
  }
  const assertDurationState = async (durationDays, stage, options = {}) => {
    const state = await protocol(() => planner.data(), `${stage}_READ`)
    const expectedInput = options.input === undefined ? String(durationDays) : String(options.input)
    const expectsError = options.error === true
    if (state.currentStep !== 1 || state.preferences.durationDays !== durationDays
      || state.durationDaysInput !== expectedInput || Boolean(state.durationDaysError) !== expectsError
      || state.durationAtMin !== (durationDays === 1) || state.durationAtMax !== (durationDays === 14)) {
      const error = new Error(`planner duration ${expectedInput} visual state is inconsistent`)
      error.stage = stage
      throw error
    }
    const stepperBoxes = await assertStepperLayout(`${stage}_LAYOUT`)
    return { state, stepperBoxes }
  }
  const renderDuration = async (durationDays, name) => {
    await protocol(() => planner.setData({
      currentStep: 1,
      taskVisible: false,
      formControlFocused: false,
      durationDaysInput: String(durationDays),
      durationDaysError: '',
      durationDaysFeedback: '',
      stepError: '',
    }), `PLANNER_DURATION_${durationDays}_SET_STEP`)
    await protocol(
      () => planner.callMethod('renderPreferences', preferencesForDuration(initial.preferences, durationDays)),
      `PLANNER_DURATION_${durationDays}_RENDER`,
    )
    await protocol(() => miniProgram.pageScrollTo(0), `PLANNER_DURATION_${durationDays}_SCROLL`)
    await sleep(250)
    const { stepperBoxes } = await assertDurationState(durationDays, `PLANNER_DURATION_${durationDays}_VERIFY`)
    await captureNamedEvidence(
      miniProgram,
      run,
      report,
      name,
      `PLANNER_DURATION_${durationDays}_SCREENSHOT`,
      {
        sourcePage: 'planner', state: `${durationDays}-days`,
        verify: async ({ targetPath, item }) => {
          await assertDurationState(durationDays, `PLANNER_DURATION_${durationDays}_POST_SCREENSHOT`)
          item.glyphEvidence = assertPngStepperGlyphs(
            targetPath, stepperBoxes, report.viewport, `PLANNER_DURATION_${durationDays}_GLYPH_PIXELS`,
          )
        },
      },
    )
  }
  await renderDuration(1, 'planner-duration-1')
  await renderDuration(14, 'planner-duration-14')
  await protocol(
    () => planner.callMethod('inputDurationDays', { detail: { value: '15' } }),
    'PLANNER_DURATION_15_INPUT',
  )
  const invalid = await waitForPageData(
    planner,
    (data) => data.durationDaysInput === '15' && Boolean(data.durationDaysError),
    'PLANNER_DURATION_15_WAIT_ERROR',
  )
  if (invalid.preferences.durationDays === 15) {
    const error = new Error('planner accepted invalid 15 day visual state')
    error.stage = 'PLANNER_DURATION_15_VERIFY'
    throw error
  }
  await protocol(() => miniProgram.pageScrollTo(0), 'PLANNER_DURATION_15_SCROLL')
  await sleep(250)
  const { stepperBoxes: invalidStepperBoxes } = await assertDurationState(
    invalid.preferences.durationDays,
    'PLANNER_DURATION_15_VERIFY',
    { input: 15, error: true },
  )
  await captureNamedEvidence(
    miniProgram,
    run,
    report,
    'planner-duration-15-error',
    'PLANNER_DURATION_15_SCREENSHOT',
    {
      sourcePage: 'planner', state: '15-days-error',
      verify: async ({ targetPath, item }) => {
        await assertDurationState(
          invalid.preferences.durationDays,
          'PLANNER_DURATION_15_POST_SCREENSHOT',
          { input: 15, error: true },
        )
        item.glyphEvidence = assertPngStepperGlyphs(
          targetPath, invalidStepperBoxes, report.viewport, 'PLANNER_DURATION_15_GLYPH_PIXELS',
        )
      },
    },
  )
}

async function captureHealthCompletedEvidence(miniProgram, run, report) {
  const health = await navigateAndAcquire(miniProgram, '/pages/health/health', {
    timeoutMs: 12000,
    responseTimeoutMs: RESPONSE_TIMEOUT_MS,
  })
  const initial = await waitForPageData(
    health,
    (data) => data.loading === false && !data.error,
    'HEALTH_EVIDENCE_WAIT',
  )
  const month = /^\d{4}-\d{2}$/.test(initial.month) ? initial.month : '2026-08'
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(year, monthNumber, 0).getDate()
  const selectedDay = Math.min(25, lastDay)
  const sampleDays = [selectedDay - 6, selectedDay - 4, selectedDay - 2, selectedDay]
  const sampleDate = (day) => `${month}-${String(day).padStart(2, '0')}`
  const records = [
    { date: sampleDate(sampleDays[0]), weight: 62.1, exercise: { completed: true, type: '快走', durationMinutes: 35, intensity: 'medium' } },
    { date: sampleDate(sampleDays[1]), weight: 61.9, exercise: null },
    { date: sampleDate(sampleDays[2]), weight: 61.8, exercise: { completed: true, type: '骑车', durationMinutes: 30, intensity: 'medium' } },
    { date: sampleDate(sampleDays[3]), weight: 61.6, exercise: { completed: true, type: '抗阻训练', durationMinutes: 45, intensity: 'high' } },
  ]
  await protocol(() => health.setData({ records }), 'HEALTH_EVIDENCE_SET_RECORDS')
  await protocol(() => health.callMethod('renderCalendar'), 'HEALTH_EVIDENCE_RENDER_CALENDAR')
  const selectedRecord = records[records.length - 1]
  await protocol(() => health.setData({
    selectedDate: selectedRecord.date,
    selectedRecord,
    selectedRecordRevision: 1,
    weight: String(selectedRecord.weight),
    note: '',
    exerciseCompleted: true,
    exerciseTypeIndex: 2,
    exerciseDuration: '45',
    exerciseIntensity: 'high',
    savedExerciseCompleted: true,
    exerciseDirty: false,
    exerciseStatus: '已打卡',
    exerciseStatusTone: 'saved',
    exerciseStatusSymbol: '✓',
    exerciseStatusHint: '已保存，月历已显示运动标记',
    saveButtonText: '保存当天记录',
    trendMode: 'week',
    trendMetric: 'weight',
    trendRecords: records,
    trendSummary: '62.1 → 61.6 kg，变化 -0.5 kg',
    weekExerciseCount: 3,
    weekExerciseMinutes: 110,
    hasWeekExercise: true,
    monthExerciseCount: 3,
    monthExerciseMinutes: 110,
    hasMonthExercise: true,
  }), 'HEALTH_EVIDENCE_SET_PRESENTATION')
  await prepareTrendCanvas(health, 'HEALTH_EVIDENCE_WEIGHT_CANVAS')
  await protocol(() => miniProgram.pageScrollTo(0), 'HEALTH_EVIDENCE_TOP_SCROLL')
  await sleep(350)
  await captureNamedEvidence(
    miniProgram,
    run,
    report,
    'health-exercise-completed',
    'HEALTH_EVIDENCE_COMPLETED_SCREENSHOT',
    { sourcePage: 'health', state: 'exercise-completed' },
  )
  const trendCards = await protocol(() => health.$$('.trend-card'), 'HEALTH_EVIDENCE_SELECT_TREND')
  if (!trendCards.length) {
    const error = new Error('health trend card is missing')
    error.stage = 'HEALTH_EVIDENCE_TREND_MISSING'
    throw error
  }
  const trendOffset = await protocol(() => trendCards[0].offset(), 'HEALTH_EVIDENCE_TREND_OFFSET')
  const trendScrollTop = Math.max(0, Number(trendOffset && trendOffset.top || 0) - 70)
  await protocol(() => miniProgram.pageScrollTo(trendScrollTop), 'HEALTH_EVIDENCE_WEIGHT_TREND_SCROLL')
  await sleep(350)
  const weightCanvasBox = await canvasViewportBox(health, '#weightChart', 'HEALTH_EVIDENCE_WEIGHT_CANVAS_BOX')
  await scrollAndCapture(
    miniProgram,
    run,
    report,
    'health-weight-trend',
    'HEALTH_EVIDENCE_WEIGHT_TREND',
    trendScrollTop,
    {
      sourcePage: 'health', state: 'week-weight-trend',
      verify: ({ targetPath, item }) => {
        item.pixelEvidence = assertPngRegionVariation(
          targetPath, weightCanvasBox, report.viewport, 'HEALTH_EVIDENCE_WEIGHT_PIXELS',
        )
      },
    },
  )
  await protocol(() => health.setData({
    trendMetric: 'exercise',
    trendSummary: '3 次运动，共 110 分钟',
  }), 'HEALTH_EVIDENCE_SET_EXERCISE_TREND')
  await prepareTrendCanvas(health, 'HEALTH_EVIDENCE_EXERCISE_CANVAS')
  const exerciseCanvasBox = await canvasViewportBox(health, '#weightChart', 'HEALTH_EVIDENCE_EXERCISE_CANVAS_BOX')
  await captureNamedEvidence(
    miniProgram,
    run,
    report,
    'health-exercise-trend',
    'HEALTH_EVIDENCE_EXERCISE_TREND',
    {
      sourcePage: 'health', state: 'week-exercise-trend',
      verify: ({ targetPath, item }) => {
        item.pixelEvidence = assertPngRegionVariation(
          targetPath, exerciseCanvasBox, report.viewport, 'HEALTH_EVIDENCE_EXERCISE_PIXELS',
        )
      },
    },
  )
}

async function main() {
  fs.mkdirSync(OUTPUT_BASE, { recursive: true })
  const run = createRun('visual', OUTPUT_BASE)
  fs.mkdirSync(run.outputDir, { recursive: true })
  const report = {
    viewport: null, pages: [], evidence: [], console: [], exceptions: [],
    cleanupFailureCount: 0, cleanupErrorCodes: [],
  }
  let miniProgram = null
  let unsubscribeDiagnostics = null
  let fatalError = null
  let reportPath = ''
  let currentStage = 'SESSION_CONNECT'
  try {
    miniProgram = await automator.connect()
    currentStage = 'ENABLE_CONSOLE_LOG'
    unsubscribeDiagnostics = await subscribeAutomatorDiagnostics(miniProgram, {
      console: (entry) => {
        const diagnostic = classifyAutomatorDiagnostic(entry)
        if (diagnostic.observed) report.console.push({
          level: diagnostic.level,
          category: diagnostic.category,
          text: diagnostic.text,
        })
      },
      exception: () => report.exceptions.push('EXCEPTION'),
    })
    currentStage = 'INITIAL_CURRENT_PAGE'
    const initialPage = await protocol(() => miniProgram.currentPage(), currentStage)
    currentStage = 'INITIAL_VIEWPORT'
    report.viewport = await readAutomatorViewport(miniProgram, initialPage, {
      stage: currentStage,
      timeoutMs: RESPONSE_TIMEOUT_MS,
    })
    for (const [name, route, selectors] of ROUTES) {
      const item = {
        name, expectedRoute: route.slice(1), route: '', selectors: [], errorCode: '',
        allowedRoutes: name === 'access' ? ['pages/plan/plan'] : [],
        expectedMemberRedirect: false, stage: 'ROUTE_NAVIGATION', durationMs: 0,
      }
      report.pages.push(item)
      const pageStartedAtMs = Date.now()
      try {
        currentStage = item.stage
        let page = await navigateAndAcquire(miniProgram, route, {
          allowedRoutes: item.allowedRoutes,
          timeoutMs: 12000,
          responseTimeoutMs: RESPONSE_TIMEOUT_MS,
        })
        await sleep(1800)
        item.stage = 'REACQUIRE_CURRENT_PAGE'
        currentStage = item.stage
        page = await protocol(() => miniProgram.currentPage(), item.stage)
        item.route = page && page.path || ''
        if (name === 'access' && item.route === 'pages/plan/plan') {
          item.expectedMemberRedirect = true
          item.stage = 'ROUTE_COMPLETED'
          continue
        }
        if (item.route !== item.expectedRoute) {
          throw new Error(`unexpected route ${item.route || 'none'}`)
        }
        try {
          item.stage = 'INSPECT_LAYOUT'
          currentStage = item.stage
          for (const selector of selectors) item.selectors.push(...await inspect(page, selector, report.viewport))
        } catch (error) {
          if (isFatalSessionError(error)) throw error
          if (name !== 'access') throw error
          let latestPage = null
          try {
            latestPage = await protocol(() => miniProgram.currentPage(), 'ACCESS_REDIRECT_CURRENT_PAGE')
          } catch (probeError) {
            if (isFatalSessionError(probeError)) throw probeError
            throw error
          }
          item.route = latestPage && latestPage.path || item.route
          if (item.route !== 'pages/plan/plan') throw error
          item.expectedMemberRedirect = true
          item.stage = 'ROUTE_COMPLETED'
          continue
        }
        item.stage = 'CAPTURE_SCREENSHOT'
        currentStage = item.stage
        await captureVisualEvidence(miniProgram, path.join(run.outputDir, `${name}.png`), item, item.stage)
        if (BOTTOM_EVIDENCE_SELECTORS[name]) {
          await scrollAndCapture(
            miniProgram,
            run,
            report,
            `${name}-bottom`,
            `${sanitizeCode(name, 'PAGE')}_BOTTOM_SCREENSHOT`,
            10000,
            {
              sourcePage: name, state: 'bottom', expectedRoute: item.expectedRoute,
              bottomSelectors: BOTTOM_EVIDENCE_SELECTORS[name], viewportHeight: report.viewport.windowHeight,
            },
          )
        }
        item.stage = 'ROUTE_COMPLETED'
      } catch (error) {
        item.errorCode = 'PAGE_VISUAL_CHECK_FAILED'
        item.category = categorizeError(error)
        item.stage = sanitizeCode(error && error.stage, item.stage)
        item.error = sanitizeText(error && error.message || 'unknown failure', 240)
        item.timeoutOrigin = error && error.timeoutOrigin || ''
        const screenshotFailure = recordScreenshotFailure(item, error)
        const exhaustedDevToolsScreenshot = screenshotFailure
          && error.screenshotAttempts === DEFAULT_SCREENSHOT_ATTEMPTS
          && error.timeoutOrigin === TIMEOUT_ORIGIN_DEVTOOLS_RESPONSE
        if (isFatalSessionError(error)
          || (isAutomatorResponseTimeout(error) && !exhaustedDevToolsScreenshot)) throw error
      } finally {
        item.durationMs = Date.now() - pageStartedAtMs
      }
    }

    currentStage = 'PLANNER_DURATION_EVIDENCE'
    await capturePlannerDurationEvidence(miniProgram, run, report)

    currentStage = 'HEALTH_COMPLETED_EVIDENCE'
    await captureHealthCompletedEvidence(miniProgram, run, report)

    currentStage = 'MEAL_EDIT_FORM_EVIDENCE'
    await captureMealEditEvidence(miniProgram, run, report)

    currentStage = 'PLANNER_CONFIRM_NAVIGATION'
    let planner = await navigateAndAcquire(miniProgram, '/pages/planner/planner')
    const plannerDeadline = Date.now() + 30000
    while (Date.now() < plannerDeadline) {
      currentStage = 'PLANNER_CONFIRM_CURRENT_PAGE'
      planner = await protocol(() => miniProgram.currentPage(), currentStage)
      currentStage = 'PLANNER_CONFIRM_LOADING_STATE'
      const loadingPage = await protocol(() => planner.data('loadingPage'), currentStage)
      currentStage = 'PLANNER_CONFIRM_AI_STATUS'
      const aiStatus = await protocol(() => planner.data('aiStatus'), currentStage)
      if (loadingPage === false && ['ready', 'unconfigured', 'error'].includes(aiStatus)) break
      await sleep(250)
    }
    currentStage = 'PLANNER_CONFIRM_FINAL_STATE'
    if (await protocol(() => planner.data('loadingPage'), currentStage) !== false) throw new Error('planner confirmation state did not load')
    if (await protocol(() => planner.data('aiStatus'), currentStage) !== 'ready') throw new Error('planner confirmation service is not ready')
    if (!await protocol(() => planner.data('providerDisplayName'), currentStage)) throw new Error('planner confirmation provider is missing')
    currentStage = 'PLANNER_CONFIRM_SET_STATE'
    await protocol(() => planner.setData({
      currentStep: 5,
      taskVisible: false,
      formControlFocused: false,
      aiDataConsentAccepted: true,
    }), currentStage)
    currentStage = 'PLANNER_CONFIRM_READ_DATA'
    const plannerData = await protocol(() => planner.data(), currentStage)
    currentStage = 'PLANNER_CONFIRM_RENDER_PREFERENCES'
    await protocol(() => planner.callMethod('renderPreferences', plannerData.preferences), currentStage)
    await sleep(250)
    currentStage = 'PLANNER_CONFIRM_CONSENT_STATE'
    if (await protocol(() => planner.data('aiDataConsentAccepted'), currentStage) !== true) throw new Error('planner confirmation consent state missing')
    const privacyScope = await protocol(() => planner.$$('.privacy-scope'), 'PLANNER_CONFIRM_PRIVACY_SCOPE')
    const consentRows = await protocol(() => planner.$$('.ai-consent-row.selected'), 'PLANNER_CONFIRM_CONSENT_ROW')
    if (!privacyScope.length || !consentRows.length) {
      throw new Error('planner confirmation details missing')
    }
    currentStage = 'PLANNER_CONFIRM_SCREENSHOT'
    await scrollAndCapture(
      miniProgram, run, report, 'planner-confirm', currentStage, 10000,
      {
        sourcePage: 'planner', state: 'confirmation', expectedRoute: 'pages/planner/planner',
        bottomSelectors: ['.bottom-actions'], viewportHeight: report.viewport.windowHeight,
      },
    )
  } catch (error) {
    fatalError = error
    report.failure = {
      stage: sanitizeCode(error && error.stage, currentStage),
      category: categorizeError(error),
      errorCode: sanitizeCode(error && error.code, 'VISUAL_REGRESSION_FAILED'),
      timeoutOrigin: error && error.timeoutOrigin || '',
      screenshotAttempts: Number.isSafeInteger(error && error.screenshotAttempts) ? error.screenshotAttempts : null,
      screenshotRetried: error && error.screenshotRetried === true,
      screenshotCaptured: error && error.screenshotCaptured === true,
      screenshotTransient: error && error.screenshotTransient || null,
      message: sanitizeText(error && error.message || 'unknown failure', 240),
    }
  } finally {
    const cleanup = await cleanupAutomatorSession(miniProgram, unsubscribeDiagnostics)
    mergeAutomatorCleanupReport(report, cleanup)
    const output = finalizeRunReport(run, report)
    reportPath = output.reportPath
  }
  if (fatalError) {
    fatalError.reportPath = reportPath
    throw fatalError
  }
  const overflow = report.pages.flatMap((page) => page.selectors.filter((item) => item.overflowX))
  const failures = report.pages.filter((page) => page.errorCode)
  const evidenceFailures = report.evidence.filter((item) => item.errorCode)
  const evidenceCounts = report.evidence.reduce((counts, item) => {
    counts[item.name] = (counts[item.name] || 0) + 1
    return counts
  }, {})
  const missingEvidence = REQUIRED_EVIDENCE_NAMES.filter((name) => evidenceCounts[name] !== 1
    || !report.evidence.some((item) => item.name === name && item.screenshotCaptured === true && !item.errorCode))
  const blockingConsole = report.console.filter((entry) => entry.category !== 'DEVTOOLS_PERFORMANCE_NOTICE')
  process.stdout.write(JSON.stringify({
    viewport: {
      windowWidth: report.viewport.windowWidth,
      windowHeight: report.viewport.windowHeight,
      platform: report.viewport.platform,
      source: report.viewport.source,
    },
    pages: report.pages.map((page) => ({
      name: page.name, route: page.route, nodeCount: page.selectors.length,
      expectedMemberRedirect: page.expectedMemberRedirect, errorCode: page.errorCode,
      screenshotAttempts: page.screenshotAttempts,
      screenshotRetried: page.screenshotRetried,
      screenshotCaptured: page.screenshotCaptured,
    })),
    failureCount: failures.length,
    evidenceCount: report.evidence.length,
    evidenceFailureCount: evidenceFailures.length,
    missingEvidence,
    evidence: report.evidence.map((item) => ({
      name: item.name,
      sourcePage: item.sourcePage,
      state: item.state,
      errorCode: item.errorCode,
      screenshotAttempts: item.screenshotAttempts,
      screenshotRetried: item.screenshotRetried,
      screenshotCaptured: item.screenshotCaptured,
    })),
    overflowCount: overflow.length,
    consoleCount: report.console.length,
    blockingConsoleCount: blockingConsole.length,
    consoleCategories: [...new Set(report.console.map((entry) => entry.category))],
    exceptionCount: report.exceptions.length,
    cleanupFailureCount: report.cleanupFailureCount,
    outputDir: run.outputDir,
    reportPath,
  }, null, 2) + '\n')
  if (failures.length || evidenceFailures.length || missingEvidence.length
    || overflow.length || blockingConsole.length || report.exceptions.length || report.cleanupFailureCount) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`VISUAL_REGRESSION_FAILED ${sanitizeText(error && error.message || 'unknown failure', 240)}\n`)
  process.exitCode = 1
})
