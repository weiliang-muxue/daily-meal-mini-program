'use strict'

const {
  CONTRACT_VERSION,
  normalizeRequest,
  buildProviderBody,
  buildChunkLayout,
  buildOutlineRequestBody,
  buildDetailRequestBody,
  extractModelText,
  parseModelJson,
  normalizeOutline,
  normalizeDetailChunk,
  assembleRawPlan,
  normalizePlan,
} = require('../cloudfunctions/aiPlanner/lib')
const { configurationForApiKey } = require('../cloudfunctions/aiPlanner/provider-config')
const {
  MIN_RETRY_DELAY_MS,
  MAX_RETRY_AFTER_MS,
  resolvePublicEndpoint,
  requestJson,
} = require('../cloudfunctions/aiPlanner/transport')
const {
  PROFILE_FULL,
  PROFILES,
  requestResponsesCompatible,
} = require('../cloudfunctions/aiPlanner/provider-compat')

const MAX_DETAIL_RETRIES = 2
const DETAIL_RETRY_DELAY_MS = MIN_RETRY_DELAY_MS
const LIVE_TEST_KEY_VARIABLE = 'MEAL_AI_LIVE_TEST_KEY'
const LIVE_MODE_SMOKE = 'smoke'
const LIVE_MODE_CONTRACT = 'contract'
const SAFE_PROFILES = new Set(PROFILES)
const SAFE_FAILURE_CODES = new Set([
  'AI_CONFIGURATION_INVALID', 'AI_NETWORK_ERROR',
  'AI_REQUEST_INVALID', 'AI_REQUEST_TOO_LARGE',
  'AI_RESPONSE_ERROR', 'AI_RESPONSE_INCOMPLETE', 'AI_RESPONSE_INVALID',
  'AI_RESPONSE_NOT_COMPLETED', 'AI_RESPONSE_REFUSED', 'AI_RESPONSE_TOO_LARGE',
  'AI_TIMEOUT', 'AI_UPSTREAM_AUTH_REJECTED', 'AI_UPSTREAM_ENDPOINT_NOT_FOUND',
  'AI_UPSTREAM_MODEL_UNAVAILABLE', 'AI_UPSTREAM_PARAMETER_REJECTED',
  'AI_UPSTREAM_POLICY_REJECTED', 'AI_UPSTREAM_RATE_LIMITED',
  'AI_UPSTREAM_REQUEST_REJECTED', 'AI_UPSTREAM_UNAVAILABLE',
  'LIVE_TEST_CONFIGURATION_MISSING', 'LIVE_TEST_CONTRACT_FAILED',
  'LIVE_TEST_MODE_INVALID', 'LIVE_TEST_MODE_REQUIRED',
  'LIVE_TEST_SMOKE_INVALID', 'LIVE_TEST_SUMMARY_INVALID',
])
let liveStage = 'configuration'
let liveStageStartedAt = Date.now()
let liveStageAttempts = 0
const SYNTHETIC_PREFERENCES = {
  contractVersion: CONTRACT_VERSION,
  durationDays: 10,
  startDate: '2026-09-07',
  mealTypes: ['breakfast', 'lunch', 'dinner'],
  doubleDinner: true,
  goals: ['高碳水'],
  styles: ['清淡低油', '食材易买'],
  customGoal: '',
  restrictions: '不使用花生',
  healthNotes: '',
  exerciseIntent: 'daily',
  exerciseNotes: '只根据合成的运动安排调整普通食物和主食',
  exerciseByDay: Array.from({ length: 10 }, (_, dayIndex) => ({
    dayIndex,
    planned: [1, 4].includes(dayIndex),
    type: [1, 4].includes(dayIndex) ? '快走' : '',
    durationMinutes: [1, 4].includes(dayIndex) ? 45 : 0,
    intensity: 'medium',
  })),
}

function providerOptions(config) {
  return {
    apiStyle: config.apiStyle,
    model: config.model,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    reasoningEffort: config.reasoningEffort,
  }
}

function liveTestError(code) {
  const error = new Error(code)
  error.code = code
  error.retryable = false
  return error
}

function parseLiveMode(argv) {
  const args = Array.isArray(argv) ? argv : []
  if (!args.length) throw liveTestError('LIVE_TEST_MODE_REQUIRED')
  if (args.length !== 1) throw liveTestError('LIVE_TEST_MODE_INVALID')
  if (args[0] === '--smoke') return LIVE_MODE_SMOKE
  if (args[0] === '--contract') return LIVE_MODE_CONTRACT
  throw liveTestError('LIVE_TEST_MODE_INVALID')
}

function safeFailureCode(error) {
  const code = typeof (error && error.code) === 'string' ? error.code.trim().toUpperCase() : ''
  return SAFE_FAILURE_CODES.has(code) ? code : 'LIVE_TEST_CONTRACT_FAILED'
}

function createProviderRequester(config, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const resolveEndpoint = typeof options.resolveEndpoint === 'function'
    ? options.resolveEndpoint : resolvePublicEndpoint
  const requestCompatible = typeof options.requestCompatible === 'function'
    ? options.requestCompatible : requestResponsesCompatible
  const transportRequest = typeof options.request === 'function' ? options.request : requestJson
  const onAttempt = typeof options.onAttempt === 'function' ? options.onAttempt : () => {}
  let profile = PROFILE_FULL

  return async function requestProvider(body) {
    const deadlineAt = now() + Number(config && config.timeoutMs || 0)
    const endpoint = await resolveEndpoint(config && config.url, { deadlineAt, now })
    let attempts = 0
    const countedRequest = (...args) => {
      attempts += 1
      onAttempt(attempts)
      return transportRequest(...args)
    }
    try {
      const execution = await requestCompatible(config, body, endpoint, {
        deadlineAt,
        initialProfile: profile,
        now,
        request: countedRequest,
      })
      profile = execution.profile
      return { ...execution, attempts }
    } catch (error) {
      if (error && typeof error === 'object') {
        try { Object.defineProperty(error, 'requestAttempts', { value: attempts, configurable: true }) } catch (_) {}
      }
      throw error
    }
  }
}

function transientFailure(error) {
  return Boolean(error && error.retryable === true)
}

function retryDelayMs(error, attempt) {
  const requested = Number(error && error.retryAfterMs)
  if (Number.isFinite(requested)) {
    return Math.max(MIN_RETRY_DELAY_MS, Math.min(MAX_RETRY_AFTER_MS, Math.ceil(requested)))
  }
  return Math.min(MAX_RETRY_AFTER_MS, DETAIL_RETRY_DELAY_MS * Math.max(1, attempt))
}

async function requestDetailWithRetry(operation, options = {}) {
  const requestedRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : MAX_DETAIL_RETRIES
  const maxRetries = Math.max(0, Math.min(MAX_DETAIL_RETRIES, requestedRetries))
  const wait = typeof options.wait === 'function'
    ? options.wait
    : (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
  let attempts = 0
  while (true) {
    attempts += 1
    try {
      return { value: await operation(attempts), attempts }
    } catch (error) {
      if (!transientFailure(error) || attempts > maxRetries) {
        if (error && typeof error === 'object') {
          try { error.attempts = attempts } catch (_) {}
        }
        throw error
      }
      await wait(retryDelayMs(error, attempts))
    }
  }
}

function report(stage, startedAt, attempts, status, writer = console.log, failure = null, profile = '') {
  const safeStage = /^(?:configuration|smoke|outline|detail-[1-9][0-9]*|final-validation)$/.test(String(stage))
    ? String(stage) : 'unknown'
  const safeAttempts = Number.isInteger(attempts) ? Math.max(0, Math.min(999, attempts)) : 0
  const started = Number(startedAt)
  const elapsedMs = Number.isFinite(started) ? Math.max(0, Math.floor(Date.now() - started)) : 0
  const safeStatus = status === 'passed' ? 'passed' : 'failed'
  const code = safeStatus === 'failed' ? ` code=${safeFailureCode(failure)}` : ''
  const selectedProfile = SAFE_PROFILES.has(profile) ? ` profile=${profile}` : ''
  writer(`stage=${safeStage} elapsedMs=${elapsedMs} attempts=${safeAttempts} status=${safeStatus}${code}${selectedProfile}`)
}

function beginStage(stage) {
  liveStage = stage
  liveStageStartedAt = Date.now()
  liveStageAttempts = 0
}

async function runLive(runOptions = {}) {
  beginStage('configuration')
  const mode = parseLiveMode(Array.isArray(runOptions.argv) ? runOptions.argv : process.argv.slice(2))
  const environment = runOptions.env && typeof runOptions.env === 'object' ? runOptions.env : process.env
  const liveTestKey = typeof environment[LIVE_TEST_KEY_VARIABLE] === 'string'
    ? environment[LIVE_TEST_KEY_VARIABLE].trim()
    : ''
  // Live tests deliberately ignore generic process credentials and provider
  // overrides. This prevents an unrelated developer credential from being sent.
  const config = configurationForApiKey(liveTestKey)
  if (!config.configured) throw liveTestError('LIVE_TEST_CONFIGURATION_MISSING')
  const writer = typeof runOptions.writer === 'function' ? runOptions.writer : console.log
  report(liveStage, liveStageStartedAt, liveStageAttempts, 'passed', writer)
  const requestBodyOptions = providerOptions(config)
  const requestProvider = createProviderRequester(config, {
    now: runOptions.now,
    resolveEndpoint: runOptions.resolveEndpoint,
    requestCompatible: runOptions.requestCompatible,
    request: runOptions.request,
    onAttempt: () => { liveStageAttempts += 1 },
  })
  if (mode === LIVE_MODE_SMOKE) {
    beginStage('smoke')
    const execution = await requestProvider(buildProviderBody(
      '只返回一个严格 JSON 对象：{"ok":true}。不要返回其他文字。',
      { ...requestBodyOptions, maxTokens: 1000 },
    ))
    const result = parseModelJson(extractModelText(execution.response, config.apiStyle))
    if (result.ok !== true) throw liveTestError('LIVE_TEST_SMOKE_INVALID')
    report(liveStage, liveStageStartedAt, liveStageAttempts, 'passed', writer, null, execution.profile)
    return { mode, profile: execution.profile }
  }
  const input = normalizeRequest(SYNTHETIC_PREFERENCES)
  beginStage('outline')

  const outlineExecution = await requestProvider(buildOutlineRequestBody(input, requestBodyOptions))
  let providerProfile = outlineExecution.profile
  const outline = normalizeOutline(
    parseModelJson(extractModelText(outlineExecution.response, config.apiStyle)), input,
  )
  report(liveStage, liveStageStartedAt, liveStageAttempts, 'passed', writer, null, providerProfile)

  const chunkResults = []
  const completedMealTitles = []
  for (const chunk of buildChunkLayout(input)) {
    beginStage(`detail-${chunk.index + 1}`)
    const detailResult = await requestDetailWithRetry(async (attempt) => {
      const context = { forbiddenMealTitles: completedMealTitles, retryAttempt: attempt }
      const execution = await requestProvider(buildDetailRequestBody(
        input, outline, chunk, requestBodyOptions, context,
      ))
      return { response: execution.response, context, profile: execution.profile }
    }, { wait: runOptions.wait, maxRetries: runOptions.maxDetailRetries })
    const { response: detailResponse, context } = detailResult.value
    providerProfile = detailResult.value.profile
    const detail = parseModelJson(extractModelText(detailResponse, config.apiStyle))
    const normalizedDays = normalizeDetailChunk(detail, input, outline, chunk, context)
    normalizedDays.forEach((day) => day.meals.forEach((meal) => completedMealTitles.push(meal.title)))
    chunkResults[chunk.index] = detail
    report(liveStage, liveStageStartedAt, liveStageAttempts, 'passed', writer, null, providerProfile)
  }

  beginStage('final-validation')
  const assembled = assembleRawPlan(input, outline, chunkResults)
  const plan = normalizePlan(assembled, input, {
    planId: 'plan-live-synthetic',
    generatedAt: new Date().toISOString(),
  })
  const mealVariants = plan.days.reduce((sum, day) => sum + day.meals.length, 0)
  const shoppingItems = plan.shoppingGroups.reduce((sum, group) => sum + group.items.length, 0)
  const expectedMealVariants = input.durationDays * (input.mealTypes.length + (input.doubleDinner ? 1 : 0))
  if (plan.days.length !== input.durationDays || mealVariants !== expectedMealVariants || shoppingItems < 1) {
    throw liveTestError('LIVE_TEST_SUMMARY_INVALID')
  }
  report(liveStage, liveStageStartedAt, liveStageAttempts, 'passed', writer, null, providerProfile)
  return {
    mode,
    profile: providerProfile,
    days: plan.days.length,
    mealVariants,
    shoppingItems,
  }
}

if (require.main === module) {
  runLive().catch((error) => {
    report(liveStage, liveStageStartedAt, liveStageAttempts, 'failed', console.error, error)
    process.exitCode = 1
  })
}

module.exports = {
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
}
