'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const runtime = require('./automation-runtime')

const sourcePath = path.join(__dirname, 'interactive-smoke.js')
const source = fs.readFileSync(sourcePath, 'utf8')
const clone = (value) => JSON.parse(JSON.stringify(value))

function createHarness(options = {}) {
  const state = { calls: [], mutations: [], report: null, completed: false, disconnected: false }
  const preferences = { mealTypes: ['lunch'], durationDays: 1 }
  const data = { loadingPage: false, taskVisible: false, preferences: clone(preferences) }
  const page = {
    path: 'pages/planner/planner',
    data: async () => clone(data),
    // Fail the control action before it changes anything, then exercise its real finally block.
    $$: async () => [],
    async callMethod(method, ...args) {
      state.calls.push({ method, args: clone(args) })
      if (method === 'updatePreferences') data.preferences = clone(args[0])
      else if (method === 'flushPreferenceDraft') {
        if (options.flush) await options.flush()
      } else if (method === 'connect') {
        assert.equal(args[0], true, 'restoration must force a cloud reload')
        const count = state.calls.filter((call) => call.method === 'connect').length
        if (options.connect) await options.connect(data, count)
      } else throw new Error(`unexpected method ${method}`)
    },
  }
  const miniProgram = {
    currentPage: async () => page,
    native: () => ({ authorizeCancel: async () => {}, cancelModal: async () => {} }),
    disconnect() { state.disconnected = true },
  }
  const recovery = {
    unresolved: () => state.mutations.filter((entry) => entry.status === 'active'),
    register(id) {
      state.mutations.push({ id, status: 'active', stage: 'REGISTERED' })
      return id
    },
    update(id, stage) { state.mutations.find((entry) => entry.id === id).stage = stage },
    resolve(id) {
      Object.assign(state.mutations.find((entry) => entry.id === id), { status: 'restored', stage: 'RESTORED' })
    },
    complete() {
      assert.equal(recovery.unresolved().length, 0)
      state.completed = true
    },
  }
  const fakeRuntime = {
    ...runtime,
    createRun: () => ({ runId: 'synthetic-recovery', outputDir: 'synthetic-output' }),
    createRecoveryJournal: () => recovery,
    async navigateAndAcquire(_, route) {
      state.calls.push({ route })
      assert.equal(route, '/pages/planner/planner', 'unexpected navigation after a restoration failure')
      return page
    },
    subscribeAutomatorDiagnostics: async () => async () => {},
    finalizeRunReport(_, report) {
      state.report = clone(report)
      return { reportPath: 'synthetic-report.json' }
    },
  }
  const fakeRequire = (name) => {
    if (name === 'fs') return { mkdirSync() {} }
    if (name === 'path') return path
    if (name === './automator-client') return { connect: async () => miniProgram }
    if (name === './automation-runtime') return fakeRuntime
    throw new Error(`unexpected import ${name}`)
  }
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module,
    require: fakeRequire,
    process: {
      env: {
        MINIPROGRAM_SMOKE_STEPS: options.steps || 'PLANNER_CONTROLS',
        MINIPROGRAM_SMOKE_ALLOW_WRITE: '1',
      },
      stdout: { write() {} },
      stderr: { write() {} },
    },
    // Accelerate UI waits; a former restore deadline would still fire while flush is pending.
    setTimeout: (callback, delay) => setTimeout(callback, delay === 30000 ? 5 : 0),
    clearTimeout,
  }, { filename: sourcePath })
  return { state, main: module.exports.main }
}

test('mainline wrapper starts interactive smoke exactly once after selecting its steps', () => {
  const environment = {}
  let runs = 0
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'run-mainline-smoke.js'), 'utf8'), {
    process: { env: environment },
    require(name) {
      assert.equal(name, './interactive-smoke')
      return {
        run() {
          runs += 1
          assert(environment.MINIPROGRAM_SMOKE_STEPS.split(',').includes('PLANNER_CONTROLS'))
          assert.equal(environment.MINIPROGRAM_SMOKE_ALLOW_WRITE, undefined)
          assert.equal(environment.MINIPROGRAM_SMOKE_ALLOW_DANGEROUS, undefined)
        },
      }
    },
  })
  assert.equal(runs, 1)
})

test('planner restoration verifies two forced cloud reads before resolving its mutation', async () => {
  const { state, main } = createHarness()
  await main()
  assert.deepEqual(state.calls.map((call) => call.method || call.route), [
    '/pages/planner/planner', 'updatePreferences', 'flushPreferenceDraft', 'connect', 'connect',
  ])
  assert.equal(state.report.cleanupFailureCount, 0)
  assert.equal(state.mutations[0].status, 'restored')
  assert.equal(state.completed, true)
  assert.equal(state.disconnected, true)
  assert.equal(state.report.steps[0].status, 'failed', 'the original control failure must still be reported')
})

test('planner restoration rejects offline cache and stops all subsequent smoke steps', async () => {
  const { state, main } = createHarness({
    steps: 'PLANNER_CONTROLS,AI_NO_GENERATE,GUIDE_SETTINGS',
    connect(data) { data.preferencesOffline = true },
  })
  await assert.rejects(main(), /cloud restoration could not be confirmed/)
  assert.equal(state.report.cleanupFailureCount, 1)
  assert.deepEqual(state.report.cleanupErrorCodes, ['CLEANUP_PLANNER_PREFERENCES_FAILED'])
  assert.equal(state.report.steps.length, 1)
  assert.equal(state.report.failure.stage, 'PLANNER_RESTORE_RELOAD')
  assert.equal(state.mutations[0].status, 'active')
  assert.equal(state.mutations[0].stage, 'RESTORE_FAILED')
  assert.equal(state.completed, false)
  assert.equal(state.calls.filter((call) => call.method === 'updatePreferences').length, 1)
  assert.equal(state.calls.filter((call) => call.route).length, 1)
})

test('planner restoration cannot resolve when the independent cloud read changes the preference', async () => {
  const { state, main } = createHarness({
    connect(data, count) {
      if (count === 2) data.preferences.durationDays = 2
    },
  })
  await assert.rejects(main(), /preferences differ after cloud reload/)
  assert.equal(state.report.cleanupFailureCount, 1)
  assert.equal(state.report.failure.stage, 'PLANNER_RESTORE_VERIFY')
  assert.equal(state.mutations[0].status, 'active')
  assert.equal(state.completed, false)
})

test('planner restoration observes immediate reload rejection and records its recovery stage', async () => {
  const { state, main } = createHarness({
    connect: () => Promise.reject(new Error('synthetic transport failed')),
  })
  await assert.rejects(main(), /synthetic transport failed/)
  assert.equal(state.report.cleanupFailureCount, 1)
  assert.equal(state.report.failure.stage, 'PLANNER_RESTORE_RELOAD')
  assert.equal(state.mutations[0].stage, 'RESTORE_FAILED')
})

test('recovery waits for pending writes to settle before reporting or disconnecting', async () => {
  let signalFlushStarted
  const started = new Promise((resolve) => { signalFlushStarted = resolve })
  let settleFlush
  const flush = new Promise((resolve) => { settleFlush = resolve })
  const { state, main } = createHarness({
    flush() {
      signalFlushStarted()
      return flush
    },
  })
  const result = main().then(() => null, (error) => error)
  await started
  try {
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(state.report, null)
    assert.equal(state.disconnected, false)
    assert.equal(state.mutations[0].stage, 'RESTORING')
  } finally {
    settleFlush()
    await result
  }
  assert.equal(await result, null)
  assert.equal(state.report.cleanupFailureCount, 0)
  assert.equal(state.mutations[0].status, 'restored')
  assert.equal(state.disconnected, true)
})
