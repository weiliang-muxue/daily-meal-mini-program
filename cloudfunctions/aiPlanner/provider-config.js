'use strict'

const crypto = require('crypto')

// Provider connection details are deliberately never bundled. They must be
// supplied by the cloud-function environment at runtime.
const DEFAULT_ENDPOINT = ''
const PROVIDER_CONTRACT_REVISION = 9
const DEFAULT_PROVIDER_REVISION = 0
const DEFAULT_PROVIDER_DISPLAY_NAME = ''
const DEFAULT_MODEL = 'gpt-5.6'
const DEFAULT_API_STYLE = 'responses'
const DEFAULT_REASONING_EFFORT = ''
const DEFAULT_TIMEOUT_MS = 45000
const MIN_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 45000
const DEFAULT_MAX_TOKENS = 16000
const MIN_MAX_TOKENS = 2000
const MAX_MAX_TOKENS = 32000
const MAX_PROVIDER_URL_LENGTH = 500
const MAX_PROVIDER_DISPLAY_NAME_LENGTH = 40
const PROVIDER_CONFIG_VERSION_DOMAIN = 'meal-ai-provider-config-v1\0'

function clean(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function boundedMaxTokens(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_TOKENS
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_TOKENS
  // Never exceed the configured token budget when normalizing fractional input.
  return Math.max(MIN_MAX_TOKENS, Math.min(MAX_MAX_TOKENS, Math.floor(numeric)))
}

function responsesPath(pathname) {
  const path = String(pathname || '/').replace(/\/+$/, '')
  if (!path) return '/responses'
  if (/\/responses$/i.test(path)) return path
  if (/\/v\d+$/i.test(path)) return `${path}/responses`
  return `${path}/responses`
}

function resolveResponsesEndpoint(rawBaseUrl) {
  if (rawBaseUrl === undefined) return null
  if (typeof rawBaseUrl !== 'string') return null
  const value = rawBaseUrl.trim()
  if (!value || value.length > MAX_PROVIDER_URL_LENGTH || /[\u0000-\u0020\u007f]/.test(value)) return null
  if (/[?#]/.test(value) || /\\/.test(value) || /^https:\/\/[^/?#]*@/i.test(value)) return null
  let url = null
  try { url = new URL(value) } catch (_) {}
  if (!url || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    return null
  }
  url.pathname = responsesPath(url.pathname)
  return url
}

function normalizeProviderDisplayName(value) {
  const source = value === undefined ? '' : value
  if (typeof source !== 'string') return ''
  const displayName = source.trim()
  if (!displayName || Array.from(displayName).length > MAX_PROVIDER_DISPLAY_NAME_LENGTH) return ''
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(displayName)) return ''
  return displayName
}

function normalizeProviderRevision(value) {
  const source = value === undefined ? 0 : value
  if (typeof source === 'number') {
    return Number.isSafeInteger(source) && source > 0 ? source : 0
  }
  if (typeof source !== 'string' || !/^[1-9]\d*$/.test(source)) return 0
  const revision = Number(source)
  return Number.isSafeInteger(revision) ? revision : 0
}

function deriveProviderConfigVersion(endpoint, providerDisplayName, providerRevision) {
  const identity = {
    providerContractRevision: PROVIDER_CONTRACT_REVISION,
    providerRevision,
    endpoint: endpoint.href,
    providerDisplayName,
    model: DEFAULT_MODEL,
    apiStyle: DEFAULT_API_STYLE,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  }
  return crypto.createHash('sha256')
    .update(PROVIDER_CONFIG_VERSION_DOMAIN, 'utf8')
    .update(JSON.stringify(identity), 'utf8')
    .digest('hex')
}

function buildConfiguration(rawApiKey, tuningEnv = {}, runtimeEnv = {}) {
  const apiKey = clean(rawApiKey, 500)
  const timeoutMs = Number(tuningEnv && tuningEnv.AI_TIMEOUT_MS)
  const endpoint = resolveResponsesEndpoint(runtimeEnv.baseUrl)
  const providerDisplayName = normalizeProviderDisplayName(runtimeEnv.displayName)
  const providerRevision = normalizeProviderRevision(runtimeEnv.revision)
  const providerIdentityValid = Boolean(endpoint && providerDisplayName && providerRevision)
  const providerConfigVersion = providerIdentityValid
    ? deriveProviderConfigVersion(endpoint, providerDisplayName, providerRevision)
    : ''
  const configured = Boolean(apiKey && providerIdentityValid)
  return {
    configured,
    providerDisplayName: providerIdentityValid ? providerDisplayName : '',
    providerContractRevision: PROVIDER_CONTRACT_REVISION,
    providerRevision: providerIdentityValid ? providerRevision : 0,
    providerConfigVersion,
    url: configured ? endpoint : null,
    apiKey,
    model: DEFAULT_MODEL,
    apiStyle: DEFAULT_API_STYLE,
    temperature: undefined,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    // The cloud function limit is 60 seconds. Reserve at least 15 seconds for
    // failure settlement and database writes after the absolute upstream deadline.
    timeoutMs: Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, timeoutMs || DEFAULT_TIMEOUT_MS)),
    maxTokens: boundedMaxTokens(tuningEnv && tuningEnv.AI_MAX_TOKENS),
  }
}

function configurationForApiKey(rawApiKey, tuningEnv = {}, runtimeEnv = {}) {
  return buildConfiguration(rawApiKey, tuningEnv, runtimeEnv)
}

function configuration(env = process.env) {
  const source = env || {}
  return buildConfiguration(source.AI_API_KEY, {
    AI_TIMEOUT_MS: source.AI_TIMEOUT_MS,
    AI_MAX_TOKENS: source.AI_MAX_TOKENS,
  }, {
    baseUrl: source.AI_API_BASE_URL,
    displayName: source.AI_PROVIDER_DISPLAY_NAME,
    revision: source.AI_PROVIDER_REVISION,
  })
}

module.exports = {
  DEFAULT_ENDPOINT,
  PROVIDER_CONTRACT_REVISION,
  DEFAULT_PROVIDER_REVISION,
  DEFAULT_PROVIDER_DISPLAY_NAME,
  DEFAULT_MODEL,
  DEFAULT_API_STYLE,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  MIN_MAX_TOKENS,
  MAX_MAX_TOKENS,
  MAX_PROVIDER_URL_LENGTH,
  MAX_PROVIDER_DISPLAY_NAME_LENGTH,
  clean,
  boundedMaxTokens,
  responsesPath,
  resolveResponsesEndpoint,
  normalizeProviderDisplayName,
  normalizeProviderRevision,
  deriveProviderConfigVersion,
  configurationForApiKey,
  configuration,
}
