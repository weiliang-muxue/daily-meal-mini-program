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
const { configuration } = require('../cloudfunctions/aiPlanner/provider-config')
const crypto = require('crypto')

const MAX_RESPONSE_BYTES = 512 * 1024
let liveStage = 'configuration'
let safeDiagnostic = ''
const SYNTHETIC_PREFERENCES = {
  contractVersion: CONTRACT_VERSION,
  durationDays: 7,
  startDate: '2026-09-07',
  mealTypes: ['breakfast', 'lunch', 'dinner'],
  doubleDinner: true,
  goals: ['高碳水'],
  styles: ['清淡低油', '食材易买'],
  customGoal: '',
  restrictions: '不使用花生',
  healthNotes: '',
  exerciseNotes: '只根据合成的运动安排调整普通食物和主食',
  exerciseByDay: Array.from({ length: 7 }, (_, dayIndex) => ({
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

async function readLimitedBody(response) {
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('UPSTREAM_EMPTY_BODY')
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('UPSTREAM_RESPONSE_TOO_LARGE')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  })
  return new TextDecoder().decode(bytes)
}

async function requestJson(config, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        ...config.extraHeaders,
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: controller.signal,
    })
    const text = await readLimitedBody(response)
    if (!response.ok) throw new Error(`UPSTREAM_HTTP_${response.status}`)
    try { return JSON.parse(text) } catch (_) { throw new Error('UPSTREAM_INVALID_JSON') }
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('UPSTREAM_TIMEOUT')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const config = configuration(process.env)
  if (!config.configured) throw new Error('LIVE_TEST_CONFIGURATION_MISSING')
  const options = providerOptions(config)
  if (process.argv.includes('--smoke')) {
    const startedAt = Date.now()
    const response = await requestJson(config, buildProviderBody(
      '只返回一个严格 JSON 对象：{"ok":true}。不要返回其他文字。',
      { ...options, maxTokens: 1000 },
    ))
    const result = parseModelJson(extractModelText(response))
    if (result.ok !== true) throw new Error('LIVE_TEST_SMOKE_INVALID')
    console.log(`AI provider smoke passed in ${Date.now() - startedAt}ms, store:false.`)
    return
  }
  const input = normalizeRequest(SYNTHETIC_PREFERENCES)
  let upstreamCalls = 0
  liveStage = 'outline-request'

  upstreamCalls += 1
  const outlineResponse = await requestJson(config, buildOutlineRequestBody(input, options))
  liveStage = 'outline-validation'
  const outline = normalizeOutline(parseModelJson(extractModelText(outlineResponse)), input)

  const chunkResults = []
  const completedMealTitles = []
  for (const chunk of buildChunkLayout(input)) {
    liveStage = `detail-${chunk.index + 1}-request`
    upstreamCalls += 1
    const context = { forbiddenMealTitles: completedMealTitles, retryAttempt: 1 }
    const detailResponse = await requestJson(config, buildDetailRequestBody(input, outline, chunk, options, context))
    liveStage = `detail-${chunk.index + 1}-validation`
    const detail = parseModelJson(extractModelText(detailResponse))
    const normalizedDays = normalizeDetailChunk(detail, input, outline, chunk, context)
    normalizedDays.forEach((day) => day.meals.forEach((meal) => completedMealTitles.push(meal.title)))
    chunkResults[chunk.index] = detail
  }

  liveStage = 'final-validation'
  const assembled = assembleRawPlan(input, outline, chunkResults)
  try {
    const identities = new Map()
    assembled.days.forEach((day) => day.meals.forEach((meal) => {
      const identity = String(meal.title || '')
        .normalize('NFKC').toLocaleLowerCase('zh-CN')
        .replace(/(?:星期|周)[一二三四五六日天]/g, '')
        .replace(/第?[0-9一二三四五六七八九十百]+(?:天|日|餐|份|周)/g, '')
        .replace(/(?:不运动|运动|训练|休息|常规)(?:日|后|前|版|餐|备选|方案)?/g, '')
        .replace(/[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~，。！？、；：“”‘’（）【】《》·…—￥]+/g, '')
        .replace(/(?:第)?[0-9一二三四五六七八九十百千万]+(?:号|款|版|型|式|份|餐|日|天|周)?$/g, '')
        .replace(/^(?:第)?[0-9一二三四五六七八九十百千万]+(?:号|款|版|型|式|份|餐|日|天|周)/g, '')
      const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 10)
      identities.set(digest, (identities.get(digest) || 0) + 1)
    }))
    const collisions = [...identities.entries()].filter(([, count]) => count > 1)
    safeDiagnostic = collisions.length
      ? `title-collision-groups=${collisions.length}; hashes=${collisions.map(([digest, count]) => `${digest}:${count}`).join(',')}`
      : ''
  } catch (_) { safeDiagnostic = '' }
  const plan = normalizePlan(assembled, input, {
    planId: 'plan-live-synthetic',
    generatedAt: new Date().toISOString(),
  })
  const mealVariants = plan.days.reduce((sum, day) => sum + day.meals.length, 0)
  const shoppingItems = plan.shoppingGroups.reduce((sum, group) => sum + group.items.length, 0)
  if (plan.days.length !== 7 || mealVariants !== 28 || shoppingItems < 1) throw new Error('LIVE_TEST_SUMMARY_INVALID')
  console.log(`AI provider live contract passed: ${plan.days.length} days, ${mealVariants} meal variants, ${shoppingItems} shopping items, ${upstreamCalls} upstream calls, store:false.`)
}

main().catch((error) => {
  const message = String(error && error.message || '')
  const code = /^[-A-Z0-9_]+$/.test(message) ? message : 'LIVE_TEST_CONTRACT_FAILED'
  console.error(`AI provider live contract failed: ${code}`)
  if (process.env.LIVE_TEST_DIAGNOSTICS === 'stage') {
    const safeReason = message
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[^\u4e00-\u9fffA-Za-z0-9_.:[\]() -]/g, '')
      .slice(0, 180)
    const suffix = safeDiagnostic ? `; ${safeDiagnostic}` : ''
    console.error(`Diagnostic: stage=${liveStage}; reason=${safeReason || 'unknown local validation failure'}${suffix}; no provider output logged.`)
  }
  process.exitCode = 1
})
