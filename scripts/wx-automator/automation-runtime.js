'use strict'

const crypto = require('crypto')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { PNG } = require('pngjs')

const DEFAULT_AUTOMATOR_ENDPOINT = 'ws://127.0.0.1:9421'
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const LOCAL_AUTOMATOR_DIR = path.join(PROJECT_ROOT, '.local', 'automator')
const DEFAULT_LOCK_PATH = path.join(LOCAL_AUTOMATOR_DIR, '.runtime', 'automator-session.lock')
const DEFAULT_RESPONSE_TIMEOUT_MS = 8000
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 20000
const DEFAULT_SCREENSHOT_ATTEMPTS = 3
const MIN_VIEWPORT_DIMENSION = 120
const MAX_VIEWPORT_DIMENSION = 4096
const MIN_VIEWPORT_ASPECT_RATIO = 0.2
const MAX_VIEWPORT_ASPECT_RATIO = 5
const DEVTOOLS_RESPONSE_TIMEOUT_MESSAGE = 'timeout waiting for automator response'
const TIMEOUT_ORIGIN_DEVTOOLS_RESPONSE = 'DEVTOOLS_RESPONSE'
const TIMEOUT_ORIGIN_LOCAL_DEADLINE = 'LOCAL_DEADLINE'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const RECOVERY_VERSION = 1

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function runtimeError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

function sanitizeText(value, maximum = 1200) {
  return String(value == null ? '' : value)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_API_KEY]')
    .replace(/\bAuthorization\s*[:=]?\s*(?:Bearer\s+)?[A-Za-z0-9._~+\/-]{12,}/gi, 'Authorization [REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(openid|unionid|appid|cloudEnvId|environmentId|memberRef|inviteRef|cacheNamespace)\s*[:=]\s*[^\s,;}]+/gi, '$1=[REDACTED]')
    .replace(/\b1\d{10}\b/g, '[REDACTED_PHONE]')
    .slice(0, maximum)
}

function sanitizeCode(value, fallback = 'UNKNOWN') {
  const code = String(value == null ? '' : value).trim().toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return code || fallback
}

function sanitizeRoute(value) {
  const route = String(value == null ? '' : value).trim().split(/[?#]/, 1)[0]
    .replace(/\\/g, '/').replace(/[^A-Za-z0-9_./-]+/g, '').slice(0, 240)
  return route.replace(/^\/+/, '')
}

function categorizeError(error) {
  const code = sanitizeCode(error && error.code, '')
  if (code) return code
  const message = String(error && error.message || error || '').toLowerCase()
  if (/time(?:d)?\s*out|timeout/.test(message)) return 'TIMEOUT'
  if (/route|navigation|navigate/.test(message)) return 'NAVIGATION'
  if (/websocket|endpoint|econnrefused|connect/.test(message)) return 'CONNECTION'
  if (/lock|exclusive|session/.test(message)) return 'SESSION_LOCK'
  if (/recover|journal|mutation|restore/.test(message)) return 'RECOVERY'
  if (/selector|control|element|render/.test(message)) return 'CONTROL'
  return 'UNCLASSIFIED'
}

function isFatalSessionError(error) {
  const code = sanitizeCode(error && error.code, '')
  if ([
    'AUTOMATOR_CONNECTION_CLOSED', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET',
    'EPIPE', 'ENETDOWN', 'ENETRESET', 'ENETUNREACH', 'ETIMEDOUT',
  ].includes(code)) return true
  const message = String(error && error.message || error || '').toLowerCase()
  return /connection closed|websocket.+(?:closed|closing|not open)|socket hang up|write epipe|econn(?:aborted|refused|reset)|enet(?:down|reset|unreach)/.test(message)
}

function validViewportDimensions(rawWidth, rawHeight) {
  const width = Number(rawWidth)
  const height = Number(rawHeight)
  const aspectRatio = width / height
  return Number.isFinite(width) && Number.isFinite(height)
    && width >= MIN_VIEWPORT_DIMENSION && width <= MAX_VIEWPORT_DIMENSION
    && height >= MIN_VIEWPORT_DIMENSION && height <= MAX_VIEWPORT_DIMENSION
    && aspectRatio >= MIN_VIEWPORT_ASPECT_RATIO && aspectRatio <= MAX_VIEWPORT_ASPECT_RATIO
}

async function readAutomatorViewport(miniProgram, page, options = {}) {
  if (!page || typeof page.windowProperty !== 'function') {
    throw runtimeError('AUTOMATOR_VIEWPORT_INVALID', 'Viewport inspection requires an active page')
  }
  const stage = sanitizeCode(options.stage, 'READ_VIEWPORT')
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.round(options.timeoutMs))
    : DEFAULT_RESPONSE_TIMEOUT_MS
  const readProperties = (properties, readStage) => withAutomatorResponseTimeout(
    () => page.windowProperty(properties),
    { stage: readStage, timeoutMs },
  )
  const innerProperties = ['window.innerWidth', 'window.innerHeight']
  const innerValues = await readProperties(innerProperties, stage)
  if (validViewportDimensions(innerValues && innerValues[0], innerValues && innerValues[1])) {
    return {
      windowWidth: Number(innerValues[0]),
      windowHeight: Number(innerValues[1]),
      platform: 'devtools',
      source: 'WINDOW_INNER',
    }
  }
  if (!miniProgram || typeof miniProgram.evaluate !== 'function') {
    const error = runtimeError(
      'AUTOMATOR_VIEWPORT_INVALID',
      'Developer Tools returned no valid layout viewport dimensions',
    )
    error.stage = stage
    throw error
  }
  // DevTools can return blank DOM viewport properties. Read the modern WeChat window API
  // in the mini-program runtime so diagnostics never call deprecated getSystemInfoSync.
  const windowInfo = await withAutomatorResponseTimeout(
    () => miniProgram.evaluate(function readWindowInfo() { return wx.getWindowInfo() }),
    {
      stage: `${stage}_WINDOW_INFO`,
      timeoutMs,
    },
  )
  if (validViewportDimensions(windowInfo && windowInfo.windowWidth, windowInfo && windowInfo.windowHeight)) {
    return {
      windowWidth: Number(windowInfo.windowWidth),
      windowHeight: Number(windowInfo.windowHeight),
      platform: 'devtools',
      source: 'WX_WINDOW_INFO',
    }
  }
  const error = runtimeError(
    'AUTOMATOR_VIEWPORT_INVALID',
    'Developer Tools returned no valid layout viewport dimensions',
  )
  error.stage = stage
  throw error
}

function validateAutomatorEndpoint(value) {
  const raw = String(value == null ? '' : value).trim()
  let endpoint
  try {
    endpoint = new URL(raw)
  } catch (_) {
    throw runtimeError('AUTOMATOR_ENDPOINT_INVALID', 'MINIPROGRAM_AUTOMATOR_ENDPOINT must be a valid WebSocket URL')
  }
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) {
    throw runtimeError('AUTOMATOR_ENDPOINT_NOT_WEBSOCKET', 'MINIPROGRAM_AUTOMATOR_ENDPOINT must use ws:// or wss://')
  }
  if (!endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw runtimeError('AUTOMATOR_ENDPOINT_INVALID', 'MINIPROGRAM_AUTOMATOR_ENDPOINT contains unsupported URL fields')
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpoint.hostname.toLowerCase())
  if (loopback && ['9430', '9431'].includes(endpoint.port)) {
    throw runtimeError(
      'AUTOMATOR_HTTP_PORT_REJECTED',
      `Port ${endpoint.port} is a Developer Tools HTTP service, not the automation WebSocket`,
    )
  }
  return endpoint.toString().replace(/\/$/, '')
}

function getAutomatorEndpoint(environment = process.env) {
  return validateAutomatorEndpoint(environment.MINIPROGRAM_AUTOMATOR_ENDPOINT || DEFAULT_AUTOMATOR_ENDPOINT)
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (_) {
    return null
  }
}

function removeEmptyLock(lockPath, ownerPath) {
  try { fs.unlinkSync(ownerPath) } catch (error) { if (!error || error.code !== 'ENOENT') throw error }
  try { fs.rmdirSync(lockPath) } catch (error) { if (!error || error.code !== 'ENOENT') throw error }
}

async function acquireExclusiveLock(options = {}) {
  const lockPath = path.resolve(options.lockPath || DEFAULT_LOCK_PATH)
  const ownerPath = path.join(lockPath, 'owner.json')
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 30000
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(10, options.pollMs) : 100
  const orphanGraceMs = Number.isFinite(options.orphanGraceMs) ? Math.max(0, options.orphanGraceMs) : 10000
  const pid = Number.isSafeInteger(options.pid) ? options.pid : process.pid
  const alive = typeof options.isPidAlive === 'function' ? options.isPidAlive : isPidAlive
  const now = typeof options.now === 'function' ? options.now : Date.now
  const token = crypto.randomUUID()
  const deadline = now() + timeoutMs
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  for (;;) {
    try {
      fs.mkdirSync(lockPath)
      const owner = { version: 1, pid, token, createdAt: new Date(now()).toISOString() }
      const temporary = path.join(lockPath, `owner-${token}.tmp`)
      fs.writeFileSync(temporary, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx' })
      fs.renameSync(temporary, ownerPath)
      let released = false
      return async () => {
        if (released) return
        const current = readJson(ownerPath)
        if (!current || current.token !== token || current.pid !== pid) {
          throw runtimeError('AUTOMATOR_LOCK_OWNERSHIP_LOST', 'Automation session lock ownership changed before release')
        }
        removeEmptyLock(lockPath, ownerPath)
        released = true
      }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      const owner = readJson(ownerPath)
      if (owner && Number.isSafeInteger(owner.pid) && typeof owner.token === 'string') {
        if (owner.pid === pid) throw runtimeError('AUTOMATOR_LOCK_REENTRANT', 'This process already owns the automation session lock')
        if (!alive(owner.pid)) {
          try {
            removeEmptyLock(lockPath, ownerPath)
            continue
          } catch (_) {
            // Another waiter may have claimed the lock; retry until the deadline.
          }
        }
      } else {
        let ageMs = 0
        try { ageMs = Math.max(0, now() - fs.statSync(lockPath).mtimeMs) } catch (_) {}
        if (ageMs >= orphanGraceMs) {
          try {
            removeEmptyLock(lockPath, ownerPath)
            continue
          } catch (_) {}
        }
      }
      if (now() >= deadline) {
        throw runtimeError('AUTOMATOR_SESSION_LOCKED', 'Another automation process owns the Developer Tools session')
      }
      await sleep(pollMs)
    }
  }
}

function bindSessionDisconnect(miniProgram, release) {
  if (!miniProgram || typeof miniProgram.disconnect !== 'function') {
    throw runtimeError('AUTOMATOR_SESSION_INVALID', 'Automator did not return a disconnectable mini program session')
  }
  const rawDisconnect = miniProgram.disconnect.bind(miniProgram)
  let disconnectPromise = null
  miniProgram.disconnect = function disconnectAndRelease() {
    if (!disconnectPromise) {
      disconnectPromise = Promise.resolve().then(rawDisconnect).finally(release)
    }
    return disconnectPromise
  }
  return miniProgram
}

async function connectAutomator(automator, options = {}, runtimeOptions = {}) {
  const release = await acquireExclusiveLock(runtimeOptions)
  try {
    const miniProgram = await automator.connect({ ...options, wsEndpoint: validateAutomatorEndpoint(options.wsEndpoint || getAutomatorEndpoint()) })
    return bindSessionDisconnect(miniProgram, release)
  } catch (error) {
    await release().catch(() => {})
    throw error
  }
}

async function launchAutomator(automator, options = {}, runtimeOptions = {}) {
  const release = await acquireExclusiveLock(runtimeOptions)
  try {
    const miniProgram = await automator.launch(options)
    return bindSessionDisconnect(miniProgram, release)
  } catch (error) {
    await release().catch(() => {})
    throw error
  }
}

async function safeDisconnect(miniProgram) {
  if (!miniProgram || typeof miniProgram.disconnect !== 'function') return true
  try {
    await Promise.resolve().then(() => miniProgram.disconnect())
    return true
  } catch (_) {
    return false
  }
}

function classifyAutomatorDiagnostic(entry) {
  const level = sanitizeText(entry && (entry.type || entry.level || entry.method || ''), 80).toLowerCase()
  const text = sanitizeText(entry && (entry.text || entry.message || entry.args || entry), 1200)
  const isError = level.includes('error')
  const isWarning = level.includes('warn')
  if (!isError && !isWarning) {
    return { observed: false, blocking: false, level, text, category: 'IGNORED_DIAGNOSTIC' }
  }
  const knownPerformanceNotice = isWarning && !isError
    && /^\[perf\]\s+app\.onlaunch\s+took\s+\d+(?:\.\d+)?ms$/i.test(text.trim())
  return {
    observed: true,
    blocking: !knownPerformanceNotice,
    level,
    text,
    category: knownPerformanceNotice ? 'DEVTOOLS_PERFORMANCE_NOTICE' : 'BLOCKING_CONSOLE',
  }
}

function cleanupErrorCode(prefix, error) {
  const code = sanitizeCode(error && error.code, categorizeError(error))
  return sanitizeCode(`${prefix}_${code}`, `${prefix}_FAILED`)
}

async function cleanupAutomatorSession(miniProgram, unsubscribeDiagnostics) {
  const errorCodes = []
  if (typeof unsubscribeDiagnostics === 'function') {
    try {
      await Promise.resolve().then(() => unsubscribeDiagnostics())
    } catch (error) {
      errorCodes.push(cleanupErrorCode('DIAGNOSTICS_UNSUBSCRIBE', error))
    }
  }
  if (miniProgram) {
    try {
      if (typeof miniProgram.disconnect !== 'function') {
        throw runtimeError('AUTOMATOR_SESSION_INVALID', 'Automation session cannot be disconnected')
      }
      await Promise.resolve().then(() => miniProgram.disconnect())
    } catch (error) {
      errorCodes.push(cleanupErrorCode('SESSION_DISCONNECT', error))
    }
  }
  return {
    ok: errorCodes.length === 0,
    failureCount: errorCodes.length,
    errorCodes,
  }
}

function mergeAutomatorCleanupReport(report, cleanup) {
  if (!report || typeof report !== 'object') {
    throw runtimeError('AUTOMATOR_REPORT_INVALID', 'Automation cleanup requires a report object')
  }
  const result = cleanup && typeof cleanup === 'object' ? cleanup : {
    failureCount: 1,
    errorCodes: ['SESSION_CLEANUP_RESULT_INVALID'],
  }
  const previousCount = Number.isSafeInteger(report.cleanupFailureCount) ? report.cleanupFailureCount : 0
  const previousCodes = Array.isArray(report.cleanupErrorCodes) ? report.cleanupErrorCodes : []
  const nextCodes = Array.isArray(result.errorCodes)
    ? result.errorCodes.map((code) => sanitizeCode(code, 'SESSION_CLEANUP_FAILED'))
    : ['SESSION_CLEANUP_RESULT_INVALID']
  report.cleanupFailureCount = previousCount
    + (Number.isSafeInteger(result.failureCount) ? Math.max(0, result.failureCount) : nextCodes.length)
  report.cleanupErrorCodes = [...previousCodes, ...nextCodes]
  return report
}

async function subscribeAutomatorDiagnostics(miniProgram, handlers = {}, options = {}) {
  if (!miniProgram || typeof miniProgram.send !== 'function') {
    throw runtimeError('AUTOMATOR_DIAGNOSTICS_INVALID', 'Automator diagnostics require a connected mini program session')
  }
  const consoleHandler = typeof handlers.console === 'function' ? handlers.console : null
  const exceptionHandler = typeof handlers.exception === 'function' ? handlers.exception : null
  const subscriptions = [
    ['console', consoleHandler],
    ['exception', exceptionHandler],
  ].filter(([, handler]) => handler)
  subscriptions.forEach(([eventName, handler]) => {
    EventEmitter.prototype.on.call(miniProgram, eventName, handler)
  })
  let active = true
  const unsubscribe = () => {
    if (!active) return
    subscriptions.forEach(([eventName, handler]) => {
      EventEmitter.prototype.removeListener.call(miniProgram, eventName, handler)
    })
    active = false
  }
  try {
    if (consoleHandler) {
      await withAutomatorResponseTimeout(() => miniProgram.send('App.enableLog'), {
        stage: options.stage || 'ENABLE_CONSOLE_LOG',
        timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_RESPONSE_TIMEOUT_MS,
      })
    }
    return unsubscribe
  } catch (error) {
    unsubscribe()
    throw error
  }
}

function normalizeAutomatorResponseError(error, stage, timeoutMs) {
  if (isAutomatorResponseTimeout(error)) return error
  const message = String(error && error.message || '').trim().toLowerCase()
  if (isFatalSessionError(error)) {
    const normalized = runtimeError(
      'AUTOMATOR_CONNECTION_CLOSED',
      `Developer Tools automation session closed during ${stage}`,
    )
    normalized.stage = stage
    normalized.cause = error
    return normalized
  }
  if (message !== DEVTOOLS_RESPONSE_TIMEOUT_MESSAGE) return error
  const normalized = runtimeError(
    'AUTOMATOR_RESPONSE_TIMEOUT',
    `Developer Tools timed out during ${stage}`,
  )
  normalized.stage = stage
  normalized.timeoutMs = timeoutMs
  normalized.timeoutOrigin = TIMEOUT_ORIGIN_DEVTOOLS_RESPONSE
  normalized.cause = error
  return normalized
}

function withAutomatorResponseTimeout(operation, options = {}) {
  if (typeof operation !== 'function') {
    return Promise.reject(runtimeError('AUTOMATOR_PROTOCOL_CALL_INVALID', 'Automator protocol operation must be a function'))
  }
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.round(options.timeoutMs))
    : DEFAULT_RESPONSE_TIMEOUT_MS
  const stage = sanitizeCode(options.stage, 'PROTOCOL_CALL')
  let timeoutHandle = null
  const response = Promise.resolve().then(operation).catch((error) => {
    throw normalizeAutomatorResponseError(error, stage, timeoutMs)
  })
  const timeout = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const error = runtimeError(
        'AUTOMATOR_RESPONSE_TIMEOUT',
        `Developer Tools did not respond during ${stage} within ${timeoutMs} ms`,
      )
      error.stage = stage
      error.timeoutMs = timeoutMs
      error.timeoutOrigin = TIMEOUT_ORIGIN_LOCAL_DEADLINE
      reject(error)
    }, timeoutMs)
  })
  return Promise.race([response, timeout]).finally(() => clearTimeout(timeoutHandle))
}

function isAutomatorResponseTimeout(error) {
  return Boolean(error && error.code === 'AUTOMATOR_RESPONSE_TIMEOUT')
}

function screenshotTransient(error) {
  return {
    errorCode: sanitizeCode(error && error.code, 'AUTOMATOR_RESPONSE_TIMEOUT'),
    stage: sanitizeCode(error && error.stage, 'CAPTURE_SCREENSHOT'),
    timeoutOrigin: error && error.timeoutOrigin === TIMEOUT_ORIGIN_DEVTOOLS_RESPONSE
      ? TIMEOUT_ORIGIN_DEVTOOLS_RESPONSE
      : TIMEOUT_ORIGIN_LOCAL_DEADLINE,
  }
}

function attachScreenshotFailure(error, attempts, transient) {
  if (!error || typeof error !== 'object') return error
  error.screenshotAttempts = attempts
  error.screenshotRetried = attempts > 1
  error.screenshotCaptured = false
  error.screenshotTransient = transient
  return error
}

function writeVerifiedPngAttempt(attemptPath, targetPath, encoded) {
  if (typeof encoded !== 'string' || !encoded) {
    throw runtimeError('AUTOMATOR_SCREENSHOT_INVALID', 'Developer Tools returned an empty screenshot')
  }
  const contents = Buffer.from(encoded, 'base64')
  let decoded
  try {
    decoded = PNG.sync.read(contents, { checkCRC: true })
  } catch (_) {
    throw runtimeError('AUTOMATOR_SCREENSHOT_INVALID', 'Developer Tools returned an invalid PNG screenshot')
  }
  if (contents.length <= PNG_SIGNATURE.length
    || !contents.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || !validViewportDimensions(decoded && decoded.width, decoded && decoded.height)
    || !decoded.data || decoded.data.length !== decoded.width * decoded.height * 4) {
    throw runtimeError('AUTOMATOR_SCREENSHOT_INVALID', 'Developer Tools returned an invalid PNG screenshot')
  }
  fs.writeFileSync(attemptPath, contents, { flag: 'wx' })
  if (fs.existsSync(targetPath)) {
    throw runtimeError('AUTOMATOR_SCREENSHOT_TARGET_EXISTS', 'Screenshot target already exists in this run')
  }
  fs.renameSync(attemptPath, targetPath)
}

async function captureScreenshotWithRetry(miniProgram, targetPath, options = {}) {
  if (!miniProgram || typeof miniProgram.screenshot !== 'function' || typeof miniProgram.currentPage !== 'function') {
    throw runtimeError('AUTOMATOR_SCREENSHOT_SESSION_INVALID', 'Screenshot capture requires a connected automation session')
  }
  const resolvedTarget = path.resolve(targetPath)
  const outputDirectory = path.dirname(resolvedTarget)
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.round(options.timeoutMs))
    : DEFAULT_SCREENSHOT_TIMEOUT_MS
  const healthTimeoutMs = Number.isFinite(options.healthTimeoutMs)
    ? Math.max(1, Math.round(options.healthTimeoutMs))
    : DEFAULT_RESPONSE_TIMEOUT_MS
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? Math.max(0, Math.round(options.retryDelayMs)) : 350
  const stage = sanitizeCode(options.stage, 'CAPTURE_SCREENSHOT')
  const expectedRoute = sanitizeRoute(options.expectedRoute)
  const allowedRoutes = new Set([
    expectedRoute,
    ...(Array.isArray(options.allowedRoutes) ? options.allowedRoutes : []).map(sanitizeRoute),
  ].filter(Boolean))
  const nonce = crypto.randomBytes(6).toString('hex')
  let attempts = 0
  let transient = null
  fs.mkdirSync(outputDirectory, { recursive: true })
  if (fs.existsSync(resolvedTarget)) {
    throw attachScreenshotFailure(
      runtimeError('AUTOMATOR_SCREENSHOT_TARGET_EXISTS', 'Screenshot target already exists in this run'),
      attempts,
      transient,
    )
  }

  while (attempts < DEFAULT_SCREENSHOT_ATTEMPTS) {
    attempts += 1
    const attemptPath = `${resolvedTarget}.attempt-${process.pid}-${nonce}-${attempts}.png`
    try {
      const encoded = await withAutomatorResponseTimeout(() => miniProgram.screenshot(), {
        stage,
        timeoutMs,
      })
      writeVerifiedPngAttempt(attemptPath, resolvedTarget, encoded)
      return {
        attempts,
        retried: attempts > 1,
        captured: true,
        transient,
      }
    } catch (error) {
      try { fs.unlinkSync(attemptPath) } catch (cleanupError) {
        if (!cleanupError || cleanupError.code !== 'ENOENT') {
          throw attachScreenshotFailure(cleanupError, attempts, transient)
        }
      }
      const retryable = isAutomatorResponseTimeout(error)
        && error.timeoutOrigin === TIMEOUT_ORIGIN_DEVTOOLS_RESPONSE
        && attempts < DEFAULT_SCREENSHOT_ATTEMPTS
      if (!retryable) throw attachScreenshotFailure(error, attempts, transient)
      transient = screenshotTransient(error)
      try {
        const page = await withAutomatorResponseTimeout(() => miniProgram.currentPage(), {
          stage: `${stage}_HEALTH_PROBE`,
          timeoutMs: healthTimeoutMs,
        })
        if (!page) {
          throw runtimeError('AUTOMATOR_SCREENSHOT_HEALTH_FAILED', 'Screenshot retry health probe returned no current page')
        }
        const actualRoute = sanitizeRoute(page.path)
        if (allowedRoutes.size && !allowedRoutes.has(actualRoute)) {
          const routeError = runtimeError(
            'AUTOMATOR_SCREENSHOT_ROUTE_CHANGED',
            `Screenshot retry expected ${[...allowedRoutes].join(' or ')}, received ${actualRoute || 'none'}`,
          )
          routeError.stage = `${stage}_HEALTH_PROBE`
          throw routeError
        }
        if (typeof options.healthPredicate === 'function'
          && !await Promise.resolve(options.healthPredicate(page))) {
          const predicateError = runtimeError(
            'AUTOMATOR_SCREENSHOT_HEALTH_FAILED',
            'Screenshot retry health predicate rejected the current page',
          )
          predicateError.stage = `${stage}_HEALTH_PROBE`
          throw predicateError
        }
      } catch (healthError) {
        throw attachScreenshotFailure(healthError, attempts, transient)
      }
      if (retryDelayMs) await sleep(retryDelayMs)
    }
  }
  throw attachScreenshotFailure(
    runtimeError('AUTOMATOR_SCREENSHOT_RETRY_EXHAUSTED', 'Screenshot retry exhausted without a result'),
    attempts,
    transient,
  )
}

async function navigateAndAcquire(miniProgram, route, options = {}) {
  const method = options.method || 'reLaunch'
  const expectedRoute = sanitizeRoute(options.expectedRoute || route)
  const allowedRoutes = new Set([expectedRoute, ...(options.allowedRoutes || []).map(sanitizeRoute)].filter(Boolean))
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(100, options.timeoutMs) : 10000
  const responseTimeoutMs = Number.isFinite(options.responseTimeoutMs)
    ? Math.max(1, options.responseTimeoutMs)
    : Math.min(DEFAULT_RESPONSE_TIMEOUT_MS, timeoutMs)
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(10, options.pollMs) : 100
  if (!miniProgram || typeof miniProgram[method] !== 'function' || typeof miniProgram.currentPage !== 'function') {
    throw runtimeError('AUTOMATOR_NAVIGATION_INVALID', `Unsupported automation navigation method: ${method}`)
  }
  const deadline = Date.now() + timeoutMs
  const beforePage = await withAutomatorResponseTimeout(() => miniProgram.currentPage(), {
    stage: 'NAVIGATE_BEFORE_CURRENT_PAGE',
    timeoutMs: Math.min(responseTimeoutMs, timeoutMs),
  })
  const beforeRoute = sanitizeRoute(beforePage && beforePage.path)
  const beforePageId = beforePage && beforePage.id != null ? String(beforePage.id) : ''
  const pageTransitioned = (page) => {
    const actualRoute = sanitizeRoute(page && page.path)
    if (actualRoute !== beforeRoute) return true
    const actualPageId = page && page.id != null ? String(page.id) : ''
    return Boolean(beforePageId && actualPageId && actualPageId !== beforePageId)
  }
  let navigationError = null
  try {
    await withAutomatorResponseTimeout(() => miniProgram[method](route), {
      stage: `NAVIGATE_${method}`,
      timeoutMs: Math.min(responseTimeoutMs, timeoutMs),
    })
  } catch (error) {
    if (isFatalSessionError(error)) throw error
    navigationError = error
  }
  let page = null
  while (Date.now() <= deadline) {
    try {
      page = await withAutomatorResponseTimeout(() => miniProgram.currentPage(), {
        stage: 'ACQUIRE_CURRENT_PAGE',
        timeoutMs: Math.min(responseTimeoutMs, Math.max(1, deadline - Date.now())),
      })
    } catch (error) {
      if (isAutomatorResponseTimeout(error) || isFatalSessionError(error)) throw error
      page = null
    }
    const actual = sanitizeRoute(page && page.path)
    const routeAccepted = page && (!allowedRoutes.size || allowedRoutes.has(actual))
    const isDeclaredRedirect = routeAccepted && actual !== expectedRoute
    if (routeAccepted
      && (!navigationError || pageTransitioned(page))
      && (!isDeclaredRedirect || pageTransitioned(page))) return page
    await sleep(pollMs)
  }
  if (navigationError && isAutomatorResponseTimeout(navigationError)) throw navigationError
  if (navigationError) {
    const error = runtimeError(
      'AUTOMATOR_NAVIGATION_UNCONFIRMED',
      `Navigation failed without a verified page transition from ${beforeRoute || 'none'}`,
    )
    error.cause = navigationError
    throw error
  }
  const error = runtimeError('AUTOMATOR_ROUTE_TIMEOUT', `Expected route ${expectedRoute || '[current]'}, received ${sanitizeRoute(page && page.path) || 'none'}`)
  throw error
}

function createRun(kind, baseDir, options = {}) {
  const startedAtMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  const runId = `${new Date(startedAtMs).toISOString().replace(/[:.]/g, '-')}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const normalizedKind = sanitizeCode(kind, 'AUTOMATION').toLowerCase()
  return Object.freeze({
    runId,
    kind: normalizedKind,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    baseDir: path.resolve(baseDir),
    outputDir: path.resolve(baseDir, 'runs', runId),
  })
}

function sanitizeReportValue(value, key = '') {
  if (value == null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return /duration/i.test(key) ? Math.max(0, Math.round(value)) : value
  }
  if (typeof value === 'string') {
    if (/route|path$/i.test(key)) return sanitizeRoute(value)
    if (/stage|category|errorCode|code$/i.test(key)) return sanitizeCode(value, '')
    return sanitizeText(value)
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeReportValue(item, key))
  if (typeof value === 'object') {
    const result = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeReportValue(childValue, childKey)
    }
    return result
  }
  return sanitizeText(value)
}

function atomicWriteJson(filePath, value) {
  const target = path.resolve(filePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  try {
    fs.renameSync(temporary, target)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch (_) {}
    throw error
  }
}

function finalizeRunReport(run, report, options = {}) {
  const finishedAtMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  const finalReport = sanitizeReportValue({
    ...report,
    runId: run.runId,
    kind: run.kind,
    startedAt: run.startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - run.startedAtMs),
  })
  fs.mkdirSync(run.outputDir, { recursive: true })
  const reportPath = path.join(run.outputDir, 'report.json')
  const latestPath = path.join(run.baseDir, 'latest.json')
  atomicWriteJson(reportPath, finalReport)
  atomicWriteJson(latestPath, finalReport)
  return { report: finalReport, reportPath, latestPath }
}

function validateRecoveryJournal(value) {
  if (!value || value.version !== RECOVERY_VERSION || !Array.isArray(value.mutations)) return null
  const mutations = []
  for (const entry of value.mutations) {
    if (!entry || typeof entry.id !== 'string' || !['active', 'restored'].includes(entry.status)) return null
    mutations.push({
      id: sanitizeCode(entry.id),
      status: entry.status,
      stage: sanitizeCode(entry.stage, 'REGISTERED'),
      registeredAt: sanitizeText(entry.registeredAt, 40),
      restoredAt: sanitizeText(entry.restoredAt, 40),
    })
  }
  return {
    version: RECOVERY_VERSION,
    runId: sanitizeText(value.runId, 120),
    updatedAt: sanitizeText(value.updatedAt, 40),
    mutations,
  }
}

function readRecoveryJournal(filePath) {
  if (!fs.existsSync(filePath)) return null
  const journal = validateRecoveryJournal(readJson(filePath))
  if (!journal) throw runtimeError('RECOVERY_JOURNAL_INVALID', 'Recovery journal is invalid; write tests are blocked')
  return journal
}

function unresolvedMutations(journal) {
  return journal ? journal.mutations.filter((entry) => entry.status === 'active') : []
}

function assertRecoveryGate(journal, recoveryOnly) {
  const unresolved = unresolvedMutations(journal)
  if (unresolved.length && recoveryOnly !== true) {
    throw runtimeError('RECOVERY_REQUIRED', `Unresolved automation mutation: ${unresolved.map((entry) => entry.id).join(',')}`)
  }
  if (!unresolved.length && recoveryOnly === true) {
    throw runtimeError('RECOVERY_NOT_REQUIRED', 'Recovery-only mode requires an unresolved mutation journal')
  }
  return unresolved
}

function createRecoveryJournal(filePath, runId, options = {}) {
  const resolvedPath = path.resolve(filePath)
  const previous = readRecoveryJournal(resolvedPath)
  const unresolved = assertRecoveryGate(previous, options.recoveryOnly === true)
  let journal = previous && unresolved.length ? previous : {
    version: RECOVERY_VERSION, runId: sanitizeText(runId, 120), updatedAt: new Date().toISOString(), mutations: [],
  }
  const persist = () => {
    journal.updatedAt = new Date().toISOString()
    atomicWriteJson(resolvedPath, journal)
  }
  if (!previous || !unresolved.length) persist()
  return {
    unresolved: () => unresolvedMutations(journal),
    register(id, stage = 'REGISTERED') {
      const normalizedId = sanitizeCode(id)
      if (journal.mutations.some((entry) => entry.id === normalizedId && entry.status === 'active')) {
        throw runtimeError('RECOVERY_MUTATION_DUPLICATE', `Mutation ${normalizedId} is already active`)
      }
      journal.mutations.push({
        id: normalizedId, status: 'active', stage: sanitizeCode(stage, 'REGISTERED'),
        registeredAt: new Date().toISOString(), restoredAt: '',
      })
      persist()
      return normalizedId
    },
    update(id, stage) {
      const entry = journal.mutations.find((item) => item.id === sanitizeCode(id) && item.status === 'active')
      if (!entry) throw runtimeError('RECOVERY_MUTATION_MISSING', `Active mutation ${sanitizeCode(id)} is missing`)
      entry.stage = sanitizeCode(stage, entry.stage)
      persist()
    },
    resolve(id) {
      const entry = journal.mutations.find((item) => item.id === sanitizeCode(id) && item.status === 'active')
      if (!entry) throw runtimeError('RECOVERY_MUTATION_MISSING', `Active mutation ${sanitizeCode(id)} is missing`)
      entry.status = 'restored'
      entry.stage = 'RESTORED'
      entry.restoredAt = new Date().toISOString()
      persist()
    },
    complete() {
      if (unresolvedMutations(journal).length) throw runtimeError('RECOVERY_UNRESOLVED', 'Recovery journal still contains active mutations')
      try { fs.unlinkSync(resolvedPath) } catch (error) { if (!error || error.code !== 'ENOENT') throw error }
    },
  }
}

module.exports = {
  DEFAULT_AUTOMATOR_ENDPOINT,
  LOCAL_AUTOMATOR_DIR,
  PROJECT_ROOT,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_SCREENSHOT_ATTEMPTS,
  DEFAULT_SCREENSHOT_TIMEOUT_MS,
  TIMEOUT_ORIGIN_DEVTOOLS_RESPONSE,
  TIMEOUT_ORIGIN_LOCAL_DEADLINE,
  acquireExclusiveLock,
  assertRecoveryGate,
  atomicWriteJson,
  captureScreenshotWithRetry,
  categorizeError,
  classifyAutomatorDiagnostic,
  cleanupAutomatorSession,
  connectAutomator,
  createRecoveryJournal,
  createRun,
  finalizeRunReport,
  getAutomatorEndpoint,
  isAutomatorResponseTimeout,
  isFatalSessionError,
  launchAutomator,
  mergeAutomatorCleanupReport,
  navigateAndAcquire,
  readAutomatorViewport,
  readRecoveryJournal,
  safeDisconnect,
  subscribeAutomatorDiagnostics,
  sanitizeCode,
  sanitizeRoute,
  sanitizeText,
  validateAutomatorEndpoint,
  withAutomatorResponseTimeout,
}
