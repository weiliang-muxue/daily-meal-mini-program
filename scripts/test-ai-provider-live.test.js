'use strict'

const assert = require('assert')
const { spawnSync } = require('child_process')
const path = require('path')
const {
  MIN_RETRY_DELAY_MS,
  MAX_RETRY_AFTER_MS,
  httpFailure,
} = require('../cloudfunctions/aiPlanner/transport')
const {
  PROFILE_FULL,
  PROFILE_NO_MAX_TOKENS,
} = require('../cloudfunctions/aiPlanner/provider-compat')
const {
  MAX_DETAIL_RETRIES,
  DETAIL_RETRY_DELAY_MS,
  LIVE_TEST_KEY_VARIABLE,
  LIVE_MODE_SMOKE,
  LIVE_MODE_CONTRACT,
  parseLiveMode,
  safeFailureCode,
  createProviderRequester,
  transientFailure,
  retryDelayMs,
  requestDetailWithRetry,
  report,
  runLive,
} = require('./test-ai-provider-live')

const TEST_KEY = 'TEST_PLACEHOLDER_ONLY'
const TEST_ENDPOINT = Object.freeze({ address: '203.0.113.1', family: 4 })
const TEST_CONFIG = Object.freeze({
  url: new URL('https://example.invalid/responses'),
  apiKey: TEST_KEY,
  timeoutMs: 45000,
})
const BASE_BODY = Object.freeze({
  model: 'model-placeholder',
  instructions: 'fixed-system-instructions',
  store: false,
  stream: false,
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'synthetic-input' }] }],
  max_output_tokens: 1000,
  reasoning: { effort: 'xhigh' },
  text: { format: { type: 'json_object' } },
})

function parameterFailure() {
  return httpFailure(422, {}, 0, {
    type: 'invalid_request_error',
    code: 'unsupported_parameter',
    param: 'max_output_tokens',
  })
}

function modelFailure() {
  return httpFailure(404, {}, 0, {
    type: 'model_not_found',
    code: 'model_not_found',
    param: 'model',
  })
}

function completed(text) {
  return { status: 'completed', output_text: text, output: [] }
}

async function run() {
  assert.strictEqual(MAX_DETAIL_RETRIES, 2)
  assert.strictEqual(DETAIL_RETRY_DELAY_MS, MIN_RETRY_DELAY_MS)
  assert.strictEqual(parseLiveMode(['--smoke']), LIVE_MODE_SMOKE)
  assert.strictEqual(parseLiveMode(['--contract']), LIVE_MODE_CONTRACT)
  assert.throws(() => parseLiveMode([]), (error) => error.code === 'LIVE_TEST_MODE_REQUIRED')
  assert.throws(() => parseLiveMode(['--smoke', '--contract']), (error) => error.code === 'LIVE_TEST_MODE_INVALID')
  assert.throws(() => parseLiveMode(['--unknown']), (error) => error.code === 'LIVE_TEST_MODE_INVALID')

  assert.strictEqual(safeFailureCode(modelFailure()), 'AI_UPSTREAM_MODEL_UNAVAILABLE')
  assert.strictEqual(safeFailureCode(Object.assign(new Error('private upstream body'), {
    code: 'AI_PRIVATE_INTERNAL_DIAGNOSTIC',
  })), 'LIVE_TEST_CONTRACT_FAILED')

  const compatibilityBodies = []
  const compatibilityAttempts = []
  let resolvedEndpoints = 0
  const requestProvider = createProviderRequester(TEST_CONFIG, {
    now: () => 1000,
    async resolveEndpoint(url, options) {
      resolvedEndpoints += 1
      assert.strictEqual(url, TEST_CONFIG.url)
      assert.strictEqual(options.deadlineAt, 46000)
      return TEST_ENDPOINT
    },
    onAttempt: (attempt) => compatibilityAttempts.push(attempt),
    async request(config, body, endpoint, options) {
      assert.strictEqual(config, TEST_CONFIG)
      assert.strictEqual(endpoint, TEST_ENDPOINT)
      assert.strictEqual(options.deadlineAt, 46000)
      compatibilityBodies.push(body)
      if (compatibilityBodies.length === 1) throw parameterFailure()
      return completed('{"ok":true}')
    },
  })
  const compatible = await requestProvider(BASE_BODY)
  assert.strictEqual(compatible.profile, PROFILE_NO_MAX_TOKENS)
  assert.strictEqual(compatible.attempts, 2)
  assert.deepStrictEqual(compatibilityAttempts, [1, 2])
  assert.strictEqual(Object.prototype.hasOwnProperty.call(compatibilityBodies[0], 'max_output_tokens'), true)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(compatibilityBodies[1], 'max_output_tokens'), false)
  assert(compatibilityBodies.every((body) => (
    body.instructions === BASE_BODY.instructions && body.store === false && body.stream === false
  )))

  const reused = await requestProvider(BASE_BODY)
  assert.strictEqual(reused.profile, PROFILE_NO_MAX_TOKENS)
  assert.strictEqual(reused.attempts, 1)
  assert.strictEqual(resolvedEndpoints, 2)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(compatibilityBodies[2], 'max_output_tokens'), false)

  let modelRequestCalls = 0
  const rejectedProvider = createProviderRequester(TEST_CONFIG, {
    now: () => 1000,
    async resolveEndpoint() { return TEST_ENDPOINT },
    async request() {
      modelRequestCalls += 1
      throw modelFailure()
    },
  })
  await assert.rejects(rejectedProvider(BASE_BODY), (error) => (
    error.code === 'AI_UPSTREAM_MODEL_UNAVAILABLE' &&
    error.statusCode === 404 &&
    error.requestAttempts === 1
  ))
  assert.strictEqual(modelRequestCalls, 1, 'model failures must not trigger compatibility fallback')

  assert.strictEqual(transientFailure({ code: 'AI_UPSTREAM_UNAVAILABLE', retryable: true }), true)
  assert.strictEqual(transientFailure({ code: 'AI_UPSTREAM_UNAVAILABLE', retryable: false }), false)
  assert.strictEqual(retryDelayMs({ retryAfterMs: 1234 }, 1), 1234)
  assert.strictEqual(retryDelayMs({ retryAfterMs: MAX_RETRY_AFTER_MS + 1 }, 1), MAX_RETRY_AFTER_MS)
  assert.strictEqual(retryDelayMs({}, 2), DETAIL_RETRY_DELAY_MS * 2)

  const attempts = []
  const delays = []
  const succeeded = await requestDetailWithRetry(async (attempt) => {
    attempts.push(attempt)
    if (attempt < 3) {
      throw Object.assign(new Error('fixed safe failure'), {
        code: 'AI_UPSTREAM_UNAVAILABLE', retryable: true,
      })
    }
    return 'ok'
  }, { wait: async (delayMs) => { delays.push(delayMs) } })
  assert.deepStrictEqual(succeeded, { value: 'ok', attempts: 3 })
  assert.deepStrictEqual(attempts, [1, 2, 3])
  assert.deepStrictEqual(delays, [DETAIL_RETRY_DELAY_MS, DETAIL_RETRY_DELAY_MS * 2])

  const rateDelays = []
  let rateAttempts = 0
  const rateResult = await requestDetailWithRetry(async () => {
    rateAttempts += 1
    if (rateAttempts === 1) {
      throw Object.assign(new Error('fixed safe rate failure'), {
        code: 'AI_UPSTREAM_RATE_LIMITED', retryable: true, retryAfterMs: 2500,
      })
    }
    return 'rate-ok'
  }, { wait: async (delayMs) => { rateDelays.push(delayMs) } })
  assert.deepStrictEqual(rateResult, { value: 'rate-ok', attempts: 2 })
  assert.deepStrictEqual(rateDelays, [2500])

  let terminal
  try {
    await requestDetailWithRetry(async () => {
      throw Object.assign(new Error('fixed safe timeout'), { code: 'AI_TIMEOUT', retryable: true })
    }, { maxRetries: 99, wait: async () => {} })
  } catch (error) { terminal = error }
  assert(terminal)
  assert.strictEqual(terminal.attempts, 3)

  let nonTransientAttempts = 0
  await assert.rejects(requestDetailWithRetry(async () => {
    nonTransientAttempts += 1
    throw parameterFailure()
  }, { wait: async () => {} }), (error) => error.code === 'AI_UPSTREAM_PARAMETER_REJECTED')
  assert.strictEqual(nonTransientAttempts, 1)

  const lines = []
  const privateFailure = Object.assign(new Error('private-upstream-body bearer credential'), {
    code: 'AI_UPSTREAM_MODEL_UNAVAILABLE', statusCode: 404, retryable: false,
  })
  report('detail-2', Date.now() - 10, 3, 'failed', (line) => lines.push(line), privateFailure, PROFILE_FULL)
  report('unsafe-stage private-upstream-body', Date.now(), 1, 'failed', (line) => lines.push(line), {
    code: 'AI_PRIVATE_INTERNAL_DIAGNOSTIC',
  })
  assert(/^stage=detail-2 elapsedMs=\d+ attempts=3 status=failed code=AI_UPSTREAM_MODEL_UNAVAILABLE profile=full$/.test(lines[0]))
  assert(/^stage=unknown elapsedMs=\d+ attempts=1 status=failed code=LIVE_TEST_CONTRACT_FAILED$/.test(lines[1]))
  assert(!lines.join('\n').toLowerCase().includes('private-upstream-body'))
  assert(!lines.join('\n').toLowerCase().includes('bearer'))

  let blockedResolverCalls = 0
  await assert.rejects(runLive({
    argv: [],
    env: { [LIVE_TEST_KEY_VARIABLE]: TEST_KEY },
    async resolveEndpoint() { blockedResolverCalls += 1; return TEST_ENDPOINT },
  }), (error) => error.code === 'LIVE_TEST_MODE_REQUIRED')
  assert.strictEqual(blockedResolverCalls, 0, 'no mode must never resolve or contact the provider')

  const genericKeyName = ['AI', 'API', 'KEY'].join('_')
  await assert.rejects(runLive({
    argv: ['--smoke'],
    env: { [genericKeyName]: TEST_KEY },
    async resolveEndpoint() { blockedResolverCalls += 1; return TEST_ENDPOINT },
  }), (error) => error.code === 'LIVE_TEST_CONFIGURATION_MISSING')
  assert.strictEqual(blockedResolverCalls, 0, 'generic credentials must never enable the live probe')

  const smokeLines = []
  const smokeBodies = []
  let smokeRequests = 0
  const smokeResult = await runLive({
    argv: ['--smoke'],
    env: { [LIVE_TEST_KEY_VARIABLE]: TEST_KEY },
    writer: (line) => smokeLines.push(line),
    now: () => 1000,
    async resolveEndpoint() { return TEST_ENDPOINT },
    async request(config, body) {
      assert.strictEqual(config.apiKey, TEST_KEY)
      smokeRequests += 1
      smokeBodies.push(body)
      if (smokeRequests === 1) throw parameterFailure()
      return completed('{"ok":true}')
    },
  })
  assert.deepStrictEqual(smokeResult, { mode: LIVE_MODE_SMOKE, profile: PROFILE_NO_MAX_TOKENS })
  assert.strictEqual(smokeRequests, 2)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(smokeBodies[0], 'max_output_tokens'), true)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(smokeBodies[1], 'max_output_tokens'), false)
  assert(smokeBodies.every((body) => (
    typeof body.instructions === 'string' && body.instructions.length > 0 &&
    body.store === false && body.stream === false
  )))
  assert(/^stage=configuration elapsedMs=\d+ attempts=0 status=passed$/.test(smokeLines[0]))
  assert(/^stage=smoke elapsedMs=\d+ attempts=2 status=passed profile=no_max_output_tokens$/.test(smokeLines[1]))
  const visibleSmokeOutput = smokeLines.join('\n').toLowerCase()
  assert(!visibleSmokeOutput.includes(TEST_KEY.toLowerCase()))
  assert(!visibleSmokeOutput.includes('authorization'))
  assert(!visibleSmokeOutput.includes('private-upstream-body'))

  const script = path.resolve(__dirname, 'test-ai-provider-live.js')
  const defaultRun = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { [LIVE_TEST_KEY_VARIABLE]: TEST_KEY },
  })
  assert.strictEqual(defaultRun.status, 1)
  assert.strictEqual(defaultRun.stdout, '')
  assert(/^stage=configuration elapsedMs=\d+ attempts=0 status=failed code=LIVE_TEST_MODE_REQUIRED\r?\n$/.test(defaultRun.stderr))
  assert(!`${defaultRun.stdout}${defaultRun.stderr}`.includes(TEST_KEY))

  const missingDedicatedKey = spawnSync(process.execPath, [script, '--smoke'], {
    encoding: 'utf8',
    env: { [genericKeyName]: TEST_KEY },
  })
  assert.strictEqual(missingDedicatedKey.status, 1)
  assert.strictEqual(missingDedicatedKey.stdout, '')
  assert(/^stage=configuration elapsedMs=\d+ attempts=0 status=failed code=LIVE_TEST_CONFIGURATION_MISSING\r?\n$/.test(missingDedicatedKey.stderr))
  assert(!`${missingDedicatedKey.stdout}${missingDedicatedKey.stderr}`.includes(TEST_KEY))

  console.log('AI provider live observability tests passed')
}

run().catch((error) => {
  console.error(error && { code: error.code, name: error.name, message: error.message })
  process.exitCode = 1
})
