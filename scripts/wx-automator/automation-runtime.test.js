'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { PNG } = require('pngjs')

const {
  DEFAULT_AUTOMATOR_ENDPOINT,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_SCREENSHOT_ATTEMPTS,
  DEFAULT_SCREENSHOT_TIMEOUT_MS,
  acquireExclusiveLock,
  assertRecoveryGate,
  captureScreenshotWithRetry,
  categorizeError,
  classifyAutomatorDiagnostic,
  cleanupAutomatorSession,
  connectAutomator,
  createRecoveryJournal,
  createRun,
  finalizeRunReport,
  getAutomatorEndpoint,
  isFatalSessionError,
  mergeAutomatorCleanupReport,
  navigateAndAcquire,
  readAutomatorViewport,
  safeDisconnect,
  subscribeAutomatorDiagnostics,
  sanitizeRoute,
  sanitizeText,
  validateAutomatorEndpoint,
  withAutomatorResponseTimeout,
} = require('./automation-runtime')

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meal-mini-runtime-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function encodedPng(width = 120, height = 240) {
  const png = new PNG({ width, height })
  png.data.fill(255)
  return PNG.sync.write(png).toString('base64')
}

const MINIMAL_PNG = encodedPng()

test('uses the dedicated local WebSocket endpoint by default', () => {
  assert.equal(DEFAULT_AUTOMATOR_ENDPOINT, 'ws://127.0.0.1:9421')
  assert.equal(getAutomatorEndpoint({}), DEFAULT_AUTOMATOR_ENDPOINT)
  assert.equal(getAutomatorEndpoint({ MINIPROGRAM_AUTOMATOR_ENDPOINT: 'wss://example.test/automation' }), 'wss://example.test/automation')
})

test('rejects HTTP URLs and the Developer Tools HTTP port', () => {
  assert.throws(() => validateAutomatorEndpoint('http://127.0.0.1:9430'), { code: 'AUTOMATOR_ENDPOINT_NOT_WEBSOCKET' })
  assert.throws(() => validateAutomatorEndpoint('ws://127.0.0.1:9430'), { code: 'AUTOMATOR_HTTP_PORT_REJECTED' })
  assert.throws(() => validateAutomatorEndpoint('ws://127.0.0.1:9431'), { code: 'AUTOMATOR_HTTP_PORT_REJECTED' })
  assert.throws(() => validateAutomatorEndpoint('not-a-url'), { code: 'AUTOMATOR_ENDPOINT_INVALID' })
})

test('exclusive lock rejects contention and releases only once', async (t) => {
  const lockPath = path.join(temporaryDirectory(t), 'session.lock')
  const release = await acquireExclusiveLock({ lockPath, timeoutMs: 0 })
  await assert.rejects(acquireExclusiveLock({ lockPath, timeoutMs: 0 }), { code: 'AUTOMATOR_LOCK_REENTRANT' })
  await release()
  await release()
  const releaseAgain = await acquireExclusiveLock({ lockPath, timeoutMs: 0 })
  await releaseAgain()
})

test('exclusive lock recovers a dead owner', async (t) => {
  const lockPath = path.join(temporaryDirectory(t), 'session.lock')
  fs.mkdirSync(lockPath, { recursive: true })
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    version: 1, pid: 999999, token: 'dead-owner', createdAt: new Date(0).toISOString(),
  }))
  const release = await acquireExclusiveLock({ lockPath, timeoutMs: 0, isPidAlive: () => false })
  await release()
  assert.equal(fs.existsSync(lockPath), false)
})

test('connect wrapper serializes the session and safely releases on sync disconnect', async (t) => {
  const lockPath = path.join(temporaryDirectory(t), 'session.lock')
  let disconnected = 0
  const fakeMiniProgram = { disconnect() { disconnected += 1 } }
  const fakeAutomator = { async connect(options) {
    assert.equal(options.wsEndpoint, DEFAULT_AUTOMATOR_ENDPOINT)
    return fakeMiniProgram
  } }
  const connected = await connectAutomator(fakeAutomator, { wsEndpoint: DEFAULT_AUTOMATOR_ENDPOINT }, { lockPath, timeoutMs: 0 })
  assert.equal(await safeDisconnect(connected), true)
  assert.equal(await safeDisconnect(connected), true)
  assert.equal(disconnected, 1)
  assert.equal(fs.existsSync(lockPath), false)
})

test('safeDisconnect absorbs synchronous and asynchronous disconnect failures', async () => {
  assert.equal(await safeDisconnect({ disconnect() { throw new Error('sync') } }), false)
  assert.equal(await safeDisconnect({ disconnect() { return Promise.reject(new Error('async')) } }), false)
  assert.equal(await safeDisconnect(null), true)
})

test('session cleanup unsubscribes before disconnect and reports every cleanup failure', async () => {
  const order = []
  const successful = await cleanupAutomatorSession({
    async disconnect() { order.push('disconnect') },
  }, async () => { order.push('unsubscribe') })
  assert.deepEqual(order, ['unsubscribe', 'disconnect'])
  assert.deepEqual(successful, { ok: true, failureCount: 0, errorCodes: [] })

  const failed = await cleanupAutomatorSession({
    async disconnect() {
      order.push('failed-disconnect')
      throw Object.assign(new Error('ownership changed'), { code: 'AUTOMATOR_LOCK_OWNERSHIP_LOST' })
    },
  }, () => {
    order.push('failed-unsubscribe')
    throw new Error('listener cleanup failed')
  })
  assert.deepEqual(order.slice(-2), ['failed-unsubscribe', 'failed-disconnect'])
  assert.equal(failed.ok, false)
  assert.equal(failed.failureCount, 2)
  assert.deepEqual(failed.errorCodes, [
    'DIAGNOSTICS_UNSUBSCRIBE_UNCLASSIFIED',
    'SESSION_DISCONNECT_AUTOMATOR_LOCK_OWNERSHIP_LOST',
  ])
  const report = { cleanupFailureCount: 1, cleanupErrorCodes: ['EARLIER_CLEANUP_FAILED'] }
  mergeAutomatorCleanupReport(report, failed)
  assert.equal(report.cleanupFailureCount, 3)
  assert.deepEqual(report.cleanupErrorCodes, [
    'EARLIER_CLEANUP_FAILED',
    'DIAGNOSTICS_UNSUBSCRIBE_UNCLASSIFIED',
    'SESSION_DISCONNECT_AUTOMATOR_LOCK_OWNERSHIP_LOST',
  ])
})

test('diagnostic classifier blocks every error and all but the exact known performance warning', () => {
  const notice = classifyAutomatorDiagnostic({ type: 'warning', text: '[Perf] App.onLaunch took 217ms' })
  assert.equal(notice.category, 'DEVTOOLS_PERFORMANCE_NOTICE')
  assert.equal(notice.blocking, false)
  assert.equal(classifyAutomatorDiagnostic({
    type: 'error', text: '[Perf] App.onLaunch took 217ms',
  }).blocking, true)
  assert.equal(classifyAutomatorDiagnostic({
    type: 'error warning', text: '[Perf] App.onLaunch took 217ms',
  }).blocking, true)
  assert.equal(classifyAutomatorDiagnostic({
    type: 'warning', text: '[Perf] App.onLaunch took 217ms; request failed',
  }).blocking, true)
  assert.equal(classifyAutomatorDiagnostic({ type: 'warn', text: 'ordinary warning' }).blocking, true)
  assert.equal(classifyAutomatorDiagnostic({ type: 'log', text: 'ordinary log' }).observed, false)
})

test('diagnostic subscription bypasses the dependency on override and can unsubscribe', async () => {
  class MiniProgramStub extends EventEmitter {
    on() { throw new Error('dependency on override must not be called') }
  }
  const miniProgram = new MiniProgramStub()
  const sent = []
  miniProgram.send = async (method) => { sent.push(method) }
  const logs = []
  const exceptions = []
  const unsubscribe = await subscribeAutomatorDiagnostics(miniProgram, {
    console: (entry) => logs.push(entry),
    exception: (entry) => exceptions.push(entry),
  }, { timeoutMs: 50 })
  assert.deepEqual(sent, ['App.enableLog'])
  miniProgram.emit('console', 'log-one')
  miniProgram.emit('exception', 'exception-one')
  assert.deepEqual(logs, ['log-one'])
  assert.deepEqual(exceptions, ['exception-one'])
  unsubscribe()
  unsubscribe()
  miniProgram.emit('console', 'log-two')
  miniProgram.emit('exception', 'exception-two')
  assert.deepEqual(logs, ['log-one'])
  assert.deepEqual(exceptions, ['exception-one'])
})

test('diagnostic subscription surfaces a Developer Tools timeout without leaving listeners', async () => {
  const miniProgram = new EventEmitter()
  let sends = 0
  miniProgram.send = async () => {
    sends += 1
    throw new Error('timeout waiting for automator response')
  }
  await assert.rejects(subscribeAutomatorDiagnostics(miniProgram, {
    console: () => {}, exception: () => {},
  }, { timeoutMs: 50 }), (error) => {
    assert.equal(error.code, 'AUTOMATOR_RESPONSE_TIMEOUT')
    assert.equal(error.stage, 'ENABLE_CONSOLE_LOG')
    assert.equal(error.timeoutOrigin, 'DEVTOOLS_RESPONSE')
    return true
  })
  assert.equal(sends, 1)
  assert.equal(miniProgram.listenerCount('console'), 0)
  assert.equal(miniProgram.listenerCount('exception'), 0)
})

test('diagnostic subscription fails fast on a closed session without retrying', async () => {
  const miniProgram = new EventEmitter()
  let sends = 0
  miniProgram.send = async () => {
    sends += 1
    throw new Error('Connection closed, check if wechat web devTools is still running')
  }
  await assert.rejects(subscribeAutomatorDiagnostics(miniProgram, {
    console: () => {},
  }, { timeoutMs: 50 }), (error) => {
    assert.equal(error.code, 'AUTOMATOR_CONNECTION_CLOSED')
    assert.equal(error.stage, 'ENABLE_CONSOLE_LOG')
    assert.equal(isFatalSessionError(error), true)
    return true
  })
  assert.equal(sends, 1)
  assert.equal(miniProgram.listenerCount('console'), 0)
})

test('navigateAndAcquire ignores stale navigation return values and reacquires current page', async () => {
  const stalePage = { path: 'pages/old/old' }
  const freshPage = { path: 'pages/planner/planner' }
  let reads = 0
  const miniProgram = {
    async reLaunch() { return stalePage },
    async currentPage() { reads += 1; return reads < 2 ? stalePage : freshPage },
  }
  assert.equal(await navigateAndAcquire(miniProgram, '/pages/planner/planner', { pollMs: 1, timeoutMs: 100 }), freshPage)
})

test('navigateAndAcquire supports a declared redirect but rejects unrelated routes', async () => {
  const source = { id: 1, path: 'pages/source/source' }
  const redirected = { path: 'pages/plan/plan' }
  let reads = 0
  const miniProgram = {
    async reLaunch() {},
    async currentPage() { reads += 1; return reads === 1 ? source : redirected },
  }
  assert.equal(await navigateAndAcquire(miniProgram, '/pages/access/access', {
    allowedRoutes: ['pages/plan/plan'], timeoutMs: 20, pollMs: 1,
  }), redirected)
  await assert.rejects(navigateAndAcquire(miniProgram, '/pages/profile/profile', { timeoutMs: 5, pollMs: 1 }), {
    code: 'AUTOMATOR_ROUTE_TIMEOUT',
  })
})

test('navigateAndAcquire accepts an allowed current route after a local navigation deadline', async () => {
  const sourcePage = { id: 1, path: 'pages/source/source' }
  const arrivedPage = { id: 2, path: 'pages/planner/planner' }
  let reads = 0
  const miniProgram = {
    reLaunch() { return new Promise(() => {}) },
    async currentPage() { reads += 1; return reads === 1 ? sourcePage : arrivedPage },
  }
  assert.equal(await navigateAndAcquire(miniProgram, '/pages/planner/planner', {
    timeoutMs: 100,
    responseTimeoutMs: 5,
    pollMs: 1,
  }), arrivedPage)
})

test('navigateAndAcquire accepts a declared redirect after a Developer Tools navigation timeout', async () => {
  const sourcePage = { id: 1, path: 'pages/source/source' }
  const redirectedPage = { id: 2, path: 'pages/plan/plan' }
  let reads = 0
  const miniProgram = {
    async reLaunch() { throw new Error('timeout waiting for automator response') },
    async currentPage() { reads += 1; return reads === 1 ? sourcePage : redirectedPage },
  }
  assert.equal(await navigateAndAcquire(miniProgram, '/pages/access/access', {
    allowedRoutes: ['pages/plan/plan'],
    timeoutMs: 100,
    responseTimeoutMs: 20,
    pollMs: 1,
  }), redirectedPage)
})

test('navigateAndAcquire preserves the navigation timeout when its bounded probe is off-route', async () => {
  let probes = 0
  const miniProgram = {
    reLaunch() { return new Promise(() => {}) },
    async currentPage() { probes += 1; return { path: 'pages/profile/profile' } },
  }
  await assert.rejects(navigateAndAcquire(miniProgram, '/pages/planner/planner', {
    timeoutMs: 100,
    responseTimeoutMs: 5,
    pollMs: 1,
  }), (error) => {
    assert.equal(error.code, 'AUTOMATOR_RESPONSE_TIMEOUT')
    assert.equal(error.stage, 'NAVIGATE_RELAUNCH')
    return true
  })
  assert(probes >= 2)
})

test('navigateAndAcquire never swallows a fatal session failure from the timeout probe', async () => {
  let reads = 0
  const miniProgram = {
    async reLaunch() { throw new Error('timeout waiting for automator response') },
    async currentPage() {
      reads += 1
      if (reads === 1) return { id: 1, path: 'pages/source/source' }
      throw new Error('Connection closed, check if wechat web devTools is still running')
    },
  }
  await assert.rejects(navigateAndAcquire(miniProgram, '/pages/planner/planner', {
    timeoutMs: 100,
    responseTimeoutMs: 20,
    pollMs: 1,
  }), (error) => {
    assert.equal(error.code, 'AUTOMATOR_CONNECTION_CLOSED')
    assert.equal(error.stage, 'ACQUIRE_CURRENT_PAGE')
    return true
  })
})

test('navigateAndAcquire bounds a currentPage protocol call that never settles', async () => {
  let reads = 0
  const miniProgram = {
    async reLaunch() {},
    currentPage() {
      reads += 1
      return reads === 1 ? { id: 1, path: 'pages/source/source' } : new Promise(() => {})
    },
  }
  await assert.rejects(navigateAndAcquire(miniProgram, '/pages/planner/planner', {
    timeoutMs: 100,
    responseTimeoutMs: 5,
    pollMs: 1,
  }), (error) => {
    assert.equal(error.code, 'AUTOMATOR_RESPONSE_TIMEOUT')
    assert.equal(error.stage, 'ACQUIRE_CURRENT_PAGE')
    return true
  })
})

test('navigateAndAcquire rejects an old allowed route when navigation fails without a page transition', async () => {
  const unchanged = { id: 7, path: 'pages/plan/plan' }
  const miniProgram = {
    async reLaunch() { throw new Error('navigation unavailable') },
    async currentPage() { return unchanged },
  }
  await assert.rejects(navigateAndAcquire(miniProgram, '/pages/access/access', {
    allowedRoutes: ['pages/plan/plan'], timeoutMs: 100, responseTimeoutMs: 20, pollMs: 1,
  }), { code: 'AUTOMATOR_NAVIGATION_UNCONFIRMED' })
})

test('navigateAndAcquire accepts a declared redirect after an ordinary navigation error only when the page changed', async () => {
  const source = { id: 3, path: 'pages/source/source' }
  const redirected = { id: 4, path: 'pages/plan/plan' }
  let reads = 0
  const miniProgram = {
    async reLaunch() { throw new Error('navigation unavailable') },
    async currentPage() { reads += 1; return reads === 1 ? source : redirected },
  }
  assert.equal(await navigateAndAcquire(miniProgram, '/pages/access/access', {
    allowedRoutes: ['pages/plan/plan'], timeoutMs: 100, responseTimeoutMs: 20, pollMs: 1,
  }), redirected)
})

test('protocol response timeout validates calls and uses a finite default', async () => {
  assert.equal(DEFAULT_RESPONSE_TIMEOUT_MS, 8000)
  assert.equal(DEFAULT_SCREENSHOT_TIMEOUT_MS, 20000)
  await assert.rejects(withAutomatorResponseTimeout(null), { code: 'AUTOMATOR_PROTOCOL_CALL_INVALID' })
})

test('viewport inspection prefers valid window inner dimensions', async () => {
  const reads = []
  const viewport = await readAutomatorViewport(null, {
    async windowProperty(properties) {
      reads.push(properties)
      return [390, 754]
    },
  }, { stage: 'INITIAL_VIEWPORT', timeoutMs: 50 })
  assert.deepEqual(reads, [['window.innerWidth', 'window.innerHeight']])
  assert.deepEqual(viewport, {
    windowWidth: 390,
    windowHeight: 754,
    platform: 'devtools',
    source: 'WINDOW_INNER',
  })
})

test('viewport inspection falls back to WeChat runtime window dimensions in layout coordinates', async () => {
  const reads = []
  let windowInfoReads = 0
  const viewport = await readAutomatorViewport({
    async evaluate(callback) {
      assert.equal(typeof callback, 'function')
      windowInfoReads += 1
      return { windowWidth: '390', windowHeight: '754', screenWidth: 390, screenHeight: 844 }
    },
  }, {
    async windowProperty(properties) {
      reads.push(properties)
      return ['', '']
    },
  }, { stage: 'INITIAL_VIEWPORT', timeoutMs: 50 })
  assert.deepEqual(reads, [['window.innerWidth', 'window.innerHeight']])
  assert.equal(windowInfoReads, 1)
  assert.deepEqual(viewport, {
    windowWidth: 390,
    windowHeight: 754,
    platform: 'devtools',
    source: 'WX_WINDOW_INFO',
  })
  assert.equal(reads.flat().some((property) => property.includes('scroll')), false)
})

test('viewport inspection rejects implausible dimensions from every source', async () => {
  const reads = []
  await assert.rejects(readAutomatorViewport({
    async evaluate() { return { windowWidth: 390, windowHeight: 10000 } },
  }, {
    async windowProperty(properties) {
      reads.push(properties)
      return [0, 0]
    },
  }, { stage: 'INITIAL_VIEWPORT', timeoutMs: 50 }), (error) => {
    assert.equal(error.code, 'AUTOMATOR_VIEWPORT_INVALID')
    assert.equal(error.stage, 'INITIAL_VIEWPORT')
    return true
  })
  assert.equal(reads.length, 1)
})

test('connection closure is normalized and classified as a fatal session error', async () => {
  assert.equal(isFatalSessionError(new Error('Connection closed, check if wechat web devTools is still running')), true)
  assert.equal(isFatalSessionError(Object.assign(new Error('write failed'), { code: 'EPIPE' })), true)
  assert.equal(isFatalSessionError(new Error('ordinary control failure')), false)
  await assert.rejects(withAutomatorResponseTimeout(
    () => Promise.reject(new Error('Connection closed, check if wechat web devTools is still running')),
    { stage: 'read page', timeoutMs: 50 },
  ), (error) => {
    assert.equal(error.code, 'AUTOMATOR_CONNECTION_CLOSED')
    assert.equal(error.stage, 'READ_PAGE')
    assert.equal(isFatalSessionError(error), true)
    return true
  })
})

test('protocol timeout distinguishes a Developer Tools response from a local deadline', async () => {
  await assert.rejects(withAutomatorResponseTimeout(
    () => Promise.reject(new Error('timeout waiting for automator response')),
    { stage: 'capture screenshot', timeoutMs: 50 },
  ), (error) => {
    assert.equal(error.code, 'AUTOMATOR_RESPONSE_TIMEOUT')
    assert.equal(error.timeoutOrigin, 'DEVTOOLS_RESPONSE')
    assert.equal(error.stage, 'CAPTURE_SCREENSHOT')
    return true
  })
  await assert.rejects(withAutomatorResponseTimeout(
    () => new Promise(() => {}),
    { stage: 'capture screenshot', timeoutMs: 5 },
  ), (error) => {
    assert.equal(error.code, 'AUTOMATOR_RESPONSE_TIMEOUT')
    assert.equal(error.timeoutOrigin, 'LOCAL_DEADLINE')
    return true
  })
})

test('screenshot retries one Developer Tools timeout and atomically promotes a verified PNG', async (t) => {
  const targetPath = path.join(temporaryDirectory(t), 'capture.png')
  let captures = 0
  let healthChecks = 0
  const result = await captureScreenshotWithRetry({
    screenshot() {
      captures += 1
      if (captures === 1) throw new Error('timeout waiting for automator response')
      return MINIMAL_PNG
    },
    async currentPage() { healthChecks += 1; return { path: 'pages/plan/plan' } },
  }, targetPath, {
    timeoutMs: 50, healthTimeoutMs: 50, retryDelayMs: 0,
    expectedRoute: 'pages/plan/plan',
  })
  assert.deepEqual(result, {
    attempts: 2,
    retried: true,
    captured: true,
    transient: {
      errorCode: 'AUTOMATOR_RESPONSE_TIMEOUT',
      stage: 'CAPTURE_SCREENSHOT',
      timeoutOrigin: 'DEVTOOLS_RESPONSE',
    },
  })
  assert.equal(captures, 2)
  assert.equal(healthChecks, 1)
  assert.equal(fs.readFileSync(targetPath).subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(fs.readdirSync(path.dirname(targetPath)).filter((name) => name.includes('.attempt-')).length, 0)
})

test('screenshot retry rejects a route change before the second capture', async (t) => {
  const targetPath = path.join(temporaryDirectory(t), 'changed-route.png')
  let captures = 0
  await assert.rejects(captureScreenshotWithRetry({
    screenshot() { captures += 1; throw new Error('timeout waiting for automator response') },
    async currentPage() { return { path: 'pages/access/access' } },
  }, targetPath, {
    timeoutMs: 50, healthTimeoutMs: 50, retryDelayMs: 0,
    expectedRoute: 'pages/plan/plan',
  }), (error) => {
    assert.equal(error.code, 'AUTOMATOR_SCREENSHOT_ROUTE_CHANGED')
    assert.equal(error.screenshotAttempts, 1)
    assert.equal(error.screenshotRetried, false)
    return true
  })
  assert.equal(captures, 1)
  assert.equal(fs.existsSync(targetPath), false)
})

test('screenshot retry accepts an explicitly allowed redirect route', async (t) => {
  const targetPath = path.join(temporaryDirectory(t), 'allowed-route.png')
  let captures = 0
  const result = await captureScreenshotWithRetry({
    screenshot() {
      captures += 1
      if (captures === 1) throw new Error('timeout waiting for automator response')
      return MINIMAL_PNG
    },
    async currentPage() { return { path: 'pages/plan/plan' } },
  }, targetPath, {
    timeoutMs: 50, healthTimeoutMs: 50, retryDelayMs: 0,
    expectedRoute: 'pages/access/access', allowedRoutes: ['pages/plan/plan'],
  })
  assert.equal(result.captured, true)
  assert.equal(result.retried, true)
  assert.equal(captures, 2)
})

test('screenshot succeeds on the bounded third attempt after two healthy route probes', async (t) => {
  const targetPath = path.join(temporaryDirectory(t), 'third-attempt.png')
  let captures = 0
  let healthChecks = 0
  const result = await captureScreenshotWithRetry({
    screenshot() {
      captures += 1
      if (captures < DEFAULT_SCREENSHOT_ATTEMPTS) throw new Error('timeout waiting for automator response')
      return MINIMAL_PNG
    },
    async currentPage() {
      healthChecks += 1
      return { path: 'pages/plan/plan' }
    },
  }, targetPath, {
    timeoutMs: 50,
    healthTimeoutMs: 50,
    retryDelayMs: 0,
    expectedRoute: 'pages/access/access',
    allowedRoutes: ['pages/plan/plan'],
  })
  assert.equal(result.attempts, DEFAULT_SCREENSHOT_ATTEMPTS)
  assert.equal(result.retried, true)
  assert.equal(result.captured, true)
  assert.equal(captures, DEFAULT_SCREENSHOT_ATTEMPTS)
  assert.equal(healthChecks, DEFAULT_SCREENSHOT_ATTEMPTS - 1)
  assert.equal(fs.existsSync(targetPath), true)
})

test('screenshot never retries a closed Developer Tools session', async (t) => {
  const targetPath = path.join(temporaryDirectory(t), 'closed.png')
  let captures = 0
  await assert.rejects(captureScreenshotWithRetry({
    screenshot() {
      captures += 1
      throw new Error('Connection closed, check if wechat web devTools is still running')
    },
    async currentPage() { throw new Error('health probe must not run') },
  }, targetPath, { timeoutMs: 50, retryDelayMs: 0 }), (error) => {
    assert.equal(error.code, 'AUTOMATOR_CONNECTION_CLOSED')
    assert.equal(error.screenshotAttempts, 1)
    assert.equal(isFatalSessionError(error), true)
    return true
  })
  assert.equal(captures, 1)
})

test('screenshot never retries local deadlines or ordinary failures', async (t) => {
  const directory = temporaryDirectory(t)
  let localAttempts = 0
  await assert.rejects(captureScreenshotWithRetry({
    screenshot() { localAttempts += 1; return new Promise(() => {}) },
    async currentPage() { throw new Error('health probe must not run') },
  }, path.join(directory, 'local.png'), { timeoutMs: 5, healthTimeoutMs: 5, retryDelayMs: 0 }), (error) => {
    assert.equal(error.timeoutOrigin, 'LOCAL_DEADLINE')
    assert.equal(error.screenshotAttempts, 1)
    assert.equal(error.screenshotRetried, false)
    return true
  })
  assert.equal(localAttempts, 1)

  let ordinaryAttempts = 0
  await assert.rejects(captureScreenshotWithRetry({
    screenshot() { ordinaryAttempts += 1; throw new Error('capture unavailable') },
    async currentPage() { throw new Error('health probe must not run') },
  }, path.join(directory, 'ordinary.png'), { timeoutMs: 50, retryDelayMs: 0 }), (error) => {
    assert.equal(error.message, 'capture unavailable')
    assert.equal(error.screenshotAttempts, 1)
    return true
  })
  assert.equal(ordinaryAttempts, 1)
})

test('screenshot makes three bounded attempts only for Developer Tools response timeouts', async (t) => {
  const targetPath = path.join(temporaryDirectory(t), 'failed.png')
  let captures = 0
  await assert.rejects(captureScreenshotWithRetry({
    screenshot() { captures += 1; throw new Error('timeout waiting for automator response') },
    async currentPage() { return { path: 'pages/plan/plan' } },
  }, targetPath, { timeoutMs: 50, healthTimeoutMs: 50, retryDelayMs: 0 }), (error) => {
    assert.equal(error.code, 'AUTOMATOR_RESPONSE_TIMEOUT')
    assert.equal(error.timeoutOrigin, 'DEVTOOLS_RESPONSE')
    assert.equal(error.screenshotAttempts, DEFAULT_SCREENSHOT_ATTEMPTS)
    assert.equal(error.screenshotRetried, true)
    assert.equal(error.screenshotCaptured, false)
    assert.equal(error.screenshotTransient.timeoutOrigin, 'DEVTOOLS_RESPONSE')
    return true
  })
  assert.equal(captures, DEFAULT_SCREENSHOT_ATTEMPTS)
  assert.equal(fs.existsSync(targetPath), false)
})

test('screenshot rejects invalid PNG data without retry or final-file promotion', async (t) => {
  const targetPath = path.join(temporaryDirectory(t), 'invalid.png')
  await assert.rejects(captureScreenshotWithRetry({
    async screenshot() { return Buffer.from('not a png').toString('base64') },
    async currentPage() { throw new Error('health probe must not run') },
  }, targetPath, { timeoutMs: 50, retryDelayMs: 0 }), (error) => {
    assert.equal(error.code, 'AUTOMATOR_SCREENSHOT_INVALID')
    assert.equal(error.screenshotAttempts, 1)
    return true
  })
  assert.equal(fs.existsSync(targetPath), false)
})

test('screenshot rejects a corrupt payload with a valid PNG signature', async (t) => {
  const targetPath = path.join(temporaryDirectory(t), 'corrupt-signature.png')
  const corrupt = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('not-a-decodable-image'),
  ]).toString('base64')
  await assert.rejects(captureScreenshotWithRetry({
    async screenshot() { return corrupt },
    async currentPage() { throw new Error('health probe must not run') },
  }, targetPath, { timeoutMs: 50, retryDelayMs: 0 }), {
    code: 'AUTOMATOR_SCREENSHOT_INVALID',
  })
  assert.equal(fs.existsSync(targetPath), false)
})

test('screenshot rejects a fully decoded PNG with implausible viewport dimensions', async (t) => {
  const targetPath = path.join(temporaryDirectory(t), 'tiny.png')
  await assert.rejects(captureScreenshotWithRetry({
    async screenshot() { return encodedPng(1, 1) },
    async currentPage() { throw new Error('health probe must not run') },
  }, targetPath, { timeoutMs: 50, retryDelayMs: 0 }), {
    code: 'AUTOMATOR_SCREENSHOT_INVALID',
  })
  assert.equal(fs.existsSync(targetPath), false)
})

test('reports retain each run and atomically update sanitized latest.json', (t) => {
  const baseDir = temporaryDirectory(t)
  const first = createRun('interactive', baseDir, { nowMs: 1000 })
  const result = finalizeRunReport(first, {
    steps: [{ stage: 'profile setting/restore', category: 'bad value', route: '/pages/profile/profile?secret=x', durationMs: -20 }],
    error: 'Authorization Bearer abcdefghijklmnopqrstuvwxyz',
  }, { nowMs: 1350 })
  assert.equal(result.report.runId, first.runId)
  assert.equal(result.report.durationMs, 350)
  assert.equal(result.report.steps[0].stage, 'PROFILE_SETTING_RESTORE')
  assert.equal(result.report.steps[0].category, 'BAD_VALUE')
  assert.equal(result.report.steps[0].route, 'pages/profile/profile')
  assert.equal(result.report.steps[0].durationMs, 0)
  assert.match(result.report.error, /\[REDACTED\]/)
  assert.deepEqual(JSON.parse(fs.readFileSync(result.reportPath, 'utf8')), result.report)
  assert.deepEqual(JSON.parse(fs.readFileSync(result.latestPath, 'utf8')), result.report)

  const second = createRun('interactive', baseDir, { nowMs: 2000 })
  const next = finalizeRunReport(second, { steps: [] }, { nowMs: 2100 })
  assert.notEqual(next.report.runId, result.report.runId)
  assert.equal(fs.existsSync(result.reportPath), true)
  assert.equal(JSON.parse(fs.readFileSync(next.latestPath, 'utf8')).runId, second.runId)
})

test('recovery journal blocks normal writes until recovery-only resolution completes', (t) => {
  const journalPath = path.join(temporaryDirectory(t), 'recovery.json')
  const journal = createRecoveryJournal(journalPath, 'run-one')
  journal.register('profile-setting-0', 'toggled')
  assert.equal(journal.unresolved().length, 1)
  assert.throws(() => createRecoveryJournal(journalPath, 'run-two'), { code: 'RECOVERY_REQUIRED' })

  const recovery = createRecoveryJournal(journalPath, 'run-two', { recoveryOnly: true })
  assert.equal(recovery.unresolved()[0].id, 'PROFILE-SETTING-0')
  recovery.update('profile-setting-0', 'restoring')
  recovery.resolve('profile-setting-0')
  recovery.complete()
  assert.equal(fs.existsSync(journalPath), false)
  assert.throws(() => assertRecoveryGate(null, true), { code: 'RECOVERY_NOT_REQUIRED' })
})

test('sanitizers remove credentials and normalize report categories', () => {
  assert.equal(sanitizeRoute('/pages/plan/plan?openid=private'), 'pages/plan/plan')
  const syntheticCredential = ['s', 'k', '-', 'abcdefgh', 'ijklmnop'].join('')
  const syntheticPhone = ['13800', '138000'].join('')
  assert.doesNotMatch(
    sanitizeText(`token ${syntheticCredential} phone ${syntheticPhone}`),
    new RegExp(`(?:${['s', 'k', '-'].join('')})|${syntheticPhone}`),
  )
  assert.equal(categorizeError(new Error('operation timed out')), 'TIMEOUT')
})
