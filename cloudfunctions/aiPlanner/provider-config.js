'use strict'

const { resolveApiEndpoint } = require('./lib')

const BLOCKED_PROVIDER_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'host', 'content-type', 'content-length',
  'connection', 'transfer-encoding', 'cookie', 'set-cookie', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto', 'x-openai-actor-authorization',
])
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const DEFAULT_ENDPOINT = 'https://gptpro.live/v1/responses'
const DEFAULT_MODEL = 'gpt-5.6'
const DEFAULT_API_STYLE = 'responses'
const DEFAULT_REASONING_EFFORT = 'xhigh'
const DEFAULT_PROVIDER_HEADERS = Object.freeze({
  'x-openai-actor-authorization': 'local-image-extension',
})
const DEFAULT_TIMEOUT_MS = 45000
const MIN_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 45000

function clean(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function providerHeaders(env = {}) {
  const name = clean(env.AI_PROVIDER_HEADER_NAME, 80).toLowerCase()
  const value = clean(env.AI_PROVIDER_HEADER_VALUE, 500)
  if (!name && !value) return {}
  if (!name || !value) throw new Error('AI 供应商附加请求头必须同时配置名称和值')
  if (!/^x-[a-z0-9][a-z0-9-]*$/.test(name) || BLOCKED_PROVIDER_HEADERS.has(name)) {
    throw new Error('AI 供应商附加请求头名称不安全')
  }
  if (/[^\t\x20-\x7e]/.test(value)) throw new Error('AI 供应商附加请求头值包含非法字符')
  return { [name]: value }
}

function configuration(env = process.env) {
  const rawEndpoint = clean(env.AI_API_ENDPOINT, 500)
  const rawBaseUrl = clean(env.AI_BASE_URL, 500)
  const legacyUrl = clean(env.AI_API_URL, 500)
  const apiKey = clean(env.AI_API_KEY, 500)
  const model = clean(env.AI_MODEL, 120) || DEFAULT_MODEL
  const apiStyle = clean(env.AI_API_STYLE, 40) || DEFAULT_API_STYLE
  const temperatureText = clean(env.AI_TEMPERATURE, 20)
  const reasoningEffort = (clean(env.AI_REASONING_EFFORT, 20) || (
    apiStyle === DEFAULT_API_STYLE ? DEFAULT_REASONING_EFFORT : ''
  )).toLowerCase()
  const hasCustomLocation = Boolean(rawEndpoint || rawBaseUrl || legacyUrl)
  const endpoint = hasCustomLocation ? rawEndpoint : DEFAULT_ENDPOINT
  const url = resolveApiEndpoint({ endpoint, baseUrl: rawBaseUrl, legacyEndpoint: legacyUrl, apiStyle })
  const temperature = temperatureText === '' ? undefined : Number(temperatureText)
  const temperatureValid = temperature === undefined || (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2)
  const reasoningValid = !reasoningEffort || (apiStyle === 'responses' && REASONING_EFFORTS.has(reasoningEffort))
  let extraHeaders = hasCustomLocation ? {} : { ...DEFAULT_PROVIDER_HEADERS }
  let headerValid = true
  try {
    const configuredHeaders = providerHeaders(env)
    extraHeaders = { ...extraHeaders, ...configuredHeaders }
  } catch (_) { headerValid = false }
  const defaultLocationValid = hasCustomLocation || apiStyle === DEFAULT_API_STYLE
  const configured = Boolean(url && apiKey && model && temperatureValid && reasoningValid && headerValid && defaultLocationValid)
  return {
    configured,
    url: configured ? url : null,
    apiKey,
    model,
    apiStyle,
    extraHeaders,
    temperature,
    reasoningEffort,
    // The cloud function limit is 60 seconds. Reserve at least 15 seconds for
    // failure settlement and database writes after the absolute upstream deadline.
    timeoutMs: Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Number(env.AI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)),
    maxTokens: Math.max(2000, Math.min(32000, Number(env.AI_MAX_TOKENS) || 16000)),
  }
}

module.exports = {
  BLOCKED_PROVIDER_HEADERS,
  REASONING_EFFORTS,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_API_STYLE,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_PROVIDER_HEADERS,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  clean,
  providerHeaders,
  configuration,
}
