'use strict'

const fs = require('fs')
const path = require('path')
const automator = require('./automator-client')
const {
  captureScreenshotWithRetry,
  categorizeError,
  classifyAutomatorDiagnostic,
  cleanupAutomatorSession,
  createRun,
  DEFAULT_SCREENSHOT_TIMEOUT_MS,
  finalizeRunReport,
  isAutomatorResponseTimeout,
  isFatalSessionError,
  LOCAL_AUTOMATOR_DIR,
  mergeAutomatorCleanupReport,
  navigateAndAcquire,
  PROJECT_ROOT,
  sanitizeCode,
  sanitizeRoute,
  subscribeAutomatorDiagnostics,
  withAutomatorResponseTimeout,
} = require('./automation-runtime')

const PROJECT_PATH = PROJECT_ROOT
const CLI_PATH = process.env.WECHAT_DEVTOOLS_CLI || 'D:\\WeChatDevTools\\cli.bat'
const OUTPUT_BASE = path.join(LOCAL_AUTOMATOR_DIR, 'artifacts', 'smoke')
const ROUTES = [
  'pages/access/access',
  'pages/plan/plan',
  'pages/planner/planner',
  'pages/plan-preview/plan-preview',
  'pages/plan-history/plan-history',
  'pages/health/health',
  'pages/shopping/shopping',
  'pages/guide/guide',
  'pages/profile/profile',
  'pages/meal-edit/meal-edit',
  'pages/legal/user-agreement',
  'pages/legal/privacy',
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const RESPONSE_TIMEOUT_MS = 12000
const SCREENSHOT_TIMEOUT_MS = DEFAULT_SCREENSHOT_TIMEOUT_MS

function routeError(expectedRoutes, actualRoute, stage) {
  const actual = sanitizeRoute(actualRoute)
  if (expectedRoutes.has(actual)) return null
  const error = new Error(`Expected route ${[...expectedRoutes].join(' or ')}, received ${actual || 'none'}`)
  error.code = 'AUTOMATOR_ROUTE_MISMATCH'
  error.stage = stage
  return error
}

function sanitize(value) {
  return String(value == null ? '' : value)
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]')
    .replace(/\b(?:openid|unionid|memberRef|inviteRef|cacheNamespace)\s*[:=]\s*[^\s,}]+/gi, '$1=[REDACTED]')
    .replace(/\b1\d{10}\b/g, '[REDACTED_PHONE]')
    .slice(0, 1200)
}

function selectPublicState(data) {
  const source = data && typeof data === 'object' ? data : {}
  const keys = [
    'loading', 'loadingPage', 'error', 'pageError', 'checkError', 'stepError',
    'viewState', 'emptyKind', 'authState', 'membersState', 'aiStatus',
    'currentStep', 'stepNumber', 'stepCount', 'hasPlan', 'hasDraft',
    'isOwner', 'memberRole', 'saving', 'generating', 'taskVisible',
    'avatarPrivacyMode', 'avatarPrivacyTone', 'avatarPrivacyError',
  ]
  const result = {}
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const value = source[key]
    result[key] = typeof value === 'string' ? sanitize(value) : value
  }
  return result
}

async function count(page, selector) {
  try {
    const elements = await withAutomatorResponseTimeout(() => page.$$(selector), {
      stage: `SELECT_${selector}`,
      timeoutMs: RESPONSE_TIMEOUT_MS,
    })
    return Array.isArray(elements) ? elements.length : 0
  } catch (error) {
    if (isAutomatorResponseTimeout(error) || isFatalSessionError(error)) throw error
    return -1
  }
}

async function main() {
  fs.mkdirSync(OUTPUT_BASE, { recursive: true })
  const run = createRun('smoke', OUTPUT_BASE)
  fs.mkdirSync(run.outputDir, { recursive: true })
  const report = {
    routes: [],
    consoleErrors: [],
    exceptions: [],
    cleanupFailureCount: 0,
    cleanupErrorCodes: [],
  }
  let miniProgram = null
  let unsubscribeDiagnostics = null
  let fatalError = null
  let reportPath = ''
  let currentStage = 'SESSION_CONNECT'
  try {
    miniProgram = process.env.WECHAT_AUTOMATOR_CONNECT === '1'
      ? await automator.connect()
      : await automator.launch({
          cliPath: CLI_PATH,
          projectPath: PROJECT_PATH,
          port: Number(new URL(automator.getEndpoint()).port || 9431),
          trustProject: true,
          timeout: 60000,
        })

    currentStage = 'ENABLE_CONSOLE_LOG'
    unsubscribeDiagnostics = await subscribeAutomatorDiagnostics(miniProgram, {
      console: (entry) => {
        const diagnostic = classifyAutomatorDiagnostic(entry)
        if (!diagnostic.observed) return
        report.consoleErrors.push({
          type: diagnostic.level,
          text: diagnostic.text,
          category: diagnostic.category,
        })
      },
      exception: (entry) => {
        report.exceptions.push(sanitize(entry && (entry.message || entry.description || entry)))
      },
    })

    for (const route of ROUTES) {
      const expected = `/${route}`
      const allowedRoutes = route === 'pages/access/access' ? ['pages/plan/plan'] : []
      const expectedRoutes = new Set([route, ...allowedRoutes])
      let page
      const routeStartedAtMs = Date.now()
      const item = {
        expected,
        actualPath: '',
        navigationError: '',
        durationMs: 0,
        stage: 'ROUTE_NAVIGATION',
        category: 'PENDING',
        errorCode: '',
      }
      report.routes.push(item)
      try {
        currentStage = item.stage
        page = await navigateAndAcquire(miniProgram, expected, {
          allowedRoutes,
          timeoutMs: 12000,
          responseTimeoutMs: RESPONSE_TIMEOUT_MS,
        })
        await sleep(1800)
        item.stage = 'REACQUIRE_CURRENT_PAGE'
        currentStage = item.stage
        page = await withAutomatorResponseTimeout(() => miniProgram.currentPage(), {
          stage: item.stage,
          timeoutMs: RESPONSE_TIMEOUT_MS,
        })
        item.actualPath = sanitizeRoute(page && page.path)
        const acquiredRouteError = routeError(expectedRoutes, item.actualPath, item.stage)
        if (acquiredRouteError) throw acquiredRouteError
        item.stage = 'READ_PAGE_DATA'
        currentStage = item.stage
        let data = {}
        try {
          data = await withAutomatorResponseTimeout(() => page.data(), {
            stage: item.stage,
            timeoutMs: RESPONSE_TIMEOUT_MS,
          })
        } catch (error) {
          if (isAutomatorResponseTimeout(error) || isFatalSessionError(error)) throw error
        }
        item.state = selectPublicState(data)
        item.stage = 'COUNT_PAGE_CONTROLS'
        currentStage = item.stage
        item.controls = {
          button: await count(page, 'button'),
          input: await count(page, 'input'),
          textarea: await count(page, 'textarea'),
          picker: await count(page, 'picker'),
          switch: await count(page, 'switch'),
          checkbox: await count(page, 'checkbox'),
          radio: await count(page, 'radio'),
          touchTarget: await count(page, '.touch-target'),
        }
        item.stage = 'VERIFY_SCREENSHOT_ROUTE'
        currentStage = item.stage
        page = await withAutomatorResponseTimeout(() => miniProgram.currentPage(), {
          stage: item.stage,
          timeoutMs: RESPONSE_TIMEOUT_MS,
        })
        item.actualPath = sanitizeRoute(page && page.path)
        const screenshotRouteError = routeError(expectedRoutes, item.actualPath, item.stage)
        if (screenshotRouteError) throw screenshotRouteError
        const screenshotName = route.replace(/\//g, '__') + '.png'
        item.screenshot = screenshotName
        item.stage = 'CAPTURE_SCREENSHOT'
        currentStage = item.stage
        const screenshot = await captureScreenshotWithRetry(
          miniProgram,
          path.join(run.outputDir, screenshotName),
          {
            stage: item.stage,
            timeoutMs: SCREENSHOT_TIMEOUT_MS,
            healthTimeoutMs: RESPONSE_TIMEOUT_MS,
            expectedRoute: route,
            allowedRoutes,
          },
        )
        item.screenshotAttempts = screenshot.attempts
        item.screenshotRetried = screenshot.retried
        item.screenshotCaptured = screenshot.captured
        item.screenshotTransient = screenshot.transient
        item.stage = 'ROUTE_COMPLETED'
        item.category = 'PASSED'
      } catch (error) {
        item.actualPath = sanitizeRoute(page && page.path) || item.actualPath
        item.navigationError = sanitize(error && error.message)
        item.errorCode = sanitizeCode(error && error.code, 'ROUTE_CHECK_FAILED')
        item.stage = sanitizeCode(error && error.stage, item.stage)
        item.category = categorizeError(error)
        item.timeoutOrigin = error && error.timeoutOrigin || ''
        if (Number.isSafeInteger(error && error.screenshotAttempts)) {
          item.screenshotAttempts = error.screenshotAttempts
          item.screenshotRetried = error.screenshotRetried === true
          item.screenshotCaptured = false
          item.screenshotTransient = error.screenshotTransient || null
        }
        if (isFatalSessionError(error)) throw error
      } finally {
        item.durationMs = Date.now() - routeStartedAtMs
      }
    }
  } catch (error) {
    fatalError = error
    report.failure = {
      stage: sanitizeCode(error && error.stage, currentStage),
      category: categorizeError(error),
      errorCode: sanitizeCode(error && error.code, 'SMOKE_FAILED'),
      timeoutOrigin: error && error.timeoutOrigin || '',
      screenshotAttempts: Number.isSafeInteger(error && error.screenshotAttempts) ? error.screenshotAttempts : null,
      screenshotRetried: error && error.screenshotRetried === true,
      screenshotCaptured: error && error.screenshotCaptured === true,
      screenshotTransient: error && error.screenshotTransient || null,
      message: sanitize(error && error.message),
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

  const summary = {
    routes: report.routes.map(({ expected, actualPath, navigationError, state, controls, screenshotAttempts, screenshotRetried, screenshotCaptured }) => ({
      expected, actualPath, navigationError, state, controls,
      screenshotAttempts, screenshotRetried, screenshotCaptured,
    })),
    consoleErrorCount: report.consoleErrors.filter((entry) => entry.category !== 'DEVTOOLS_PERFORMANCE_NOTICE').length,
    consoleNoticeCount: report.consoleErrors.filter((entry) => entry.category === 'DEVTOOLS_PERFORMANCE_NOTICE').length,
    exceptionCount: report.exceptions.length,
    cleanupFailureCount: report.cleanupFailureCount,
    reportPath,
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  if (report.routes.some((item) => item.category !== 'PASSED')
    || report.consoleErrors.some((entry) => entry.category !== 'DEVTOOLS_PERFORMANCE_NOTICE')
    || report.exceptions.length || report.cleanupFailureCount) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  process.stderr.write(`SMOKE_FAILED: ${sanitize(error && (error.stack || error.message || error))}\n`)
  process.exitCode = 1
})
